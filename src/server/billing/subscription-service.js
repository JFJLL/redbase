"use strict";

const { getDbProxy, transaction } = require("../db/connection");
const { PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("./catalog");
const {
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
  toShanghaiDate,
  formatShanghaiDate,
} = require("./period-utils");
const {
  getUserWalletBalances,
  createCreditLot,
  rescanExpiredLots,
  insertLedgerCreditEvent,
} = require("./credit-ledger");

function findActiveSubscription(userId, nowMs = getNowTimestamp(), db = getDbProxy()) {
  const uid = Number(userId);
  const nowIso = new Date(nowMs).toISOString();
  const row = db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active' AND service_end > ?
    ORDER BY id DESC LIMIT 1
  `).get(uid, nowIso);
  return row || null;
}

function findPendingSchedule(userId, db = getDbProxy()) {
  const uid = Number(userId);
  const row = db.prepare(`
    SELECT * FROM subscription_schedules
    WHERE user_id = ? AND status = 'scheduled'
    ORDER BY id DESC LIMIT 1
  `).get(uid);
  return row || null;
}

function determinePlanAction(activeSub, plan, cycle, isExpired, hasScheduled) {
  if (!activeSub) {
    return {
      type: "activate",
      label: isExpired ? "重新开通" : "立即开通",
      note: "支付成功后生效，开启新的服务期",
    };
  }

  const oldPlan = getPlan(activeSub.plan_id);
  const oldCycle = activeSub.cycle;
  const cycleName = (c) => (c === "annual" ? "年付" : "月付");

  if (cycle !== oldCycle) {
    const label = plan.id === oldPlan.id ? `改为${cycleName(cycle)}` : "更换套餐";
    return {
      type: "interval",
      label,
      note: `${cycleName(oldCycle)}改${cycleName(cycle)}，当前服务到期后生效`,
    };
  }

  if (plan.rank > oldPlan.rank) {
    return {
      type: "upgrade",
      label: "升级套餐",
      note: "补差价立即生效，原到期日不变",
    };
  }

  if (plan.rank < oldPlan.rank) {
    return {
      type: "downgrade",
      label: "更换套餐",
      note: "当前服务到期后生效，保留已有权益",
    };
  }

  return {
    type: "renew",
    label: "续费套餐",
    note: "衔接当前服务，本期积分不重置",
  };
}

function getUserBillingOverview(userId, nowMs = getNowTimestamp(), db = getDbProxy()) {
  const uid = Number(userId);
  advanceSubscriptionLifecycles(nowMs, db);

  const wallet = getUserWalletBalances(uid, nowMs, db);
  const activeSub = findActiveSubscription(uid, nowMs, db);
  const pendingSchedule = findPendingSchedule(uid, db);

  let isExpired = false;
  if (!activeSub) {
    const pastSub = db.prepare(`
      SELECT id FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1
    `).get(uid);
    if (pastSub) isExpired = true;
  }

  let scenario = "new";
  if (activeSub) {
    scenario = activeSub.cycle === "annual" ? "annual" : "monthly";
  } else if (isExpired) {
    scenario = "expired";
  }

  const planActions = {};
  for (const plan of PLANS) {
    for (const cycle of ["monthly", "annual"]) {
      const key = `${plan.id}_${cycle}`;
      planActions[key] = determinePlanAction(
        activeSub,
        plan,
        cycle,
        isExpired,
        Boolean(pendingSchedule)
      );
    }
  }

  let currentSubData = null;
  if (activeSub) {
    const plan = getPlan(activeSub.plan_id);
    const nowIso = new Date(nowMs).toISOString();
    const usedRow = db.prepare(`
      SELECT COALESCE(SUM(used_credits), 0) AS used
      FROM credit_lots
      WHERE subscription_id = ?
        AND (expires_at = ? OR starts_at = ?)
    `).get(activeSub.id, activeSub.current_period_end, activeSub.current_period_start);

    const totalUsedRow = db.prepare(`
      SELECT COALESCE(SUM(used_credits), 0) AS used
      FROM credit_lots
      WHERE subscription_id = ?
    `).get(activeSub.id);

    // Next grant date for annual
    let nextGrantAt = null;
    if (activeSub.cycle === "annual") {
      const nextGrant = db.prepare(`
        SELECT period_start FROM subscription_grants
        WHERE subscription_id = ? AND status = 'pending' AND period_start > ?
        ORDER BY period_index ASC LIMIT 1
      `).get(activeSub.id, nowIso);
      nextGrantAt = nextGrant?.period_start || null;
    }

    currentSubData = {
      id: activeSub.id,
      planId: activeSub.plan_id,
      planName: plan?.name || activeSub.plan_id,
      cycle: activeSub.cycle,
      serviceStart: activeSub.service_start,
      serviceEnd: activeSub.service_end,
      currentPeriodStart: activeSub.current_period_start,
      currentPeriodEnd: activeSub.current_period_end,
      currentPeriodGrant: activeSub.current_period_grant,
      usedCredits: Number(usedRow?.used || 0),
      totalUsedCredits: Number(totalUsedRow?.used || 0),
      nextGrantAt,
    };
  }

  let scheduledData = null;
  if (pendingSchedule) {
    const plan = getPlan(pendingSchedule.plan_id);
    scheduledData = {
      id: pendingSchedule.id,
      orderId: pendingSchedule.order_id,
      planId: pendingSchedule.plan_id,
      planName: plan?.name || pendingSchedule.plan_id,
      cycle: pendingSchedule.cycle,
      startAt: pendingSchedule.start_at,
      endAt: pendingSchedule.end_at,
      amountFen: pendingSchedule.amount_fen,
      monthlyCredits: pendingSchedule.monthly_credits,
    };
  }

  return {
    wallet,
    subscription: currentSubData,
    scheduled: scheduledData,
    scenario,
    planActions,
  };
}

function fulfillPaymentOrder(order, nowMs = getNowTimestamp(), db = getDbProxy()) {
  const nowIso = new Date(nowMs).toISOString();
  const uid = Number(order.user_id || order.userId);
  const kind = String(order.order_kind || order.orderKind || "plan");
  const action = String(order.order_action || order.orderAction || "activate");
  const planId = String(order.plan_id || order.planId);
  const cycle = String(order.cycle || "monthly");
  const orderId = Number(order.id);

  return transaction(() => {
    if (kind === "topup") {
      const topup = getTopup(planId);
      const credits = Number(order.snapshot?.topupCredits || order.plan_credits || order.planCredits || topup?.credits || 0);
      createCreditLot({
        userId: uid,
        sourceType: "topup",
        sourceLabel: "永久积分",
        orderId,
        credits,
        startsAt: order.paid_at || nowIso,
        expiresAt: null,
        nowIso,
      }, db);

      db.prepare(`
        UPDATE payment_orders
        SET fulfillment_status = 'fulfilled', fulfilled_at = ?
        WHERE id = ?
      `).run(nowIso, orderId);

      return { status: "fulfilled" };
    }

    const plan = getPlan(planId);
    if (!plan) {
      db.prepare(`
        UPDATE payment_orders
        SET fulfillment_status = 'audit_required', audit_reason = '未知套餐商品', updated_at = ?
        WHERE id = ?
      `).run(nowIso, orderId);
      return { status: "audit_required", reason: "未知套餐商品" };
    }

    if (action === "activate") {
      const existingActive = findActiveSubscription(uid, nowMs, db);
      if (existingActive) {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '用户已有有效订阅，不能重复开通', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "用户已有有效订阅，不能重复开通" };
      }

      const paidAtRaw = order.paidAt || order.paid_at;
      const startMs = paidAtRaw ? new Date(paidAtRaw).getTime() : nowMs;
      const anchorDay = order.anchorDay || order.anchor_day || toShanghaiDate(startMs).getUTCDate();
      const serviceStartIso = new Date(startMs).toISOString();
      const isAnnual = cycle === "annual";
      const serviceEndIso = new Date(addCalendarMonths(startMs, isAnnual ? 12 : 1, anchorDay)).toISOString();
      const periodEndIso = new Date(addCalendarMonths(startMs, 1, anchorDay)).toISOString();

      // Use purchased quota snapshot (R7)
      const initialCredits = Number(order.snapshot?.issuedNow ?? order.snapshot?.monthlyCredits ?? order.plan_credits ?? order.planCredits ?? plan.credits ?? 0);
      const monthlyCredits = Number(order.snapshot?.monthlyCredits || plan.credits || initialCredits);
      const pricingBasisFen = Number(
        order.snapshot?.pricingBasisFen ||
        order.snapshot?.meta?.pricingBasisFen ||
        order.snapshot?.meta?.targetFullTermPrice ||
        order.amount_fen ||
        order.amountFen ||
        0
      );
      if (pricingBasisFen <= 0) {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '缺少权威历史计费基准，需人工核查', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "缺少权威历史计费基准，需人工核查" };
      }
      const subSnapshot = {
        version: "v2",
        planId: plan.id,
        planName: plan.name,
        cycle,
        monthlyCredits,
        initialCredits,
        pricingBasisFen,
        actualPaidTotalFen: order.amount_fen || order.amountFen,
        anchorDay,
        serviceStart: serviceStartIso,
        serviceEnd: serviceEndIso,
      };
      const subSnapshotJson = JSON.stringify(subSnapshot);

      const subResult = db.prepare(`
        INSERT INTO subscriptions (
          user_id, plan_id, cycle, status, service_start, service_end,
          anchor_day, current_period_start, current_period_end,
          current_period_grant, upgrade_cumulative_increment,
          pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        uid,
        plan.id,
        cycle,
        serviceStartIso,
        serviceEndIso,
        anchorDay,
        serviceStartIso,
        periodEndIso,
        initialCredits,
        pricingBasisFen,
        order.amount_fen || order.amountFen,
        subSnapshotJson,
        nowIso,
        nowIso
      );

      const subscriptionId = subResult.lastInsertRowid;

      const lotId = createCreditLot({
        userId: uid,
        sourceType: "cycle",
        sourceLabel: "本期积分",
        orderId,
        subscriptionId,
        credits: initialCredits,
        startsAt: serviceStartIso,
        expiresAt: periodEndIso,
        nowIso,
      }, db);

      if (isAnnual) {
        const futureMonthlyCredits = Number(order.snapshot?.monthlyCredits || plan.credits);
        for (let i = 1; i <= 12; i++) {
          const pStartMs = addCalendarMonths(startMs, i - 1, anchorDay);
          const pEndMs = addCalendarMonths(startMs, i, anchorDay);
          const pStartIso = new Date(pStartMs).toISOString();
          const pEndIso = new Date(pEndMs).toISOString();
          const isFirst = i === 1;

          db.prepare(`
            INSERT INTO subscription_grants (
              subscription_id, user_id, period_index, period_start, period_end,
              credits, status, granted_at, credit_lot_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            subscriptionId,
            uid,
            i,
            pStartIso,
            pEndIso,
            isFirst ? initialCredits : futureMonthlyCredits,
            isFirst ? "granted" : "pending",
            isFirst ? nowIso : null,
            isFirst ? lotId : null,
            nowIso,
            nowIso
          );
        }
      }

      db.prepare(`
        UPDATE payment_orders
        SET fulfillment_status = 'fulfilled', fulfilled_at = ?
        WHERE id = ?
      `).run(nowIso, orderId);

      return { status: "fulfilled", subscriptionId };
    }

    if (action === "upgrade") {
      const paidAtRaw = order.paidAt || order.paid_at;
      const paidAtMs = paidAtRaw ? new Date(paidAtRaw).getTime() : nowMs;
      const orderPeriodEnd = order.period_end || order.snapshot?.periodEndAt || order.snapshot?.originalPeriodEnd;
      const orderPeriodEndMs = orderPeriodEnd ? new Date(orderPeriodEnd).getTime() : 0;

      // D5: If payment occurred strictly after the quoted period ended, require audit
      if (orderPeriodEndMs > 0 && paidAtMs > orderPeriodEndMs) {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '付款时间已晚于原报价周期到期时间', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "付款时间已晚于原报价周期到期时间" };
      }

      const activeSub = findActiveSubscription(uid, nowMs, db) || db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(order.snapshot?.originalSubscriptionId || order.snapshot?.subscription_id);
      const expectedSubId = order.snapshot?.originalSubscriptionId || order.snapshot?.subscription_id || order.quote?.subscription_id;
      const expectedPlanId = order.snapshot?.originalPlanId || order.snapshot?.original_plan_id || order.quote?.original_plan_id;

      if (!activeSub || (expectedSubId && activeSub.id !== expectedSubId) || (expectedPlanId && activeSub.plan_id !== expectedPlanId)) {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '原订阅已发生变更或已失效，升级无法自动应用', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "原订阅已发生变更或已失效，升级无法自动应用" };
      }

      const paidAdd = Number(order.amount_fen || order.amountFen || 0);
      const issuedNow = Number(order.snapshot?.issuedNow ?? order.issued_now ?? order.issuedNow ?? 0);

      const metaTargetPrice = Number(
        order.snapshot?.meta?.targetFullTermPrice ||
        order.snapshot?.meta?.upgradeDetails?.targetFullTermPrice ||
        order.quote?.meta?.targetFullTermPrice ||
        order.quote?.meta?.upgradeDetails?.targetFullTermPrice ||
        order.snapshot?.meta?.pricingBasisFen ||
        order.quote?.meta?.pricingBasisFen ||
        0
      );
      const snapshotBasis = Number(order.snapshot?.pricingBasisFen || order.quote?.pricingBasisFen || 0);

      let nextBasis = 0;
      if (Number.isSafeInteger(metaTargetPrice) && metaTargetPrice > 0) {
        nextBasis = metaTargetPrice;
      } else if (Number.isSafeInteger(snapshotBasis) && snapshotBasis > 0) {
        nextBasis = snapshotBasis;
      } else {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '缺少权威历史计费基准，需人工核查', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "缺少权威历史计费基准，需人工核查" };
      }

      const metaTargetCredits = Number(
        order.snapshot?.meta?.upgradeDetails?.targetMonthlyCredits ||
        order.snapshot?.meta?.planCredits ||
        order.quote?.meta?.upgradeDetails?.targetMonthlyCredits ||
        order.quote?.meta?.planCredits ||
        0
      );
      const snapshotCredits = Number(
        order.snapshot?.targetMonthlyCredits ||
        order.snapshot?.monthlyCredits ||
        order.quote?.targetMonthlyCredits ||
        order.quote?.monthlyCredits ||
        0
      );

      let targetMonthlyCredits = 0;
      if (Number.isSafeInteger(metaTargetCredits) && metaTargetCredits > 0) {
        targetMonthlyCredits = metaTargetCredits;
      } else if (Number.isSafeInteger(snapshotCredits) && snapshotCredits > 0) {
        targetMonthlyCredits = snapshotCredits;
      } else {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'audit_required', audit_reason = '缺少权威套餐配额快照，需人工核查', updated_at = ?
          WHERE id = ?
        `).run(nowIso, orderId);
        return { status: "audit_required", reason: "缺少权威套餐配额快照，需人工核查" };
      }

      const subPeriodStartMs = new Date(activeSub.current_period_start).getTime();
      const periodAdvanced = orderPeriodEndMs > 0 && (nowMs >= orderPeriodEndMs || subPeriodStartMs >= orderPeriodEndMs);

      const cumExact = Number(order.snapshot?.cumExact ?? order.quote?.meta?.cumExact ?? (Number(activeSub.upgrade_cumulative_exact || 0) + Number(order.snapshot?.exactIncrement || 0)));
      const cumCeil = Number(order.snapshot?.cumCeil ?? order.quote?.meta?.cumCeil ?? (Number(activeSub.upgrade_cumulative_increment || 0) + issuedNow));

      const updatedSnapshot = {
        version: "v2",
        planId: plan.id,
        planName: plan.name,
        cycle: activeSub.cycle,
        monthlyCredits: targetMonthlyCredits,
        pricingBasisFen: nextBasis,
        actualPaidTotalFen: Number(activeSub.actual_paid_total_fen || 0) + paidAdd,
        anchorDay: activeSub.anchor_day,
        serviceStart: activeSub.service_start,
        serviceEnd: activeSub.service_end,
      };
      const updatedSnapshotJson = JSON.stringify(updatedSnapshot);

      if (periodAdvanced) {
        // D3: Original period pro-rata grant belonged to original period which has ended; do not extend to new period
        if (issuedNow > 0) {
          createCreditLot({
            userId: uid,
            sourceType: "upgrade",
            sourceLabel: "本期积分",
            orderId,
            subscriptionId: activeSub.id,
            credits: issuedNow,
            startsAt: order.paid_at || nowIso,
            expiresAt: orderPeriodEnd,
            nowIso,
          }, db);
        }

        // D4: Top up current active period from old quota (e.g. 400) to target quota (e.g. 1500)
        let currentGrant = db.prepare(`
          SELECT * FROM subscription_grants
          WHERE subscription_id = ? AND period_start = ?
        `).get(activeSub.id, activeSub.current_period_start);

        if (!currentGrant && activeSub.cycle === "annual") {
          currentGrant = db.prepare(`
            SELECT * FROM subscription_grants
            WHERE subscription_id = ? AND status = 'granted'
            ORDER BY period_index DESC LIMIT 1
          `).get(activeSub.id);
        }

        if (currentGrant && currentGrant.credits < targetMonthlyCredits) {
          const deficit = targetMonthlyCredits - currentGrant.credits;
          createCreditLot({
            userId: uid,
            sourceType: "cycle",
            sourceLabel: "本期积分",
            orderId,
            subscriptionId: activeSub.id,
            credits: deficit,
            startsAt: activeSub.current_period_start,
            expiresAt: activeSub.current_period_end,
            nowIso,
          }, db);

          insertLedgerCreditEvent(db, {
            userId: uid,
            actionType: "cycle_grant",
            actionLabel: "升级跨期权益追补",
            creditDelta: deficit,
            creditCost: 0,
            createdAt: nowIso,
            summary: `升级${plan.name}追补本期差额 ${deficit} 积分（原发 ${currentGrant.credits} 积分，目标 ${targetMonthlyCredits} 积分）`,
            payload: {
              subscriptionId: activeSub.id,
              grantId: currentGrant.id,
              orderId,
              deficit,
              targetMonthlyCredits,
              idempotencyKey: `upgrade_delay_topup:${activeSub.id}:${currentGrant.id}:${orderId}`,
            },
          });

          db.prepare(`
            UPDATE subscription_grants
            SET credits = ?, updated_at = ?
            WHERE id = ?
          `).run(targetMonthlyCredits, nowIso, currentGrant.id);
        }

        if (activeSub.cycle === "annual") {
          db.prepare(`
            UPDATE subscription_grants
            SET credits = ?, updated_at = ?
            WHERE subscription_id = ? AND status = 'pending'
          `).run(targetMonthlyCredits, nowIso, activeSub.id);
        }

        db.prepare(`
          UPDATE subscriptions
          SET plan_id = ?,
              pricing_basis_fen = ?,
              actual_paid_total_fen = actual_paid_total_fen + ?,
              current_period_grant = ?,
              upgrade_cumulative_increment = 0,
              upgrade_cumulative_exact = 0,
              snapshot_json = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          plan.id,
          nextBasis,
          paidAdd,
          targetMonthlyCredits,
          updatedSnapshotJson,
          nowIso,
          activeSub.id
        );
      } else {
        const subCols = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
        if (subCols.includes("upgrade_cumulative_exact")) {
          db.prepare(`
            UPDATE subscriptions
            SET plan_id = ?,
                pricing_basis_fen = ?,
                actual_paid_total_fen = actual_paid_total_fen + ?,
                current_period_grant = current_period_grant + ?,
                upgrade_cumulative_increment = ?,
                upgrade_cumulative_exact = ?,
                snapshot_json = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            plan.id,
            nextBasis,
            paidAdd,
            issuedNow,
            cumCeil,
            cumExact,
            updatedSnapshotJson,
            nowIso,
            activeSub.id
          );
        } else {
          db.prepare(`
            UPDATE subscriptions
            SET plan_id = ?,
                pricing_basis_fen = ?,
                actual_paid_total_fen = actual_paid_total_fen + ?,
                current_period_grant = current_period_grant + ?,
                upgrade_cumulative_increment = upgrade_cumulative_increment + ?,
                snapshot_json = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            plan.id,
            nextBasis,
            paidAdd,
            issuedNow,
            issuedNow,
            updatedSnapshotJson,
            nowIso,
            activeSub.id
          );
        }

        if (issuedNow > 0) {
          createCreditLot({
            userId: uid,
            sourceType: "upgrade",
            sourceLabel: "本期积分",
            orderId,
            subscriptionId: activeSub.id,
            credits: issuedNow,
            startsAt: order.paid_at || nowIso,
            expiresAt: activeSub.current_period_end,
            nowIso,
          }, db);
        }

        if (activeSub.cycle === "annual") {
          db.prepare(`
            UPDATE subscription_grants
            SET credits = ?, updated_at = ?
            WHERE subscription_id = ? AND status = 'pending'
          `).run(targetMonthlyCredits, nowIso, activeSub.id);
        }
      }

      db.prepare(`
        UPDATE payment_orders
        SET fulfillment_status = 'fulfilled', fulfilled_at = ?
        WHERE id = ?
      `).run(nowIso, orderId);

      return { status: "fulfilled" };
    }

    if (action === "renew" || action === "downgrade" || action === "interval") {
      const startIso = order.service_start || order.serviceStart;
      const endIso = order.service_end || order.serviceEnd;

      const activeSub = findActiveSubscription(uid, nowMs, db);
      const anchorDay = activeSub?.anchor_day || toShanghaiDate(new Date(startIso).getTime()).getUTCDate();
      const monthlyCredits = Number(order.snapshot?.monthlyCredits || order.snapshot?.meta?.planCredits || order.plan_credits || order.planCredits || 400);
      const pricingBasisFen = Number(
        order.snapshot?.pricingBasisFen ||
        order.snapshot?.meta?.pricingBasisFen ||
        order.snapshot?.meta?.targetFullTermPrice ||
        order.amount_fen ||
        order.amountFen ||
        0
      );
      const schedSnapshot = {
        planId: plan.id,
        planName: plan.name,
        cycle,
        monthlyCredits,
        pricingBasisFen,
        amountFen: Number(order.amount_fen || order.amountFen || 0),
      };

      const schedCols = db.prepare("PRAGMA table_info(subscription_schedules)").all().map((c) => c.name);
      if (schedCols.includes("anchor_day")) {
        db.prepare(`
          INSERT INTO subscription_schedules (
            user_id, order_id, plan_id, cycle, status, start_at, end_at,
            amount_fen, monthly_credits, anchor_day, snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uid,
          orderId,
          plan.id,
          cycle,
          startIso,
          endIso,
          order.amount_fen || order.amountFen,
          monthlyCredits,
          anchorDay,
          JSON.stringify(schedSnapshot),
          nowIso,
          nowIso
        );
      } else {
        db.prepare(`
          INSERT INTO subscription_schedules (
            user_id, order_id, plan_id, cycle, status, start_at, end_at,
            amount_fen, monthly_credits, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)
        `).run(
          uid,
          orderId,
          plan.id,
          cycle,
          startIso,
          endIso,
          order.amount_fen || order.amountFen,
          monthlyCredits,
          nowIso,
          nowIso
        );
      }

      db.prepare(`
        UPDATE payment_orders
        SET fulfillment_status = 'scheduled', fulfilled_at = ?
        WHERE id = ?
      `).run(nowIso, orderId);

      return { status: "scheduled" };
    }

    throw new Error(`未知的订单履约动作：${action}`);
  })();
}

