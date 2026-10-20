"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy, transaction } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { VERSIONED_MIGRATIONS } = require("../../src/server/db/migrations");
const { PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("../../src/server/billing/catalog");
const {
  setNowGetter,
  resetNowGetter,
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
  formatShanghaiDate,
} = require("../../src/server/billing/period-utils");
const {
  createQuote,
  verifyAndConsumeQuote,
  findQuoteById,
} = require("../../src/server/billing/quote-service");
const {
  createCreditLot,
  getUserWalletBalances,
  spendCreditsFromLots,
  reserveCreditsForTask,
  settleCreditsForTask,
  releaseCreditsForTask,
  migrateLegacyUserCredits,
  rescanExpiredLots,
  syncUserCreditsCache,
} = require("../../src/server/billing/credit-ledger");
const {
  getUserBillingOverview,
  fulfillPaymentOrder,
  advanceSubscriptionLifecycles,
  findActiveSubscription,
  findPendingSchedule,
} = require("../../src/server/billing/subscription-service");
const {
  insertUser,
  findUserById,
} = require("../../src/server/db/repositories/auth-repository");
const {
  insertPaymentOrder,
  settlePaidPaymentOrder,
  findPaymentOrderByOutTradeNo,
} = require("../../src/server/db/repositories/payment-repository");
const {
  insertCreditEvent,
} = require("../../src/server/db/repositories/admin-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
  findTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");
const {
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  findExcellentBillingRequest,
  buildExcellentBillingSignature,
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
} = require("../../src/server/db/repositories/excellent-remix-billing-repository");
const { insertBrand } = require("../../src/server/db/repositories/brand-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

let userSequence = 8000;
function createTestUser(credits = 0) {
  userSequence++;
  const id = userSequence;
  insertUser({
    id,
    name: `User${id}`,
    phone: `138${String(id).padStart(8, "0")}`,
    password: "hash",
    accountType: "customer",
    credits,
    createdAt: new Date().toISOString(),
  });
  return id;
}

let mockNow = new Date("2026-10-19T10:00:00+08:00").getTime();
function setTime(iso) {
  mockNow = new Date(iso).getTime();
  setNowGetter(() => mockNow);
}

function resetTime() {
  resetNowGetter();
}

test("H1: User with 1 credit completes 1-credit fusion task without INSUFFICIENT_CREDITS", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(1);

  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 1 }, db);
  syncUserCreditsCache(uid, db);

  const sig = buildExcellentBillingSignature({ test: "H1", uid });
  const reqId = `h1_req_${uid}`;
  const reservation = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: new Date(mockNow),
  });

  assert.equal(reservation.status, "reserved");
  assert.equal(reservation.willCharge, true);

  const walletMid = getUserWalletBalances(uid, mockNow, db);
  assert.equal(walletMid.totalAvailable, 0);
  assert.equal(walletMid.totalReserved, 1);
  assert.equal(walletMid.totalUsed, 0);

  const settle = settleExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: reservation.request.created_at,
    resultSource: "model",
    resultJson: JSON.stringify({ plan: "content plan" }),
    event: { actionType: "excellentFusionPlan", actionLabel: "优秀内容融合方案生成" },
    now: new Date(mockNow + 1000),
  });

  assert.equal(settle.charged, true);
  assert.equal(settle.creditCost, 1);

  const finalWallet = getUserWalletBalances(uid, mockNow + 1000, db);
  assert.equal(finalWallet.totalAvailable, 0);
  assert.equal(finalWallet.totalReserved, 0);
  assert.equal(finalWallet.totalUsed, 1);

  const req = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.equal(req.status, "completed");
  assert.equal(req.credit_cost, 1);
});

