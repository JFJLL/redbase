"use strict";

process.env.REDBASE_DB_FILE = "data/test-billing-ui.sqlite";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { createCreditLot, syncUserCreditsCache } = require("../src/server/billing/credit-ledger");
const { addCalendarMonths } = require("../src/server/billing/period-utils");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

// Clean existing data in test db
db.prepare("DELETE FROM sessions").run();
db.prepare("DELETE FROM users").run();
db.prepare("DELETE FROM subscriptions").run();
db.prepare("DELETE FROM subscription_schedules").run();
db.prepare("DELETE FROM subscription_grants").run();
db.prepare("DELETE FROM credit_lots").run();
db.prepare("DELETE FROM credit_events").run();
db.prepare("DELETE FROM payment_orders").run();
db.prepare("DELETE FROM brands").run();

// 1. Insert user
db.prepare(`
  INSERT INTO users (id, name, phone, password, account_type, department, credits, legacy_credits_migrated, created_at)
  VALUES (1, 'RedBase 体验用户', '13800138000', 'hash', 'customer', '运营部', 420, 1, '2026-08-01T00:00:00.000Z')
`).run();

// 2. Insert session
db.prepare(`
  INSERT INTO sessions (token, user_id, created_at)
  VALUES ('test-session-v2', 1, '2026-10-16T00:00:00.000Z')
`).run();

// 3. Insert brand
db.prepare(`
  INSERT INTO brands (id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, created_at)
  VALUES (1, 1, '自然之光', '家居', '年轻租房人群', '便携折叠灯', '折叠台灯', '打造小空间桌面好光', '', '2026-08-01T00:00:00.000Z')
`).run();

// 4. Insert active subscription (Pro Monthly: 2026-09-23 14:00 to 2026-10-23 14:00)
const subStartIso = new Date("2026-09-23T14:00:00+08:00").toISOString();
const subEndIso = new Date("2026-10-23T14:00:00+08:00").toISOString();
const schedStartIso = subEndIso;
const schedEndIso = new Date("2026-11-23T14:00:00+08:00").toISOString();

db.prepare(`
  INSERT INTO subscriptions (
    id, user_id, plan_id, cycle, status, service_start, service_end,
    anchor_day, current_period_start, current_period_end,
    current_period_grant, upgrade_cumulative_increment,
    pricing_basis_fen, actual_paid_total_fen, created_at, updated_at
  ) VALUES (1, 1, 'pro', 'monthly', 'active', ?, ?, 23, ?, ?, 400, 0, 99900, 99900, ?, ?)
`).run(subStartIso, subEndIso, subStartIso, subEndIso, subStartIso, subStartIso);

// 5. Insert credit lots
// Period lot: started with 400, 280 used, 120 remaining
db.prepare(`
  INSERT INTO credit_lots (
    id, user_id, source_type, source_label, subscription_id,
    initial_credits, remaining_credits, reserved_credits, used_credits,
    starts_at, expires_at, status, created_at, updated_at
  ) VALUES (1, 1, 'cycle', '本期积分', 1, 400, 120, 0, 280, ?, ?, 'active', ?, ?)
`).run(subStartIso, subEndIso, subStartIso, subStartIso);

// Permanent lot: 200 fuel pack + 100 legacy = 300
createCreditLot({
  userId: 1,
  sourceType: "topup",
  sourceLabel: "永久积分",
  credits: 200,
  startsAt: "2026-09-01T00:00:00.000Z",
  expiresAt: null,
}, db);

createCreditLot({
  userId: 1,
  sourceType: "legacy",
  sourceLabel: "历史保留积分",
  credits: 100,
  startsAt: "2026-08-01T00:00:00.000Z",
  expiresAt: null,
}, db);

syncUserCreditsCache(1, db);

