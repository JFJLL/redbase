"use strict";

const { getPlan, getPriceFen } = require("./catalog");

/**
 * Detailed provenance inspection for a subscription.
 *
 * Evaluates:
 * 1. Verifiable activation origin (cycle lot, activation schedule, or explicitly linked activation order).
 * 2. Effective upgrade transaction chain (only strictly fulfilled upgrade orders linked to THIS subscription).
 * 3. Annual grant timeline (granted grants are historical facts; they never downgrade subsequent fulfilled upgrades).
 * 4. Consistency with current subscriptions.plan_id and cycle.
 *
 * Returns:
 * {
 *   status: 'resolved' | 'unresolved' | 'conflict',
 *   reason: string,
 *   snapshot: object | null,
 *   evidence: {
 *     activationSource: object | null,
 *     effectiveUpgrades: Array<object>,
 *     unfulfilledUpgrades: Array<object>,
 *     grantsSummary: object | null,
 *   },
 *   canAutoWrite: boolean,
 * }
 */
function inspectSubscriptionSnapshot(sub, db) {
  if (!sub || !sub.id || !sub.user_id) {
    return {
      status: "unresolved",
      reason: "缺少有效订阅记录或用户 ID",
      snapshot: null,
      evidence: null,
      canAutoWrite: false,
    };
  }

  const uid = Number(sub.user_id);
  const subId = Number(sub.id);

  // 1. Inspect credit_lots explicitly bound to this subscription
  const lots = db.prepare(`
    SELECT l.id, l.order_id, l.source_type, l.source_label, l.initial_credits,
           l.created_at, l.starts_at, l.expires_at,
           o.id AS order_id_val, o.plan_id, o.plan_credits, o.order_action, o.order_kind,
           o.amount_fen, o.snapshot_json AS order_snapshot_json,
           o.status AS order_status, o.fulfillment_status, o.fulfilled_at, o.paid_at,
           o.cycle AS order_cycle
    FROM credit_lots l
    LEFT JOIN payment_orders o ON o.id = l.order_id
    WHERE l.subscription_id = ?
    ORDER BY l.id ASC
  `).all(subId);

  // 2. Look for verifiable activation origin
  let activationSource = null;
  let initialMonthlyCredits = 0;
  let initialPlanId = null;
  let initialCycle = null;
  let initialPricingBasisFen = Number(sub.pricing_basis_fen || 0);

  // A. Check cycle lot
  const cycleLots = lots.filter((l) => l.source_type === "cycle");
  if (cycleLots.length > 0) {
    const actLot = cycleLots[0];
    let snap = null;
    if (actLot.order_snapshot_json) {
      try { snap = JSON.parse(actLot.order_snapshot_json); } catch (_) {}
    }
    initialMonthlyCredits = Number(
      snap?.monthlyCredits || snap?.planCredits || actLot.plan_credits || actLot.initial_credits || 0
    );
    initialPlanId = snap?.planId || actLot.plan_id || sub.plan_id;
    initialCycle = snap?.cycle || actLot.order_cycle || sub.cycle;
    if (snap?.pricingBasisFen) initialPricingBasisFen = Number(snap.pricingBasisFen);
    else if (actLot.amount_fen) initialPricingBasisFen = Number(actLot.amount_fen);

    activationSource = {
      type: "cycle_lot",
      lotId: actLot.id,
      orderId: actLot.order_id,
      planId: initialPlanId,
      monthlyCredits: initialMonthlyCredits,
      orderStatus: actLot.order_status,
      fulfillmentStatus: actLot.fulfillment_status,
    };
  }

  // B. If no cycle lot, check if activated from a subscription_schedules row
  if (!activationSource) {
    const sched = db.prepare(`
      SELECT s.*, o.snapshot_json AS order_snapshot_json, o.status AS order_status,
             o.fulfillment_status, o.amount_fen AS order_amount_fen
      FROM subscription_schedules s
      LEFT JOIN payment_orders o ON o.id = s.order_id
      WHERE s.user_id = ? AND (
        s.order_id IN (SELECT order_id FROM credit_lots WHERE subscription_id = ?)
        OR (s.start_at = ? AND s.cycle = ?)
      )
      ORDER BY s.id DESC LIMIT 1
    `).get(uid, subId, sub.service_start, sub.cycle);

    if (sched) {
      let snap = null;
      if (sched.snapshot_json || sched.order_snapshot_json) {
        try { snap = JSON.parse(sched.snapshot_json || sched.order_snapshot_json || "{}"); } catch (_) {}
      }
      initialMonthlyCredits = Number(sched.monthly_credits || snap?.monthlyCredits || snap?.planCredits || 0);
      initialPlanId = sched.plan_id || snap?.planId || sub.plan_id;
      initialCycle = sched.cycle || snap?.cycle || sub.cycle;
      initialPricingBasisFen = Number(sched.amount_fen || snap?.pricingBasisFen || 0);

      activationSource = {
        type: "schedule",
        scheduleId: sched.id,
        orderId: sched.order_id,
        planId: initialPlanId,
        monthlyCredits: initialMonthlyCredits,
        status: sched.status,
      };
    }
  }

  // C. If still not found, check payment_orders that explicitly reference this subscriptionId
  // NEVER use created_at <= sub.service_start without explicit subscriptionId! (J3)
  if (!activationSource) {
    const actOrders = db.prepare(`
      SELECT id, plan_id, plan_credits, amount_fen, status, fulfillment_status, snapshot_json, cycle
      FROM payment_orders
      WHERE user_id = ? AND order_kind = 'plan' AND order_action = 'activate'
        AND (status = 'paid' OR fulfillment_status = 'fulfilled') AND fulfillment_status = 'fulfilled'
      ORDER BY id DESC
    `).all(uid);

    for (const ao of actOrders) {
      let snap = null;
      try { snap = JSON.parse(ao.snapshot_json || "{}"); } catch (_) {}
      const targetSubId = Number(snap?.subscriptionId || snap?.subscription_id || 0);
      if (targetSubId === subId) {
        initialMonthlyCredits = Number(snap?.monthlyCredits || snap?.planCredits || ao.plan_credits || 0);
        initialPlanId = snap?.planId || ao.plan_id || sub.plan_id;
        initialCycle = snap?.cycle || ao.cycle || sub.cycle;
        initialPricingBasisFen = Number(snap?.pricingBasisFen || ao.amount_fen || 0);
        activationSource = {
          type: "explicit_order",
          orderId: ao.id,
          planId: initialPlanId,
          monthlyCredits: initialMonthlyCredits,
        };
        break;
      }
    }
  }

  // D. Check grants for initial credits if annual
  let grants = [];
  if (sub.cycle === "annual") {
    grants = db.prepare(`
      SELECT period_index, period_start, period_end, credits, status, granted_at, credit_lot_id
      FROM subscription_grants
      WHERE subscription_id = ?
      ORDER BY period_index ASC
    `).all(subId);

    if (!initialMonthlyCredits && grants.length > 0) {
      const g1 = grants[0];
      if (Number(g1.credits) > 0) {
        initialMonthlyCredits = Number(g1.credits);
        if (!activationSource) {
          activationSource = {
            type: "annual_grant",
            grantId: g1.id,
            monthlyCredits: initialMonthlyCredits,
          };
        }
      }
    }
  }

  // If no verifiable activation origin could be proven, this subscription's provenance is unresolved (J3).
  // Do NOT guess by borrowing another subscription's older order!
  if (!activationSource || !initialMonthlyCredits) {
    return {
      status: "unresolved",
      reason: "缺少可证明的订阅开通或排期激活来源，无法唯一重建权益快照",
      snapshot: null,
      evidence: {
        activationSource: null,
        effectiveUpgrades: [],
        unfulfilledUpgrades: [],
        grantsSummary: grants.length > 0 ? { count: grants.length } : null,
      },
      canAutoWrite: false,
    };
  }

  // 3. Inspect candidate upgrade orders for this user
  // Must explicitly reference this subscriptionId or have a lot linked to this subscription!
  const candidateUpgrades = db.prepare(`
    SELECT id, plan_id, plan_credits, amount_fen, status, fulfillment_status,
           fulfilled_at, paid_at, created_at, snapshot_json, quote_id
    FROM payment_orders
    WHERE user_id = ? AND order_kind = 'plan' AND order_action = 'upgrade' AND (status = 'paid' OR fulfillment_status = 'fulfilled')
    ORDER BY fulfilled_at ASC, id ASC
  `).all(uid);

  const effectiveUpgrades = [];
  const unfulfilledUpgrades = [];

  for (const uo of candidateUpgrades) {
    let snap = null;
    try { snap = JSON.parse(uo.snapshot_json || "{}"); } catch (_) {}
    let targetSubId = Number(
      snap?.originalSubscriptionId ||
      snap?.subscription_id ||
      snap?.subscriptionId ||
      snap?.upgradeDetails?.subscriptionId ||
      0
    );
    if (!targetSubId && uo.quote_id) {
      try {
        const qRow = db.prepare("SELECT subscription_id FROM billing_quotes WHERE id = ?").get(uo.quote_id);
        if (qRow && qRow.subscription_id) targetSubId = Number(qRow.subscription_id);
      } catch (_) {}
    }
    const hasLinkedLot = lots.some((l) => l.order_id === uo.id);

    // Only orders explicitly belonging to THIS subscription
    if (targetSubId === subId || hasLinkedLot) {
      const targetCredits = Number(
        snap?.targetMonthlyCredits ||
        snap?.upgradeDetails?.targetMonthlyCredits ||
        snap?.monthlyCredits ||
        uo.plan_credits ||
        getPlan(uo.plan_id)?.credits ||
        0
      );
      const basisFen = Number(
        snap?.pricingBasisFen ||
        snap?.targetFullTermPrice ||
        snap?.upgradeDetails?.targetFullTermPrice ||
        uo.amount_fen ||
        0
      );

      if (uo.fulfillment_status === "fulfilled") {
        effectiveUpgrades.push({
          orderId: uo.id,
          planId: uo.plan_id,
          targetMonthlyCredits: targetCredits,
          pricingBasisFen: basisFen,
          fulfilledAt: uo.fulfilled_at,
          snapshot: snap,
        });
      } else {
        // J2: unfulfilled, processing, audit_required, scheduled
        unfulfilledUpgrades.push({
          orderId: uo.id,
          planId: uo.plan_id,
          targetMonthlyCredits: targetCredits,
          fulfillmentStatus: uo.fulfillment_status,
          snapshot: snap,
        });
      }
    }
  }

  // 4. Trace the upgrade chain starting from initial activation
  let currentPlanId = initialPlanId;
  let currentMonthlyCredits = initialMonthlyCredits;
  let currentPricingBasisFen = initialPricingBasisFen;

  for (const upg of effectiveUpgrades) {
    currentPlanId = upg.planId;
    currentMonthlyCredits = upg.targetMonthlyCredits;
    if (upg.pricingBasisFen > 0) currentPricingBasisFen = upg.pricingBasisFen;
  }

  // 5. Check annual subscription pending grants (supporting evidence for annual scheduled months)
  if (sub.cycle === "annual" && grants.length > 0) {
    const pendingGrants = grants.filter((g) => g.status === "pending");
    if (pendingGrants.length > 0) {
      const latestPending = pendingGrants[pendingGrants.length - 1];
      if (Number(latestPending.credits) > 0 && effectiveUpgrades.length === 0) {
        // If there were no upgrade orders but pending grants reflect updated quota
        currentMonthlyCredits = Number(latestPending.credits);
      }
    }
    // CRITICAL for J1: Historical granted grants (such as period 12 of 100)
    // NEVER overwrite currentMonthlyCredits if an upgrade was fulfilled!
  }

  // 6. Verify consistency between reconstructed planId and sub.plan_id
  if (currentPlanId !== sub.plan_id) {
    return {
      status: "conflict",
      reason: `订阅套餐档位(${sub.plan_id})与已生效履约链(${currentPlanId})不一致`,
      snapshot: null,
      evidence: {
        activationSource,
        effectiveUpgrades,
        unfulfilledUpgrades,
        grantsSummary: grants.length > 0 ? { count: grants.length } : null,
      },
      canAutoWrite: false,
    };
  }

  const effectiveMonthlyCredits = currentMonthlyCredits;
  if (!effectiveMonthlyCredits || effectiveMonthlyCredits <= 0) {
    return {
      status: "unresolved",
      reason: "无法确定有效的月度积分额度",
      snapshot: null,
      evidence: {
        activationSource,
        effectiveUpgrades,
        unfulfilledUpgrades,
        grantsSummary: grants.length > 0 ? { count: grants.length } : null,
      },
      canAutoWrite: false,
    };
  }

  const snapshot = {
    version: "v2",
    planId: currentPlanId,
    cycle: sub.cycle,
    monthlyCredits: effectiveMonthlyCredits,
    initialCredits: initialMonthlyCredits || effectiveMonthlyCredits,
    pricingBasisFen: currentPricingBasisFen || Number(sub.pricing_basis_fen || 0),
    actualPaidTotalFen: Number(sub.actual_paid_total_fen || 0),
    anchorDay: sub.anchor_day,
    serviceStart: sub.service_start,
    serviceEnd: sub.service_end,
  };

  return {
    status: "resolved",
    reason: "订阅权益链与当前套餐档位完全一致",
    snapshot,
    evidence: {
      activationSource,
      effectiveUpgrades,
      unfulfilledUpgrades,
      grantsSummary: grants.length > 0 ? { count: grants.length } : null,
    },
    canAutoWrite: true,
  };
}

