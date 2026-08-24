const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { insertCreditEvent, trySpendCreditsWithEvent, refundCreditEventIfNeeded } = require("../../src/server/db/repositories/admin-repository");
const {
  CREDIT_COSTS,
  hasEnoughCredits,
  getCreditEventCost,
  getGenerationTokenCost,
} = require("../../src/server/api/helpers");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Credit Tester",
  phone: "13910000001",
  password: "hash",
  accountType: "customer",
  credits: 3,
  createdAt: "2026-05-02T00:00:00.000Z",
});
insertUser({
  id: 2,
  name: "Atomic Credit Tester",
  phone: "13910000002",
  password: "hash",
  accountType: "customer",
  credits: 1,
  createdAt: "2026-05-02T00:00:00.000Z",
});

function createJsonRes() {
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

test("credit costs stay aligned with generation actions", () => {
  assert.equal(CREDIT_COSTS.analysis, 1);
  assert.equal(CREDIT_COSTS.regenerateIdeas, 1);
  assert.equal(CREDIT_COSTS.momentsImage, 1);
  assert.equal(CREDIT_COSTS.wechatImage, 1);
  assert.equal(CREDIT_COSTS.xhsCarousel, 4);
  assert.equal(CREDIT_COSTS.xhsCarouselSlide, 1);
  assert.equal(CREDIT_COSTS.imageEdit, 1);
  assert.equal(CREDIT_COSTS.styleImage, 1);
  assert.equal(CREDIT_COSTS.videoScript, 1);
});

test("hasEnoughCredits allows affordable actions", () => {
  const res = createJsonRes();
  assert.equal(hasEnoughCredits({ credits: 2 }, 1, res), true);
  assert.equal(res.statusCode, 0);
});

test("hasEnoughCredits rejects insufficient balance with 402", () => {
  const res = createJsonRes();
  assert.equal(hasEnoughCredits({ credits: 0 }, 1, res), false);
  assert.equal(res.statusCode, 402);
  assert.match(res.body.error, /积分不足/);
});

test("credit event cost falls back from explicit cost to negative delta", () => {
  assert.equal(getCreditEventCost({ creditCost: 4, creditDelta: -1 }), 4);
  assert.equal(getCreditEventCost({ creditDelta: -3 }), 3);
  assert.equal(getCreditEventCost({ creditDelta: 3 }), 0);
});

test("generation token cost falls back by generation type", () => {
  assert.equal(getGenerationTokenCost({ type: "xhsCarousel" }, null), CREDIT_COSTS.xhsCarousel);
  assert.equal(getGenerationTokenCost({ type: "moments" }, null), CREDIT_COSTS.momentsImage);
  assert.equal(getGenerationTokenCost({ type: "videoScript" }, null), CREDIT_COSTS.videoScript);
  assert.equal(getGenerationTokenCost({ type: "moments" }, { creditCost: 7 }), 7);
});

test("refundCreditEventIfNeeded restores credits once and is idempotent", () => {
  const debit = insertCreditEvent({
    id: 100,
    userId: 1,
    actionType: "momentsImage",
    actionLabel: "朋友圈图",
    creditDelta: -1,
    creditCost: 1,
    createdAt: "2026-05-02T01:00:00.000Z",
  });

  const first = refundCreditEventIfNeeded({ creditEventId: debit.id, userId: 1, reason: "job failed" });
  assert.equal(first.refunded, true);
  assert.equal(first.refundEvent.creditDelta, 1);
  assert.equal(findUserById(1).credits, 4);

  const second = refundCreditEventIfNeeded({ creditEventId: debit.id, userId: 1, reason: "job failed again" });
  assert.equal(second.refunded, false);
  assert.equal(second.refundEvent.id, first.refundEvent.id);
  assert.equal(findUserById(1).credits, 4);

  const refundCount = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE credit_delta > 0").get().count;
  assert.equal(refundCount, 1);
});

test("trySpendCreditsWithEvent atomically spends and records only affordable actions", () => {
  const first = trySpendCreditsWithEvent({
    userId: 2,
    amount: 1,
    event: {
      actionType: "styleImage",
      actionLabel: "风格化图生成",
      summary: "atomic spend",
    },
  });
  assert.equal(first.spent, true);
  assert.equal(first.user.credits, 0);
  assert.equal(first.creditEvent.creditDelta, -1);
  assert.equal(first.creditEvent.creditCost, 1);

  const second = trySpendCreditsWithEvent({
    userId: 2,
    amount: 1,
    event: {
      actionType: "styleImage",
      actionLabel: "风格化图生成",
      summary: "should not spend",
    },
  });
  assert.equal(second.spent, false);
  assert.equal(second.user.credits, 0);

  const spendCount = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = 2 AND credit_delta < 0").get().count;
  assert.equal(spendCount, 1);
});
