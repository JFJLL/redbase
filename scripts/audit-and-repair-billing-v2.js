"use strict";

const Database = require("better-sqlite3");
const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { formatShanghaiDate, getNowIso } = require("../src/server/billing/period-utils");
const { reconstructSubscriptionSnapshot } = require("../src/server/billing/snapshot-recovery");

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

  // 5. Audit Subscription Snapshots (I4)
  const allSubs = db.prepare("SELECT * FROM subscriptions").all();
  const subscriptionSnapshotAudits = [];
  for (const sub of allSubs) {
    let currentSnap = null;
    try { currentSnap = JSON.parse(sub.snapshot_json || "{}"); } catch (_) {}
    const expected = reconstructSubscriptionSnapshot(sub, db);
    const candidateOrders = db.prepare(`
      SELECT o.id, o.plan_id, o.order_action, o.status, o.amount_fen, o.snapshot_json
      FROM credit_lots l
      JOIN payment_orders o ON o.id = l.order_id
      WHERE l.subscription_id = ?
    `).all(sub.id);
    const upgradeOrders = db.prepare(`
      SELECT id, plan_id, order_action, status, amount_fen, snapshot_json
      FROM payment_orders
      WHERE user_id = ? AND status = 'paid' AND order_action = 'upgrade'
    `).all(sub.user_id);
    const grants = db.prepare(`
      SELECT period_index, credits, status FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC
    `).all(sub.id);

    let conflictReason = "valid";
    let actionTaken = "none";
    if (!expected) {
      conflictReason = "无法唯一重建权益快照";
      actionTaken = "audit_required";
    } else if (!currentSnap || !currentSnap.monthlyCredits) {
      conflictReason = "快照缺失";
      actionTaken = dryRun ? "需回填" : "已回填";
      if (!dryRun) {
        db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(expected), sub.id);
      }
    } else if (currentSnap.monthlyCredits !== expected.monthlyCredits || currentSnap.planId !== sub.plan_id) {
      conflictReason = `快照权益与真实履约链不一致 (当前: ${currentSnap.monthlyCredits} 分 [${currentSnap.planId || ""}], 真实: ${expected.monthlyCredits} 分 [${expected.planId}])`;
      actionTaken = dryRun ? "需修正" : "已修正";
      if (!dryRun) {
        db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(expected), sub.id);
      }
    }

    if (conflictReason !== "valid") {
      subscriptionSnapshotAudits.push({
        subscriptionId: sub.id,
        userId: sub.user_id,
        planId: sub.plan_id,
        cycle: sub.cycle,
        currentSnapshot: currentSnap,
        expectedSnapshot: expected,
        candidateOrders,
        upgradeOrders,
        grants,
        conflictReason,
        actionTaken,
      });
    }
  }
  console.log(`\n[订阅快照真实权益审计]`);
  console.log(`- 异常或需回填订阅数: ${subscriptionSnapshotAudits.length}`);
  for (const a of subscriptionSnapshotAudits) {
    console.log(`  * 订阅 #${a.subscriptionId} (用户 ${a.userId}, 套餐 ${a.planId}/${a.cycle}): ${a.conflictReason} -> [${a.actionTaken}]`);
  }

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
    subscriptionSnapshotAudits,
  };
}

if (require.main === module) {
  auditBillingDatabase();
}

module.exports = { auditBillingDatabase };
