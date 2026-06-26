const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { upsertGeneration, findGenerationById } = require("../../src/server/db/repositories/generation-repository");
const { cleanupExpiredGenerationHistory, handleHistoryRoutes } = require("../../src/server/api/history-routes");

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

insertBrand({
  id: 10,
  ownerUserId: 1,
  name: "Route Brand",
  industry: "母婴",
  audience: "新手妈妈",
  description: "用于接口测试的品牌",
  product: "完整产品介绍不应出现在 summary",
  goal: "完整运营目标不应出现在 summary",
  knowledgeBase: "完整品牌资料库不应出现在 summary",
  logo: {
    originalName: "logo.png",
    storedPath: "uploads/brand-logos/users/1/route/logo.png",
    mimeType: "image/png",
    sizeBytes: 1200,
    createdAt: "2026-05-02T00:00:00.000Z",
  },
  assetTags: ["母婴", "内容运营"],
});
upsertBrandFull({
  id: 10,
  ownerUserId: 1,
  name: "Route Brand",
  industry: "母婴",
  audience: "新手妈妈",
  description: "用于接口测试的品牌",
  product: "完整产品介绍不应出现在 summary",
  goal: "完整运营目标不应出现在 summary",
  knowledgeBase: "完整品牌资料库不应出现在 summary",
  logo: {
    originalName: "logo.png",
    storedPath: "uploads/brand-logos/users/1/route/logo.png",
    mimeType: "image/png",
    sizeBytes: 1200,
    createdAt: "2026-05-02T00:00:00.000Z",
  },
  assetTags: ["母婴", "内容运营"],
  analyses: [
    {
      id: 9001,
      name: "历史分析",
      timestamp: "2026-05-02T00:00:00.000Z",
      brandBrief: {},
      trendSnapshot: [],
    },
  ],
  trends: [
    {
      key: "global",
      title: "全网热点指数",
      description: "测试维度",
      items: [
        {
          id: 100,
          stableKey: "route-trend",
          rank: 1,
          title: "测试趋势",
          category: "测试",
          summary: "测试摘要",
          score: 90,
          reason: "测试原因",
          ideas: [],
        },
      ],
    },
  ],
});

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
seedGeneration({
  id: 3,
  type: "moments",
  channelLabel: "朋友圈图",
  brandId: 20,
  brandName: "Other Brand",
  cardTitle: "其他品牌标题",
  summary: "其他摘要",
  createdAt: "2026-05-03T10:00:00.000Z",
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

const context = {
  appConfig: { security: { assetSigningSecret: "test-secret" } },
  historyRetentionNowMs: Date.parse("2026-05-04T00:00:00.000Z"),
};

test("GET /api/history rejects unauthenticated requests", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(context, createReq("/api/history"), res, "/api/history");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test("GET /api/brands summary returns lightweight signed brand records", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(
    context,
    createReq("/api/brands?summary=1", "redbase_session=route-token"),
    res,
    "/api/brands",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.brands.length, 1);
  const brand = res.body.brands[0];
  assert.equal(brand.id, 10);
  assert.equal(brand.name, "Route Brand");
  assert.equal(brand.trendCount, 1);
  assert.equal(brand.analysisCount, 1);
  assert.equal(brand.logo.url.includes("assetSignature="), true);
  assert.equal("knowledgeBase" in brand, false);
  assert.equal("product" in brand, false);
  assert.equal("goal" in brand, false);
  assert.equal("trends" in brand, false);
  assert.equal("analyses" in brand, false);
});

test("GET /api/history returns unfiltered history for authenticated user", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(context, createReq("/api/history", "redbase_session=route-token"), res, "/api/history");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.generations.map((item) => item.id), [3, 2, 1]);
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

test("GET /api/history combines brand and type filters", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(
    context,
    createReq("/api/history?brandId=10&type=moments", "redbase_session=route-token"),
    res,
    "/api/history",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.generations.map((item) => item.id), [1]);
});

test("cleanupExpiredGenerationHistory removes expired rows and local files", async () => {
  seedGeneration({
    id: 4,
    type: "moments",
    channelLabel: "朋友圈图",
    cardTitle: "过期生成",
    createdAt: "2026-05-01T00:00:00.000Z",
    payload: {
      localImage: {
        storedPath: "uploads/generated-images/users/1/2026/05/expired.png",
      },
    },
  });
  seedGeneration({
    id: 5,
    type: "moments",
    channelLabel: "朋友圈图",
    cardTitle: "未过期生成",
    createdAt: "2026-05-10T00:00:00.000Z",
    payload: {
      localImage: {
        storedPath: "uploads/generated-images/users/1/2026/05/fresh.png",
      },
    },
  });

  const removedGenerationIds = [];
  const result = await cleanupExpiredGenerationHistory({
    nowMs: Date.parse("2026-05-12T00:00:00.000Z"),
    removeGenerationLocalFiles: async (generation) => {
      removedGenerationIds.push(generation.id);
    },
  });

  assert.equal(findGenerationById(4), null);
  assert.equal(findGenerationById(5).id, 5);
  assert.equal(result.deletedGenerationIds.includes(4), true);
  assert.equal(removedGenerationIds.includes(4), true);
  assert.equal(removedGenerationIds.includes(5), false);
});
