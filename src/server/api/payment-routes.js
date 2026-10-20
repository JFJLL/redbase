"use strict";

const crypto = require("crypto");
const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { getAlipayProvider, isAlipayTradeNotExistError } = require("../integrations/alipay");
const { getWxpayProvider } = require("../integrations/wxpay");
const { fenToYuanString } = require("../billing/money");
const { reconcileOne, safeReconcileAndCloseOrder } = require("../billing/reconcile-orders");
const { PLANS, TOPUPS, CATALOG_VERSION, getPlan, getTopup, getLegacyPlan } = require("../billing/catalog");
const { getNowTimestamp, getNowIso, formatShanghaiDate, normalizeProviderPaidAt } = require("../billing/period-utils");
const { createQuote, verifyAndConsumeQuote, findQuoteById } = require("../billing/quote-service");
const { getUserBillingOverview } = require("../billing/subscription-service");
const { rescanExpiredLots } = require("../billing/credit-ledger");
const { getDbProxy, transaction } = require("../db/connection");
const {
  insertPaymentOrder,
  updatePaymentOrderStatus,
  transitionPaymentOrderCreatedToPending,
  findPaymentOrderByOutTradeNo,
  findPaymentOrderByUserAndIdempotency,
  findPaymentOrdersByUser,
  settlePaidPaymentOrder,
  fulfillPaidOrderSafely,
  closePaymentOrder,
  markPaymentOrderExpired,
  markPaymentOrderAudit,
  mapPaymentOrderRow,
} = require("../db/repositories/payment-repository");

const NOTIFY_SUCCESS = "success";
const NOTIFY_FAILURE = "failure";
const ORDER_EXPIRY_MS = 30 * 60 * 1000;

function checkAndRefreshOrderPayable(order, nowIso = getNowIso()) {
  if (!order) return { payable: false, order: null };
  let current = order;
  if (
    (current.status === "created" || current.status === "pending") &&
    current.expiresAt &&
    current.expiresAt <= nowIso
  ) {
    markPaymentOrderExpired({ outTradeNo: current.outTradeNo, nowIso });
    current = findPaymentOrderByOutTradeNo(current.outTradeNo) || current;
  }
  const isPayable = (current.status === "created" || current.status === "pending") &&
    (!current.expiresAt || current.expiresAt > nowIso);
  return { payable: isPayable, order: current };
}

async function issuePaymentAccessSafely({
  order,
  gateway,
  provider,
  subject,
  appConfig,
  isNewOrder = false,
  res,
  scope,
  successStatusCode = 200,
}) {
  const nowIso = getNowIso();
  const preCheck = checkAndRefreshOrderPayable(order, nowIso);
  if (!preCheck.payable) {
    scope.json(res, 200, { order: sanitizeOrder(preCheck.order) });
    return true;
  }

  let paymentAccess;
  if (provider === "wxpay") {
    paymentAccess = await createWxpayPaymentAccess({
      gateway,
      outTradeNo: order.outTradeNo,
      description: subject,
      totalAmountFen: order.amountFen,
      notifyUrl: appConfig?.wxpay?.notifyUrl || "",
    });
  } else {
    paymentAccess = await createPaymentAccess({
      gateway,
      outTradeNo: order.outTradeNo,
      subject,
      totalAmount: fenToYuanString(order.amountFen),
      returnUrl: appConfig?.alipay?.returnUrl || "",
      notifyUrl: appConfig?.alipay?.notifyUrl || "",
    });
  }

  if (isNewOrder) {
    transitionPaymentOrderCreatedToPending({
      outTradeNo: order.outTradeNo,
      nowIso: getNowIso(),
    });
  }

  const postNowIso = getNowIso();
  const postCheck = checkAndRefreshOrderPayable(findPaymentOrderByOutTradeNo(order.outTradeNo), postNowIso);

  if (!postCheck.payable) {
    scope.json(res, 200, { order: sanitizeOrder(postCheck.order) });
    return true;
  }

  scope.json(res, successStatusCode, { order: sanitizeOrder(postCheck.order), ...paymentAccess });
  return true;
}

const inFlightReconcileOrders = new Set();
const reconcileAttemptCache = new Map();
const RECONCILE_RETRY_INTERVAL_MS = 60 * 1000;
const LIST_RECONCILE_LIMIT = 3;
const LIST_RECONCILE_TIMEOUT_MS = 1500;

function _resetReconcileCacheForTest() {
  inFlightReconcileOrders.clear();
  reconcileAttemptCache.clear();
}


function createOutTradeNo() {
  return `rb_${Date.now()}_${crypto.randomBytes(7).toString("hex")}`;
}

function sanitizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    outTradeNo: order.outTradeNo,
    planId: order.planId,
    planName: order.planName,
    planCredits: order.planCredits,
    amountFen: order.amountFen,
    amountYuan: fenToYuanString(order.amountFen),
    status: order.status,
    provider: order.provider || "alipay",
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    quoteId: order.quoteId || "",
    fulfillmentStatus: order.fulfillmentStatus || "unfulfilled",
    fulfilledAt: order.fulfilledAt || "",
    cycle: order.cycle || "",
    orderKind: order.orderKind || "plan",
    orderAction: order.orderAction || "activate",
    issuedNow: Number(order.issuedNow || 0),
    serviceStart: order.serviceStart || "",
    serviceEnd: order.serviceEnd || "",
    periodEnd: order.periodEnd || "",
  };
}