function advanceSubscriptionLifecycles(nowMs = getNowTimestamp(), db = getDbProxy()) {
  const nowIso = new Date(nowMs).toISOString();

  // 1. Activate due schedules
  const dueSchedules = db.prepare(`
    SELECT * FROM subscription_schedules
    WHERE status = 'scheduled' AND start_at <= ?
    ORDER BY start_at ASC
  `).all(nowIso);

  for (const schedule of dueSchedules) {
    transaction(() => {
      const claim = db.prepare(`
        UPDATE subscription_schedules
        SET status = 'activating', updated_at = ?
        WHERE id = ? AND status = 'scheduled'
      `).run(nowIso, schedule.id);
      if (claim.changes === 0) return;

      const existingSub = db.prepare(`
        SELECT id FROM subscriptions
        WHERE user_id = ? AND service_start = ? AND status = 'active'
      `).get(schedule.user_id, schedule.start_at);
      if (existingSub) {
        db.prepare(`UPDATE subscription_schedules SET status = 'activated', updated_at = ? WHERE id = ?`).run(nowIso, schedule.id);
        return;
      }

      // Supersede previous active sub if ended
      db.prepare(`
        UPDATE subscriptions
        SET status = 'superseded', updated_at = ?
        WHERE user_id = ? AND status = 'active' AND service_end <= ?
      `).run(nowIso, schedule.user_id, schedule.start_at);

      const plan = getPlan(schedule.plan_id);
      if (!plan && !schedule.monthly_credits) return;
      const startMs = new Date(schedule.start_at).getTime();
      // Preserve original anchor day from schedule (R5)
      const anchorDay = schedule.anchor_day || toShanghaiDate(startMs).getUTCDate();
      const isAnnual = schedule.cycle === "annual";
      const monthlyCredits = Number(schedule.monthly_credits || plan?.credits || 0);
      const schedSnapshot = (() => {
        try { return JSON.parse(schedule.snapshot_json || "{}"); } catch (_) { return {}; }
      })();
      const fullMonthlyCredits = Number(schedSnapshot.monthlyCredits || monthlyCredits);
      const periodEndIso = new Date(addCalendarMonths(startMs, 1, anchorDay)).toISOString();
      const pricingBasisFen = Number(schedSnapshot.pricingBasisFen || schedule.amount_fen);
      const subSnapshot = {
        version: "v2",
        planId: schedule.plan_id,
        planName: plan?.name || schedule.plan_id,
        cycle: schedule.cycle,
        monthlyCredits: fullMonthlyCredits,
        initialCredits: monthlyCredits,
        pricingBasisFen,
        actualPaidTotalFen: schedule.amount_fen,
        anchorDay,
        serviceStart: schedule.start_at,
        serviceEnd: schedule.end_at,
      };
      const subSnapshotJson = JSON.stringify(subSnapshot);

      const subResult = db.prepare(`
        INSERT INTO subscriptions (
          user_id, plan_id, cycle, status, service_start, service_end,
          anchor_day, current_period_start, current_period_end,
          current_period_grant, upgrade_cumulative_increment,
          pricing_basis_fen, actual_paid_total_fen, snapshot_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        schedule.user_id,
        schedule.plan_id,
        schedule.cycle,
        schedule.start_at,
        schedule.end_at,
        anchorDay,
        schedule.start_at,
        periodEndIso,
        monthlyCredits,
        pricingBasisFen,
        schedule.amount_fen,
        subSnapshotJson,
        nowIso,
        nowIso
      );

      const subscriptionId = subResult.lastInsertRowid;
      const lotId = createCreditLot({
        userId: schedule.user_id,
        sourceType: "cycle",
        sourceLabel: "本期积分",
        orderId: schedule.order_id,
        subscriptionId,
        credits: monthlyCredits,
        startsAt: schedule.start_at,
        expiresAt: periodEndIso,
        nowIso,
      }, db);

      insertLedgerCreditEvent(db, {
        userId: schedule.user_id,
        actionType: "cycle_grant",
        actionLabel: "续费套餐首期积分",
        creditDelta: monthlyCredits,
        creditCost: 0,
        createdAt: nowIso,
        summary: `开通${plan?.name || schedule.plan_id}发放 ${monthlyCredits} 积分`,
        payload: {
          subscriptionId,
          scheduleId: schedule.id,
          orderId: schedule.order_id,
          lotId,
          credits: monthlyCredits,
        },
      });

      if (isAnnual) {
        for (let i = 1; i <= 12; i++) {
          const pStartMs = addCalendarMonths(startMs, i - 1, anchorDay);
          const pEndMs = addCalendarMonths(startMs, i, anchorDay);
          const pStartIso = new Date(pStartMs).toISOString();
          const pEndIso = new Date(pEndMs).toISOString();
          const isFirst = i === 1;

          db.prepare(`
            INSERT INTO subscription_grants (
              subscription_id, user_id, period_index, period_start, period_end,
              credits, status, granted_at, credit_lot_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            subscriptionId,
            schedule.user_id,
            i,
            pStartIso,
            pEndIso,
            monthlyCredits,
            isFirst ? "granted" : "pending",
            isFirst ? nowIso : null,
            isFirst ? lotId : null,
            nowIso,
            nowIso
          );
        }
      }

      db.prepare(`
        UPDATE subscription_schedules
        SET status = 'activated', updated_at = ?
        WHERE id = ?
      `).run(nowIso, schedule.id);

      // Sync payment_orders fulfillment_status to fulfilled (R9)
      if (schedule.order_id) {
        db.prepare(`
          UPDATE payment_orders
          SET fulfillment_status = 'fulfilled', fulfilled_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nowIso, nowIso, schedule.order_id);
      }
    })();
  }

  // 2. Grant due annual installments
  const dueGrants = db.prepare(`
    SELECT g.*, s.status AS sub_status, s.anchor_day
    FROM subscription_grants g
    JOIN subscriptions s ON s.id = g.subscription_id
    WHERE g.status = 'pending' AND g.period_start <= ? AND s.status = 'active'
    ORDER BY g.period_start ASC
  `).all(nowIso);

  for (const grant of dueGrants) {
    transaction(() => {
      const claim = db.prepare(`
        UPDATE subscription_grants
        SET status = 'granting', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(nowIso, grant.id);
      if (claim.changes === 0) return;

      if (grant.period_end <= nowIso) {
        // Missed month during downtime: record accounting without resurrecting expired credits
        db.prepare(`
          UPDATE subscription_grants
          SET status = 'expired', updated_at = ?
          WHERE id = ?
        `).run(nowIso, grant.id);
        return;
      }

      const existingLot = db.prepare(`
        SELECT id FROM credit_lots WHERE grant_id = ?
      `).get(grant.id);
      if (existingLot) {
        db.prepare(`UPDATE subscription_grants SET status = 'granted', credit_lot_id = ?, updated_at = ? WHERE id = ?`).run(existingLot.id, nowIso, grant.id);
        return;
      }

      const lotId = createCreditLot({
        userId: grant.user_id,
        sourceType: "cycle",
        sourceLabel: "本期积分",
        subscriptionId: grant.subscription_id,
        grantId: grant.id,
        credits: grant.credits,
        startsAt: grant.period_start,
        expiresAt: grant.period_end,
        nowIso,
      }, db);

      // Record visible credit event for annual installment (R8)
      db.prepare(`
        INSERT INTO credit_events (
          user_id, action_type, action_label, credit_delta, credit_cost,
          created_at, summary, payload_json
        ) VALUES (?, 'cycle_grant', '周期积分发放', ?, 0, ?, ?, ?)
      `).run(
        grant.user_id,
        grant.credits,
        nowIso,
        `年付分期积分发放（第 ${grant.period_index} 期，共 12 期）`,
        JSON.stringify({
          subscriptionId: grant.subscription_id,
          grantId: grant.id,
          periodIndex: grant.period_index,
          lotId,
        })
      );

      db.prepare(`
        UPDATE subscription_grants
        SET status = 'granted', granted_at = ?, credit_lot_id = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, lotId, nowIso, grant.id);

      db.prepare(`
        UPDATE subscriptions
        SET current_period_start = ?,
            current_period_end = ?,
            current_period_grant = ?,
            upgrade_cumulative_increment = 0,
            upgrade_cumulative_exact = 0,
            updated_at = ?
        WHERE id = ?
      `).run(grant.period_start, grant.period_end, grant.credits, nowIso, grant.subscription_id);
    })();
  }

  // 3. Expire ended subscriptions without pending schedules
  db.prepare(`
    UPDATE subscriptions
    SET status = 'expired', updated_at = ?
    WHERE status = 'active' AND service_end <= ?
  `).run(nowIso, nowIso);
}

module.exports = {
  findActiveSubscription,
  findPendingSchedule,
  determinePlanAction,
  getUserBillingOverview,
  fulfillPaymentOrder,
  advanceSubscriptionLifecycles,
};
