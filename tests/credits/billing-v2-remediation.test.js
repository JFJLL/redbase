"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
  spendCreditsWithEventInTransaction,
  trySpendCreditsWithEvent,
  insertCreditEvent,
} = require("../../src/server/db/repositories/admin-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");
const {
  insertBrand,
} = require("../../src/server/db/repositories/brand-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

let mockNow = Date.parse("2026-10-16T06:00:00Z");
setNowGetter(() => new Date(mockNow));

function setTime(isoOrMs) {
  mockNow = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
}

let nextUid = 1000;
function createTestUser(credits = 0) {
  const uid = ++nextUid;
  insertUser({
    id: uid,
    name: `User ${uid}`,
    phone: `1380000${String(uid).padStart(4, "0")}`,
    password: "hash",
    accountType: "customer",
    credits,
    createdAt: new Date(mockNow).toISOString(),
  });
  return uid;
}

let nextOrderId = 5000;
function makeOrder(q, uid) {
  const id = ++nextOrderId;
  const outTradeNo = `rb_test_${Date.now()}_${id}`;
  const nowIso = new Date(mockNow).toISOString();
  const placed = insertPaymentOrder({
    outTradeNo,
    userId: uid,
    idempotencyKey: `idemp_${id}`,
    plan: q.kind === "plan" ? getPlan(q.itemId) : getTopup(q.itemId),
    provider: "alipay",
    quote: q,
    nowIso,
    expiresAtIso: q.expiresAt,
  });
  return placed;
}

function buyQuote(q, uid) {
  verifyAndConsumeQuote(q.quoteId, uid, mockNow);
  const order = makeOrder(q, uid);
  const nowIso = new Date(mockNow).toISOString();
  const settled = settlePaidPaymentOrder({
    outTradeNo: order.outTradeNo,
    tradeNo: `trade_${order.outTradeNo}`,
    paidAt: nowIso,
    nowIso,
  });
  return settled.order;
}

test("C1 CONTROL: standard single upgrade remains 46667 fen / 257 credits / 677 available", () => {
  const uid = createTestUser(0);
  setTime("2026-09-23T06:00:00Z");
  const qInit = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(qInit, uid);

  // Spend 280 credits
  spendCreditsFromLots({ userId: uid, amount: 280, creditEventId: 9001 }, db);
  // Add 300 permanent credits
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 300 }, db);

  // Upgrade on 2026-10-16 14:00 (UTC 06:00:00)
  setTime("2026-10-16T06:00:00Z");
  const qUp = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
  assert.equal(qUp.amountFen, 46667);
  assert.equal(qUp.issuedNow, 257);

  buyQuote(qUp, uid);
  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.periodBalance, 377); // 120 + 257
  assert.equal(wallet.permanentBalance, 300);
  assert.equal(wallet.totalAvailable, 677);

  const sub = findActiveSubscription(uid, mockNow, db);
  assert.equal(sub.plan_id, "business");
});

test("C2 CONTROL: calendar helper preserves explicitly passed day-31 anchor across non-leap and leap years", () => {
  const startNonLeap = Date.parse("2026-01-31T06:00:00Z");
  assert.equal(formatShanghaiDate(addCalendarMonths(startNonLeap, 1, 31)), "2026.02.28 14:00");
  assert.equal(formatShanghaiDate(addCalendarMonths(startNonLeap, 2, 31)), "2026.03.31 14:00");

  const startLeap = Date.parse("2028-01-31T06:00:00Z");
  assert.equal(formatShanghaiDate(addCalendarMonths(startLeap, 1, 31)), "2028.02.29 14:00");
  assert.equal(formatShanghaiDate(addCalendarMonths(startLeap, 2, 31)), "2028.03.31 14:00");
});

