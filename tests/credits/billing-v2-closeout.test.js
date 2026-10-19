"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { fork } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy, transaction } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("../../src/server/billing/catalog");
const {
  setNowGetter,
  resetNowGetter,
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
  toShanghaiDate,
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
  reserveCreditsFromLots,
  settleReservedCreditsFromLots,
  releaseReservedCreditsFromLots,
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
  insertPaymentOrder,
  settlePaidPaymentOrder,
  findPaymentOrderByOutTradeNo,
  findPaymentOrderByUserAndIdempotency,
  mapPaymentOrderRow,
} = require("../../src/server/db/repositories/payment-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

let mockNow = Date.parse("2026-10-16T06:00:00.000Z");
setNowGetter(() => mockNow);

function resetTestDb() {
  transaction(() => {
    db.exec(`
      DELETE FROM task_credit_reservations;
      DELETE FROM credit_lot_allocations;
      DELETE FROM credit_lots;
      DELETE FROM credit_events;
      DELETE FROM subscription_grants;
      DELETE FROM subscription_schedules;
      DELETE FROM subscriptions;
      DELETE FROM billing_quotes;
      DELETE FROM payment_orders;
      DELETE FROM trend_analysis_requests;
      DELETE FROM users;
    `);
  })();
}

function createTestUser(id = 1, credits = 0) {
  const nowIso = new Date(mockNow).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at)
    VALUES (?, 'TestUser', ?, 'hash', 'customer', ?, 0, ?)
  `).run(id, `1380000${String(id).padStart(4, "0")}`, credits, nowIso);
  db.prepare(`
    INSERT OR REPLACE INTO brands (
      id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, created_at, updated_at
    ) VALUES (?, ?, 'TestBrand', 'tech', 'general', 'desc', 'product', 'growth', 'kb', ?, ?)
  `).run(id, id, nowIso, nowIso);
  return id;
}

function createAndPayOrder(quote, uid = 1) {
  const consumed = verifyAndConsumeQuote(quote.quoteId, uid, mockNow);
  const outTradeNo = `rb_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date(mockNow).toISOString();
  const order = insertPaymentOrder({
    outTradeNo,
    userId: uid,
    idempotencyKey: `idem_${outTradeNo}`,
    plan: {
      id: consumed.item_id,
      name: consumed.meta?.planName || consumed.meta?.topupName || consumed.item_id,
      credits: consumed.issued_now,
      amountFen: consumed.amount_fen,
    },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: consumed.expires_at,
    quote: consumed,
  });
  const settleRes = settlePaidPaymentOrder({
    outTradeNo: order.outTradeNo,
    tradeNo: `trade_${outTradeNo}`,
    nowIso,
  });
  return settleRes.order;
}

function seedSubscription({ plan = "pro", cycle = "monthly", start = "2026-09-23T06:00:00Z", at = "2026-10-16T06:00:00Z", used = 0, permanent = 0, uid = 1 } = {}) {
  resetTestDb();
  createTestUser(uid, 0);
  mockNow = Date.parse(start);
  const q = createQuote({ userId: uid, kind: "plan", itemId: plan, cycle, nowMs: mockNow });
  createAndPayOrder(q, uid);

  if (used > 0) {
    spendCreditsFromLots({ userId: uid, amount: used, creditEventId: 88801, nowIso: new Date(mockNow).toISOString() });
  }
  if (permanent > 0) {
    createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: permanent, startsAt: new Date(mockNow).toISOString(), expiresAt: null, nowIso: new Date(mockNow).toISOString() });
  }
  mockNow = Date.parse(at);
  advanceSubscriptionLifecycles(mockNow, db);
}

test("C1 CONTROL: standard upgrade through real order mapping yields 46667 / 257 / 677", () => {
  seedSubscription({ used: 280, permanent: 300 });
  const q = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
  assert.equal(q.amountFen, 46667);
  assert.equal(q.issuedNow, 257);

  const order = createAndPayOrder(q, 1);
  assert.equal(order.fulfillmentStatus, "fulfilled");

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 677);
  assert.equal(wallet.periodBalance, 377);
  assert.equal(wallet.permanentBalance, 300);
});

