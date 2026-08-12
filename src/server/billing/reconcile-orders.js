"use strict";

// Reconcile Alipay payment orders against the provider. Settlement reuses the
// same atomic conditional update + unique constraints as the notify path.

const { fenToYuanString } = require("./money");
const {
  findOpenPaymentOrdersForReconcile,
  settlePaidPaymentOrder,
  closePaymentOrder,
  markPaymentOrderExpired,
  markPaymentOrderAudit,
} = require("../db/repositories/payment-repository");

async function reconcileOne(order, gateway, options = {}) {
  const nowIso = String(options.nowIso || new Date().toISOString());
  const dryRun = Boolean(options.dryRun);

  const result = await gateway.queryOrder(order.outTradeNo);
  const data = result?.data || {};
  const tradeStatus = String(data.trade_status || "");
  const isPaidAtProvider = tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED";
  const responseAppId = String(data.app_id ?? data.appId ?? "");
  const responseSellerId = String(data.seller_id ?? data.sellerId ?? "");
  if (
    (data.out_trade_no && String(data.out_trade_no) !== String(order.outTradeNo)) ||
    (isPaidAtProvider && String(data.out_trade_no || "") !== String(order.outTradeNo)) ||
    (responseAppId && gateway.appId && responseAppId !== String(gateway.appId)) ||
    (responseSellerId && gateway.sellerId && responseSellerId !== String(gateway.sellerId))
  ) {
    console.warn("[reconcile] provider identity mismatch", {
      outTradeNo: order.outTradeNo,
      actualOutTradeNo: String(data.out_trade_no || ""),
      appIdMatched: !responseAppId || !gateway.appId || responseAppId === String(gateway.appId),
      sellerIdMatched: !responseSellerId || !gateway.sellerId || responseSellerId === String(gateway.sellerId),
    });
    return "failed";
  }
  if (isPaidAtProvider) {
    const expectedAmount = fenToYuanString(order.amountFen);
    if (String(data.total_amount || "") !== expectedAmount) {
      console.warn("[reconcile] amount mismatch", {
        outTradeNo: order.outTradeNo,
        expected: expectedAmount,
        actual: String(data.total_amount || ""),
      });
      return "failed";
    }
    if (!data.trade_no) {
      console.warn("[reconcile] missing trade_no", { outTradeNo: order.outTradeNo });
      return "failed";
    }
    if (order.status === "closed") {
      if (!dryRun) {
        markPaymentOrderAudit({
          outTradeNo: order.outTradeNo,
          reason: "closed_provider_paid",
          nowIso,
          extraPayload: {
            tradeNo: String(data.trade_no),
            totalAmount: String(data.total_amount || ""),
          },
        });
      }
      return "audit";
    }
    if (dryRun) return "paid";
    settlePaidPaymentOrder({ outTradeNo: order.outTradeNo, tradeNo: String(data.trade_no), nowIso });
    return "paid";
  }
  if (tradeStatus === "TRADE_CLOSED") {
    if (order.status === "paid") return "paid";
    if (dryRun) return "closed";
    closePaymentOrder({ userId: order.userId, outTradeNo: order.outTradeNo, nowIso });
    return "closed";
  }
  if (tradeStatus === "WAIT_BUYER_PAY" || !tradeStatus) {
    if (
      order.expiresAt &&
      order.expiresAt <= nowIso &&
      order.status !== "closed"
    ) {
      if (dryRun) return "expired";
      markPaymentOrderExpired({ outTradeNo: order.outTradeNo, nowIso });
      return "expired";
    }
    return "pending";
  }
  return "unknown";
}

async function reconcileOrders({ gateway, limit = 100, dryRun = false, nowIso }) {
  const orders = findOpenPaymentOrdersForReconcile({ limit });
  const summary = {
    ok: true,
    dryRun,
    checked: orders.length,
    paid: 0,
    expired: 0,
    closed: 0,
    pending: 0,
    failed: 0,
    unknown: 0,
    audit: 0,
  };
  for (const order of orders) {
    try {
      const outcome = await reconcileOne(order, gateway, { dryRun, nowIso });
      summary[outcome] = Number(summary[outcome] || 0) + 1;
    } catch (error) {
      summary.failed = Number(summary.failed || 0) + 1;
      console.warn("[reconcile] order failed", {
        outTradeNo: order.outTradeNo,
        error: String(error?.message || error),
      });
    }
  }
  return summary;
}

module.exports = {
  reconcileOne,
  reconcileOrders,
};
