const http = require("http");
const https = require("https");
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

function extractTextFromOpenAIStream(raw) {
  const parts = [];
  let completed = false;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      completed = true;
      continue;
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch (_error) {
      continue;
    }
    if (data?.error) {
      throw new Error(data.error.message || data.error || "OpenAI-compatible stream failed");
    }
    const content = data?.choices?.[0]?.delta?.content;
    if (typeof content === "string") parts.push(content);
  }
  if (!completed) throw new Error("OpenAI-compatible stream ended before [DONE].");
  return parts.join("");
}

function fetchOpenAIText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const timeoutMs = Number(options.timeoutMs || 180000);
    const request = transport.request(
      target,
      {
        method: options.method || "POST",
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
          } catch (_error) {
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
          try {
            const contentType = String(response.headers["content-type"] || "").toLowerCase();
            resolve(
              contentType.includes("text/event-stream") || /^\s*data:/m.test(raw)
                ? extractTextFromOpenAIStream(raw)
                : extractTextFromOpenAIResponse(data),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout: ${url}`));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function fetchJsonNative(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 180000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.status}`;
      const httpError = new Error(message);
      httpError.statusCode = response.status;
      httpError.url = url;
      httpError.rawBody = raw;
      httpError.payload = data;
      throw httpError;
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function buildRetryOptions(options) {
  return {
    retries: Number.isFinite(Number(options.retries)) ? Math.max(1, Number(options.retries)) : 3,
    delayMs: Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 1200,
  };
}

async function callTextModelJson(appConfig, { systemPrompt, userPrompt, useSearch = false, temperature = 0.7, timeoutMs, retries, delayMs, maxOutputTokens, stream = false }) {
  const provider = appConfig.textProvider;
  assertConfigured(provider.apiKey, "文本模型 API Key");
  const modelTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7;
  const outputTokenLimit = Number.isFinite(Number(maxOutputTokens))
    ? Number(maxOutputTokens)
    : Number.isFinite(Number(provider.maxOutputTokens))
      ? Number(provider.maxOutputTokens)
      : null;
  const requestOptions = {
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : undefined,
  };
  const retryOptions = buildRetryOptions({ retries, delayMs });

  if (provider.apiStyle === "google") {
    const data = await withRetries(
      () =>
        fetchJsonNative(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            ...(useSearch && provider.searchEnabled ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: {
              temperature: modelTemperature,
              ...(outputTokenLimit ? { maxOutputTokens: outputTokenLimit } : {}),
            },
          }),
          ...requestOptions,
        }),
      retryOptions,
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
            max_tokens: outputTokenLimit || 4096,
            temperature: modelTemperature,
            messages: [{ role: "user", content: userPrompt }],
          }),
          ...requestOptions,
        }),
      retryOptions,
    );
    return parseJsonFromModelText(extractTextFromAnthropicResponse(data));
  }

  const requestBody = JSON.stringify({
    model: provider.model,
    temperature: modelTemperature,
    response_format: { type: "json_object" },
    ...(outputTokenLimit ? { max_tokens: outputTokenLimit } : {}),
    ...(stream ? { stream: true } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  if (stream) {
    const text = await withRetries(
      () =>
        fetchOpenAIText(joinUrl(provider.openaiBaseUrl, "/chat/completions"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: requestBody,
          ...requestOptions,
        }),
      retryOptions,
    );
    return parseJsonFromModelText(text);
  }

  const data = await withRetries(
    () =>
      fetchJson(joinUrl(provider.openaiBaseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: requestBody,
        ...requestOptions,
      }),
    retryOptions,
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
  fetchJsonNative,
  fetchOpenAIText,
  extractTextFromOpenAIStream,
  extractTextFromOpenAIResponse,
  extractTextFromAnthropicResponse,
  extractTextFromGoogleResponse,
  callTextModelJson,
  buildTextProviderEndpoint,
};