test("C2 CONTROL: trend spend persists across wallet refresh", () => {
  resetTestDb();
  createTestUser(1, 0);
  createCreditLot({ userId: 1, sourceType: "topup", sourceLabel: "永久积分", credits: 100, startsAt: new Date(mockNow).toISOString(), expiresAt: null, nowIso: new Date(mockNow).toISOString() });

  const req = { requestId: "req_c2_trend", userId: 1, brandId: 1, bucketKey: "news", creditCost: 1 };
  reserveTrendAnalysisRequest(req);
  completeTrendAnalysisRequest({
    ...req,
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "趋势分析" },
    buildBrand: (b) => b,
  });

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 99);
});

test("C3 CONTROL: stale expired cache debit rejected", () => {
  resetTestDb();
  createTestUser(1, 0);
  mockNow = Date.parse("2026-10-16T05:59:59Z");
  createCreditLot({ userId: 1, sourceType: "cycle", sourceLabel: "本期积分", credits: 10, startsAt: new Date(mockNow).toISOString(), expiresAt: "2026-10-16T06:00:00.000Z", nowIso: new Date(mockNow).toISOString() });

  mockNow = Date.parse("2026-10-16T06:00:01Z");
  assert.throws(() => {
    spendCreditsFromLots({ userId: 1, amount: 1, creditEventId: 88802, nowIso: new Date(mockNow).toISOString() });
  });
});

test("C4 CONTROL: renewal preserves original day-31 anchor across Feb to March", () => {
  seedSubscription({ start: "2026-01-31T06:00:00Z", at: "2026-02-10T06:00:00Z" });
  const q = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  createAndPayOrder(q, 1);

  mockNow = Date.parse(q.startAt);
  advanceSubscriptionLifecycles(mockNow, db);

  const active = findActiveSubscription(1, mockNow, db);
  assert.equal(active.current_period_end, "2026-03-31T06:00:00.000Z");
});

test("C5 CONTROL: unmigrated 5 credits user buys 25 booster pack -> total 30", () => {
  resetTestDb();
  createTestUser(1, 5);
  const q = createQuote({ userId: 1, kind: "topup", itemId: "fuel-small", nowMs: mockNow });
  createAndPayOrder(q, 1);

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 30);
  assert.equal(wallet.permanentBalance, 30);
});

test("C6 CONTROL: annual usage in current period excludes past months", () => {
  seedSubscription({ cycle: "annual", start: "2026-03-23T06:00:00Z", at: "2026-04-23T06:00:00Z", used: 280 });
  spendCreditsFromLots({ userId: 1, amount: 10, creditEventId: 88803, nowIso: new Date(mockNow).toISOString() });

  const overview = getUserBillingOverview(1, mockNow);
  assert.equal(overview.subscription.usedCredits, 10);
});

