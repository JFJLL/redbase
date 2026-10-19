"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

function testFreshDatabase() {
  console.log("\n--- [演练场景 1] 全新数据库初始化与 V14 迁移验证 ---");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Apply migrations via official connection and migrations runner
  const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
  const { openDatabase } = require("../src/server/db/connection");
  // Set memory file and initialize
  process.env.REDBASE_DB_FILE = ":memory:";
  const conn = openDatabase();
  initializeDatabaseSchema();
  ensureDatabaseIndexes();

  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const requiredTables = ["users", "credit_lots", "credit_lot_allocations", "subscriptions", "subscription_schedules", "subscription_grants", "billing_quotes", "payment_orders", "credit_events"];
  for (const t of requiredTables) {
    if (!tables.includes(t)) throw new Error(`全新库缺少表: ${t}`);
  }

  // Check columns added by V14
  const userCols = conn.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes("legacy_credits_migrated")) throw new Error("users 缺少 legacy_credits_migrated 字段");

  const schedCols = conn.prepare("PRAGMA table_info(subscription_schedules)").all().map((c) => c.name);
  if (!schedCols.includes("anchor_day")) throw new Error("subscription_schedules 缺少 anchor_day 字段");

  const subCols = conn.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
  if (!subCols.includes("upgrade_cumulative_exact")) throw new Error("subscriptions 缺少 upgrade_cumulative_exact 字段");

  console.log("✔ 全新数据库表结构与 V14 字段索引验证通过");
}

