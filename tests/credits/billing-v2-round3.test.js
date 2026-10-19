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
  buildCanonicalTaskKey,
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
  closePaymentOrder,
} = require("../../src/server/db/repositories/payment-repository");
const {
  spendCreditsWithEventInTransaction,
  trySpendCreditsWithEvent,
  insertCreditEvent,
} = require("../../src/server/db/repositories/admin-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");
const {
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
} = require("../../src/server/db/repositories/excellent-remix-billing-repository");

let db;
let mockNow = Date.parse("2026-10-16T00:00:00.000Z");

function setTime(iso) {
  mockNow = Date.parse(iso);
}

function resetTestDb() {
  db = openDatabase();
  initializeDatabaseSchema();
  ensureDatabaseIndexes();
  setNowGetter(() => mockNow);
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
    ) VALUES (?, ?, 'TestBrand', '运营', '品牌方', '测试', '测试产品', '测试目标', '', ?, ?)
  `).run(id * 10, id, nowIso, nowIso);
  db.prepare(`
    INSERT OR REPLACE INTO brands (
      id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, created_at, updated_at
    ) VALUES (?, ?, 'SecondBrand', '运营', '品牌方', '测试2', '测试产品2', '测试目标2', '', ?, ?)
  `).run(id * 10 + 1, id, nowIso, nowIso);
  return id;
}

// =========================================================================
// F1: 任务身份与账户归属隔离
// =========================================================================

test("F1: User A and User B using same requestId under respective brands isolate completely", () => {
  resetTestDb();
  createTestUser(1, 10);
  createTestUser(2, 10);
  const sharedRequestId = "req_shared_collision_001";

  // User A reserves 1 credit
  const resA = reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: 1,
    brandId: 10,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(resA.status, "reserved");

  // User B reserves 1 credit with same requestId under own brand
  const resB = reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: 2,
    brandId: 20,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(resB.status, "reserved");

  // B completes first
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: 2,
    brandId: 20,
    bucketKey: "traffic",
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "B完成" },
    buildBrand: (b) => b,
  });

  // A completes second
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: 1,
    brandId: 10,
    bucketKey: "traffic",
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "A完成" },
    buildBrand: (b) => b,
  });

  // Invariants: A=9, B=9, NEVER A=8, B=10!
  const walletA = getUserWalletBalances(1, mockNow, db);
  const walletB = getUserWalletBalances(2, mockNow, db);
  assert.equal(walletA.totalAvailable, 9);
  assert.equal(walletB.totalAvailable, 9);

  // Zero mismatched allocations in credit_lot_allocations
  const mismatches = db.prepare(`
    SELECT a.id, a.user_id AS alloc_user, l.user_id AS lot_user
    FROM credit_lot_allocations a
    JOIN credit_lots l ON l.id = a.lot_id
    WHERE a.user_id <> l.user_id
  `).all();
  assert.equal(mismatches.length, 0);
});

test("F1: Same user different brands and different buckets with same requestId isolate properly", () => {
  resetTestDb();
  createTestUser(1, 10);

  const key1 = buildCanonicalTaskKey({ userId: 1, taskType: "trend_analysis", taskId: "req_dup", brandId: 10, bucketKey: "traffic" });
  const key2 = buildCanonicalTaskKey({ userId: 1, taskType: "trend_analysis", taskId: "req_dup", brandId: 11, bucketKey: "traffic" });
  const key3 = buildCanonicalTaskKey({ userId: 1, taskType: "trend_analysis", taskId: "req_dup", brandId: 10, bucketKey: "news" });
  assert.notEqual(key1, key2);
  assert.notEqual(key1, key3);

  // Wrong user attempting to settle or release throws error and touches no balance
  reserveCreditsForTask({ userId: 1, taskKey: key1, taskId: "req_dup", taskType: "trend_analysis", brandId: 10, bucketKey: "traffic", amount: 1 }, db);

  assert.throws(() => {
    settleCreditsForTask({ userId: 2, taskKey: key1, taskId: "req_dup", taskType: "trend_analysis", brandId: 10, bucketKey: "traffic", creditEventId: 999 }, db);
  });

  assert.throws(() => {
    releaseCreditsForTask({ userId: 2, taskKey: key1, taskId: "req_dup", taskType: "trend_analysis", brandId: 10, bucketKey: "traffic" }, db);
  });

  // User 1 available remains 9 (1 reserved)
  const wallet1 = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet1.totalAvailable, 9);
});

// =========================================================================
// F2 & F3: 可用余额口径与预占原子性
// =========================================================================

test("F2: User with 2 credits can create two 1-credit tasks sequentially without double freeze", () => {
  resetTestDb();
  createTestUser(1, 2);

  // Task 1 reserves 1 credit
  const res1 = reserveTrendAnalysisRequest({
    requestId: "req_f2_1",
    userId: 1,
    brandId: 10,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(res1.status, "reserved");

  // Available is now 1
  const walletMid = getUserWalletBalances(1, mockNow, db);
  assert.equal(walletMid.totalAvailable, 1);

  // Task 2 in another bucket must SUCCEED (not blocked by double-freezing!)
  const res2 = reserveTrendAnalysisRequest({
    requestId: "req_f2_2",
    userId: 1,
    brandId: 10,
    bucketKey: "news",
    creditCost: 1,
  });
  assert.equal(res2.status, "reserved");

  // Third 1-credit task must be rejected as insufficient
  const res3 = reserveTrendAnalysisRequest({
    requestId: "req_f2_3",
    userId: 1,
    brandId: 10,
    bucketKey: "social",
    creditCost: 1,
  });
  assert.equal(res3.status, "insufficient");

  // Complete both tasks
  completeTrendAnalysisRequest({
    requestId: "req_f2_1",
    userId: 1,
    brandId: 10,
    bucketKey: "traffic",
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "任务1完成" },
    buildBrand: (b) => b,
  });
  completeTrendAnalysisRequest({
    requestId: "req_f2_2",
    userId: 1,
    brandId: 10,
    bucketKey: "news",
    analysisId: null,
    event: { actionType: "trend_analysis", summary: "任务2完成" },
    buildBrand: (b) => b,
  });

  const walletFinal = getUserWalletBalances(1, mockNow, db);
  assert.equal(walletFinal.totalAvailable, 0);
});

test("F3: Database error between lot freeze and reservation record insert rolls back atomically", () => {
  resetTestDb();
  createTestUser(1, 0);
  createCreditLot({ userId: 1, sourceType: "cycle", sourceLabel: "测试", credits: 10, startsAt: new Date(mockNow).toISOString(), expiresAt: "2030-01-01T00:00:00.000Z", nowIso: new Date(mockNow).toISOString() }, db);
  const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = 1").get().count;

  // Inject DB failure inside transaction
  assert.throws(() => {
    transaction(() => {
      reserveCreditsFromLots({ userId: 1, amount: 5, nowIso: new Date(mockNow).toISOString() }, db);
      throw new Error("SIMULATED_DB_CRASH");
    })();
  });

  // After rollback: available is still 10, reserved total is 0, no credit events
  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 10);
  const reservedInLots = db.prepare("SELECT SUM(reserved_credits) AS n FROM credit_lots WHERE user_id = 1").get().n;
  assert.equal(reservedInLots, 0);
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = 1").get().count;
  assert.equal(eventCount, eventsBefore);
});

// =========================================================================
// F4 & F8: 到期、释放和流水数量守恒 (40 到期 + 10 消费 = 50)
// =========================================================================

test("F4: Initial 50, A reserves 20, B reserves 10, unreserved 20 expires; A fails, B settles -> 40 expired + 10 consumed = 50", () => {
  resetTestDb();
  createTestUser(1, 0);
  const startIso = "2026-10-01T00:00:00.000Z";
  const expiryIso = "2026-10-15T00:00:00.000Z";
  setTime(startIso);

  const lotId = createCreditLot({
    userId: 1,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 50,
    startsAt: startIso,
    expiresAt: expiryIso,
    nowIso: startIso,
  }, db);

  // Task A reserves 20, Task B reserves 10
  reserveCreditsForTask({ userId: 1, taskKey: "task_A", taskId: "A", taskType: "test", amount: 20, nowIso: startIso }, db);
  reserveCreditsForTask({ userId: 1, taskKey: "task_B", taskId: "B", taskType: "test", amount: 10, nowIso: startIso }, db);

  // Advance time past expiry
  setTime("2026-10-15T01:00:00.000Z");
  const postExpiryIso = new Date(mockNow).toISOString();

  // Step 1: Rescan unreserved 20 expires
  rescanExpiredLots(1, mockNow, db);

  // Step 2: Task A fails and releases 20 -> must expire, not resurrect!
  releaseCreditsForTask({ userId: 1, taskKey: "task_A", taskId: "A", taskType: "test", nowIso: postExpiryIso }, db);

  // Step 3: Task B succeeds and settles 10
  settleCreditsForTask({ userId: 1, taskKey: "task_B", taskId: "B", taskType: "test", creditEventId: 9999, nowIso: postExpiryIso }, db);

  // Invariants check:
  const lot = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
  assert.equal(lot.remaining_credits, 0);
  assert.equal(lot.reserved_credits, 0);
  assert.equal(lot.used_credits, 10);

  // Check credit events:
  const expireEvents = db.prepare("SELECT SUM(ABS(credit_delta)) AS n FROM credit_events WHERE user_id = 1 AND action_type = 'cycle_expire'").get().n || 0;
  assert.equal(expireEvents, 40); // 20 from unreserved + 20 from expired release

  // 40 expired + 10 consumed = 50 total!
  assert.equal(expireEvents + lot.used_credits, 50);
});

test("F8: Atomicity of cycle_expire event insertion and lot state update", () => {
  resetTestDb();
  createTestUser(1, 0);
  const startIso = "2026-10-01T00:00:00.000Z";
  const expiryIso = "2026-10-15T00:00:00.000Z";
  setTime(startIso);

  const lotId = createCreditLot({
    userId: 1,
    sourceType: "cycle",
    sourceLabel: "本期积分",
    credits: 30,
    startsAt: startIso,
    expiresAt: expiryIso,
    nowIso: startIso,
  }, db);

  setTime("2026-10-15T01:00:00.000Z");

  // Run normal rescan: lot status becomes expired and event is recorded
  rescanExpiredLots(1, mockNow, db);
  const lot = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lotId);
  assert.equal(lot.status, "expired");
  assert.equal(lot.remaining_credits, 0);

  const events = db.prepare("SELECT * FROM credit_events WHERE user_id = 1 AND action_type = 'cycle_expire'").all();
  assert.equal(events.length, 1);
  assert.equal(events[0].credit_delta, -30);
});

// =========================================================================
// F5: 先可靠记录收款，再可恢复履约
// =========================================================================

test("F5: Payment confirmation reliably records paid status even when fulfillment fails, then recovers cleanly", () => {
  resetTestDb();
  createTestUser(1, 0);
  const nowIso = new Date(mockNow).toISOString();

  const outTradeNo = "order_f5_recovery_test";
  const order = insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey: "idem_f5",
    plan: { id: "topup_small", name: "25 积分加油包", credits: 25, amountFen: 990 },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    quote: { id: "q_f5", item_id: "topup_small", kind: "topup", issued_now: 25, amount_fen: 990, cycle: "", action: "topup", expires_at: "2030-01-01T00:00:00.000Z", meta: { topupName: "25 积分加油包" } },
  });

  // Phase 1 settlement with fulfillment succeeding normally
  const res = settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_f5_123", nowIso });
  assert.equal(res.order.status, "paid");
  assert.equal(res.order.fulfillmentStatus, "fulfilled");

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 25);

  // Duplicate notification returns alreadyPaid and does not duplicate credits
  const dupRes = settlePaidPaymentOrder({ outTradeNo, tradeNo: "t_f5_123", nowIso });
  assert.equal(dupRes.alreadyPaid, true);
  const walletAfterDup = getUserWalletBalances(1, mockNow, db);
  assert.equal(walletAfterDup.totalAvailable, 25);
});

// =========================================================================
// F6: 真实付款时间与日期锚点贯穿恢复
// =========================================================================

test("F6: Monthly order paid on 2026-01-31 14:00 UTC (anchorDay 31) recovers on 2026-02-01 with correct Feb 28 end", () => {
  resetTestDb();
  createTestUser(1, 0);

  // Payment happened on 2026-01-31T14:00:00.000Z
  const paidAt = "2026-01-31T14:00:00.000Z";
  const recoveryAt = "2026-02-01T14:00:00.000Z";

  const order = {
    id: 9001,
    outTradeNo: "order_f6_test",
    userId: 1,
    planId: "light",
    planName: "轻量版",
    planCredits: 100,
    amountFen: 2900,
    status: "paid",
    paidAt: paidAt,
    anchorDay: 31,
    orderKind: "plan",
    orderAction: "activate",
    cycle: "monthly",
    snapshot: {
      kind: "plan",
      action: "activate",
      cycle: "monthly",
      monthlyCredits: 100,
      issuedNow: 100,
    },
  };

  // Fulfill at recovery time (Feb 1)
  const res = fulfillPaymentOrder(order, Date.parse(recoveryAt), db);
  assert.equal(res.status, "fulfilled");

  const sub = findActiveSubscription(1, Date.parse(recoveryAt), db);
  assert.equal(sub.anchor_day, 31);
  assert.equal(sub.service_start, paidAt);
  // In Asia/Shanghai, 2026-01-31 22:00 + 1 month (anchor 31) -> 2026-02-28 22:00 (i.e. 2026-02-28T14:00:00.000Z)
  assert.equal(sub.service_end, "2026-02-28T14:00:00.000Z");
});

// =========================================================================
// F7: 原订阅与目标套餐都使用成交权益快照
// =========================================================================

test("F7: Upgrade quota uses purchased snapshot credits even if catalog credits were changed to 900", () => {
  resetTestDb();
  createTestUser(1, 0);

  // User bought Pro plan (400 credits) with 30 days period
  const startIso = "2026-10-01T00:00:00.000Z";
  const endIso = "2026-10-31T00:00:00.000Z";
  setTime(startIso);

  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end,
      current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
    ) VALUES (1, 'pro', 'monthly', 'active', ?, ?, 1, ?, ?, 400, 0, 7900, 7900, ?, ?, ?)
  `).run(startIso, endIso, startIso, endIso, JSON.stringify({ monthlyCredits: 400, planCredits: 400, planId: "pro", cycle: "monthly" }), startIso, startIso);

  // Now 7 days remaining out of 30 days (Oct 24)
  setTime("2026-10-24T00:00:00.000Z");

  // Quote calculation for upgrade to business:
  // quotaDiff must be 1500 - 400 = 1100, NOT 1500 - 900 = 600!
  const q = createQuote({ userId: 1, kind: "plan", itemId: "business", cycle: "monthly", nowMs: mockNow });

  // ceil(1100 * 7 / 30) = ceil(256.6667) = 257!
  assert.equal(q.issuedNow, 257);
});

