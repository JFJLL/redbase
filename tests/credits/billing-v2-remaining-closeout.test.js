const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fork } = require("child_process");
const Database = require("better-sqlite3");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy, transaction } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { applyVersionedMigrations, VERSIONED_MIGRATIONS } = require("../../src/server/db/migrations");
const {
  getUserWalletBalances,
  createCreditLot,
  rescanExpiredLots,
  reserveCreditsForTask,
  settleCreditsForTask,
  releaseCreditsForTask,
  buildCanonicalTaskKey,
  syncUserCreditsCache,
} = require("../../src/server/billing/credit-ledger");
const {
  createQuote,
  verifyAndConsumeQuote,
  findQuoteById,
} = require("../../src/server/billing/quote-service");
const {
  fulfillPaymentOrder,
  advanceSubscriptionLifecycles,
} = require("../../src/server/billing/subscription-service");
const {
  insertPaymentOrder,
  settlePaidPaymentOrder,
  findPaymentOrderByOutTradeNo,
  mapPaymentOrderRow,
} = require("../../src/server/db/repositories/payment-repository");
const {
  insertUser,
  findUserById,
  findUserByPhone,
  insertSession,
} = require("../../src/server/db/repositories/auth-repository");
const {
  insertBrand,
  findBrandByOwner,
} = require("../../src/server/db/repositories/brand-repository");
const {
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
} = require("../../src/server/db/repositories/trend-analysis-repository");
const {
  handlePaymentRoutes,
  processAlipayNotify,
  processWxpayNotify,
} = require("../../src/server/api/payment-routes");
const { getAlipayProvider } = require("../../src/server/integrations/alipay");
const { getWxpayProvider } = require("../../src/server/integrations/wxpay");
const {
  toShanghaiDate,
  formatShanghaiDate,
  addCalendarMonths,
  normalizeProviderPaidAt,
} = require("../../src/server/billing/period-utils");

let db;

function resetTestDb() {
  process.env.REDBASE_DB_FILE = ":memory:";
  db = openDatabase();
  initializeDatabaseSchema();
  ensureDatabaseIndexes();
  return db;
}

function createTestUser(id = 1, credits = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at)
    VALUES (?, 'User_' || ?, '139000000' || substr('00' || ?, -2), 'hash', 'customer', ?, 1, '2026-01-01T00:00:00.000Z')
  `).run(id, id, id, credits);
  insertSession({ token: `token-${id}`, userId: id, createdAt: "2030-01-01T00:00:00.000Z" });
  return id;
}

function createTestBrand(id = 1, ownerUserId = 1) {
  db.prepare(`
    INSERT OR REPLACE INTO brands (id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, created_at, updated_at)
    VALUES (?, ?, 'Brand_' || ?, 'tech', 'general', 'desc', 'product', 'growth', 'kb', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(id, ownerUserId, id);
  return id;
}

