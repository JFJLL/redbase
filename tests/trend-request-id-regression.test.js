const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

test("trend retries reuse an ambiguous request ID and rotate only after terminal client failures", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const names = [
    "getTrendAnalysisRequestKey",
    "getOrCreateTrendAnalysisRequestId",
    "clearTrendAnalysisRequestId",
    "shouldResetTrendAnalysisRequestId",
  ];
  let generated = 0;
  const context = {
    DEFAULT_TREND_MODE: "xhs",
    normalizeTrendBucketKey: (value) => value,
    trendAnalysisRequestIds: new Map(),
    window: {
      crypto: {
        randomUUID: () => `request-${++generated}`,
      },
    },
  };
  vm.runInNewContext(
    `${names.map((name) => extractFunction(source, name)).join("\n")}; globalThis.tracker = { getOrCreateTrendAnalysisRequestId, clearTrendAnalysisRequestId, shouldResetTrendAnalysisRequestId };`,
    context,
  );

  const first = context.tracker.getOrCreateTrendAnalysisRequestId(7, "traffic");
  assert.equal(context.tracker.getOrCreateTrendAnalysisRequestId(7, "traffic"), first);
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId(new TypeError("socket closed")), false);
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId({ status: 408 }), false);
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId({ status: 409 }), false);
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId({ status: 500 }), false);
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId({ status: 504 }), false);
  assert.equal(context.tracker.getOrCreateTrendAnalysisRequestId(7, "traffic"), first);

  const validationFailure = { status: 422 };
  assert.equal(context.tracker.shouldResetTrendAnalysisRequestId(validationFailure), true);
  if (context.tracker.shouldResetTrendAnalysisRequestId(validationFailure)) {
    context.tracker.clearTrendAnalysisRequestId(7, "traffic");
  }
  assert.notEqual(context.tracker.getOrCreateTrendAnalysisRequestId(7, "traffic"), first);
});

test("API client exposes HTTP status so retry policy can distinguish terminal responses", async () => {
  const source = fs
    .readFileSync(path.join(__dirname, "../public/js/api-client.js"), "utf8")
    .replace(/^import .*\r?\n/, "const IMAGE_JOB_MAX_WAIT_MS = 1000; const IMAGE_JOB_POLL_INTERVAL_MS = 1;\n")
    .replace(/export /g, "");
  const context = {
    fetch: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "模型请求失败" }),
    }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${source}; globalThis.apiClient = { configureApiClient, request };`, context);
  context.apiClient.configureApiClient();

  await assert.rejects(
    context.apiClient.request("/api/brands/7/analyses", { method: "POST" }),
    (error) => error.message === "模型请求失败" && error.status === 500,
  );
});
