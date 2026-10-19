"use strict";

const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { fulfillPaymentOrder } = require("../../billing/subscription-service");
const { createCreditLot, syncUserCreditsCache, migrateLegacyUserCredits } = require("../../billing/credit-ledger");
const { CATALOG_VERSION, PLANS, TOPUPS, getPlan, getTopup, getPriceFen, isV2Plan, isV2Topup } = require("../../billing/catalog");
const {
  recordPaymentOrderCreated,
  recordPaymentPaid,
  recordPaymentFailed,
  recordPaymentClosed,
} = require("../../analytics/analytics-recorder");

const db = getDbProxy();

const PAYMENT_COLUMNS = `
  id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
  amount_fen, status, provider, trade_no, credit_event_id, created_at, updated_at,
  paid_at, expires_at, last_notified_at, notify_count, audit_reason, audit_at, payload_json,
  quote_id, fulfillment_status, fulfilled_at, cycle, order_kind, order_action,
  issued_now, service_start, service_end, period_end, snapshot_json, anchor_day
`;

function mapPaymentOrderRow(row) {
  if (!row) return null;
  const snapshot = safeParseObject(row.snapshot_json);
  return {
    id: row.id,
    outTradeNo: row.out_trade_no,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    planId: row.plan_id,
    planName: row.plan_name,
    planCredits: Number(row.plan_credits),
    amountFen: Number(row.amount_fen),
    status: row.status,
    provider: row.provider,
    tradeNo: row.trade_no || "",
    creditEventId: row.credit_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at || "",
    expiresAt: row.expires_at,
    lastNotifiedAt: row.last_notified_at || "",
    notifyCount: Number(row.notify_count || 0),
    auditReason: row.audit_reason || "",
    auditAt: row.audit_at || "",
    payload: safeParseObject(row.payload_json),
    quoteId: row.quote_id || "",
    fulfillmentStatus: row.fulfillment_status || "unfulfilled",
    fulfilledAt: row.fulfilled_at || "",
    cycle: row.cycle || "",
    orderKind: row.order_kind || "plan",
    orderAction: row.order_action || "activate",
    issuedNow: Number(row.issued_now || 0),
    serviceStart: row.service_start || "",
    serviceEnd: row.service_end || "",
    periodEnd: row.period_end || "",
    snapshot,
    quote: snapshot,
    anchorDay: Number(row.anchor_day || 0),
  };
}

