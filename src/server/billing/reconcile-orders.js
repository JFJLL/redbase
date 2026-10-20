"use strict";

// Reconcile payment orders against providers (Alipay and WeChat Pay).
// Settlement reuses the same atomic conditional update + unique constraints as notify.

const { fenToYuanString } = require("./money");
const { normalizeProviderPaidAt } = require("./period-utils");
const {
  findOpenPaymentOrdersForReconcile,
  findPaymentOrderByOutTradeNo,
  settlePaidPaymentOrder,
  closePaymentOrder,
  markPaymentOrderExpired,
  markPaymentOrderAudit,
} = require("../db/repositories/payment-repository");
const { isAlipayTradeNotExistError } = require("../integrations/alipay");

async function reconcileOne(order, gateway, options = {}) {
  const nowIso = String(options.nowIso || new Date().toISOString());
  const dryRun = Boolean(options.dryRun);

  let result = options.queryResult;
  if (!result) {
    try {
      result = await gateway.queryOrder(order.outTradeNo);
    } catch (error) {
      if (
        isAlipayTradeNotExistError(error) ||
        error?.code === "ALIPAY_TRADE_NOT_EXIST" ||
        error?.code === "ORDER_NOT_EXIST"
      ) {
        result = { data: {}, notFound: true, responseHttpStatus: 200 };
      } else {
        throw error;
      }
    }
  }

  const data = result?.data || {};
  const tradeStatus = String(data.trade_status || "");
  const isPaidAtProvider = tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED";
  const responseAppId = String(data.app_id ?? data.appId ?? data.appid ?? "");
  const responseSellerId = String(data.seller_id ?? data.sellerId ?? "");
  const responseMchId = String(data.mchid ?? data.mchId ?? "");

  const appIdMatched = !responseAppId || !gateway.appId || responseAppId === String(gateway.appId);
  const sellerIdMatched = !responseSellerId || !gateway.sellerId || responseSellerId === String(gateway.sellerId);
  const mchIdMatched = !responseMchId || !gateway.mchId || responseMchId === String(gateway.mchId);

  if (
    (data.out_trade_no && String(data.out_trade_no) !== String(order.outTradeNo)) ||
    (isPaidAtProvider && (!data.out_trade_no || String(data.out_trade_no) !== String(order.outTradeNo))) ||
    !appIdMatched ||
    !sellerIdMatched ||
    !mchIdMatched
  ) {
    console.warn("[reconcile] provider identity mismatch", {
      outTradeNo: order.outTradeNo,
      actualOutTradeNo: String(data.out_trade_no || ""),
      appIdMatched,
      sellerIdMatched,
      mchIdMatched,
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
    const latestOrder = findPaymentOrderByOutTradeNo(order.outTradeNo) || order;
    if (latestOrder.status === "closed") {
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
    const providerPaidAt = normalizeProviderPaidAt(data.send_pay_date || data.gmt_payment || data.success_time || data.paid_at || data.paidAt);
    settlePaidPaymentOrder({ outTradeNo: order.outTradeNo, tradeNo: String(data.trade_no), nowIso, providerPaidAt });
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

async function safeReconcileAndCloseOrder(order, gateway, options = {}) {
  const nowIso = String(options.nowIso || new Date().toISOString());
  const dryRun = Boolean(options.dryRun);

  if (!order) {
    return { ok: false, code: "ORDER_NOT_FOUND", message: "订单不存在" };
  }

  // Always work with latest order state from DB
  let currentOrder = findPaymentOrderByOutTradeNo(order.outTradeNo) || order;
  if (currentOrder.status === "paid") {
    return { ok: false, code: "ALREADY_PAID", message: "订单已支付，不能关闭", order: currentOrder, status: "paid" };
  }
  if (currentOrder.status === "closed") {
    return { ok: true, status: "closed", order: currentOrder };
  }

  // 1. Query provider first to check authoritative trade state
  let queryResult;
  try {
    queryResult = await gateway.queryOrder(currentOrder.outTradeNo);
  } catch (err) {
    if (
      isAlipayTradeNotExistError(err) ||
      err?.code === "ALIPAY_TRADE_NOT_EXIST" ||
      err?.code === "ORDER_NOT_EXIST"
    ) {
      queryResult = { notFound: true, data: {} };
    } else {
      console.warn("[safeReconcileAndCloseOrder] query failed", {
        outTradeNo: currentOrder.outTradeNo,
        error: String(err?.message || err),
      });
      return {
        ok: false,
        code: "PROVIDER_QUERY_FAILED",
        message: "关闭订单前确认支付状态失败，请稍后重试",
        order: currentOrder,
        status: currentOrder.status,
      };
    }
  }

  // Case A: Provider authoritatively reports trade does not exist
  if (queryResult?.notFound === true) {
    if (dryRun) {
      return { ok: true, status: "closed", providerTradeNotFound: true, order: currentOrder };
    }
    closePaymentOrder({ userId: currentOrder.userId, outTradeNo: currentOrder.outTradeNo, nowIso });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    return { ok: true, status: reRead.status, providerTradeNotFound: true, order: reRead };
  }

  const queryData = queryResult?.data || {};
  const tradeStatus = String(queryData.trade_status || "");

  // Case B: Provider trade is already paid or finished
  if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
    const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult, dryRun });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    if (outcome === "paid") {
      return { ok: true, status: reRead.status, reconciledOnClose: true, order: reRead };
    }
    if (outcome === "audit") {
      return { ok: false, code: "AUDIT_REQUIRED", message: "订单支付状态异常，需人工核查", order: reRead, status: reRead.status };
    }
    return { ok: false, code: "IDENTITY_MISMATCH", message: "订单支付状态异常，请稍后重试或联系客服", order: reRead, status: reRead.status };
  }

  // Case C: Provider trade is already closed
  if (tradeStatus === "TRADE_CLOSED") {
    const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult, dryRun });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    if (outcome === "closed") {
      return { ok: true, status: reRead.status, order: reRead };
    }
    return { ok: false, code: "IDENTITY_MISMATCH", message: "订单支付状态异常，请稍后重试或联系客服", order: reRead, status: reRead.status };
  }

  // Case D: Provider trade must be explicitly WAIT_BUYER_PAY
  if (tradeStatus !== "WAIT_BUYER_PAY") {
    return {
      ok: false,
      code: "UNKNOWN_PROVIDER_STATUS",
      message: "关闭订单前确认支付状态失败，请稍后重试",
      order: currentOrder,
      status: currentOrder.status,
    };
  }

  // Verify identity and validity using reconcileOne in dryRun mode before calling closeTrade!
  const preCheckOutcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult, dryRun: true });
  if (preCheckOutcome === "failed" || preCheckOutcome === "unknown") {
    return {
      ok: false,
      code: "IDENTITY_MISMATCH",
      message: "订单支付状态异常，请稍后重试或联系客服",
      order: currentOrder,
      status: currentOrder.status,
    };
  }

  // If dryRun, do NOT call closeTrade and do NOT write to DB
  if (dryRun) {
    return { ok: true, status: currentOrder.status, order: currentOrder };
  }

  // Attempt closeTrade on provider
  let closeResult;
  try {
    closeResult = await gateway.closeTrade(currentOrder.outTradeNo);
  } catch (closeErr) {
    // If closeTrade failed, run confirming query
    let confirmQuery;
    try {
      confirmQuery = await gateway.queryOrder(currentOrder.outTradeNo);
    } catch (qErr) {
      if (
        isAlipayTradeNotExistError(qErr) ||
        qErr?.code === "ALIPAY_TRADE_NOT_EXIST" ||
        qErr?.code === "ORDER_NOT_EXIST"
      ) {
        confirmQuery = { notFound: true, data: {} };
      } else {
        const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
        return {
          ok: false,
          code: "PROVIDER_CLOSE_FAILED",
          message: "关闭订单前确认支付状态失败，请稍后重试",
          order: reRead,
          status: reRead.status,
        };
      }
    }

    if (confirmQuery?.notFound) {
      closePaymentOrder({ userId: currentOrder.userId, outTradeNo: currentOrder.outTradeNo, nowIso });
      const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
      return { ok: true, status: reRead.status, providerTradeNotFound: true, order: reRead };
    }

    const confirmStatus = String(confirmQuery?.data?.trade_status || "");
    if (confirmStatus === "TRADE_CLOSED" || confirmStatus === "TRADE_SUCCESS" || confirmStatus === "TRADE_FINISHED") {
      const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult: confirmQuery, dryRun: false });
      const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
      if (outcome === "closed") {
        return { ok: true, status: reRead.status, order: reRead };
      }
      if (outcome === "paid") {
        return { ok: true, status: reRead.status, reconciledOnClose: true, order: reRead };
      }
    }

    if (confirmStatus === "WAIT_BUYER_PAY") {
      const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
      return {
        ok: false,
        code: "TRADE_WAIT_BUYER_PAY",
        message: "支付宝交易状态已变化，请刷新后重试",
        order: reRead,
        status: reRead.status,
      };
    }

    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    return {
      ok: false,
      code: "UNKNOWN_PROVIDER_STATUS",
      message: "关闭订单前确认支付状态失败，请稍后重试",
      order: reRead,
      status: reRead.status,
    };
  }

  // closeTrade returned; inspect closeResult
  if (closeResult?.alreadyPaid) {
    const normQueryResult = {
      data: {
        out_trade_no: String(closeResult.outTradeNo || closeResult.out_trade_no || ""),
        trade_no: String(closeResult.tradeNo || closeResult.trade_no || ""),
        trade_status: String(closeResult.tradeStatus || closeResult.trade_status || "TRADE_SUCCESS"),
        total_amount: String(closeResult.totalAmount || closeResult.total_amount || ""),
        app_id: String(closeResult.appId || closeResult.app_id || closeResult.appid || ""),
        seller_id: String(closeResult.sellerId || closeResult.seller_id || ""),
        mchid: String(closeResult.mchId || closeResult.mchid || ""),
        paid_at: String(closeResult.paidAt || closeResult.gmt_payment || closeResult.send_pay_date || closeResult.success_time || ""),
      },
      notFound: false,
    };
    const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult: normQueryResult, dryRun: false });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    if (outcome === "paid") {
      return { ok: true, status: reRead.status, paidOnClose: true, order: reRead };
    }
    return {
      ok: false,
      code: "IDENTITY_MISMATCH",
      message: "订单支付状态异常，请稍后重试或联系客服",
      order: reRead,
      status: reRead.status,
    };
  }

  const closeTradeStatus = String(closeResult?.tradeStatus || closeResult?.trade_status || "");
  if (closeTradeStatus === "TRADE_CLOSED") {
    closePaymentOrder({ userId: currentOrder.userId, outTradeNo: currentOrder.outTradeNo, nowIso });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    return { ok: true, status: reRead.status, order: reRead };
  }

  // If closeResult did not have explicit TRADE_CLOSED or alreadyPaid, verify with query
  let verifyQuery;
  try {
    verifyQuery = await gateway.queryOrder(currentOrder.outTradeNo);
  } catch (_) {}

  const verifyStatus = String(verifyQuery?.data?.trade_status || "");
  if (verifyStatus === "TRADE_CLOSED") {
    const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult: verifyQuery, dryRun: false });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    if (outcome === "closed") {
      return { ok: true, status: reRead.status, order: reRead };
    }
  }
  if (verifyStatus === "TRADE_SUCCESS" || verifyStatus === "TRADE_FINISHED") {
    const outcome = await reconcileOne(currentOrder, gateway, { nowIso, queryResult: verifyQuery, dryRun: false });
    const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
    if (outcome === "paid") {
      return { ok: true, status: reRead.status, reconciledOnClose: true, order: reRead };
    }
    if (outcome === "audit") {
      return { ok: false, code: "AUDIT_REQUIRED", message: "订单支付状态异常，需人工核查", order: reRead, status: reRead.status };
    }
    return { ok: false, code: "IDENTITY_MISMATCH", message: "订单支付状态异常，请稍后重试或联系客服", order: reRead, status: reRead.status };
  }

  const reRead = findPaymentOrderByOutTradeNo(currentOrder.outTradeNo) || currentOrder;
  return {
    ok: false,
    code: "UNKNOWN_PROVIDER_STATUS",
    message: "关闭订单前确认支付状态失败，请稍后重试",
    order: reRead,
    status: reRead.status,
  };
}

async function reconcileOrders({ gateway, gateways = {}, limit = 100, dryRun = false, nowIso }) {
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
    const orderProvider = order.provider || "alipay";
    const activeGateway = gateways[orderProvider] || gateway;
    if (!activeGateway) {
      summary.unknown = Number(summary.unknown || 0) + 1;
      continue;
    }
    try {
      const outcome = await reconcileOne(order, activeGateway, { dryRun, nowIso });
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
  safeReconcileAndCloseOrder,
};
