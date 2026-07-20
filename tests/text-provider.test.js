const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_APP_CONFIG, loadProjectEnvFile, readEnvValueFile, loadAppConfig } = require("../src/server/config");
const { callTextModelJson, buildTextProviderEndpoint } = require("../src/server/ai/text-provider");

test("defaults to DeepSeek V4 Flash through the RunningHub OpenAI-compatible endpoint", () => {
  assert.equal(DEFAULT_APP_CONFIG.textProvider.apiStyle, "openai");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.model, "deepseek/deepseek-v4-flash");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.openaiBaseUrl, "https://llm.runninghub.ai/v1");
  assert.equal(DEFAULT_APP_CONFIG.textProvider.searchEnabled, false);
  assert.equal(DEFAULT_APP_CONFIG.searchProvider.subDomain, "general.general");
  assert.equal(DEFAULT_APP_CONFIG.searchProvider.socialSubDomain, "social_media.social_media");
  assert.equal(DEFAULT_APP_CONFIG.searchProvider.dailyQueryLimit, 950);
  assert.deepEqual(DEFAULT_APP_CONFIG.searchProvider.apiKeys, []);
});

test("loads multiple AnySearch keys from a deployable env variable", () => {
  const previous = process.env.ANYSEARCH_API_KEYS;
  try {
    process.env.ANYSEARCH_API_KEYS = "fixture-key-a,fixture-key-b";
    const config = loadAppConfig();
    assert.deepEqual(config.searchProvider.apiKeys, ["fixture-key-a", "fixture-key-b"]);
    assert.equal(config.searchProvider.apiKey, "fixture-key-a");
    assert.equal(config.searchProvider.dailyQueryLimit * config.searchProvider.apiKeys.length, 1900);
  } finally {
    if (previous === undefined) delete process.env.ANYSEARCH_API_KEYS;
    else process.env.ANYSEARCH_API_KEYS = previous;
  }
});

test("loads a project env file without overriding an existing process variable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "redbase-env-"));
  const envFile = path.join(tempDir, ".env");
  const name = "REDBASE_ENV_FIXTURE";
  const previous = process.env[name];
  try {
    await fs.writeFile(envFile, `${name}=from-file\n`, "utf8");
    process.env[name] = "from-process";
    assert.equal(loadProjectEnvFile(envFile), true);
    assert.equal(process.env[name], "from-process");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("reads a named key from an env-style secret file without persisting it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "redbase-anysearch-"));
  const secretFile = path.join(tempDir, ".env");
  await fs.writeFile(secretFile, "OTHER=value\nANYSEARCH_API_KEY=fixture-key\n", "utf8");
  assert.equal(readEnvValueFile(secretFile, "ANYSEARCH_API_KEY"), "fixture-key");
  assert.equal(readEnvValueFile(secretFile, "MISSING"), "");
});

test("calls an OpenAI-compatible chat completion and parses JSON content", async (t) => {
  let received = null;
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requestCount += 1;
      received = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      };
      if (requestCount === 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "temporary overload" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "```json\n{\"ok\":true}\n```" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  const appConfig = {
    textProvider: {
      apiStyle: "openai",
      model: "deepseek/deepseek-v4-flash",
      openaiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-key",
      maxOutputTokens: 2048,
    },
  };

  const result = await callTextModelJson(appConfig, {
    systemPrompt: "Return JSON",
    userPrompt: "ping",
    temperature: 0.2,
    retries: 2,
    delayMs: 1,
    maxOutputTokens: 1024,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requestCount, 2);
  assert.equal(buildTextProviderEndpoint(appConfig), `http://127.0.0.1:${address.port}/v1/chat/completions`);
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/v1/chat/completions");
  assert.equal(received.authorization, "Bearer fixture-key");
  assert.equal(received.body.model, "deepseek/deepseek-v4-flash");
  assert.equal(received.body.max_tokens, 1024);
  assert.deepEqual(received.body.response_format, { type: "json_object" });
  assert.deepEqual(received.body.messages.map((item) => item.role), ["system", "user"]);
  assert.equal("tools" in received.body, false);
});

test("streams long OpenAI-compatible JSON generations so active responses do not hit the idle timeout", async (t) => {
  let receivedBody = null;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      receivedBody = JSON.parse(raw);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data:{"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n');
      setTimeout(() => {
        response.write('data:{"choices":[{"delta":{"content":"true}"}}]}\n\n');
        response.end("data:[DONE]\n\n");
      }, 25);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const result = await callTextModelJson(
    {
      textProvider: {
        apiStyle: "openai",
        model: "deepseek/deepseek-v4-flash",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
        maxOutputTokens: 1024,
      },
    },
    {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      retries: 1,
      stream: true,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(receivedBody.stream, true);
});

test("retries a transient socket disconnect inside one streamed model call", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.socket.destroy();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data:{"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata:[DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const result = await callTextModelJson(
    {
      textProvider: {
        apiStyle: "openai",
        model: "deepseek/deepseek-v4-flash",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
        maxOutputTokens: 1024,
      },
    },
    {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      retries: 2,
      delayMs: 1,
      stream: true,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(requestCount, 2);
});

test("rejects an OpenAI-compatible stream that ends without the DONE marker", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data:{"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  await assert.rejects(
    callTextModelJson(
      {
        textProvider: {
          apiStyle: "openai",
          model: "deepseek/deepseek-v4-flash",
          openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "fixture-key",
          maxOutputTokens: 1024,
        },
      },
      {
        systemPrompt: "Return JSON",
        userPrompt: "ping",
        retries: 1,
        stream: true,
      },
    ),
    /ended before \[DONE\]/,
  );
});
