const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { RealAlipayProvider } = require("../src/server/integrations/alipay");
const { reconcileOrders } = require("../src/server/billing/reconcile-orders");
const { insertUser, findUserByPhone } = require("../src/server/db/repositories/auth-repository");
const { insertPaymentOrder, findPaymentOrderByOutTradeNo } = require("../src/server/db/repositories/payment-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();

function makeRealProvider() {
  return new RealAlipayProvider({
    appId: "app-test",
    privateKey: "private-test",
    alipayPublicKey: "public-test",
    sellerId: "seller-test",
  });
}

test("queryOrder normalizes the SDK camelCase response to the wire contract", async () => {
  const provider = makeRealProvider();
  let receivedMethod = "";
  let receivedParams = null;
  provider.sdk = {
    exec: async (method, params) => {
      receivedMethod = method;
      receivedParams = params;
      return {
      outTradeNo: "redbase_query_camel_1",
      tradeNo: "CAMEL_TRADE_NO",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "0.01",
      responseHttpStatus: 200,
      traceId: "trace-camel",
      };
    },
  };

  const result = await provider.queryOrder("redbase_query_camel_1");

  assert.equal(receivedMethod, "alipay.trade.query");
  assert.deepEqual(receivedParams, { bizContent: { out_trade_no: "redbase_query_camel_1" } });
  assert.equal(result.data.out_trade_no, "redbase_query_camel_1");
  assert.equal(result.data.trade_no, "CAMEL_TRADE_NO");
  assert.equal(result.data.trade_status, "TRADE_SUCCESS");
  assert.equal(result.data.total_amount, "0.01");
});

test("createQrCode returns the official Alipay precreate QR payload", async () => {
  const provider = makeRealProvider();
  let receivedMethod = "";
  let receivedParams = null;
  provider.sdk = {
    exec: async (method, params) => {
      receivedMethod = method;
      receivedParams = params;
      return { code: "10000", qrCode: "https://qr.alipay.com/official-code" };
    },
  };

  const qrCode = await provider.createQrCode({
    outTradeNo: "redbase_precreate_1",
    subject: "RedBase 单月版",
    totalAmount: "3500.00",
    notifyUrl: "https://api.red-magic.cn/api/payments/alipay/notify",
  });

  assert.equal(receivedMethod, "alipay.trade.precreate");
  assert.deepEqual(receivedParams, {
    notify_url: "https://api.red-magic.cn/api/payments/alipay/notify",
    bizContent: {
      out_trade_no: "redbase_precreate_1",
      subject: "RedBase 单月版",
      total_amount: "3500.00",
    },
  });
  assert.equal(qrCode, "https://qr.alipay.com/official-code");
});

test("createQrCode rejects a failed or empty precreate response", async () => {
  const provider = makeRealProvider();
  provider.sdk = {
    exec: async () => ({ code: "40004", subMsg: "商户未开通当面付" }),
  };

  await assert.rejects(
    () => provider.createQrCode({ outTradeNo: "redbase_precreate_error", subject: "套餐", totalAmount: "0.01" }),
    /支付宝扫码支付创建失败：商户未开通当面付/,
  );
});

test("V3 close success response with only out_trade_no/trade_no is accepted as closed", async () => {
  const provider = makeRealProvider();
  provider.sdk = {
    curl: async () => ({
      data: { out_trade_no: "redbase_close_v3", trade_no: "CLOSE_TRADE_NO" },
      responseHttpStatus: 200,
      traceId: "trace-close",
    }),
  };

  const result = await provider.closeTrade("redbase_close_v3");

  assert.equal(result.alreadyPaid, false);
  assert.equal(result.tradeStatus, "TRADE_CLOSED");
});

test("closeTrade still rejects explicit error responses", async () => {
  const provider = makeRealProvider();
  provider.sdk = {
    curl: async () => ({
      data: { code: "40004", sub_msg: "交易不存在" },
      responseHttpStatus: 200,
      traceId: "trace-error",
    }),
  };

  await assert.rejects(
    () => provider.closeTrade("redbase_close_error"),
    /关闭订单失败/,
  );
});

test("closeTrade detects an already-paid transaction from camelCase status", async () => {
  const provider = makeRealProvider();
  provider.sdk = {
    curl: async () => ({
      data: {
        tradeStatus: "TRADE_SUCCESS",
        outTradeNo: "redbase_close_paid",
        tradeNo: "ALREADY_PAID_CAMEL",
        totalAmount: "0.01",
        appId: "app-camel",
        sellerId: "seller-camel",
      },
      responseHttpStatus: 200,
      traceId: "trace-paid",
    }),
  };

  const result = await provider.closeTrade("redbase_close_paid");

  assert.equal(result.alreadyPaid, true);
  assert.equal(result.outTradeNo, "redbase_close_paid");
  assert.equal(result.tradeNo, "ALREADY_PAID_CAMEL");
  assert.equal(result.totalAmount, "0.01");
  assert.equal(result.appId, "app-camel");
  assert.equal(result.sellerId, "seller-camel");
});

test("P3: an expired order paid in the real camelCase SDK shape is settled by reconciliation", async () => {
  insertUser({
    id: 1,
    name: "契约对账用户",
    phone: "13900000009",
    password: "hash",
    accountType: "customer",
    credits: 5,
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  insertPaymentOrder({
    outTradeNo: "redbase_real_camel_expired_paid",
    userId: 1,
    idempotencyKey: "real-camel-expired-paid",
    plan: { id: "p1", name: "测试套餐", credits: 10, amountFen: 1 },
    status: "pending",
    nowIso: "2026-08-04T00:00:00.000Z",
    expiresAtIso: "2026-08-04T01:00:00.000Z",
  });

  const provider = makeRealProvider();
  provider.sdk = {
    exec: async () => ({
      outTradeNo: "redbase_real_camel_expired_paid",
      tradeNo: "REAL_CAMEL_PAID",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "0.01",
      responseHttpStatus: 200,
      traceId: "trace-real",
    }),
  };
  const creditsBefore = Number(findUserByPhone("13900000009").credits);

  const summary = await reconcileOrders({
    gateway: provider,
    nowIso: "2026-08-04T12:00:00.000Z",
  });

  assert.equal(summary.paid, 1);
  assert.equal(findPaymentOrderByOutTradeNo("redbase_real_camel_expired_paid").status, "paid");
  assert.equal(Number(findUserByPhone("13900000009").credits), creditsBefore + 10);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count,
    1,
  );
});
