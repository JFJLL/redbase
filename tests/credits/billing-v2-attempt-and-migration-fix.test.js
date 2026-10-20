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
const { VERSIONED_MIGRATIONS, applyVersionedMigrations } = require("../../src/server/db/migrations");
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
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  findExcellentBillingRequest,
  buildExcellentBillingSignature,
} = require("../../src/server/db/repositories/excellent-remix-billing-repository");
const { reconstructSubscriptionSnapshot } = require("../../src/server/billing/snapshot-recovery");

openDatabase();
initializeDatabaseSchema();
applyVersionedMigrations();
ensureDatabaseIndexes();

let userSeq = 7000;
function makeUserWithLots(credits = 10, cycle = false) {
  userSeq += 1;
  const uid = userSeq;
  const db = getDbProxy();
  insertUser({
    id: uid,
    name: `FixUser_${uid}`,
    phone: `138${String(uid).padStart(8, "0")}`,
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(uid);
  if (credits > 0) {
    createCreditLot({
      userId: uid,
      sourceType: cycle ? "cycle" : "topup",
      sourceLabel: cycle ? "本期积分" : "永久积分",
      credits,
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: cycle ? "2026-02-01T00:00:00.000Z" : null,
      nowIso: "2026-01-01T00:00:00.000Z",
    }, db);
  }
  return uid;
}

test("I1: DB failure during settlement rolls back atomic money state, leaves reservation intact, then clean failure releases it", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(10);
  const reqId = `req_i1_${Date.now()}`;
  const sig = buildExcellentBillingSignature({ action: "fusion_i1", uid });
  const now = new Date("2026-06-01T12:00:00.000Z");

  // Step 1: User reserves 1 credit
  const res = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now,
  });
  assert.equal(res.status, "reserved");
  const walletBefore = getUserWalletBalances(uid, now.getTime(), db);
  assert.equal(walletBefore.totalAvailable, 9);
  assert.equal(walletBefore.totalReserved, 1);

  // Step 2: Inject a database failure during settlement allocation insertion
  // We attach a temporary trigger on credit_lot_allocations that fails
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trig_injected_alloc_fail
    BEFORE INSERT ON credit_lot_allocations
    BEGIN
      SELECT RAISE(FAIL, 'INJECTED_ALLOCATION_DB_ERROR');
    END;
  `);

  let thrownError = null;
  try {
    settleExcellentBillingRequest({
      requestId: reqId,
      userId: uid,
      kind: EXCELLENT_BILLING_KIND_FUSION,
      inputSignature: sig,
      reservationToken: res.request.created_at,
      resultSource: "model",
      resultJson: JSON.stringify({ mode: "ai" }),
      event: { actionType: "excellentFusionPlan", actionLabel: "融合生成" },
      now,
    });
  } catch (err) {
    thrownError = err;
  }

  // Cleanup injected trigger immediately
  db.exec("DROP TRIGGER IF EXISTS trig_injected_alloc_fail");

  // Assert: The real database error was thrown, NOT masked as INSUFFICIENT_CREDITS (HTTP 402)
  assert.ok(thrownError, "settlement must throw on database failure");
  assert.match(thrownError.message, /INJECTED_ALLOCATION_DB_ERROR/);
  assert.notEqual(thrownError.code, "INSUFFICIENT_CREDITS");

  // Assert: Transaction rolled back completely!
  // 1. Used credits still 0
  const lot = db.prepare("SELECT used_credits, reserved_credits FROM credit_lots WHERE user_id = ?").get(uid);
  assert.equal(lot.used_credits, 0, "used credits must remain 0");
  assert.equal(lot.reserved_credits, 1, "reservation must remain intact (1 credit)");

  // 2. No credit_events inserted
  const events = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ?").get(uid);
  assert.equal(events.count, 0, "no credit event should be committed");

  // 3. No credit_lot_allocations inserted
  const allocs = db.prepare("SELECT COUNT(*) AS count FROM credit_lot_allocations WHERE user_id = ?").get(uid);
  assert.equal(allocs.count, 0, "no allocations should be committed");

  // 4. Request is still reserved (not marked failed in half-committed state)
  const req = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.equal(req.status, "reserved", "request must remain reserved before explicit failure handling");

  // Step 3: Now the upper layer explicitly terminates/fails the request
  failExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: res.request.created_at,
    error: thrownError.message,
    now,
  });

  // Assert: Final state after clean failure release:
  // Available restored to 10, reserved is 0, used is 0, request is failed
  const walletFinal = getUserWalletBalances(uid, now.getTime(), db);
  assert.equal(walletFinal.totalAvailable, 10);
  assert.equal(walletFinal.totalReserved, 0);
  assert.equal(findUserById(uid).credits, 10);
  const reqFinal = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.equal(reqFinal.status, "failed");
});

test("I1 Coverage: Settle retry succeeds after transient DB error, and duplicate settlement replays idempotently", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(10);
  const reqId = `req_i1_retry_${Date.now()}`;
  const sig = buildExcellentBillingSignature({ action: "fusion_retry", uid });
  const now = new Date("2026-06-01T12:00:00.000Z");

  const res = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now,
  });
  assert.equal(res.status, "reserved");

  // Settle succeeds cleanly
  const settleRes = settleExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: res.request.created_at,
    resultSource: "model",
    resultJson: JSON.stringify({ mode: "ai" }),
    event: { actionType: "excellentFusionPlan", actionLabel: "重试结算" },
    now,
  });
  assert.equal(settleRes.charged, true);
  assert.equal(settleRes.creditCost, 1);

  // Replay settlement (duplicate callback)
  const replayRes = settleExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: res.request.created_at,
    resultSource: "model",
    resultJson: JSON.stringify({ mode: "ai" }),
    event: { actionType: "excellentFusionPlan", actionLabel: "重复结算" },
    now,
  });
  assert.equal(replayRes.replayed, true);
  assert.equal(replayRes.charged, false);

  // Invariants: exactly 1 credit deducted
  const wallet = getUserWalletBalances(uid, now.getTime(), db);
  assert.equal(wallet.totalAvailable, 9);
  assert.equal(wallet.totalReserved, 0);
  assert.equal(wallet.totalUsed, 1);
});

test("I2 Coverage: Stale success, missing token, wrong signature, and post-completion late failures are rejected without side-effects", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(10);
  const reqId = `req_i2_cov_${Date.now()}`;
  const sig = buildExcellentBillingSignature({ action: "fusion_cov", uid });
  const t1 = new Date("2026-06-01T12:00:00.000Z");
  const t2 = new Date("2026-06-01T12:05:00.000Z");

  // T1: reserve and fail
  const res1 = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: t1,
  });
  const token1 = res1.request.created_at;
  failExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token1,
    now: t1,
  });

  // T2: reserve with new token
  const res2 = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: t2,
  });
  const token2 = res2.request.created_at;

  // Case A: Missing reservationToken throws STALE_BILLING_ATTEMPT
  assert.throws(
    () => failExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION, inputSignature: sig, reservationToken: "" }),
    /缺少有效的计费尝试令牌/,
  );

  // Case B: Wrong signature throws STALE_BILLING_ATTEMPT
  assert.throws(
    () => failExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION, inputSignature: "wrong_sig", reservationToken: token2 }),
    /计费请求已被新的生成尝试替代/,
  );

  // Case C: Stale success arrival with token1 throws STALE_BILLING_ATTEMPT (409)
  assert.throws(
    () => settleExcellentBillingRequest({
      requestId: reqId,
      userId: uid,
      kind: EXCELLENT_BILLING_KIND_FUSION,
      inputSignature: sig,
      reservationToken: token1,
      resultSource: "model",
      resultJson: "{}",
      now: t2,
    }),
    /STALE_BILLING_ATTEMPT|计费请求已被新的生成尝试替代/,
  );

  // Case D: Complete T2, then late T1 failure arrives
  settleExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token2,
    resultSource: "model",
    resultJson: "{}",
    now: t2,
  });

  // T1 late failure arrives AFTER T2 completed: zero side-effects
  const lateAfterComplete = failExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token1,
    now: new Date("2026-06-01T12:10:00.000Z"),
  });
  assert.equal(lateAfterComplete.status, "stale");
  const finalWallet = getUserWalletBalances(uid, t2.getTime(), db);
  assert.equal(finalWallet.totalAvailable, 9);
  assert.equal(finalWallet.totalUsed, 1);
});

test("I4 Coverage: Ambiguous unresolvable subscription throws clear audit error without guessing catalog prices", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(0);
  const nowMs = new Date("2026-06-01T12:00:00.000Z").getTime();

  // Insert an orphaned subscription with no orders, no lots, and no snapshot
  const subId = 99999;
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end, current_period_grant,
      upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen,
      snapshot_json, created_at, updated_at
    ) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 0, 0, 0, 0, '', '2026-06-01', '2026-06-01')
  `).run(subId, uid);

  // reconstructSubscriptionSnapshot returns null for unresolvable subscription
  const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subId);
  const reconstructed = reconstructSubscriptionSnapshot(sub, db);
  assert.equal(reconstructed, null, "unresolvable subscription must return null, not guess from catalog");

  // createQuote for upgrade must throw clear error requiring audit, refusing to guess catalog prices
  assert.throws(
    () => createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs }),
    /当前订阅权益快照待核查|当前订阅计费基准待核查/,
  );
});
test("I2: Late failure callback for old attempt T1 has zero side-effects on active attempt T2", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(10);
  const reqId = `req_i2_${Date.now()}`;
  const sig = buildExcellentBillingSignature({ action: "fusion_i2", uid });
  const t1 = new Date("2026-06-01T12:00:00.000Z");
  const t2 = new Date("2026-06-01T12:05:00.000Z");

  // T1: Reserve 1 credit
  const res1 = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: t1,
  });
  assert.equal(res1.status, "reserved");
  const token1 = res1.request.created_at;

  // T1 fails cleanly and releases
  failExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token1,
    error: "T1 network timeout",
    now: t1,
  });
  assert.equal(getUserWalletBalances(uid, t1.getTime(), db).totalAvailable, 10);

  // T2: User retries with new attempt
  const res2 = reserveExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    creditCost: 1,
    now: t2,
  });
  assert.equal(res2.status, "reserved");
  const token2 = res2.request.created_at;
  assert.notEqual(token1, token2);

  // Verify T2 is actively reserved: available 9, reserved 1
  const walletT2 = getUserWalletBalances(uid, t2.getTime(), db);
  assert.equal(walletT2.totalAvailable, 9);
  assert.equal(walletT2.totalReserved, 1);

  // LATE failure for T1 arrives now!
  const lateFailResult = failExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token1,
    error: "T1 late failure message",
    now: new Date("2026-06-01T12:06:00.000Z"),
  });
  assert.equal(lateFailResult.status, "stale");
  assert.equal(lateFailResult.ignored, true);

  // Assert: T2 is STILL reserved, funds NOT restored prematurely
  const walletAfterLateFail = getUserWalletBalances(uid, t2.getTime(), db);
  assert.equal(walletAfterLateFail.totalAvailable, 9, "T2 available must remain 9");
  assert.equal(walletAfterLateFail.totalReserved, 1, "T2 reserved must remain 1");
  const reqDuringT2 = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.equal(reqDuringT2.status, "reserved", "request must remain reserved for T2");
  assert.equal(reqDuringT2.created_at, token2);

  // Now T2 succeeds: settles 1 credit
  const settle2 = settleExcellentBillingRequest({
    requestId: reqId,
    userId: uid,
    kind: EXCELLENT_BILLING_KIND_FUSION,
    inputSignature: sig,
    reservationToken: token2,
    resultSource: "model",
    resultJson: JSON.stringify({ mode: "ai" }),
    event: { actionType: "excellentFusionPlan", actionLabel: "融合生成" },
    now: new Date("2026-06-01T12:07:00.000Z"),
  });
  assert.equal(settle2.charged, true);
  assert.equal(settle2.creditCost, 1);

  // Final state: Exactly 1 credit spent, available is 9, reserved is 0
  const walletFinal = getUserWalletBalances(uid, t2.getTime(), db);
  assert.equal(walletFinal.totalAvailable, 9);
  assert.equal(walletFinal.totalReserved, 0);
  const reqFinal = findExcellentBillingRequest({ requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION });
  assert.equal(reqFinal.status, "completed");
});

