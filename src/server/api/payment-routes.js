"use strict";

const crypto = require("crypto");
const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { getAlipayProvider } = require("../integrations/alipay");
const { fenToYuanString } = require("../billing/money");
const {
  insertPaymentOrder,
  updatePaymentOrderStatus,
  findPaymentOrderByOutTradeNo,
  findPaymentOrderByUserAndIdempotency,
  findPaymentOrdersByUser,
  settlePaidPaymentOrder,
  closePaymentOrder,
  markPaymentOrderAudit,
} = require("../db/repositories/payment-repository");

const NOTIFY_SUCCESS = "success";
const NOTIFY_FAILURE = "failure";
const ORDER_EXPIRY_MS = 30 * 60 * 1000;

function createOutTradeNo() {
  return `redbase_${crypto.randomBytes(16).toString("hex")}`;
}

function sanitizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    outTradeNo: order.outTradeNo,
    planId: order.planId,
    planName: order.planName,
    planCredits: order.planCredits,
    amountYuan: fenToYuanString(order.amountFen),
    status: order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
  };
}

function collectRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) {
        reject(Object.assign(new Error("通知体过大"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, totalBytes).toString("utf8")));
    req.on("error", reject);
  });
}

function parseFormUrlEncoded(raw) {
  const params = {};
  for (const [key, value] of new URLSearchParams(String(raw || "")).entries()) {
    params[key] = value;
  }
  return params;
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end("");
}

function processAlipayNotify({ params, appConfig, gateway, nowIso }) {
  if (!gateway) return { ok: false, reason: "gateway_unavailable" };
  if (!gateway.verifyNotify(params)) return { ok: false, reason: "bad_signature" };
  const expectedAppId = String(gateway.appId || appConfig?.alipay?.appId || "");
  const expectedSellerId = String(gateway.sellerId || appConfig?.alipay?.sellerId || "");
  if (String(params.app_id || "") !== expectedAppId) return { ok: false, reason: "app_id_mismatch" };
  if (String(params.seller_id || "") !== expectedSellerId) return { ok: false, reason: "seller_id_mismatch" };
  const outTradeNo = String(params.out_trade_no || "");
  const tradeNo = String(params.trade_no || "");
  if (!outTradeNo || !tradeNo) return { ok: false, reason: "missing_trade_ids" };
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  if (!order) return { ok: false, reason: "unknown_order" };
  const expectedAmount = fenToYuanString(order.amountFen);
  if (String(params.total_amount || "") !== expectedAmount) {
    return { ok: false, reason: "amount_mismatch" };
  }
  const tradeStatus = String(params.trade_status || "");
  if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
    if (order.status === "closed") {
      // 本地已关闭但支付宝侧仍付款：绝不静默确认。记录人工审计并返回
      // failure，让支付宝持续重试，对账/人工可见。
      markPaymentOrderAudit({
        outTradeNo,
        reason: "closed_provider_paid",
        nowIso,
        extraPayload: {
          tradeNo,
          totalAmount: String(params.total_amount || ""),
        },
      });
      return { ok: false, reason: "order_closed_provider_paid" };
    }
    const settled = settlePaidPaymentOrder({ outTradeNo, tradeNo, nowIso });
    if (settled.order.status !== "paid") {
      markPaymentOrderAudit({
        outTradeNo,
        reason: "settle_blocked",
        nowIso,
        extraPayload: {
          tradeNo,
          status: settled.order.status,
          totalAmount: String(params.total_amount || ""),
        },
      });
      return { ok: false, reason: "settle_blocked" };
    }
    return { ok: true };
  }
  if (tradeStatus === "TRADE_CLOSED") {
    if (order.status !== "paid") {
      closePaymentOrder({ userId: order.userId, outTradeNo, nowIso });
    }
    return { ok: true };
  }
  if (tradeStatus === "WAIT_BUYER_PAY") {
    return { ok: true };
  }
  return { ok: false, reason: "unknown_trade_status" };
}

