"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const {
  VERSIONED_MIGRATIONS,
  applyVersionedMigrations,
  ensureSubscriptionSnapshotAuditsTable,
  reconcileSubscriptionRow,
} = require("../../src/server/db/migrations");
const { PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("../../src/server/billing/catalog");
const {
  setNowGetter,
  resetNowGetter,
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
} = require("../../src/server/billing/period-utils");
const {
  createQuote,
  verifyAndConsumeQuote,
  findQuoteById,
} = require("../../src/server/billing/quote-service");
const {
  createCreditLot,
  getUserWalletBalances,
} = require("../../src/server/billing/credit-ledger");
const {
  advanceSubscriptionLifecycles,
  findActiveSubscription,
} = require("../../src/server/billing/subscription-service");
const {
  insertUser,
  findUserById,
} = require("../../src/server/db/repositories/auth-repository");
const {
  insertPaymentOrder,
  settlePaidPaymentOrder,
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

let userSeq = 88000;
function makeTestUser(credits = 0) {
  userSeq += 1;
  const uid = userSeq;
  const db = getDbProxy();
  insertUser({
    id: uid,
    name: "RevUser_" + uid,
    phone: "138" + String(uid).padStart(8, "0"),
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

test("Finding 3 Negative Control: Cancelled or scheduled schedule sharing start date is not trusted as activation source", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_f3_neg_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_f3_neg_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_f3_neg_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);
    assert.equal(sub.plan_id, "pro");

    // Break original credit_lots link to simulate damaged lot link
    db.prepare("UPDATE credit_lots SET subscription_id = NULL WHERE subscription_id = ?").run(sub.id);

    // Insert cancelled schedule with conflicting 700 monthly credits sharing the start date
    db.prepare(`
      INSERT INTO subscription_schedules (
        id, user_id, order_id, plan_id, cycle, status, start_at, end_at, amount_fen, monthly_credits, created_at, updated_at
      ) VALUES (88301, ?, 99999, 'pro', 'monthly', 'cancelled', ?, ?, 4900, 700, '2026-06-01', '2026-06-01')
    `).run(uid, sub.service_start, sub.service_end);

    const inspection = inspectSubscriptionSnapshot(sub, db);
    assert.equal(inspection.status, "unresolved");
    assert.equal(inspection.snapshot, null);
    assert.match(inspection.reason, /缺少可证明的订阅开通或排期激活来源/);

    const recon = reconstructSubscriptionSnapshot(sub, db);
    assert.equal(recon, null, "cancelled/scheduled rows must never reconstruct entitlement");
  } finally {
    resetNowGetter();
  }
});
test("Finding 3 Positive Control: Real purchase -> renewal -> advanceSubscriptionLifecycles resolves with lot link removed", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  let now = new Date("2026-01-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    // 1. User activates Pro monthly
    const q1 = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otn1 = "otn_real_init_" + uid;
    insertPaymentOrder({
      outTradeNo: otn1,
      userId: uid,
      idempotencyKey: "idem_real_init_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: q1,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otn1,
      tradeNo: "tr_real_init_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const initSub = findActiveSubscription(uid, now, db);
    assert.equal(initSub.plan_id, "pro");

    // 2. User purchases renewal for month 2 (scheduled)
    const qRenew = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now + 86400000 });
    assert.equal(qRenew.scheduled, true);
    assert.equal(qRenew.action, "renew");
    const otnRenew = "otn_real_renew_" + uid;
    insertPaymentOrder({
      outTradeNo: otnRenew,
      userId: uid,
      idempotencyKey: "idem_real_renew_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qRenew,
      nowIso: new Date(now + 86400000).toISOString(),
      expiresAtIso: new Date(now + 86400000 + 900000).toISOString(),
    });
    const paidRenew = settlePaidPaymentOrder({
      outTradeNo: otnRenew,
      tradeNo: "tr_real_renew_" + uid,
      paidAt: new Date(now + 86400000).toISOString(),
      nowIso: new Date(now + 86400000).toISOString(),
    });
    assert.equal(paidRenew.order.fulfillmentStatus, "scheduled");

    // 3. Advance lifecycles to renewal date
    now = new Date(initSub.service_end).getTime() + 1000;
    advanceSubscriptionLifecycles(now, db);

    const renewalSub = findActiveSubscription(uid, now, db);
    assert.ok(renewalSub);
    assert.notEqual(renewalSub.id, initSub.id);
    assert.equal(renewalSub.plan_id, "pro");

    // 4. Remove ONLY the historical lot link on renewalSub
    db.prepare("UPDATE credit_lots SET subscription_id = NULL WHERE subscription_id = ?").run(renewalSub.id);

    // 5. Inspect renewalSub: legitimate activated schedule provenance resolves to 400!
    const inspection = inspectSubscriptionSnapshot(renewalSub, db);
    assert.equal(inspection.status, "resolved");
    assert.equal(inspection.snapshot.planId, "pro");
    assert.equal(inspection.snapshot.monthlyCredits, 400);

    // 6. Adding an unrelated cancelled schedule at the same start date does not break resolution
    db.prepare(`
      INSERT INTO subscription_schedules (
        id, user_id, order_id, plan_id, cycle, status, start_at, end_at, amount_fen, monthly_credits, created_at, updated_at
      ) VALUES (88499, ?, 99990, 'pro', 'monthly', 'cancelled', ?, ?, 4900, 700, ?, ?)
    `).run(uid, renewalSub.service_start, renewalSub.service_end, renewalSub.service_start, renewalSub.service_start);

    const inspectionAfter = inspectSubscriptionSnapshot(renewalSub, db);
    assert.equal(inspectionAfter.status, "resolved");
    assert.equal(inspectionAfter.snapshot.monthlyCredits, 400);
  } finally {
    resetNowGetter();
  }
});

test("Finding 3: Multiple contradictory activated schedules flags conflict", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const startIso = "2026-06-01T00:00:00.000Z";
  const endIso = "2026-07-01T00:00:00.000Z";

  const o1 = insertPaymentOrder({
    outTradeNo: "otn_conf_1_" + uid,
    userId: uid,
    idempotencyKey: "idem_conf_1_" + uid,
    plan: getPlan("light"),
    provider: "test",
    quote: createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "monthly", nowMs: new Date(startIso).getTime() }),
    nowIso: startIso,
    expiresAtIso: endIso,
  });
  db.prepare("UPDATE payment_orders SET status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(o1.id);

  const o2 = insertPaymentOrder({
    outTradeNo: "otn_conf_2_" + uid,
    userId: uid,
    idempotencyKey: "idem_conf_2_" + uid,
    plan: getPlan("pro"),
    provider: "test",
    quote: createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: new Date(startIso).getTime() }),
    nowIso: startIso,
    expiresAtIso: endIso,
  });
  db.prepare("UPDATE payment_orders SET status = 'paid', fulfillment_status = 'fulfilled' WHERE id = ?").run(o2.id);

  db.prepare(`
    INSERT INTO subscription_schedules (id, user_id, order_id, plan_id, cycle, status, start_at, end_at, amount_fen, monthly_credits, created_at, updated_at)
    VALUES (88501, ?, ?, 'light', 'monthly', 'activated', ?, ?, 2900, 100, ?, ?)
  `).run(uid, o1.id, startIso, endIso, startIso, startIso);

  db.prepare(`
    INSERT INTO subscription_schedules (id, user_id, order_id, plan_id, cycle, status, start_at, end_at, amount_fen, monthly_credits, created_at, updated_at)
    VALUES (88502, ?, ?, 'pro', 'monthly', 'activated', ?, ?, 99900, 400, ?, ?)
  `).run(uid, o2.id, startIso, endIso, startIso, startIso);

  const subId = 88503;
  db.prepare(`
    INSERT INTO subscriptions (id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day, current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at)
    VALUES (?, ?, 'pro', 'monthly', 'active', ?, ?, 1, ?, ?, 400, 0, 99900, 99900, '', ?, ?)
  `).run(subId, uid, startIso, endIso, startIso, endIso, startIso, startIso);

  const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subId);
  const inspection = inspectSubscriptionSnapshot(sub, db);
  assert.equal(inspection.status, "conflict");
  assert.equal(inspection.snapshot, null);
  assert.match(inspection.reason, /存在多个重复或冲突的已生效排期记录/);
});

