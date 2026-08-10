const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, insertSession, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertBrand, findBrandByOwner } = require("../src/server/db/repositories/brand-repository");
const { handleTrendRoutes } = require("../src/server/api/trend-routes");
const { generateAiTrendSet } = require("../src/server/ai/trend-service");
const { clearAnySearchCache } = require("../src/server/integrations/anysearch");
const {
  findTrendAnalysisRequest,
  reserveTrendAnalysisRequest,
  failTrendAnalysisRequest,
} = require("../src/server/db/repositories/trend-analysis-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Delivery Credits Tester",
  phone: "13910000105",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-07-20T00:00:00.000Z",
});
insertSession({ token: "delivery-credit-token", userId: 1, createdAt: "2026-07-20T00:00:00.000Z" });

insertBrand({
  id: 40,
  ownerUserId: 1,
  name: "Delivery Brand",
  industry: "家居照明",
  audience: "租房人群",
  description: "小空间照明",
  product: "折叠桌面灯",
  goal: "内容增长",
  knowledgeBase: "",
  assetTags: [],
});

function completeContentAssets(label) {
  return {
    moments: {
      title: `${label}朋友圈配图`,
      caption: `${label}从小空间桌面的真实使用出发，整理照明、收纳和移动使用时值得关注的细节。`,
      visualDirection: "小空间桌面与折叠灯的真实使用画面",
    },
    xhsCarousel: {
      title: `${label}小红书组图`,
      publishTitle: `${label}桌面照明检查清单`,
      publishCaption: `${label}整理小空间桌面照明的选择思路，从照明区域、折叠收纳和移动场景逐项判断。`,
      caption: `${label}四页组图说明桌面照明选择逻辑。`,
      slides: [1, 2, 3, 4].map((index) => ({
        pageLabel: `第 ${index} 张`,
        title: `${label}检查项 ${index}`,
        copy: `${label}第 ${index} 个检查项说明实际使用条件。`,
        visualDirection: `${label}小桌面使用场景 ${index}`,
      })),
    },
    wechatLongImage: {
      title: `${label}公众号长图`,
      publishTitle: `${label}小空间桌面照明怎么选`,
      intro: `${label}围绕有限桌面空间，建立照明区域、收纳方式和移动使用的判断框架。`,
      outline: [`${label}判断照明区域`, `${label}比较收纳方式`, `${label}核对移动场景`],
      positioning: `${label}帮助小空间用户建立桌面照明选择框架。`,
      cta: `${label}保存清单，布置桌面前逐项核对。`,
      visualDirection: `${label}桌面照明选择框架长图。`,
    },
  };
}

function makeIdea(label) {
  return {
    title: `${label}选题`,
    summary: `${label}摘要`,
    angle: `${label}角度`,
    brandFit: `${label}结合`,
    audience: "目标人群",
    hook: `${label}钩子`,
    tags: ["#选题"],
    contentAssets: completeContentAssets(label),
  };
}

function makeGeneratedBuckets({ degradedCount = 0 } = {}) {
  const buckets = [{
    key: "traffic",
    title: "流量热点趋势",
    description: "流量内容形式",
    items: Array.from({ length: 10 }, (_, index) => ({
      id: 8000 + index,
      stableKey: `delivery-${index + 1}`,
      bucketKey: "traffic",
      rank: index + 1,
      title: `交付趋势${index + 1}`,
      category: "流量趋势",
      summary: "趋势摘要",
      score: 90 - index,
      tags: ["#热点"],
      reason: "适合品牌内容化",
      evidenceIds: ["S1"],
      degraded: index < degradedCount,
      ideas: [makeIdea(`A${index}`), makeIdea(`B${index}`)],
    })),
  }];
  const warnings = Array.from({ length: degradedCount }, (_, index) => ({
    code: "TREND_ITEM_DEGRADED",
    bucketKey: "traffic",
    trendIndex: index,
    reasons: ["missing-idea-tags"],
    message: `第 ${index + 1} 条为待验证/降级内容。`,
  }));
  Object.defineProperty(buckets, "analysisWarnings", { value: warnings, enumerable: false });
  return buckets;
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

test("a degraded-but-delivered analysis charges exactly one credit and surfaces warnings", async () => {
  let modelCalls = 0;
  const context = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    async generateAiTrendSet() {
      modelCalls += 1;
      return makeGeneratedBuckets({ degradedCount: 3 });
    },
  };
  const payload = { requestId: "delivery-degraded-1", bucketKey: "traffic" };

  const res = createRes();
  await handleTrendRoutes(
    context,
    createJsonReq("/api/brands/40/analyses", payload, "redbase_session=delivery-credit-token"),
    res,
    "/api/brands/40/analyses",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.credits, 4);
  assert.equal(res.body.warnings.length, 3);
  assert.ok(res.body.warnings.every((warning) => warning.code === "TREND_ITEM_DEGRADED"));
  assert.equal(res.body.brand.trends.find((bucket) => bucket.key === "traffic").items.length, 10);
  assert.equal(modelCalls, 1);

  // Same requestId replays without a second charge or a second generation.
  const replayRes = createRes();
  await handleTrendRoutes(
    context,
    createJsonReq("/api/brands/40/analyses", payload, "redbase_session=delivery-credit-token"),
    replayRes,
    "/api/brands/40/analyses",
  );
  assert.equal(replayRes.statusCode, 200);
  assert.equal(replayRes.body.replayed, true);
  assert.equal(replayRes.body.user.credits, 4);
  assert.ok(Array.isArray(replayRes.body.warnings));
  assert.equal(modelCalls, 1);
  assert.equal(findUserById(1).credits, 4);
});

