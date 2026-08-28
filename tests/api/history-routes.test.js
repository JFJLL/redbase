const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { upsertGeneration, findGenerationById } = require("../../src/server/db/repositories/generation-repository");
const { cleanupExpiredGenerationHistory, handleHistoryRoutes, resolveLegacyVideoScriptIdeaIndex } = require("../../src/server/api/history-routes");

test("legacy video script history safely recovers a unique idea index from its trend title", () => {
  const generation = { type: "videoScript", trendId: 88, ideaTitle: "第二个选题", payload: {} };
  const brand = {
    trends: [{ items: [{ id: 88, ideas: [{ title: "第一个选题" }, { title: "第二个选题" }] }] }],
  };
  assert.equal(resolveLegacyVideoScriptIdeaIndex(generation, brand), 1);
  assert.equal(resolveLegacyVideoScriptIdeaIndex({ ...generation, ideaTitle: "不存在" }, brand), null);
  assert.equal(resolveLegacyVideoScriptIdeaIndex({ ...generation, payload: { ideaIndex: 0 } }, brand), 0);
});

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

test("GET /api/history accepts video script and project type filters", async () => {
  for (const type of ["videoScript", "videoProject"]) {
    const res = createRes();
    const handled = await handleHistoryRoutes(
      context,
      createReq(`/api/history?type=${type}`, "redbase_session=route-token"),
      res,
      "/api/history",
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.generations, []);
  }
});

test("GET /api/history still applies the normal type filter after adding video types", async () => {
  const res = createRes();
  const handled = await handleHistoryRoutes(
    context,
    createReq("/api/history?type=moments", "redbase_session=route-token"),
    res,
    "/api/history",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.generations.map((item) => item.id), [3, 1]);
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

test("GET /api/history omits videoScript superseded by a videoProject and DELETE cleans up both", async () => {
  seedGeneration({
    id: 50,
    type: "videoScript",
    channelLabel: "视频脚本",
    cardTitle: "被视频替代的脚本",
    createdAt: "2026-05-03T11:00:00.000Z",
    payload: { ideaIndex: 0, videoScript: { title: "被视频替代的脚本", clips: [] } },
  });
  seedGeneration({
    id: 51,
    type: "videoProject",
    channelLabel: "AI 视频",
    cardTitle: "由脚本生成的视频项目",
    createdAt: "2026-05-03T11:05:00.000Z",
    payload: {
      sourceVideoScriptGenerationId: 50,
      projectId: 5001,
      videoModel: "d2",
      videoStatus: "completed",
      videoScript: { title: "由脚本生成的视频项目", clips: [] },
    },
  });
  seedGeneration({
    id: 52,
    type: "videoScript",
    channelLabel: "视频脚本",
    cardTitle: "独立的未生成视频脚本",
    createdAt: "2026-05-03T11:10:00.000Z",
    payload: { ideaIndex: 1, videoScript: { title: "独立的未生成视频脚本", clips: [] } },
  });

  const res = createRes();
  const handled = await handleHistoryRoutes(
    context,
    createReq("/api/history", "redbase_session=route-token"),
    res,
    "/api/history",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const returnedIds = res.body.generations.map((item) => item.id);
  assert.equal(returnedIds.includes(51), true); // videoProject is returned
  assert.equal(returnedIds.includes(52), true); // standalone script is returned
  assert.equal(returnedIds.includes(50), false); // superseded script is omitted

  // Deleting the video project cleans up both id 51 and precursor id 50
  const deleteRes = createRes();
  const deleteHandled = await handleHistoryRoutes(
    { ...context, removeGenerationAssetsAndRows: async (gen, opts) => {
      const { deleteGenerationRows } = require("../../src/server/db/repositories/generation-repository");
      return deleteGenerationRows(gen.id, opts);
    }},
    { method: "DELETE", url: "/api/history/51", headers: { host: "localhost:3013", cookie: "redbase_session=route-token" } },
    deleteRes,
    "/api/history/51",
  );
  assert.equal(deleteHandled, true);
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(findGenerationById(51), null);
  assert.equal(findGenerationById(50), null);
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
        storedPath: "uploads/generated-images/users/1/2026/05/gi_4_expired.png",
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
        storedPath: "uploads/generated-images/users/1/2026/05/gi_5_fresh.png",
      },
    },
  });

  const removedStoredPaths = [];
  const result = await cleanupExpiredGenerationHistory({
    nowMs: Date.parse("2026-06-01T00:00:00.000Z"),
    storage: {
      deleteMany: async (assets) => {
        removedStoredPaths.push(...assets.map((asset) => asset.storedPath));
      },
    },
  });

  assert.equal(findGenerationById(4), null);
  assert.equal(findGenerationById(5).id, 5);
  assert.equal(result.deletedGenerationIds.includes(4), true);
  assert.equal(removedStoredPaths.includes("uploads/generated-images/users/1/2026/05/gi_4_expired.png"), true);
  assert.equal(removedStoredPaths.includes("uploads/generated-images/users/1/2026/05/gi_5_fresh.png"), false);
});
insertUser({
  id: 2,
  name: "Other Route Tester",
  phone: "13910000005",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});

