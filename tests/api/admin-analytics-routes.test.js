const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, createSessionForUser } = require("../../src/server/db/repositories/auth-repository");
const { upsertGeneration } = require("../../src/server/db/repositories/generation-repository");
const { createApiHandler } = require("../../src/server/api");
const { ensureAnalyticsBackfill } = require("../../src/server/analytics/analytics-backfill");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const adminUser = insertUser({
  id: 1,
  name: "管理员",
  phone: "13800000000",
  password: "hash",
  accountType: "yimei",
  credits: 100,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const normalUser = insertUser({
  id: 2,
  name: "普通用户",
  phone: "13800000002",
  password: "hash",
  accountType: "customer",
  credits: 50,
  createdAt: "2026-01-02T00:00:00.000Z",
});

const adminToken = "admin-session-token";
const normalToken = "normal-session-token";
createSessionForUser(adminUser.id, adminToken);
createSessionForUser(normalUser.id, normalToken);

ensureAnalyticsBackfill();

const appConfig = {
  admin: { phones: ["13800000000"] },
  security: { cookieSecure: false },
  textProvider: { model: "test-model", apiKey: "test" },
  imageProvider: { model: "test-image-model", apiKey: "test" },
};

const handleApi = createApiHandler({
  appConfig,
  store: {},
  ai: {
    imageJobs: new Map(),
    generateAiTrendSet: async () => {},
    regenerateTrendIdeas: async () => {},
    ensureTrendIdeaContentAssets: async () => {},
    createImageJob: () => {},
    resolveImageJob: () => {},
    buildImageJobResponse: () => {},
  },
});

function makeReq(urlPath, { method = "GET", headers = {}, body = null } = {}) {
  const stream = {
    method,
    url: urlPath,
    headers: {
      host: "127.0.0.1",
      ...headers,
    },
    on(event, handler) {
      if (event === "data" && body) {
        handler(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      }
      if (event === "end") {
        handler();
      }
      return this;
    },
  };
  return stream;
}

function makeRes() {
  const emitter = new EventEmitter();
  let statusCode = 200;
  const headers = {};
  let bodyText = "";
  return {
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    writeHead(code, h = {}) {
      statusCode = code;
      Object.assign(headers, h);
    },
    setHeader(k, v) {
      headers[k] = v;
    },
    end(chunk) {
      if (chunk) bodyText += chunk.toString();
      emitter.emit("finish");
    },
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get json() {
      return JSON.parse(bodyText || "{}");
    },
    get text() {
      return bodyText;
    },
  };
}

test("GET /api/admin/analytics/overview requires admin auth", async () => {
  // No cookie -> 401
  const res1 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview"), res1, "/api/admin/analytics/overview");
  assert.equal(res1.statusCode, 401);

  // Normal user cookie -> 403
  const res2 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview", {
    headers: { cookie: `redbase_session=${normalToken}` },
  }), res2, "/api/admin/analytics/overview");
  assert.equal(res2.statusCode, 403);

  // Admin cookie -> 200
  const res3 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res3, "/api/admin/analytics/overview");
  assert.equal(res3.statusCode, 200);
  assert.ok(res3.json.kpis);
  assert.ok(res3.json.trends);
  assert.ok(res3.json.coverage);
});

test("Analytics endpoints validate date range and return 400 on invalid input", async () => {
  const headers = { cookie: `redbase_session=${adminToken}` };

  // from >= to -> 400
  const res1 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview?from=2026-08-10&to=2026-08-01", { headers }), res1, "/api/admin/analytics/overview");
  assert.equal(res1.statusCode, 400);

  // invalid timezone -> 400
  const res2 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview?timezone=UTC", { headers }), res2, "/api/admin/analytics/overview");
  assert.equal(res2.statusCode, 400);

  // invalid date format -> 400
  const res3 = makeRes();
  await handleApi(makeReq("/api/admin/analytics/overview?from=not-a-date&to=2026-08-10", { headers }), res3, "/api/admin/analytics/overview");
  assert.equal(res3.statusCode, 400);
});

