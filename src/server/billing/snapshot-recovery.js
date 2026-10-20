"use strict";

const { getPlan, getPriceFen } = require("./catalog");

/**
 * Detailed provenance inspection for a subscription.
 *
 * Evaluates:
 * 1. Verifiable activation origin (cycle lot with fulfilled order, activation schedule with fulfilled order, or explicitly linked activation order).
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
  // Strict provenance: cycle lot MUST have a linked order with BOTH status = 'paid' AND fulfillment_status = 'fulfilled'.
  // Cycle lots with no order or unfulfilled order are NOT accepted as complete entitlement proof.
  const cycleLots = lots.filter((l) => l.source_type === "cycle");
  if (cycleLots.length > 0) {
    for (const actLot of cycleLots) {
      if (!actLot.order_id) {
        continue;
      }
      const isPaidAndFulfilled = actLot.order_status === "paid" && actLot.fulfillment_status === "fulfilled";
      if (!isPaidAndFulfilled) continue;

      let snap = null;
      if (actLot.order_snapshot_json) {
        try { snap = JSON.parse(actLot.order_snapshot_json); } catch (_) {}
      }

      const credits = Number(
        snap?.monthlyCredits || snap?.planCredits || actLot.plan_credits || 0
      );
      if (credits <= 0) continue;

      initialMonthlyCredits = credits;
      initialPlanId = snap?.planId || actLot.plan_id || sub.plan_id;
      initialCycle = snap?.cycle || actLot.order_cycle || sub.cycle;
      if (snap?.pricingBasisFen) initialPricingBasisFen = Number(snap.pricingBasisFen);
      else if (actLot.order_action === "activate" && actLot.amount_fen) initialPricingBasisFen = Number(actLot.amount_fen);

      activationSource = {
        type: "cycle_lot",
        lotId: actLot.id,
        orderId: actLot.order_id,
        planId: initialPlanId,
        monthlyCredits: initialMonthlyCredits,
        orderStatus: actLot.order_status,
        fulfillmentStatus: actLot.fulfillment_status,
      };
      break;
    }
  }

  // B. If no cycle lot, check if activated from a subscription_schedules row
  // Strict provenance requirement:
  // - Schedule must be 'activated' (cancelled or scheduled rows are NEVER activation sources).
  // - Linked payment order must have BOTH status = 'paid' AND fulfillment_status = 'fulfilled'.
  // - Unique ownership and cycle consistency: cycle, start_at, and end_at must match subscription.
  // - Contradictions ONLY count among eligible proven sources! Non-effective rows have no authority.
  if (!activationSource) {
    const candidateSchedules = db.prepare(`
      SELECT s.*, o.id AS order_id_val, o.snapshot_json AS order_snapshot_json,
             o.status AS order_status, o.fulfillment_status, o.amount_fen AS order_amount_fen,
             o.cycle AS order_cycle, o.plan_id AS order_plan_id, o.plan_credits AS order_plan_credits
      FROM subscription_schedules s
      LEFT JOIN payment_orders o ON o.id = s.order_id
      WHERE s.user_id = ?
        AND (
          s.order_id IN (SELECT order_id FROM credit_lots WHERE subscription_id = ?)
          OR s.start_at = ?
        )
      ORDER BY s.id ASC
    `).all(uid, subId, sub.service_start);

    const validActivatedSchedules = [];

    for (const cs of candidateSchedules) {
      const isPaidAndFulfilled = cs.order_id && cs.order_status === "paid" && cs.fulfillment_status === "fulfilled";

      if (cs.status === "activated" && isPaidAndFulfilled) {
        const matchesInterval = cs.start_at === sub.service_start &&
          (!cs.end_at || cs.end_at === sub.service_end) &&
          cs.cycle === sub.cycle;
        if (matchesInterval) {
          validActivatedSchedules.push(cs);
        }
      }
    }

    if (validActivatedSchedules.length === 1) {
      const sched = validActivatedSchedules[0];
      let snap = null;
      if (sched.snapshot_json || sched.order_snapshot_json) {
        try { snap = JSON.parse(sched.snapshot_json || sched.order_snapshot_json || "{}"); } catch (_) {}
      }
      initialMonthlyCredits = Number(
        sched.monthly_credits || snap?.monthlyCredits || snap?.planCredits || sched.order_plan_credits || 0
      );
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
    } else if (validActivatedSchedules.length > 1) {
      return {
        status: "conflict",
        reason: "存在多个重复或冲突的已生效排期记录，无法确定唯一开通来源",
        snapshot: null,
        evidence: {
          activationSource: null,
          effectiveUpgrades: [],
          unfulfilledUpgrades: [],
        },
        canAutoWrite: false,
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
        AND status = 'paid' AND fulfillment_status = 'fulfilled'
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

  // 2.5 Verify Cycle Consistency
  if (activationSource) {
    if (initialCycle && initialCycle !== sub.cycle) {
      return {
        status: "conflict",
        reason: `开通来源周期(${initialCycle})与订阅当前周期(${sub.cycle})不一致`,
        snapshot: null,
        evidence: {
          activationSource,
          effectiveUpgrades: [],
          unfulfilledUpgrades: [],
          grantsSummary: grants.length > 0 ? { count: grants.length } : null,
        },
        canAutoWrite: false,
      };
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
  // Query only strictly paid and fulfilled orders for effective upgrades
  const candidateUpgrades = db.prepare(`
    SELECT id, plan_id, plan_credits, amount_fen, status, fulfillment_status,
           fulfilled_at, paid_at, created_at, snapshot_json, quote_id
    FROM payment_orders
    WHERE user_id = ? AND order_kind = 'plan' AND order_action = 'upgrade'
      AND (status = 'paid' OR fulfillment_status = 'fulfilled')
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
      snap?.meta?.upgradeDetails?.subscriptionId ||
      0
    );
    if (!targetSubId && uo.quote_id) {
      const qRow = db.prepare("SELECT subscription_id FROM billing_quotes WHERE id = ?").get(uo.quote_id);
      if (qRow && qRow.subscription_id) targetSubId = Number(qRow.subscription_id);
    }
    const hasLinkedLot = lots.some((l) => l.order_id === uo.id);

    // Only orders explicitly belonging to THIS subscription
    if (targetSubId === subId || hasLinkedLot) {
      // Authoritative upgrade target quota precedence (coordinated with pricing agent)
      let targetCredits = Number(
        snap?.meta?.targetMonthlyCredits ||
        snap?.meta?.upgradeDetails?.targetMonthlyCredits ||
        snap?.meta?.planCredits ||
        snap?.targetMonthlyCredits ||
        snap?.upgradeDetails?.targetMonthlyCredits ||
        snap?.monthlyCredits ||
        uo.plan_credits ||
        0
      );
      if (!Number.isSafeInteger(targetCredits) || targetCredits <= 0) {
        targetCredits = 0;
      }

      // Authoritative upgrade full-term pricing basis precedence (coordinated with pricing agent)
      // snap.meta.targetFullTermPrice -> snap.meta.upgradeDetails.targetFullTermPrice -> snap.meta.pricingBasisFen,
      // then explicit snap.targetFullTermPrice -> snap.upgradeDetails.targetFullTermPrice -> snap.pricingBasisFen.
      // Must be positive safe integer; missing => 0 => unresolved (never old plan basis).
      let basisFen = Number(
        snap?.meta?.targetFullTermPrice ||
        snap?.meta?.upgradeDetails?.targetFullTermPrice ||
        snap?.meta?.pricingBasisFen ||
        snap?.targetFullTermPrice ||
        snap?.upgradeDetails?.targetFullTermPrice ||
        snap?.pricingBasisFen ||
        0
      );
      if (!Number.isSafeInteger(basisFen) || basisFen <= 0) {
        basisFen = 0;
      }

      const isPaidAndFulfilled = uo.status === "paid" && uo.fulfillment_status === "fulfilled";
      if (isPaidAndFulfilled) {
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
    if (upg.pricingBasisFen > 0) {
      currentPricingBasisFen = upg.pricingBasisFen;
    } else {
      // An effective upgrade occurred, but target pricing basis is missing!
      // Must NOT silently retain the old pre-upgrade basis!
      currentPricingBasisFen = 0;
    }
  }

  // 5. Historical granted grants (such as period 12 of 100 in J1) NEVER overwrite currentMonthlyCredits.
  // Pending grants alone must NEVER override paid order monthly quota.

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

  if (effectiveUpgrades.length > 0 && (!currentPricingBasisFen || currentPricingBasisFen <= 0)) {
    return {
      status: "unresolved",
      reason: "升级订单缺少目标计费基准，无法确定有效计费基准",
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

  const targetBasis = Number(snapshot.pricingBasisFen || 0) > 0
    ? Number(snapshot.pricingBasisFen)
    : Number(sub.pricing_basis_fen || 0);

  // Optimistic concurrency CAS predicate:
  // Compare all structural fields read/used by callers:
  // id, updated_at, plan_id, cycle, status, service_start, service_end,
  // current_period_start, current_period_end, current_period_grant,
  // pricing_basis_fen, actual_paid_total_fen, upgrade_cumulative_increment,
  // upgrade_cumulative_exact, snapshot_json.
  // This catches same-millisecond updates, concurrent lifecycle advances,
  // and same-plan repairs.
  const result = db.prepare(`
    UPDATE subscriptions
    SET snapshot_json = ?, pricing_basis_fen = ?, updated_at = ?
    WHERE id = ?
      AND updated_at = ?
      AND plan_id = ?
      AND cycle = ?
      AND status = ?
      AND service_start = ?
      AND service_end = ?
      AND current_period_start = ?
      AND current_period_end = ?
      AND current_period_grant = ?
      AND pricing_basis_fen = ?
      AND actual_paid_total_fen = ?
      AND upgrade_cumulative_increment = ?
      AND upgrade_cumulative_exact = ?
      AND snapshot_json = ?
  `).run(
    snapshotJson,
    targetBasis,
    nowIso,
    sub.id,
    sub.updated_at,
    sub.plan_id,
    sub.cycle,
    sub.status,
    sub.service_start,
    sub.service_end,
    sub.current_period_start,
    sub.current_period_end,
    sub.current_period_grant,
    sub.pricing_basis_fen,
    sub.actual_paid_total_fen,
    sub.upgrade_cumulative_increment || 0,
    sub.upgrade_cumulative_exact || 0,
    sub.snapshot_json || ""
  );

  if (result.changes === 0) {
    // CAS failure: record was modified concurrently. NEVER force-write stale snapshot!
    return false;
  }
  sub.updated_at = nowIso;
  sub.snapshot_json = snapshotJson;
  sub.pricing_basis_fen = targetBasis;
  return true;
}


/**
 * Pure consistency predicate (no writes) comparing the current state of a subscription
 * and its snapshot_json against an expected canonical entitlement snapshot.
 *
 * Missing canonical fields count as mismatches (no truthy bypass guards).
 * Also checks subscriptions.pricing_basis_fen column alignment when expected pricingBasisFen > 0.
 *
 * Returns: { isConsistent: boolean, mismatches: string[] }
 */