async function handlePaymentRoutes(context, req, res, pathname) {
  const scope = bindRouteScope(context);
  const {
    appConfig,
    collectBody,
    json,
    badRequest,
  } = scope;

  if (req.method === "GET" && pathname === "/api/billing/recharge-plans") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const gateway = getAlipayProvider(appConfig);
    if (appConfig?.alipay?.enabled !== true || !gateway) {
      // 回滚/关闭状态：彻底隐藏充值入口与测试结算能力；
      // 存量订单的通知、查单、对账与补账不受影响。
      json(res, 200, { plans: [], fakeSettle: false });
      return true;
    }
    const fakeSettle = Boolean(
      String(appConfig?.alipay?.provider || "") === "fake" &&
      process.env.NODE_ENV === "test",
    );
    const plans = (appConfig?.billing?.rechargePlans || []).map((plan) => ({
      id: plan.id,
      name: plan.name,
      credits: plan.credits,
      amountYuan: fenToYuanString(plan.amountFen),
    }));
    json(res, 200, { plans, fakeSettle });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/payments/alipay/orders") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const payload = await collectBody(req);
    const planId = String(payload?.planId || "").trim();
    const idempotencyKey = String(payload?.idempotencyKey || "").trim();
    if (!planId || !idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      badRequest(res, "套餐与幂等键不能为空");
      return true;
    }
    const plan = (appConfig?.billing?.rechargePlans || []).find((item) => item.id === planId);
    if (!plan) {
      badRequest(res, "充值套餐未配置或不存在");
      return true;
    }
    if (appConfig?.alipay?.enabled !== true) {
      json(res, 503, { error: "充值暂未开放" });
      return true;
    }
    const gateway = getAlipayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "充值暂未开放" });
      return true;
    }

    const existing = findPaymentOrderByUserAndIdempotency(user.id, idempotencyKey);
    if (existing) {
      const payUrl = gateway.createPayUrl({
        outTradeNo: existing.outTradeNo,
        subject: `RedBase ${existing.planName}`,
        totalAmount: fenToYuanString(existing.amountFen),
        returnUrl: appConfig?.alipay?.returnUrl || "",
        notifyUrl: appConfig?.alipay?.notifyUrl || "",
      });
      json(res, 200, { order: sanitizeOrder(existing), payUrl });
      return true;
    }

    const outTradeNo = createOutTradeNo();
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
    const order = insertPaymentOrder({
      outTradeNo,
      userId: user.id,
      idempotencyKey,
      plan,
      status: "created",
      nowIso,
      expiresAtIso,
    });
    const payUrl = gateway.createPayUrl({
      outTradeNo,
      subject: `RedBase ${plan.name}`,
      totalAmount: fenToYuanString(plan.amountFen),
      returnUrl: appConfig?.alipay?.returnUrl || "",
      notifyUrl: appConfig?.alipay?.notifyUrl || "",
    });
    updatePaymentOrderStatus({ outTradeNo, status: "pending", nowIso: new Date().toISOString() });
    json(res, 201, { order: sanitizeOrder(findPaymentOrderByOutTradeNo(outTradeNo)), payUrl });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments/alipay/return") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const params = Object.fromEntries(url.searchParams.entries());
    const gateway = getAlipayProvider(appConfig);
    const verified = gateway ? gateway.verifyNotify(params) : false;
    const outTradeNo = String(params.out_trade_no || "");
    const order = outTradeNo ? findPaymentOrderByOutTradeNo(outTradeNo) : null;
    const status = order?.status || (verified ? "pending" : "invalid");
    // 同步返回永不入账：只展示状态，入账仅由 notify/对账完成。
    redirect(res, `/app/billing?outTradeNo=${encodeURIComponent(outTradeNo)}&status=${encodeURIComponent(status)}`);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/payments/alipay/notify") {
    const raw = await collectRawBody(req);
    const params = parseFormUrlEncoded(raw);
    const gateway = getAlipayProvider(appConfig);
    let result;
    try {
      result = processAlipayNotify({
        params,
        appConfig,
        gateway,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("[alipay] notify processing failed", {
        outTradeNo: String(params.out_trade_no || ""),
        error: String(error?.message || error),
      });
      result = { ok: false, reason: "processing_error" };
    }
    text(res, 200, result.ok ? NOTIFY_SUCCESS : NOTIFY_FAILURE);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments/orders") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    json(res, 200, { orders: findPaymentOrdersByUser(user.id).map(sanitizeOrder) });
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/payments/orders/")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/orders/".length));
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    json(res, 200, { order: sanitizeOrder(order) });
    return true;
  }

  if (req.method === "POST" && pathname.startsWith("/api/payments/alipay/orders/") && pathname.endsWith("/close")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/alipay/orders/".length, -"/close".length));
    const existing = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!existing || existing.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (existing.status === "paid") {
      badRequest(res, "订单已支付，不能关闭");
      return true;
    }
    const gateway = getAlipayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "充值服务未配置，暂时无法关闭订单" });
      return true;
    }
    let closeResult;
    try {
      closeResult = await gateway.closeTrade(outTradeNo);
    } catch (error) {
      console.warn("[alipay] close failed", {
        outTradeNo,
        error: String(error?.message || error),
      });
      json(res, 502, { error: "关闭订单失败，请稍后重试" });
      return true;
    }
    if (closeResult?.alreadyPaid) {
      const nowIso = new Date().toISOString();
      const settled = settlePaidPaymentOrder({
        outTradeNo,
        tradeNo: String(closeResult.tradeNo || `FAKE${Date.now()}`),
        nowIso,
      });
      json(res, 200, { order: sanitizeOrder(settled.order), paidOnClose: true });
      return true;
    }
    const nowIso = new Date().toISOString();
    const closed = closePaymentOrder({ userId: user.id, outTradeNo, nowIso });
    const finalOrder = closed || findPaymentOrderByOutTradeNo(outTradeNo);
    json(res, 200, { order: sanitizeOrder(finalOrder) });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments/fake/alipay/settle") {
    const gateway = getAlipayProvider(appConfig);
    if (!gateway || String(appConfig?.alipay?.provider || "") !== "fake") {
      json(res, 404, { error: "Not found" });
      return true;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const outTradeNo = String(url.searchParams.get("outTradeNo") || "");
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    const tradeNo = String(url.searchParams.get("tradeNo") || `FAKE${Date.now()}`);
    const amountYuan = fenToYuanString(order.amountFen);
    gateway.settle({ outTradeNo, tradeNo, totalAmount: amountYuan });
    const params = gateway.buildNotifyParams({
      outTradeNo,
      tradeNo,
      totalAmount: amountYuan,
      tradeStatus: String(url.searchParams.get("status") || "TRADE_SUCCESS"),
    });
    const result = processAlipayNotify({
      params,
      appConfig,
      gateway,
      nowIso: new Date().toISOString(),
    });
    if (!result.ok) {
      json(res, 400, { ok: false, reason: result.reason });
      return true;
    }
    json(res, 200, { ok: true, order: sanitizeOrder(findPaymentOrderByOutTradeNo(outTradeNo)) });
    return true;
  }

  return false;
}

module.exports = {
  handlePaymentRoutes,
  processAlipayNotify,
  parseFormUrlEncoded,
  sanitizeOrder,
  createOutTradeNo,
};
