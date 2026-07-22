const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

process.env.REDBASE_DB_FILE = ":memory:";

const { handleAuthRoutes } = require("../src/server/api/auth-routes");

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async " ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    writeHead(code, values = {}) {
      this.statusCode = code;
      Object.entries(values).forEach(([key, value]) => headers.set(key.toLowerCase(), value));
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end() {},
  };
}

test("clearSession removes user-scoped dashboard data after a 401", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const clearFreshTimerSource = extractFunction(source, "clearExcellentFreshCheckTimer");
  const clearFreshStateSource = extractFunction(source, "clearExcellentFreshCheckState");
  const clearSessionSource = extractFunction(source, "clearSession");
  const calls = [];
  const state = {
    sessionToken: "cookie",
    currentUser: { id: 1 },
    brands: [{ id: 69, name: "管理员品牌" }],
    generationHistory: [{ id: 1 }],
    generationHistoryFilters: {
      q: "管理员私有项目",
      brandId: "69",
      type: "xhsCarousel",
      from: "2026-07-01",
      to: "2026-07-20",
    },
    generationHistoryNeedsLatest: true,
    selectedBrandId: 69,
    selectedTrendId: 100,
    selectedTrendMode: "xhs",
    brandDetailLoadingId: 69,
    xhsCategoryPath: "a/b",
    xhsCategories: [{ id: 1 }],
    xhsCategoryStatus: "ready",
    xhsCategoryError: "old error",
    excellentContents: [{ noteId: "n1" }],
    excellentContentFilters: { categoryPath: "美妆", source: "xhs_hot" },
    excellentContentStatus: "ready",
    excellentContentError: "old",
    excellentContentUpdatedAt: "2026-07-01T00:00:00.000Z",
    excellentContentStale: true,
    excellentContentRequestId: 9,
    trendAnalysisLoadingKeys: ["69:xhs"],
    productImages: { 0: [{ id: 1 }] },
    productImageLibrary: [{ id: 1 }],
    productImagePickerIdeaIndex: 0,
    brandLogoUsage: { 0: true },
    editingIdeas: { 0: "private copy" },
    styleReferences: { 0: "private style" },
    resumingImageTasks: true,
  };
  const pendingFilterTimer = { id: 1 };
  const pendingFreshTimer = { id: 2 };
  const context = {
    DEFAULT_TREND_MODE: "traffic",
    sessionEpoch: 3,
    state,
    brandDetailRequests: new Map([[69, Promise.resolve()]]),
    trendAnalysisRequestIds: new Map([["69:xhs", "request-1"]]),
    dashboardScrollPositions: new Map([["brands", 200]]),
    retriedHistoryImagePaths: new Set(["/private/image.png"]),
    historyImageSignatureRefreshInFlight: Promise.resolve(),
    historyFilterTimer: pendingFilterTimer,
    excellentFreshCheckTimer: pendingFreshTimer,
    excellentFreshCheckKey: "xhs_hot::美妆",
    excellentFreshCheckAttempted: new Set(["xhs_hot::美妆"]),
    clearTimeout: (timer) => calls.push(`clearTimeout:${timer.id}`),
    document: {
      querySelectorAll: () => [],
    },
    renderUser: () => calls.push("renderUser"),
    renderAll: () => calls.push("renderAll"),
    switchPage: (page) => calls.push(`switchPage:${page}`),
    closeAccountCenterModal: () => calls.push("closeAccountCenterModal"),
  };

  vm.runInNewContext(
    `${clearFreshTimerSource}; ${clearFreshStateSource}; ${clearSessionSource}; clearSession();`,
    context,
  );

  assert.equal(state.sessionToken, "");
  assert.equal(state.currentUser, null);
  assert.equal(state.brands.length, 0);
  assert.equal(state.generationHistory.length, 0);
  assert.equal(state.generationHistoryFilters.q, "");
  assert.equal(state.generationHistoryFilters.brandId, "");
  assert.equal(state.generationHistoryFilters.type, "");
  assert.equal(state.generationHistoryFilters.from, "");
  assert.equal(state.generationHistoryFilters.to, "");
  assert.equal(state.xhsCategories.length, 0);
  assert.equal(state.excellentContents.length, 0);
  assert.equal(state.excellentContentStatus, "idle");
  assert.equal(state.excellentContentRequestId, 0);
  assert.equal(state.productImageLibrary.length, 0);
  assert.equal(Object.keys(state.productImages).length, 0);
  assert.equal(Object.keys(state.editingIdeas).length, 0);
  assert.equal(Object.keys(state.styleReferences).length, 0);
  assert.equal(context.brandDetailRequests.size, 0);
  assert.equal(context.trendAnalysisRequestIds.size, 0);
  assert.equal(context.dashboardScrollPositions.size, 0);
  assert.equal(context.retriedHistoryImagePaths.size, 0);
  assert.equal(context.historyImageSignatureRefreshInFlight, null);
  assert.equal(context.historyFilterTimer, null);
  assert.equal(context.excellentFreshCheckTimer, null);
  assert.equal(context.excellentFreshCheckKey, "");
  assert.equal(context.excellentFreshCheckAttempted.size, 0);
  assert.equal(context.sessionEpoch, 4);
  assert.deepEqual(calls, [
    "clearTimeout:2",
    "clearTimeout:1",
    "renderUser",
    "renderAll",
    "switchPage:landing",
    "closeAccountCenterModal",
  ]);
});