test("Finding 3 Positive Control: Delayed payment for normal activation order (quote time vs paid_at lag) resolves correctly", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const quoteTime = new Date("2026-06-01T10:00:00.000Z").getTime();
  const paymentTime = new Date("2026-06-01T10:05:00.000Z").getTime();
  setNowGetter(() => quoteTime);

  try {
    const q = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: quoteTime });
    const otn = "otn_delay_" + uid;
    insertPaymentOrder({
      outTradeNo: otn,
      userId: uid,
      idempotencyKey: "idem_delay_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: q,
      nowIso: new Date(quoteTime).toISOString(),
      expiresAtIso: new Date(quoteTime + 900000).toISOString(),
    });

    setNowGetter(() => paymentTime);
    const paidResult = settlePaidPaymentOrder({
      outTradeNo: otn,
      tradeNo: "tr_delay_" + uid,
      paidAt: new Date(paymentTime).toISOString(),
      nowIso: new Date(paymentTime).toISOString(),
    });
    assert.equal(paidResult.order.fulfillmentStatus, "fulfilled");

    const activeSub = findActiveSubscription(uid, paymentTime, db);
    assert.ok(activeSub);
    assert.equal(activeSub.service_start, new Date(paymentTime).toISOString());

    const inspection = inspectSubscriptionSnapshot(activeSub, db);
    assert.equal(inspection.status, "resolved");
    assert.equal(inspection.snapshot.monthlyCredits, 400);
    assert.equal(inspection.snapshot.planId, "pro");
  } finally {
    resetNowGetter();
  }
});
test("Finding 3 / 2: Upgrade order missing target pricing basis resolves to unresolved instead of silently retaining old basis", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qInit = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "monthly", nowMs: now });
    const otnInit = "otn_nobasis_init_" + uid;
    insertPaymentOrder({
      outTradeNo: otnInit,
      userId: uid,
      idempotencyKey: "idem_nobasis_init_" + uid,
      plan: getPlan("light"),
      provider: "test",
      quote: qInit,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnInit,
      tradeNo: "tr_nobasis_init_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);

    const otnUpg = "otn_nobasis_upg_" + uid;
    const upgOrder = insertPaymentOrder({
      outTradeNo: otnUpg,
      userId: uid,
      idempotencyKey: "idem_nobasis_upg_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now + 86400000 }),
      nowIso: new Date(now + 86400000).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });

    db.prepare(`
      UPDATE payment_orders
      SET status = 'paid', fulfillment_status = 'fulfilled', fulfilled_at = '2026-06-02T00:00:00.000Z',
          snapshot_json = '{"targetMonthlyCredits":400,"originalSubscriptionId":` + sub.id + `}'
      WHERE id = ?
    `).run(upgOrder.id);

    db.prepare("UPDATE subscriptions SET plan_id = 'pro' WHERE id = ?").run(sub.id);
    const subPro = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id);

    const inspection = inspectSubscriptionSnapshot(subPro, db);
    assert.equal(inspection.status, "unresolved");
    assert.match(inspection.reason, /缺少目标计费基准/);
  } finally {
    resetNowGetter();
  }
});