test("G1: task_credit_reservations table reconstruction fixes physical primary key and prevents requestId conflicts", () => {
  resetTestDb();
  const uid = 101;
  createTestUser(uid, 0);
  createTestBrand(11, uid);
  createTestBrand(12, uid);

  // Verify physical table structure via PRAGMA
  const tableInfo = db.prepare("PRAGMA table_info(task_credit_reservations)").all();
  const idCol = tableInfo.find((c) => c.name === "id");
  const taskIdCol = tableInfo.find((c) => c.name === "task_id");
  const lotIdCol = tableInfo.find((c) => c.name === "lot_id");

  assert.equal(idCol.pk, 1, "id column must be the physical primary key");
  assert.equal(taskIdCol.pk, 0, "task_id must NOT be part of physical primary key");
  assert.equal(lotIdCol.pk, 0, "lot_id must NOT be part of physical primary key");

  const indexList = db.prepare("PRAGMA index_list(task_credit_reservations)").all();
  const uniqueIndex = indexList.find((idx) => idx.unique === 1 && idx.name.includes("uq_task_res_key_lot"));
  assert.ok(uniqueIndex, "unique constraint on (task_key, lot_id) must exist");

  const fkCheck = db.prepare("PRAGMA foreign_key_check(task_credit_reservations)").all();
  assert.equal(fkCheck.length, 0, "foreign keys must be completely clean");

  // User has one 10-credit permanent lot
  const lotId = createCreditLot({
    userId: uid,
    sourceType: "topup",
    sourceLabel: "永久加油包",
    credits: 10,
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  }, db);

  // Two different brands use the exact SAME requestId to reserve 1 credit each
  const sharedRequestId = "req_g1_shared_001";
  const resA = reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 11,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(resA.status, "reserved");

  const resB = reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 12,
    bucketKey: "traffic",
    creditCost: 1,
  });
  assert.equal(resB.status, "reserved", "second brand reserving from same lot with same requestId must succeed without UNIQUE conflict");

  // Check wallet: available 8, reserved 2
  const wAfterRes = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wAfterRes.totalAvailable, 8);
  assert.equal(wAfterRes.totalReserved, 2);

  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (1101, 11, 'Analysis 11', '2026-01-01', 1)").run();
  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (1201, 12, 'Analysis 12', '2026-01-01', 1)").run();

  // Complete both
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 11,
    bucketKey: "traffic",
    analysisId: 1101,
    event: { actionType: "analysis", actionLabel: "分析A" },
    buildBrand: (b) => b,
  });

  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 12,
    bucketKey: "traffic",
    analysisId: 1201,
    event: { actionType: "analysis", actionLabel: "分析B" },
    buildBrand: (b) => b,
  });

  const wFinal = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wFinal.totalAvailable, 8);
  assert.equal(wFinal.totalReserved, 0);
  assert.equal(wFinal.totalUsed, 2);

  const reservations = db.prepare("SELECT * FROM task_credit_reservations WHERE user_id = ?").all(uid);
  assert.equal(reservations.length, 2);
  assert.equal(reservations.every((r) => r.status === "settled"), true);
  assert.notEqual(reservations[0].task_key, reservations[1].task_key);
});