test("API client discards stale responses without clearing a newer session", async () => {
  const source = fs
    .readFileSync(path.join(__dirname, "../public/js/api-client.js"), "utf8")
    .replace(/^import .*\r?\n/, "const IMAGE_JOB_MAX_WAIT_MS = 1000; const IMAGE_JOB_POLL_INTERVAL_MS = 1;\n")
    .replace(/export /g, "");
  let resolveFetch;
  const context = {
    fetch: () => new Promise((resolve) => {
      resolveFetch = resolve;
    }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    `${source}; globalThis.apiClient = { configureApiClient, request, isStaleSessionRequest };`,
    context,
  );
  let sessionEpoch = 1;
  let unauthorizedCalls = 0;
  context.apiClient.configureApiClient({
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
    getRequestContext: () => sessionEpoch,
    isRequestContextCurrent: (requestEpoch) => requestEpoch === sessionEpoch,
  });

  const pending = context.apiClient.request("/api/brands/69");
  sessionEpoch = 2;
  resolveFetch({
    ok: false,
    status: 401,
    json: async () => ({ error: "旧会话已失效", brand: { id: 69 } }),
  });

  await assert.rejects(pending, (error) => error.code === "STALE_SESSION_REQUEST");
  assert.equal(unauthorizedCalls, 0);
});

test("API client marks the current 401 request stale after clearing its session", async () => {
  const source = fs
    .readFileSync(path.join(__dirname, "../public/js/api-client.js"), "utf8")
    .replace(/^import .*\r?\n/, "const IMAGE_JOB_MAX_WAIT_MS = 1000; const IMAGE_JOB_POLL_INTERVAL_MS = 1;\n")
    .replace(/export /g, "");
  let sessionEpoch = 1;
  const context = {
    fetch: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "会话已失效" }),
    }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    `${source}; globalThis.apiClient = { configureApiClient, request };`,
    context,
  );
  let unauthorizedCalls = 0;
  context.apiClient.configureApiClient({
    onUnauthorized: () => {
      unauthorizedCalls += 1;
      sessionEpoch += 1;
    },
    getRequestContext: () => sessionEpoch,
    isRequestContextCurrent: (requestEpoch) => requestEpoch === sessionEpoch,
  });

  await assert.rejects(
    context.apiClient.request("/api/image-jobs/old-account-job"),
    (error) => error.code === "STALE_SESSION_REQUEST",
  );
  assert.equal(unauthorizedCalls, 1);
});

test("file uploads stop when the account changes during local file reading", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const assertSessionEpochSource = extractFunction(source, "assertSessionEpoch");
  const uploadProductImageSource = extractFunction(source, "uploadProductImage");
  let resolveFileRead;
  let requestCalls = 0;
  const context = {
    sessionEpoch: 7,
    fileToDataUrl: () => new Promise((resolve) => {
      resolveFileRead = resolve;
    }),
    request: async () => {
      requestCalls += 1;
      return { image: { id: 1 } };
    },
    upsertProductImageLibrary: () => assert.fail("a stale upload must not update the new account library"),
  };

  vm.runInNewContext(
    `${assertSessionEpochSource}; ${uploadProductImageSource}; globalThis.pending = uploadProductImage({ name: "old-account.png" });`,
    context,
  );
  context.sessionEpoch = 8;
  resolveFileRead("data:image/png;base64,old-account");

  await assert.rejects(context.pending, (error) => error.code === "STALE_SESSION_REQUEST");
  assert.equal(requestCalls, 0);
});