test("a real no-source failure charges nothing and leaves the brand unchanged", async () => {
  const before = findUserById(1).credits;
  const context = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    async generateAiTrendSet() {
      const error = new Error("AnySearch 返回的可验证营销/社交来源不足：0/1。");
      error.code = "ANYSEARCH_INSUFFICIENT_EVIDENCE";
      throw error;
    },
  };

  const res = createRes();
  await handleTrendRoutes(
    context,
    createJsonReq("/api/brands/40/analyses", { requestId: "delivery-failed-1", bucketKey: "news" }, "redbase_session=delivery-credit-token"),
    res,
    "/api/brands/40/analyses",
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /不会扣积分/);
  assert.equal(findUserById(1).credits, before);
  const brand = findBrandByOwner(40, 1);
  assert.ok(!(brand.trends || []).some((bucket) => bucket.key === "news"));
});

test("an eight-item model batch is rejected before persistence or charging", async () => {
  const beforeCredits = findUserById(1).credits;
  const beforeBrand = findBrandByOwner(40, 1);
  const beforeAnalysisCount = beforeBrand.analyses.length;
  const beforeTrafficTitles = (beforeBrand.trends || [])
    .find((bucket) => bucket.key === "traffic")
    ?.items.map((item) => item.title) || [];
  const shortBatch = makeGeneratedBuckets();
  shortBatch[0].items = shortBatch[0].items.slice(0, 8);
  const res = createRes();

  await handleTrendRoutes(
    {
      appConfig: { security: { assetSigningSecret: "test-secret" } },
      async generateAiTrendSet() {
        return shortBatch;
      },
    },
    createJsonReq(
      "/api/brands/40/analyses",
      { requestId: "delivery-short-batch-1", bucketKey: "traffic" },
      "redbase_session=delivery-credit-token",
    ),
    res,
    "/api/brands/40/analyses",
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /实际 8 条/);
  assert.match(res.body.error, /未保存也未扣积分/);
  assert.equal(findUserById(1).credits, beforeCredits);
  assert.equal(findTrendAnalysisRequest({
    requestId: "delivery-short-batch-1",
    userId: 1,
    brandId: 40,
    bucketKey: "traffic",
  })?.status, "failed");
  const afterBrand = findBrandByOwner(40, 1);
  assert.equal(afterBrand.analyses.length, beforeAnalysisCount);
  assert.deepEqual(
    (afterBrand.trends || []).find((bucket) => bucket.key === "traffic")?.items.map((item) => item.title) || [],
    beforeTrafficTitles,
  );
});

test("extra, duplicate, and oversized buckets are rejected before persistence or charging", async () => {
  const scenarios = [
    {
      name: "extra-bucket",
      build() {
        const result = makeGeneratedBuckets();
        result.push({ key: "news", title: "额外趋势", description: "不应交付", items: [result[0].items[0]] });
        return result;
      },
    },
    {
      name: "duplicate-bucket",
      build() {
        const result = makeGeneratedBuckets();
        result.push({ ...result[0], items: result[0].items.slice(0, 8) });
        return result;
      },
    },
    {
      name: "oversized-bucket",
      build() {
        const result = makeGeneratedBuckets();
        result[0].items.push({ ...result[0].items[0], id: 8999, title: "第十一条异常趋势" });
        return result;
      },
    },
  ];

  for (const scenario of scenarios) {
    const requestId = `delivery-${scenario.name}-1`;
    const beforeCredits = findUserById(1).credits;
    const beforeBrand = findBrandByOwner(40, 1);
    const beforeAnalysisCount = beforeBrand.analyses.length;
    const res = createRes();
    await handleTrendRoutes(
      {
        appConfig: { security: { assetSigningSecret: "test-secret" } },
        async generateAiTrendSet() {
          return scenario.build();
        },
      },
      createJsonReq(
        "/api/brands/40/analyses",
        { requestId, bucketKey: "traffic" },
        "redbase_session=delivery-credit-token",
      ),
      res,
      "/api/brands/40/analyses",
    );

    assert.equal(res.statusCode, 400, scenario.name);
    assert.match(res.body.error, /未保存也未扣积分/, scenario.name);
    assert.equal(findUserById(1).credits, beforeCredits, scenario.name);
    assert.equal(findBrandByOwner(40, 1).analyses.length, beforeAnalysisCount, scenario.name);
    assert.equal(findTrendAnalysisRequest({ requestId, userId: 1, brandId: 40, bucketKey: "traffic" })?.status, "failed", scenario.name);
  }
});

