"use strict";

const crypto = require("crypto");
const { getDbProxy } = require("../db/connection");
const { CATALOG_VERSION, PLANS, TOPUPS, getPlan, getTopup, getPriceFen } = require("./catalog");
const {
  getNowTimestamp,
  getNowIso,
  addCalendarMonths,
  toShanghaiDate,
  formatShanghaiDate,
} = require("./period-utils");
const {
  reconstructSubscriptionSnapshot,
  inspectSubscriptionSnapshot,
  safeUpdateSubscriptionSnapshot,
  isSubscriptionSnapshotConsistent,
} = require("./snapshot-recovery");

const DEFAULT_QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateQuoteId() {
  return "quot_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
}

function findActiveSubscription(userId, nowMs = getNowTimestamp()) {
  const db = getDbProxy();
  const nowIso = new Date(nowMs).toISOString();
  const row = db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active' AND service_end > ?
    ORDER BY id DESC LIMIT 1
  `).get(Number(userId), nowIso);
  return row || null;
}

function getSubscriptionSnapshot(sub, db = getDbProxy()) {
  if (!sub) return {};
  let currentSnap = null;
  try {
    currentSnap = JSON.parse(sub.snapshot_json || "{}");
  } catch (_) {}

  const inspection = inspectSubscriptionSnapshot(sub, db);

  if (inspection.status === "resolved" && inspection.snapshot) {
    const resolved = inspection.snapshot;
    if (resolved.planId !== sub.plan_id) {
      return {};
    }
    const consistency = isSubscriptionSnapshotConsistent(sub, resolved, currentSnap);

    if (!consistency.isConsistent) {
      const ok = safeUpdateSubscriptionSnapshot(sub, resolved, db);
      if (!ok) {
        return { casFailed: true };
      }
    }
    return resolved;
  }

  // When inspection status is conflict or unresolved:
  // Gate automatic dependent pricing when uncertain.
  // Never rely on current catalog to call snapshot healthy!
  return {};
}

function findPendingSchedule(userId) {
  const db = getDbProxy();
  const row = db.prepare(`
    SELECT * FROM subscription_schedules
    WHERE user_id = ? AND status = 'scheduled'
    ORDER BY id DESC LIMIT 1
  `).get(Number(userId));
  return row || null;
}

function createQuote({ userId, kind, itemId, cycle = "monthly", nowMs = getNowTimestamp() }) {
  const db = getDbProxy();
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("用户未登录或用户 ID 无效");
  }

  const nowIso = new Date(nowMs).toISOString();

  if (kind === "topup") {
    const topup = getTopup(itemId);
    if (!topup) {
      throw new Error(`无效的加油包商品：${itemId}`);
    }
    const quoteId = generateQuoteId();
    const expiresAt = new Date(nowMs + DEFAULT_QUOTE_TTL_MS).toISOString();
    const meta = {
      catalogVersion: CATALOG_VERSION,
      topupId: topup.id,
      topupName: topup.name,
      credits: topup.credits,
      amountFen: topup.amountFen,
    };

    db.prepare(`
      INSERT INTO billing_quotes (
        id, user_id, kind, item_id, action, cycle, catalog_version,
        amount_fen, issued_now, start_at, end_at, period_end_at,
        scheduled, meta_json, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      quoteId,
      uid,
      "topup",
      topup.id,
      "topup",
      null,
      CATALOG_VERSION,
      topup.amountFen,
      topup.credits,
      nowIso,
      null,
      null,
      0,
      JSON.stringify(meta),
      expiresAt,
      nowIso
    );

    return {
      quoteId,
      kind: "topup",
      itemId: topup.id,
      itemName: topup.name,
      action: "topup",
      cycle: null,
      amountFen: topup.amountFen,
      issuedNow: topup.credits,
      startAt: nowIso,
      endAt: null,
      periodEndAt: null,
      scheduled: false,
      meta,
      expiresAt,
    };
  }

  if (kind === "plan") {
    const plan = getPlan(itemId);
    if (!plan) {
      throw new Error(`无效的套餐商品：${itemId}`);
    }
    if (cycle !== "monthly" && cycle !== "annual") {
      throw new Error(`无效的付款周期：${cycle}`);
    }

    const pendingSchedule = findPendingSchedule(uid);
    if (pendingSchedule) {
      throw new Error("当前已有待生效套餐安排，请先查看已购安排，不能重复购买或变更套餐");
    }

    const activeSub = findActiveSubscription(uid, nowMs);
    let action = "activate";
    let scheduled = false;
    let startAtMs = nowMs;
    let endAtMs = 0;
    let periodEndAtMs = 0;
    let amountFen = 0;
    let issuedNow = 0;
    let anchorDay = toShanghaiDate(nowMs).getUTCDate();
    let meta = {
      catalogVersion: CATALOG_VERSION,
      planId: plan.id,
      planName: plan.name,
      cycle,
      planCredits: plan.credits,
    };

    if (!activeSub) {
      action = "activate";
      scheduled = false;
      startAtMs = nowMs;
      amountFen = getPriceFen(plan, cycle);
      issuedNow = plan.credits;
      endAtMs = addCalendarMonths(startAtMs, cycle === "annual" ? 12 : 1, anchorDay);
      periodEndAtMs = addCalendarMonths(startAtMs, 1, anchorDay);
    } else {
      const oldPlan = getPlan(activeSub.plan_id);
      const oldCycle = activeSub.cycle;
      anchorDay = activeSub.anchor_day || toShanghaiDate(new Date(activeSub.service_start).getTime()).getUTCDate();
      const subEndMs = new Date(activeSub.service_end).getTime();
      const subStartMs = new Date(activeSub.service_start).getTime();
      const periodEndMs = new Date(activeSub.current_period_end).getTime();
      const periodStartMs = new Date(activeSub.current_period_start).getTime();

      if (cycle !== oldCycle) {
        action = "interval";
        scheduled = true;
        startAtMs = subEndMs;
        amountFen = getPriceFen(plan, cycle);
        issuedNow = 0;
        endAtMs = addCalendarMonths(startAtMs, cycle === "annual" ? 12 : 1, anchorDay);
        periodEndAtMs = addCalendarMonths(startAtMs, 1, anchorDay);
        meta.previous = {
          planId: oldPlan.id,
          planName: oldPlan.name,
          cycle: oldCycle,
          serviceEnd: activeSub.service_end,
        };
      } else if (plan.rank > oldPlan.rank) {
        action = "upgrade";
        scheduled = false;
        startAtMs = nowMs;
        endAtMs = subEndMs;
        periodEndAtMs = periodEndMs;

        const serviceTotalMs = subEndMs - subStartMs;
        const serviceRemainingMs = Math.max(0, subEndMs - nowMs);
        const periodTotalMs = periodEndMs - periodStartMs;
        const periodRemainingMs = Math.max(0, periodEndMs - nowMs);

        if (serviceRemainingMs <= 0 || serviceTotalMs <= 0) {
          throw new Error("当前服务即将结束或已到期，请到期后重新开通");
        }

        const remainingServiceRatio = serviceRemainingMs / serviceTotalMs;
        const remainingPeriodRatio = periodTotalMs > 0 ? (periodRemainingMs / periodTotalMs) : 0;

        const subSnapshot = getSubscriptionSnapshot(activeSub, db);
        if (subSnapshot.casFailed) {
          throw new Error("原订阅状态已发生并发变更，无法生成有效升级报价，请重新获取报价");
        }
        const oldPurchasedCredits = Number(
          subSnapshot.monthlyCredits ||
          subSnapshot.planCredits ||
          0
        );
        if (!oldPurchasedCredits) {
          throw new Error("当前订阅权益快照待核查，无法自动计算升级差额，请联系客服处理");
        }

        const oldFullTermPrice = Number(subSnapshot.pricingBasisFen || activeSub.pricing_basis_fen || subSnapshot.fullTermPriceFen || 0);
        if (!oldFullTermPrice) {
          throw new Error("当前订阅计费基准待核查，无法自动计算升级差额，请联系客服处理");
        }
        const targetFullTermPrice = getPriceFen(plan, cycle);
        const priceDiff = targetFullTermPrice - oldFullTermPrice;

        if (priceDiff <= 0) {
          throw new Error("目标套餐价格不高于当前套餐，无法升级");
        }

        amountFen = Math.round(priceDiff * remainingServiceRatio);
        if (amountFen <= 0) {
          throw new Error("剩余时间不足以生成有效升级补款，请等待到期后重新开通");
        }

        const quotaDiff = plan.credits - oldPurchasedCredits;
        const exactIncrement = quotaDiff * remainingPeriodRatio;
        const previousCumExact = Number(activeSub.upgrade_cumulative_exact || 0);
        const previousIssued = Number(activeSub.upgrade_cumulative_increment || 0);
        const cumExact = previousCumExact + exactIncrement;
        const cumCeil = Math.ceil(cumExact);
        issuedNow = cumCeil - previousIssued;

        meta.upgradeDetails = {
          subscriptionId: activeSub.id,
          oldPlanId: oldPlan.id,
          oldPlanName: oldPlan.name,
          targetPlanId: plan.id,
          targetPlanName: plan.name,
          oldFullTermPrice,
          targetFullTermPrice,
          serviceRemainingMs,
          serviceTotalMs,
          periodRemainingMs,
          periodTotalMs,
          serviceDaysLeft: serviceRemainingMs / 86400000,
          serviceDaysTotal: serviceTotalMs / 86400000,
          periodDaysLeft: periodRemainingMs / 86400000,
          periodDaysTotal: periodTotalMs / 86400000,
          exactIncrement,
          previousCumExact,
          cumExact,
          previousIssued,
          cumCeil,
          issuedNow,
          serviceEnd: activeSub.service_end,
          periodStart: activeSub.current_period_start,
          periodEnd: activeSub.current_period_end,
          targetMonthlyCredits: plan.credits,
          oldPurchasedCredits,
        };
        meta.exactIncrement = exactIncrement;
        meta.cumExact = cumExact;
        meta.cumCeil = cumCeil;
      } else if (plan.rank < oldPlan.rank) {
        action = "downgrade";
        scheduled = true;
        startAtMs = subEndMs;
        amountFen = getPriceFen(plan, cycle);
        issuedNow = 0;
        endAtMs = addCalendarMonths(startAtMs, cycle === "annual" ? 12 : 1, anchorDay);
        periodEndAtMs = addCalendarMonths(startAtMs, 1, anchorDay);
        meta.previous = {
          planId: oldPlan.id,
          planName: oldPlan.name,
          cycle: oldCycle,
          serviceEnd: activeSub.service_end,
        };
      } else {
        action = "renew";
        scheduled = true;
        startAtMs = subEndMs;
        amountFen = getPriceFen(plan, cycle);
        issuedNow = 0;
        endAtMs = addCalendarMonths(startAtMs, cycle === "annual" ? 12 : 1, anchorDay);
        periodEndAtMs = addCalendarMonths(startAtMs, 1, anchorDay);
        meta.previous = {
          planId: oldPlan.id,
          planName: oldPlan.name,
          cycle: oldCycle,
          serviceEnd: activeSub.service_end,
        };
      }
    }

    let maxExpiresAtMs = nowMs + DEFAULT_QUOTE_TTL_MS;
    if (action === "upgrade") {
      maxExpiresAtMs = Math.min(maxExpiresAtMs, periodEndAtMs, endAtMs);
    }
    const expiresAt = new Date(maxExpiresAtMs).toISOString();
    const quoteId = generateQuoteId();

    const quoteCols = db.prepare("PRAGMA table_info(billing_quotes)").all().map((c) => c.name);
    if (quoteCols.includes("subscription_id")) {
      db.prepare(`
        INSERT INTO billing_quotes (
          id, user_id, kind, item_id, action, cycle, catalog_version,
          amount_fen, issued_now, start_at, end_at, period_end_at,
          scheduled, meta_json, expires_at, created_at,
          subscription_id, original_plan_id, original_service_end, subscription_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        quoteId,
        uid,
        "plan",
        plan.id,
        action,
        cycle,
        CATALOG_VERSION,
        amountFen,
        issuedNow,
        new Date(startAtMs).toISOString(),
        new Date(endAtMs).toISOString(),
        new Date(periodEndAtMs).toISOString(),
        scheduled ? 1 : 0,
        JSON.stringify(meta),
        expiresAt,
        nowIso,
        activeSub ? activeSub.id : null,
        activeSub ? activeSub.plan_id : "",
        activeSub ? activeSub.service_end : "",
        activeSub ? String(activeSub.updated_at || "") : ""
      );
    } else {
      db.prepare(`
        INSERT INTO billing_quotes (
          id, user_id, kind, item_id, action, cycle, catalog_version,
          amount_fen, issued_now, start_at, end_at, period_end_at,
          scheduled, meta_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        quoteId,
        uid,
        "plan",
        plan.id,
        action,
        cycle,
        CATALOG_VERSION,
        amountFen,
        issuedNow,
        new Date(startAtMs).toISOString(),
        new Date(endAtMs).toISOString(),
        new Date(periodEndAtMs).toISOString(),
        scheduled ? 1 : 0,
        JSON.stringify(meta),
        expiresAt,
        nowIso
      );
    }

    return {
      quoteId,
      kind: "plan",
      itemId: plan.id,
      itemName: plan.name,
      action,
      cycle,
      amountFen,
      issuedNow,
      startAt: new Date(startAtMs).toISOString(),
      endAt: new Date(endAtMs).toISOString(),
      periodEndAt: new Date(periodEndAtMs).toISOString(),
      scheduled,
      meta,
      expiresAt,
    };
  }

  throw new Error(`不支持的报价类型：${kind}`);
}