test("Finding 4: CAS predicate matches all structural fields and rejects write when updated_at is identical but snapshot/period changed", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_same_ts_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_same_ts_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_same_ts_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);
    const staleSnapshot = { ...inspectSubscriptionSnapshot(sub, db).snapshot, monthlyCredits: 300 };

    // Update current_period_grant without changing updated_at
    db.prepare("UPDATE subscriptions SET current_period_grant = 500 WHERE id = ?").run(sub.id);

    // Call safeUpdateSubscriptionSnapshot with stale sub object
    const accepted = safeUpdateSubscriptionSnapshot(sub, staleSnapshot, db);
    assert.equal(accepted, false, "CAS predicate must compare structural fields and reject write even when updated_at matches");

    const subAfter = findActiveSubscription(uid, now, db);
    assert.equal(JSON.parse(subAfter.snapshot_json).monthlyCredits, 400);
  } finally {
    resetNowGetter();
  }
});

test("Finding 4: safeUpdateSubscriptionSnapshot CAS failure rejects stale write and does not overwrite concurrent upgrade", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_cas_pro_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_cas_pro_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_cas_pro_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const staleSub = findActiveSubscription(uid, now, db);
    const staleSnapshot = inspectSubscriptionSnapshot(staleSub, db).snapshot;

    const qBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 10000 });
    const otnBiz = "otn_cas_biz_" + uid;
    insertPaymentOrder({
      outTradeNo: otnBiz,
      userId: uid,
      idempotencyKey: "idem_cas_biz_" + uid,
      plan: getPlan("business"),
      provider: "test",
      quote: qBiz,
      nowIso: new Date(now + 10000).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnBiz,
      tradeNo: "tr_cas_biz_" + uid,
      paidAt: new Date(now + 10000).toISOString(),
      nowIso: new Date(now + 10000).toISOString(),
    });

    const activeBefore = findActiveSubscription(uid, now + 10000, db);
    assert.equal(activeBefore.plan_id, "business");
    assert.equal(JSON.parse(activeBefore.snapshot_json).monthlyCredits, 1500);

    const accepted = safeUpdateSubscriptionSnapshot(staleSub, staleSnapshot, db);
    assert.equal(accepted, false, "CAS failure must reject stale write and return false");

    const activeAfter = findActiveSubscription(uid, now + 10000, db);
    assert.equal(activeAfter.plan_id, "business");
    assert.equal(JSON.parse(activeAfter.snapshot_json).monthlyCredits, 1500);
  } finally {
    resetNowGetter();
  }
});

