const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_APP_CONFIG, loadProjectEnvFile, readEnvValueFile, loadAppConfig } = require("../src/server/config");
const {
  fetchJson,
  fetchJsonNative,
  fetchOpenAIText,
  callTextModelJson,
  buildTextProviderEndpoint,
  buildTextProviderRequestOptions,
  createPinnedTextProviderLookup,
  resolveRunningHubAddresses,
} = require("../src/server/ai/text-provider");

test("caps buffered text-provider responses without retrying oversized payloads", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(512) } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

  for (const request of [
    () => fetchJson(url, { maxResponseBytes: 128 }),
    () => fetchOpenAIText(url, { maxResponseBytes: 128 }),
    () => fetchJsonNative(url, { maxResponseBytes: 128 }),
  ]) {
    await assert.rejects(request(), { code: "TEXT_PROVIDER_RESPONSE_TOO_LARGE" });
  }

  const callsBeforeModelRequest = requestCount;
  await assert.rejects(
    callTextModelJson({
      textProvider: {
        apiStyle: "openai",
        model: "deepseek/deepseek-v4-flash",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
      },
    }, {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      maxAttempts: 3,
      delayMs: 1,
      maxResponseBytes: 128,
    }),
    { code: "TEXT_PROVIDER_RESPONSE_TOO_LARGE" },
  );
  assert.equal(requestCount, callsBeforeModelRequest + 1);
});

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

test("limits RunningHub requests to TLS 1.2 without changing other text providers", () => {
  const lookup = createPinnedTextProviderLookup("1.1.1.1", 4);
  const runningHubOptions = buildTextProviderRequestOptions(
    new URL("https://llm.runninghub.ai/v1/chat/completions"),
    { method: "POST", headers: {}, lookup },
  );
  const otherHttpsOptions = buildTextProviderRequestOptions(
    new URL("https://example.com/v1/chat/completions"),
    { method: "POST", headers: {} },
  );
  const localHttpOptions = buildTextProviderRequestOptions(
    new URL("http://127.0.0.1:3000/v1/chat/completions"),
    { method: "POST", headers: {} },
  );

  assert.equal(runningHubOptions.maxVersion, "TLSv1.2");
  assert.equal(runningHubOptions.lookup, lookup);
  assert.equal(Object.hasOwn(otherHttpsOptions, "maxVersion"), false);
  assert.equal(Object.hasOwn(localHttpOptions, "maxVersion"), false);
});