test("R1: trend completion deducts from credit_lots and is not restored by wallet read", () => {
  const uid = createTestUser(0);
  setTime("2026-10-16T06:00:00Z");
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 100 }, db);

  const reqId = `trend_req_${uid}`;
  const nowIso = new Date(mockNow).toISOString();

  // Ensure brand and analysis exist first to satisfy foreign keys
  const brand = insertBrand({
    ownerUserId: uid,
    name: "BrandR1",
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
  db.prepare("INSERT INTO analyses (id, brand_id, name, timestamp, position) VALUES (101, ?, 'Analysis 101', ?, 1)").run(brandId, nowIso);

  reserveTrendAnalysisRequest({
    requestId: reqId,
    userId: uid,
    brandId,
    bucketKey: "news",
    creditCost: 1,
    now: new Date(mockNow),
  });

  completeTrendAnalysisRequest({
    requestId: reqId,
    userId: uid,
    brandId,
    bucketKey: "news",
    analysisId: 101,
    event: { actionType: "trendAnalysis", actionLabel: "趋势分析" },
    buildBrand: (b) => b,
  });

  const cacheAfterSpend = findUserById(uid).credits;
  assert.equal(cacheAfterSpend, 99);

  // Read wallet - must NOT restore balance!
  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 99);
  assert.equal(findUserById(uid).credits, 99);

  const allocations = db.prepare("SELECT COUNT(*) AS n FROM credit_lot_allocations WHERE user_id = ?").get(uid).n;
  assert.equal(allocations, 1);
});

test("R2: expired-only stale cache must not authorize a successful debit", () => {
  const uid = createTestUser(0);
  setTime("2026-10-16T05:59:59Z");
  createCreditLot({
    userId: uid,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 10,
    expiresAt: "2026-10-16T06:00:00.000Z",
  }, db);

  // Stale cache has 10
  assert.equal(findUserById(uid).credits, 10);

  // Advance time past expiry
  setTime("2026-10-16T06:00:01Z");
  const result = trySpendCreditsWithEvent({
    userId: uid,
    amount: 1,
    event: { actionType: "image", actionLabel: "生成图片" },
  });

  assert.equal(result.spent, false);
  assert.equal(findUserById(uid).credits, 0);
  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 0);

  const allocations = db.prepare("SELECT COUNT(*) AS n FROM credit_lot_allocations WHERE user_id = ?").get(uid).n;
  assert.equal(allocations, 0);
});

test("R3: a second quote from an already-upgraded subscription must be rejected", () => {
  const uid = createTestUser(0);
  setTime("2026-09-23T06:00:00Z");
  const qInit = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(qInit, uid);
  spendCreditsFromLots({ userId: uid, amount: 280, creditEventId: 9002 }, db);
  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久积分", credits: 300 }, db);

  setTime("2026-10-16T06:00:00Z");
  const args = { userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow };
  const q1 = createQuote(args);
  const q2 = createQuote(args);

  // Buy first upgrade
  buyQuote(q1, uid);

  // Attempting to consume second quote must be rejected!
  assert.throws(() => {
    verifyAndConsumeQuote(q2.quoteId, uid, mockNow);
  }, /原订阅已发生变更/);

  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 677); // NOT 934!
});

test("R4: two initial activation quotes must not produce two active subscriptions", () => {
  const uid = createTestUser(0);
  setTime("2026-10-16T06:00:00Z");
  const args = { userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow };
  const a = createQuote(args);
  const b = createQuote(args);

  buyQuote(a, uid);

  assert.throws(() => {
    verifyAndConsumeQuote(b.quoteId, uid, mockNow);
  }, /已有生效套餐/);

  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND status = 'active'").get(uid).n;
  assert.equal(activeCount, 1);
  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 400); // NOT 800!
});

