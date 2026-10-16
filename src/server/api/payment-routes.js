"use strict";

const crypto = require("crypto");
const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { getAlipayProvider, isAlipayTradeNotExistError } = require("../integrations/alipay");
const { getWxpayProvider } = require("../integrations/wxpay");
const { fenToYuanString } = require("../billing/money");
const { reconcileOne } = require("../billing/reconcile-orders");
const { PLANS, TOPUPS, CATALOG_VERSION, getPlan, getTopup, getLegacyPlan } = require("../billing/catalog");
const { getNowTimestamp, getNowIso, formatShanghaiDate } = require("../billing/period-utils");
const { createQuote, verifyAndConsumeQuote } = require("../billing/quote-service");
const { getUserBillingOverview } = require("../billing/subscription-service");
const { rescanExpiredLots } = require("../billing/credit-ledger");
const { getDbProxy } = require("../db/connection");
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
    const settled = settlePaidPaymentOrder({ outTradeNo, tradeNo, nowIso });
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
      if (delta < 0) {
        type = "spend";
      } else if (event.action_type.includes("expire")) {
        type = "expire";
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

    json(res, 200, { rows, total: rows.length });
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
      if (delta < 0) {
        type = "spend";
      } else if (event.action_type.includes("expire")) {
        type = "expire";
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
    let quote = null;
    let plan = null;
    if (quoteId) {
      try {
        quote = verifyAndConsumeQuote(quoteId, user.id);
      } catch (err) {
        badRequest(res, err.message || "报价无效或已过期");
        return true;
      }
      plan = {
        id: quote.item_id,
        name: quote.meta?.planName || quote.meta?.topupName || quote.item_id,
        credits: quote.issued_now,
        amountFen: quote.amount_fen,
      };
    } else {
      plan = (appConfig?.billing?.rechargePlans || []).find((item) => item.id === planId)
        || getPlan(planId)
        || getTopup(planId)
        || getLegacyPlan(planId);
    }
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
      const paymentAccess = await createPaymentAccess({
        gateway,
        outTradeNo: existing.outTradeNo,
        subject: `RedBase ${existing.planName}`,
        totalAmount: fenToYuanString(existing.amountFen),
        returnUrl: appConfig?.alipay?.returnUrl || "",
        notifyUrl: appConfig?.alipay?.notifyUrl || "",
      });
      json(res, 200, { order: sanitizeOrder(existing), ...paymentAccess });
      return true;
    }

    const outTradeNo = createOutTradeNo();
    const nowIso = getNowIso();
    const expiresAtIso = quote?.expires_at || new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
    const order = insertPaymentOrder({
      outTradeNo,
      userId: user.id,
      idempotencyKey,
      plan,
      status: "created",
      provider: "alipay",
      nowIso,
      expiresAtIso,
      quote,
    });
    const paymentAccess = await createPaymentAccess({
      gateway,
      outTradeNo,
      subject: `RedBase ${plan.name}`,
      totalAmount: fenToYuanString(plan.amountFen),
      returnUrl: appConfig?.alipay?.returnUrl || "",
      notifyUrl: appConfig?.alipay?.notifyUrl || "",
    });
    updatePaymentOrderStatus({ outTradeNo, status: "pending", nowIso: new Date().toISOString() });
    json(res, 201, { order: sanitizeOrder(findPaymentOrderByOutTradeNo(outTradeNo)), ...paymentAccess });
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
    let quote = null;
    let plan = null;
    if (quoteId) {
      try {
        quote = verifyAndConsumeQuote(quoteId, user.id);
      } catch (err) {
        badRequest(res, err.message || "报价无效或已过期");
        return true;
      }
      plan = {
        id: quote.item_id,
        name: quote.meta?.planName || quote.meta?.topupName || quote.item_id,
        credits: quote.issued_now,
        amountFen: quote.amount_fen,
      };
    } else {
      plan = (appConfig?.billing?.rechargePlans || []).find((item) => item.id === planId)
        || getPlan(planId)
        || getTopup(planId)
        || getLegacyPlan(planId);
    }
    if (!plan) {
      badRequest(res, "充值套餐未配置或不存在");
      return true;
    }
    if (appConfig?.wxpay?.enabled !== true) {
      json(res, 503, { error: "微信支付充值暂未开放" });
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 400, { error: "微信支付商户信息尚未配置，请在 config.local.json 中填入微信支付参数" });
      return true;
    }

    const existing = findPaymentOrderByUserAndIdempotency(user.id, idempotencyKey);
    if (existing) {
      const paymentAccess = await createWxpayPaymentAccess({
        gateway,
        outTradeNo: existing.outTradeNo,
        description: `RedBase ${existing.planName}`,
        totalAmountFen: existing.amountFen,
        notifyUrl: appConfig?.wxpay?.notifyUrl || "",
      });
      json(res, 200, { order: sanitizeOrder(existing), ...paymentAccess });
      return true;
    }

    const outTradeNo = createOutTradeNo();
    const nowIso = getNowIso();
    const expiresAtIso = quote?.expires_at || new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
    const order = insertPaymentOrder({
      outTradeNo,
      userId: user.id,
      idempotencyKey,
      plan,
      status: "created",
      provider: "wxpay",
      nowIso,
      expiresAtIso,
      quote,
    });
    const paymentAccess = await createWxpayPaymentAccess({
      gateway,
      outTradeNo,
      description: `RedBase ${plan.name}`,
      totalAmountFen: plan.amountFen,
      notifyUrl: appConfig?.wxpay?.notifyUrl || "",
    });
    updatePaymentOrderStatus({ outTradeNo, status: "pending", nowIso: new Date().toISOString() });
    json(res, 201, { order: sanitizeOrder(findPaymentOrderByOutTradeNo(outTradeNo)), ...paymentAccess });
    return true;
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
    if (!isOrderPayable(order)) {
      badRequest(res, "当前订单不能继续支付");
      return true;
    }
    const gateway = getAlipayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "充值服务未配置" });
      return true;
    }
    const paymentAccess = await createPaymentAccess({
      gateway,
      outTradeNo: order.outTradeNo,
      subject: `RedBase ${order.planName}`,
      totalAmount: fenToYuanString(order.amountFen),
      returnUrl: appConfig?.alipay?.returnUrl || "",
      notifyUrl: appConfig?.alipay?.notifyUrl || "",
    });
    json(res, 200, { order: sanitizeOrder(order), ...paymentAccess });
    return true;
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
    if (isOrderPayable(order)) {
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
      let queryResult;
      try {
        queryResult = await gateway.queryOrder(outTradeNo);
      } catch (queryError) {
        console.warn("[alipay] close confirmation query failed", {
          outTradeNo,
          error: String(queryError?.message || queryError),
        });
      }
      if (queryResult?.notFound === true || (!queryResult && isAlipayTradeNotExistError(error))) {
        const nowIso = new Date().toISOString();
        const closed = closePaymentOrder({ userId: user.id, outTradeNo, nowIso });
        const finalOrder = closed || findPaymentOrderByOutTradeNo(outTradeNo);
        json(res, 200, { order: sanitizeOrder(finalOrder), providerTradeNotFound: true });
        return true;
      }
      const tradeStatus = String(queryResult?.data?.trade_status || "");
      if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
        let outcome;
        try {
          outcome = await reconcileOne(existing, gateway, {
            nowIso: new Date().toISOString(),
            queryResult,
          });
        } catch (reconcileError) {
          console.warn("[alipay] close missing-trade reconciliation failed", {
            outTradeNo,
            error: String(reconcileError?.message || reconcileError),
          });
          json(res, 502, { error: "关闭订单前确认支付状态失败，请稍后重试" });
          return true;
        }
        const currentOrder = findPaymentOrderByOutTradeNo(outTradeNo);
        if (outcome === "paid") {
          json(res, 200, { order: sanitizeOrder(currentOrder), reconciledOnClose: true });
          return true;
        }
        json(res, 502, { error: "订单支付状态异常，请稍后重试或联系客服" });
        return true;
      }
      if (tradeStatus === "WAIT_BUYER_PAY" || tradeStatus === "TRADE_CLOSED") {
        const currentOrder = findPaymentOrderByOutTradeNo(outTradeNo);
        json(res, 409, { error: "支付宝交易状态已变化，请刷新后重试", order: sanitizeOrder(currentOrder) });
        return true;
      }
      // If trade was never created on Alipay or provider is unreachable, close locally
      const nowIso = new Date().toISOString();
      const closed = closePaymentOrder({ userId: user.id, outTradeNo, nowIso });
      const finalOrder = closed || findPaymentOrderByOutTradeNo(outTradeNo);
      json(res, 200, { order: sanitizeOrder(finalOrder), providerClosed: false });
      return true;
    }
    if (closeResult?.alreadyPaid) {
      const identityMismatch =
        String(closeResult.outTradeNo || "") !== String(outTradeNo) ||
        !closeResult.tradeNo ||
        String(closeResult.totalAmount || "") !== fenToYuanString(existing.amountFen) ||
        (closeResult.appId && gateway.appId && String(closeResult.appId) !== String(gateway.appId)) ||
        (closeResult.sellerId && gateway.sellerId && String(closeResult.sellerId) !== String(gateway.sellerId));
      if (identityMismatch) {
        console.warn("[alipay] paid-on-close identity mismatch", { outTradeNo });
        json(res, 502, { error: "订单支付状态异常，请稍后重试或联系客服" });
        return true;
      }
      const nowIso = new Date().toISOString();
      const settled = settlePaidPaymentOrder({
        outTradeNo,
        tradeNo: String(closeResult.tradeNo),
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

  if (req.method === "POST" && pathname.startsWith("/api/payments/wxpay/orders/") && pathname.endsWith("/pay-link")) {
    const user = requireSqlAuth(req, res, scope);
    if (!user) return true;
    const outTradeNo = decodeURIComponent(pathname.slice("/api/payments/wxpay/orders/".length, -"/pay-link".length));
    const order = findPaymentOrderByOutTradeNo(outTradeNo);
    if (!order || order.userId !== user.id) {
      json(res, 404, { error: "订单不存在" });
      return true;
    }
    if (!isOrderPayable(order)) {
      badRequest(res, "当前订单不能继续支付");
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "微信支付服务未配置" });
      return true;
    }
    const paymentAccess = await createWxpayPaymentAccess({
      gateway,
      outTradeNo: order.outTradeNo,
      description: `RedBase ${order.planName}`,
      totalAmountFen: order.amountFen,
      notifyUrl: appConfig?.wxpay?.notifyUrl || "",
    });
    json(res, 200, { order: sanitizeOrder(order), ...paymentAccess });
    return true;
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
    if (isOrderPayable(order)) {
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
    if (existing.status === "paid") {
      badRequest(res, "订单已支付，不能关闭");
      return true;
    }
    const gateway = getWxpayProvider(appConfig);
    if (!gateway) {
      json(res, 503, { error: "微信支付服务未配置，暂时无法关闭订单" });
      return true;
    }
    let closeResult;
    try {
      closeResult = await gateway.closeTrade(outTradeNo);
    } catch (error) {
      let queryResult;
      try {
        queryResult = await gateway.queryOrder(outTradeNo);
      } catch (queryError) {
        console.warn("[wxpay] close confirmation query failed", {
          outTradeNo,
          error: String(queryError?.message || queryError),
        });
      }
      if (queryResult?.data?.trade_status === "TRADE_SUCCESS") {
        const nowIso = new Date().toISOString();
        const settled = settlePaidPaymentOrder({
          outTradeNo,
          tradeNo: String(queryResult.data.trade_no || ""),
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
    if (closeResult?.alreadyPaid) {
      const nowIso = new Date().toISOString();
      const settled = settlePaidPaymentOrder({
        outTradeNo,
        tradeNo: String(closeResult.tradeNo),
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
  processAlipayNotify,
  processWxpayNotify,
  parseFormUrlEncoded,
  sanitizeOrder,
  createOutTradeNo,
};

function isOrderPayable(order) {
  return order?.status === "created" || order?.status === "pending";
}