test("analysis id allocation failure releases the reservation immediately", async () => {
  const beforeCredits = findUserById(1).credits;
  const requestId = "delivery-allocation-failed-1";
  const res = createRes();
  await handleTrendRoutes(
    {
      appConfig: { security: { assetSigningSecret: "test-secret" } },
      allocateAnalysisAndTrendBase() {
        throw new Error("allocator unavailable");
      },
      async generateAiTrendSet() {
        assert.fail("model must not run when id allocation fails");
      },
    },
    createJsonReq(
      "/api/brands/40/analyses",
      { requestId, bucketKey: "crowd" },
      "redbase_session=delivery-credit-token",
    ),
    res,
    "/api/brands/40/analyses",
  );

  assert.equal(res.statusCode, 400);
  assert.equal(findUserById(1).credits, beforeCredits);
  assert.equal(findTrendAnalysisRequest({ requestId, userId: 1, brandId: 40, bucketKey: "crowd" })?.status, "failed");

  const followupRequestId = "delivery-allocation-followup-1";
  const followup = reserveTrendAnalysisRequest({
    requestId: followupRequestId,
    userId: 1,
    brandId: 40,
    bucketKey: "crowd",
    creditCost: 1,
  });
  assert.equal(followup.status, "reserved");
  assert.equal(followup.existing, false);
  failTrendAnalysisRequest({
    requestId: followupRequestId,
    userId: 1,
    brandId: 40,
    bucketKey: "crowd",
    error: "test cleanup",
  });
});

test("the persisted analysis record keeps the delivered snapshot for the degraded batch", async () => {
  const brand = findBrandByOwner(40, 1);
  const analysis = (brand.analyses || []).find((entry) => entry.name.includes("流量热点趋势"));
  assert.ok(analysis, "degraded delivery must still create an analysis record");
  const snapshotBucket = (analysis.trendSnapshot || []).find((bucket) => bucket.key === "traffic");
  assert.equal(snapshotBucket.items.length, 10);
});

test("a first-call transport failure with evidence fails without saving or charging", async () => {
  clearAnySearchCache();
  const before = findUserById(1).credits;
  const evidenceMarkdown = [
    "## Query 1: precise",
    "### 1. 家居照明折叠桌面灯用户讨论",
    "- **URL**: https://www.ce.cn/lighting-a",
    "- Published: 2026-07-16 Source: ce.cn 家居照明与折叠桌面灯的租房使用讨论。",
    "## Query 2: broad",
    "### 1. 家居照明小空间内容趋势",
    "- **URL**: https://www.xinhuanet.com/lighting-b",
    "- Published: 2026-07-15 Source: xinhuanet.com 家居照明小空间场景内容形式。",
  ].join("\n");
  let modelCalls = 0;
  // End-to-end through the real trend service: the main model dies at
  // transport level on its only call. 完整 contentAssets 是硬门槛，证据槽位
  // 兜底卡不能凭空生成真实发布文案，因此整批失败：不保存、不扣费。
  const context = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    async generateAiTrendSet(brand, baseId, options) {
      return generateAiTrendSet({
        searchProvider: { enabled: true, socialEnabled: false, minReliableEvidence: 1, urlCheckEnabled: false, cacheTtlMs: 0 },
        textProvider: { apiStyle: "openai", maxOutputTokens: 32768 },
        security: { assetSigningSecret: "test-secret" },
      }, brand, baseId, {
        ...options,
        anySearchOptions: {
          now: new Date("2026-07-17T04:00:00.000Z"),
          requestImpl: async () => evidenceMarkdown,
        },
        textModelImpl: async () => {
          modelCalls += 1;
          const error = new Error("socket hang up before response");
          error.code = "ECONNRESET";
          throw error;
        },
      });
    },
  };

  const res = createRes();
  await handleTrendRoutes(
    context,
    createJsonReq("/api/brands/40/analyses", { requestId: "delivery-transport-1", bucketKey: "track" }, "redbase_session=delivery-credit-token"),
    res,
    "/api/brands/40/analyses",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(modelCalls, 1);
  assert.match(res.body.error, /未保存也未扣积分/);
  assert.equal(findUserById(1).credits, before);
  const brand = findBrandByOwner(40, 1);
  assert.ok(!(brand.trends || []).some((bucket) => bucket.key === "track"));
});