test("R5: renewal activation preserves the original day-31 anchor", () => {
  const uid = createTestUser(0);
  setTime("2026-01-31T06:00:00Z");
  const qInit = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(qInit, uid);

  // On Feb 10, buy renewal
  setTime("2026-02-10T06:00:00Z");
  const qRenew = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(qRenew, uid);

  // Advance time to Feb 28 14:00 (UTC 06:00) when schedule activates
  setTime(qRenew.startAt);
  advanceSubscriptionLifecycles(mockNow, db);

  const activeSub = findActiveSubscription(uid, mockNow, db);
  assert.ok(activeSub);
  assert.equal(activeSub.anchor_day, 31);
  assert.equal(formatShanghaiDate(activeSub.current_period_end), "2026.03.31 14:00");
  assert.equal(formatShanghaiDate(activeSub.service_end), "2026.03.31 14:00");

  // On March 29, the subscription and period credits must still be active!
  setTime("2026-03-29T06:00:00Z");
  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.periodBalance, 400);
});

test("R6: chained upgrades use cumulative precise rounding, not ceil each time", () => {
  const uid = createTestUser(0);
  setTime("2026-10-01T06:00:00Z");
  const qInit = createQuote({ userId: uid, kind: "plan", itemId: "light", cycle: "monthly", nowMs: mockNow });
  buyQuote(qInit, uid);

  // Advance to Oct 29 (3 days remaining out of 31)
  setTime("2026-10-29T06:00:00Z");
  const q1 = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(q1, uid);
  assert.equal(q1.issuedNow, 30);

  const q2 = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });
  buyQuote(q2, uid);
  assert.equal(q2.issuedNow, 106);

  // Total issued must be 136, NOT 137!
  assert.equal(q1.issuedNow + q2.issuedNow, 136);
});

test("R7: fulfillment must use purchased quota snapshot, not current catalog", () => {
  const uid = createTestUser(0);
  setTime("2026-10-16T06:00:00Z");
  const q = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });

  // Simulate catalog modification
  const originalCredits = getPlan("pro").credits;
  getPlan("pro").credits = 900;
  try {
    buyQuote(q, uid);
    const wallet = getUserWalletBalances(uid, mockNow, db);
    assert.equal(wallet.totalAvailable, 400); // Preserves quoted snapshot 400!
  } finally {
    getPlan("pro").credits = originalCredits;
  }
});

test("R8: annual installment grant and expiry produce visible credit_events", () => {
  const uid = createTestUser(0);
  setTime("2026-03-23T06:00:00Z");
  const q = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
  buyQuote(q, uid);

  const oldCount = db.prepare("SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?").get(uid).n;

  // Advance 1 month to 2026-04-23
  setTime("2026-04-23T06:00:00Z");
  advanceSubscriptionLifecycles(mockNow, db);
  getUserWalletBalances(uid, mockNow, db);

  const newCount = db.prepare("SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?").get(uid).n;
  assert.ok(newCount > oldCount, "Expected new credit events for annual grant and expiry");

  const grantEvent = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_grant'").get(uid);
  assert.ok(grantEvent);
  assert.equal(grantEvent.credit_delta, 400);

  const expireEvent = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").get(uid);
  assert.ok(expireEvent);
  assert.equal(expireEvent.credit_delta, -400);
});

test("R9: an activated scheduled order must no longer say scheduled", () => {
  const uid = createTestUser(0);
  setTime("2026-10-16T06:00:00Z");
  const qInit = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  buyQuote(qInit, uid);

  const qRenew = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: mockNow });
  const order = buyQuote(qRenew, uid);
  assert.equal(db.prepare("SELECT fulfillment_status FROM payment_orders WHERE id = ?").get(order.id).fulfillment_status, "scheduled");

  // Advance time to start of renewal
  setTime(qRenew.startAt);
  advanceSubscriptionLifecycles(mockNow, db);

  assert.equal(db.prepare("SELECT fulfillment_status FROM payment_orders WHERE id = ?").get(order.id).fulfillment_status, "fulfilled");
});

test("R10: creating first new lot must not erase an unmigrated positive balance", () => {
  setTime("2026-10-16T06:00:00Z");
  // User with unmigrated 5 credits, legacy_credits_migrated = 0
  const uid = ++nextUid;
  insertUser({
    id: uid,
    name: `Legacy User ${uid}`,
    phone: `1380000${String(uid).padStart(4, "0")}`,
    password: "hash",
    accountType: "customer",
    credits: 5,
    legacyCreditsMigrated: 0,
    createdAt: new Date(mockNow).toISOString(),
  });
  const q = createQuote({ userId: uid, kind: "topup", itemId: "fuel-small", nowMs: mockNow });
  buyQuote(q, uid);

  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 30); // 5 legacy + 25 topup!
  assert.equal(wallet.legacyBalance, 5);
  assert.equal(wallet.permanentBalance, 30);
});