test("GET /api/admin/analytics/users returns activity, funnels, and retention", async () => {
  const res = makeRes();
  await handleApi(makeReq("/api/admin/analytics/users", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/analytics/users");
  assert.equal(res.statusCode, 200);
  assert.ok(res.json.mainFunnel);
  assert.ok(res.json.videoFunnel);
  assert.ok(res.json.retention);
  assert.ok(res.json.accountDistribution);
});

test("GET /api/admin/analytics/features returns all 10 features", async () => {
  const res = makeRes();
  await handleApi(makeReq("/api/admin/analytics/features", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/analytics/features");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.features.length, 10);
});

test("GET /api/admin/analytics/ai returns telemetry summary and D2/G2 comparison", async () => {
  const res = makeRes();
  await handleApi(makeReq("/api/admin/analytics/ai", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/analytics/ai");
  assert.equal(res.statusCode, 200);
  assert.ok(res.json.summary);
  assert.ok(res.json.errorStages);
});

test("GET /api/admin/analytics/finance returns revenue, channels, and plan packages", async () => {
  const res = makeRes();
  await handleApi(makeReq("/api/admin/analytics/finance", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/analytics/finance");
  assert.equal(res.statusCode, 200);
  assert.ok(res.json.overview);
  assert.ok(res.json.channelComparison);
});

test("GET /api/admin/analytics/system returns database size, queues, and alerts", async () => {
  const res = makeRes();
  await handleApi(makeReq("/api/admin/analytics/system", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/analytics/system");
  assert.equal(res.statusCode, 200);
  assert.ok(res.json.database);
  assert.ok(res.json.imageJobs);
  assert.ok(res.json.videoJobs);
  assert.ok(res.json.assetPurge);
  assert.ok(Array.isArray(res.json.alerts));
});

test("Data management pagination endpoints return total, page, pageSize, items", async () => {
  const headers = { cookie: `redbase_session=${adminToken}` };

  const endpoints = [
    "/api/admin/data/users",
    "/api/admin/data/brands",
    "/api/admin/data/generations",
    "/api/admin/data/credit-events",
    "/api/admin/data/payment-orders",
    "/api/admin/data/video-projects",
  ];

  for (const ep of endpoints) {
    const res = makeRes();
    await handleApi(makeReq(`${ep}?page=1&pageSize=10`, { headers }), res, ep);
    assert.equal(res.statusCode, 200, `${ep} should return 200`);
    assert.equal(res.json.page, 1);
    assert.equal(res.json.pageSize, 10);
    assert.ok(Array.isArray(res.json.items));
  }
});

test("POST /api/analytics/events records client events safely", async () => {
  // Unauthenticated -> 401
  const res1 = makeRes();
  await handleApi(makeReq("/api/analytics/events", {
    method: "POST",
    body: { eventName: "video_studio_opened" },
  }), res1, "/api/analytics/events");
  assert.equal(res1.statusCode, 401);

  // Invalid event -> 400
  const res2 = makeRes();
  await handleApi(makeReq("/api/analytics/events", {
    method: "POST",
    headers: { cookie: `redbase_session=${normalToken}` },
    body: { eventName: "custom_unauthorized_event" },
  }), res2, "/api/analytics/events");
  assert.equal(res2.statusCode, 400);

  // Valid event -> 200
  const res3 = makeRes();
  await handleApi(makeReq("/api/analytics/events", {
    method: "POST",
    headers: { cookie: `redbase_session=${normalToken}` },
    body: { eventName: "video_studio_opened", metadata: { page: "studio" } },
  }), res3, "/api/analytics/events");
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.json.ok, true);
});

test("GET /api/admin/data/generations hydrates previewUrl and thumbnailUrl from storage", async () => {
  const gen = upsertGeneration({
    id: 101,
    ownerUserId: 1,
    type: "wechat",
    channelLabel: "公众号",
    brandId: 1,
    brandName: "特仑苏",
    trendId: 1,
    trendTitle: "秋日滋养",
    ideaTitle: "特仑苏长图",
    cardTitle: "特仑苏长图",
    createdAt: new Date().toISOString(),
    previewUrl: "/api/generated-images/101/file",
    summary: "微信公众号长图",
    payload: {
      localImage: {
        provider: "aliyun_oss",
        objectKey: "redbase/generated-images/users/1/2026/08/101/gi_101.png",
        storedPath: "",
      },
      imageUrl: "/api/generated-images/101/file",
      previewUrl: "/api/generated-images/101/file",
    },
  });

  const customStorage = {
    createReadUrl: async (asset, opts = {}) => {
      if (opts.process) return `https://oss.example.com/${asset.objectKey}?x-oss-process=${opts.process}`;
      return `https://oss.example.com/${asset.objectKey}`;
    },
  };

  const customHandleApi = createApiHandler({
    appConfig,
    store: {},
    ai: { imageJobs: new Map() },
    generatedAssetStorage: customStorage,
  });

  const res = makeRes();
  await customHandleApi(makeReq("/api/admin/data/generations?page=1&pageSize=10", {
    headers: { cookie: `redbase_session=${adminToken}` },
  }), res, "/api/admin/data/generations");

  assert.equal(res.statusCode, 200);
  const target = res.json.items.find((item) => item.id === 101);
  assert.ok(target, "generation 101 should be returned");
  assert.equal(target.previewUrl, "https://oss.example.com/redbase/generated-images/users/1/2026/08/101/gi_101.png");
  assert.ok(target.thumbnailUrl.includes("x-oss-process="));
});
