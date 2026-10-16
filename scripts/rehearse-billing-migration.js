"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

function runRehearsal() {
  console.log("=== 开始执行 RedBase 套餐与积分 V2 数据迁移隔离演练 ===");

  // Create isolated in-memory test database
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // 1. Setup pre-V2 schema
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
  `);

  // 2. Populate legacy data
  db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, credits, created_at)
    VALUES
      (1, '历史用户A', '13900000001', 'hash', 'customer', 500, '2026-06-01T00:00:00.000Z'),
      (2, '历史用户B', '13900000002', 'hash', 'customer', 1200, '2026-07-01T00:00:00.000Z'),
      (3, '零余额用户', '13900000003', 'hash', 'customer', 0, '2026-08-01T00:00:00.000Z'),
      (4, '历史用户C', '13900000004', 'hash', 'customer', 50, '2026-09-01T00:00:00.000Z');
  `).run();

  const totalCreditsBefore = db.prepare("SELECT SUM(credits) AS total FROM users").get().total;
  const userCountBefore = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  console.log(`[迁移前] 用户数: ${userCountBefore}, 可用积分总和: ${totalCreditsBefore}`);

  // 3. Apply V2 Schema Migration (Version 13 DDL)
  db.exec(`
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
  `);

  const { migrateAllLegacyUsers, getUserWalletBalances } = require("../src/server/billing/credit-ledger");

  // 4. Run Migration
  const firstRun = migrateAllLegacyUsers(db);
  console.log(`[第1次迁移] 迁移账户数: ${firstRun.migratedCount}, 迁入积分总和: ${firstRun.migratedCreditsTotal}`);

  // Reconcile after first run
  const lotsTotalAfter = db.prepare("SELECT SUM(remaining_credits) AS total FROM credit_lots WHERE source_type = 'legacy'").get().total;
  const usersTotalAfter = db.prepare("SELECT SUM(credits) AS total FROM users").get().total;
  const nonPermanentLots = db.prepare("SELECT COUNT(*) AS count FROM credit_lots WHERE expires_at IS NOT NULL").get().count;

  if (lotsTotalAfter !== totalCreditsBefore) {
    throw new Error(`对账失败：迁移后积分总和 ${lotsTotalAfter} != 迁移前总和 ${totalCreditsBefore}`);
  }
  if (usersTotalAfter !== totalCreditsBefore) {
    throw new Error(`对账失败：用户缓存总和 ${usersTotalAfter} != 迁移前总和 ${totalCreditsBefore}`);
  }
  if (nonPermanentLots !== 0) {
    throw new Error(`违规：历史保留积分被错误追加了到期日（存在 ${nonPermanentLots} 条带到期日的历史批次）`);
  }
  console.log("[对账验证1] 积分总额 100% 对齐，历史积分保留永久有效（expires_at = NULL）");

  // 5. Test Idempotency (Second run must do nothing)
  const secondRun = migrateAllLegacyUsers(db);
  console.log(`[第2次迁移(幂等重跑)] 迁移账户数: ${secondRun.migratedCount}, 迁入积分: ${secondRun.migratedCreditsTotal}`);
  if (secondRun.migratedCount !== 0 || secondRun.migratedCreditsTotal !== 0) {
    throw new Error("幂等失败：重跑迁移产生了重复积分！");
  }
  console.log("[对账验证2] 幂等性验证通过：重复执行不会重复增发积分");

  console.log("=== RedBase 套餐与积分 V2 数据迁移隔离演练全部通过 ===");
}

if (require.main === module) {
  runRehearsal();
}

module.exports = { runRehearsal };