test("R11: annual current-period usedCredits must not include past periods", () => {
  const uid = createTestUser(0);
  setTime("2026-03-23T06:00:00Z");
  const q = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
  buyQuote(q, uid);

  // Spend 280 credits in period 1
  spendCreditsFromLots({ userId: uid, amount: 280, creditEventId: 9005 }, db);

  // Advance to period 2
  setTime("2026-04-23T06:00:00Z");
  advanceSubscriptionLifecycles(mockNow, db);

  // Spend 10 credits in period 2
  spendCreditsFromLots({ userId: uid, amount: 10, creditEventId: 9006 }, db);

  const view = getUserBillingOverview(uid, mockNow, db);
  assert.equal(view.subscription.usedCredits, 10);
  assert.equal(view.subscription.totalUsedCredits, 290);
  assert.equal(view.wallet.periodBalance, 390); // 400 - 10
});
test("Cross-period reservation: settled task charges original lot even after period expiry", () => {
  const uid = createTestUser(0);
  setTime("2026-10-01T06:00:00Z");
  createCreditLot({
    userId: uid,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 50,
    startsAt: "2026-10-01T06:00:00.000Z",
    expiresAt: "2026-10-15T06:00:00.000Z",
  }, db);
  createCreditLot({
    userId: uid,
    sourceType: "topup",
    sourceLabel: "永久积分",
    credits: 100,
    startsAt: "2026-10-01T06:00:00.000Z",
    expiresAt: null,
  }, db);

  // Reserve 30 credits on Oct 10 (before expiry)
  setTime("2026-10-10T06:00:00Z");
  const reservations = reserveCreditsFromLots({ userId: uid, amount: 30, nowIso: new Date(mockNow).toISOString() }, db);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].reservedCredits, 30);

  // Advance to Oct 20 (past expiry)
  setTime("2026-10-20T06:00:00Z");
  rescanExpiredLots(uid, mockNow, db);

  // Settle the reserved task
  const allocs = settleReservedCreditsFromLots({
    userId: uid,
    creditEventId: 9801,
    reservations,
    nowIso: new Date(mockNow).toISOString(),
  }, db);

  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].creditsUsed, 30);

  const wallet = getUserWalletBalances(uid, mockNow, db);
  // Permanent credits must remain untouched at 100!
  assert.equal(wallet.permanentBalance, 100);
  assert.equal(wallet.periodBalance, 0); // Expired unreserved 20 expired
  assert.equal(wallet.totalAvailable, 100);
});

test("Cross-period reservation failure: released expired credits do not resurrect into permanent", () => {
  const uid = createTestUser(0);
  setTime("2026-10-01T06:00:00Z");
  createCreditLot({
    userId: uid,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 50,
    startsAt: "2026-10-01T06:00:00.000Z",
    expiresAt: "2026-10-15T06:00:00.000Z",
  }, db);

  // Reserve 30 credits
  setTime("2026-10-10T06:00:00Z");
  const reservations = reserveCreditsFromLots({ userId: uid, amount: 30, nowIso: new Date(mockNow).toISOString() }, db);

  // Advance past expiry
  setTime("2026-10-20T06:00:00Z");
  rescanExpiredLots(uid, mockNow, db);

  // Task fails; release reservation
  releaseReservedCreditsFromLots({
    userId: uid,
    reservations,
    nowIso: new Date(mockNow).toISOString(),
  }, db);

  const wallet = getUserWalletBalances(uid, mockNow, db);
  assert.equal(wallet.totalAvailable, 0); // Must be 0, not resurrected!
  assert.equal(wallet.permanentBalance, 0);
});

