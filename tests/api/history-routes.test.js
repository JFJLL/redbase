const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { upsertGeneration } = require("../../src/server/db/repositories/generation-repository");
const { handleHistoryRoutes } = require("../../src/server/api/history-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Route Tester",
  phone: "13910000004",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});
insertSession({ token: "route-token", userId: 1, createdAt: "2026-05-02T00:00:00.000Z" });

function seedGeneration(input) {
  upsertGeneration({
    ownerUserId: 1,
    brandId: 10,
    brandName: "Route Brand",
    trendId: 1,
    trendTitle: "Route Trend",
    ideaTitle: "Route Idea",
    previewUrl: "",
    summary: "",
    payload: {},
    ...input,
  });
}

seedGeneration({
  id: 1,
  type: "moments",
  channelLabel: "朋友圈图",
  cardTitle: "朋友圈标题",
  summary: "包含关键词",
  createdAt: "2026-05-01T10:00:00.000Z",
});
seedGeneration({
  id: 2,
  type: "wechat",
  channelLabel: "公众号长图",
  cardTitle: "公众号标题",
  summary: "另一条",
  createdAt: "2026-05-02T10:00:00.000Z",
});

function createReq(url, cookie = "") {
  return {
    method: "GET",
    url,
    headers: {
      host: "localhost:3013",
      cookie,
    },
  };
}

function createRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = JSON.parse(data);
    },
  };
}

const context = { appConfig: { security: { assetSigningSecret: "test-secret" } } };

test("GET /api/history rejects unauthenticated requests", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(context, createReq("/api/history"), res, "/api/history");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test("GET /api/history returns unfiltered history for authenticated user", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(context, createReq("/api/history", "redbase_session=route-token"), res, "/api/history");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.generations.map((item) => item.id), [2, 1]);
});

test("GET /api/history applies type and keyword filters", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(
    context,
    createReq("/api/history?type=moments&q=%E5%85%B3%E9%94%AE", "redbase_session=route-token"),
    res,
    "/api/history",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.generations.map((item) => item.id), [1]);
});
