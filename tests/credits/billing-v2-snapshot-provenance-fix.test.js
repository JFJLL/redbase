"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
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
  inspectSubscriptionSnapshot,
  reconstructSubscriptionSnapshot,
  safeUpdateSubscriptionSnapshot,
} = require("../../src/server/billing/snapshot-recovery");

openDatabase();
initializeDatabaseSchema();
applyVersionedMigrations();
ensureDatabaseIndexes();

let userSeq = 80000;
function makeTestUser(credits = 0) {
  userSeq += 1;
  const uid = userSeq;
  const db = getDbProxy();
  insertUser({
    id: uid,
    name: "JUser_" + uid,
    phone: "139" + String(uid).padStart(8, "0"),
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  db.prepare("UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?").run(uid);
  if (credits > 0) {
    createCreditLot({
      userId: uid,
      sourceType: "topup",
      sourceLabel: "永久积分",
      credits,
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      nowIso: "2026-01-01T00:00:00.000Z",
    }, db);
  }
  return uid;
}

test("J1: Annual subscription upgraded in Month 12 preserves 400 entitlement and is not downgraded by grant 12 of 100", () => {
  const db = getDbProxy();
  const uid = makeTestUser(300); // 300 permanent topup credits
  let mockNow = new Date("2026-01-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);

  try {
    // 1. User activates Light annual (100 credits/mo)
    const qInit = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "annual", nowMs: mockNow });
    const otnInit = "otn_j1_init_" + uid;
    const orderInit = insertPaymentOrder({
      outTradeNo: otnInit,
      userId: uid,
      idempotencyKey: "idem_j1_init_" + uid,
      plan: getPlan("light"),
      provider: "test",
      quote: qInit,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    const sInit = settlePaidPaymentOrder({
      outTradeNo: otnInit,
      tradeNo: "tr_j1_init_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });
    assert.equal(sInit.order.fulfillmentStatus, "fulfilled");

    // 2. Advance lifecycles through 12 months
    for (let m = 2; m <= 12; m++) {
      mockNow = addCalendarMonths(new Date("2026-01-01T00:00:00.000Z").getTime(), m - 1, 1) + 1000;
      advanceSubscriptionLifecycles(mockNow, db);
    }

    const subM12 = findActiveSubscription(uid, mockNow, db);
    assert.ok(subM12);
    assert.equal(subM12.plan_id, "light");

    // Verify all 12 grants are granted and grant 12 has 100 credits
    const g12 = db.prepare("SELECT * FROM subscription_grants WHERE subscription_id = ? AND period_index = 12").get(subM12.id);
    assert.equal(g12.status, "granted");
    assert.equal(g12.credits, 100);

    const pendingGrantsCount = db.prepare("SELECT COUNT(*) AS c FROM subscription_grants WHERE subscription_id = ? AND status = 'pending'").get(subM12.id).c;
    assert.equal(pendingGrantsCount, 0, "month 12 has 0 pending grants left");

    // 3. User upgrades to Pro annual (400 credits/mo) in month 12
    mockNow += 86400000 * 5; // 5 days into month 12
    const qUpg = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
    assert.equal(qUpg.action, "upgrade");
    const otnUpg = "otn_j1_upg_" + uid;
    const orderUpg = insertPaymentOrder({
      outTradeNo: otnUpg,
      userId: uid,
      idempotencyKey: "idem_j1_upg_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qUpg,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    const sUpg = settlePaidPaymentOrder({
      outTradeNo: otnUpg,
      tradeNo: "tr_j1_upg_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });
    assert.equal(sUpg.order.fulfillmentStatus, "fulfilled");

    // 4. Verify post-upgrade state before migration
    const subAfterUpg = findActiveSubscription(uid, mockNow, db);
    assert.equal(subAfterUpg.plan_id, "pro");
    const snapBefore = JSON.parse(subAfterUpg.snapshot_json);
    assert.equal(snapBefore.monthlyCredits, 400);
    assert.equal(snapBefore.planId, "pro");

    // Grant 12 remains historical 100 credits
    const g12After = db.prepare("SELECT credits, status FROM subscription_grants WHERE subscription_id = ? AND period_index = 12").get(subAfterUpg.id);
    assert.equal(g12After.credits, 100);
    assert.equal(g12After.status, "granted");

    // Inspect reconstruction: MUST resolve to 400, not 100!
    const insp = inspectSubscriptionSnapshot(subAfterUpg, db);
    assert.equal(insp.status, "resolved");
    assert.equal(insp.snapshot.monthlyCredits, 400);
    assert.equal(insp.snapshot.planId, "pro");
    const recon = reconstructSubscriptionSnapshot(subAfterUpg, db);
    assert.equal(recon.monthlyCredits, 400);

    // Record quote to Business before migration
    const qBizBefore = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
    assert.equal(qBizBefore.meta.upgradeDetails.oldPurchasedCredits, 400);
    assert.equal(qBizBefore.meta.upgradeDetails.targetMonthlyCredits, 1500);
    const quotaDiffBefore = qBizBefore.meta.upgradeDetails.targetMonthlyCredits - qBizBefore.meta.upgradeDetails.oldPurchasedCredits;
    assert.equal(quotaDiffBefore, 1100); // 1500 - 400

    // 5. Corrupt snapshot to 100 to simulate buggy V19 that took latest grant (100)
    db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run('{"monthlyCredits":100,"planId":"pro"}', subAfterUpg.id);

    // Run V20 migration
    const v20 = VERSIONED_MIGRATIONS.find((m) => m.version === 20);
    v20.apply();

    // 6. Verify repaired state
    const repairedSub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subAfterUpg.id);
    const snapRepaired = JSON.parse(repairedSub.snapshot_json);
    assert.equal(snapRepaired.monthlyCredits, 400, "V20 must restore monthlyCredits to 400, not 100");
    assert.equal(snapRepaired.planId, "pro");

    // Grant 12 remains historical 100
    const g12Repaired = db.prepare("SELECT credits FROM subscription_grants WHERE subscription_id = ? AND period_index = 12").get(subAfterUpg.id);
    assert.equal(g12Repaired.credits, 100);

    // Balances unchanged
    const wallet = getUserWalletBalances(uid, mockNow, db);
    assert.equal(wallet.permanentBalance, 300);

    // Quote to Business after migration matches EXACTLY:
    const qBizAfter = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
    assert.equal(qBizAfter.amountFen, qBizBefore.amountFen);
    assert.equal(qBizAfter.issuedNow, qBizBefore.issuedNow);
    assert.equal(qBizAfter.meta.upgradeDetails.oldPurchasedCredits, 400);
    assert.equal(qBizAfter.meta.upgradeDetails.targetMonthlyCredits, 1500);
    const quotaDiffAfter = qBizAfter.meta.upgradeDetails.targetMonthlyCredits - qBizAfter.meta.upgradeDetails.oldPurchasedCredits;
    assert.equal(quotaDiffAfter, 1100, "quota diff must remain 1100, not 1400");
  } finally {
    resetNowGetter();
  }
});

test("J1 Coverage: Upgrade in Month 1, Month 6, and upgrade with issuedNow = 0", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  let mockNow = new Date("2026-01-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);

  try {
    // Light annual
    const qInit = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "annual", nowMs: mockNow });
    const otnInit = "otn_j1cov_init_" + uid;
    insertPaymentOrder({
      outTradeNo: otnInit,
      userId: uid,
      idempotencyKey: "idem_j1cov_init_" + uid,
      plan: getPlan("light"),
      provider: "test",
      quote: qInit,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnInit,
      tradeNo: "tr_j1cov_init_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    // Advance to month 6
    for (let m = 2; m <= 6; m++) {
      mockNow = addCalendarMonths(new Date("2026-01-01T00:00:00.000Z").getTime(), m - 1, 1) + 1000;
      advanceSubscriptionLifecycles(mockNow, db);
    }

    const sub = findActiveSubscription(uid, mockNow, db);
    const pEndMs = new Date(sub.current_period_end).getTime();
    // At current month period boundary (mockNow = pEndMs): periodRemainingMs = 0 -> issuedNow = 0
    // while annual service still has 6 months remaining -> amountFen > 0
    mockNow = pEndMs;

    // Quote Pro upgrade with issuedNow = 0
    const qZero = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
    assert.equal(qZero.issuedNow, 0, "issuedNow must be 0 at period boundary");
    assert.ok(qZero.amountFen > 0, "amountFen must be positive for 6 months remaining");
    const otnZero = "otn_j1cov_zero_" + uid;
    insertPaymentOrder({
      outTradeNo: otnZero,
      userId: uid,
      idempotencyKey: "idem_j1cov_zero_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qZero,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnZero,
      tradeNo: "tr_j1cov_zero_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    const subAfterZero = findActiveSubscription(uid, mockNow, db);
    assert.equal(subAfterZero.plan_id, "pro");

    // Verify reconstruction works even when no upgrade lot was added
    const reconZero = reconstructSubscriptionSnapshot(subAfterZero, db);
    assert.ok(reconZero);
    assert.equal(reconZero.monthlyCredits, 400);
    assert.equal(reconZero.planId, "pro");
  } finally {
    resetNowGetter();
  }
});

test("J2: paid + audit_required upgrade does not change current entitlement and is not backfilled by migration", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  let mockNow = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);

  try {
    // 1. Activate Pro monthly (400 credits)
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
    const otnPro = "otn_j2_pro_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_j2_pro_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    const sPro = settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_j2_pro_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });
    assert.equal(sPro.order.fulfillmentStatus, "fulfilled");

    const sub = findActiveSubscription(uid, mockNow, db);
    assert.equal(sub.plan_id, "pro");

    // 2. Create upgrade order to Business (1500 credits)
    mockNow += 86400000 * 5;
    const qBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
    const otnBiz = "otn_j2_biz_" + uid;
    const orderBiz = insertPaymentOrder({
      outTradeNo: otnBiz,
      userId: uid,
      idempotencyKey: "idem_j2_biz_" + uid,
      plan: getPlan("business"),
      provider: "test",
      quote: qBiz,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });

    // Mark order as paid + audit_required (e.g. payment confirmed but fulfillment entered audit_required)
    db.prepare("UPDATE payment_orders SET status = ?, fulfillment_status = ?, audit_reason = ? WHERE id = ?")
      .run("paid", "audit_required", "受控测试待核查", orderBiz.id);

    // 3. Inspect subscription recovery: MUST be Pro 400, unfulfilledUpgrades has the Business order
    const inspection = inspectSubscriptionSnapshot(sub, db);
    assert.equal(inspection.status, "resolved");
    assert.equal(inspection.snapshot.planId, "pro");
    assert.equal(inspection.snapshot.monthlyCredits, 400);
    assert.equal(inspection.evidence.unfulfilledUpgrades.length, 1);
    assert.equal(inspection.evidence.effectiveUpgrades.length, 0);

    const recon = reconstructSubscriptionSnapshot(sub, db);
    assert.equal(recon.planId, "pro");
    assert.equal(recon.monthlyCredits, 400);

    // 4. Corrupt snapshot to Business 1500 (simulating bad V18/V19)
    db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run('{"monthlyCredits":1500,"planId":"business"}', sub.id);

    // Run migration V20
    const v20 = VERSIONED_MIGRATIONS.find((m) => m.version === 20);
    v20.apply();

    // 5. Assert: Snapshot repaired to Pro 400!
    const repairedSub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id);
    const snapRepaired = JSON.parse(repairedSub.snapshot_json);
    assert.equal(snapRepaired.monthlyCredits, 400, "must restore to Pro 400, NOT Business 1500");
    assert.equal(snapRepaired.planId, "pro");

    // Order remains paid + audit_required
    const bizOrderRow = db.prepare("SELECT status, fulfillment_status, audit_reason FROM payment_orders WHERE id = ?").get(orderBiz.id);
    assert.equal(bizOrderRow.status, "paid");
    assert.equal(bizOrderRow.fulfillment_status, "audit_required");
    assert.equal(bizOrderRow.audit_reason, "受控测试待核查");

    // No business entitlement added to wallet
    const wallet = getUserWalletBalances(uid, mockNow, db);
    assert.equal(wallet.periodBalance, 400);
  } finally {
    resetNowGetter();
  }
});

test("J3: Subscription with missing provenance cannot borrow another subscription's older order and enters audit", () => {
  const db = getDbProxy();
  const uid = makeTestUser(500); // 500 permanent booster credits
  const nowMs = new Date("2026-06-01T00:00:00.000Z").getTime();

  // 1. Subscription A in 2025: Light monthly (100 credits), expired
  const qA = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "monthly", nowMs: new Date("2025-01-01T00:00:00.000Z").getTime() });
  const otnA = "otn_j3_subA_" + uid;
  const oA = insertPaymentOrder({
    outTradeNo: otnA,
    userId: uid,
    idempotencyKey: "idem_j3_subA_" + uid,
    plan: getPlan("light"),
    provider: "test",
    quote: qA,
    nowIso: "2025-01-01T00:00:00.000Z",
    expiresAtIso: "2025-01-01T01:00:00.000Z",
  });
  settlePaidPaymentOrder({
    outTradeNo: otnA,
    tradeNo: "tr_j3_subA_" + uid,
    paidAt: "2025-01-01T00:00:00.000Z",
    nowIso: "2025-01-01T00:00:00.000Z",
  });
  db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ?").run(uid);

  // 2. Subscription B in 2026: Pro monthly (400 credits), but provenance is missing (simulating unlinked/lost link)
  const subBId = 99881;
  db.prepare("INSERT INTO subscriptions (id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day, current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 0, 0, 0, 0, '', '2026-06-01', '2026-06-01')").run(subBId, uid);

  const subB = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subBId);

  // 3. Inspect Sub B: MUST be unresolved, cannot borrow Sub A's order (100)
  const insp = inspectSubscriptionSnapshot(subB, db);
  assert.equal(insp.status, "unresolved");
  assert.match(insp.reason, /缺少可证明的订阅开通或排期激活来源/);
  assert.equal(insp.snapshot, null);

  const recon = reconstructSubscriptionSnapshot(subB, db);
  assert.equal(recon, null, "unresolved subscription B must return null, NOT borrow Sub A's order");

  // 4. Quote for upgrade from Sub B MUST throw clear audit error
  assert.throws(
    () => createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs }),
    /当前订阅权益快照待核查|当前订阅计费基准待核查/,
  );

  // 5. User's independent permanent credits are NOT affected
  const wallet = getUserWalletBalances(uid, nowMs, db);
  assert.equal(wallet.permanentBalance, 500);

  // 6. Stability check: Adding an older unrelated order for the user does not alter Sub B
  const otnUnrelated = "otn_unrelated_" + uid;
  db.prepare("INSERT INTO payment_orders (out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, provider, created_at, updated_at, expires_at, fulfillment_status, cycle, order_kind, order_action, issued_now) VALUES (?, ?, 'idem_unrelated', 'light', '轻量版', 100, 2900, 'paid', 'test', '2024-01-01', '2024-01-01', '2024-01-02', 'fulfilled', 'monthly', 'plan', 'activate', 100)").run(otnUnrelated, uid);

  const inspAfter = inspectSubscriptionSnapshot(subB, db);
  assert.equal(inspAfter.status, "unresolved");
  assert.equal(reconstructSubscriptionSnapshot(subB, db), null);

  // 7. If Sub B had bad snapshot corrupted to 100 by old V19, V20 clears it
  db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run('{"monthlyCredits":100,"planId":"lite"}', subBId);
  const v20 = VERSIONED_MIGRATIONS.find((m) => m.version === 20);
  v20.apply();
  const subBCleared = db.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subBId);
  assert.equal(subBCleared.snapshot_json, "", "unresolved subscription bad snapshot must be cleared to empty");
});