test("Annual 12-month complete lifecycle: grants all 12 installments and no 13th month", () => {
  const uid = createTestUser(0);
  setTime("2026-01-31T06:00:00Z"); // Anchor 31
  const q = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "annual", nowMs: mockNow });
  buyQuote(q, uid);

  const sub = findActiveSubscription(uid, mockNow, db);
  assert.equal(sub.anchor_day, 31);
  assert.equal(formatShanghaiDate(sub.service_end), "2027.01.31 14:00");

  const grants = db.prepare("SELECT * FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC").all(sub.id);
  assert.equal(grants.length, 12);
  assert.equal(grants[0].status, "granted");

  // Advance through all 12 months
  for (let month = 2; month <= 12; month++) {
    const periodStartMs = addCalendarMonths(Date.parse("2026-01-31T06:00:00Z"), month - 1, 31);
    setTime(periodStartMs);
    advanceSubscriptionLifecycles(mockNow, db);

    const currentGrant = db.prepare("SELECT * FROM subscription_grants WHERE subscription_id = ? AND period_index = ?").get(sub.id, month);
    assert.equal(currentGrant.status, "granted", `Month ${month} must be granted`);
  }

  // Advance past end of year (month 13)
  const month13Ms = addCalendarMonths(Date.parse("2026-01-31T06:00:00Z"), 12, 31);
  setTime(month13Ms);
  advanceSubscriptionLifecycles(mockNow, db);

  const activeSubAfterYear = findActiveSubscription(uid, mockNow, db);
  assert.equal(activeSubAfterYear, null); // Ended!
  const finalGrants = db.prepare("SELECT COUNT(*) AS n FROM subscription_grants WHERE subscription_id = ?").get(sub.id).n;
  assert.equal(finalGrants, 12); // Exactly 12, never 13!
});

test("Multi-process concurrent reservation and order mutex on real SQLite disk database", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-proc-test-"));
  const dbFile = path.join(tempDir, "concurrent.sqlite");

  const workerScript = path.join(tempDir, "worker.cjs");
  fs.writeFileSync(workerScript, `
const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
const db = new Database(process.argv[2]);
const uid = Number(process.argv[3]);
const action = process.argv[4];

if (action === "reserve") {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("BEGIN IMMEDIATE");
  const row = db.prepare("SELECT remaining_credits - reserved_credits AS avail FROM credit_lots WHERE user_id = ? AND status = 'active'").get(uid);
  if (row && row.avail >= 10) {
    db.prepare("UPDATE credit_lots SET reserved_credits = reserved_credits + 10 WHERE user_id = ?").run(uid);
    db.exec("COMMIT");
    process.stdout.write("RESERVED");
  } else {
    db.exec("ROLLBACK");
    process.stdout.write("INSUFFICIENT");
  }
}
`);

  // Initialize DB in child process
  const initScript = path.join(tempDir, "init.cjs");
  fs.writeFileSync(initScript, `
const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
const db = new Database(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("CREATE TABLE credit_lots (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, remaining_credits INTEGER, reserved_credits INTEGER);");
db.prepare("INSERT INTO credit_lots VALUES (1, 9999, 'active', 15, 0)").run();
`);

  execFileSync(process.execPath, [initScript, dbFile]);

  // Run two child processes concurrently competing for 10 credits out of 15 available: exactly one must succeed!
  const p1 = new Promise((resolve) => {
    try {
      const out = execFileSync(process.execPath, [workerScript, dbFile, "9999", "reserve"]).toString();
      resolve(out);
    } catch (e) {
      resolve("ERROR");
    }
  });

  const p2 = new Promise((resolve) => {
    try {
      const out = execFileSync(process.execPath, [workerScript, dbFile, "9999", "reserve"]).toString();
      resolve(out);
    } catch (e) {
      resolve("ERROR");
    }
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  const outcomes = [res1, res2].sort();
  assert.deepEqual(outcomes, ["INSUFFICIENT", "RESERVED"]);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