test("restoreSession ignores a stale startup request instead of clearing a newer login", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const restoreSessionSource = extractFunction(source, "restoreSession");
  let clearSessionCalls = 0;
  const context = {
    request: async () => {
      const error = new Error("stale startup request");
      error.code = "STALE_SESSION_REQUEST";
      throw error;
    },
    isStaleSessionRequest: (error) => error?.code === "STALE_SESSION_REQUEST",
    clearSession: () => {
      clearSessionCalls += 1;
    },
    applySession: () => assert.fail("stale restore must not apply a session"),
    loadBrands: () => assert.fail("stale restore must not load brands"),
    switchPage: () => assert.fail("stale restore must not change the newer page"),
    switchTab: () => assert.fail("stale restore must not change the newer tab"),
    resumePendingImageTasks: () => assert.fail("stale restore must not resume old tasks"),
    renderUser: () => assert.fail("stale restore must not rerender the newer user"),
  };

  vm.runInNewContext(`${restoreSessionSource}; globalThis.pending = restoreSession();`, context);
  await context.pending;
  assert.equal(clearSessionCalls, 0);
});

test("pending image recovery stops before requesting another account task", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const resumeSource = extractFunction(source, "resumePendingImageTasks");
  const processed = [];
  const context = {
    sessionEpoch: 1,
    state: {
      resumingImageTasks: false,
      sessionToken: "cookie",
      currentUser: { id: 1 },
    },
    getCurrentUserPendingImageTasks: () => [{ id: "a-1" }, { id: "a-2" }],
    showToast: () => {},
    resumePendingImageTask: async (task) => {
      processed.push(task.id);
      context.sessionEpoch = 2;
    },
  };

  vm.runInNewContext(`${resumeSource}; globalThis.pending = resumePendingImageTasks();`, context);
  await context.pending;
  assert.deepEqual(processed, ["a-1"]);
});

test("stale category responses do not overwrite a newer session state", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const loadCategoriesSource = extractFunction(source, "loadXhsCategories");
  const applied = [];
  let renders = 0;
  const context = {
    state: {
      sessionToken: "cookie",
      xhsCategoryStatus: "ready",
      xhsCategoryError: "",
    },
    request: async () => {
      context.state.xhsCategoryStatus = "ready";
      const error = new Error("stale category response");
      error.code = "STALE_SESSION_REQUEST";
      throw error;
    },
    isStaleSessionRequest: (error) => error?.code === "STALE_SESSION_REQUEST",
    applyXhsCategoryResult: (result) => applied.push(result),
    renderXhsCategorySelector: () => {
      renders += 1;
    },
  };

  vm.runInNewContext(`${loadCategoriesSource}; globalThis.pending = loadXhsCategories();`, context);
  await context.pending;
  assert.equal(applied.length, 0);
  assert.equal(renders, 1);
  assert.equal(context.state.xhsCategoryStatus, "ready");
  assert.equal(context.state.xhsCategoryError, "");
});

test("Feishu start logs the selected app and exact redirect URI without credentials", async () => {
  const req = {
    method: "GET",
    url: "/api/auth/feishu/start?app=yimei",
    headers: {
      host: "127.0.0.1:3013",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "redbase.china-yimei.cn",
    },
  };
  const res = createRes();
  const entries = [];
  const originalLog = console.log;
  console.log = (...args) => entries.push(args);
  try {
    await handleAuthRoutes(
      {
        appConfig: {
          security: { cookieSecure: true },
          feishu: {
            enabled: true,
            baseUrl: "https://redbase.china-yimei.cn",
            apps: [
              {
                key: "yimei",
                name: "易美传播",
                appId: "cli_test",
                appSecret: "secret_test",
                tenantKeys: ["tenant_test"],
              },
            ],
          },
        },
      },
      req,
      res,
      "/api/auth/feishu/start",
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(res.statusCode, 302);
  assert.deepEqual(entries, [[
    "[feishu-auth] authorize redirect",
    {
      appKey: "yimei",
      redirectUri: "https://redbase.china-yimei.cn/api/auth/feishu/callback",
      requestBaseUrl: "https://redbase.china-yimei.cn",
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(entries), /cli_test|secret_test|tenant_test/);
});