function isSubscriptionSnapshotConsistent(sub, expectedSnapshot, currentSnap = null) {
  if (!sub || !expectedSnapshot) {
    return { isConsistent: false, mismatches: ["missing_sub_or_expected"] };
  }

  let snap = currentSnap;
  if (!snap) {
    try {
      snap = JSON.parse(sub.snapshot_json || "{}");
    } catch (_) {
      return { isConsistent: false, mismatches: ["invalid_snapshot_json"] };
    }
  }

  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    return { isConsistent: false, mismatches: ["non_object_snapshot"] };
  }

  const mismatches = [];

  // 1. Snapshot planId must match expected planId and sub.plan_id
  if (!snap.planId || snap.planId !== expectedSnapshot.planId || snap.planId !== sub.plan_id) {
    mismatches.push(`planId (current: ${snap.planId}, expected: ${expectedSnapshot.planId}, sub: ${sub.plan_id})`);
  }

  // 2. Snapshot cycle must match expected cycle and sub.cycle
  if (!snap.cycle || snap.cycle !== expectedSnapshot.cycle || snap.cycle !== sub.cycle) {
    mismatches.push(`cycle (current: ${snap.cycle}, expected: ${expectedSnapshot.cycle}, sub: ${sub.cycle})`);
  }

  // 3. Snapshot monthlyCredits must strictly match expected
  if (!snap.monthlyCredits || Number(snap.monthlyCredits) !== Number(expectedSnapshot.monthlyCredits)) {
    mismatches.push(`monthlyCredits (current: ${snap.monthlyCredits}, expected: ${expectedSnapshot.monthlyCredits})`);
  }

  // 4. Snapshot pricingBasisFen must strictly match expected when expected > 0
  if (expectedSnapshot.pricingBasisFen > 0) {
    if (!snap.pricingBasisFen || Number(snap.pricingBasisFen) !== Number(expectedSnapshot.pricingBasisFen)) {
      mismatches.push(`snapshot.pricingBasisFen (current: ${snap.pricingBasisFen}, expected: ${expectedSnapshot.pricingBasisFen})`);
    }
    // Column pricing_basis_fen must also align with expected
    if (Number(sub.pricing_basis_fen || 0) !== Number(expectedSnapshot.pricingBasisFen)) {
      mismatches.push(`column.pricing_basis_fen (current: ${sub.pricing_basis_fen}, expected: ${expectedSnapshot.pricingBasisFen})`);
    }
  }

  // 5. Service start & end timestamps must match expected when present in expected
  if (expectedSnapshot.serviceStart && snap.serviceStart !== expectedSnapshot.serviceStart) {
    mismatches.push(`serviceStart (current: ${snap.serviceStart}, expected: ${expectedSnapshot.serviceStart})`);
  }
  if (expectedSnapshot.serviceEnd && snap.serviceEnd !== expectedSnapshot.serviceEnd) {
    mismatches.push(`serviceEnd (current: ${snap.serviceEnd}, expected: ${expectedSnapshot.serviceEnd})`);
  }

  return {
    isConsistent: mismatches.length === 0,
    mismatches,
  };
}

module.exports = {
  inspectSubscriptionSnapshot,
  reconstructSubscriptionSnapshot,
  safeUpdateSubscriptionSnapshot,
  isSubscriptionSnapshotConsistent,
};