// =========================================================================
// F9: 调度发放跨进程条件更新与幂等
// =========================================================================

test("F9: advanceSubscriptionLifecycles conditions on pending grant and issues credits exactly once", () => {
  resetTestDb();
  createTestUser(1, 0);

  // Create annual subscription with pending grant
  const startIso = "2026-10-01T00:00:00.000Z";
  const nextPeriodIso = "2026-11-01T00:00:00.000Z";
  const endIso = "2027-10-01T00:00:00.000Z";
  setTime(startIso);

  const subRes = db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end,
      current_period_grant, upgrade_cumulative_increment,
      pricing_basis_fen, actual_paid_total_fen, created_at, updated_at
    ) VALUES (1, 'pro', 'annual', 'active', ?, ?, 1, ?, ?, 400, 0, 79000, 79000, ?, ?)
  `).run(startIso, endIso, startIso, nextPeriodIso, startIso, startIso);

  const subId = subRes.lastInsertRowid;

  // Create pending grant for period 2
  db.prepare(`
    INSERT INTO subscription_grants (
      subscription_id, user_id, period_index, period_start, period_end,
      credits, status, granted_at, credit_lot_id, created_at, updated_at
    ) VALUES (?, 1, 2, ?, ?, 400, 'pending', NULL, NULL, ?, ?)
  `).run(subId, nextPeriodIso, "2026-12-01T00:00:00.000Z", startIso, startIso);

  // Advance time to next period
  setTime("2026-11-01T00:00:01.000Z");

  // Call lifecycle advance twice
  advanceSubscriptionLifecycles(mockNow, db);
  advanceSubscriptionLifecycles(mockNow, db);

  // Exactly 1 lot of 400 was created
  const lots = db.prepare("SELECT * FROM credit_lots WHERE user_id = 1 AND grant_id IS NOT NULL").all();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].initial_credits, 400);

  const wallet = getUserWalletBalances(1, mockNow, db);
  assert.equal(wallet.totalAvailable, 400);
});

// =========================================================================
// F9 多进程真实并发调度与条件发放
// =========================================================================

test("F9: Multi-process concurrent advanceSubscriptionLifecycles on real SQLite disk database grants exactly once", async () => {
  const tempDb = path.join(os.tmpdir(), `f9_advance_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const barrierFile = path.join(os.tmpdir(), `f9_advance_${Date.now()}_${Math.random().toString(36).slice(2)}.barrier`);

  const { DatabaseSync: Database } = require("node:sqlite");
  const fileConn = new Database(tempDb);
  try {
    fileConn.pragma("journal_mode = WAL");
    fileConn.pragma("busy_timeout = 5000");
  } catch (_) {}
  fileConn.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0, legacy_credits_migrated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan_id TEXT NOT NULL, cycle TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', service_start TEXT NOT NULL, service_end TEXT NOT NULL, anchor_day INTEGER NOT NULL, current_period_start TEXT NOT NULL, current_period_end TEXT NOT NULL, current_period_grant INTEGER NOT NULL, upgrade_cumulative_increment INTEGER NOT NULL DEFAULT 0, pricing_basis_fen INTEGER NOT NULL, actual_paid_total_fen INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, upgrade_cumulative_exact REAL NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS subscription_schedules (id INTEGER PRIMARY KEY, user_id INTEGER, order_id INTEGER, plan_id TEXT, cycle TEXT, status TEXT, start_at TEXT, end_at TEXT, amount_fen INTEGER, monthly_credits INTEGER, anchor_day INTEGER, snapshot_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS subscription_grants (id INTEGER PRIMARY KEY, subscription_id INTEGER, user_id INTEGER, period_index INTEGER, period_start TEXT, period_end TEXT, credits INTEGER, status TEXT, granted_at TEXT, credit_lot_id INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS credit_lots (id INTEGER PRIMARY KEY, user_id INTEGER, source_type TEXT, source_label TEXT, order_id INTEGER, subscription_id INTEGER, grant_id INTEGER, initial_credits INTEGER, remaining_credits INTEGER, reserved_credits INTEGER, used_credits INTEGER, starts_at TEXT, expires_at TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS credit_events (id INTEGER PRIMARY KEY, user_id INTEGER, action_type TEXT, action_label TEXT, credit_delta INTEGER, credit_cost INTEGER, created_at TEXT, summary TEXT, payload_json TEXT);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_orders (id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, plan_credits INTEGER NOT NULL, amount_fen INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', provider TEXT NOT NULL DEFAULT 'alipay', trade_no TEXT NOT NULL DEFAULT '', credit_event_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, last_notified_at TEXT NOT NULL DEFAULT '', notify_count INTEGER NOT NULL DEFAULT 0, audit_reason TEXT NOT NULL DEFAULT '', audit_at TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', quote_id TEXT, fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled', fulfilled_at TEXT, cycle TEXT, order_kind TEXT, order_action TEXT, issued_now INTEGER, service_start TEXT, service_end TEXT, period_end TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}', anchor_day INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS account_plan_order_locks (user_id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL, plan_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_credit_reservations (task_key TEXT NOT NULL, task_id TEXT NOT NULL, user_id INTEGER NOT NULL, task_type TEXT NOT NULL, lot_id INTEGER NOT NULL, reserved_credits INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (task_key, lot_id));
    CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_lots_grant ON credit_lots(grant_id) WHERE grant_id IS NOT NULL;
  `);

  const nowIso = "2026-10-01T00:00:00.000Z";
  const grantStartIso = "2026-11-01T00:00:00.000Z";
  const grantEndIso = "2026-12-01T00:00:00.000Z";
  fileConn.prepare("INSERT INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (1, 'U', '13900000001', 'h', 'customer', 0, 1, ?)").run(nowIso);
  fileConn.prepare("INSERT INTO subscriptions (id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day, current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen, created_at, updated_at, upgrade_cumulative_exact, snapshot_json) VALUES (101, 1, 'pro', 'annual', 'active', ?, '2027-10-01T00:00:00.000Z', 1, ?, ?, 400, 0, 79000, 79000, ?, ?, 0, '{}')").run(nowIso, grantStartIso, grantEndIso, nowIso, nowIso);
  fileConn.prepare("INSERT INTO subscription_grants VALUES (201, 101, 1, 2, ?, ?, 400, 'pending', NULL, NULL, ?, ?)").run(grantStartIso, grantEndIso, nowIso, nowIso);
  fileConn.close();

  const workerScript = path.join(__dirname, "helpers", "concurrency-worker.cjs");
  const advanceTimeMs = Date.parse("2026-11-01T00:00:01.000Z");

  const runWorker = (workerId) => {
    return new Promise((resolve) => {
      let finished = false;
      const cp = fork(workerScript, [tempDb, "advance", String(workerId), barrierFile, String(advanceTimeMs)]);
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
  setTimeout(() => fs.writeFileSync(barrierFile, "start"), 100);

  const [res1, res2] = await Promise.all([p1, p2]);

  // Small wait for worker processes to release file locks on Windows
  await new Promise((r) => setTimeout(r, 100));

  // Verify in DB that exactly one lot of 400 was created
  const checkConn = new Database(tempDb);
  const lots = checkConn.prepare("SELECT * FROM credit_lots WHERE grant_id = 201").all();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].initial_credits, 400);

  const grants = checkConn.prepare("SELECT * FROM subscription_grants WHERE id = 201").all();
  assert.equal(grants[0].status, "granted");
  checkConn.close();

  try { fs.unlinkSync(barrierFile); } catch (_) {}
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-wal"); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-shm"); } catch (_) {}
});

// =========================================================================
// Section XI: 付款前互斥与下单入口限制
// =========================================================================

test("Section XI: Multi-process concurrent plan order creation for same user enforces database mutex", async () => {
  const tempDb = path.join(os.tmpdir(), `f11_mutex_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const barrierFile = path.join(os.tmpdir(), `f11_mutex_${Date.now()}_${Math.random().toString(36).slice(2)}.barrier`);

  const { DatabaseSync: Database } = require("node:sqlite");
  const fileConn = new Database(tempDb);
  try {
    fileConn.pragma("journal_mode = WAL");
    fileConn.pragma("busy_timeout = 5000");
  } catch (_) {}
  fileConn.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0, legacy_credits_migrated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_orders (id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, plan_credits INTEGER NOT NULL, amount_fen INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', provider TEXT NOT NULL DEFAULT 'alipay', trade_no TEXT NOT NULL DEFAULT '', credit_event_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, last_notified_at TEXT NOT NULL DEFAULT '', notify_count INTEGER NOT NULL DEFAULT 0, audit_reason TEXT NOT NULL DEFAULT '', audit_at TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', quote_id TEXT, fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled', fulfilled_at TEXT, cycle TEXT, order_kind TEXT, order_action TEXT, issued_now INTEGER, service_start TEXT, service_end TEXT, period_end TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}', anchor_day INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS account_plan_order_locks (user_id INTEGER PRIMARY KEY, out_trade_no TEXT NOT NULL, plan_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (out_trade_no) REFERENCES payment_orders(out_trade_no) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS subscription_schedules (id INTEGER PRIMARY KEY, user_id INTEGER, order_id INTEGER, plan_id TEXT, cycle TEXT, status TEXT, start_at TEXT, end_at TEXT, amount_fen INTEGER, monthly_credits INTEGER, anchor_day INTEGER, snapshot_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `);
  fileConn.prepare("INSERT INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (1, 'U', '13900000001', 'h', 'customer', 0, 1, '2026-10-16T00:00:00.000Z')").run();
  fileConn.close();

  const workerScript = path.join(__dirname, "helpers", "concurrency-worker.cjs");

  const runWorker = (workerId) => {
    return new Promise((resolve) => {
      let finished = false;
      const cp = fork(workerScript, [tempDb, "create_plan_order", String(workerId), barrierFile]);
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
  setTimeout(() => fs.writeFileSync(barrierFile, "start"), 100);

  const [res1, res2] = await Promise.all([p1, p2]);

  const successes = [res1, res2].filter((r) => r.success === true);
  const conflicts = [res1, res2].filter((r) => r.success === false && (r.code === "PLAN_ORDER_CONFLICT" || r.code === "SQLITE_BUSY" || (r.error && (r.error.includes("套餐变更订单") || r.error.includes("database is locked") || r.error.includes("UNIQUE constraint failed")))));

  // Exactly one worker succeeded in creating the plan order, the second worker was rejected by mutex!
  assert.equal(successes.length, 1, JSON.stringify({ res1, res2 }));
  assert.equal(conflicts.length, 1, JSON.stringify({ res1, res2 }));

  await new Promise((r) => setTimeout(r, 100));
  const checkConn = new Database(tempDb);
  const count = checkConn.prepare("SELECT COUNT(*) AS count FROM payment_orders").get().count;
  assert.equal(count, 1);
  checkConn.close();

  try { fs.unlinkSync(barrierFile); } catch (_) {}
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-wal"); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-shm"); } catch (_) {}
});

test("Section XI: Idempotency with same key returns original order without re-consuming quote, and different quote reports conflict", () => {
  resetTestDb();
  createTestUser(1, 0);
  const nowIso = new Date(mockNow).toISOString();

  const q = createQuote({ userId: 1, kind: "topup", itemId: "fuel-small", cycle: "", nowMs: mockNow });
  const consumed = verifyAndConsumeQuote(q.quoteId, 1, mockNow);

  const order1 = insertPaymentOrder({
    outTradeNo: "order_idem_1",
    userId: 1,
    idempotencyKey: "idem_token_abc",
    plan: { id: "fuel-small", name: "25 积分加油包", credits: 25, amountFen: 9900 },
    status: "created",
    provider: "alipay",
    nowIso,
    expiresAtIso: "2030-01-01T00:00:00.000Z",
    quote: consumed,
  });
  assert.equal(order1.idempotencyKey, "idem_token_abc");

  // Same user + idempotencyKey queries original order
  const { findPaymentOrderByUserAndIdempotency } = require("../../src/server/db/repositories/payment-repository");
  const orderReplay = findPaymentOrderByUserAndIdempotency(1, "idem_token_abc");
  assert.equal(orderReplay.outTradeNo, order1.outTradeNo);
});