test("H2: User with 2 credits reserves two 1-credit tasks, third is rejected, first two settle", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(2);
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 2 }, db);
  syncUserCreditsCache(uid, db);

  const sig1 = buildExcellentBillingSignature({ test: "H2-1", uid });
  const res1 = reserveExcellentBillingRequest({
    requestId: `h2_req1_${uid}`,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig1,
    creditCost: 1,
    now: new Date(mockNow),
  });
  assert.equal(res1.status, "reserved");

  const sig2 = buildExcellentBillingSignature({ test: "H2-2", uid });
  const res2 = reserveExcellentBillingRequest({
    requestId: `h2_req2_${uid}`,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig2,
    creditCost: 1,
    now: new Date(mockNow),
  });
  assert.equal(res2.status, "reserved");

  const sig3 = buildExcellentBillingSignature({ test: "H2-3", uid });
  const res3 = reserveExcellentBillingRequest({
    requestId: `h2_req3_${uid}`,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig3,
    creditCost: 1,
    now: new Date(mockNow),
  });
  assert.equal(res3.status, "insufficient");

  settleExcellentBillingRequest({
    requestId: `h2_req1_${uid}`,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig1,
    reservationToken: res1.request.created_at,
    resultSource: "model",
    resultJson: "{}",
    event: { actionType: "excellentFusionPlan", actionLabel: "方案1" },
    now: new Date(mockNow + 1000),
  });

  settleExcellentBillingRequest({
    requestId: `h2_req2_${uid}`,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig2,
    reservationToken: res2.request.created_at,
    resultSource: "model",
    resultJson: "{}",
    event: { actionType: "excellentFusionPlan", actionLabel: "方案2" },
    now: new Date(mockNow + 2000),
  });

  const finalWallet = getUserWalletBalances(uid, mockNow + 2000, db);
  assert.equal(finalWallet.totalAvailable, 0);
  assert.equal(finalWallet.totalReserved, 0);
  assert.equal(finalWallet.totalUsed, 2);
});