test("Finding 4 Caller: createQuote throws retryable error immediately on concurrent CAS update", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  const { getDatabase } = require("../../src/server/db/connection");
  const rawDb = getDatabase();
  const origPrepare = rawDb.prepare.bind(rawDb);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_cq_cas_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_cq_cas_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_cq_cas_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);

    // Corrupt snapshot in DB to trigger lazy repair during createQuote
    origPrepare("UPDATE subscriptions SET snapshot_json = '{\"monthlyCredits\":300,\"planId\":\"pro\"}' WHERE id = ?").run(sub.id);

    const quotesBefore = origPrepare("SELECT COUNT(*) AS c FROM billing_quotes WHERE user_id = ?").get(uid).c;

    // Intercept db.prepare: when inspectSubscriptionSnapshot queries credit_lots for this subscription,
    // simulate a concurrent transaction updating subscriptions.updated_at
    let injected = false;
    rawDb.prepare = function(sql) {
      const stmt = origPrepare(sql);
      if (!injected && typeof sql === "string" && sql.includes("SELECT l.id, l.order_id, l.source_type")) {
        injected = true;
        origPrepare("UPDATE subscriptions SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(sub.id);
      }
      return stmt;
    };

    assert.throws(
      () => createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 5000 }),
      /原订阅状态已发生并发变更，无法生成有效升级报价，请重新获取报价/,
    );

    const quotesAfter = origPrepare("SELECT COUNT(*) AS c FROM billing_quotes WHERE user_id = ?").get(uid).c;
    assert.equal(quotesAfter, quotesBefore, "no stale quote should be persisted on CAS failure");

    const currentSub = origPrepare("SELECT updated_at FROM subscriptions WHERE id = ?").get(sub.id);
    assert.equal(currentSub.updated_at, "2099-01-01T00:00:00.000Z");
  } finally {
    rawDb.prepare = origPrepare;
    resetNowGetter();
  }
});

test("Finding 4: Lazy repair synchronizes activeSub.updated_at into billing_quotes.subscription_version", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_ver_sync_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_ver_sync_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_ver_sync_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);

    // Corrupt snapshot_json so lazy repair will execute during createQuote
    db.prepare("UPDATE subscriptions SET snapshot_json = '{\"monthlyCredits\":200,\"planId\":\"pro\"}', updated_at = '2026-06-01T00:00:00.000Z' WHERE id = ?").run(sub.id);

    const qBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 5000 });
    const subAfterQuote = findActiveSubscription(uid, now + 5000, db);

    const quoteRow = db.prepare("SELECT subscription_version FROM billing_quotes WHERE id = ?").get(qBiz.quoteId);
    assert.equal(quoteRow.subscription_version, subAfterQuote.updated_at, "quote subscription_version must match refreshed updated_at");

    const consumed = verifyAndConsumeQuote(qBiz.quoteId, uid, now + 5000);
    assert.ok(consumed);
  } finally {
    resetNowGetter();
  }
});
test("Finding 5: V20 preserves intact historical snapshot as evidence and records audit before write", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_v20_pres_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_v20_pres_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_v20_pres_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);
    const intactSnapshotJson = sub.snapshot_json;

    // Simulate broken lot links (unresolved provenance)
    db.prepare("UPDATE credit_lots SET subscription_id = NULL WHERE subscription_id = ?").run(sub.id);

    // Run V20
    const v20 = VERSIONED_MIGRATIONS.find((m) => m.version === 20);
    v20.apply();

    // Assert: Intact snapshot is PRESERVED, not erased!
    const subAfter = findActiveSubscription(uid, now, db);
    assert.equal(subAfter.snapshot_json, intactSnapshotJson, "intact historical snapshot must be preserved as evidence");

    const auditRow = db.prepare("SELECT * FROM subscription_snapshot_audits WHERE subscription_id = ? AND migration_version = 20").get(sub.id);
    assert.ok(auditRow);
    assert.equal(auditRow.action_type, "preserve_unresolved");
    assert.equal(auditRow.pre_snapshot_json, intactSnapshotJson);

    // Automatic dependent upgrade pricing is gated
    assert.throws(
      () => createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 1000 }),
      /当前订阅权益快照待核查，无法自动计算升级差额，请联系客服处理/,
    );
  } finally {
    resetNowGetter();
  }
});