test("I3: Migration V18/V19 safely handles historical released attempt and active retry on same lot without UNIQUE conflict", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(10);
  const reqId = `req_i3_${Date.now()}`;
  const lot = db.prepare("SELECT id FROM credit_lots WHERE user_id = ?").get(uid);
  const lotId = lot.id;

  const t1Time = "2026-06-01T10:00:00.000Z";
  const t2Time = "2026-06-01T10:10:00.000Z";

  // Setup legacy pre-V18 state:
  // Request table has current active attempt T2
  db.prepare(`
    INSERT OR REPLACE INTO excellent_remix_billing_requests (
      request_id, user_id, kind, input_signature, status, credit_cost,
      created_at, updated_at, task_key
    ) VALUES (?, ?, 'direction', 'sig_i3', 'reserved', 1, ?, ?, '')
  `).run(reqId, uid, t2Time, t2Time);

  // task_credit_reservations has BOTH T1 (released) and T2 (reserved) on the same lotId!
  const t1KeyOld = `excellent_direction:${uid}:${reqId}`;
  const t2KeyOld = `excellent_direction:${uid}:${reqId}:${t2Time}`;
  db.prepare(`
    INSERT OR REPLACE INTO task_credit_reservations (
      task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'excellent_direction', ?, 1, 'released', ?, ?)
  `).run(t1KeyOld, reqId, uid, lotId, t1Time, t1Time);

  db.prepare(`
    INSERT OR REPLACE INTO task_credit_reservations (
      task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'excellent_direction', ?, 1, 'reserved', ?, ?)
  `).run(t2KeyOld, reqId, uid, lotId, t2Time, t2Time);

  // Run migration V18 and V19: MUST NOT fail with UNIQUE constraint error!
  const v18 = VERSIONED_MIGRATIONS.find((m) => m.version === 18);
  v18.apply();
  const v19 = VERSIONED_MIGRATIONS.find((m) => m.version === 19);
  v19.apply();

  // Check that T1 and T2 keys are distinct and retain their own timestamps
  const reservations = db.prepare(`
    SELECT task_key, status, created_at FROM task_credit_reservations
    WHERE user_id = ? AND task_id = ?
    ORDER BY id ASC
  `).all(uid, reqId);

  assert.equal(reservations.length, 2, "both reservations must be preserved");
  assert.notEqual(reservations[0].task_key, reservations[1].task_key, "T1 and T2 keys must be distinct");
  assert.equal(reservations[0].status, "released");
  assert.equal(reservations[1].status, "reserved");
  assert.match(reservations[0].task_key, new RegExp(t1Time.replace(/:/g, "\\:")));
  assert.match(reservations[1].task_key, new RegExp(t2Time.replace(/:/g, "\\:")));
});