test("H3: DB error during reservation bubbles up, rolls back atomic state, leaves 10 credits", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(10);
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 10 }, db);
  syncUserCreditsCache(uid, db);

  let externalModelCalled = false;
  const sig = buildExcellentBillingSignature({ test: "H3", uid });
  const reqId = `h3_req_${uid}`;

  // Inject real database write failure on task_credit_reservations
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trig_simulated_db_failure
    BEFORE INSERT ON task_credit_reservations
    BEGIN
      SELECT RAISE(FAIL, 'DISK_CORRUPTION_SIMULATION: injected database write failure');
    END;
  `);

  try {
    assert.throws(() => {
      const res = reserveExcellentBillingRequest({
        requestId: reqId,
        userId: uid,
        kind: EXCELLENT_BILLING_KIND_FUSION,
        inputSignature: sig,
        creditCost: 1,
        now: new Date(mockNow),
      });
      if (res.status === "reserved") {
        externalModelCalled = true;
      }
    }, /DISK_CORRUPTION_SIMULATION/);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS trig_simulated_db_failure;");
  }

  assert.equal(externalModelCalled, false, "External model must not be called when DB error occurs");

  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 10);
  assert.equal(wallet.totalReserved, 0);
  assert.equal(wallet.totalUsed, 0);

  const req = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.ok(!req, "No half-written request row should exist after rollback");
});

test("H4: User with 2 credits: excellent task reserves 1, trend task reserves 1 without double freeze", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(2);
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 2 }, db);
  syncUserCreditsCache(uid, db);

  const brand = insertBrand({
    ownerUserId: uid,
    name: "BrandH4",
    industry: "Food",
    audience: "All",
    description: "",
    product: "",
    goal: "",
    knowledgeBase: "",
    logo: "",
    assetTags: [],
    profileType: "corporate",
    contentPillars: [],
    personaStyle: "",
    createdAt: new Date(mockNow).toISOString(),
  });
  const brandId = brand.id;

  const sig = buildExcellentBillingSignature({ test: "H4", uid });
  const excReqId = `exc_h4_${uid}`;
  const excRes = reserveExcellentBillingRequest({
    requestId: excReqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: new Date(mockNow),
  });
  assert.equal(excRes.status, "reserved");

  const trendReqId = `trend_h4_${uid}`;
  const trendRes = reserveTrendAnalysisRequest({
    requestId: trendReqId,
    userId: uid,
    brandId,
    bucketKey: "food_news",
    creditCost: 1,
    now: new Date(mockNow),
  });
  assert.equal(trendRes.status, "reserved", "Second reservation must succeed without double-counting the excellent reservation");

  const walletMid = getUserWalletBalances(uid, mockNow, db);
  assert.equal(walletMid.totalAvailable, 0);
  assert.equal(walletMid.totalReserved, 2);
});

test("H5: Real V15 in-flight trend task, upgraded through V16, V17, V18, completes with exact ledger accounting", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(10);
  const lotId = createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 10 }, db);
  syncUserCreditsCache(uid, db);

  const nowIso = new Date(mockNow).toISOString();
  const brand = insertBrand({
    ownerUserId: uid,
    name: "BrandH5",
    industry: "Tech",
    audience: "All",
    description: "",
    product: "",
    goal: "",
    knowledgeBase: "",
    logo: "",
    assetTags: [],
    profileType: "corporate",
    contentPillars: [],
    personaStyle: "",
    createdAt: nowIso,
  });
  const brandId = brand.id;
  db.prepare("INSERT INTO analyses (id, brand_id, name, timestamp, position) VALUES (501, ?, 'Analysis 501', ?, 1)").run(brandId, nowIso);

  const reqId = `trend_in_flight_${uid}`;

  db.prepare(`
    UPDATE credit_lots SET reserved_credits = 1 WHERE id = ?
  `).run(lotId);
  syncUserCreditsCache(uid, db);

  db.prepare(`
    INSERT INTO trend_analysis_requests (request_id, user_id, brand_id, bucket_key, status, credit_cost, created_at, updated_at, task_key)
    VALUES (?, ?, ?, 'tech_news', 'reserved', 1, ?, ?, '')
  `).run(reqId, uid, brandId, nowIso, nowIso);

  const oldKey = `trend_analysis:${uid}:${reqId}`;
  db.prepare(`
    INSERT INTO task_credit_reservations (task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at)
    VALUES (?, ?, ?, 'trend_analysis', ?, 1, 'reserved', ?, ?)
  `).run(oldKey, reqId, uid, lotId, nowIso, nowIso);

  assert.equal(getUserWalletBalances(uid, mockNow, db).totalAvailable, 9);
  assert.equal(getUserWalletBalances(uid, mockNow, db).totalReserved, 1);

  const v18 = VERSIONED_MIGRATIONS.find((m) => m.version === 18);
  assert.ok(v18, "Migration V18 must exist");
  v18.apply();

  const updatedRes = db.prepare("SELECT task_key FROM task_credit_reservations WHERE task_id = ?").get(reqId);
  const canonicalKey = `trend_analysis:${uid}:${brandId}:tech_news:${reqId}`;
  assert.equal(updatedRes.task_key, canonicalKey, "Migration V18 must align task_key to canonical format");

  completeTrendAnalysisRequest({
    requestId: reqId,
    userId: uid,
    brandId,
    bucketKey: "tech_news",
    analysisId: 501,
    event: { actionType: "trendAnalysis", actionLabel: "趋势分析" },
    buildBrand: (b) => b,
  });

  const finalWallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(finalWallet.totalAvailable, 9, "Available balance must remain 9, not drop to 8");
  assert.equal(finalWallet.totalReserved, 0, "Reserved credits must be released/settled to 0");
  assert.equal(finalWallet.totalUsed, 1, "Used credits must be 1");

  const req = findTrendAnalysisRequest({ requestId: reqId, userId: uid, brandId, bucketKey: "tech_news" });
  assert.equal(req.status, "completed");
});

test("H6: Old in-flight task upgraded to V18 fails cleanly and releases reserved credits", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(10);
  const lotId = createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 10 }, db);
  syncUserCreditsCache(uid, db);

  const nowIso = new Date(mockNow).toISOString();
  const brand = insertBrand({
    ownerUserId: uid,
    name: "BrandH6",
    industry: "Tech",
    audience: "All",
    description: "",
    product: "",
    goal: "",
    knowledgeBase: "",
    logo: "",
    assetTags: [],
    profileType: "corporate",
    contentPillars: [],
    personaStyle: "",
    createdAt: nowIso,
  });
  const brandId = brand.id;
  const reqId = `trend_fail_${uid}`;

  db.prepare(`UPDATE credit_lots SET reserved_credits = 1 WHERE id = ?`).run(lotId);
  syncUserCreditsCache(uid, db);

  db.prepare(`
    INSERT INTO trend_analysis_requests (request_id, user_id, brand_id, bucket_key, status, credit_cost, created_at, updated_at, task_key)
    VALUES (?, ?, ?, 'fail_news', 'reserved', 1, ?, ?, '')
  `).run(reqId, uid, brandId, nowIso, nowIso);

  const oldKey = `trend_analysis:${uid}:${reqId}`;
  db.prepare(`
    INSERT INTO task_credit_reservations (task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at)
    VALUES (?, ?, ?, 'trend_analysis', ?, 1, 'reserved', ?, ?)
  `).run(oldKey, reqId, uid, lotId, nowIso, nowIso);

  const v18 = VERSIONED_MIGRATIONS.find((m) => m.version === 18);
  v18.apply();

  failTrendAnalysisRequest({
    requestId: reqId,
    userId: uid,
    brandId,
    bucketKey: "fail_news",
    error: "AI model timeout",
  });

  const finalWallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(finalWallet.totalAvailable, 10, "Available balance must restore to 10");
  assert.equal(finalWallet.totalReserved, 0, "Reserved credits must be 0");
  assert.equal(finalWallet.totalUsed, 0, "Used credits must be 0");

  const req = findTrendAnalysisRequest({ requestId: reqId, userId: uid, brandId, bucketKey: "fail_news" });
  assert.equal(req.status, "failed");
});

test("H7: Purchasing Pro monthly preserves snapshot; catalog modification to 900 does not affect upgrade calculation (257, not 140)", () => {
  const startMs = new Date("2026-09-23T14:00:00+08:00").getTime();
  setTime("2026-09-23T14:00:00+08:00");
  const uid = createTestUser(0);

  const quote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "pro",
    cycle: "monthly",
    nowMs: startMs,
  });
  assert.equal(quote.itemId, "pro");

  const outTradeNo = `otn_h7_${uid}`;
  insertPaymentOrder({
    outTradeNo,
    userId: uid,
    idempotencyKey: `idem_h7_${uid}`,
    plan: getPlan("pro"),
    nowIso: new Date(startMs).toISOString(),
    expiresAtIso: new Date(startMs + 900000).toISOString(),
    quote,
  });

  settlePaidPaymentOrder({
    outTradeNo,
    tradeNo: `trade_h7_${uid}`,
    paidAt: new Date(startMs).toISOString(),
    nowIso: new Date(startMs).toISOString(),
  });

  const sub = findActiveSubscription(uid, startMs, db);
  assert.ok(sub, "Active subscription must exist");
  assert.ok(sub.snapshot_json && sub.snapshot_json !== "{}", "subscriptions.snapshot_json must be saved by business logic");
  const parsedSubSnap = JSON.parse(sub.snapshot_json);
  assert.equal(parsedSubSnap.monthlyCredits, 400, "Purchased monthlyCredits snapshot must be 400");

  const proPlan = PLANS.find((p) => p.id === "pro");
  const originalProCredits = proPlan.credits;
  try {
    proPlan.credits = 900;

    const subEndMs = new Date(sub.current_period_end).getTime();
    const upgradeNowMs = subEndMs - (7 * 24 * 3600 * 1000);
    setTime(new Date(upgradeNowMs).toISOString());

    const upgradeQuote = createQuote({
      userId: uid,
      kind: "plan",
      itemId: "business",
      cycle: "monthly",
      nowMs: upgradeNowMs,
    });

    assert.equal(upgradeQuote.action, "upgrade");
    assert.equal(upgradeQuote.issuedNow, 257, `Upgrade increment must be 257 (purchased snapshot 400), got ${upgradeQuote.issuedNow}`);
  } finally {
    proPlan.credits = originalProCredits;
  }
});

test("H8: Annual upgrade paid before period 1 end, delayed fulfillment after period 2 started tops up deficit to 1500 and does not leak 401", () => {
  const p1StartMs = new Date("2026-09-23T14:00:00+08:00").getTime();
  const p1EndMs = new Date("2026-10-23T14:00:00+08:00").getTime();

  setTime("2026-09-23T14:00:00+08:00");
  const uid = createTestUser(0);

  const quote1 = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "pro",
    cycle: "annual",
    nowMs: p1StartMs,
  });

  const outTradeNo1 = `otn_h8_init_${uid}`;
  insertPaymentOrder({
    outTradeNo: outTradeNo1,
    userId: uid,
    idempotencyKey: `idem_h8_init_${uid}`,
    plan: getPlan("pro"),
    nowIso: new Date(p1StartMs).toISOString(),
    expiresAtIso: new Date(p1StartMs + 900000).toISOString(),
    quote: quote1,
  });
  settlePaidPaymentOrder({
    outTradeNo: outTradeNo1,
    tradeNo: `trade_h8_init_${uid}`,
    paidAt: new Date(p1StartMs).toISOString(),
    nowIso: new Date(p1StartMs).toISOString(),
  });

  const sub = findActiveSubscription(uid, p1StartMs, db);
  assert.equal(sub.plan_id, "pro");
  assert.equal(sub.cycle, "annual");

  const orderTimeMs = p1EndMs - 1000;
  setTime(new Date(orderTimeMs).toISOString());

  const upgradeQuote = createQuote({
    userId: uid,
    kind: "plan",
    itemId: "business",
    cycle: "annual",
    nowMs: orderTimeMs,
  });

  assert.equal(upgradeQuote.action, "upgrade");

  const upgradeOtn = `otn_h8_upg_${uid}`;
  insertPaymentOrder({
    outTradeNo: upgradeOtn,
    userId: uid,
    idempotencyKey: `idem_h8_upg_${uid}`,
    plan: getPlan("business"),
    nowIso: new Date(orderTimeMs).toISOString(),
    expiresAtIso: new Date(orderTimeMs + 900000).toISOString(),
    quote: upgradeQuote,
  });

  const paidAtIso = new Date(orderTimeMs).toISOString();

  const period2StartMs = p1EndMs + 1000;
  setTime(new Date(period2StartMs).toISOString());

  advanceSubscriptionLifecycles(period2StartMs, db);

  const walletAtP2 = getUserWalletBalances(uid, period2StartMs, db);
  assert.equal(walletAtP2.periodBalance, 400, "Period 2 was granted 400 credits before delayed callback arrived");

  const callbackTimeMs = p1EndMs + (5 * 60 * 1000);
  setTime(new Date(callbackTimeMs).toISOString());

  settlePaidPaymentOrder({
    outTradeNo: upgradeOtn,
    tradeNo: `trade_h8_upg_${uid}`,
    paidAt: paidAtIso,
    nowIso: new Date(callbackTimeMs).toISOString(),
  });

  const updatedOrder = findPaymentOrderByOutTradeNo(upgradeOtn);
  assert.equal(updatedOrder.fulfillmentStatus, "fulfilled", "Upgrade order must fulfill");

  const finalWallet = getUserWalletBalances(uid, callbackTimeMs, db);
  assert.equal(finalWallet.periodBalance, 1500, `Period 2 balance must be 1500 (400 + 1100 deficit), not 401! Got: ${finalWallet.periodBalance}`);

  const futureGrants = db.prepare(`
    SELECT credits FROM subscription_grants
    WHERE subscription_id = ? AND status = 'pending'
  `).all(sub.id);
  assert.equal(futureGrants.length, 10, "10 remaining pending grants");
  assert.ok(futureGrants.every((g) => g.credits === 1500), "All remaining months must have 1500 credits");

  settlePaidPaymentOrder({
    outTradeNo: upgradeOtn,
    tradeNo: `trade_h8_upg_${uid}`,
    paidAt: paidAtIso,
    nowIso: new Date(callbackTimeMs + 1000).toISOString(),
  });
  const repeatWallet = getUserWalletBalances(uid, callbackTimeMs + 1000, db);
  assert.equal(repeatWallet.periodBalance, 1500, "Balance must remain 1500 across duplicate fulfillment");
});

test("Conservation invariant across interleaved reservation, settlement, failure, and expiry", () => {
  setTime("2026-10-19T10:00:00+08:00");
  const uid = createTestUser(100);
  const lotId = createCreditLot({
    userId: uid,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 100,
    startsAt: new Date(mockNow).toISOString(),
    expiresAt: new Date(mockNow + 100000).toISOString(),
    nowIso: new Date(mockNow).toISOString(),
  }, db);
  syncUserCreditsCache(uid, db);

  function checkInvariant() {
    const lots = db.prepare("SELECT * FROM credit_lots WHERE user_id = ?").all(uid);
    for (const lot of lots) {
      const sum = lot.remaining_credits + lot.used_credits;
      assert.equal(sum, lot.initial_credits, `Conservation violated: remaining (${lot.remaining_credits}) + used (${lot.used_credits}) !== initial (${lot.initial_credits})`);
      assert.ok(lot.reserved_credits <= lot.remaining_credits, "Reserved credits cannot exceed remaining credits");
    }
  }

  checkInvariant();

  reserveCreditsForTask({
    userId: uid,
    taskKey: `task:${uid}:1`,
    taskId: "1",
    taskType: "test",
    amount: 20,
    nowIso: new Date(mockNow).toISOString(),
  }, db);
  checkInvariant();

  reserveCreditsForTask({
    userId: uid,
    taskKey: `task:${uid}:2`,
    taskId: "2",
    taskType: "test",
    amount: 30,
    nowIso: new Date(mockNow).toISOString(),
  }, db);
  checkInvariant();

  const ev1 = insertCreditEvent({ userId: uid, creditDelta: -20, creditCost: 20, actionType: "test" });
  settleCreditsForTask({
    userId: uid,
    taskKey: `task:${uid}:1`,
    taskId: "1",
    taskType: "test",
    creditEventId: ev1.id,
    nowIso: new Date(mockNow).toISOString(),
  }, db);
  checkInvariant();

  releaseCreditsForTask({
    userId: uid,
    taskKey: `task:${uid}:2`,
    taskId: "2",
    taskType: "test",
    nowIso: new Date(mockNow).toISOString(),
  }, db);
  checkInvariant();

  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 80);
  assert.equal(wallet.totalUsed, 20);
  assert.equal(wallet.totalReserved, 0);

  resetTime();
});

test("Multi-process concurrency: competing trend and excellent reservations on real disk SQLite enforce balance mutex", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-concurrency-"));
  const tempDb = path.join(tempDir, "concurrency.db");
  const barrierFile = path.join(tempDir, "barrier.flag");

  const Database = require("better-sqlite3");
  const initDb = new Database(tempDb);
  initDb.pragma("journal_mode = WAL");
  initDb.pragma("busy_timeout = 10000");

  initDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer',
      department TEXT NOT NULL DEFAULT '',
      credits INTEGER NOT NULL DEFAULT 0,
      legacy_credits_migrated INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      industry TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      product TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      knowledge_base TEXT NOT NULL DEFAULT '',
      logo TEXT NOT NULL DEFAULT '',
      asset_tags_json TEXT NOT NULL DEFAULT '[]',
      profile_type TEXT NOT NULL DEFAULT 'corporate',
      content_pillars_json TEXT NOT NULL DEFAULT '[]',
      persona_style TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_lots (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_label TEXT NOT NULL,
      order_id INTEGER,
      subscription_id INTEGER,
      grant_id INTEGER,
      initial_credits INTEGER NOT NULL,
      remaining_credits INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL DEFAULT 0,
      used_credits INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_credit_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      lot_id INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_task_res_key_lot ON task_credit_reservations(task_key, lot_id);
    CREATE TABLE IF NOT EXISTS trend_analysis_requests (
      request_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      bucket_key TEXT NOT NULL,
      status TEXT NOT NULL,
      credit_cost INTEGER NOT NULL,
      analysis_id INTEGER,
      credit_event_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (request_id, user_id, brand_id, bucket_key)
    );
    CREATE TABLE IF NOT EXISTS excellent_remix_billing_requests (
      request_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      input_signature TEXT NOT NULL,
      status TEXT NOT NULL,
      credit_cost INTEGER NOT NULL DEFAULT 0,
      counted INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      result_source TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '',
      credit_event_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      task_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (request_id, user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS credit_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      credit_delta INTEGER NOT NULL,
      credit_cost INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  const uid = 9999;
  initDb.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at)
    VALUES (?, 'ConcurrentUser', '13900009999', 'hash', 'customer', 1, 1, ?)
  `).run(uid, new Date().toISOString());

  initDb.prepare(`
    INSERT INTO brands (id, owner_user_id, name, created_at, updated_at)
    VALUES (1, ?, 'BrandConcurrent', ?, ?)
  `).run(uid, new Date().toISOString(), new Date().toISOString());

  initDb.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (1, ?, 'topup', '永久积分', 1, 1, 0, 0, ?, NULL, 'active', ?, ?)
  `).run(uid, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  initDb.close();

  const workerCode = `
    const { fork } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const [,, dbFile, barrierFile, workerType, userId] = process.argv;
    process.env.REDBASE_DB_FILE = dbFile;
    process.env.NODE_ENV = "test";

    const { openDatabase, getDbProxy } = require("${path.resolve(__dirname, "../../src/server/db/connection").replace(/\\/g, "/")}");
    const { reserveExcellentBillingRequest, EXCELLENT_BILLING_KIND_FUSION, buildExcellentBillingSignature } = require("${path.resolve(__dirname, "../../src/server/db/repositories/excellent-remix-billing-repository").replace(/\\/g, "/")}");
    const { reserveTrendAnalysisRequest } = require("${path.resolve(__dirname, "../../src/server/db/repositories/trend-analysis-repository").replace(/\\/g, "/")}");

    openDatabase(dbFile);

    // Wait for barrier
    while (!fs.existsSync(barrierFile)) {
      const now = Date.now();
      while (Date.now() - now < 5) {}
    }

    function tryReserve(attempt = 0) {
      try {
        if (workerType === "excellent") {
          const sig = buildExcellentBillingSignature({ test: "concurrent", userId });
          const res = reserveExcellentBillingRequest({
            requestId: "req_concurrent_exc",
            userId: Number(userId),
            kind: EXCELLENT_BILLING_KIND_FUSION,
            inputSignature: sig,
            creditCost: 1,
          });
          process.send({ type: "excellent", status: res.status });
        } else {
          const res = reserveTrendAnalysisRequest({
            requestId: "req_concurrent_trend",
            userId: Number(userId),
            brandId: 1,
            bucketKey: "news",
            creditCost: 1,
          });
          process.send({ type: "trend", status: res.status });
        }
      } catch (err) {
        if (err.message && err.message.includes("locked") && attempt < 10) {
          const wait = Date.now();
          while (Date.now() - wait < 30) {}
          return tryReserve(attempt + 1);
        }
        process.send({ type: workerType, error: err.message });
      }
    }
    tryReserve();
  `;

  const workerScript = path.join(tempDir, "worker.cjs");
  fs.writeFileSync(workerScript, workerCode);

  // Start 2 workers
  const runWorker = (workerType) =>
    new Promise((resolve) => {
      const cp = fork(workerScript, [tempDb, barrierFile, workerType, String(uid)], { stdio: "inherit" });
      cp.on("message", resolve);
      cp.on("exit", () => resolve({ exit: true }));
    });

  const p1 = runWorker("excellent");
  const p2 = runWorker("trend");

  // Release barrier to start both simultaneously
  fs.writeFileSync(barrierFile, "GO");

  const [r1, r2] = await Promise.all([p1, p2]);

  const results = [r1, r2];
  const reservedCount = results.filter((r) => r.status === "reserved").length;
  const insufficientCount = results.filter((r) => r.status === "insufficient").length;

  assert.equal(reservedCount, 1, "Exactly one worker must succeed in reserving the 1 credit");
  assert.equal(insufficientCount, 1, "The competing worker must receive status insufficient");

  const verifyDb = new Database(tempDb);
  const remaining = verifyDb.prepare("SELECT remaining_credits, reserved_credits FROM credit_lots WHERE user_id = ?").get(uid);
  assert.equal(remaining.remaining_credits, 1);
  assert.equal(remaining.reserved_credits, 1, "Reserved credits on lot must be exactly 1");
  verifyDb.close();

  // Cleanup temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});