test("Finding 5: V21 marks audit_required_unresolved on empty and '{}' no-source snapshots without fabricating data", () => {
  const db = getDbProxy();
  const uid1 = makeTestUser(100);
  const uid2 = makeTestUser(100);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const subEmptyId = 88701;
    const subBracesId = 88702;

    // Sub 1: snapshot_json = ''
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day,
        current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment,
        pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
      ) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 0, 0, 4900, 4900, '', '2026-06-01', '2026-06-01')
    `).run(subEmptyId, uid1);

    // Sub 2: snapshot_json = '{}'
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day,
        current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment,
        pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
      ) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 0, 0, 4900, 4900, '{}', '2026-06-01', '2026-06-01')
    `).run(subBracesId, uid2);

    const walletBefore = getUserWalletBalances(uid1, now, db);

    const v21 = VERSIONED_MIGRATIONS.find((m) => m.version === 21);
    v21.apply();

    // Verify Sub 1: snapshot remains ''
    const subEmptyAfter = db.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subEmptyId);
    assert.equal(subEmptyAfter.snapshot_json, "", "must not fabricate snapshot without source");
    const auditEmpty = db.prepare("SELECT * FROM subscription_snapshot_audits WHERE subscription_id = ? AND migration_version = 21").get(subEmptyId);
    assert.ok(auditEmpty);
    assert.equal(auditEmpty.action_type, "audit_required_unresolved");
    assert.equal(auditEmpty.pre_snapshot_json, "");
    assert.equal(auditEmpty.post_snapshot_json, "", "postimage must equal actual stored row for empty-string variant");

    // Verify Sub 2: snapshot remains '{}'
    const subBracesAfter = db.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subBracesId);
    assert.equal(subBracesAfter.snapshot_json, "{}", "must not fabricate snapshot without source");
    const auditBraces = db.prepare("SELECT * FROM subscription_snapshot_audits WHERE subscription_id = ? AND migration_version = 21").get(subBracesId);
    assert.ok(auditBraces);
    assert.equal(auditBraces.action_type, "audit_required_unresolved");
    assert.equal(auditBraces.pre_snapshot_json, "{}");
    assert.equal(auditBraces.post_snapshot_json, "{}", "postimage must equal actual stored row for '{}' variant");

    const walletAfter = getUserWalletBalances(uid1, now, db);
    assert.equal(walletAfter.permanentBalance, walletBefore.permanentBalance);

    v21.apply();
    const countAfter = db.prepare("SELECT COUNT(*) AS c FROM subscription_snapshot_audits WHERE subscription_id = ? AND migration_version = 21").get(subEmptyId).c;
    assert.equal(countAfter, 1, "repeated V21 must be idempotent");
  } finally {
    resetNowGetter();
  }
});