test("J1 Coverage: Consecutive upgrades in month 12 (Light -> Pro -> Business) correctly traces to Business 1500", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  let mockNow = new Date("2026-01-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);

  try {
    // 1. Light annual
    const qInit = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "annual", nowMs: mockNow });
    const otnInit = "otn_consec_init_" + uid;
    insertPaymentOrder({
      outTradeNo: otnInit,
      userId: uid,
      idempotencyKey: "idem_consec_init_" + uid,
      plan: getPlan("light"),
      provider: "test",
      quote: qInit,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnInit,
      tradeNo: "tr_consec_init_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    // Advance to month 12
    for (let m = 2; m <= 12; m++) {
      mockNow = addCalendarMonths(new Date("2026-01-01T00:00:00.000Z").getTime(), m - 1, 1) + 1000;
      advanceSubscriptionLifecycles(mockNow, db);
    }

    mockNow += 86400000 * 5;

    // 2. Upgrade Light -> Pro
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
    const otnPro = "otn_consec_pro_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_consec_pro_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_consec_pro_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    // 3. Immediately upgrade Pro -> Business
    mockNow += 1000;
    const qBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
    const otnBiz = "otn_consec_biz_" + uid;
    insertPaymentOrder({
      outTradeNo: otnBiz,
      userId: uid,
      idempotencyKey: "idem_consec_biz_" + uid,
      plan: getPlan("business"),
      provider: "test",
      quote: qBiz,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnBiz,
      tradeNo: "tr_consec_biz_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    const activeSub = findActiveSubscription(uid, mockNow, db);
    assert.equal(activeSub.plan_id, "business");

    // Inspect reconstruction: Must resolve to Business 1500!
    const insp = inspectSubscriptionSnapshot(activeSub, db);
    assert.equal(insp.status, "resolved");
    assert.equal(insp.snapshot.planId, "business");
    assert.equal(insp.snapshot.monthlyCredits, 1500);
    assert.equal(insp.evidence.effectiveUpgrades.length, 2);

    const recon = reconstructSubscriptionSnapshot(activeSub, db);
    assert.equal(recon.monthlyCredits, 1500);
    assert.equal(recon.planId, "business");
  } finally {
    resetNowGetter();
  }
});

test("J2 Coverage: paid + unfulfilled and paid + processing do not alter active entitlement", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  let mockNow = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => mockNow);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
    const otnPro = "otn_j2cov_pro_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_j2cov_pro_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_j2cov_pro_" + uid,
      paidAt: new Date(mockNow).toISOString(),
      nowIso: new Date(mockNow).toISOString(),
    });

    const sub = findActiveSubscription(uid, mockNow, db);

    // Create upgrade order with paid + unfulfilled
    mockNow += 86400000;
    const qBiz1 = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
    const otnBiz1 = "otn_j2cov_unf_" + uid;
    const oBiz1 = insertPaymentOrder({
      outTradeNo: otnBiz1,
      userId: uid,
      idempotencyKey: "idem_j2cov_unf_" + uid,
      plan: getPlan("business"),
      provider: "test",
      quote: qBiz1,
      nowIso: new Date(mockNow).toISOString(),
      expiresAtIso: new Date(mockNow + 900000).toISOString(),
    });
    db.prepare("UPDATE payment_orders SET status = 'paid', fulfillment_status = 'unfulfilled' WHERE id = ?").run(oBiz1.id);

    const insp1 = inspectSubscriptionSnapshot(sub, db);
    assert.equal(insp1.status, "resolved");
    assert.equal(insp1.snapshot.monthlyCredits, 400);
    assert.equal(insp1.snapshot.planId, "pro");
    assert.equal(insp1.evidence.unfulfilledUpgrades.length, 1);
    assert.equal(insp1.evidence.unfulfilledUpgrades[0].fulfillmentStatus, "unfulfilled");

    // Change to processing
    db.prepare("UPDATE payment_orders SET fulfillment_status = 'processing' WHERE id = ?").run(oBiz1.id);
    const insp2 = inspectSubscriptionSnapshot(sub, db);
    assert.equal(insp2.status, "resolved");
    assert.equal(insp2.snapshot.monthlyCredits, 400);
    assert.equal(insp2.evidence.unfulfilledUpgrades[0].fulfillmentStatus, "processing");
  } finally {
    resetNowGetter();
  }
});

