"use strict";

/**
 * Reconstructs the canonical entitlement snapshot for a subscription
 * based strictly on its origin payment order, upgrade transaction chain,
 * credit lots, and subscription grants.
 *
 * NEVER guesses from current catalog or arbitrary unlinked orders.
 */
function reconstructSubscriptionSnapshot(sub, db) {
  if (!sub) return null;
  const uid = Number(sub.user_id);
  const subId = Number(sub.id);

  // 1. Inspect credit_lots explicitly bound to this subscription
  let lots = [];
  try {
    lots = db.prepare(`
      SELECT l.id, l.order_id, l.source_type, l.initial_credits, o.plan_id, o.plan_credits, o.order_action, o.amount_fen, o.snapshot_json
      FROM credit_lots l
      LEFT JOIN payment_orders o ON o.id = l.order_id
      WHERE l.subscription_id = ?
      ORDER BY l.id ASC
    `).all(subId);
  } catch (_) {}

  let initialMonthlyCredits = 0;
  let currentMonthlyCredits = 0;
  let pricingBasisFen = Number(sub.pricing_basis_fen || 0);
  let planId = sub.plan_id;
  const cycle = sub.cycle;

  // Find initial activation order from lots
  const activationLot = lots.find((l) => l.source_type === "cycle");
  if (activationLot && activationLot.snapshot_json) {
    try {
      const snap = JSON.parse(activationLot.snapshot_json);
      initialMonthlyCredits = Number(snap.monthlyCredits || snap.planCredits || activationLot.plan_credits || 0);
      if (snap.pricingBasisFen) pricingBasisFen = Number(snap.pricingBasisFen);
    } catch (_) {}
  }
  if (!initialMonthlyCredits && activationLot) {
    initialMonthlyCredits = Number(activationLot.plan_credits || activationLot.initial_credits || 0);
  }

  // Find latest upgrade order from lots
  const upgradeLots = lots.filter((l) => l.source_type === "upgrade");
  if (upgradeLots.length > 0) {
    const latestUpgradeLot = upgradeLots[upgradeLots.length - 1];
    if (latestUpgradeLot.snapshot_json) {
      try {
        const snap = JSON.parse(latestUpgradeLot.snapshot_json);
        currentMonthlyCredits = Number(snap.targetMonthlyCredits || snap.monthlyCredits || latestUpgradeLot.plan_credits || 0);
        if (snap.pricingBasisFen) pricingBasisFen = Number(snap.pricingBasisFen);
        if (snap.planId) planId = snap.planId;
      } catch (_) {}
    }
    if (!currentMonthlyCredits) {
      currentMonthlyCredits = Number(latestUpgradeLot.plan_credits || 0);
    }
  }

  // 2. If this is an annual subscription, subscription_grants reflects actual and scheduled monthly grants
  if (sub.cycle === "annual") {
    try {
      // Check latest grant credits (represents current upgraded monthly entitlement)
      const latestGrant = db.prepare(`
        SELECT credits FROM subscription_grants
        WHERE subscription_id = ?
        ORDER BY period_index DESC LIMIT 1
      `).get(subId);
      if (latestGrant && Number(latestGrant.credits) > 0) {
        currentMonthlyCredits = Number(latestGrant.credits);
      }

      // First grant represents initial entitlement
      if (!initialMonthlyCredits) {
        const firstGrant = db.prepare(`
          SELECT credits FROM subscription_grants
          WHERE subscription_id = ?
          ORDER BY period_index ASC LIMIT 1
        `).get(subId);
        if (firstGrant && Number(firstGrant.credits) > 0) {
          initialMonthlyCredits = Number(firstGrant.credits);
        }
      }
    } catch (_) {}
  }

  // 3. If still not resolved from lots/grants, check upgrade orders explicitly referencing this subscriptionId
  if (!currentMonthlyCredits) {
    try {
      const upgradeOrders = db.prepare(`
        SELECT id, plan_id, plan_credits, snapshot_json, amount_fen
        FROM payment_orders
        WHERE user_id = ? AND status = 'paid' AND order_action = 'upgrade'
        ORDER BY id ASC
      `).all(uid);
      for (const uo of upgradeOrders) {
        try {
          const snap = JSON.parse(uo.snapshot_json || "{}");
          const targetSubId = Number(snap.originalSubscriptionId || snap.subscription_id || 0);
          if (targetSubId === subId) {
            currentMonthlyCredits = Number(snap.targetMonthlyCredits || snap.monthlyCredits || uo.plan_credits || 0);
            if (snap.pricingBasisFen) pricingBasisFen = Number(snap.pricingBasisFen);
            if (uo.plan_id) planId = uo.plan_id;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 4. If still not resolved, look for the activation order of THIS subscription
  // Strictly condition on created_at <= sub.service_start to never pick up future scheduled orders!
  if (!initialMonthlyCredits && !currentMonthlyCredits) {
    try {
      const activateOrder = db.prepare(`
        SELECT id, plan_id, plan_credits, snapshot_json, amount_fen
        FROM payment_orders
        WHERE user_id = ? AND status = 'paid' AND order_kind = 'plan' AND order_action = 'activate'
          AND created_at <= ?
        ORDER BY id DESC LIMIT 1
      `).get(uid, sub.service_start || sub.created_at);
      if (activateOrder) {
        try {
          const snap = JSON.parse(activateOrder.snapshot_json || "{}");
          initialMonthlyCredits = Number(snap.monthlyCredits || snap.planCredits || activateOrder.plan_credits || 0);
          if (snap.pricingBasisFen) pricingBasisFen = Number(snap.pricingBasisFen);
        } catch (_) {}
        if (!initialMonthlyCredits) {
          initialMonthlyCredits = Number(activateOrder.plan_credits || 0);
        }
        if (!planId && activateOrder.plan_id) planId = activateOrder.plan_id;
      }
    } catch (_) {}
  }

  const effectiveMonthlyCredits = currentMonthlyCredits || initialMonthlyCredits;
  if (!effectiveMonthlyCredits || effectiveMonthlyCredits <= 0) {
    return null;
  }

  return {
    version: "v2",
    planId: planId || sub.plan_id,
    cycle: cycle || sub.cycle,
    monthlyCredits: effectiveMonthlyCredits,
    initialCredits: initialMonthlyCredits || effectiveMonthlyCredits,
    pricingBasisFen: pricingBasisFen || Number(sub.pricing_basis_fen || 0),
    actualPaidTotalFen: Number(sub.actual_paid_total_fen || 0),
    anchorDay: sub.anchor_day,
    serviceStart: sub.service_start,
    serviceEnd: sub.service_end,
  };
}

module.exports = {
  reconstructSubscriptionSnapshot,
};
