"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("../../src/server/billing/catalog");
const {
  setNowGetter,
  resetNowGetter,
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
  formatShanghaiDate,
  isLeapYear,
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
  migrateLegacyUserCredits,
  migrateAllLegacyUsers,
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

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

test("V2 Standard Upgrade Example passes with exact precision", () => {
  // Setup user with 120 period credits and 300 permanent credits
  const userId = 101;
  insertUser({
    id: userId,
    name: "V2 Upgrade User",
    phone: "13800000101",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const serviceStart = new Date("2026-09-23T14:00:00+08:00").getTime();
  const serviceEnd = new Date("2026-10-23T14:00:00+08:00").getTime();
  const quoteTime = new Date("2026-10-16T14:00:00+08:00").getTime();

  setNowGetter(() => new Date(serviceStart));

  // Active pro monthly subscription
  const subResult = db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end,
      current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, created_at, updated_at
    ) VALUES (?, ?, 'monthly', 'active', ?, ?, 23, ?, ?, 400, 0, 99900, 99900, ?, ?)
  `).run(
    userId,
    "pro",
    new Date(serviceStart).toISOString(),
    new Date(serviceEnd).toISOString(),
    new Date(serviceStart).toISOString(),
    new Date(serviceEnd).toISOString(),
    new Date(serviceStart).toISOString(),
    new Date(serviceStart).toISOString()
  );
  const subscriptionId = subResult.lastInsertRowid;

  // Period lot: started with 400, 280 used, 120 remaining
  db.prepare(`
    INSERT INTO credit_lots (
      user_id, source_type, source_label, subscription_id,
      initial_credits, remaining_credits, reserved_credits, used_credits,
      starts_at, expires_at, status, created_at, updated_at
    ) VALUES (?, 'cycle', '本期积分', ?, 400, 120, 0, 280, ?, ?, 'active', ?, ?)
  `).run(
    userId,
    subscriptionId,
    new Date(serviceStart).toISOString(),
    new Date(serviceEnd).toISOString(),
    new Date(serviceStart).toISOString(),
    new Date(serviceStart).toISOString()
  );

  // Permanent lot: 300 credits
  createCreditLot({
    userId,
    sourceType: "topup",
    sourceLabel: "永久积分",
    credits: 300,
    startsAt: new Date(serviceStart).toISOString(),
    expiresAt: null,
  }, db);

  // Verify before quote
  const beforeBalances = getUserWalletBalances(userId, quoteTime, db);
  assert.equal(beforeBalances.periodBalance, 120);
  assert.equal(beforeBalances.permanentBalance, 300);
  assert.equal(beforeBalances.totalAvailable, 420);

  // Inject quote time: 2026-10-16 14:00
  setNowGetter(() => new Date(quoteTime));

  const quote = createQuote({
    userId,
    kind: "plan",
    itemId: "business",
    cycle: "monthly",
    nowMs: quoteTime,
  });

  assert.equal(quote.action, "upgrade");
  assert.equal(quote.amountFen, 46667); // ¥466.67
  assert.equal(quote.issuedNow, 257);
  assert.equal(quote.endAt, new Date(serviceEnd).toISOString());
  assert.equal(quote.periodEndAt, new Date(serviceEnd).toISOString());

  // Fulfill upgrade payment
  const outTradeNo = "rb_upgrade_test_001";
  const order = {
    id: 999,
    userId,
    outTradeNo,
    planId: "business",
    planCredits: 1500,
    amountFen: quote.amountFen,
    orderKind: "plan",
    orderAction: "upgrade",
    cycle: "monthly",
    issuedNow: quote.issuedNow,
    paidAt: new Date(quoteTime).toISOString(),
  };

  fulfillPaymentOrder(order, quoteTime, db);

  const afterBalances = getUserWalletBalances(userId, quoteTime, db);
  assert.equal(afterBalances.periodBalance, 377);
  assert.equal(afterBalances.permanentBalance, 300);
  assert.equal(afterBalances.totalAvailable, 677);

  const updatedSub = findActiveSubscription(userId, quoteTime, db);
  assert.equal(updatedSub.plan_id, "business");
  assert.equal(updatedSub.current_period_grant, 400 + 257);
  assert.equal(updatedSub.service_end, new Date(serviceEnd).toISOString());
  assert.equal(updatedSub.current_period_end, new Date(serviceEnd).toISOString());

  resetNowGetter();
});

test("Calendar month addition handles leap years and month end anchors correctly", () => {
  // 2026 is non-leap year
  const jan31_2026 = new Date("2026-01-31T14:00:00+08:00").getTime();
  const feb2026 = addCalendarMonths(jan31_2026, 1, 31);
  assert.equal(formatShanghaiDate(feb2026), "2026.02.28 14:00");

  const mar2026 = addCalendarMonths(jan31_2026, 2, 31);
  assert.equal(formatShanghaiDate(mar2026), "2026.03.31 14:00");

  const apr2026 = addCalendarMonths(jan31_2026, 3, 31);
  assert.equal(formatShanghaiDate(apr2026), "2026.04.30 14:00");

  const may2026 = addCalendarMonths(jan31_2026, 4, 31);
  assert.equal(formatShanghaiDate(may2026), "2026.05.31 14:00");

  // 2028 is a leap year
  const jan31_2028 = new Date("2028-01-31T14:00:00+08:00").getTime();
  const feb2028 = addCalendarMonths(jan31_2028, 1, 31);
  assert.equal(formatShanghaiDate(feb2028), "2028.02.29 14:00");

  const mar2028 = addCalendarMonths(jan31_2028, 2, 31);
  assert.equal(formatShanghaiDate(mar2028), "2028.03.31 14:00");

  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2100), false);
  assert.equal(isLeapYear(2000), true);
});

test("Annual subscription generates exactly 12 installments and grants installment 1 immediately", () => {
  const userId = 102;
  insertUser({
    id: userId,
    name: "Annual User",
    phone: "13800000102",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-03-23T00:00:00.000Z",
  });

  const startMs = new Date("2026-03-23T14:00:00+08:00").getTime();
  setNowGetter(() => new Date(startMs));

  const order = {
    id: 1002,
    userId,
    outTradeNo: "rb_annual_test_001",
    planId: "pro",
    planCredits: 400,
    amountFen: 999000, // ¥9,990
    orderKind: "plan",
    orderAction: "activate",
    cycle: "annual",
    paidAt: new Date(startMs).toISOString(),
  };

  fulfillPaymentOrder(order, startMs, db);

  const sub = findActiveSubscription(userId, startMs, db);
  assert.equal(sub.plan_id, "pro");
  assert.equal(sub.cycle, "annual");
  assert.equal(formatShanghaiDate(sub.service_start), "2026.03.23 14:00");
  assert.equal(formatShanghaiDate(sub.service_end), "2027.03.23 14:00");

  // Verify installments in DB
  const grants = db.prepare(`
    SELECT * FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC
  `).all(sub.id);

  assert.equal(grants.length, 12);
  assert.equal(grants[0].status, "granted");
  assert.equal(grants[0].period_index, 1);
  assert.equal(grants[1].status, "pending");
  assert.equal(grants[11].period_index, 12);
  assert.equal(grants[11].status, "pending");

  // Wallet balance after installment 1
  const balances = getUserWalletBalances(userId, startMs, db);
  assert.equal(balances.periodBalance, 400);
  assert.equal(balances.totalAvailable, 400);

  // Advance to month 2: 2026-04-23 14:00
  const month2Ms = new Date("2026-04-23T14:00:00+08:00").getTime();
  setNowGetter(() => new Date(month2Ms));

  advanceSubscriptionLifecycles(month2Ms, db);

  const updatedGrants = db.prepare(`
    SELECT * FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC
  `).all(sub.id);
  assert.equal(updatedGrants[1].status, "granted");

  resetNowGetter();
});

test("Pending scheduled plan prevents duplicate plan orders but allows booster packs", () => {
  const userId = 103;
  insertUser({
    id: userId,
    name: "Scheduled Plan User",
    phone: "13800000103",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const nowMs = new Date("2026-10-16T14:00:00+08:00").getTime();
  setNowGetter(() => new Date(nowMs));

  // Create active monthly subscription
  const subEndMs = new Date("2026-10-23T14:00:00+08:00").getTime();
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end,
      current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, created_at, updated_at
    ) VALUES (?, 'pro', 'monthly', 'active', ?, ?, 23, ?, ?, 400, 0, 99900, 99900, ?, ?)
  `).run(
    userId,
    new Date("2026-09-23T14:00:00+08:00").toISOString(),
    new Date(subEndMs).toISOString(),
    new Date("2026-09-23T14:00:00+08:00").toISOString(),
    new Date(subEndMs).toISOString(),
    new Date().toISOString(),
    new Date().toISOString()
  );

  // Request renewal quote
  const renewQuote = createQuote({
    userId,
    kind: "plan",
    itemId: "pro",
    cycle: "monthly",
    nowMs,
  });
  assert.equal(renewQuote.action, "renew");
  assert.equal(renewQuote.scheduled, true);
  assert.equal(renewQuote.startAt, new Date(subEndMs).toISOString());

  // Fulfill renewal order -> enters subscription_schedules
  fulfillPaymentOrder({
    id: 1003,
    userId,
    planId: "pro",
    cycle: "monthly",
    orderKind: "plan",
    orderAction: "renew",
    amountFen: renewQuote.amountFen,
    serviceStart: renewQuote.startAt,
    serviceEnd: renewQuote.endAt,
    paidAt: new Date(nowMs).toISOString(),
  }, nowMs, db);

  const pending = findPendingSchedule(userId, db);
  assert.ok(pending);
  assert.equal(pending.status, "scheduled");

  // Try creating another plan quote -> must throw!
  assert.throws(() => {
    createQuote({
      userId,
      kind: "plan",
      itemId: "business",
      cycle: "monthly",
      nowMs,
    });
  }, /当前已有待生效套餐安排/);

  // But creating a topup quote is allowed!
  const topupQuote = createQuote({
    userId,
    kind: "topup",
    itemId: "fuel-standard",
    nowMs,
  });
  assert.equal(topupQuote.action, "topup");
  assert.equal(topupQuote.amountFen, 29900);
  assert.equal(topupQuote.issuedNow, 80);

  resetNowGetter();
});

test("Credit ledger uses FIFO: earliest expiring first, permanent last", () => {
  const userId = 104;
  insertUser({
    id: userId,
    name: "FIFO Ledger User",
    phone: "13800000104",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
  });

  const nowMs = new Date("2026-10-16T14:00:00+08:00").getTime();
  setNowGetter(() => new Date(nowMs));

  // Lot 1: Permanent 300 credits
  const lotPermanent = createCreditLot({
    userId,
    sourceType: "topup",
    sourceLabel: "永久积分",
    credits: 300,
    startsAt: new Date(nowMs).toISOString(),
    expiresAt: null,
  }, db);

  // Lot 2: Expiring on 2026-10-23 (soonest expiring), 100 credits
  const lotSoon = createCreditLot({
    userId,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 100,
    startsAt: new Date(nowMs).toISOString(),
    expiresAt: new Date("2026-10-23T14:00:00+08:00").toISOString(),
  }, db);

  // Lot 3: Expiring on 2026-11-23 (later expiring), 50 credits
  const lotLater = createCreditLot({
    userId,
    sourceType: "cycle",
    sourceLabel: "下期积分",
    credits: 50,
    startsAt: new Date(nowMs).toISOString(),
    expiresAt: new Date("2026-11-23T14:00:00+08:00").toISOString(),
  }, db);

  // Spend 120 credits
  // Should take 100 from lotSoon (exhausts it), and 20 from lotLater (30 remaining)
  // lotPermanent should remain untouched (300 remaining)
  const allocations = spendCreditsFromLots({
    userId,
    amount: 120,
    creditEventId: 2001,
    nowIso: new Date(nowMs).toISOString(),
  }, db);

  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].lotId, lotSoon);
  assert.equal(allocations[0].creditsUsed, 100);
  assert.equal(allocations[1].lotId, lotLater);
  assert.equal(allocations[1].creditsUsed, 20);

  const soonRow = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotSoon);
  assert.equal(soonRow.remaining_credits, 0);
  assert.equal(soonRow.status, "exhausted");

  const laterRow = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotLater);
  assert.equal(laterRow.remaining_credits, 30);

  const permRow = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotPermanent);
  assert.equal(permRow.remaining_credits, 300);

  // Total available = 30 + 300 = 330
  const balances = getUserWalletBalances(userId, nowMs, db);
  assert.equal(balances.totalAvailable, 330);
  assert.equal(balances.periodBalance, 30);
  assert.equal(balances.permanentBalance, 300);

  resetNowGetter();
});