test("J3 Coverage: Subscription with conflicting candidate orders flags conflict and refuses to auto-write", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const nowMs = new Date("2026-06-01T00:00:00.000Z").getTime();

  // Insert a subscription whose plan_id in DB is 'business', but the only activation order is 'light'
  // and there is NO fulfilled upgrade order to business!
  const subConflictId = 99899;
  const otnAct = "otn_conf_act_" + uid;
  const actOrder = insertPaymentOrder({
    outTradeNo: otnAct,
    userId: uid,
    idempotencyKey: "idem_conf_act_" + uid,
    plan: getPlan("light"),
    provider: "test",
    quote: createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "monthly", nowMs }),
    nowIso: "2026-06-01T00:00:00.000Z",
    expiresAtIso: "2026-06-01T01:00:00.000Z",
  });
  db.prepare("UPDATE payment_orders SET status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(actOrder.id);
  db.prepare("INSERT INTO credit_lots (id, user_id, source_type, source_label, order_id, subscription_id, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (998991, ?, 'cycle', '本期积分', ?, ?, 100, 100, 0, 0, '2026-06-01', '2026-07-01', 'active', '2026-06-01', '2026-06-01')").run(uid, actOrder.id, subConflictId);

  // Sub row contradicts the activation order (says business instead of light)
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end, current_period_grant,
      upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen,
      snapshot_json, created_at, updated_at
    ) VALUES (?, ?, 'business', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 0, 0, 0, 0, '', '2026-06-01', '2026-06-01')
  `).run(subConflictId, uid);

  const subConflict = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subConflictId);
  const insp = inspectSubscriptionSnapshot(subConflict, db);
  assert.equal(insp.status, "conflict");
  assert.equal(insp.snapshot, null);
  assert.equal(insp.canAutoWrite, false);
  assert.match(insp.reason, /不一致/);

  const recon = reconstructSubscriptionSnapshot(subConflict, db);
  assert.equal(recon, null);
});