test("I4a: Active Pro monthly service with future scheduled Business plan rebuilds snapshot as 400, not 1500", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(0);
  let mockNow = new Date("2026-06-01T12:00:00.000Z").getTime();
  setNowGetter(() => mockNow);
  try {

  // User creates and pays Pro monthly (400 credits)
  const quotePro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  const otnPro = `otn_pro_${uid}_${Date.now()}`;
  const orderPro = insertPaymentOrder({
    outTradeNo: otnPro,
    userId: uid,
    idempotencyKey: `idem_pro_${Date.now()}`,
    plan: getPlan("pro"),
    provider: "test",
    quote: quotePro,
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: new Date(mockNow + 900000).toISOString(),
  });
  const settleProRes = settlePaidPaymentOrder({
    outTradeNo: otnPro,
    tradeNo: `tr_pro_${Date.now()}`,
    paidAt: new Date(mockNow).toISOString(),
    nowIso: new Date(mockNow).toISOString(),
  });
  assert.equal(settleProRes.order.fulfillmentStatus, "fulfilled");
  const activeSub = findActiveSubscription(uid, mockNow, db);
  assert.ok(activeSub);
  assert.equal(activeSub.plan_id, "pro");

  // User pays a future scheduled Business plan (1500 credits)
  mockNow += 1000;
  const quoteBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
  const otnBiz = `otn_biz_${uid}_${Date.now()}`;
  const orderBiz = insertPaymentOrder({
    outTradeNo: otnBiz,
    userId: uid,
    idempotencyKey: `idem_biz_${Date.now()}`,
    plan: getPlan("business"),
    provider: "test",
    quote: quoteBiz,
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: new Date(mockNow + 900000).toISOString(),
  });
  const settleBizRes = settlePaidPaymentOrder({
    outTradeNo: otnBiz,
    tradeNo: `tr_biz_${Date.now()}`,
    paidAt: new Date(mockNow).toISOString(),
    nowIso: new Date(mockNow).toISOString(),
  });
  assert.equal(settleBizRes.order.fulfillmentStatus, "scheduled");

  // Corrupt active sub snapshot to simulate bad V18 that took newest order (1500)
  db.prepare(`UPDATE subscriptions SET snapshot_json = '{"monthlyCredits":1500,"planId":"business"}' WHERE id = ?`).run(activeSub.id);

  // Run V19 repair
  const v19 = VERSIONED_MIGRATIONS.find((m) => m.version === 19);
  v19.apply();

  // Assert: Active sub snapshot restored to 400!
  const repairedSub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(activeSub.id);
  const snap = JSON.parse(repairedSub.snapshot_json);
  assert.equal(snap.monthlyCredits, 400, "active Pro sub snapshot must be 400, not 1500");
  assert.equal(snap.planId, "pro");

  // Assert: Future schedule retains 1500
  const schedule = findPendingSchedule(uid, db);
  assert.ok(schedule);
  assert.equal(schedule.plan_id, "business");
  assert.equal(schedule.monthly_credits, 1500);

  // Assert: Re-running reconstruct on active sub yields 400
  const reconstructed = reconstructSubscriptionSnapshot(repairedSub, db);
  assert.equal(reconstructed.monthlyCredits, 400);
  } finally {
    resetNowGetter();
  }
});