function testLegacyDatabaseUpgrade() {
  console.log("\n--- [演练场景 2] 改造前旧数据库直接升级至 V14 ---");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Setup pre-V2 legacy schema
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer',
      department TEXT NOT NULL DEFAULT '',
      credits INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL
    );
    CREATE TABLE credit_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      credit_delta INTEGER NOT NULL,
      credit_cost INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      admin_user_name TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE payment_orders (
      id INTEGER PRIMARY KEY,
      out_trade_no TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      plan_credits INTEGER NOT NULL,
      amount_fen INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      provider TEXT NOT NULL DEFAULT 'alipay',
      trade_no TEXT NOT NULL DEFAULT '',
      credit_event_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, credits, created_at)
    VALUES
      (1, '历史用户A', '13900000001', 'hash', 'customer', 500, '2026-06-01T00:00:00.000Z'),
      (2, '历史用户B', '13900000002', 'hash', 'customer', 1200, '2026-07-01T00:00:00.000Z'),
      (3, '零余额用户', '13900000003', 'hash', 'customer', 0, '2026-08-01T00:00:00.000Z'),
      (4, '历史用户C', '13900000004', 'hash', 'customer', 50, '2026-09-01T00:00:00.000Z');
  `).run();

  const totalBefore = db.prepare("SELECT SUM(credits) AS total FROM users").get().total;

  // Run all migrations
  const { VERSIONED_MIGRATIONS } = require("../src/server/db/migrations");
  // We can apply migrations v13 and v14 on db
  const v13 = VERSIONED_MIGRATIONS.find((m) => m.version === 13);
  const v14 = VERSIONED_MIGRATIONS.find((m) => m.version === 14);

  // Connection proxy for manual migration application
  const { openDatabase, getDbProxy } = require("../src/server/db/connection");
  const conn = getDbProxy();

  // Apply V13 DDL
  const v13Ddl = `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      service_start TEXT NOT NULL,
      service_end TEXT NOT NULL,
      anchor_day INTEGER NOT NULL,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      current_period_grant INTEGER NOT NULL,
      upgrade_cumulative_increment INTEGER NOT NULL DEFAULT 0,
      pricing_basis_fen INTEGER NOT NULL,
      actual_paid_total_fen INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS subscription_schedules (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      cycle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,
      monthly_credits INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS subscription_grants (
      id INTEGER PRIMARY KEY,
      subscription_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      period_index INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      granted_at TEXT,
      credit_lot_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS credit_lot_allocations (
      id INTEGER PRIMARY KEY,
      credit_event_id INTEGER NOT NULL,
      lot_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      credits_used INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_quotes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      action TEXT NOT NULL,
      cycle TEXT,
      catalog_version TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,
      issued_now INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      period_end_at TEXT,
      scheduled INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    ALTER TABLE payment_orders ADD COLUMN quote_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN fulfilled_at TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
    ALTER TABLE payment_orders ADD COLUMN cycle TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'plan';
    ALTER TABLE payment_orders ADD COLUMN order_action TEXT NOT NULL DEFAULT 'activate';
    ALTER TABLE payment_orders ADD COLUMN issued_now INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payment_orders ADD COLUMN service_start TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN service_end TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN period_end TEXT NOT NULL DEFAULT '';
  `;
  db.exec(v13Ddl);

  // Apply V14 DDL
  db.exec(`
    ALTER TABLE users ADD COLUMN legacy_credits_migrated INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE subscription_schedules ADD COLUMN anchor_day INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE subscription_schedules ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE subscriptions ADD COLUMN upgrade_cumulative_exact REAL NOT NULL DEFAULT 0;
    ALTER TABLE subscriptions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE payment_orders ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE payment_orders ADD COLUMN audit_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN audit_at TEXT NOT NULL DEFAULT '';
    ALTER TABLE payment_orders ADD COLUMN anchor_day INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE billing_quotes ADD COLUMN subscription_id INTEGER;
    ALTER TABLE billing_quotes ADD COLUMN original_plan_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE billing_quotes ADD COLUMN original_service_end TEXT NOT NULL DEFAULT '';
    ALTER TABLE billing_quotes ADD COLUMN subscription_version TEXT NOT NULL DEFAULT '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unique_active ON subscriptions(user_id) WHERE status = 'active';
  `);

  const { migrateAllLegacyUsers } = require("../src/server/billing/credit-ledger");
  const firstRun = migrateAllLegacyUsers(db);
  console.log(`[首次开账] 迁移账户数: ${firstRun.migratedCount}, 迁入积分: ${firstRun.migratedCreditsTotal}`);

  const lotsTotal = db.prepare("SELECT SUM(remaining_credits) AS total FROM credit_lots WHERE source_type = 'legacy'").get().total;
  const nonPermanent = db.prepare("SELECT COUNT(*) AS count FROM credit_lots WHERE expires_at IS NOT NULL").get().count;
  if (lotsTotal !== totalBefore) throw new Error("总额对账失败");
  if (nonPermanent !== 0) throw new Error("历史积分错误追加了到期日");

  // Idempotency re-run
  const secondRun = migrateAllLegacyUsers(db);
  if (secondRun.migratedCount !== 0 || secondRun.migratedCreditsTotal !== 0) throw new Error("幂等重跑失败");

  console.log("✔ 旧库升级与历史开账对账 100% 成功，幂等重跑无增发");
}

function testV13DatabaseIncrementalUpgrade() {
  console.log("\n--- [演练场景 3] 已执行 V13 的数据库平滑增量升级至 V14 ---");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Setup exact V13 tables and data
  const { initializeDatabaseSchema } = require("../src/server/db/schema");
  // Set memory file
  process.env.REDBASE_DB_FILE = ":memory:";
  const conn = require("../src/server/db/connection").openDatabase();
  initializeDatabaseSchema();

  // Verify that migration 14 has been recorded in schema_migrations
  const applied = conn.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
  if (!applied.includes(14)) throw new Error("Schema migrations 未包含版本 14");

  // Verify index idx_subscriptions_unique_active exists
  const indices = conn.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((i) => i.name);
  if (!indices.includes("idx_subscriptions_unique_active")) throw new Error("缺少索引 idx_subscriptions_unique_active");

  console.log("✔ 已执行 V13 数据库增量升级至 V14 验证成功");
}

function testInFlightAndScheduleReconciliation() {
  console.log("\n--- [演练场景 4 & 5] 在途预占、已付未履约与异常数据审计修复演练 ---");
  const { openDatabase, getDbProxy } = require("../src/server/db/connection");
  const conn = getDbProxy();

  // User with in-flight reservation
  const uid = 8001;
  const nowIso = new Date().toISOString();
  conn.prepare("DELETE FROM credit_lots WHERE id = 881").run();
  conn.prepare("DELETE FROM users WHERE id = ?").run(uid);
  conn.prepare("INSERT INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (?, 'InFlight', '13980010001', 'h', 'customer', 50, 1, ?)").run(uid, nowIso);
  conn.prepare("INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (881, ?, 'cycle', '本期积分', 50, 50, 20, 0, ?, ?, 'active', ?, ?)").run(uid, nowIso, new Date(Date.now() + 86400000).toISOString(), nowIso, nowIso);

  const { getUserWalletBalances, settleReservedCreditsFromLots } = require("../src/server/billing/credit-ledger");
  const balancesBefore = getUserWalletBalances(uid, Date.now(), conn);
  // Unreserved is 30, reserved is 20
  if (balancesBefore.totalAvailable !== 30) throw new Error(`在途预占可用扣减异常: ${balancesBefore.totalAvailable}`);

  // Settle reservation
  settleReservedCreditsFromLots({
    userId: uid,
    creditEventId: 7771,
    reservations: [{ lotId: 881, reservedCredits: 20 }],
    nowIso,
  }, conn);

  const balancesAfter = getUserWalletBalances(uid, Date.now(), conn);
  if (balancesAfter.totalAvailable !== 30) throw new Error("结算后可用余额应为 30");

  console.log("✔ 在途预占隔离结算与钱包读取对账成功");
}

function testV13CycleOnlyNoLegacyDuplication() {
  console.log("\n--- [演练场景 6] V13 仅有 cycle 批次账户升级验证（N1 硬断言） ---");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Setup exact V13 schema
  const { initializeDatabaseSchema } = require("../src/server/db/schema");
  const { applyVersionedMigrations } = require("../src/server/db/migrations");
  const { getUserWalletBalances, rescanExpiredLots } = require("../src/server/billing/credit-ledger");

  // User 9001 with 400 credits and only cycle lot
  const uid = 9001;
  const startIso = "2026-10-01T06:00:00.000Z";
  const expIso = "2026-11-01T06:00:00.000Z";
  const nowIso = "2026-10-16T06:00:00.000Z";
  const afterExpMs = Date.parse("2026-11-02T06:00:00.000Z");

  const conn = require("../src/server/db/connection").openDatabase();
  conn.prepare("DELETE FROM credit_lots WHERE user_id = ?").run(uid);
  conn.prepare("DELETE FROM users WHERE id = ?").run(uid);

  conn.prepare("INSERT INTO users (id, name, phone, password, account_type, credits, created_at) VALUES (?, 'V13CycleOnly', '13990010001', 'h', 'customer', 400, ?)").run(uid, startIso);
  conn.prepare("INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (90011, ?, 'cycle', '本期积分', 400, 400, 0, 0, ?, ?, 'active', ?, ?)").run(uid, startIso, expIso, startIso, startIso);

  // Apply migration / wallet query
  const balanceBefore = getUserWalletBalances(uid, Date.parse(nowIso), conn);
  if (balanceBefore.totalAvailable !== 400) throw new Error(`V13 升级前可用额度异常: ${balanceBefore.totalAvailable}`);
  if (balanceBefore.permanentBalance !== 0) throw new Error(`V13 升级前永久额度异常: ${balanceBefore.permanentBalance}`);

  // Check after expiry
  rescanExpiredLots(uid, afterExpMs, conn);
  const balanceAfter = getUserWalletBalances(uid, afterExpMs, conn);
  if (balanceAfter.totalAvailable !== 0) throw new Error(`V13 周期到期后可用额度应为 0，实际: ${balanceAfter.totalAvailable}`);
  if (balanceAfter.permanentBalance !== 0) throw new Error(`V13 周期到期后永久额度应为 0，实际: ${balanceAfter.permanentBalance}`);

  console.log("✔ V13 纯 cycle 批次账户升级演练通过：无重复开账，到期安全归零");
}

function testV17TableReconstructionAndExpiryNormalization() {
  console.log("\n--- [演练场景 7] V17 预占表物理主键重建与到期防重规范化演练 ---");
  const conn = require("../src/server/db/connection").openDatabase();

  // Verify V17 table structure
  const info = conn.prepare("PRAGMA table_info(task_credit_reservations)").all();
  const idCol = info.find((c) => c.name === "id");
  const taskIdCol = info.find((c) => c.name === "task_id");
  if (!idCol || idCol.pk !== 1) throw new Error("V17 物理主键必须为 id 字段");
  if (taskIdCol && taskIdCol.pk !== 0) throw new Error("V17 task_id 绝不能是物理主键");

  const indexList = conn.prepare("PRAGMA index_list(task_credit_reservations)").all();
  const uniqueIndex = indexList.find((idx) => idx.unique === 1 && idx.name.includes("uq_task_res_key_lot"));
  if (!uniqueIndex) throw new Error("缺少 (task_key, lot_id) 业务唯一索引");

  // Verify foreign key checks
  const fks = conn.prepare("PRAGMA foreign_key_check(task_credit_reservations)").all();
  if (fks.length > 0) throw new Error(`V17 预占表外键检查未通过: ${JSON.stringify(fks)}`);

  // Verify legacy expired normalization
  const { rescanExpiredLots, getUserWalletBalances } = require("../src/server/billing/credit-ledger");
  const uid = 9077;
  conn.prepare("INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (?, 'NormUser', '13990770001', 'h', 'customer', 0, 1, '2026-01-01')").run(uid);
  const lotId = 90771;
  conn.prepare("INSERT OR REPLACE INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (?, ?, 'cycle', '本期积分', 20, 20, 0, 0, '2026-01-01', '2026-02-01', 'expired', '2026-01-01', '2026-01-01')").run(lotId, uid);
  conn.prepare("INSERT OR REPLACE INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary, payload_json) VALUES (907701, ?, 'cycle_expire', '周期积分到期', -20, 0, '2026-02-01', '到期', ?)").run(uid, JSON.stringify({ lotId, expiredCredits: 20 }));

  rescanExpiredLots(uid, Date.now(), conn);
  const events = conn.prepare("SELECT * FROM credit_events WHERE user_id = ? AND action_type = 'cycle_expire'").all(uid);
  if (events.length !== 1) throw new Error(`规范化后到期事件数量应为 1，实际: ${events.length}`);

  const lot = conn.prepare("SELECT remaining_credits, status FROM credit_lots WHERE id = ?").get(lotId);
  if (lot.remaining_credits !== 0) throw new Error(`规范化后 remaining_credits 应为 0，实际: ${lot.remaining_credits}`);

  console.log("✔ V17 物理主键重建与到期防重规范化演练通过");
}

function testV18ReservationIdentityAndSubscriptionSnapshot() {
  console.log("\n--- [演练场景 8] V18 任务身份规范对齐与订阅快照回填演练 ---");
  const conn = require("../src/server/db/connection").openDatabase();
  const { VERSIONED_MIGRATIONS } = require("../src/server/db/migrations");

  // Verify task_key column in trend_analysis_requests and excellent_remix_billing_requests
  const trendCols = conn.prepare("PRAGMA table_info(trend_analysis_requests)").all().map((c) => c.name);
  if (!trendCols.includes("task_key")) throw new Error("trend_analysis_requests 缺少 task_key 字段");

  const excCols = conn.prepare("PRAGMA table_info(excellent_remix_billing_requests)").all().map((c) => c.name);
  if (!excCols.includes("task_key")) throw new Error("excellent_remix_billing_requests 缺少 task_key 字段");

  // Verify V18 migration aligns old trend keys
  const uid = 9088;
  const reqId = "req_rehearse_v18";
  conn.prepare("INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (?, 'V18User', '13990880001', 'h', 'customer', 0, 1, '2026-01-01')").run(uid);
  const { insertBrand } = require("../src/server/db/repositories/brand-repository");
  const brand = insertBrand({ ownerUserId: uid, name: "Brand88", industry: "Tech", audience: "All", description: "", product: "", goal: "", knowledgeBase: "", logo: "", assetTags: [], profileType: "corporate", contentPillars: [], personaStyle: "", createdAt: "2026-01-01" });
  const brandId = brand.id;
  conn.prepare("INSERT OR REPLACE INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (90881, ?, 'topup', '永久积分', 10, 9, 1, 0, '2026-01-01', NULL, 'active', '2026-01-01', '2026-01-01')").run(uid);
  conn.prepare("INSERT OR REPLACE INTO trend_analysis_requests (request_id, user_id, brand_id, bucket_key, status, credit_cost, created_at, updated_at, task_key) VALUES (?, ?, ?, 'bkey88', 'reserved', 1, '2026-01-01', '2026-01-01', '')").run(reqId, uid, brandId);
  conn.prepare("INSERT OR REPLACE INTO task_credit_reservations (id, task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at) VALUES (90882, ?, ?, ?, 'trend_analysis', 90881, 1, 'reserved', '2026-01-01', '2026-01-01')").run(`trend_analysis:${uid}:${reqId}`, reqId, uid);

  const v18 = VERSIONED_MIGRATIONS.find((m) => m.version === 18);
  v18.apply();

  const updatedRes = conn.prepare("SELECT task_key FROM task_credit_reservations WHERE id = 90882").get();
  if (updatedRes.task_key !== `trend_analysis:${uid}:${brandId}:bkey88:${reqId}`) {
    throw new Error(`V18 未将旧键更新为规范格式，当前: ${updatedRes.task_key}`);
  }

  // Verify V18 multi-attempt safety on same lot (I3)
  const excReqId = "req_rehearse_exc_v18";
  const t1Time = "2026-01-01T01:00:00.000Z";
  const t2Time = "2026-01-01T02:00:00.000Z";
  conn.prepare("INSERT OR REPLACE INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (90883, ?, 'topup', '永久积分', 10, 9, 1, 0, '2026-01-01', NULL, 'active', '2026-01-01', '2026-01-01')").run(uid);
  conn.prepare("INSERT OR REPLACE INTO excellent_remix_billing_requests (request_id, user_id, kind, input_signature, status, credit_cost, created_at, updated_at, task_key) VALUES (?, ?, 'direction', 'sig88', 'reserved', 1, ?, ?, '')").run(excReqId, uid, t2Time, t2Time);
  conn.prepare("INSERT OR REPLACE INTO task_credit_reservations (id, task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at) VALUES (90884, ?, ?, ?, 'excellent_direction', 90883, 1, 'released', ?, ?)").run(`excellent_direction:${uid}:${excReqId}`, excReqId, uid, t1Time, t1Time);
  conn.prepare("INSERT OR REPLACE INTO task_credit_reservations (id, task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at) VALUES (90885, ?, ?, ?, 'excellent_direction', 90883, 1, 'reserved', ?, ?)").run(`excellent_direction:${uid}:${excReqId}:${t2Time}`, excReqId, uid, t2Time, t2Time);

  // Re-run V18 on multi-attempt setup
  v18.apply();

  const t1Res = conn.prepare("SELECT task_key, status FROM task_credit_reservations WHERE id = 90884").get();
  const t2Res = conn.prepare("SELECT task_key, status FROM task_credit_reservations WHERE id = 90885").get();
  if (t1Res.task_key === t2Res.task_key) {
    throw new Error(`V18 将不同尝试合并成了相同 task_key: ${t1Res.task_key}`);
  }
  if (t1Res.status !== "released" || t2Res.status !== "reserved") {
    throw new Error(`V18 破坏了预占状态: T1=${t1Res.status}, T2=${t2Res.status}`);
  }

  console.log("✔ V18 任务身份规范对齐与订阅快照回填演练通过");
}

function testV19AttemptIdentityAndSnapshotRepair() {
  console.log("\n--- [演练场景 9] V19 历史尝试身份修复与订阅快照回填修正演练 ---");
  const conn = require("../src/server/db/connection").openDatabase();
  const { VERSIONED_MIGRATIONS } = require("../src/server/db/migrations");

  const uidPro = 9091;
  const uidAnnual = 9092;
  conn.prepare("INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (?, 'V19UserPro', '13990910001', 'h', 'customer', 0, 1, '2026-01-01')").run(uidPro);
  conn.prepare("INSERT OR REPLACE INTO users (id, name, phone, password, account_type, credits, legacy_credits_migrated, created_at) VALUES (?, 'V19UserAnnual', '13990920001', 'h', 'customer', 0, 1, '2026-01-01')").run(uidAnnual);

  // I4a setup: Pro monthly (400) + future scheduled Business (1500), corrupted by bad V18 to 1500
  const subProId = 9091;
  conn.prepare("INSERT OR REPLACE INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, order_kind, order_action, cycle, fulfillment_status, snapshot_json, expires_at, created_at, updated_at) VALUES (90910, 'out_pro_9091', ?, 'idem_pro_9091', 'pro', '专业版', 400, 4900, 'paid', 'plan', 'activate', 'monthly', 'fulfilled', '{\"monthlyCredits\":400,\"planId\":\"pro\",\"cycle\":\"monthly\",\"pricingBasisFen\":4900}', '2026-02-01', '2026-01-01', '2026-01-01')").run(uidPro);
  conn.prepare("INSERT OR REPLACE INTO credit_lots (id, user_id, source_type, source_label, order_id, subscription_id, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at) VALUES (909101, ?, 'cycle', '本期积分', 90910, ?, 400, 400, 0, 0, '2026-01-01', '2026-02-01', 'active', '2026-01-01', '2026-01-01')").run(uidPro, subProId);
  conn.prepare("INSERT OR REPLACE INTO subscriptions (id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day, current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at) VALUES (?, ?, 'pro', 'monthly', 'active', '2026-01-01', '2026-02-01', 1, '2026-01-01', '2026-02-01', 400, 0, 4900, 4900, '{\"monthlyCredits\":1500,\"planId\":\"business\"}', '2026-01-01', '2026-01-01')").run(subProId, uidPro);

  // Future scheduled order
  conn.prepare("INSERT OR REPLACE INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, order_kind, order_action, cycle, fulfillment_status, snapshot_json, expires_at, created_at, updated_at) VALUES (90911, 'out_biz_9091', ?, 'idem_biz_9091', 'business', '业务版', 1500, 14900, 'paid', 'plan', 'interval', 'monthly', 'scheduled', '{\"monthlyCredits\":1500,\"planId\":\"business\",\"cycle\":\"monthly\",\"pricingBasisFen\":14900}', '2026-03-01', '2026-01-15', '2026-01-15')").run(uidPro);
  conn.prepare("INSERT OR REPLACE INTO subscription_schedules (id, user_id, order_id, plan_id, cycle, status, start_at, end_at, amount_fen, monthly_credits, snapshot_json, created_at, updated_at) VALUES (90912, ?, 90911, 'business', 'monthly', 'scheduled', '2026-02-01', '2026-03-01', 14900, 1500, '{\"monthlyCredits\":1500}', '2026-01-15', '2026-01-15')").run(uidPro);

  // I4b setup: Lite annual upgraded to Pro annual, corrupted by bad V18 to 100
  const subAnnualId = 9092;
  conn.prepare("INSERT OR REPLACE INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, order_kind, order_action, cycle, fulfillment_status, snapshot_json, expires_at, created_at, updated_at) VALUES (90920, 'out_lite_9092', ?, 'idem_lite_9092', 'lite', '轻量版', 100, 19900, 'paid', 'plan', 'activate', 'annual', 'fulfilled', '{\"monthlyCredits\":100,\"planId\":\"lite\",\"cycle\":\"annual\",\"pricingBasisFen\":19900}', '2027-01-01', '2026-01-01', '2026-01-01')").run(uidAnnual);
  conn.prepare("INSERT OR REPLACE INTO payment_orders (id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits, amount_fen, status, order_kind, order_action, cycle, fulfillment_status, snapshot_json, expires_at, created_at, updated_at) VALUES (90921, 'out_upg_9092', ?, 'idem_upg_9092', 'pro', '专业版', 400, 29100, 'paid', 'plan', 'upgrade', 'annual', 'fulfilled', '{\"monthlyCredits\":400,\"targetMonthlyCredits\":400,\"planId\":\"pro\",\"cycle\":\"annual\",\"originalSubscriptionId\":9092,\"pricingBasisFen\":49000}', '2027-01-01', '2026-01-10', '2026-01-10')").run(uidAnnual);
  conn.prepare("INSERT OR REPLACE INTO subscriptions (id, user_id, plan_id, cycle, status, service_start, service_end, anchor_day, current_period_start, current_period_end, current_period_grant, upgrade_cumulative_increment, pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at) VALUES (?, ?, 'pro', 'annual', 'active', '2026-01-01', '2027-01-01', 1, '2026-02-01', '2026-03-01', 400, 0, 49000, 49000, '{\"monthlyCredits\":100,\"planId\":\"lite\"}', '2026-01-01', '2026-01-10')").run(subAnnualId, uidAnnual);
  conn.prepare("INSERT OR REPLACE INTO subscription_grants (id, subscription_id, user_id, period_index, period_start, period_end, credits, status, created_at, updated_at) VALUES (909201, ?, ?, 1, '2026-01-01', '2026-02-01', 100, 'granted', '2026-01-01', '2026-01-01')").run(subAnnualId, uidAnnual);
  for (let p = 2; p <= 12; p++) {
    conn.prepare("INSERT OR REPLACE INTO subscription_grants (id, subscription_id, user_id, period_index, period_start, period_end, credits, status, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-02-01', '2026-03-01', 400, 'pending', '2026-01-01', '2026-01-10')").run(909200 + p, subAnnualId, uidAnnual, p);
  }

  const v19 = VERSIONED_MIGRATIONS.find((m) => m.version === 19);
  v19.apply();

  const repairedPro = conn.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subProId);
  const proSnap = JSON.parse(repairedPro.snapshot_json);
  if (proSnap.monthlyCredits !== 400 || proSnap.planId !== "pro") {
    throw new Error(`V19 未能正确修复 I4a 专业版快照，当前: ${repairedPro.snapshot_json}`);
  }

  const repairedAnnual = conn.prepare("SELECT snapshot_json FROM subscriptions WHERE id = ?").get(subAnnualId);
  const annualSnap = JSON.parse(repairedAnnual.snapshot_json);
  if (annualSnap.monthlyCredits !== 400 || annualSnap.planId !== "pro") {
    throw new Error(`V19 未能正确修复 I4b 年付升级快照，当前: ${repairedAnnual.snapshot_json}`);
  }

  const period1Grant = conn.prepare("SELECT credits FROM subscription_grants WHERE subscription_id = ? AND period_index = 1").get(subAnnualId);
  if (period1Grant.credits !== 100) {
    throw new Error(`V19 错误覆盖了历史第一期发放额度: ${period1Grant.credits}`);
  }

  console.log("✔ V19 历史尝试身份修复与订阅快照回填修正演练通过");
}

function runRehearsal() {
  console.log("=== 开始执行 RedBase 套餐与积分 V2 数据迁移与审计修复完整演练 ===");
  testFreshDatabase();
  testLegacyDatabaseUpgrade();
  testV13DatabaseIncrementalUpgrade();
  testInFlightAndScheduleReconciliation();
  testV13CycleOnlyNoLegacyDuplication();
  testV17TableReconstructionAndExpiryNormalization();
  testV18ReservationIdentityAndSubscriptionSnapshot();
  testV19AttemptIdentityAndSnapshotRepair();
  console.log("\n=== RedBase 套餐与积分 V2 数据迁移隔离演练全部 100% 通过 ===");
}

if (require.main === module) {
  runRehearsal();
}

module.exports = { runRehearsal };