test("manual history deletion uses the shared asset-and-row service and is idempotent", async () => {
  seedGeneration({
    id: 6,
    type: "moments",
    channelLabel: "朋友圈图",
    cardTitle: "手动删除",
    createdAt: "2026-05-03T00:00:00.000Z",
    payload: { localImage: { storedPath: "uploads/generated-images/users/1/2026/05/gi_6_manual.png" } },
  });
  const deletedAssets = [];
  const deleteContext = {
    ...context,
    generatedAssetStorage: { deleteMany: async (assets) => deletedAssets.push(...assets) },
  };
  const req = createReq("/api/history/6", "redbase_session=route-token");
  req.method = "DELETE";
  const firstRes = createRes();
  await handleHistoryRoutes(deleteContext, req, firstRes, "/api/history/6");
  assert.equal(firstRes.statusCode, 200);
  assert.equal(firstRes.body.deletedGenerationId, 6);
  assert.equal(deletedAssets[0].storedPath.endsWith("gi_6_manual.png"), true);
  assert.equal(findGenerationById(6), null);

  const secondRes = createRes();
  await handleHistoryRoutes(deleteContext, req, secondRes, "/api/history/6");
  assert.equal(secondRes.statusCode, 200);
  assert.equal(secondRes.body.alreadyDeleted, true);
});

test("manual history deletion does not reveal whether an id belongs to another tenant", async () => {
  upsertGeneration({
    id: 66,
    ownerUserId: 2,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 0,
    brandName: "",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: "other tenant",
    createdAt: "2026-05-03T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: {},
  });
  const deleteId = async (id) => {
    const req = createReq(`/api/history/${id}`, "redbase_session=route-token");
    req.method = "DELETE";
    const res = createRes();
    await handleHistoryRoutes(context, req, res, `/api/history/${id}`);
    return res;
  };
  const foreign = await deleteId(66);
  const absent = await deleteId(999999);
  assert.equal(foreign.statusCode, absent.statusCode);
  assert.equal(foreign.body.alreadyDeleted, absent.body.alreadyDeleted);
  assert.ok(findGenerationById(66));
});

test("reading an expired generated image deletes it through the shared service and returns not found", async () => {
  seedGeneration({
    id: 7,
    type: "moments",
    channelLabel: "朋友圈图",
    cardTitle: "读取时过期",
    createdAt: "2026-04-04T00:00:00.000Z",
    payload: { localImage: { storedPath: "uploads/generated-images/users/1/2026/04/gi_7_expired-on-read.png" } },
  });
  const res = {
    statusCode: 0,
    writeHead(code) { this.statusCode = code; },
    end() {},
  };
  const readContext = {
    ...context,
    historyRetentionNowMs: Date.parse("2026-05-04T00:00:00.000Z"),
    verifySignedAssetRequest: () => true,
    generatedAssetStorage: { deleteMany: async () => [] },
  };
  await handleHistoryRoutes(readContext, createReq("/api/generated-images/7/file"), res, "/api/generated-images/7/file");
  assert.equal(res.statusCode, 404);
  assert.equal(findGenerationById(7), null);
});

test("history list never returns expired rows even when a shared cleanup is already in flight", async () => {
  seedGeneration({
    id: 8,
    type: "moments",
    channelLabel: "朋友圈图",
    cardTitle: "并发清理过期",
    createdAt: "2026-04-04T00:00:00.000Z",
  });
  const res = createRes();
  await handleHistoryRoutes({
    ...context,
    historyRetentionNowMs: Date.parse("2026-05-04T00:00:00.000Z"),
    historyCleanupRunner: async () => ({ skipped: true, reason: "already_running" }),
  }, createReq("/api/history", "redbase_session=route-token"), res, "/api/history");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.generations.some((generation) => generation.id === 8), false);
});