test("resolves and pins every RunningHub edge without affecting other providers", async () => {
  const addresses = await resolveRunningHubAddresses(
    new URL("https://llm.runninghub.ai/v1/chat/completions"),
    async () => [
      { address: "43.175.132.232", family: 4 },
      { address: "43.168.19.45", family: 4 },
      { address: "43.175.132.232", family: 4 },
    ],
  );
  assert.deepEqual(addresses, [
    { address: "43.175.132.232", family: 4 },
    { address: "43.168.19.45", family: 4 },
  ]);
  assert.deepEqual(await resolveRunningHubAddresses(
    new URL("https://example.com/v1/chat/completions"),
    async () => { throw new Error("should not resolve"); },
  ), []);
  await assert.rejects(
    resolveRunningHubAddresses(
      new URL("https://llm.runninghub.ai/v1/chat/completions"),
      async () => [
        { address: "43.175.132.232", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ),
    { code: "TEXT_PROVIDER_DNS_ERROR" },
  );
  for (const address of [
    "64:ff9b:1:a9fe:a9:fe00::",
    "100::1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "64:ff9b:1::8.8.8.8",
    "2001:db8::8.8.8.8",
  ]) {
    await assert.rejects(
      resolveRunningHubAddresses(
        new URL("https://llm.runninghub.ai/v1/chat/completions"),
        async () => [{ address, family: 6 }],
      ),
      { code: "TEXT_PROVIDER_DNS_ERROR" },
      address,
    );
  }
  assert.deepEqual(
    await resolveRunningHubAddresses(
      new URL("https://llm.runninghub.ai/v1/chat/completions"),
      async () => [{ address: "2606:4700:4700::1111", family: 6 }],
    ),
    [{ address: "2606:4700:4700::1111", family: 6 }],
  );
  await assert.rejects(
    resolveRunningHubAddresses(
      new URL("https://llm.runninghub.ai/v1/chat/completions"),
      async () => { throw new Error("dns unavailable"); },
    ),
    { code: "TEXT_PROVIDER_DNS_ERROR" },
  );
  await assert.rejects(
    resolveRunningHubAddresses(
      new URL("https://llm.runninghub.ai/v1/chat/completions"),
      async () => new Promise(() => {}),
      { timeoutMs: 10 },
    ),
    { code: "TEXT_PROVIDER_DNS_ERROR" },
  );
  const pinnedLookup = createPinnedTextProviderLookup(addresses[0].address, addresses[0].family);
  assert.deepEqual(await new Promise((resolve, reject) => pinnedLookup("llm.runninghub.ai", { all: true }, (error, value) => (
    error ? reject(error) : resolve(value)
  ))), [{ address: "43.175.132.232", family: 4 }]);
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

test("keeps enough AnySearch retries to reach every direct CDN edge", () => {
  const previous = process.env.ANYSEARCH_RETRIES;
  try {
    process.env.ANYSEARCH_RETRIES = "1";
    assert.equal(loadAppConfig().searchProvider.retries, 3);
  } finally {
    if (previous === undefined) delete process.env.ANYSEARCH_RETRIES;
    else process.env.ANYSEARCH_RETRIES = previous;
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
  const telemetry = [];
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
    onTelemetry(event) {
      telemetry.push(event);
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requestCount, 1);
  assert.equal(buildTextProviderEndpoint(appConfig), `http://127.0.0.1:${address.port}/v1/chat/completions`);
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/v1/chat/completions");
  assert.equal(received.authorization, "Bearer fixture-key");
  assert.equal(received.body.model, "deepseek/deepseek-v4-flash");
  assert.equal(received.body.max_tokens, 1024);
  assert.deepEqual(received.body.response_format, { type: "json_object" });
  assert.deepEqual(received.body.messages.map((item) => item.role), ["system", "user"]);
  assert.equal("tools" in received.body, false);
  assert.deepEqual(telemetry.filter((event) => event.type === "attempt").map((event) => event.attempt), [1]);
  assert.ok(telemetry.some((event) => event.type === "first-byte" && event.statusCode === 200));
  assert.ok(telemetry.some((event) => event.type === "complete" && event.statusCode === 200));
});

test("shares one timeout budget across text-provider transport retries", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      setTimeout(() => response.socket.destroy(), 20);
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    }, 200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const startedAt = Date.now();

  await assert.rejects(
    callTextModelJson({
      textProvider: {
        apiStyle: "openai",
        model: "fixture-model",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
      },
    }, {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      timeoutMs: 90,
      maxAttempts: 2,
      delayMs: 30,
    }),
    { code: "ETIMEDOUT" },
  );

  assert.equal(requestCount, 2);
  assert.ok(Date.now() - startedAt < 125, "retry must not receive a fresh 90ms timeout");
});

test("does not retry an OpenAI-compatible request after an HTTP response arrives", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporary overload" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  await assert.rejects(
    callTextModelJson({
      textProvider: {
        apiStyle: "openai",
        model: "fixture-model",
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture-key",
      },
    }, {
      systemPrompt: "Return JSON",
      userPrompt: "ping",
      maxAttempts: 3,
      delayMs: 1,
    }),
    { statusCode: 503, retryable: false },
  );

  assert.equal(requestCount, 1);
});

test("redacts provider credentials from propagated HTTP errors", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Authorization: Bearer fixture-text-secret" } }));
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
        maxAttempts: 1,
      },
    ),
    (error) => {
      assert.doesNotMatch(error.message, /fixture-text-secret/);
      assert.doesNotMatch(String(error.rawBody || ""), /fixture-text-secret/);
      assert.doesNotMatch(JSON.stringify(error.payload || {}), /fixture-text-secret/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("streams long OpenAI-compatible JSON generations so active responses do not hit the idle timeout", async (t) => {
  let receivedBody = null;
  const telemetry = [];
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
        response.write('data:{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n');
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
      maxAttempts: 1,
      stream: true,
      onTelemetry(event) {
        telemetry.push(event);
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(receivedBody.stream, true);
  assert.ok(telemetry.some((event) => event.type === "first-byte" && event.elapsedMs >= 0));
  assert.deepEqual(telemetry.find((event) => event.type === "usage")?.usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  });
  assert.ok(telemetry.some((event) => event.type === "complete"));
});

test("enforces the configured model timeout as a total wall-clock deadline", async (t) => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data:{"choices":[{"delta":{"content":"{"}}]}\n\n');
    const interval = setInterval(() => {
      response.write('data:{"choices":[{"delta":{"content":" "}}]}\n\n');
    }, 10);
    response.on("close", () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const startedAt = Date.now();

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
        timeoutMs: 40,
        maxAttempts: 1,
        stream: true,
      },
    ),
    /Request timeout/,
  );

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 30, `deadline fired unexpectedly early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 200, `trickled response exceeded the wall-clock deadline: ${elapsedMs}ms`);
});

test("retries a transient socket disconnect inside one streamed model call", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      setTimeout(() => response.socket.destroy(), 10);
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

test("does not retry a streamed model request after a non-success response arrives", async (t) => {
  let requestCount = 0;
  const telemetry = [];
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporary overload" } }));
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
        maxAttempts: 3,
        delayMs: 1,
        stream: true,
        onTelemetry(event) {
          telemetry.push(event);
        },
      },
    ),
    { statusCode: 503, retryable: false },
  );

  assert.equal(requestCount, 1);
  assert.deepEqual(telemetry.filter((event) => event.type === "attempt").map((event) => event.attempt), [1]);
});

test("does not retry when a streamed response aborts after the first byte", async (t) => {
  let requestCount = 0;
  const telemetry = [];
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requestCount === 1) {
      response.write('data:{"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n');
      setTimeout(() => response.socket.destroy(), 10);
      return;
    }
    response.end('data:{"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata:[DONE]\n\n');
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
        maxAttempts: 2,
        delayMs: 1,
        stream: true,
        onTelemetry(event) {
          telemetry.push(event);
        },
      },
    ),
    /aborted/,
  );

  assert.equal(requestCount, 1);
  assert.deepEqual(telemetry.filter((event) => event.type === "attempt").map((event) => event.attempt), [1]);
});

test("does not retry a streamed request that times out after the first byte", async (t) => {
  let requestCount = 0;
  const telemetry = [];
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data:{"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n');
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
        timeoutMs: 40,
        maxAttempts: 2,
        delayMs: 1,
        stream: true,
        onTelemetry(event) {
          telemetry.push(event);
        },
      },
    ),
    { code: "EOPENAI_RESPONSE_TIMEOUT" },
  );

  assert.equal(requestCount, 1);
  assert.deepEqual(telemetry.filter((event) => event.type === "attempt").map((event) => event.attempt), [1]);
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