async function createPaymentAccess({ gateway, outTradeNo, subject, totalAmount, returnUrl, notifyUrl }) {
  const payUrl = gateway.createPayUrl({ outTradeNo, subject, totalAmount, returnUrl, notifyUrl });
  try {
    const qrCode = await gateway.createQrCode({ outTradeNo, subject, totalAmount, notifyUrl });
    return { payUrl, qrCode, qrCodeError: "" };
  } catch (error) {
    console.warn("[alipay] precreate failed", {
      outTradeNo,
      error: String(error?.message || error),
    });
    return {
      payUrl,
      qrCode: "",
      qrCodeError: "支付宝扫码支付暂不可用，请点击“打开支付宝付款”完成支付。",
    };
  }
}

async function createWxpayPaymentAccess({ gateway, outTradeNo, description, totalAmountFen, notifyUrl }) {
  try {
    const qrCode = await gateway.createQrCode({ outTradeNo, description, totalAmountFen, notifyUrl });
    const payUrl = typeof gateway.createPayUrl === "function" ? gateway.createPayUrl({ outTradeNo }) : "";
    return { payUrl, qrCode, qrCodeError: "" };
  } catch (error) {
    const detail = String(error?.message || error || "微信扫码支付暂不可用，请稍后重试。");
    console.warn("[wxpay] createQrCode failed", {
      outTradeNo,
      error: detail,
    });
    return {
      payUrl: "",
      qrCode: "",
      qrCodeError: detail,
    };
  }
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
    const providerPaidAt = normalizeProviderPaidAt(params.gmt_payment || params.notify_time);
    const settled = settlePaidPaymentOrder({ outTradeNo, tradeNo, nowIso, providerPaidAt });
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

function processWxpayNotify({ headers, rawBody, appConfig, gateway, nowIso }) {
  if (!gateway) return { ok: false, reason: "gateway_unavailable" };
  if (!gateway.verifyNotify({ headers, rawBody })) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return { ok: false, reason: "invalid_json" };
  }
  if (!payload?.resource) {
    return { ok: false, reason: "missing_resource" };
  }
  let decrypted;
  try {
    decrypted = gateway.decryptNotifyResource(payload.resource);
  } catch (error) {
    return { ok: false, reason: "decrypt_failed" };
  }
  const expectedAppId = String(gateway.appId || appConfig?.wxpay?.appId || "");
  const expectedMchId = String(gateway.mchId || appConfig?.wxpay?.mchId || "");
  if (expectedAppId && String(decrypted.appid || "") !== expectedAppId) {
    return { ok: false, reason: "app_id_mismatch" };
  }
  if (expectedMchId && String(decrypted.mchid || "") !== expectedMchId) {
    return { ok: false, reason: "mch_id_mismatch" };
  }
  const outTradeNo = String(decrypted.out_trade_no || "");
  const tradeNo = String(decrypted.transaction_id || "");
  if (!outTradeNo || !tradeNo) {
    return { ok: false, reason: "missing_trade_ids" };
  }
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  if (!order) return { ok: false, reason: "unknown_order" };
  const expectedFen = Number(order.amountFen);
  const actualFen = Number(decrypted.amount?.total ?? decrypted.amount_fen ?? 0);
  if (actualFen !== expectedFen) {
    return { ok: false, reason: "amount_mismatch" };
  }
  const tradeState = String(decrypted.trade_state || "").toUpperCase();
  if (tradeState === "SUCCESS") {
    if (order.status === "closed") {
      markPaymentOrderAudit({
        outTradeNo,
        reason: "closed_provider_paid",
        nowIso,
        extraPayload: {
          tradeNo,
          amountFen: actualFen,
        },
      });
      return { ok: false, reason: "order_closed_provider_paid" };
    }
    const providerPaidAt = normalizeProviderPaidAt(decrypted.success_time);
    const settled = settlePaidPaymentOrder({ outTradeNo, tradeNo, nowIso, providerPaidAt });
    if (settled.order.status !== "paid") {
      markPaymentOrderAudit({
        outTradeNo,
        reason: "settle_blocked",
        nowIso,
        extraPayload: {
          tradeNo,
          status: settled.order.status,
          amountFen: actualFen,
        },
      });
      return { ok: false, reason: "settle_blocked" };
    }
    return { ok: true };
  }
  if (tradeState === "CLOSED" || tradeState === "REVOKED") {
    if (order.status !== "paid") {
      closePaymentOrder({ userId: order.userId, outTradeNo, nowIso });
    }
    return { ok: true };
  }
  if (tradeState === "NOTPAY" || tradeState === "USERPAYING") {
    return { ok: true };
  }
  return { ok: false, reason: "unknown_trade_state" };
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
    const alipayGateway = getAlipayProvider(appConfig);
    const wxpayGateway = getWxpayProvider(appConfig);
    const alipayEnabled = appConfig?.alipay?.enabled === true && (Boolean(alipayGateway) || appConfig?.alipay?.provider !== "disabled");
    const wxpayEnabled = appConfig?.wxpay?.enabled === true && (Boolean(wxpayGateway) || appConfig?.wxpay?.provider !== "disabled");
    if (!alipayEnabled && !wxpayEnabled) {
      json(res, 200, { plans: [], fakeSettle: false, providers: { alipay: false, wxpay: false } });
      return true;
    }
    const fakeSettle = Boolean(
      (
        (String(appConfig?.alipay?.provider || "") === "fake" && alipayEnabled) ||
        (String(appConfig?.wxpay?.provider || "") === "fake" && wxpayEnabled)
      ) && process.env.NODE_ENV === "test",
    );
    const isTestOverride = process.env.NODE_ENV === "test" && (appConfig?.billing?.rechargePlans || []).length > 0;
    const resolvedPlans = isTestOverride
      ? (appConfig?.billing?.rechargePlans || []).map((plan) => ({
          id: plan.id,
          name: plan.name,
          credits: plan.credits,
          amountYuan: fenToYuanString(plan.amountFen),
        }))
      : PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        credits: p.credits,
        amountYuan: fenToYuanString(p.monthlyFen),
        monthlyFen: p.monthlyFen,
        annualFen: p.annualFen,
        label: p.label,
        desc: p.desc,
        icon: p.icon,
        featured: p.featured,
      }));
    json(res, 200, {
      plans: resolvedPlans,
      topups: TOPUPS,
      v2Catalog: {
        plans: PLANS,
        topups: TOPUPS,
        version: CATALOG_VERSION,
      },
      fakeSettle,
      providers: {
        alipay: alipayEnabled,
        wxpay: wxpayEnabled,
      },
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/billing/wallet") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const overview = getUserBillingOverview(user.id);
    json(res, 200, overview);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/billing/quote") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const payload = await collectBody(req);
    const kind = String(payload?.kind || "plan").trim();
    const itemId = String(payload?.itemId || "").trim();
    const cycle = String(payload?.cycle || "monthly").trim();
    try {
      const quote = createQuote({ userId: user.id, kind, itemId, cycle });
      json(res, 200, { quote });
    } catch (err) {
      badRequest(res, err.message || "报价生成失败");
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/billing/ledger") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const url = new URL(req.url, "http://localhost");
    const filter = url.searchParams.get("filter") || "all";
    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const db = getDbProxy();
    rescanExpiredLots(user.id);
    const events = db.prepare(`
      SELECT * FROM credit_events
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 300
    `).all(user.id);

    const allocations = db.prepare(`
      SELECT a.*, l.source_type, l.source_label, l.expires_at
      FROM credit_lot_allocations a
      JOIN credit_lots l ON l.id = a.lot_id
      WHERE a.user_id = ?
    `).all(user.id);

    const allocMap = new Map();
    for (const a of allocations) {
      if (!allocMap.has(a.credit_event_id)) allocMap.set(a.credit_event_id, []);
      allocMap.get(a.credit_event_id).push(a);
    }

    const rows = events.map((event) => {
      const delta = Number(event.credit_delta || 0);
      let type = "grant";
      if (event.action_type.includes("expire")) {
        type = "expire";
      } else if (delta < 0) {
        type = "spend";
      }

      let source = "本期积分";
      const allocs = allocMap.get(event.id);
      if (allocs && allocs.length > 0) {
        const hasPermanent = allocs.some((a) => a.expires_at === null);
        const hasExpiring = allocs.some((a) => a.expires_at !== null);
        if (hasPermanent && !hasExpiring) source = "永久积分";
        else if (!hasPermanent && hasExpiring) source = "本期积分";
        else source = "混合积分";
      } else {
        const action = event.action_type.toLowerCase();
        if (action.includes("topup") || action.includes("legacy") || action.includes("admin")) {
          source = "永久积分";
        } else if (action.includes("upgrade") || action.includes("cycle")) {
          source = "本期积分";
        } else if (delta < 0) {
          source = "本期积分";
        } else {
          source = "永久积分";
        }
      }

      return {
        id: event.id,
        time: formatShanghaiDate(event.created_at),
        label: event.action_label || event.summary,
        delta,
        source,
        note: event.summary || "",
        type,
      };
    }).filter((r) => {
      if (filter !== "all" && r.type !== filter) return false;
      if (query) {
        const text = `${r.time} ${r.label} ${r.source} ${r.note}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
    const total = rows.length;
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    json(res, 200, { rows: pagedRows, total, page, pageSize });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/billing/ledger/export") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const url = new URL(req.url, "http://localhost");
    const filter = url.searchParams.get("filter") || "all";
    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const db = getDbProxy();
    rescanExpiredLots(user.id);
    const events = db.prepare(`
      SELECT * FROM credit_events
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1000
    `).all(user.id);

    const allocations = db.prepare(`
      SELECT a.*, l.source_type, l.source_label, l.expires_at
      FROM credit_lot_allocations a
      JOIN credit_lots l ON l.id = a.lot_id
      WHERE a.user_id = ?
    `).all(user.id);

    const allocMap = new Map();
    for (const a of allocations) {
      if (!allocMap.has(a.credit_event_id)) allocMap.set(a.credit_event_id, []);
      allocMap.get(a.credit_event_id).push(a);
    }

    const rows = events.map((event) => {
      const delta = Number(event.credit_delta || 0);
      let type = "grant";
      if (event.action_type.includes("expire")) {
        type = "expire";
      } else if (delta < 0) {
        type = "spend";
      }

      let source = "本期积分";
      const allocs = allocMap.get(event.id);
      if (allocs && allocs.length > 0) {
        const hasPermanent = allocs.some((a) => a.expires_at === null);
        const hasExpiring = allocs.some((a) => a.expires_at !== null);
        if (hasPermanent && !hasExpiring) source = "永久积分";
        else if (!hasPermanent && hasExpiring) source = "本期积分";
        else source = "混合积分";
      } else {
        const action = event.action_type.toLowerCase();
        if (action.includes("topup") || action.includes("legacy") || action.includes("admin")) {
          source = "永久积分";
        } else if (action.includes("upgrade") || action.includes("cycle")) {
          source = "本期积分";
        } else if (delta < 0) {
          source = "本期积分";
        } else {
          source = "永久积分";
        }
      }

      return {
        time: formatShanghaiDate(event.created_at),
        label: event.action_label || event.summary,
        delta: `${delta > 0 ? "+" : ""}${delta}`,
        source,
        note: event.summary || "",
        type,
      };
    }).filter((r) => {
      if (filter !== "all" && r.type !== filter) return false;
      if (query) {
        const text = `${r.time} ${r.label} ${r.source} ${r.note}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });

    const escapeCsv = (str) => {
      let val = String(str ?? "");
      if (/^[=+\-@\t\r]/.test(val)) {
        val = "'" + val;
      }
      return `"${val.replace(/"/g, '""')}"`;
    };

    const header = ["时间", "操作", "积分变化", "积分来源", "说明"].map(escapeCsv).join(",");
    const body = rows.map((r) => [r.time, r.label, r.delta, r.source, r.note].map(escapeCsv).join(",")).join("\r\n");
    const csv = "\uFEFF" + header + "\r\n" + body;

    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="RedBase-credits-ledger.csv"',
    });
    res.end(csv);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/payments/alipay/orders") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const payload = await collectBody(req);
    const quoteId = String(payload?.quoteId || "").trim();
    const planId = String(payload?.planId || "").trim();
    const idempotencyKey = String(payload?.idempotencyKey || "").trim();
    if ((!quoteId && !planId) || !idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      badRequest(res, "套餐/报价与幂等键不能为空");
      return true;
    }

    // 1. Check provider availability first before consuming any quote
    if (appConfig?.alipay?.enabled !== true) {
      json(res, 503, { error: "充值暂未开放" });
      return true;
    }
    const gateway = getAlipayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "充值暂未开放" });
      return true;
    }

    // 2. Check existing order by idempotency key
    const existing = findPaymentOrderByUserAndIdempotency(user.id, idempotencyKey);
    if (existing) {
      if (existing.provider && existing.provider !== "alipay") {
        badRequest(res, "该幂等键已被其他支付渠道的订单使用，不能跨渠道重用");
        return true;
      }
      if (quoteId && existing.quoteId && existing.quoteId !== quoteId) {
        json(res, 409, { error: "幂等键已被其它报价订单使用，请勿混用幂等键" });
        return true;
      }
      if (planId && existing.planId !== planId) {
        json(res, 409, { error: "幂等键已被其它套餐订单使用，请勿混用幂等键" });
        return true;
      }
      return await issuePaymentAccessSafely({
        order: existing,
        gateway,
        provider: "alipay",
        subject: `RedBase ${existing.planName}`,
        appConfig,
        isNewOrder: false,
        res,
        scope,
        successStatusCode: 200,
      });
    }

    const db = getDbProxy();
    const nowIso = getNowIso();
    let order;
    let consumedQuote;
    let plan = null;

    if (quoteId) {
      const quote = findQuoteById(quoteId);
      if (!quote) {
        badRequest(res, "报价不存在或已失效，请重新确认套餐与价格");
        return true;
      }
      if (quote.kind === "plan") {
        let activePending = db.prepare(`
          SELECT * FROM payment_orders
          WHERE user_id = ? AND order_kind = 'plan'
            AND (
              status IN ('created', 'pending', 'expired')
              OR (status = 'paid' AND (fulfillment_status IN ('unfulfilled', 'processing', 'scheduled', 'audit_required') OR audit_reason <> ''))
            )
          ORDER BY id DESC LIMIT 1
        `).get(user.id);

        if (activePending) {
          const isStale = (activePending.status === "expired" || activePending.expires_at <= nowIso)
            && ["created", "pending", "expired"].includes(activePending.status);
          if (isStale) {
            const staleOrder = mapPaymentOrderRow(activePending);
            const orderProvider = staleOrder.provider || "alipay";
            const targetGateway = orderProvider === "wxpay"
              ? getWxpayProvider(appConfig)
              : getAlipayProvider(appConfig);
            if (targetGateway) {
              try {
                await safeReconcileAndCloseOrder(staleOrder, targetGateway, { nowIso, user });
              } catch (err) {
                console.warn("[alipay:createOrder] auto-reconcile stale order failed", {
                  outTradeNo: staleOrder.outTradeNo,
                  error: err?.message || err,
                });
              }
            }
            activePending = db.prepare(`
              SELECT * FROM payment_orders
              WHERE user_id = ? AND order_kind = 'plan'
                AND (
                  status IN ('created', 'pending', 'expired')
                  OR (status = 'paid' AND (fulfillment_status IN ('unfulfilled', 'processing', 'scheduled', 'audit_required') OR audit_reason <> ''))
                )
              ORDER BY id DESC LIMIT 1
            `).get(user.id);
          }
        }

        if (activePending) {
          json(res, 409, {
            error: "当前账户已有进行中或待生效的套餐订单，请先完成、生效或取消原订单",
            pendingOrder: sanitizeOrder(mapPaymentOrderRow(activePending)),
          });
          return true;
        }
      }
    } else {
      badRequest(res, "充值套餐必须通过服务端报价下单，历史商品已停止新售");
      return true;
    }

    try {
      transaction(() => {
        consumedQuote = verifyAndConsumeQuote(quoteId, user.id);
        const outTradeNo = createOutTradeNo();
        const expiresAtIso = consumedQuote.expires_at || new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
          const orderPlan = {
          id: consumedQuote.item_id,
          name: consumedQuote.meta?.planName || consumedQuote.meta?.topupName || consumedQuote.item_id,
          credits: consumedQuote.issued_now,
          amountFen: consumedQuote.amount_fen,
        };
        order = insertPaymentOrder({
          outTradeNo,
          userId: user.id,
          idempotencyKey,
            plan: orderPlan,
          status: "created",
          provider: "alipay",
          nowIso,
          expiresAtIso,
          quote: consumedQuote,
          acquireLock: true,
        });
      })();
    } catch (err) {
      if (err.code === "PLAN_ORDER_CONFLICT") {
        json(res, 409, {
          error: err.message,
          pendingOrder: err.pendingOrder ? sanitizeOrder(err.pendingOrder) : null,
        });
        return true;
      }
      badRequest(res, err.message || "报价消费或创建订单失败");
      return true;
    }

    return await issuePaymentAccessSafely({
      order,
      gateway,
      provider: "alipay",
      subject: `RedBase ${order.planName}`,
      appConfig,
      isNewOrder: true,
      res,
      scope,
      successStatusCode: 201,
    });
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

  if (req.method === "POST" && pathname === "/api/payments/wxpay/orders") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const payload = await collectBody(req);
    const quoteId = String(payload?.quoteId || "").trim();
    const planId = String(payload?.planId || "").trim();
    const idempotencyKey = String(payload?.idempotencyKey || "").trim();
    if ((!quoteId && !planId) || !idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      badRequest(res, "套餐/报价与幂等键不能为空");
      return true;
    }

    // 1. Check provider availability first
    if (appConfig?.wxpay?.enabled !== true) {
      json(res, 503, { error: "微信支付充值暂未开放" });
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 400, { error: "微信支付商户信息尚未配置，请在 config.local.json 中填入微信支付参数" });
      return true;
    }

    // 2. Check existing order by idempotency key
    const existing = findPaymentOrderByUserAndIdempotency(user.id, idempotencyKey);
    if (existing) {
      if (existing.provider && existing.provider !== "wxpay") {
        badRequest(res, "该幂等键已被其他支付渠道的订单使用，不能跨渠道重用");
        return true;
      }
      if (quoteId && existing.quoteId && existing.quoteId !== quoteId) {
        json(res, 409, { error: "幂等键已被其它报价订单使用，请勿混用幂等键" });
        return true;
      }
      if (planId && existing.planId !== planId) {
        json(res, 409, { error: "幂等键已被其它套餐订单使用，请勿混用幂等键" });
        return true;
      }
      return await issuePaymentAccessSafely({
        order: existing,
        gateway,
        provider: "wxpay",
        subject: `RedBase ${existing.planName}`,
        appConfig,
        isNewOrder: false,
        res,
        scope,
        successStatusCode: 200,
      });
    }

    const db = getDbProxy();
    const nowIso = getNowIso();
    let order;
    let consumedQuote;
    let plan = null;

    if (quoteId) {
      const quote = findQuoteById(quoteId);
      if (!quote) {
        badRequest(res, "报价不存在或已失效，请重新确认套餐与价格");
        return true;
      }
      if (quote.kind === "plan") {
        let activePending = db.prepare(`
          SELECT * FROM payment_orders
          WHERE user_id = ? AND order_kind = 'plan'
            AND (
              status IN ('created', 'pending', 'expired')
              OR (status = 'paid' AND (fulfillment_status IN ('unfulfilled', 'processing', 'scheduled', 'audit_required') OR audit_reason <> ''))
            )
          ORDER BY id DESC LIMIT 1
        `).get(user.id);

        if (activePending) {
          const isStale = (activePending.status === "expired" || activePending.expires_at <= nowIso)
            && ["created", "pending", "expired"].includes(activePending.status);
          if (isStale) {
            const staleOrder = mapPaymentOrderRow(activePending);
            const orderProvider = staleOrder.provider || "alipay";
            const targetGateway = orderProvider === "wxpay"
              ? getWxpayProvider(appConfig)
              : getAlipayProvider(appConfig);
            if (targetGateway) {
              try {
                await safeReconcileAndCloseOrder(staleOrder, targetGateway, { nowIso, user });
              } catch (err) {
                console.warn("[alipay:createOrder] auto-reconcile stale order failed", {
                  outTradeNo: staleOrder.outTradeNo,
                  error: err?.message || err,
                });
              }
            }
            activePending = db.prepare(`
              SELECT * FROM payment_orders
              WHERE user_id = ? AND order_kind = 'plan'
                AND (
                  status IN ('created', 'pending', 'expired')
                  OR (status = 'paid' AND (fulfillment_status IN ('unfulfilled', 'processing', 'scheduled', 'audit_required') OR audit_reason <> ''))
                )
              ORDER BY id DESC LIMIT 1
            `).get(user.id);
          }
        }

        if (activePending) {
          json(res, 409, {
            error: "当前账户已有进行中或待生效的套餐订单，请先完成、生效或取消原订单",
            pendingOrder: sanitizeOrder(mapPaymentOrderRow(activePending)),
          });
          return true;
        }
      }
    } else {
      badRequest(res, "充值套餐必须通过服务端报价下单，历史商品已停止新售");
      return true;
    }

    try {
      transaction(() => {
        consumedQuote = verifyAndConsumeQuote(quoteId, user.id);
        const outTradeNo = createOutTradeNo();
        const expiresAtIso = consumedQuote.expires_at || new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
          const orderPlan = {
          id: consumedQuote.item_id,
          name: consumedQuote.meta?.planName || consumedQuote.meta?.topupName || consumedQuote.item_id,
          credits: consumedQuote.issued_now,
          amountFen: consumedQuote.amount_fen,
        };
        order = insertPaymentOrder({
          outTradeNo,
          userId: user.id,
          idempotencyKey,
            plan: orderPlan,
          status: "created",
          provider: "wxpay",
          nowIso,
          expiresAtIso,
          quote: consumedQuote,
          acquireLock: true,
        });
      })();
    } catch (err) {
      if (err.code === "PLAN_ORDER_CONFLICT") {
        json(res, 409, {
          error: err.message,
          pendingOrder: err.pendingOrder ? sanitizeOrder(err.pendingOrder) : null,
        });
        return true;
      }
      badRequest(res, err.message || "报价消费或创建订单失败");
      return true;
    }

    return await issuePaymentAccessSafely({
      order,
      gateway,
      provider: "wxpay",
      subject: `RedBase ${order.planName}`,
      appConfig,
      isNewOrder: true,
      res,
      scope,
      successStatusCode: 201,
    });
  }

  if (req.method === "POST" && pathname === "/api/payments/wxpay/notify") {
    const rawBody = await collectRawBody(req);
    const gateway = getWxpayProvider(appConfig);
    let result;
    try {
      result = processWxpayNotify({
        headers: req.headers,
        rawBody,
        appConfig,
        gateway,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("[wxpay] notify processing failed", {
        error: String(error?.message || error),
      });
      result = { ok: false, reason: "processing_error" };
    }
    if (result.ok) {
      json(res, 200, { code: "SUCCESS", message: "成功" });
    } else {
      json(res, 400, { code: "FAIL", message: result.reason || "处理失败" });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments/orders") {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const nowIso = getNowIso();
    const db = getDbProxy();

    // 1. Fast local sweep: mark locally expired orders using repository method to record audit facts
    const expiredLocally = db.prepare(`
      SELECT out_trade_no FROM payment_orders
      WHERE user_id = ? AND status IN ('created', 'pending') AND expires_at <= ?
    `).all(Number(user.id), nowIso);

    for (const row of expiredLocally) {
      markPaymentOrderExpired({ outTradeNo: row.out_trade_no, nowIso });
    }

    // 2. Select candidates for provider reconciliation (最多3条按最近尝试排序)
    const candidates = db.prepare(`
      SELECT * FROM payment_orders
      WHERE user_id = ?
        AND (
          status = 'expired'
          OR (status IN ('created', 'pending') AND expires_at <= ?)
        )
      ORDER BY id ASC
    `).all(Number(user.id), nowIso).map(mapPaymentOrderRow);

    const nowMs = Date.now();
    const eligible = [];
    for (const cand of candidates) {
      if (inFlightReconcileOrders.has(cand.outTradeNo)) continue;
      const lastAttempt = reconcileAttemptCache.get(cand.outTradeNo) || 0;
      if (nowMs - lastAttempt < RECONCILE_RETRY_INTERVAL_MS) continue;
      eligible.push({ cand, lastAttempt });
    }

    eligible.sort((a, b) => a.lastAttempt - b.lastAttempt || a.cand.id - b.cand.id);
    const toReconcile = eligible.slice(0, LIST_RECONCILE_LIMIT).map((e) => e.cand);

    if (toReconcile.length > 0) {
      for (const cand of toReconcile) {
        inFlightReconcileOrders.add(cand.outTradeNo);
        reconcileAttemptCache.set(cand.outTradeNo, nowMs);
      }

      const reconcileTask = Promise.allSettled(
        toReconcile.map(async (cand) => {
          try {
            const providerName = cand.provider || "alipay";
            const gateway = providerName === "wxpay"
              ? getWxpayProvider(appConfig)
              : getAlipayProvider(appConfig);
            if (gateway) {
              const closeRes = await safeReconcileAndCloseOrder(cand, gateway, { nowIso, user });
              if (closeRes?.status === "closed" || closeRes?.status === "paid") {
                reconcileAttemptCache.delete(cand.outTradeNo);
              }
            }
          } catch (_) {
          } finally {
            inFlightReconcileOrders.delete(cand.outTradeNo);
          }
        })
      );

      let timerId;
      const timeoutPromise = new Promise((resolve) => {
        timerId = setTimeout(resolve, LIST_RECONCILE_TIMEOUT_MS);
      });
      await Promise.race([reconcileTask, timeoutPromise]);
      clearTimeout(timerId);
    }

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

  if (req.method === "POST" && pathname.startsWith("/api/payments/alipay/orders/") && pathname.endsWith("/pay-link")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/alipay/orders/".length, -"/pay-link".length));
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (order.provider && order.provider !== "alipay") {
      badRequest(res, "订单支付渠道不匹配");
      return true;
    }
    const preCheck = checkAndRefreshOrderPayable(order, getNowIso());
    if (!preCheck.payable) {
      badRequest(res, "当前订单不能继续支付");
      return true;
    }
    const gateway = getAlipayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "充值服务未配置" });
      return true;
    }
    return await issuePaymentAccessSafely({
      order: preCheck.order,
      gateway,
      provider: "alipay",
      subject: `RedBase ${order.planName}`,
      appConfig,
      isNewOrder: false,
      res,
      scope,
      successStatusCode: 200,
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/payments/alipay/orders/") && pathname.endsWith("/check")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/alipay/orders/".length, -"/check".length));
    let order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (order.provider && order.provider !== "alipay") {
      badRequest(res, "订单支付渠道不匹配");
      return true;
    }
    if (
      order.status === "paid" &&
      (order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "processing") &&
      !order.auditReason &&
      order.fulfillmentStatus !== "audit_required"
    ) {
      try {
        fulfillPaidOrderSafely({ outTradeNo: order.outTradeNo, nowIso: getNowIso() });
      } catch (err) {
        console.warn("[alipay:check] retry fulfillment failed", { outTradeNo: order.outTradeNo, error: err?.message || err });
      }
      order = findPaymentOrderByOutTradeNo(outTradeNo) || order;
    }
    const isReconcilableAlipay = order.status === "created" || order.status === "pending" || order.status === "expired";
    if (isReconcilableAlipay) {
      const gateway = getAlipayProvider(appConfig);
      if (!gateway) {
        json(res, 503, { error: "充值服务未配置" });
        return true;
      }
      try {
        const outcome = await reconcileOne(order, gateway, { nowIso: new Date().toISOString() });
        if (outcome === "failed" || outcome === "unknown" || outcome === "audit") {
          console.warn("[alipay] active order check returned an unsafe outcome", { outTradeNo, outcome });
          json(res, 502, { error: "支付状态异常，请稍后重试或联系客服" });
          return true;
        }
      } catch (error) {
        console.warn("[alipay] active order check failed", {
          outTradeNo,
          error: String(error?.message || error),
        });
        const detail = String(error?.message || "");
        const isExplicitError = detail.includes("IP") || detail.includes("支付宝");
        json(res, 502, { error: isExplicitError ? detail : "支付状态查询失败，请稍后重试" });
        return true;
      }
      order = findPaymentOrderByOutTradeNo(outTradeNo);
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
    if (existing.provider && existing.provider !== "alipay") {
      badRequest(res, "订单支付渠道不匹配");
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
    const nowIso = getNowIso();
    const result = await safeReconcileAndCloseOrder(existing, gateway, { nowIso, user });
    if (!result.ok) {
      if (result.code === "TRADE_WAIT_BUYER_PAY") {
        json(res, 409, { error: "支付宝交易状态已变化，请刷新后重试", order: sanitizeOrder(result.order) });
        return true;
      }
      if (result.code === "IDENTITY_MISMATCH" || result.code === "AMOUNT_MISMATCH" || result.code === "AUDIT_REQUIRED") {
        json(res, 502, { error: "订单支付状态异常，请稍后重试或联系客服" });
        return true;
      }
      json(res, 502, { error: result.message || "关闭订单前确认支付状态失败，请稍后重试" });
      return true;
    }
    const responsePayload = { order: sanitizeOrder(result.order) };
    if (result.paidOnClose) responsePayload.paidOnClose = true;
    if (result.reconciledOnClose) responsePayload.reconciledOnClose = true;
    if (result.providerTradeNotFound) responsePayload.providerTradeNotFound = true;
    json(res, 200, responsePayload);
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

  if (req.method === "POST" && pathname.startsWith("/api/payments/wxpay/orders/") && pathname.endsWith("/pay-link")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/wxpay/orders/".length, -"/pay-link".length));
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (order.provider && order.provider !== "wxpay") {
      badRequest(res, "订单支付渠道不匹配");
      return true;
    }
    const preCheck = checkAndRefreshOrderPayable(order, getNowIso());
    if (!preCheck.payable) {
      badRequest(res, "当前订单不能继续支付");
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "微信支付服务未配置" });
      return true;
    }
    return await issuePaymentAccessSafely({
      order: preCheck.order,
      gateway,
      provider: "wxpay",
      subject: `RedBase ${order.planName}`,
      appConfig,
      isNewOrder: false,
      res,
      scope,
      successStatusCode: 200,
    });
  }

  if (req.method === "POST" && pathname.startsWith("/api/payments/wxpay/orders/") && pathname.endsWith("/check")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/wxpay/orders/".length, -"/check".length));
    let order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (order.provider && order.provider !== "wxpay") {
      badRequest(res, "订单支付渠道不匹配");
      return true;
    }
    if (
      order.status === "paid" &&
      (order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "processing") &&
      !order.auditReason &&
      order.fulfillmentStatus !== "audit_required"
    ) {
      try {
        fulfillPaidOrderSafely({ outTradeNo: order.outTradeNo, nowIso: getNowIso() });
      } catch (err) {
        console.warn("[wxpay:check] retry fulfillment failed", { outTradeNo: order.outTradeNo, error: err?.message || err });
      }
      order = findPaymentOrderByOutTradeNo(outTradeNo) || order;
    }
    const isReconcilableWxpay = order.status === "created" || order.status === "pending" || order.status === "expired";
    if (isReconcilableWxpay) {
      const gateway = getWxpayProvider(appConfig);
      if (!gateway) {
        json(res, 503, { error: "微信支付服务未配置" });
        return true;
      }
      try {
        const outcome = await reconcileOne(order, gateway, { nowIso: new Date().toISOString() });
        if (outcome === "failed" || outcome === "unknown" || outcome === "audit") {
          console.warn("[wxpay] active order check returned an unsafe outcome", { outTradeNo, outcome });
          json(res, 502, { error: "支付状态异常，请稍后重试或联系客服" });
          return true;
        }
      } catch (error) {
        console.warn("[wxpay] active order check failed", {
          outTradeNo,
          error: String(error?.message || error),
        });
        json(res, 502, { error: "支付状态查询失败，请稍后重试" });
        return true;
      }
      order = findPaymentOrderByOutTradeNo(outTradeNo);
    }
    json(res, 200, { order: sanitizeOrder(order) });
    return true;
  }

  if (req.method === "POST" && pathname.startsWith("/api/payments/wxpay/orders/") && pathname.endsWith("/close")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/wxpay/orders/".length, -"/close".length));
    const existing = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!existing || existing.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (existing.provider && existing.provider !== "wxpay") {
      badRequest(res, "订单支付渠道不匹配");
      return true;
    }
    if (existing.status === "paid") {
      badRequest(res, "订单已支付，不能关闭");
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "微信支付服务未配置，暂时无法关闭订单" });
      return true;
    }
    const nowIso = getNowIso();
    const result = await safeReconcileAndCloseOrder(existing, gateway, { nowIso, user });
    if (!result.ok) {
      if (result.code === "TRADE_WAIT_BUYER_PAY") {
        json(res, 409, { error: "微信支付交易状态已变化，请刷新后重试", order: sanitizeOrder(result.order) });
        return true;
      }
      if (result.code === "IDENTITY_MISMATCH" || result.code === "AMOUNT_MISMATCH" || result.code === "AUDIT_REQUIRED") {
        json(res, 502, { error: "订单支付状态异常，请稍后重试或联系客服" });
        return true;
      }
      json(res, 502, { error: result.message || "关闭订单前确认支付状态失败，请稍后重试" });
      return true;
    }
    const responsePayload = { order: sanitizeOrder(result.order) };
    if (result.paidOnClose) responsePayload.paidOnClose = true;
    if (result.reconciledOnClose) responsePayload.reconciledOnClose = true;
    if (result.providerTradeNotFound) responsePayload.providerTradeNotFound = true;
    json(res, 200, responsePayload);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/payments/fake/wxpay/settle") {
    const gateway = getWxpayProvider(appConfig);
    if (!gateway || String(appConfig?.wxpay?.provider || "") !== "fake") {
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
    const transactionId = String(url.searchParams.get("transactionId") || url.searchParams.get("tradeNo") || `WXFAKE${Date.now()}`);
    gateway.settle({ outTradeNo, transactionId, amountFen: order.amountFen });
    const payload = gateway.buildNotifyPayload({
      outTradeNo,
      transactionId,
      amountFen: order.amountFen,
      tradeState: String(url.searchParams.get("tradeState") || "SUCCESS"),
    });
    const result = processWxpayNotify({
      headers: payload.headers,
      rawBody: payload.rawBody,
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
  _resetReconcileCacheForTest,
  processAlipayNotify,
  processWxpayNotify,
  parseFormUrlEncoded,
  sanitizeOrder,
  createOutTradeNo,
};

function isOrderPayable(order, nowIso = getNowIso()) {
  if (!order) return false;
  if (order.status !== "created" && order.status !== "pending") return false;
  if (order.expiresAt && order.expiresAt <= nowIso) return false;
  return true;
}
