const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, insertSession, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertBrand, findBrandByOwner } = require("../src/server/db/repositories/brand-repository");
const { handleTrendRoutes } = require("../src/server/api/trend-routes");

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

function makeIdea(label) {
  return {
    title: `${label}选题`,
    summary: `${label}摘要`,
    angle: `${label}角度`,
    brandFit: `${label}结合`,
    audience: "目标人群",
    hook: `${label}钩子`,
    tags: ["#选题"],
    contentAssets: {},
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

test("the persisted analysis record keeps the delivered snapshot for the degraded batch", async () => {
  const brand = findBrandByOwner(40, 1);
  const analysis = (brand.analyses || []).find((entry) => entry.name.includes("流量热点趋势"));
  assert.ok(analysis, "degraded delivery must still create an analysis record");
  const snapshotBucket = (analysis.trendSnapshot || []).find((bucket) => bucket.key === "traffic");
  assert.equal(snapshotBucket.items.length, 10);
});