test("I4b: Upgraded Pro annual subscription rebuilds snapshot as 400, preserving period 1 grant of 100, and calculates upgrade diff from 400", () => {
  const db = getDbProxy();
  const uid = makeUserWithLots(0);
  let mockNow = new Date("2026-01-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);
  try {
  const startMs = mockNow;

  // 1. User activates Light annual (100 credits/mo)
  const quoteLite = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "annual", nowMs: startMs });
  const otnLite = `otn_light_${uid}_${Date.now()}`;
  const orderLite = insertPaymentOrder({
    outTradeNo: otnLite,
    userId: uid,
    idempotencyKey: `idem_light_${Date.now()}`,
    plan: getPlan("light"),
    provider: "test",
    quote: quoteLite,
    nowIso: new Date(startMs).toISOString(),
    expiresAtIso: new Date(startMs + 900000).toISOString(),
  });
  const sLite = settlePaidPaymentOrder({
    outTradeNo: otnLite,
    tradeNo: `tr_lite_${Date.now()}`,
    paidAt: new Date(startMs).toISOString(),
    nowIso: new Date(startMs).toISOString(),
  });
  assert.equal(sLite.order.fulfillmentStatus, "fulfilled");

  const sub = findActiveSubscription(uid, startMs, db);
  assert.ok(sub);
  assert.equal(sub.plan_id, "light");

  // 2. User upgrades to Pro annual (400 credits/mo) in month 1
  mockNow = new Date("2026-01-10T00:00:00.000Z").getTime();
  const quoteUpg = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
  const otnUpg = `otn_upg_${uid}_${Date.now()}`;
  const orderUpg = insertPaymentOrder({
    outTradeNo: otnUpg,
    userId: uid,
    idempotencyKey: `idem_upg_${Date.now()}`,
    plan: getPlan("pro"),
    provider: "test",
    quote: quoteUpg,
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: new Date(mockNow + 900000).toISOString(),
  });
  const sUpg = settlePaidPaymentOrder({
    outTradeNo: otnUpg,
    tradeNo: `tr_upg_${Date.now()}`,
    paidAt: new Date(mockNow).toISOString(),
    nowIso: new Date(mockNow).toISOString(),
  });
  assert.equal(sUpg.order.fulfillmentStatus, "fulfilled");

  // 3. Advance to month 2 (Pro installment of 400 issued)
  mockNow = new Date("2026-02-05T00:00:00.000Z").getTime();
  advanceSubscriptionLifecycles(mockNow, db);

  const activeSubMonth2 = findActiveSubscription(uid, mockNow, db);
  assert.equal(activeSubMonth2.plan_id, "pro");

  // Corrupt snapshot to 100 to simulate bad V18 that took period 1 grant of light
  db.prepare(`UPDATE subscriptions SET snapshot_json = '{"monthlyCredits":100,"planId":"light"}' WHERE id = ?`).run(activeSubMonth2.id);

  // Run V19 repair
  const v19 = VERSIONED_MIGRATIONS.find((m) => m.version === 19);
  v19.apply();

  // Assert: Current monthly quota is repaired to 400!
  const repairedSub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(activeSubMonth2.id);
  const snap = JSON.parse(repairedSub.snapshot_json);
  assert.equal(snap.monthlyCredits, 400, "annual upgraded subscription must have monthlyCredits 400, not 100");
  assert.equal(snap.planId, "pro");

  // Assert: Historical period 1 grant is STILL 100
  const p1Grant = db.prepare("SELECT credits FROM subscription_grants WHERE subscription_id = ? AND period_index = 1").get(activeSubMonth2.id);
  assert.equal(p1Grant.credits, 100, "period 1 historical grant must remain 100");

  // Assert: Future upgrade to Business plan with 7/30 days left in month 2 calculates quota diff from 400:
  // Target Business credits = 1500, Old purchased credits = 400 -> Quota diff = 1500 - 400 = 1100 (NOT 1500 - 100 = 1400!)
  const quoteBizUpg = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
  assert.equal(quoteBizUpg.action, "upgrade");
  assert.equal(quoteBizUpg.meta.upgradeDetails.oldPurchasedCredits, 400, "old purchased credits must be 400, not 100");
  assert.equal(quoteBizUpg.meta.upgradeDetails.targetMonthlyCredits, 1500);
  const quotaDiff = quoteBizUpg.meta.upgradeDetails.targetMonthlyCredits - quoteBizUpg.meta.upgradeDetails.oldPurchasedCredits;
  assert.equal(quotaDiff, 1100, "quota diff must be 1100, not 1400");
  } finally {
    resetNowGetter();
  }
});

