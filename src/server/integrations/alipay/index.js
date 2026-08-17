"use strict";

// Alipay provider adapters. The production gateway is disabled by default and
// only active with explicit credentials. Fake is allowed only when NODE_ENV=test
// AND alipay.fakeAllowed=true (explicit injection). Notify/query remain
// available while the gateway is configured even when alipay.enabled=false
// (rollback mode keeps reconciliation working).

const crypto = require("crypto");

const providerCache = new WeakMap();
const FAKE_SIGN_KEY = "redbase-fake-alipay-sign-key-v1";
const FAKE_APP_ID = "2023000000000000";
const FAKE_SELLER_ID = "2088000000000000";

function signFakeParams(params) {
  const keys = Object.keys(params || {}).filter((key) => key !== "sign").sort();
  const canonical = keys.map((key) => `${key}=${String(params[key] ?? "")}`).join("&");
  return crypto.createHmac("sha256", FAKE_SIGN_KEY).update(canonical).digest("hex");
}

function safeTimingEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The official SDK defaults to camelcase=true, so V3 responses arrive as
// tradeStatus/totalAmount/tradeNo. Normalize to the wire (snake_case) contract
// once at the adapter boundary so billing/reconcile never depend on SDK shape.
function normalizeAlipayQueryData(data) {
  const source = data || {};
  return {
    out_trade_no: source.out_trade_no ?? source.outTradeNo ?? "",
    trade_no: source.trade_no ?? source.tradeNo ?? "",
    trade_status: source.trade_status ?? source.tradeStatus ?? "",
    total_amount: source.total_amount ?? source.totalAmount ?? "",
    ...source,
  };
}

function isAlipayTradeNotExistError(error) {
  const source = error || {};
  const responseData = source.response?.data || source.data || {};
  const details = [
    source.code,
    source.subCode,
    source.sub_code,
    source.subMsg,
    source.sub_msg,
    source.msg,
    source.message,
    responseData.code,
    responseData.subCode,
    responseData.sub_code,
    responseData.subMsg,
    responseData.sub_msg,
    responseData.msg,
  ].map((value) => String(value || "")).join(" ");
  return /ACQ\.TRADE_NOT_EXIST|TRADE_NOT_EXIST|ACQ\.TRADE_HAS_CLOSE|ACQ\.TRADE_STATUS_ERROR|交易不存在|交易已关闭/i.test(details);
}

function alipayTradeNotExistError(error) {
  const normalized = new Error("支付宝交易不存在");
  normalized.code = "ALIPAY_TRADE_NOT_EXIST";
  normalized.cause = error;
  return normalized;
}

// V3 alipay.trade.close success returns only out_trade_no/trade_no (no
// trade_status, no code=10000). Error responses carry code/sub_code/msg.
function parseCloseTradeResult(data) {
  const source = data || {};
  const tradeStatus = String(source.trade_status ?? source.tradeStatus ?? "");
  if (source.code && String(source.code) !== "10000") {
    throw new Error(
      `支付宝关闭订单失败：${String(source.sub_msg || source.msg || source.code)}`,
    );
  }
  if (source.sub_code) {
    throw new Error(`支付宝关闭订单失败：${String(source.sub_msg || source.sub_code)}`);
  }
  if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
    return {
      alreadyPaid: true,
      tradeStatus,
      outTradeNo: String(source.out_trade_no ?? source.outTradeNo ?? ""),
      tradeNo: String(source.trade_no ?? source.tradeNo ?? ""),
      totalAmount: String(source.total_amount ?? source.totalAmount ?? ""),
      appId: String(source.app_id ?? source.appId ?? ""),
      sellerId: String(source.seller_id ?? source.sellerId ?? ""),
    };
  }
  if (tradeStatus === "TRADE_CLOSED") {
    return { alreadyPaid: false, tradeStatus };
  }
  if (source.out_trade_no || source.outTradeNo || source.trade_no || source.tradeNo) {
    return { alreadyPaid: false, tradeStatus: "TRADE_CLOSED" };
  }
  throw new Error("支付宝关闭订单失败：unknown");
}

class FakeAlipayProvider {
  constructor(config) {
    this.config = config;
    this.appId = FAKE_APP_ID;
    this.sellerId = FAKE_SELLER_ID;
    this.payments = new Map();
  }