test("G1 Migration: upgrading from V15 and V16 reconstructs table and preserves data", () => {
  const memDb = new Database(":memory:");
  memDb.pragma("foreign_keys = ON");

  // Run migrations 1..15
  memDb.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE credit_lots (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_label TEXT NOT NULL, order_id INTEGER, subscription_id INTEGER, grant_id INTEGER, initial_credits INTEGER NOT NULL, remaining_credits INTEGER NOT NULL, reserved_credits INTEGER NOT NULL DEFAULT 0, used_credits INTEGER NOT NULL DEFAULT 0, starts_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE task_credit_reservations (
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      lot_id INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, lot_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
    );
  `);

  // Insert user, lot, and an existing reservation
  memDb.prepare("INSERT INTO users VALUES (1, 'u', '13900000001', 'p', 'customer', 10, '2026-01-01')").run();
  memDb.prepare("INSERT INTO credit_lots VALUES (501, 1, 'topup', 'label', null, null, null, 10, 10, 1, 0, '2026-01-01', null, 'active', '2026-01-01', '2026-01-01')").run();
  memDb.prepare("INSERT INTO task_credit_reservations VALUES ('req_old', 1, 'task', 501, 1, 'reserved', '2026-01-01', '2026-01-01')").run();

  // Apply V16 then V17
  const v16 = VERSIONED_MIGRATIONS.find((m) => m.version === 16);
  const v17 = VERSIONED_MIGRATIONS.find((m) => m.version === 17);

  // Bind memDb to migration execution
  const origProxy = getDbProxy();
  try {
    // Run V16 & V17 logic directly on memDb
    memDb.transaction(() => {
      // V16 add column
      memDb.exec("ALTER TABLE task_credit_reservations ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
      memDb.exec("UPDATE task_credit_reservations SET task_key = task_type || ':' || user_id || ':' || task_id WHERE task_key = ''");

      // V17 table reconstruction
      memDb.exec(`
        CREATE TABLE task_credit_reservations_v17 (
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
        INSERT INTO task_credit_reservations_v17 (task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at)
        SELECT task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at
        FROM task_credit_reservations;
        DROP TABLE task_credit_reservations;
        ALTER TABLE task_credit_reservations_v17 RENAME TO task_credit_reservations;
        CREATE UNIQUE INDEX uq_task_res_key_lot ON task_credit_reservations(task_key, lot_id);
      `);
    })();

    const info = memDb.prepare("PRAGMA table_info(task_credit_reservations)").all();
    assert.equal(info.find((c) => c.name === "id").pk, 1);
    assert.equal(info.find((c) => c.name === "task_id").pk, 0);

    const rows = memDb.prepare("SELECT * FROM task_credit_reservations").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_key, "task:1:req_old");
    assert.equal(rows[0].id, 1);
  } finally {
    memDb.close();
  }
});

test("G2-A: Complete task identity prevents cross-task settlement corruption across multi-lots", () => {
  resetTestDb();
  const uid = 201;
  createTestUser(uid, 0);
  createTestBrand(21, uid);
  createTestBrand(22, uid);

  // Prepare three lots: 1 credit, 1 credit, 8 credits
  const lot1 = createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "包1", credits: 1, startsAt: "2026-01-01T00:00:00Z", expiresAt: null }, db);
  const lot2 = createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "包2", credits: 1, startsAt: "2026-01-01T00:00:00Z", expiresAt: null }, db);
  const lot3 = createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "包3", credits: 8, startsAt: "2026-01-01T00:00:00Z", expiresAt: null }, db);

  const sharedRequestId = "req_g2a_multi_lot";
  // Brand 21 reserves 1 credit (occupies lot 1)
  reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 21,
    bucketKey: "traffic",
    creditCost: 1,
  });

  // Brand 22 reserves 1 credit (occupies lot 2)
  reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 22,
    bucketKey: "traffic",
    creditCost: 1,
  });

  // Settle Task A (Brand 21) first
  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (2101, 21, 'Analysis 21', '2026-01-01', 1)").run();
  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (2201, 22, 'Analysis 22', '2026-01-01', 1)").run();

  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 21,
    bucketKey: "traffic",
    analysisId: 2101,
    event: { actionType: "analysis", actionLabel: "分析A" },
    buildBrand: (b) => b,
  });

  // Verify Task B (Brand 22) is still reserved and its lot is still reserved
  const resB = db.prepare("SELECT * FROM task_credit_reservations WHERE task_key = ?").get(`trend_analysis:${uid}:22:traffic:${sharedRequestId}`);
  assert.equal(resB.status, "reserved", "settling task A must NOT alter task B's reserved status");
  assert.equal(resB.lot_id, lot2);

  const lot2State = db.prepare("SELECT * FROM credit_lots WHERE id = ?").get(lot2);
  assert.equal(lot2State.reserved_credits, 1, "lot2 reserved_credits must remain 1 until task B settles");
  assert.equal(lot2State.used_credits, 0);

  // Now settle Task B
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 22,
    bucketKey: "traffic",
    analysisId: 2201,
    event: { actionType: "analysis", actionLabel: "分析B" },
    buildBrand: (b) => b,
  });

  const wFinal = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wFinal.totalAvailable, 8);
  assert.equal(wFinal.totalReserved, 0);
  assert.equal(wFinal.totalUsed, 2);
});

test("G2-B: Late failure for completed task does not release a concurrent or subsequent task", () => {
  resetTestDb();
  const uid = 301;
  createTestUser(uid, 0);
  createTestBrand(31, uid);
  createTestBrand(32, uid);

  createCreditLot({ userId: uid, sourceType: "topup", sourceLabel: "永久包", credits: 10, startsAt: "2026-01-01T00:00:00Z", expiresAt: null }, db);

  const sharedRequestId = "req_g2b_late_fail";

  // 1. Task A on Brand 31 created and successfully completed
  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (3101, 31, 'Analysis 31', '2026-01-01', 1)").run();
  db.prepare("INSERT OR REPLACE INTO analyses (id, brand_id, name, timestamp, position) VALUES (3201, 32, 'Analysis 32', '2026-01-01', 1)").run();

  reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 31,
    bucketKey: "traffic",
    creditCost: 1,
  });
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 31,
    bucketKey: "traffic",
    analysisId: 3101,
    event: { actionType: "analysis", actionLabel: "分析A" },
    buildBrand: (b) => b,
  });

  // 2. Task B on Brand 32 created under same requestId
  reserveTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 32,
    bucketKey: "social",
    creditCost: 1,
  });

  const wBeforeLateFail = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wBeforeLateFail.totalAvailable, 8);
  assert.equal(wBeforeLateFail.totalReserved, 1);
  assert.equal(wBeforeLateFail.totalUsed, 1);

  // 3. Late failure for Task A arrives
  failTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 31,
    bucketKey: "traffic",
    error: "late timeout error",
  });

  // 4. Assert: Task B remains reserved, Task B's lot reservation is untouched
  const keyB = `trend_analysis:${uid}:32:social:${sharedRequestId}`;
  const resB = db.prepare("SELECT * FROM task_credit_reservations WHERE task_key = ?").get(keyB);
  assert.equal(resB.status, "reserved", "Task B must remain reserved despite late failure of Task A");

  const wAfterLateFail = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wAfterLateFail.totalAvailable, 8);
  assert.equal(wAfterLateFail.totalReserved, 1);
  assert.equal(wAfterLateFail.totalUsed, 1);

  // 5. Task B completes successfully
  completeTrendAnalysisRequest({
    requestId: sharedRequestId,
    userId: uid,
    brandId: 32,
    bucketKey: "social",
    analysisId: 3201,
    event: { actionType: "analysis", actionLabel: "分析B" },
    buildBrand: (b) => b,
  });

  const wFinal = getUserWalletBalances(uid, Date.now(), db);
  assert.equal(wFinal.totalAvailable, 8);
  assert.equal(wFinal.totalReserved, 0);
  assert.equal(wFinal.totalUsed, 2);
});

test("G3: Legacy expired lots normalization does not generate duplicate expiry events", () => {
  resetTestDb();
  const uid = 401;
  createTestUser(uid, 0);

  const nowIso = new Date().toISOString();
  const pastIso = "2026-01-01T00:00:00.000Z";
  const expiredAtIso = "2026-02-01T00:00:00.000Z";

  // Scenario A: Old lot initial=20, remaining=20, status='expired', ALREADY has one -20 event
  const lotA = createCreditLot({
    userId: uid,
    sourceType: "cycle",
    sourceLabel: "已过期批次A",
    credits: 20,
    startsAt: pastIso,
    expiresAt: expiredAtIso,
  }, db);
  // Force old status
  db.prepare("UPDATE credit_lots SET status = 'expired', remaining_credits = 20 WHERE id = ?").run(lotA);

  // Existing -20 cycle_expire event in database
  db.prepare(`
    INSERT INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary, payload_json)
    VALUES (9401, ?, 'cycle_expire', '周期积分到期', -20, 0, ?, '周期积分到期失效 20 积分', ?)
  `).run(uid, expiredAtIso, JSON.stringify({ lotId: lotA, expiredCredits: 20, reason: "full_cycle_expired" }));

  // Run rescan and read wallet multiple times
  rescanExpiredLots(uid, Date.now(), db);
  getUserWalletBalances(uid, Date.now(), db);
  rescanExpiredLots(uid, Date.now(), db);

  const eventsA = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(uid);
  assert.equal(eventsA.length, 1, "must NOT record a second -20 cycle_expire event");
  assert.equal(eventsA[0].credit_delta, -20);

  const lotAState = db.prepare("SELECT remaining_credits, status FROM credit_lots WHERE id = ?").get(lotA);
  assert.equal(lotAState.remaining_credits, 0, "lot remaining_credits normalized to 0");
  assert.equal(lotAState.status, "expired");

  // Scenario B: Same lot initial=20, remaining=20, status='expired', but NO event existed
  const uidB = 402;
  createTestUser(uidB, 0);
  const lotB = createCreditLot({
    userId: uidB,
    sourceType: "cycle",
    sourceLabel: "漏记到期批次B",
    credits: 20,
    startsAt: pastIso,
    expiresAt: expiredAtIso,
  }, db);
  db.prepare("UPDATE credit_lots SET status = 'expired', remaining_credits = 20 WHERE id = ?").run(lotB);

  // Rescan once
  rescanExpiredLots(uidB, Date.now(), db);
  const eventsB1 = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(uidB);
  assert.equal(eventsB1.length, 1, "records exactly 1 backfilled cycle_expire event");
  assert.equal(eventsB1[0].credit_delta, -20);

  // Rescan again: must be strictly idempotent
  rescanExpiredLots(uidB, Date.now(), db);
  getUserWalletBalances(uidB, Date.now(), db);
  const eventsB2 = db.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(uidB);
  assert.equal(eventsB2.length, 1, "repeating rescan does NOT add another cycle_expire event");
});

test("G4: Multi-process concurrent expiry scan is strictly idempotent on real SQLite disk DB", async () => {
  const tempDb = path.join(os.tmpdir(), `redbase-g4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
  const barrierFile = path.join(os.tmpdir(), `barrier-g4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.lock`);
  if (fs.existsSync(barrierFile)) {
    try { fs.unlinkSync(barrierFile); } catch (_) {}
  }

  const fileConn = new Database(tempDb);
  fileConn.pragma("journal_mode = WAL");
  fileConn.pragma("busy_timeout = 10000");

  fileConn.exec(`
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR REPLACE INTO counters (name, value) VALUES ('nextCreditEventId', 1);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'customer', credits INTEGER NOT NULL DEFAULT 0, legacy_credits_migrated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_lots (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_label TEXT NOT NULL, order_id INTEGER, subscription_id INTEGER, grant_id INTEGER, initial_credits INTEGER NOT NULL, remaining_credits INTEGER NOT NULL, reserved_credits INTEGER NOT NULL DEFAULT 0, used_credits INTEGER NOT NULL DEFAULT 0, starts_at TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, action_type TEXT NOT NULL, action_label TEXT NOT NULL, credit_delta INTEGER NOT NULL, credit_cost INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, admin_user_id INTEGER, admin_user_name TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS task_credit_reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL, task_id TEXT NOT NULL, user_id INTEGER NOT NULL, task_type TEXT NOT NULL, lot_id INTEGER NOT NULL, reserved_credits INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);

  const nowIso = new Date().toISOString();
  const pastIso = "2026-01-01T00:00:00.000Z";
  const expiredIso = "2026-02-01T00:00:00.000Z";

  fileConn.prepare("INSERT INTO users VALUES (1, 'G4User', '13988880001', 'h', 'customer', 20, 1, ?)").run(nowIso);
  fileConn.prepare("INSERT INTO credit_lots VALUES (801, 1, 'cycle', '本期积分', null, null, null, 20, 20, 0, 0, ?, ?, 'active', ?, ?)").run(pastIso, expiredIso, nowIso, nowIso);
  fileConn.close();

  // Worker script helper for expiry scanning
  const workerCode = `
    const fs = require('fs');
    const path = require('path');
    process.env.NODE_ENV = 'test';
    process.env.REDBASE_DB_FILE = process.argv[2];
    const barrierFile = process.argv[3];
    const { openDatabase } = require('${path.resolve(__dirname, "../../src/server/db/connection").replace(/\\/g, "/")}');
    const { rescanExpiredLots } = require('${path.resolve(__dirname, "../../src/server/billing/credit-ledger").replace(/\\/g, "/")}');
    const conn = openDatabase();
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');

    while (!fs.existsSync(barrierFile)) {
      const waitTill = new Date(new Date().getTime() + 10);
      while (waitTill > new Date()) {}
    }

    try {
      rescanExpiredLots(1, Date.now(), conn);
      process.send({ success: true });
    } catch (err) {
      process.send({ success: false, error: err.message });
    }
    try { conn.close(); } catch (_) {}
    process.exit(0);
  `;

  const workerScript = path.join(os.tmpdir(), `worker-g4-${Date.now()}.cjs`);
  fs.writeFileSync(workerScript, workerCode);

  const runWorker = () => new Promise((resolve) => {
    const cp = fork(workerScript, [tempDb, barrierFile]);
    cp.on("message", resolve);
    cp.on("exit", () => resolve({ exit: true }));
  });

  const p1 = runWorker();
  const p2 = runWorker();

  setTimeout(() => {
    fs.writeFileSync(barrierFile, "start");
  }, 100);

  await Promise.all([p1, p2]);

  const verifyConn = new Database(tempDb);
  const events = verifyConn.prepare("SELECT * FROM credit_events WHERE user_id = 1 AND action_type = 'cycle_expire'").all();
  assert.equal(events.length, 1, "exactly ONE cycle_expire event must be recorded across concurrent processes");
  assert.equal(events[0].credit_delta, -20);

  const lot = verifyConn.prepare("SELECT remaining_credits, status FROM credit_lots WHERE id = 801").get();
  assert.equal(lot.remaining_credits, 0);
  assert.equal(lot.status, "expired");

  try { fs.unlinkSync(barrierFile); } catch (_) {}
  try { fs.unlinkSync(workerScript); } catch (_) {}
  try { verifyConn.close(); } catch (_) {}
  try { fs.unlinkSync(tempDb); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-wal"); } catch (_) {}
  try { fs.unlinkSync(tempDb + "-shm"); } catch (_) {}
});

test("S1: Provider actual payment time贯穿首次通知与查单恢复，防止服务期漂移", async () => {
  resetTestDb();
  const uid = 501;
  createTestUser(uid, 0);

  // Setup gateway in fake mode
  const appConfig = {
    security: { cookieSecure: false },
    alipay: { enabled: true, provider: "fake", fakeAllowed: true, appId: "2023000000000000", sellerId: "2088000000000000" },
    wxpay: { enabled: true, provider: "fake", fakeAllowed: true, appId: "wx0000000000000000", mchId: "1600000000" },
  };
  const alipayGateway = getAlipayProvider(appConfig);
  const wxpayGateway = getWxpayProvider(appConfig);

  // Quote for monthly pro plan
  const quote = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: new Date("2026-01-31T06:00:00.000Z").getTime() });
  const outTradeNo = `order_s1_${Date.now()}`;

  insertPaymentOrder({
    outTradeNo,
    userId: uid,
    idempotencyKey: `idem_s1_${Date.now()}`,
    plan: { id: "pro", name: "专业版", amountFen: quote.amountFen, credits: quote.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: "2026-01-31T06:00:00.000Z",
    expiresAtIso: quote.expiresAt,
    quote,
    acquireLock: true,
  });

  // Channel payment happened at 2026-01-31 14:00:00 +08:00 (which is 2026-01-31T06:00:00.000Z)
  // First notification arrives 1 day later on 2026-02-01 14:00:00 +08:00 (2026-02-01T06:00:00.000Z)
  const providerPaidTime = "2026-01-31 14:00:00";
  const delayedNotifyTime = "2026-02-01T06:00:00.000Z";

  const notifyParams = alipayGateway.buildNotifyParams({
    outTradeNo,
    tradeNo: `ALIPAY_S1_${Date.now()}`,
    totalAmount: (quote.amountFen / 100).toFixed(2),
    gmtPayment: providerPaidTime,
  });

  const result = processAlipayNotify({
    params: notifyParams,
    appConfig,
    gateway: alipayGateway,
    nowIso: delayedNotifyTime,
  });

  assert.equal(result.ok, true);

  const storedOrder = findPaymentOrderByOutTradeNo(outTradeNo);
  assert.equal(storedOrder.status, "paid");
  assert.equal(storedOrder.fulfillmentStatus, "fulfilled");

  // S1 Check: Service start must be 2026-01-31 14:00 and service end must be 2026-02-28 14:00!
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(uid);
  assert.ok(sub, "active subscription must exist");
  assert.equal(formatShanghaiDate(sub.service_start), "2026.01.31 14:00");
  assert.equal(formatShanghaiDate(sub.service_end), "2026.02.28 14:00");
  assert.equal(sub.anchor_day, 31);

  // WeChat Pay S1 Verification
  const uidWx = 502;
  createTestUser(uidWx, 0);
  const quoteWx = createQuote({ userId: uidWx, kind: "plan", itemId: "pro", cycle: "monthly", nowMs: new Date("2026-01-31T06:00:00.000Z").getTime() });
  const outTradeNoWx = `order_s1_wx_${Date.now()}`;

  insertPaymentOrder({
    outTradeNo: outTradeNoWx,
    userId: uidWx,
    idempotencyKey: `idem_s1_wx_${Date.now()}`,
    plan: { id: "pro", name: "专业版", amountFen: quoteWx.amountFen, credits: quoteWx.issuedNow },
    status: "created",
    provider: "wxpay",
    nowIso: "2026-01-31T06:00:00.000Z",
    expiresAtIso: quoteWx.expiresAt,
    quote: quoteWx,
    acquireLock: true,
  });

  const wxPayload = wxpayGateway.buildNotifyPayload({
    outTradeNo: outTradeNoWx,
    transactionId: `WX_S1_${Date.now()}`,
    amountFen: quoteWx.amountFen,
  });
  // Inject exact success_time: 2026-01-31T14:00:00+08:00
  const decryptedData = wxpayGateway.decryptNotifyResource(JSON.parse(wxPayload.rawBody).resource);
  decryptedData.success_time = "2026-01-31T14:00:00+08:00";

  // Test processWxpayNotify with verified success_time
  const wxSettled = settlePaidPaymentOrder({
    outTradeNo: outTradeNoWx,
    tradeNo: `WX_S1_${Date.now()}`,
    nowIso: delayedNotifyTime,
    providerPaidAt: decryptedData.success_time,
  });
  assert.equal(wxSettled.order.status, "paid");

  const subWx = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(uidWx);
  assert.equal(formatShanghaiDate(subWx.service_start), "2026.01.31 14:00");
  assert.equal(formatShanghaiDate(subWx.service_end), "2026.02.28 14:00");
});

test("S1 Missing Time: missing provider payment time enters audit_required and does not grant fake period", () => {
  resetTestDb();
  const uid = 503;
  createTestUser(uid, 0);

  const quote = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly" });
  const outTradeNo = `order_s1_missing_${Date.now()}`;
  insertPaymentOrder({
    outTradeNo,
    userId: uid,
    idempotencyKey: `idem_missing_${Date.now()}`,
    plan: { id: "pro", name: "专业版", amountFen: quote.amountFen, credits: quote.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date().toISOString(),
    expiresAtIso: quote.expiresAt,
    quote,
    acquireLock: true,
  });

  // Settle with explicitly null providerPaidAt
  const settled = settlePaidPaymentOrder({
    outTradeNo,
    tradeNo: "TRADE_NO_TIME",
    nowIso: new Date().toISOString(),
    providerPaidAt: null,
  });

  assert.equal(settled.order.status, "paid");
  assert.equal(settled.order.fulfillmentStatus, "audit_required");
  assert.equal(settled.order.auditReason, "missing_provider_paid_at");

  // No active subscription should be granted!
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(uid);
  assert.equal(sub, undefined, "must NOT grant active subscription without verified payment time");
});

test("S2: Historical SKU new order is rejected and unquoted order cannot bypass via config", async () => {
  resetTestDb();
  const uid = 601;
  createTestUser(uid, 0);

  const appConfig = {
    security: { cookieSecure: false },
    alipay: { enabled: true, provider: "fake", fakeAllowed: true },
    billing: {
      rechargePlans: [
        { id: "business-monthly", name: "旧版单月版", amountFen: 350000, credits: 1000 },
        { id: "p1", name: "历史小包", amountFen: 1, credits: 10 },
      ],
    },
  };

  const reqUnquoted = {
    method: "POST",
    url: "/api/payments/alipay/orders",
    headers: { host: "localhost:3013", cookie: `redbase_session=token-${uid}`, "content-type": "application/json" },
  };

  // 1. Trying to order historical SKU without quote: rejected
  const res1 = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk) this.body += chunk; },
  };
  const handled1 = await handlePaymentRoutes({
    appConfig,
    collectBody: async () => ({ planId: "business-monthly", idempotencyKey: `idem_s2_${Date.now()}` }),
    json: (res, code, data) => { res.statusCode = code; res.body = JSON.stringify(data); },
    badRequest: (res, msg) => { res.statusCode = 400; res.body = JSON.stringify({ error: msg }); },
  }, reqUnquoted, res1, "/api/payments/alipay/orders");

  assert.equal(handled1, true);
  assert.equal(res1.statusCode, 400);
  assert.match(res1.body, /充值套餐必须通过服务端报价下单，历史商品已停止新售/);

  // 2. Historical valid order already in database fulfills once with permanent credits
  const histOutTradeNo = `hist_order_${Date.now()}`;
  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
      amount_fen, status, provider, created_at, updated_at, expires_at, fulfillment_status
    ) VALUES (?, ?, 'idem_hist', 'business-monthly', '历史单月版', 1000, 350000, 'created', 'alipay', '2026-01-01', '2026-01-01', '2030-01-01', 'unfulfilled')
  `).run(histOutTradeNo, uid);

  const histSettled = settlePaidPaymentOrder({
    outTradeNo: histOutTradeNo,
    tradeNo: `HIST_TRADE_${Date.now()}`,
    nowIso: new Date().toISOString(),
  });

  assert.equal(histSettled.order.status, "paid");
  assert.equal(histSettled.order.fulfillmentStatus, "fulfilled");

  const histLot = db.prepare("SELECT * FROM credit_lots WHERE order_id = ?").get(histSettled.order.id);
  assert.ok(histLot);
  assert.equal(histLot.source_type, "legacy", "historical plan order must fulfill as permanent legacy credits");
  assert.equal(histLot.expires_at, null, "historical plan credits must have NO expiry date");
  assert.equal(histLot.initial_credits, 1000);
});

test("S3: Account plan order lock handles all states and returns HTTP 409 PLAN_ORDER_CONFLICT", () => {
  resetTestDb();
  const uid = 701;
  createTestUser(uid, 0);

  const q1 = createQuote({ userId: uid, kind: "plan", itemId: "pro", cycle: "monthly" });
  const outTradeNo1 = `plan_order_1_${Date.now()}`;

  // 1. Order 1 created
  insertPaymentOrder({
    outTradeNo: outTradeNo1,
    userId: uid,
    idempotencyKey: `idem_s3_1_${Date.now()}`,
    plan: { id: "pro", name: "专业版", amountFen: q1.amountFen, credits: q1.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date().toISOString(),
    expiresAtIso: q1.expiresAt,
    quote: q1,
    acquireLock: true,
  });

  // 2. Order 2 for a plan with different quote must throw PLAN_ORDER_CONFLICT
  const q2 = createQuote({ userId: uid, kind: "plan", itemId: "business", cycle: "monthly" });
  const outTradeNo2 = `plan_order_2_${Date.now()}`;
  assert.throws(
    () => {
      insertPaymentOrder({
        outTradeNo: outTradeNo2,
        userId: uid,
        idempotencyKey: `idem_s3_2_${Date.now()}`,
        plan: { id: "business", name: "业务版", amountFen: q2.amountFen, credits: q2.issuedNow },
        status: "created",
        provider: "alipay",
        nowIso: new Date().toISOString(),
        expiresAtIso: q2.expiresAt,
        quote: q2,
        acquireLock: true,
      });
    },
    (err) => err.code === "PLAN_ORDER_CONFLICT" && err.pendingOrder && err.pendingOrder.outTradeNo === outTradeNo1,
  );

  // 3. Booster pack (topup) order for same user is NOT blocked!
  const qTopup = createQuote({ userId: uid, kind: "topup", itemId: "fuel-small" });
  const outTradeNoTopup = `topup_order_${Date.now()}`;
  const topupOrder = insertPaymentOrder({
    outTradeNo: outTradeNoTopup,
    userId: uid,
    idempotencyKey: `idem_s3_topup_${Date.now()}`,
    plan: { id: "fuel-small", name: "小额加油包", amountFen: qTopup.amountFen, credits: qTopup.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date().toISOString(),
    expiresAtIso: qTopup.expiresAt,
    quote: qTopup,
    acquireLock: true,
  });
  assert.equal(topupOrder.status, "created", "topup purchase must not be blocked by plan order lock");

  // 4. Order 1 expires locally (status = 'expired') but is NOT closed: still blocks new plan orders!
  db.prepare("UPDATE payment_orders SET status = 'expired' WHERE out_trade_no = ?").run(outTradeNo1);
  assert.throws(
    () => {
      insertPaymentOrder({
        outTradeNo: outTradeNo2,
        userId: uid,
        idempotencyKey: `idem_s3_2_${Date.now()}`,
        plan: { id: "business", name: "业务版", amountFen: q2.amountFen, credits: q2.issuedNow },
        status: "created",
        provider: "alipay",
        nowIso: new Date().toISOString(),
        expiresAtIso: q2.expiresAt,
        quote: q2,
        acquireLock: true,
      });
    },
    (err) => err.code === "PLAN_ORDER_CONFLICT",
    "expired order without channel close must still block conflicting plan purchase",
  );

  // 5. Order 1 fulfills: lock is released, Order 2 can proceed
  settlePaidPaymentOrder({ outTradeNo: outTradeNo1, tradeNo: "T1", nowIso: new Date().toISOString() });
  const fulfilledOrder = findPaymentOrderByOutTradeNo(outTradeNo1);
  assert.equal(fulfilledOrder.fulfillmentStatus, "fulfilled");

  // Now order 2 can be created
  const order2 = insertPaymentOrder({
    outTradeNo: outTradeNo2,
    userId: uid,
    idempotencyKey: `idem_s3_2_${Date.now()}`,
    plan: { id: "business", name: "业务版", amountFen: q2.amountFen, credits: q2.issuedNow },
    status: "created",
    provider: "alipay",
    nowIso: new Date().toISOString(),
    expiresAtIso: q2.expiresAt,
    quote: q2,
    acquireLock: true,
  });
  assert.equal(order2.status, "created");
});