function safeParseObject(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function buildCanonicalOrderSnapshot(quote, plan, extra = {}) {
  const isV2 = Boolean(quote?.quoteId || quote?.id || isV2Plan(plan?.id) || isV2Topup(plan?.id));
  const kind = quote?.kind || (isV2Topup(plan?.id) ? "topup" : isV2Plan(plan?.id) ? "plan" : "legacy");
  const action = quote?.action || (isV2Topup(plan?.id) ? "topup" : isV2Plan(plan?.id) ? "activate" : "legacy");
  const itemId = quote?.item_id || quote?.itemId || plan?.id || "";
  const itemName = quote?.meta?.planName || quote?.meta?.topupName || quote?.itemName || plan?.name || itemId;
  const cycle = quote?.cycle || (kind === "plan" ? "monthly" : null);

  const amountFen = Number(quote?.amount_fen !== undefined ? quote.amount_fen : quote?.amountFen !== undefined ? quote.amountFen : plan?.amountFen || 0);

  let pricingBasisFen = amountFen;
  if (kind === "plan") {
    const fullPlan = getPlan(itemId);
    pricingBasisFen = Number(quote?.meta?.pricingBasisFen || (fullPlan ? getPriceFen(fullPlan, cycle) : amountFen));
  }

  let monthlyCredits = 0;
  if (kind === "plan") {
    const fullPlan = getPlan(itemId);
    monthlyCredits = Number(quote?.meta?.planCredits || fullPlan?.credits || (action === "activate" ? (quote?.issued_now ?? quote?.issuedNow) : 0) || plan?.credits || 0);
  } else {
    monthlyCredits = Number(quote?.issued_now ?? quote?.issuedNow ?? plan?.credits ?? 0);
  }

  const issuedNow = Number(quote?.issued_now !== undefined ? quote.issued_now : quote?.issuedNow !== undefined ? quote.issuedNow : (kind === "plan" && action === "activate" ? monthlyCredits : (plan?.credits || 0)));
  const topupCredits = kind === "topup" ? Number(quote?.issued_now ?? quote?.issuedNow ?? quote?.meta?.credits ?? plan?.credits ?? 0) : Number(plan?.credits || 0);

  const anchorDay = Number(quote?.anchor_day || quote?.meta?.anchorDay || extra.anchorDay || 0);
  const startAt = quote?.start_at || quote?.startAt || "";
  const endAt = quote?.end_at || quote?.endAt || "";
  const periodEndAt = quote?.period_end_at || quote?.periodEndAt || "";
  const scheduled = Boolean(quote?.scheduled);

  const originalSubscriptionId = quote?.subscription_id || quote?.meta?.upgradeDetails?.subscriptionId || null;
  const originalPlanId = quote?.original_plan_id || quote?.meta?.upgradeDetails?.oldPlanId || quote?.meta?.previous?.planId || "";
  const originalCycle = quote?.meta?.upgradeDetails?.oldCycle || quote?.meta?.previous?.cycle || "";
  const originalServiceEnd = quote?.original_service_end || quote?.meta?.upgradeDetails?.serviceEnd || quote?.meta?.previous?.serviceEnd || "";
  const subscriptionVersion = quote?.subscription_version || quote?.meta?.upgradeDetails?.subscriptionVersion || "";

  const exactIncrement = Number(quote?.meta?.exactIncrement || quote?.meta?.upgradeDetails?.exactIncrement || 0);
  const previousCumExact = Number(quote?.meta?.previousCumExact || quote?.meta?.upgradeDetails?.previousCumExact || 0);
  const cumExact = Number(quote?.meta?.cumExact || quote?.meta?.upgradeDetails?.cumExact || 0);
  const cumCeil = Number(quote?.meta?.cumCeil || quote?.meta?.upgradeDetails?.cumCeil || 0);
  const previousIssued = Number(quote?.meta?.previousIssued || quote?.meta?.upgradeDetails?.previousIssued || 0);
  const targetMonthlyCredits = kind === "plan" ? Number(quote?.meta?.upgradeDetails?.targetMonthlyCredits || monthlyCredits) : 0;

  return {
    version: 2,
    catalogVersion: quote?.catalog_version || CATALOG_VERSION,
    kind,
    action,
    itemId,
    itemName,
    cycle,
    amountFen,
    pricingBasisFen,
    monthlyCredits,
    issuedNow,
    topupCredits,
    anchorDay,
    startAt,
    endAt,
    periodEndAt,
    scheduled,
    originalSubscriptionId,
    originalPlanId,
    originalCycle,
    originalServiceEnd,
    subscriptionVersion,
    exactIncrement,
    previousCumExact,
    cumExact,
    cumCeil,
    previousIssued,
    targetMonthlyCredits,
    quoteId: quote?.quoteId || quote?.id || "",
    meta: quote?.meta || {},
  };
}

function insertPaymentOrder({
  outTradeNo,
  userId,
  idempotencyKey,
  plan,
  status = "created",
  provider = "alipay",
  nowIso,
  expiresAtIso,
  quote = null,
}) {
  const snapshot = buildCanonicalOrderSnapshot(quote, plan);
  const snapshotJson = JSON.stringify(snapshot);
  const planCredits = snapshot.kind === "topup" ? snapshot.topupCredits : snapshot.monthlyCredits;
  const issuedNow = snapshot.issuedNow;

  const orderCols = db.prepare("PRAGMA table_info(payment_orders)").all().map((c) => c.name);
  if (orderCols.includes("snapshot_json") && orderCols.includes("anchor_day")) {
    db.prepare(`
      INSERT INTO payment_orders (
        out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
        amount_fen, status, provider, created_at, updated_at, expires_at,
        quote_id, fulfillment_status, cycle, order_kind, order_action,
        issued_now, service_start, service_end, period_end, snapshot_json, anchor_day
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unfulfilled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(outTradeNo || ""),
      Number(userId),
      String(idempotencyKey || ""),
      String(snapshot.itemId || plan.id || ""),
      String(snapshot.itemName || plan.name || ""),
      planCredits,
      snapshot.amountFen,
      String(status || "created"),
      String(provider || "alipay"),
      String(nowIso),
      String(nowIso),
      String(expiresAtIso),
      String(snapshot.quoteId),
      String(snapshot.cycle || ""),
      String(snapshot.kind),
      String(snapshot.action),
      issuedNow,
      String(snapshot.startAt),
      String(snapshot.endAt),
      String(snapshot.periodEndAt),
      snapshotJson,
      snapshot.anchorDay
    );
  } else {
    db.prepare(`
      INSERT INTO payment_orders (
        out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
        amount_fen, status, provider, created_at, updated_at, expires_at,
        quote_id, fulfillment_status, cycle, order_kind, order_action,
        issued_now, service_start, service_end, period_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unfulfilled', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(outTradeNo || ""),
      Number(userId),
      String(idempotencyKey || ""),
      String(snapshot.itemId || plan.id || ""),
      String(snapshot.itemName || plan.name || ""),
      planCredits,
      snapshot.amountFen,
      String(status || "created"),
      String(provider || "alipay"),
      String(nowIso),
      String(nowIso),
      String(expiresAtIso),
      String(snapshot.quoteId),
      String(snapshot.cycle || ""),
      String(snapshot.kind),
      String(snapshot.action),
      issuedNow,
      String(snapshot.startAt),
      String(snapshot.endAt),
      String(snapshot.periodEndAt),
    );
  }
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  try {
    const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(order.userId);
    recordPaymentOrderCreated({
      orderId: order.id,
      userId: order.userId,
      accountType: userRow?.account_type || "customer",
      amountFen: order.amountFen,
      planId: order.planId,
      planName: order.planName,
      planCredits: order.planCredits,
      provider: order.provider,
      createdAt: order.createdAt,
    });
  } catch (_) {}
  return order;
}

function updatePaymentOrderStatus({ outTradeNo, status, nowIso, extra = {} }) {
  const allowed = ["created", "pending", "paid", "closed", "expired", "failed"];
  if (!allowed.includes(String(status || ""))) throw new Error(`未知订单状态：${status}`);
  const sets = ["status = ?", "updated_at = ?"];
  const values = [String(status), String(nowIso)];
  if (extra.tradeNo) {
    sets.push("trade_no = ?");
    values.push(String(extra.tradeNo));
  }
  if (extra.paidAt) {
    sets.push("paid_at = ?");
    values.push(String(extra.paidAt));
  }
  values.push(String(outTradeNo || ""));
  const updated = db.prepare(`UPDATE payment_orders SET ${sets.join(", ")} WHERE out_trade_no = ?`).run(...values).changes > 0;
  if (updated && ["failed", "expired", "closed"].includes(String(status))) {
    try {
      const order = findPaymentOrderByOutTradeNo(outTradeNo);
      if (order && order.status !== "paid") {
        const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(order.userId);
        const recordTerminalFact = String(status) === "closed" ? recordPaymentClosed : recordPaymentFailed;
        recordTerminalFact({
          orderId: order.id,
          userId: order.userId,
          accountType: userRow?.account_type || "customer",
          amountFen: order.amountFen,
          provider: order.provider,
          ...(String(status) === "closed" ? { closedAt: String(nowIso) } : { failedAt: String(nowIso) }),
        });
      }
    } catch (_) {}
  }
  return updated;
}

function findPaymentOrderByOutTradeNo(outTradeNo) {
  return mapPaymentOrderRow(
    db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payment_orders WHERE out_trade_no = ?`)
      .get(String(outTradeNo || "")),
  );
}

function findPaymentOrderByUserAndIdempotency(userId, idempotencyKey) {
  return mapPaymentOrderRow(
    db.prepare(`
      SELECT ${PAYMENT_COLUMNS} FROM payment_orders
      WHERE user_id = ? AND idempotency_key = ?
      ORDER BY id DESC LIMIT 1
    `).get(Number(userId), String(idempotencyKey || "")),
  );
}

function findPaymentOrdersByUser(userId, limit = 50) {
  return db.prepare(`
    SELECT ${PAYMENT_COLUMNS} FROM payment_orders
    WHERE user_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(Number(userId), Number(limit || 50)).map(mapPaymentOrderRow);
}

function findReconcilablePaymentOrders({ limit = 100, nowIso }) {
  const beforeExpiry = String(nowIso || new Date().toISOString());
  return db.prepare(`
    SELECT ${PAYMENT_COLUMNS} FROM payment_orders
    WHERE status IN ('created', 'pending')
      AND expires_at <= ?
    ORDER BY id ASC LIMIT ?
  `).all(beforeExpiry, Number(limit || 100)).map(mapPaymentOrderRow);
}

function findPendingPaymentOrders({ limit = 100 }) {
  return db.prepare(`
    SELECT ${PAYMENT_COLUMNS} FROM payment_orders
    WHERE status IN ('created', 'pending')
    ORDER BY id ASC LIMIT ?
  `).all(Number(limit || 100)).map(mapPaymentOrderRow);
}

function findOpenPaymentOrdersForReconcile({ limit = 100 }) {
  return db.prepare(`
    SELECT ${PAYMENT_COLUMNS} FROM payment_orders
    WHERE (status IN ('created', 'pending', 'expired', 'closed')
       OR (status = 'paid' AND fulfillment_status IN ('unfulfilled', 'processing')))
      AND audit_reason = ''
    ORDER BY id ASC LIMIT ?
  `).all(Number(limit || 100)).map(mapPaymentOrderRow);
}

function settlePaidPaymentOrder({ outTradeNo, tradeNo, nowIso }) {
  return runTransaction(() => {
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order) {
      throw Object.assign(new Error("订单不存在"), { code: "PAYMENT_ORDER_NOT_FOUND" });
    }
    if (order.status === "paid") {
      if (order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "processing") {
        const isWx = String(order.provider || "").toLowerCase() === "wxpay";
        const isV2 = Boolean(order.quoteId || isV2Plan(order.planId) || isV2Topup(order.planId));
        let assignedCreditEventId = null;
        if (isV2) {
          const fulfillResult = fulfillPaymentOrder(order, new Date(nowIso || order.paidAt || Date.now()).getTime(), db);
          if (fulfillResult.status === "fulfilled") {
            let creditDelta = order.planCredits;
            let actionType = isWx ? "wxpay_recharge" : "alipay_recharge";
            let actionLabel = isWx ? "微信支付充值" : "支付宝充值";
            let summary = `${order.planName}到账`;

            if (order.orderKind === "topup") {
              creditDelta = order.planCredits;
              actionType = "topup_purchase";
              actionLabel = "积分加油包购买";
              summary = `购买${order.planName}到账 ${order.planCredits} 积分`;
            } else if (order.orderAction === "upgrade") {
              creditDelta = order.issuedNow;
              actionType = "upgrade_grant";
              actionLabel = "套餐升级补发";
              summary = `升级至${order.planName}补发 ${order.issuedNow} 积分`;
            } else if (order.orderAction === "activate") {
              creditDelta = order.planCredits;
              actionType = "cycle_first_grant";
              actionLabel = "套餐首期积分";
              summary = `开通${order.planName}首期发放 ${order.planCredits} 积分`;
            }

            if (creditDelta > 0) {
              assignedCreditEventId = allocateCounter("nextCreditEventId", 1);
              db.prepare(`
                INSERT INTO credit_events (
                  id, user_id, action_type, action_label, credit_delta, credit_cost,
                  created_at, summary, payload_json
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
              `).run(
                assignedCreditEventId,
                Number(order.userId),
                actionType,
                actionLabel,
                Number(creditDelta),
                String(nowIso || order.paidAt || new Date().toISOString()),
                summary,
                JSON.stringify({
                  outTradeNo: order.outTradeNo,
                  planId: order.planId,
                  provider: order.provider,
                  orderKind: order.orderKind,
                  orderAction: order.orderAction,
                  issuedNow: order.issuedNow,
                }),
              );
            }
          }
        }
        return { order: findPaymentOrderByOutTradeNo(outTradeNo), alreadyPaid: true, recovered: true };
      }
      return { order, alreadyPaid: true };
    }
    const updated = db.prepare(`
      UPDATE payment_orders
      SET status = 'paid', trade_no = ?, paid_at = ?, updated_at = ?,
          last_notified_at = ?, notify_count = notify_count + 1
      WHERE out_trade_no = ? AND status IN ('created', 'pending', 'expired')
    `).run(String(tradeNo || ""), String(nowIso), String(nowIso), String(nowIso), String(outTradeNo || ""));
    if (updated.changes === 0) {
      return { order: findPaymentOrderByOutTradeNo(outTradeNo), alreadyPaid: true };
    }

    const isWx = String(order.provider || "").toLowerCase() === "wxpay";
    const isV2 = Boolean(order.quoteId || isV2Plan(order.planId) || isV2Topup(order.planId));
    let assignedCreditEventId = null;

    if (isV2) {
      const fulfillResult = fulfillPaymentOrder(order, new Date(nowIso).getTime(), db);
      if (fulfillResult.status === "fulfilled") {
        let creditDelta = order.planCredits;
        let actionType = isWx ? "wxpay_recharge" : "alipay_recharge";
        let actionLabel = isWx ? "微信支付充值" : "支付宝充值";
        let summary = `${order.planName}到账`;

        if (order.orderKind === "topup") {
          creditDelta = order.planCredits;
          actionType = "topup_purchase";
          actionLabel = "积分加油包购买";
          summary = `购买${order.planName}到账 ${order.planCredits} 积分`;
        } else if (order.orderAction === "upgrade") {
          creditDelta = order.issuedNow;
          actionType = "upgrade_grant";
          actionLabel = "套餐升级补发";
          summary = `升级至${order.planName}补发 ${order.issuedNow} 积分`;
        } else if (order.orderAction === "activate") {
          creditDelta = order.planCredits;
          actionType = "cycle_first_grant";
          actionLabel = "套餐首期积分";
          summary = `开通${order.planName}首期发放 ${order.planCredits} 积分`;
        }

        if (creditDelta > 0) {
          assignedCreditEventId = allocateCounter("nextCreditEventId", 1);
          db.prepare(`
            INSERT INTO credit_events (
              id, user_id, action_type, action_label, credit_delta, credit_cost,
              created_at, summary, payload_json
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
          `).run(
            assignedCreditEventId,
            Number(order.userId),
            actionType,
            actionLabel,
            Number(creditDelta),
            String(nowIso),
            summary,
            JSON.stringify({
              outTradeNo: order.outTradeNo,
              planId: order.planId,
              provider: order.provider,
              orderKind: order.orderKind,
              orderAction: order.orderAction,
              issuedNow: order.issuedNow,
            }),
          );
        }
      }
    } else {
      migrateLegacyUserCredits(order.userId, db);
      if (Number(order.planCredits) > 0) {
        createCreditLot({
          userId: Number(order.userId),
          sourceType: "legacy",
          sourceLabel: "历史保留积分",
          orderId: order.id,
          credits: Number(order.planCredits),
          startsAt: nowIso,
          expiresAt: null,
          nowIso,
        }, db);
      }
      db.prepare("UPDATE payment_orders SET fulfillment_status = 'fulfilled', fulfilled_at = ? WHERE id = ?")
        .run(nowIso, order.id);

      assignedCreditEventId = allocateCounter("nextCreditEventId", 1);
      const actionType = isWx ? "wxpay_recharge" : "alipay_recharge";
      const actionLabel = isWx ? "微信支付充值" : "支付宝充值";
      db.prepare(`
        INSERT INTO credit_events (
          id, user_id, action_type, action_label, credit_delta, credit_cost,
          created_at, summary, payload_json
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        assignedCreditEventId,
        Number(order.userId),
        actionType,
        actionLabel,
        Number(order.planCredits),
        String(nowIso),
        `充值 ${order.planCredits} 积分`,
        JSON.stringify({
          outTradeNo: order.outTradeNo,
          planId: order.planId,
          provider: order.provider,
        }),
      );
    }

    syncUserCreditsCache(order.userId, db);
    if (assignedCreditEventId) {
      db.prepare(`
        UPDATE payment_orders SET credit_event_id = ?
        WHERE out_trade_no = ? AND credit_event_id IS NULL
      `).run(assignedCreditEventId, String(outTradeNo || ""));
    }
    try {
      const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(order.userId);
      recordPaymentPaid({
        orderId: order.id,
        userId: order.userId,
        accountType: userRow?.account_type || "customer",
        amountFen: order.amountFen,
        planId: order.planId,
        planName: order.planName,
        planCredits: order.planCredits,
        provider: order.provider,
        paidAt: String(nowIso),
      });
    } catch (_) {}
    return { order: findPaymentOrderByOutTradeNo(outTradeNo), alreadyPaid: false };
  });
}

function closePaymentOrder({ userId, outTradeNo, nowIso }) {
  const result = db.prepare(`
    UPDATE payment_orders
    SET status = 'closed', updated_at = ?
    WHERE user_id = ? AND out_trade_no = ? AND status IN ('created', 'pending', 'expired')
  `).run(String(nowIso), Number(userId), String(outTradeNo || ""));
  if (result.changes === 0) return null;
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  try {
    const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(order.userId);
    recordPaymentClosed({
      orderId: order.id,
      userId: order.userId,
      accountType: userRow?.account_type || "customer",
      amountFen: order.amountFen,
      provider: order.provider,
      closedAt: String(nowIso),
    });
  } catch (_) {}
  return order;
}

function markPaymentOrderExpired({ outTradeNo, nowIso }) {
  const result = db.prepare(`
    UPDATE payment_orders
    SET status = 'expired', updated_at = ?
    WHERE out_trade_no = ? AND status IN ('created', 'pending')
  `).run(String(nowIso), String(outTradeNo || ""));
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  if (result.changes > 0 && order) {
    try {
      const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(order.userId);
      recordPaymentFailed({
        orderId: order.id,
        userId: order.userId,
        accountType: userRow?.account_type || "customer",
        amountFen: order.amountFen,
        provider: order.provider,
        error: "expired",
        failedAt: String(nowIso),
      });
    } catch (_) {}
  }
  return order;
}

function markPaymentOrderAudit({ outTradeNo, reason, nowIso, extraPayload = {} }) {
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  if (!order) return null;
  const payload = {
    ...order.payload,
    audit: {
      reason: String(reason || ""),
      at: String(nowIso),
      ...extraPayload,
    },
  };
  db.prepare(`
    UPDATE payment_orders
    SET audit_reason = ?, audit_at = ?, payload_json = ?, updated_at = ?,
        last_notified_at = ?, notify_count = notify_count + 1
    WHERE out_trade_no = ?
  `).run(
    String(reason || ""),
    String(nowIso),
    JSON.stringify(payload),
    String(nowIso),
    String(nowIso),
    String(outTradeNo || ""),
  );
  return findPaymentOrderByOutTradeNo(outTradeNo);
}

module.exports = {
  mapPaymentOrderRow,
  insertPaymentOrder,
  updatePaymentOrderStatus,
  findPaymentOrderByOutTradeNo,
  findPaymentOrderByUserAndIdempotency,
  findPaymentOrdersByUser,
  findReconcilablePaymentOrders,
  findPendingPaymentOrders,
  findOpenPaymentOrdersForReconcile,
  settlePaidPaymentOrder,
  closePaymentOrder,
  markPaymentOrderExpired,
  markPaymentOrderAudit,
};