  createPayUrl({ outTradeNo, subject, totalAmount, returnUrl, notifyUrl }) {
    let origin = "http://127.0.0.1:3013";
    try {
      origin = new URL(String(returnUrl || this.config.returnUrl || "http://127.0.0.1:3013")).origin;
    } catch (error) {
      // Keep default origin.
    }
    return `${origin}/api/payments/fake/alipay/pay?out_trade_no=${encodeURIComponent(outTradeNo)}`;
  }

  async createQrCode({ outTradeNo }) {
    return `https://qr.alipay.test/${encodeURIComponent(outTradeNo)}`;
  }

  verifyNotify(params) {
    return safeTimingEqual(signFakeParams(params), params?.sign);
  }

  settle({ outTradeNo, tradeNo, totalAmount }) {
    this.payments.set(String(outTradeNo || ""), {
      outTradeNo: String(outTradeNo || ""),
      tradeNo: String(tradeNo || ""),
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: String(totalAmount || ""),
      appId: FAKE_APP_ID,
      sellerId: FAKE_SELLER_ID,
      notifiedAt: new Date().toISOString(),
    });
  }

  closeTrade(outTradeNo) {
    const existing = this.payments.get(String(outTradeNo || ""));
    if (
      existing?.tradeStatus === "TRADE_SUCCESS" ||
      existing?.tradeStatus === "TRADE_FINISHED"
    ) {
      return {
        alreadyPaid: true,
        tradeStatus: existing.tradeStatus,
        outTradeNo: String(existing.outTradeNo || outTradeNo || ""),
        tradeNo: String(existing.tradeNo || ""),
        totalAmount: String(existing.totalAmount || ""),
        appId: String(existing.appId || this.appId || ""),
        sellerId: String(existing.sellerId || this.sellerId || ""),
      };
    }
    this.payments.set(String(outTradeNo || ""), {
      outTradeNo: String(outTradeNo || ""),
      tradeNo: "",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "",
      appId: FAKE_APP_ID,
      sellerId: FAKE_SELLER_ID,
      closedAt: new Date().toISOString(),
    });
    return { alreadyPaid: false, tradeStatus: "TRADE_CLOSED" };
  }

  buildNotifyParams({ outTradeNo, tradeNo, totalAmount, tradeStatus = "TRADE_SUCCESS", appId = FAKE_APP_ID, sellerId = FAKE_SELLER_ID, ...overrides }) {
    const params = {
      app_id: appId,
      seller_id: sellerId,
      out_trade_no: String(outTradeNo || ""),
      trade_no: String(tradeNo || `FAKE${Date.now()}`),
      total_amount: String(totalAmount || ""),
      trade_status: tradeStatus,
      notify_id: `fake-notify-${Date.now()}`,
      sign_type: "RSA2",
      ...overrides,
    };
    return { ...params, sign: signFakeParams(params) };
  }

  async queryOrder(outTradeNo) {
    const payment = this.payments.get(String(outTradeNo || ""));
    if (!payment) {
      return {
        data: {
          out_trade_no: String(outTradeNo || ""),
          trade_status: "WAIT_BUYER_PAY",
          total_amount: "0.00",
        },
        responseHttpStatus: 200,
        traceId: `fake-${Date.now()}`,
      };
    }
    return {
      data: {
        out_trade_no: payment.outTradeNo,
        trade_no: payment.tradeNo,
        trade_status: payment.tradeStatus,
        total_amount: payment.totalAmount,
        ...payment,
      },
      responseHttpStatus: 200,
      traceId: `fake-${Date.now()}`,
    };
  }
}

class RealAlipayProvider {
  constructor(config) {
    this.config = config;
    this.appId = config.appId;
    this.sellerId = config.sellerId;
    this.sdk = null;
  }

  getSdk() {
    if (this.sdk) return this.sdk;
    const { AlipaySdk } = require("alipay-sdk");
    const rawGateway = String(this.config.gateway || "https://openapi.alipay.com/gateway.do").trim();
    const gateway = rawGateway.endsWith("/gateway.do") ? rawGateway : `${rawGateway.replace(/\/+$/, "")}/gateway.do`;
    const endpoint = rawGateway.replace(/\/gateway\.do\/?$/i, "").replace(/\/+$/, "") || "https://openapi.alipay.com";
    this.sdk = new AlipaySdk({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      alipayPublicKey: this.config.alipayPublicKey,
      gateway,
      endpoint,
      timeout: Number(this.config.timeoutMs || 5000),
      keyType: this.config.keyType || "PKCS8",
    });
    return this.sdk;
  }