test("Finding 5 / 2: Historical pricing_basis_fen drift is reconciled by V21 and subsequent quote computes exact diff", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const subId = 88801;
    const startIso = "2026-06-01T00:00:00.000Z";
    const endIso = "2026-07-01T00:00:00.000Z";

    const otn = "otn_drift_" + uid;
    const pOrder = insertPaymentOrder({
      outTradeNo: otn,
      userId: uid,
      idempotencyKey: "idem_drift_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now }),
      nowIso: startIso,
      expiresAtIso: endIso,
    });
    db.prepare(`
      UPDATE payment_orders
      SET status = 'paid', fulfillment_status = 'fulfilled',
          snapshot_json = '{"monthlyCredits":400,"planId":"pro","cycle":"monthly","pricingBasisFen":99900}'
      WHERE id = ?
    `).run(pOrder.id);

    db.prepare(`
      INSERT INTO credit_lots (id, user_id, source_type, source_label, order_id, subscription_id, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at)
      VALUES (888011, ?, 'cycle', '本期积分', ?, ?, 400, 400, 0, 0, ?, ?, 'active', ?, ?)
    `).run(uid, pOrder.id, subId, startIso, endIso, startIso, startIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day,
        current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment,
        pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
      ) VALUES (?, ?, 'pro', 'monthly', 'active', ?, ?, 1, ?, ?, 400, 0, 199900, 99900, '{"monthlyCredits":400,"planId":"pro","pricingBasisFen":199900}', ?, ?)
    `).run(subId, uid, startIso, endIso, startIso, endIso, startIso, startIso);

    const v21 = VERSIONED_MIGRATIONS.find((m) => m.version === 21);
    v21.apply();

    const subAfter = db.prepare("SELECT pricing_basis_fen, snapshot_json FROM subscriptions WHERE id = ?").get(subId);
    assert.equal(subAfter.pricing_basis_fen, 99900);
    assert.equal(JSON.parse(subAfter.snapshot_json).pricingBasisFen, 99900);

    const quoteNow = new Date("2026-06-15T00:00:00.000Z").getTime();
    const qBiz = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: quoteNow });
    assert.equal(qBiz.meta.upgradeDetails.oldFullTermPrice, 99900);
    const expectedCharge = Math.round((getPlan("business").monthlyFen - 99900) * (qBiz.meta.upgradeDetails.serviceRemainingMs / qBiz.meta.upgradeDetails.serviceTotalMs));
    assert.equal(qBiz.amountFen, expectedCharge);
  } finally {
    resetNowGetter();
  }
});

test("Transaction rollback: failing update on separate connection rolls back both audit row and subscription mutation", () => {
  const Database = require("better-sqlite3");
  const separateDb = new Database(":memory:");
  separateDb.pragma("foreign_keys = ON");

  // Setup minimal schema on separateDb
  separateDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0,
      legacy_credits_migrated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE credit_events (
      id INTEGER PRIMARY KEY, user_id INTEGER, action_type TEXT, payload_json TEXT
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan_id TEXT NOT NULL, cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', service_start TEXT NOT NULL, service_end TEXT NOT NULL,
      anchor_day INTEGER NOT NULL, current_period_start TEXT NOT NULL, current_period_end TEXT NOT NULL,
      current_period_grant INTEGER NOT NULL, upgrade_cumulative_increment INTEGER NOT NULL DEFAULT 0,
      upgrade_cumulative_exact REAL NOT NULL DEFAULT 0, pricing_basis_fen INTEGER NOT NULL,
      actual_paid_total_fen INTEGER NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE credit_lots (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_label TEXT NOT NULL,
      order_id INTEGER, subscription_id INTEGER, initial_credits INTEGER NOT NULL, remaining_credits INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL DEFAULT 0, used_credits INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE payment_orders (
      id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, plan_credits INTEGER NOT NULL, amount_fen INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created', provider TEXT NOT NULL DEFAULT 'alipay', trade_no TEXT NOT NULL DEFAULT '',
      fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled', order_kind TEXT NOT NULL DEFAULT 'plan',
      order_action TEXT NOT NULL DEFAULT 'activate', cycle TEXT NOT NULL DEFAULT '', snapshot_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT NOT NULL DEFAULT '',
      fulfilled_at TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '', audit_reason TEXT NOT NULL DEFAULT '', audit_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE subscription_schedules (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
      cycle TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      amount_fen INTEGER NOT NULL, monthly_credits INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_grants (
      id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL, user_id INTEGER NOT NULL, period_index INTEGER NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      granted_at TEXT, credit_lot_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  ensureSubscriptionSnapshotAuditsTable(separateDb);

  const subId = 99991;
  const uid = 9999;
  separateDb.prepare("INSERT INTO users (id, name, phone, password, created_at) VALUES (?, 'SepUser', '13899990001', 'hash', '2026-01-01')").run(uid);
  separateDb.prepare(`
    INSERT INTO subscriptions (
      id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day,
      current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
    ) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-06-01', '2026-07-01', 1, '2026-06-01', '2026-07-01', 400, 0, 4900, 4900, '{"monthlyCredits":200,"planId":"pro"}', '2026-06-01', '2026-06-01')
  `).run(subId, uid);

  // Link valid order
  separateDb.prepare(`
    INSERT INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, fulfillment_status, snapshot_json, expires_at, created_at, updated_at, quote_id)
    VALUES (999910, 'otn_sep_fail', ?, 'idem_sep', 'pro', '专业版', 400, 4900, 'paid', 'fulfilled', '{"monthlyCredits":400,"planId":"pro","cycle":"monthly","pricingBasisFen":4900}', '2026-07-01', '2026-06-01', '2026-06-01', '')
  `).run(uid);
  separateDb.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, order_id, subscription_id, initial_credits, remaining_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (9999101, ?, 'cycle', '本期积分', 999910, ?, 400, 400, '2026-06-01', '2026-07-01', 'active', '2026-06-01', '2026-06-01')
  `).run(uid, subId);

  // Add trigger that throws on update
  separateDb.exec("CREATE TRIGGER fail_separate_sub BEFORE UPDATE ON subscriptions BEGIN SELECT RAISE(ABORT, 'forced separate update failure'); END;");

  const subObj = separateDb.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subId);

  assert.throws(
    () => reconcileSubscriptionRow({ sub: subObj, migrationVersion: 21, db: separateDb }),
    /forced separate update failure/,
  );

  // Assert rollback on the separate database instance: audit count is 0
  const auditCount = separateDb.prepare("SELECT COUNT(*) AS c FROM subscription_snapshot_audits WHERE subscription_id = ?").get(subId).c;
  assert.equal(auditCount, 0, "audit record must rollback on separate db instance update failure");
});
test("Price-only snapshot corruption regression: column 99900, snapshot 199900, same 400/plan -> dryrun detects, execute repairs + preimage, repeat idempotent", () => {
  const Database = require("better-sqlite3");
  const memDb = new Database(":memory:");
  memDb.pragma("foreign_keys = ON");

  memDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0,
      legacy_credits_migrated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE credit_events (
      id INTEGER PRIMARY KEY, user_id INTEGER, action_type TEXT, payload_json TEXT
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan_id TEXT NOT NULL, cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', service_start TEXT NOT NULL, service_end TEXT NOT NULL,
      anchor_day INTEGER NOT NULL, current_period_start TEXT NOT NULL, current_period_end TEXT NOT NULL,
      current_period_grant INTEGER NOT NULL, upgrade_cumulative_increment INTEGER NOT NULL DEFAULT 0,
      upgrade_cumulative_exact REAL NOT NULL DEFAULT 0, pricing_basis_fen INTEGER NOT NULL,
      actual_paid_total_fen INTEGER NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE credit_lots (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_label TEXT NOT NULL,
      order_id INTEGER, subscription_id INTEGER, initial_credits INTEGER NOT NULL, remaining_credits INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL DEFAULT 0, used_credits INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE payment_orders (
      id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, plan_credits INTEGER NOT NULL, amount_fen INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created', provider TEXT NOT NULL DEFAULT 'alipay', trade_no TEXT NOT NULL DEFAULT '',
      fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled', order_kind TEXT NOT NULL DEFAULT 'plan',
      order_action TEXT NOT NULL DEFAULT 'activate', cycle TEXT NOT NULL DEFAULT '', snapshot_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT NOT NULL DEFAULT '',
      fulfilled_at TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '', audit_reason TEXT NOT NULL DEFAULT '', audit_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE subscription_schedules (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
      cycle TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      amount_fen INTEGER NOT NULL, monthly_credits INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_grants (
      id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL, user_id INTEGER NOT NULL, period_index INTEGER NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      granted_at TEXT, credit_lot_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  const { auditBillingDatabase } = require("../../scripts/audit-and-repair-billing-v2");

  const uid = 9988;
  const subId = 99881;
  const startIso = "2026-06-01T00:00:00.000Z";
  const endIso = "2026-07-01T00:00:00.000Z";

  memDb.prepare("INSERT INTO users (id, name, phone, password, created_at) VALUES (?, 'PriceOnlyUser', '13899880001', 'h', '2026-01-01')").run(uid);

  memDb.prepare(`
    INSERT INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, fulfillment_status, snapshot_json, expires_at, created_at, updated_at)
    VALUES (998810, 'otn_price_only', ?, 'idem_po', 'pro', '专业版', 400, 99900, 'paid', 'fulfilled', '{"monthlyCredits":400,"planId":"pro","cycle":"monthly","pricingBasisFen":99900}', '2026-07-01', '2026-06-01', '2026-06-01')
  `).run(uid);

  memDb.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, order_id, subscription_id, initial_credits, remaining_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (9988101, ?, 'cycle', '本期积分', 998810, ?, 400, 400, ?, ?, 'active', ?, ?)
  `).run(uid, subId, startIso, endIso, startIso, startIso);

  const corruptSnapJson = JSON.stringify({
    version: "v2",
    planId: "pro",
    cycle: "monthly",
    monthlyCredits: 400,
    pricingBasisFen: 199900,
    serviceStart: startIso,
    serviceEnd: endIso,
  });

  memDb.prepare(`
    INSERT INTO subscriptions (
      id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day,
      current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
    ) VALUES (?, ?, 'pro', 'monthly', 'active', ?, ?, 1, ?, ?, 400, 0, 99900, 99900, ?, ?, ?)
  `).run(subId, uid, startIso, endIso, startIso, endIso, corruptSnapJson, startIso, startIso);

  // 1. Dry-run must detect this mismatch
  const dryReport = auditBillingDatabase(memDb, { dryRun: true });
  assert.equal(dryReport.subscriptionSnapshotAudits.length, 1);
  assert.equal(dryReport.subscriptionSnapshotAudits[0].subscriptionId, subId);
  assert.match(dryReport.subscriptionSnapshotAudits[0].conflictReason, /pricingBasisFen/);
  assert.equal(dryReport.subscriptionSnapshotAudits[0].actionTaken, "需修正");

  // Verify no mutation occurred during dry-run
  const subAfterDry = memDb.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subId);
  assert.equal(subAfterDry.snapshot_json, corruptSnapJson);

  // 2. Execute mode repairs it and captures preimage
  const execReport = auditBillingDatabase(memDb, { dryRun: false });
  assert.equal(execReport.subscriptionSnapshotAudits.length, 1);
  assert.equal(execReport.subscriptionSnapshotAudits[0].actionTaken, "repair");

  const subAfterExec = memDb.prepare("SELECT snapshot_json, pricing_basis_fen FROM subscriptions WHERE id = ?").get(subId);
  const fixedSnap = JSON.parse(subAfterExec.snapshot_json);
  assert.equal(fixedSnap.pricingBasisFen, 99900, "snapshot pricingBasisFen must be repaired to 99900");
  assert.equal(subAfterExec.pricing_basis_fen, 99900);

  // Preimage audit row captured
  const auditRow = memDb.prepare("SELECT * FROM subscription_snapshot_audits WHERE subscription_id = ? AND action_type = 'repair'").get(subId);
  assert.ok(auditRow);
  assert.equal(JSON.parse(auditRow.pre_snapshot_json).pricingBasisFen, 199900);
  assert.equal(JSON.parse(auditRow.post_snapshot_json).pricingBasisFen, 99900);

  // 3. Repeat execution is idempotent: audit report shows 0 anomalies and no additional audit rows created
  const repeatReport = auditBillingDatabase(memDb, { dryRun: false });
  assert.equal(repeatReport.subscriptionSnapshotAudits.length, 0);

  const totalAudits = memDb.prepare("SELECT COUNT(*) AS c FROM subscription_snapshot_audits WHERE subscription_id = ?").get(subId).c;
  assert.equal(totalAudits, 1, "repeated execution must be idempotent");
});

test("Shared consistency predicate: guards null, 'null', and non-object snapshots without throwing", () => {
  const { isSubscriptionSnapshotConsistent } = require("../../src/server/billing/snapshot-recovery");

  const sub = { id: 1, user_id: 1, plan_id: "pro", cycle: "monthly", pricing_basis_fen: 99900 };
  const expected = { planId: "pro", cycle: "monthly", monthlyCredits: 400, pricingBasisFen: 99900 };

  // 'null' string in snapshot_json
  const resNullStr = isSubscriptionSnapshotConsistent({ ...sub, snapshot_json: "null" }, expected);
  assert.equal(resNullStr.isConsistent, false);
  assert.deepEqual(resNullStr.mismatches, ["non_object_snapshot"]);

  // Literal null object
  const resLiteralNull = isSubscriptionSnapshotConsistent(sub, expected, null);
  assert.equal(resLiteralNull.isConsistent, false);

  // Array snapshot
  const resArray = isSubscriptionSnapshotConsistent(sub, expected, []);
  assert.equal(resArray.isConsistent, false);
  assert.deepEqual(resArray.mismatches, ["non_object_snapshot"]);

  // Primitive string
  const resPrim = isSubscriptionSnapshotConsistent(sub, expected, "corrupt");
  assert.equal(resPrim.isConsistent, false);
  assert.deepEqual(resPrim.mismatches, ["non_object_snapshot"]);
});

test("Lazy quote column drift repair: first quote fixes column and snapshot atomically; second quote performs no update (updated_at stable)", () => {
  const db = getDbProxy();
  const uid = makeTestUser(0);
  const now = new Date("2026-06-01T00:00:00.000Z").getTime();
  setNowGetter(() => now);

  try {
    const qPro = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: now });
    const otnPro = "otn_lazy_drift_" + uid;
    insertPaymentOrder({
      outTradeNo: otnPro,
      userId: uid,
      idempotencyKey: "idem_lazy_drift_" + uid,
      plan: getPlan("pro"),
      provider: "test",
      quote: qPro,
      nowIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + 900000).toISOString(),
    });
    settlePaidPaymentOrder({
      outTradeNo: otnPro,
      tradeNo: "tr_lazy_drift_" + uid,
      paidAt: new Date(now).toISOString(),
      nowIso: new Date(now).toISOString(),
    });

    const sub = findActiveSubscription(uid, now, db);

    // Corrupt column pricing_basis_fen = 199900 in DB (while paid order has 99900)
    db.prepare("UPDATE subscriptions SET pricing_basis_fen = 199900, snapshot_json = '{\"monthlyCredits\":400,\"planId\":\"pro\",\"cycle\":\"monthly\",\"pricingBasisFen\":199900}', updated_at = '2026-06-01T00:00:00.000Z' WHERE id = ?").run(sub.id);

    // First quote: detects drift, atomically repairs BOTH snapshot_json and pricing_basis_fen column!
    const q1 = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 5000 });
    assert.equal(q1.meta.upgradeDetails.oldFullTermPrice, 99900);

    const subAfterQ1 = findActiveSubscription(uid, now + 5000, db);
    assert.equal(subAfterQ1.pricing_basis_fen, 99900, "first quote must repair subscriptions.pricing_basis_fen to 99900");
    assert.equal(JSON.parse(subAfterQ1.snapshot_json).pricingBasisFen, 99900);
    const updatedAtAfterQ1 = subAfterQ1.updated_at;

    // Second quote: consistency checks pass, no repair needed, updated_at remains strictly identical!
    const q2 = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: now + 6000 });
    assert.equal(q2.meta.upgradeDetails.oldFullTermPrice, 99900);

    const subAfterQ2 = findActiveSubscription(uid, now + 6000, db);
    assert.equal(subAfterQ2.updated_at, updatedAtAfterQ1, "second quote must perform no update, updated_at must be stable");
  } finally {
    resetNowGetter();
  }
});
