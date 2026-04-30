const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { ROOT } = require("../config");
const { joinUrl, assertConfigured, parseJsonFromModelText, withRetries } = require("../utils");

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const timeoutMs = Number(options.timeoutMs || 180000);
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            data = null;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.statusCode}`;
            const httpError = new Error(message);
            httpError.statusCode = response.statusCode;
            httpError.url = url;
            httpError.rawBody = raw;
            httpError.payload = data;
            reject(httpError);
            return;
          }

          resolve(data);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout: ${url}`));
    });

    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function fetchJsonViaPython(url, options = {}) {
  return new Promise((resolve, reject) => {
    const script = [
      "import base64, json, sys, requests",
      "sys.stdout.reconfigure(encoding='utf-8')",
      "try:",
      "    payload = json.loads(base64.b64decode(sys.stdin.read()).decode('utf-8'))",
      "    session = requests.Session()",
      "    session.trust_env = False",
      "    body = payload.get('body')",
      "    if isinstance(body, str):",
      "        body = body.encode('utf-8')",
      "    response = session.request(",
      "        method=payload.get('method', 'GET'),",
      "        url=payload['url'],",
      "        headers=payload.get('headers') or {},",
      "        data=body,",
      "        timeout=payload.get('timeout', 60),",
      "    )",
      "    print(json.dumps({'ok': True, 'status': response.status_code, 'text': response.text}, ensure_ascii=False))",
      "except Exception as exc:",
      "    print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))",
    ].join("\n");

    const child = spawn("python", ["-X", "utf8", "-c", script], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python request failed with code ${code}`));
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`Python request returned invalid JSON: ${stdout}`));
        return;
      }

      if (!payload.ok) {
        reject(new Error(payload.error || "Python request failed"));
        return;
      }

      let data = null;
      try {
        data = payload.text ? JSON.parse(payload.text) : null;
      } catch (error) {
        data = null;
      }

      if (payload.status < 200 || payload.status >= 300) {
        const message = data?.error?.message || data?.error || data?.message || payload.text || `HTTP ${payload.status}`;
        reject(new Error(message));
        return;
      }

      resolve(data);
    });

    child.stdin.end(
      Buffer.from(
        JSON.stringify({
          url,
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body || null,
          timeout: 90,
        }),
        "utf8",
      ).toString("base64"),
    );
  });
}

function extractTextFromOpenAIResponse(payload) {
  const choice = payload?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (!Array.isArray(choice)) return "";
  return choice
    .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
    .join("\n");
}

function extractTextFromAnthropicResponse(payload) {
  const content = payload?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item?.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function extractTextFromGoogleResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((item) => item?.text || "").filter(Boolean).join("\n");
}

async function callTextModelJson(appConfig, { systemPrompt, userPrompt, useSearch = false, temperature = 0.7 }) {
  const provider = appConfig.textProvider;
  assertConfigured(provider.apiKey, "文本模型 API Key");
  const modelTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7;

  if (provider.apiStyle === "google") {
    const data = await withRetries(
      () =>
        fetchJsonViaPython(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            ...(useSearch && provider.searchEnabled ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: { temperature: modelTemperature },
          }),
        }),
      { retries: 3, delayMs: 1200 },
    );
    return parseJsonFromModelText(extractTextFromGoogleResponse(data));
  }

  if (provider.apiStyle === "anthropic") {
    const data = await withRetries(
      () =>
        fetchJson(joinUrl(provider.anthropicBaseUrl, "/messages"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: provider.model,
            system: systemPrompt,
            max_tokens: 4096,
            temperature: modelTemperature,
            messages: [{ role: "user", content: userPrompt }],
          }),
        }),
      { retries: 3, delayMs: 1200 },
    );
    return parseJsonFromModelText(extractTextFromAnthropicResponse(data));
  }

  const data = await withRetries(
    () =>
      fetchJson(joinUrl(provider.openaiBaseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: modelTemperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      }),
    { retries: 3, delayMs: 1200 },
  );
  return parseJsonFromModelText(extractTextFromOpenAIResponse(data));
}

function buildTextProviderEndpoint(appConfig) {
  if (appConfig.textProvider.apiStyle === "anthropic") {
    return joinUrl(appConfig.textProvider.anthropicBaseUrl, "/messages");
  }
  if (appConfig.textProvider.apiStyle === "google") {
    return joinUrl(
      appConfig.textProvider.baseUrl,
      `/v1beta/models/${encodeURIComponent(appConfig.textProvider.model)}:generateContent`,
    );
  }
  return joinUrl(appConfig.textProvider.openaiBaseUrl, "/chat/completions");
}

module.exports = {
  fetchJson,
  fetchJsonViaPython,
  extractTextFromOpenAIResponse,
  extractTextFromAnthropicResponse,
  extractTextFromGoogleResponse,
  callTextModelJson,
  buildTextProviderEndpoint,
};