function findQuoteById(quoteId) {
  const db = getDbProxy();
  const row = db.prepare(`SELECT * FROM billing_quotes WHERE id = ?`).get(String(quoteId));
  if (!row) return null;
  return {
    ...row,
    meta: JSON.parse(row.meta_json || "{}"),
  };
}

function verifyAndConsumeQuote(quoteId, userId, nowMs = getNowTimestamp()) {
  const db = getDbProxy();
  const quote = findQuoteById(quoteId);
  if (!quote) {
    throw new Error("报价不存在或已失效，请重新确认");
  }
  if (Number(quote.user_id) !== Number(userId)) {
    throw new Error("报价不属于当前登录账号");
  }
  if (quote.used_at) {
    throw new Error("该报价已创建订单，请勿重复使用");
  }
  const nowIso = new Date(nowMs).toISOString();
  if (quote.expires_at <= nowIso) {
    throw new Error("报价已过期，请重新确认套餐与价格");
  }

  // Enforce subscription state consistency for upgrade quotes (R3)
  if (quote.action === "upgrade") {
    const activeSub = findActiveSubscription(userId, nowMs);
    const expectedSubId = quote.subscription_id || quote.meta?.upgradeDetails?.subscriptionId;
    const expectedPlanId = quote.original_plan_id || quote.meta?.upgradeDetails?.oldPlanId;
    const expectedServiceEnd = quote.original_service_end || quote.meta?.upgradeDetails?.serviceEnd;

    if (!activeSub) {
      throw new Error("原订阅已失效，无法升级");
    }
    if (expectedSubId && activeSub.id !== expectedSubId) {
      throw new Error("原订阅已发生变更，该升级报价已失效，请重新获取报价");
    }
    if (expectedPlanId && activeSub.plan_id !== expectedPlanId) {
      throw new Error("原订阅已发生变更，该升级报价已失效，请重新获取报价");
    }
    if (expectedServiceEnd && activeSub.service_end !== expectedServiceEnd) {
      throw new Error("原订阅服务期已发生变更，该升级报价已失效，请重新获取报价");
    }
  }

  // Prevent multiple active activations (R4)
  if (quote.action === "activate") {
    const activeSub = findActiveSubscription(userId, nowMs);
    if (activeSub) {
      throw new Error("用户当前已有生效套餐，不能重复开通");
    }
  }

  db.prepare(`UPDATE billing_quotes SET used_at = ? WHERE id = ?`).run(nowIso, quote.id);
  return quote;
}

module.exports = {
  generateQuoteId,
  findActiveSubscription,
  findPendingSchedule,
  createQuote,
  findQuoteById,
  verifyAndConsumeQuote,
};