  createPayUrl({ outTradeNo, subject, totalAmount, returnUrl, notifyUrl }) {
    return this.getSdk().pageExecute("alipay.trade.page.pay", "GET", {
      bizContent: {
        out_trade_no: outTradeNo,
        product_code: "FAST_INSTANT_TRADE_PAY",
        subject,
        total_amount: totalAmount,
      },
      returnUrl,
      notifyUrl,
    });
  }

  async createQrCode({ outTradeNo, subject, totalAmount, notifyUrl }) {
    const result = await this.getSdk().exec("alipay.trade.precreate", {
      notify_url: notifyUrl,
      bizContent: {
        out_trade_no: outTradeNo,
        subject,
        total_amount: totalAmount,
      },
    });
    const qrCode = String(result?.qr_code ?? result?.qrCode ?? "").trim();
    if (String(result?.code || "10000") !== "10000" || !qrCode) {
      const detail = String(result?.sub_msg || result?.subMsg || result?.msg || result?.code || "unknown");
      throw new Error(`支付宝扫码支付创建失败：${detail}`);
    }
    return qrCode;
  }

  verifyNotify(params) {
    return this.getSdk().checkNotifySignV2(params);
  }

  async queryOrder(outTradeNo) {
    let result;
    try {
      result = await this.getSdk().exec("alipay.trade.query", {
        bizContent: { out_trade_no: outTradeNo },
      });
    } catch (error) {
      if (isAlipayTradeNotExistError(error)) {
        return { data: {}, notFound: true, responseHttpStatus: 200, traceId: String(error?.traceId || "") };
      }
      throw error;
    }
    if (isAlipayTradeNotExistError(result)) {
      return { data: {}, notFound: true, responseHttpStatus: 200, traceId: String(result?.traceId || "") };
    }
    if (result?.code && String(result.code) !== "10000") {
      const error = new Error(`支付宝查询订单失败：${String(result.subMsg || result.sub_msg || result.msg || result.code)}`);
      error.subMsg = result.subMsg || result.sub_msg;
      error.subCode = result.subCode || result.sub_code;
      error.code = result.code;
      throw error;
    }
    return {
      data: normalizeAlipayQueryData(result || {}),
      notFound: false,
      responseHttpStatus: result?.responseHttpStatus || 200,
      traceId: result?.traceId || "",
    };
  }

  async closeTrade(outTradeNo) {
    let result;
    try {
      result = await this.getSdk().curl("POST", "/v3/alipay/trade/close", {
        body: { out_trade_no: outTradeNo },
      });
    } catch (error) {
      if (isAlipayTradeNotExistError(error)) throw alipayTradeNotExistError(error);
      throw error;
    }
    if (isAlipayTradeNotExistError(result?.data)) throw alipayTradeNotExistError(result?.data);
    return parseCloseTradeResult(result?.data);
  }
}

function isFakeAllowed(config) {
  return process.env.NODE_ENV === "test" && config?.fakeAllowed === true;
}

function createAlipayProvider(appConfig) {
  const alipay = appConfig?.alipay || {};
  const providerName = String(alipay.provider || "disabled").trim().toLowerCase();
  if (providerName === "fake") {
    if (!isFakeAllowed(alipay)) return null;
    return new FakeAlipayProvider(alipay);
  }
  if (providerName === "alipay") {
    if (!alipay.appId || !alipay.privateKey || !alipay.alipayPublicKey || !alipay.sellerId) return null;
    return new RealAlipayProvider(alipay);
  }
  return null;
}

function getAlipayProvider(appConfig) {
  if (!appConfig || typeof appConfig !== "object") return null;
  if (!providerCache.has(appConfig)) {
    providerCache.set(appConfig, createAlipayProvider(appConfig));
  }
  return providerCache.get(appConfig);
}

module.exports = {
  FakeAlipayProvider,
  RealAlipayProvider,
  normalizeAlipayQueryData,
  parseCloseTradeResult,
  isAlipayTradeNotExistError,
  createAlipayProvider,
  getAlipayProvider,
  isFakeAllowed,
  FAKE_APP_ID,
  FAKE_SELLER_ID,
};
