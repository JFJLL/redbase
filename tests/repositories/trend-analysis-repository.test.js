const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand } = require("../../src/server/db/repositories/brand-repository");
const { trySpendCreditsWithEvent } = require("../../src/server/db/repositories/admin-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 71,
  name: "Trend Idempotency Tester",
  phone: "13910000071",
  password: "hash",
  accountType: "customer",
  credits: 1,
  createdAt: "2026-07-20T00:00:00.000Z",
});
insertBrand({
  id: 81,
  ownerUserId: 71,
  name: "Stable Ten",
  industry: "内容运营",
  audience: "品牌运营人员",
  description: "趋势分析测试品牌",
  product: "内容运营服务",
  goal: "稳定生成趋势",
  knowledgeBase: "",
  assetTags: [],
});

function makeIdea(label) {
  return {
    title: `${label}选题`,
    summary: `${label}摘要`,
    angle: `${label}角度`,
    brandFit: `${label}品牌结合`,
    audience: `${label}人群`,
    hook: `${label}钩子`,
    tags: ["#测试"],
    contentAssets: {},
  };
}

function makeBucket() {
  return [{
    key: "traffic",
    title: "流量热点趋势",
    description: "流量内容形式",
    items: Array.from({ length: 10 }, (_, index) => ({
      id: 1001 + index,
      stableKey: `traffic-${index + 1}`,
      rank: index + 1,
      title: `趋势${index + 1}`,
      category: "流量趋势",
      summary: "趋势摘要",
      score: 90 - index,
      tags: ["#趋势"],
      reason: "品牌适配原因",
      ideas: [makeIdea(`A${index}`), makeIdea(`B${index}`)],
    })),
  }];
}

test("trend analysis freezes credits, saves and charges atomically, and replays idempotently", () => {
  const identity = { requestId: "trend-request-0001", userId: 71, brandId: 81, bucketKey: "traffic" };
  const reserved = reserveTrendAnalysisRequest({ ...identity, creditCost: 1 });
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.existing, false);
  assert.equal(findUserById(71).credits, 1, "reservation must not deduct credits");

  const duplicateInFlight = reserveTrendAnalysisRequest({ ...identity, creditCost: 1 });
  assert.equal(duplicateInFlight.status, "reserved");
  assert.equal(duplicateInFlight.existing, true);
  const blockedByReservation = reserveTrendAnalysisRequest({
    requestId: "trend-request-0002",
    userId: 71,
    brandId: 81,
    bucketKey: "news",
    creditCost: 1,
  });
  assert.equal(blockedByReservation.status, "insufficient");

  const completed = completeTrendAnalysisRequest({
    ...identity,
    analysisId: 9101,
    event: {
      actionType: "analysis",
      actionLabel: "AI 热点分析",
      brandId: 81,
      brandName: "Stable Ten",
      summary: "Stable Ten 流量热点趋势",
    },
    buildBrand(brand) {
      const buckets = makeBucket();
      brand.trends = buckets;
      brand.analyses.unshift({
        id: 9101,
        name: "Stable Ten - 流量热点趋势",
        timestamp: "2026-07-20 10:00:00",
        trendSnapshot: buckets,
      });
      return brand;
    },
  });
  assert.equal(completed.replayed, false);
  assert.equal(completed.user.credits, 0);
  assert.equal(completed.brand.trends[0].items.length, 10);

  const replayed = completeTrendAnalysisRequest({
    ...identity,
    analysisId: 9101,
    event: {},
    buildBrand() {
      throw new Error("idempotent replay must not save again");
    },
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.user.credits, 0);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = 71 AND credit_delta < 0").get().count, 1);
});

test("failed reserved trend analysis keeps credits unchanged", () => {
  const identity = { requestId: "trend-request-0003", userId: 71, brandId: 81, bucketKey: "social" };
  getDatabase().prepare("UPDATE users SET credits = 1 WHERE id = 71").run();
  assert.equal(reserveTrendAnalysisRequest({ ...identity, creditCost: 1 }).status, "reserved");
  failTrendAnalysisRequest({ ...identity, error: "provider timeout" });
  assert.equal(findUserById(71).credits, 1);
  assert.equal(reserveTrendAnalysisRequest({ ...identity, creditCost: 1 }).status, "failed");
});

test("active bucket reservations block alternate request IDs and protect frozen credits", () => {
  insertUser({
    id: 72,
    name: "Reservation Isolation Tester",
    phone: "13910000072",
    password: "hash",
    accountType: "customer",
    credits: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  insertBrand({
    id: 82,
    ownerUserId: 72,
    name: "Concurrent Stable Ten",
    industry: "内容运营",
    audience: "品牌运营人员",
    description: "并发冻结测试品牌",
    product: "内容运营服务",
    goal: "防止重复生成",
    knowledgeBase: "",
    assetTags: [],
  });
  const firstIdentity = { requestId: "active-bucket-0001", userId: 72, brandId: 82, bucketKey: "traffic" };
  assert.equal(reserveTrendAnalysisRequest({ ...firstIdentity, creditCost: 1 }).status, "reserved");

  const duplicate = reserveTrendAnalysisRequest({
    requestId: "active-bucket-0002",
    userId: 72,
    brandId: 82,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(duplicate.status, "reserved");
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.request.request_id, firstIdentity.requestId);

  const blockedSpend = trySpendCreditsWithEvent({
    userId: 72,
    amount: 1,
    event: { actionType: "styleImage", actionLabel: "风格化图生成", summary: "must respect frozen trend credit" },
  });
  assert.equal(blockedSpend.spent, false);
  assert.equal(findUserById(72).credits, 1);

  failTrendAnalysisRequest({ ...firstIdentity, error: "cancelled fixture" });
  const releasedSpend = trySpendCreditsWithEvent({
    userId: 72,
    amount: 1,
    event: { actionType: "styleImage", actionLabel: "风格化图生成", summary: "reservation released" },
  });
  assert.equal(releasedSpend.spent, true);
  assert.equal(findUserById(72).credits, 0);
});
