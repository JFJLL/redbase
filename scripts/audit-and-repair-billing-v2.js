"use strict";

const Database = require("better-sqlite3");
const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { formatShanghaiDate, getNowIso } = require("../src/server/billing/period-utils");

function auditBillingDatabase(database = null, options = {}) {
  const db = database || openDatabase();
  const dryRun = options.dryRun !== false;
  console.log(`=== RedBase 套餐与积分 V2 数据库账务与迁移审计 (${dryRun ? "DRY-RUN 模式" : "执行模式"}) ===\n`);

  // 1. Audit Users & Legacy Balances
  const users = db.prepare("SELECT id, name, phone, credits, legacy_credits_migrated, created_at FROM users").all();
  const categoryA = []; // True unmigrated legacy
  const categoryB = []; // Valid V13+ ledger accounts
  const categoryC = []; // Discrepancy accounts
  const categoryD = []; // Duplicate legacy lots from buggy V14

  for (const user of users) {
    const lots = db.prepare("SELECT * FROM credit_lots WHERE user_id = ?").all(user.id);
    const legacyLots = lots.filter((l) => l.source_type === "legacy");
    const cycleLots = lots.filter((l) => l.source_type === "cycle");
    const activeUnexpiredLots = lots.filter((l) => l.status === "active" && (l.expires_at === null || l.expires_at > getNowIso()));
    const activeLotBalance = activeUnexpiredLots.reduce((sum, l) => sum + Math.max(0, l.remaining_credits - l.reserved_credits), 0);

    if (lots.length === 0) {
      if (user.credits > 0) {
        categoryA.push({ userId: user.id, credits: user.credits, status: "未开账历史用户" });
      }
    } else {
      // Check if user has both cycle lot from V13 and duplicate legacy lot with matching credits
      if (cycleLots.length > 0 && legacyLots.length > 0) {
        const suspicious = legacyLots.filter((l) => cycleLots.some((c) => c.initial_credits === l.initial_credits));
        if (suspicious.length > 0) {
          categoryD.push({
            userId: user.id,
            credits: user.credits,
            suspiciousLots: suspicious.map((l) => ({ id: l.id, credits: l.initial_credits, created: l.created_at })),
          });
        }
      }

      if (Math.abs(user.credits - activeLotBalance) > 0) {
        categoryC.push({
          userId: user.id,
          userCredits: user.credits,
          activeLotBalance,
          diff: user.credits - activeLotBalance,
        });
      } else {
        categoryB.push({ userId: user.id, activeBalance: activeLotBalance });
      }
    }
  }

  console.log(`[用户开账状态审计]`);
  console.log(`- 分类 A（完全未开账历史用户）: ${categoryA.length} 人`);
  console.log(`- 分类 B（合法 V13+ 账本用户）: ${categoryB.length} 人`);
  console.log(`- 分类 C（缓存与批次不一致异常）: ${categoryC.length} 人`);
  console.log(`- 分类 D（疑似受旧 V14 影响生成重复永久批次）: ${categoryD.length} 人`);

  // 2. Audit Subscriptions
  const duplicateActiveSubs = db.prepare(`
    SELECT user_id, COUNT(*) AS count
    FROM subscriptions
    WHERE status = 'active'
    GROUP BY user_id
    HAVING count > 1
  `).all();
  console.log(`\n[订阅状态审计]`);
  console.log(`- 重复 active 订阅冲突账户数: ${duplicateActiveSubs.length}`);
  if (duplicateActiveSubs.length > 0) {
    for (const d of duplicateActiveSubs) {
      console.log(`  * 用户 ${d.user_id} 存在 ${d.count} 个 active 订阅，需人工核对`);
    }
  }

  // 3. Audit Orders
  const paidUnfulfilledOrders = db.prepare(`
    SELECT id, out_trade_no, user_id, plan_name, amount_fen, status, fulfillment_status, created_at
    FROM payment_orders
    WHERE status = 'paid' AND fulfillment_status IN ('unfulfilled', 'processing')
  `).all();

  const auditRequiredOrders = db.prepare(`
    SELECT id, out_trade_no, user_id, plan_name, amount_fen, status, fulfillment_status, audit_reason, created_at
    FROM payment_orders
    WHERE fulfillment_status = 'audit_required' OR audit_reason != ''
  `).all();

  console.log(`\n[订单履约与核查审计]`);
  console.log(`- 已支付未履约 (paid + unfulfilled) 订单数: ${paidUnfulfilledOrders.length}`);
  console.log(`- 待核查 (audit_required) 订单数: ${auditRequiredOrders.length}`);

  // 4. Audit Expired Lots with unrecorded expiration events
  const lotsWithMissingEvents = db.prepare(`
    SELECT l.id, l.user_id, l.remaining_credits, l.reserved_credits, l.expires_at
    FROM credit_lots l
    WHERE l.status = 'expired'
      AND l.remaining_credits > 0
      AND l.id NOT IN (
        SELECT CAST(json_extract(payload_json, '$.lotId') AS INTEGER)
        FROM credit_events
        WHERE action_type = 'cycle_expire'
      )
  `).all();
  console.log(`- 已过期但缺失 cycle_expire 流水批次数: ${lotsWithMissingEvents.length}`);

  console.log(`\n=== 审计完成 ===\n`);
  return {
    categoryA,
    categoryB,
    categoryC,
    categoryD,
    duplicateActiveSubs,
    paidUnfulfilledOrders,
    auditRequiredOrders,
    lotsWithMissingEvents,
  };
}

if (require.main === module) {
  auditBillingDatabase();
}

module.exports = { auditBillingDatabase };
