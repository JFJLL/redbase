"use strict";

// WeChat Pay (V3 Native) provider adapter.
// Production gateway is disabled by default and only active with explicit credentials.
// Fake is allowed only when NODE_ENV=test AND wxpay.fakeAllowed=true.

const crypto = require("crypto");
const { fenToYuanString } = require("../../billing/money");

const providerCache = new WeakMap();
const FAKE_SIGN_KEY = "redbase-fake-wxpay-sign-key-v1";
const FAKE_APP_ID = "wx0000000000000000";
const FAKE_MCH_ID = "1600000000";
const FAKE_API_V3_KEY = "0123456789abcdef0123456789abcdef";
const FAKE_PUBLIC_KEY_ID = "PUB_KEY_ID_00000000000000000000000000000001";
const FAKE_SERIAL_NO = "0123456789ABCDEF0123456789ABCDEF01234567";

function safeTimingEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildAuthorizationHeader({ method, pathname, body = "", mchId, serialNo, privateKey }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString("hex");
  const payload = typeof body === "object" && body !== null ? JSON.stringify(body) : String(body || "");
  const message = `${String(method).toUpperCase()}\n${pathname}\n${timestamp}\n${nonceStr}\n${payload}\n`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  const signature = signer.sign(privateKey, "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

function verifyWxpaySignature({ timestamp, nonce, body = "", signature, publicKey }) {
  if (!timestamp || !nonce || !signature || !publicKey) return false;
  const message = `${String(timestamp)}\n${String(nonce)}\n${String(body || "")}\n`;
  try {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(message);
    return verifier.verify(publicKey, String(signature), "base64");
  } catch (error) {
    return false;
  }
}

function decryptWxpayResource({ ciphertext, nonce, associated_data = "", apiV3Key }) {
  if (!ciphertext || !nonce || !apiV3Key) {
    throw new Error("微信支付回调解密失败：缺少密文、随机串或 APIv3 密钥");
  }
  const keyBuffer = Buffer.from(String(apiV3Key), "utf8");
  if (keyBuffer.length !== 32) {
    throw new Error("微信支付回调解密失败：APIv3 密钥长度必须为 32 字节");
  }
  const ciphertextBuffer = Buffer.from(String(ciphertext), "base64");
  if (ciphertextBuffer.length < 16) {
    throw new Error("微信支付回调解密失败：密文长度非法");
  }
  const authTag = ciphertextBuffer.subarray(ciphertextBuffer.length - 16);
  const data = ciphertextBuffer.subarray(0, ciphertextBuffer.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, Buffer.from(String(nonce), "utf8"));
  decipher.setAuthTag(authTag);
  if (associated_data) {
    decipher.setAAD(Buffer.from(String(associated_data), "utf8"));
  }
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function encryptWxpayResource({ plainObject, nonce, associated_data = "", apiV3Key }) {
  const keyBuffer = Buffer.from(String(apiV3Key), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, Buffer.from(String(nonce), "utf8"));
  if (associated_data) {
    cipher.setAAD(Buffer.from(String(associated_data), "utf8"));
  }
  const textPayload = typeof plainObject === "string" ? plainObject : JSON.stringify(plainObject);
  const ciphertext = Buffer.concat([cipher.update(textPayload, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([ciphertext, authTag]).toString("base64");
}

function normalizePemKey(rawKey, defaultType) {
  const key = String(rawKey || "").trim();
  if (!key) return "";
  if (key.includes("-----BEGIN")) return key;
  const clean = key.replace(/\s+/g, "");
  const chunks = clean.match(/.{1,64}/g);
  if (!chunks) return key;
  return `-----BEGIN ${defaultType}-----\n${chunks.join("\n")}\n-----END ${defaultType}-----`;
}

function mapWxpayTradeState(tradeState) {
  const state = String(tradeState || "").toUpperCase();
  if (state === "SUCCESS") return "TRADE_SUCCESS";
  if (state === "NOTPAY" || state === "USERPAYING") return "WAIT_BUYER_PAY";
  if (state === "CLOSED" || state === "REVOKED") return "TRADE_CLOSED";
  if (state === "PAYERROR") return "TRADE_CLOSED";
  return state;
}

function normalizeWxpayQueryData(data) {
  const source = data || {};
  const amountFen = source.amount?.total ?? source.amount_fen ?? 0;
  const rawState = source.trade_state ?? source.tradeState ?? source.trade_status ?? "";
  const mappedStatus = mapWxpayTradeState(rawState);
  return {
    out_trade_no: source.out_trade_no ?? source.outTradeNo ?? "",
    trade_no: source.transaction_id ?? source.transactionId ?? source.trade_no ?? "",
    trade_status: mappedStatus,
    trade_state: rawState,
    total_amount: fenToYuanString(amountFen),
    amount_fen: Number(amountFen),
    mchid: source.mchid ?? source.mchId ?? "",
    appid: source.appid ?? source.appId ?? "",
    ...source,
  };
}

class FakeWxpayProvider {
  constructor(config) {
    this.config = config || {};
    this.appId = config.appId || FAKE_APP_ID;
    this.mchId = config.mchId || FAKE_MCH_ID;
    this.apiV3Key = config.apiV3Key || FAKE_API_V3_KEY;
    this.publicKeyId = config.publicKeyId || FAKE_PUBLIC_KEY_ID;
    this.serialNo = config.serialNo || FAKE_SERIAL_NO;
    this.payments = new Map();
  }

  async createQrCode({ outTradeNo }) {
    return `weixin://wxpay/bizpayurl?pr=fake-${encodeURIComponent(outTradeNo)}`;
  }

  createPayUrl({ outTradeNo, returnUrl }) {
    let origin = "http://127.0.0.1:3013";
    try {
      origin = new URL(String(returnUrl || this.config.returnUrl || "http://127.0.0.1:3013")).origin;
    } catch (error) {
      // Keep default origin.
    }
    return `${origin}/api/payments/fake/wxpay/pay?out_trade_no=${encodeURIComponent(outTradeNo)}`;
  }

  verifyNotify({ headers, rawBody }) {
    const signature = headers?.["wechatpay-signature"] || headers?.["Wechatpay-Signature"];
    const timestamp = headers?.["wechatpay-timestamp"] || headers?.["Wechatpay-Timestamp"];
    const nonce = headers?.["wechatpay-nonce"] || headers?.["Wechatpay-Nonce"];
    if (!signature || !timestamp || !nonce) return false;
    const expected = crypto
      .createHmac("sha256", FAKE_SIGN_KEY)
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .digest("hex");
    return safeTimingEqual(expected, signature);
  }

  decryptNotifyResource(resource) {
    return decryptWxpayResource({
      ciphertext: resource.ciphertext,
      nonce: resource.nonce,
      associated_data: resource.associated_data || "",
      apiV3Key: this.apiV3Key,
    });
  }

  buildNotifyPayload({
    outTradeNo,
    transactionId,
    amountFen,
    tradeState = "SUCCESS",
    appId = this.appId,
    mchId = this.mchId,
  }) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const tradeData = {
      mchid: mchId,
      appid: appId,
      out_trade_no: String(outTradeNo || ""),
      transaction_id: String(transactionId || `WXFAKE${Date.now()}`),
      trade_type: "NATIVE",
      trade_state: tradeState,
      trade_state_desc: tradeState === "SUCCESS" ? "支付成功" : "待支付",
      bank_type: "OTHERS",
      success_time: new Date().toISOString(),
      amount: {
        total: Number(amountFen || 0),
        payer_total: Number(amountFen || 0),
        currency: "CNY",
        payer_currency: "CNY",
      },
    };
    const ciphertext = encryptWxpayResource({
      plainObject: tradeData,
      nonce,
      associated_data: "transaction",
      apiV3Key: this.apiV3Key,
    });
    const bodyObj = {
      id: `EVT_${Date.now()}`,
      create_time: new Date().toISOString(),
      resource_type: "encrypt-resource",
      event_type: "TRANSACTION.SUCCESS",
      summary: "支付成功",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        ciphertext,
        associated_data: "transaction",
        nonce,
      },
    };
    const rawBody = JSON.stringify(bodyObj);
    const signature = crypto
      .createHmac("sha256", FAKE_SIGN_KEY)
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .digest("hex");
    return {
      rawBody,
      headers: {
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": nonce,
        "wechatpay-signature": signature,
        "wechatpay-serial": this.publicKeyId,
      },
      tradeData,
    };
  }

  settle({ outTradeNo, transactionId, amountFen }) {
    this.payments.set(String(outTradeNo || ""), {
      outTradeNo: String(outTradeNo || ""),
      transactionId: String(transactionId || `WXFAKE${Date.now()}`),
      tradeState: "SUCCESS",
      tradeStatus: "TRADE_SUCCESS",
      amountFen: Number(amountFen || 0),
      totalAmount: fenToYuanString(amountFen),
      appId: this.appId,
      mchId: this.mchId,
      notifiedAt: new Date().toISOString(),
    });
  }

  async queryOrder(outTradeNo) {
    const payment = this.payments.get(String(outTradeNo || ""));
    if (!payment) {
      return {
        data: {
          out_trade_no: String(outTradeNo || ""),
          trade_state: "NOTPAY",
          trade_status: "WAIT_BUYER_PAY",
          total_amount: "0.00",
          amount_fen: 0,
          mchid: this.mchId,
          appid: this.appId,
        },
        responseHttpStatus: 200,
        traceId: `fake-wx-${Date.now()}`,
      };
    }
    return {
      data: {
        out_trade_no: payment.outTradeNo,
        trade_no: payment.transactionId,
        transaction_id: payment.transactionId,
        trade_state: payment.tradeState,
        trade_status: payment.tradeStatus,
        total_amount: payment.totalAmount,
        amount_fen: payment.amountFen,
        mchid: payment.mchId,
        appid: payment.appId,
      },
      responseHttpStatus: 200,
      traceId: `fake-wx-${Date.now()}`,
    };
  }

  closeTrade(outTradeNo) {
    const existing = this.payments.get(String(outTradeNo || ""));
    if (existing?.tradeState === "SUCCESS") {
      return {
        alreadyPaid: true,
        tradeState: "SUCCESS",
        tradeStatus: "TRADE_SUCCESS",
        outTradeNo: String(existing.outTradeNo || outTradeNo || ""),
        tradeNo: String(existing.transactionId || ""),
        totalAmount: String(existing.totalAmount || ""),
        appId: String(existing.appId || this.appId || ""),
        mchId: String(existing.mchId || this.mchId || ""),
      };
    }
    this.payments.set(String(outTradeNo || ""), {
      outTradeNo: String(outTradeNo || ""),
      transactionId: "",
      tradeState: "CLOSED",
      tradeStatus: "TRADE_CLOSED",
      amountFen: 0,
      totalAmount: "0.00",
      appId: this.appId,
      mchId: this.mchId,
      closedAt: new Date().toISOString(),
    });
    return { alreadyPaid: false, tradeStatus: "TRADE_CLOSED" };
  }
}

class RealWxpayProvider {
  constructor(config) {
    this.config = config || {};
    this.appId = String(config.appId || "").trim();
    this.mchId = String(config.mchId || "").trim();
    this.serialNo = String(config.serialNo || "").trim();
    this.privateKey = normalizePemKey(config.privateKey, "PRIVATE KEY");
    this.apiV3Key = String(config.apiV3Key || "").trim();
    this.publicKeyId = String(config.publicKeyId || "").trim();
    this.publicKey = normalizePemKey(config.publicKey, "PUBLIC KEY");
    this.gateway = String(config.gateway || "https://api.mch.weixin.qq.com").trim().replace(/\/+$/, "");
    this.timeoutMs = Number(config.timeoutMs || 5000);
    this.notifyUrl = String(config.notifyUrl || "").trim();
  }

  async request(method, pathname, body = null) {
    const url = `${this.gateway}${pathname}`;
    const payload = body !== null ? JSON.stringify(body) : "";
    const authHeader = buildAuthorizationHeader({
      method,
      pathname,
      body: payload,
      mchId: this.mchId,
      serialNo: this.serialNo,
      privateKey: this.privateKey,
    });
    const headers = {
      Accept: "application/json",
      Authorization: authHeader,
      "User-Agent": "redbase-wxpay/1.0",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: payload || undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = { raw: text };
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    };
  }

  async createQrCode({ outTradeNo, description = "RedBase 积分充值", totalAmountFen, notifyUrl }) {
    const res = await this.request("POST", "/v3/pay/transactions/native", {
      appid: this.appId,
      mchid: this.mchId,
      description,
      out_trade_no: outTradeNo,
      notify_url: notifyUrl || this.notifyUrl,
      amount: {
        total: Number(totalAmountFen),
        currency: "CNY",
      },
    });
    if (!res.ok || !res.data?.code_url) {
      const detail = res.data?.message || res.data?.code || `HTTP ${res.status}`;
      throw new Error(`微信支付扫码下单失败：${detail}`);
    }
    return String(res.data.code_url);
  }

  verifyNotify({ headers, rawBody }) {
    const signature = headers?.["wechatpay-signature"] || headers?.["Wechatpay-Signature"];
    const timestamp = headers?.["wechatpay-timestamp"] || headers?.["Wechatpay-Timestamp"];
    const nonce = headers?.["wechatpay-nonce"] || headers?.["Wechatpay-Nonce"];
    return verifyWxpaySignature({
      timestamp,
      nonce,
      body: rawBody,
      signature,
      publicKey: this.publicKey,
    });
  }

  decryptNotifyResource(resource) {
    return decryptWxpayResource({
      ciphertext: resource.ciphertext,
      nonce: resource.nonce,
      associated_data: resource.associated_data || "",
      apiV3Key: this.apiV3Key,
    });
  }

  async queryOrder(outTradeNo) {
    const pathname = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.mchId)}`;
    let res;
    try {
      res = await this.request("GET", pathname);
    } catch (error) {
      throw error;
    }
    if (res.status === 404 || res.data?.code === "ORDER_NOT_EXIST" || res.data?.code === "ORDERNOTEXIST") {
      return { data: {}, notFound: true, responseHttpStatus: 404 };
    }
    if (!res.ok) {
      const msg = res.data?.message || res.data?.code || `HTTP ${res.status}`;
      throw new Error(`微信支付查询订单失败：${msg}`);
    }
    return {
      data: normalizeWxpayQueryData(res.data),
      notFound: false,
      responseHttpStatus: res.status,
    };
  }

  async closeTrade(outTradeNo) {
    const pathname = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    const res = await this.request("POST", pathname, { mchid: this.mchId });
    if (res.status === 204) {
      return { alreadyPaid: false, tradeStatus: "TRADE_CLOSED" };
    }
    if (res.data?.code === "ORDER_PAID" || res.data?.code === "ORDERPAID") {
      const queryRes = await this.queryOrder(outTradeNo);
      return {
        alreadyPaid: true,
        tradeStatus: queryRes.data?.trade_status || "TRADE_SUCCESS",
        outTradeNo,
        tradeNo: queryRes.data?.trade_no || "",
        totalAmount: queryRes.data?.total_amount || "",
        appId: queryRes.data?.appid || this.appId,
        mchId: queryRes.data?.mchid || this.mchId,
      };
    }
    if (res.data?.code === "ORDER_NOT_EXIST" || res.data?.code === "ORDERNOTEXIST") {
      return { alreadyPaid: false, tradeStatus: "TRADE_CLOSED", notFound: true };
    }
    const msg = res.data?.message || res.data?.code || `HTTP ${res.status}`;
    throw new Error(`微信支付关闭订单失败：${msg}`);
  }
}

function isFakeAllowed(config) {
  return process.env.NODE_ENV === "test" && config?.fakeAllowed === true;
}

function createWxpayProvider(appConfig) {
  const wxpay = appConfig?.wxpay || {};
  const providerName = String(wxpay.provider || "disabled").trim().toLowerCase();
  if (providerName === "fake") {
    if (!isFakeAllowed(wxpay)) return null;
    return new FakeWxpayProvider(wxpay);
  }
  if (providerName === "wxpay") {
    if (!wxpay.appId || !wxpay.mchId || !wxpay.serialNo || !wxpay.privateKey || !wxpay.apiV3Key || !wxpay.publicKey) {
      return null;
    }
    return new RealWxpayProvider(wxpay);
  }
  return null;
}

function getWxpayProvider(appConfig) {
  if (!appConfig || typeof appConfig !== "object") return null;
  if (!providerCache.has(appConfig)) {
    providerCache.set(appConfig, createWxpayProvider(appConfig));
  }
  return providerCache.get(appConfig);
}

module.exports = {
  FakeWxpayProvider,
  RealWxpayProvider,
  buildAuthorizationHeader,
  verifyWxpaySignature,
  decryptWxpayResource,
  encryptWxpayResource,
  mapWxpayTradeState,
  normalizeWxpayQueryData,
  createWxpayProvider,
  getWxpayProvider,
  isFakeAllowed,
  FAKE_APP_ID,
  FAKE_MCH_ID,
  FAKE_API_V3_KEY,
  FAKE_PUBLIC_KEY_ID,
  FAKE_SERIAL_NO,
};