test("Legacy credit migration is idempotent and retains permanent validity", () => {
  const userId = 105;
  insertUser({
    id: userId,
    name: "Legacy Migration User",
    phone: "13800000105",
    password: "hash",
    accountType: "customer",
    credits: 500,
    createdAt: "2026-06-01T00:00:00.000Z",
  });

  // First migration
  const firstRun = migrateLegacyUserCredits(userId, db);
  assert.equal(firstRun, 500);

  const lot = db.prepare(`SELECT * FROM credit_lots WHERE user_id = ? AND source_type = 'legacy'`).get(userId);
  assert.ok(lot);
  assert.equal(lot.remaining_credits, 500);
  assert.equal(lot.expires_at, null); // Never expires!

  // Second migration (idempotent check)
  const secondRun = migrateLegacyUserCredits(userId, db);
  assert.equal(secondRun, 0); // No duplicate credits!

  const lotCount = db.prepare(`SELECT COUNT(*) AS count FROM credit_lots WHERE user_id = ?`).get(userId).count;
  assert.equal(lotCount, 1);

  const balances = getUserWalletBalances(userId, Date.now(), db);
  assert.equal(balances.totalAvailable, 500);
  assert.equal(balances.permanentBalance, 500);
  assert.equal(balances.legacyBalance, 500);
  assert.equal(balances.periodBalance, 0);
});