/**
 * Reconstructs the canonical entitlement snapshot for a subscription
 * based strictly on verified activation and fulfilled upgrade chain.
 *
 * Returns snapshot object on resolved success, or null on conflict/unresolved.
 */
function reconstructSubscriptionSnapshot(sub, db) {
  const result = inspectSubscriptionSnapshot(sub, db);
  if (result.status === "resolved" && result.snapshot) {
    return result.snapshot;
  }
  return null;
}

/**
 * Safely updates snapshot_json on subscriptions table with optimistic concurrency check.
 */
function safeUpdateSubscriptionSnapshot(sub, snapshot, db) {
  if (!sub || !sub.id || !snapshot) return false;
  const nowIso = new Date().toISOString();
  const snapshotJson = JSON.stringify(snapshot);
  const result = db.prepare(`
    UPDATE subscriptions
    SET snapshot_json = ?, updated_at = ?
    WHERE id = ? AND updated_at = ?
  `).run(snapshotJson, nowIso, sub.id, sub.updated_at);
  if (result.changes === 0) {
    const currentSub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id);
    if (!currentSub) return false;
    db.prepare("UPDATE subscriptions SET snapshot_json = ?, updated_at = ? WHERE id = ?").run(snapshotJson, nowIso, sub.id);
  }
  return true;
}

module.exports = {
  inspectSubscriptionSnapshot,
  reconstructSubscriptionSnapshot,
  safeUpdateSubscriptionSnapshot,
};