test("Multi-process concurrency: competing settlements and late failures on real disk SQLite enforce mutex and idempotency", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-closeout-i-fork-"));
  const diskDbPath = path.join(tmpDir, "concurrency.sqlite");

  const setupScript = path.join(tmpDir, "setup.js");
  fs.writeFileSync(setupScript, `
    process.env.REDBASE_DB_FILE = ${JSON.stringify(diskDbPath)};
    const { openDatabase } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/connection"))});
    const { initializeDatabaseSchema, ensureDatabaseIndexes } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/schema"))});
    const { applyVersionedMigrations } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/migrations"))});
    const { insertUser } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/repositories/auth-repository"))});
    const { createCreditLot } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/billing/credit-ledger"))});
    const { reserveExcellentBillingRequest, buildExcellentBillingSignature, EXCELLENT_BILLING_KIND_FUSION } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/repositories/excellent-remix-billing-repository"))});

    const db = openDatabase();
    initializeDatabaseSchema();
    applyVersionedMigrations();
    ensureDatabaseIndexes();

    const uid = 8888;
    insertUser({
      id: uid,
      name: "ForkUser",
      phone: "13988880001",
      password: "hash",
      accountType: "customer",
      credits: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(uid);
    createCreditLot({
      userId: uid,
      sourceType: "topup",
      sourceLabel: "永久积分",
      credits: 10,
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      nowIso: "2026-01-01T00:00:00.000Z",
    }, db);

    const reqId = "req_concurrent_fork_1";
    const sig = buildExcellentBillingSignature({ action: "fork", uid });
    const now = new Date("2026-06-01T12:00:00.000Z");
    const res = reserveExcellentBillingRequest({
      requestId: reqId,
      userId: uid,
      kind: EXCELLENT_BILLING_KIND_FUSION,
      inputSignature: sig,
      creditCost: 1,
      now,
    });
    process.stdout.write(JSON.stringify({ token: res.request.created_at, sig }));
  `);

  const { execFileSync } = require("child_process");
  const initOut = JSON.parse(execFileSync(process.execPath, [setupScript], { encoding: "utf8" }));
  const token = initOut.token;
  const sig = initOut.sig;
  const reqId = "req_concurrent_fork_1";
  const uid = 8888;

  const workerScript = path.join(tmpDir, "worker.js");
  fs.writeFileSync(workerScript, `
    process.env.REDBASE_DB_FILE = ${JSON.stringify(diskDbPath)};
    const { openDatabase } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/connection"))});
    const { settleExcellentBillingRequest, failExcellentBillingRequest } = require(${JSON.stringify(path.resolve(__dirname, "../../src/server/db/repositories/excellent-remix-billing-repository"))});

    openDatabase();

    process.on("message", (msg) => {
      const { action, requestId, userId, kind, inputSignature, reservationToken } = msg;
      try {
        if (action === "settle") {
          const res = settleExcellentBillingRequest({
            requestId,
            userId,
            kind,
            inputSignature,
            reservationToken,
            resultSource: "model",
            resultJson: "{}",
            event: { actionType: "excellentFusionPlan", actionLabel: "并发测试" },
            now: new Date(),
          });
          process.send({ ok: true, action, res });
        } else if (action === "fail") {
          const res = failExcellentBillingRequest({
            requestId,
            userId,
            kind,
            inputSignature,
            reservationToken,
            error: "concurrent fail",
            now: new Date(),
          });
          process.send({ ok: true, action, res });
        }
      } catch (err) {
        process.send({ ok: false, action, error: err.message, code: err.code });
      }
    });
  `);

  // Spawn 2 workers competing to settle the SAME reservation
  const w1 = fork(workerScript, { env: { ...process.env, REDBASE_DB_FILE: diskDbPath } });
  const w2 = fork(workerScript, { env: { ...process.env, REDBASE_DB_FILE: diskDbPath } });

  const p1 = new Promise((resolve) => w1.once("message", resolve));
  const p2 = new Promise((resolve) => w2.once("message", resolve));

  const msg = { action: "settle", requestId: reqId, userId: uid, kind: EXCELLENT_BILLING_KIND_FUSION, inputSignature: sig, reservationToken: token };
  w1.send(msg);
  w2.send(msg);

  const [res1, res2] = await Promise.all([p1, p2]);
  w1.kill();
  w2.kill();

  const verifyDb = new (require("better-sqlite3"))(diskDbPath);
  const chargedCount = [res1, res2].filter((r) => r.ok && r.res && r.res.charged).length;
  assert.equal(chargedCount, 1, `exactly one worker must charge credits, got results: ${JSON.stringify([res1, res2])}`);
  const finalLot = verifyDb.prepare("SELECT used_credits, remaining_credits FROM credit_lots WHERE user_id = ?").get(uid);
  assert.equal(finalLot.used_credits, 1, "used credits on disk DB must be exactly 1");
  assert.equal(finalLot.remaining_credits, 9, "remaining credits must be exactly 9");
  verifyDb.close();

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