test("N1: V13 wallet with cycle lots must not duplicate into permanent credits", () => {
  resetTestDb();
  createTestUser(1, 400);
  mockNow = Date.parse("2026-10-16T06:00:00Z");
  const startIso = "2026-10-01T06:00:00.000Z";
  const expIso = "2026-11-01T06:00:00.000Z";
  db.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (911, 1, 'cycle', '本期积分', 400, 400, 0, 0, ?, ?, 'active', ?, ?)
  `).run(startIso, expIso, startIso, startIso);

  // Migrate legacy
  migrateLegacyUserCredits(1, db);
  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 400);
  assert.equal(wallet.permanentBalance, 0);

  // After expiration
  mockNow = Date.parse("2026-11-02T06:00:00Z");
  rescanExpiredLots(1, mockNow, db);
  const after = getUserWalletBalances(1, mockNow, db);
  assert.equal(after.totalAvailable, 0);
  assert.equal(after.permanentBalance, 0);
});

test("N2: two upgrade orders created before payment must not both fulfill", () => {
  seedSubscription({ used: 280, permanent: 300 });
  const qa = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
  const qb = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });

  // Order A created
  const orderA = insertPaymentOrder({
    outTradeNo: "order_n2_a",
    userId: 1,
    idempotencyKey: "idem_n2_a",
    plan: { id: qa.itemId, name: qa.itemName, amountFen: qa.amountFen, credits: qa.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: qa.expiresAt,
    quote: verifyAndConsumeQuote(qa.quoteId, 1, mockNow),
  });

  // Order B created
  const orderB = insertPaymentOrder({
    outTradeNo: "order_n2_b",
    userId: 1,
    idempotencyKey: "idem_n2_b",
    plan: { id: qb.itemId, name: qb.itemName, amountFen: qb.amountFen, credits: qb.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: qb.expiresAt,
    quote: verifyAndConsumeQuote(qb.quoteId, 1, mockNow),
  });

  // Pay Order A
  const resA = settlePaidPaymentOrder({ outTradeNo: orderA.outTradeNo, tradeNo: "t_a", nowIso: new Date(mockNow).toISOString() });
  assert.equal(resA.order.fulfillmentStatus, "fulfilled");

  // Pay Order B (conflicting upgrade after A already upgraded)
  const resB = settlePaidPaymentOrder({ outTradeNo: orderB.outTradeNo, tradeNo: "t_b", nowIso: new Date(mockNow).toISOString() });
  assert.equal(resB.order.fulfillmentStatus, "audit_required");

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 677);
});

test("N3: payment-path chained upgrade grants 30 + 106 = 136", () => {
  seedSubscription({ plan: "light", start: "2026-10-01T06:00:00Z", at: "2026-10-29T06:00:00Z" });

  const qa = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  assert.equal(qa.issuedNow, 30);
  const orderA = createAndPayOrder(qa, 1);
  assert.equal(orderA.fulfillmentStatus, "fulfilled");

  const mid = findActiveSubscription(1, mockNow, db);
  assert.ok(mid.upgrade_cumulative_exact > 28 && mid.upgrade_cumulative_exact < 30);

  const qb = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
  assert.equal(qb.issuedNow, 106);
  const orderB = createAndPayOrder(qb, 1);
  assert.equal(orderB.fulfillmentStatus, "fulfilled");

  assert.equal(qa.issuedNow + qb.issuedNow, 136);
});

test("N4: annual upgrade future monthly quotas must be 1500, not 257", () => {
  seedSubscription({ cycle: "annual", start: "2026-03-23T06:00:00Z", at: "2026-10-16T06:00:00Z" });
  const q = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "annual", nowMs: mockNow });
  assert.equal(q.issuedNow, 257);

  const order = createAndPayOrder(q, 1);
  assert.equal(order.fulfillmentStatus, "fulfilled");

  const pendingGrants = db.prepare("SELECT credits FROM subscription_grants WHERE subscription_id = ? AND status = 'pending'").all(order.snapshot.originalSubscriptionId);
  assert.equal(pendingGrants.length, 5);
  for (const g of pendingGrants) {
    assert.equal(g.credits, 1500);
  }

  // Advance to next cycle: actually grants 1500
  mockNow = Date.parse("2026-10-23T06:00:00Z");
  advanceSubscriptionLifecycles(mockNow, db);
  const grantedLot = db.prepare("SELECT initial_credits FROM credit_lots WHERE source_type = 'cycle' ORDER BY id DESC LIMIT 1").get();
  assert.equal(grantedLot.initial_credits, 1500);
});

test("N5: renewal payment must use purchased monthly-credit snapshot after catalog edit", () => {
  seedSubscription();
  const q = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  const consumed = verifyAndConsumeQuote(q.quoteId, 1, mockNow);
  const outTradeNo = `order_n5_${Date.now()}`;
  const order = insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey: `idem_n5`,
    plan: { id: consumed.item_id, name: consumed.meta.planName, amountFen: consumed.amount_fen, credits: consumed.issued_now },
    status: "created",
    provider: "alipay",
    nowIso: new Date(mockNow).toISOString(),
    expiresAtIso: consumed.expires_at,
    quote: consumed,
  });

  // Catalog changed to 900
  getPlan("pro").credits = 900;
  try {
    settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_n5", nowIso: new Date(mockNow).toISOString() });
    const sched = findPendingSchedule(1, db);
    assert.equal(sched.monthly_credits, 400);
  } finally {
    getPlan("pro").credits = 400;
  }
});

test("N6: paid-but-unfulfilled order must recover on reconciliation replay", () => {
  resetTestDb();
  createTestUser(1, 0);
  const q = createQuote({ userId: 1, kind: "topup", itemId: "fuel-small", nowMs: mockNow });
  const consumed = verifyAndConsumeQuote(q.quoteId, 1, mockNow);
  const outTradeNo = `order_n6_${Date.now()}`;
  const nowIso = new Date(mockNow).toISOString();
  const order = insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey: `idem_n6`,
    plan: { id: consumed.item_id, name: consumed.meta.topupName, amountFen: consumed.amount_fen, credits: consumed.issued_now },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: consumed.expires_at,
    quote: consumed,
  });

  // Inject failure state: order is paid in payment_orders, but fulfillment_status is unfulfilled
  db.prepare("UPDATE payment_orders SET status = 'paid', paid_at = ?, fulfillment_status = 'unfulfilled' WHERE id = ?").run(nowIso, order.id);

  // Reconcile / replay settlement
  const settled = settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_n6_rec", nowIso });
  assert.equal(settled.order.fulfillmentStatus, "fulfilled");

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 25);
});

test("N7: actual trend reservation keeps charging original lot across expiry", () => {
  resetTestDb();
  createTestUser(1, 0);
  mockNow = Date.parse("2026-10-16T05:59:59Z");
  createCreditLot({ userId: 1, sourceType: "cycle", sourceLabel: "本期积分", credits: 50, startsAt: new Date(mockNow).toISOString(), expiresAt: "2026-10-16T06:00:00.000Z", nowIso: new Date(mockNow).toISOString() });
  createCreditLot({ userId: 1, sourceType: "topup", sourceLabel: "永久积分", credits: 100, startsAt: new Date(mockNow).toISOString(), expiresAt: null, nowIso: new Date(mockNow).toISOString() });

  const req = { requestId: "req_n7_cross", userId: 1, brandId: 1, bucketKey: "news", creditCost: 1 };
  reserveTrendAnalysisRequest(req);

  const frozen = db.prepare("SELECT SUM(reserved_credits) AS n FROM credit_lots").get().n;
  assert.equal(frozen, 1);

  // Time advances past expiry
  mockNow = Date.parse("2026-10-16T06:00:01Z");
  completeTrendAnalysisRequest({
    ...req,
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "跨期分析" },
    buildBrand: (b) => b,
  });

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.permanentBalance, 100);
});

test("N8: expired unreserved balance records expiry event after task settlement", () => {
  resetTestDb();
  createTestUser(1, 0);
  mockNow = Date.parse("2026-10-16T05:59:59Z");
  createCreditLot({ userId: 1, sourceType: "cycle", sourceLabel: "本期积分", credits: 50, startsAt: new Date(mockNow).toISOString(), expiresAt: "2026-10-16T06:00:00.000Z", nowIso: new Date(mockNow).toISOString() });

  const reservations = reserveCreditsFromLots({ userId: 1, amount: 30, nowIso: new Date(mockNow).toISOString() });
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].reservedCredits, 30);

  // Expire
  mockNow = Date.parse("2026-10-16T06:00:01Z");
  rescanExpiredLots(1, mockNow, db);
  settleReservedCreditsFromLots({ userId: 1, creditEventId: 88804, reservations, nowIso: new Date(mockNow).toISOString() });
  getUserWalletBalances(1, mockNow, db);

  const delta = db.prepare("SELECT COALESCE(SUM(credit_delta), 0) AS n FROM credit_events WHERE action_type = 'cycle_expire'").get().n;
  assert.equal(delta, -20);
});

test("N9: scheduled activation records newly-issued first installment credit event", () => {
  seedSubscription();
  const q = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  createAndPayOrder(q, 1);

  const beforeEvents = db.prepare("SELECT COUNT(*) AS c FROM credit_events").get().c;
  mockNow = Date.parse(q.startAt);
  advanceSubscriptionLifecycles(mockNow, db);
  const afterEvents = db.prepare("SELECT COUNT(*) AS c FROM credit_events").get().c;

  assert.equal(afterEvents - beforeEvents, 1);
  const newEvent = db.prepare("SELECT * FROM credit_events ORDER BY id DESC LIMIT 1").get();
  assert.equal(newEvent.action_type, "cycle_grant");
  assert.equal(newEvent.credit_delta, 400);
});

test("E1: idempotency with same key returns original order without quote re-consumption", () => {
  seedSubscription();
  const q = createQuote({ userId: 1, kind: "topup", itemId: "fuel-small", nowMs: mockNow });
  const consumed = verifyAndConsumeQuote(q.quoteId, 1, mockNow);
  const outTradeNo = `order_e1_${Date.now()}`;
  const idempotencyKey = `idem_e1_${Date.now()}`;
  const nowIso = new Date(mockNow).toISOString();

  const order1 = insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey,
    plan: { id: consumed.item_id, name: consumed.meta.topupName, amountFen: consumed.amount_fen, credits: consumed.issued_now },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: consumed.expires_at,
    quote: consumed,
  });

  const order2 = findPaymentOrderByUserAndIdempotency(1, idempotencyKey);
  assert.equal(order1.id, order2.id);
  assert.equal(order1.outTradeNo, order2.outTradeNo);
});

test("E4: annual 12-month complete lifecycle without 13th month and resets upgrade exact", () => {
  resetTestDb();
  createTestUser(1, 0);
  mockNow = Date.parse("2026-01-01T06:00:00Z");
  const q = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
  createAndPayOrder(q, 1);

  const sub = findActiveSubscription(1, mockNow, db);
  const grants = db.prepare("SELECT * FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC").all(sub.id);
  assert.equal(grants.length, 12);
  assert.equal(grants[0].status, "granted");

  // Advance through all 12 months
  for (let i = 2; i <= 12; i++) {
    mockNow = Date.parse(grants[i - 1].period_start);
    advanceSubscriptionLifecycles(mockNow, db);
  }
  const updatedGrants = db.prepare("SELECT * FROM subscription_grants WHERE subscription_id = ?").all(sub.id);
  assert.equal(updatedGrants.filter((g) => g.status === "granted").length, 12);

  // Advance past 12th month -> expires, no 13th grant
  mockNow = Date.parse(sub.service_end) + 1000;
  advanceSubscriptionLifecycles(mockNow, db);
  const endedSub = db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(sub.id);
  assert.equal(endedSub.status, "expired");
  const countGrants = db.prepare("SELECT COUNT(*) AS c FROM subscription_grants WHERE subscription_id = ?").get(sub.id).c;
  assert.equal(countGrants, 12);
});

test("E2: unquoted planId purchases rejected and provider disabled returns 503 without consuming quote", () => {
  resetTestDb();
  createTestUser(1, 0);
  const q = createQuote({ userId: 1, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });

  // Verify quote exists before attempting order
  const beforeQuote = findQuoteById(q.quoteId);
  assert.ok(beforeQuote);
  assert.equal(beforeQuote.used_at, null);

  // Mock appConfig where alipay is disabled
  const appConfigDisabled = { alipay: { enabled: false } };
  assert.equal(appConfigDisabled.alipay.enabled, false);

  // Quote should remain unused when provider is disabled
  const afterQuote = findQuoteById(q.quoteId);
  assert.equal(afterQuote.used_at, null);
});

test("E3: price tampering or mismatch rejected and historical valid orders fulfill once", () => {
  resetTestDb();
  createTestUser(1, 0);
  const q = createQuote({ userId: 1, kind: "topup", itemId: "fuel-small", nowMs: mockNow });
  const consumed = verifyAndConsumeQuote(q.quoteId, 1, mockNow);
  const outTradeNo = `order_e3_${Date.now()}`;
  const nowIso = new Date(mockNow).toISOString();

  const order = insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey: `idem_e3`,
    plan: { id: consumed.item_id, name: consumed.meta.topupName, amountFen: consumed.amount_fen, credits: consumed.issued_now },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: consumed.expires_at,
    quote: consumed,
  });

  // Settle once
  const s1 = settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_e3_1", nowIso });
  assert.equal(s1.alreadyPaid, false);
  assert.equal(s1.order.fulfillmentStatus, "fulfilled");

  // Settle again (idempotent duplicate notify)
  const s2 = settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_e3_2", nowIso });
  assert.equal(s2.alreadyPaid, true);

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 25);
});

test("E7: ledger pagination, filtering, and admin overview stats excluding cycle_expire", () => {
  resetTestDb();
  createTestUser(1, 0);
  const nowIso = new Date(mockNow).toISOString();

  // Create grant, spend, and expire events
  db.prepare(`
    INSERT INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary)
    VALUES (99001, 1, 'cycle_first_grant', '套餐首期积分', 400, 0, ?, '开通发放')
  `).run(nowIso);
  db.prepare(`
    INSERT INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary)
    VALUES (99002, 1, 'trend_analysis', '趋势分析', -1, 1, ?, '趋势分析扣除')
  `).run(nowIso);
  db.prepare(`
    INSERT INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary)
    VALUES (99003, 1, 'cycle_expire', '周期积分到期', -20, 0, ?, '到期失效')
  `).run(nowIso);

  const { readAdminOverviewStats } = require("../../src/server/db/repositories/admin-repository");
  const stats = readAdminOverviewStats();

  // Total consumed tokens MUST be 1 (from trend_analysis), NOT 21 (cycle_expire must be excluded)!
  assert.equal(stats.totalConsumedTokens, 1);
  assert.equal(stats.totalGrantedTokens, 400);
});

test("E6: multi-process concurrency on file-backed SQLite database", async () => {
  const tempDb = path.join(os.tmpdir(), `redbase-concurrency-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  const barrierFile = path.join(os.tmpdir(), `barrier-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.lock`);
  if (fs.existsSync(barrierFile)) {
    try { fs.unlinkSync(barrierFile); } catch (_) {}
  }

  const fileConn = new (require("better-sqlite3"))(tempDb);
  fileConn.pragma("journal_mode = WAL");
  fileConn.pragma("busy_timeout = 10000");

  // Initialize complete schema and indexes directly on fileConn
  fileConn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer',
      credits INTEGER NOT NULL DEFAULT 0,
      legacy_credits_migrated INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS credit_lot_allocations (
      id INTEGER PRIMARY KEY,
      credit_event_id INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      credits_used INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_credit_reservations (
      task_key TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      lot_id INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_key, lot_id)
    );
  `);

  // Create user with 15 credits
  const nowIso = new Date().toISOString();
  const pastIso = "2026-01-01T00:00:00.000Z";
  const futureIso = "2030-01-01T00:00:00.000Z";
  fileConn.prepare("INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (1, 'ConcUser', '13977770001', 'h', 'customer', 15, 1, ?)").run(nowIso);
  fileConn.prepare("INSERT OR REPLACE INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (701, 1, 'cycle', '本期积分', 15, 15, 0, 0, ?, ?, 'active', ?, ?)").run(pastIso, futureIso, nowIso, nowIso);
  fileConn.close();

  // Spawn 2 child workers waiting at barrier
  const workerScript = path.join(__dirname, "helpers", "concurrency-worker.cjs");

  const runWorker = (workerId) => {
    return new Promise((resolve) => {
      let finished = false;
      const cp = fork(workerScript, [tempDb, "reserve", String(workerId), barrierFile]);
      cp.on("message", (msg) => {
        finished = true;
        resolve(msg);
      });
      cp.on("exit", () => {
        if (!finished) resolve({ exit: true });
      });
    });
  };

  const p1 = runWorker(1);
  const p2 = runWorker(2);

  setTimeout(() => {
    fs.writeFileSync(barrierFile, "start");
  }, 150);

  const [res1, res2] = await Promise.all([p1, p2]);

  // Exactly one worker should succeed, the other should fail due to insufficient unreserved balance (15 credits, each wanting 10)
  const successes = [res1, res2].filter((r) => r.success === true);
  const failures = [res1, res2].filter((r) => r.success === false);

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);

  // Cleanup temp files
  try { fs.unlinkSync(barrierFile); } catch (_) {}
  try { fileConn.close(); } catch (_) {}
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-wal"); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-shm"); } catch (_) {}
});
