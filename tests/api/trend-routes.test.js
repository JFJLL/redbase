const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull, findBrandByOwner } = require("../../src/server/db/repositories/brand-repository");
const { handleTrendRoutes } = require("../../src/server/api/trend-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Trend Route Tester",
  phone: "13910000005",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});
insertUser({
  id: 2,
  name: "Other Trend User",
  phone: "13910000006",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});
insertSession({ token: "trend-route-token", userId: 1, createdAt: "2026-05-02T00:00:00.000Z" });
insertSession({ token: "other-trend-route-token", userId: 2, createdAt: "2026-05-02T00:00:00.000Z" });

function makeTrend(id, title) {
  return {
    id,
    stableKey: `trend-${id}`,
    bucketKey: "xhs",
    bucketTitle: "小红书热点话题",
    bucketDescription: "站内热点",
    rank: 1,
    title,
    category: "内容趋势",
    summary: "趋势摘要",
    score: 80,
    tags: ["#热点"],
    reason: "适合品牌内容化",
    ideas: [
      {
        title: "选题一",
        summary: "内容摘要",
        angle: "切入角度",
        brandFit: "品牌结合方式",
        audience: "目标人群",
        hook: "开头钩子",
        tags: ["#选题"],
        contentAssets: {
          moments: { title: "朋友圈", caption: "朋友圈文案", visualDirection: "视觉方向" },
          xhsCarousel: { title: "小红书", publishTitle: "发布标题", publishCaption: "发布文案", caption: "文案", slides: [] },
          wechatLongImage: { title: "公众号", publishTitle: "长图标题", intro: "导语", outline: [], positioning: "定位", cta: "行动", visualDirection: "视觉方向" },
        },
      },
      {
        title: "选题二",
        summary: "内容摘要",
        angle: "切入角度",
        brandFit: "品牌结合方式",
        audience: "目标人群",
        hook: "开头钩子",
        tags: ["#选题"],
        contentAssets: {
          moments: { title: "朋友圈", caption: "朋友圈文案", visualDirection: "视觉方向" },
          xhsCarousel: { title: "小红书", publishTitle: "发布标题", publishCaption: "发布文案", caption: "文案", slides: [] },
          wechatLongImage: { title: "公众号", publishTitle: "长图标题", intro: "导语", outline: [], positioning: "定位", cta: "行动", visualDirection: "视觉方向" },
        },
      },
    ],
  };
}

insertBrand({
  id: 30,
  ownerUserId: 1,
  name: "History Brand",
  industry: "内容运营",
  audience: "运营",
  description: "品牌描述",
  product: "运营工具",
  goal: "提升效率",
  knowledgeBase: "",
  assetTags: [],
});
upsertBrandFull({
  id: 30,
  ownerUserId: 1,
  name: "History Brand",
  industry: "内容运营",
  audience: "运营",
  description: "品牌描述",
  product: "运营工具",
  goal: "提升效率",
  knowledgeBase: "",
  logo: null,
  assetTags: [],
  analyses: [
    {
      id: 9001,
      name: "History Brand - 小红书热点话题",
      timestamp: "2026-05-02 10:00",
      brandBrief: {},
      trendSnapshot: [{ key: "xhs", title: "小红书热点话题", description: "站内热点", items: [makeTrend(100, "历史话题")] }],
    },
  ],
  trends: [{ key: "xhs", title: "小红书热点话题", description: "站内热点", items: [makeTrend(200, "当前话题")] }],
});

function createReq(url, method = "GET", cookie = "") {
  return {
    method,
    url,
    headers: {
      host: "localhost:3013",
      cookie,
    },
  };
}

function createJsonReq(url, payload, cookie = "") {
  const body = JSON.stringify(payload);
  const req = Readable.from([Buffer.from(body)]);
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  };
  return req;
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

test("DELETE /api/brands/:brandId/analyses/:analysisId removes only owned analysis snapshots", async () => {
  const unauthorizedRes = createRes();
  const unauthorizedHandled = await handleTrendRoutes(
    context,
    createReq("/api/brands/30/analyses/9001", "DELETE", "redbase_session=other-trend-route-token"),
    unauthorizedRes,
    "/api/brands/30/analyses/9001",
  );
  assert.equal(unauthorizedHandled, true);
  assert.equal(unauthorizedRes.statusCode, 404);

  const res = createRes();
  const handled = await handleTrendRoutes(
    context,
    createReq("/api/brands/30/analyses/9001", "DELETE", "redbase_session=trend-route-token"),
    res,
    "/api/brands/30/analyses/9001",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedAnalysisId, 9001);
  assert.deepEqual(res.body.brand.analyses, []);

  const brand = findBrandByOwner(30, 1);
  assert.equal(brand.analyses.length, 0);
  assert.equal(brand.trends[0].items[0].title, "当前话题");
});

test("POST trend analysis returns exactly ten items and replays the same request without a second charge", async () => {
  let modelCalls = 0;
  const generated = [{
    key: "traffic",
    title: "流量热点趋势",
    description: "流量内容形式",
    items: Array.from({ length: 10 }, (_, index) => ({
      ...makeTrend(300 + index, `流量趋势${index + 1}`),
      bucketKey: "traffic",
      bucketTitle: "流量热点趋势",
      rank: index + 1,
      score: 90 - index,
    })),
  }];
  const postContext = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    async generateAiTrendSet() {
      modelCalls += 1;
      return generated;
    },
  };
  const payload = { requestId: "trend-api-request-1", bucketKey: "traffic" };

  const firstRes = createRes();
  await handleTrendRoutes(
    postContext,
    createJsonReq("/api/brands/30/analyses", payload, "redbase_session=trend-route-token"),
    firstRes,
    "/api/brands/30/analyses",
  );
  assert.equal(firstRes.statusCode, 200);
  assert.equal(firstRes.body.brand.trends.find((bucket) => bucket.key === "traffic").items.length, 10);
  assert.equal(firstRes.body.user.credits, 4);
  assert.equal(modelCalls, 1);

  const replayRes = createRes();
  await handleTrendRoutes(
    postContext,
    createJsonReq("/api/brands/30/analyses", payload, "redbase_session=trend-route-token"),
    replayRes,
    "/api/brands/30/analyses",
  );
  assert.equal(replayRes.statusCode, 200);
  assert.equal(replayRes.body.replayed, true);
  assert.equal(replayRes.body.user.credits, 4);
  assert.equal(modelCalls, 1);
});