// 6. Insert subscription schedule (pending scheduled renewal)
db.prepare(`
  INSERT INTO subscription_schedules (
    id, user_id, order_id, plan_id, cycle, status, start_at, end_at,
    amount_fen, monthly_credits, anchor_day, snapshot_json, created_at, updated_at
  ) VALUES (1, 1, 3, 'pro', 'monthly', 'scheduled', ?, ?, 99900, 400, 23, '{"planId":"pro","cycle":"monthly","monthlyCredits":400}', ?, ?)
`).run(schedStartIso, schedEndIso, subStartIso, subStartIso);

// 7. Insert visible credit events
db.prepare(`
  INSERT INTO credit_events (id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, summary)
  VALUES
    (1, 1, 'image_generation', '小红书标准组图', -4, 4, '2026-10-16T10:28:00+08:00', '4 张 · 标准模型 1K'),
    (2, 1, 'image_edit', '图片编辑', -1, 1, '2026-10-16T09:46:00+08:00', '1 张 · 智能消除'),
    (3, 1, 'trend_analysis', '热点趋势分析', -1, 1, '2026-10-15T16:15:00+08:00', '1 个分析维度'),
    (4, 1, 'topup_purchase', '积分加油包到账', 80, 0, '2026-10-01T09:20:00+08:00', '购买标准加油包到账 80 积分 · 永久有效'),
    (5, 1, 'cycle_first_grant', '套餐首期积分发放', 400, 0, '2026-09-23T14:00:00+08:00', '开通专业版首期发放 400 积分 · 2026.10.23 14:00 到期'),
    (6, 1, 'legacy_migration', '历史积分结转', 0, 0, '2026-08-01T00:00:00+08:00', '历史有效积分结转为永久积分（100 积分）')
`).run();

// 8. Insert sample orders (fulfilled, scheduled, audit_required, pending)
db.prepare(`
  INSERT INTO payment_orders (
    id, out_trade_no, user_id, idempotency_key, plan_id, plan_name,
    plan_credits, amount_fen, status, provider, trade_no, created_at, updated_at,
    paid_at, expires_at, fulfillment_status, order_kind, order_action, cycle, issued_now, audit_reason
  ) VALUES
    (1, 'rb_20261001_fuel80', 1, 'idem_01', 'fuel-standard', '标准加油包', 80, 29900, 'paid', 'alipay', 'trade_alipay_80', '2026-10-01T09:20:00+08:00', '2026-10-01T09:21:00+08:00', '2026-10-01T09:21:00+08:00', '2026-10-01T09:50:00+08:00', 'fulfilled', 'topup', 'topup', '', 80, ''),
    (2, 'rb_20260923_pro_m', 1, 'idem_02', 'pro', '专业版 · 月付', 400, 99900, 'paid', 'wxpay', 'trade_wx_pro', '2026-09-23T14:00:00+08:00', '2026-09-23T14:01:00+08:00', '2026-09-23T14:01:00+08:00', '2026-09-23T14:30:00+08:00', 'fulfilled', 'plan', 'activate', 'monthly', 400, ''),
    (3, 'rb_20261010_renew_pro', 1, 'idem_03', 'pro', '专业版 · 续费', 400, 99900, 'paid', 'alipay', 'trade_alipay_renew', '2026-10-10T11:00:00+08:00', '2026-10-10T11:02:00+08:00', '2026-10-10T11:02:00+08:00', '2026-10-10T11:30:00+08:00', 'scheduled', 'plan', 'renew', 'monthly', 0, ''),
    (4, 'rb_20261012_audit_up', 1, 'idem_04', 'business', '业务版 · 升级差价', 1100, 46667, 'paid', 'alipay', 'trade_alipay_conflict', '2026-10-12T15:00:00+08:00', '2026-10-12T15:01:00+08:00', '2026-10-12T15:01:00+08:00', '2026-10-12T15:30:00+08:00', 'audit_required', 'plan', 'upgrade', 'monthly', 257, '原订阅已发生变更或已失效，升级无法自动应用')
`).run();

console.log("data/test-billing-ui.sqlite seeded successfully with comprehensive state!");