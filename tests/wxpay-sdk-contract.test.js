const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const {
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
} = require("../src/server/integrations/wxpay");
const { reconcileOrders } = require("../src/server/billing/reconcile-orders");
const { insertUser, findUserByPhone } = require("../src/server/db/repositories/auth-repository");
const { insertPaymentOrder, findPaymentOrderByOutTradeNo } = require("../src/server/db/repositories/payment-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TEST_API_V3_KEY = "12345678901234567890123456789012";

function makeRealWxProvider() {
  return new RealWxpayProvider({
    appId: "wx_app_test",
    mchId: "1600000001",
    serialNo: "SERIAL_NO_TEST_001",
    privateKey,
    publicKeyId: "PUB_KEY_ID_001",
    publicKey,
    apiV3Key: TEST_API_V3_KEY,
    notifyUrl: "https://example.com/api/payments/wxpay/notify",
  });
}

test("buildAuthorizationHeader formats and signs client request with RSA-SHA256", () => {
  const authHeader = buildAuthorizationHeader({
    method: "POST",
    pathname: "/v3/pay/transactions/native",
    body: JSON.stringify({ out_trade_no: "wx_order_1" }),
    mchId: "1600000001",
    serialNo: "SERIAL_NO_TEST_001",
    privateKey,
  });

  assert.match(authHeader, /^WECHATPAY2-SHA256-RSA2048 /);
  assert.match(authHeader, /mchid="1600000001"/);
  assert.match(authHeader, /serial_no="SERIAL_NO_TEST_001"/);

  const timestampMatch = authHeader.match(/timestamp="([^"]+)"/);
  const nonceMatch = authHeader.match(/nonce_str="([^"]+)"/);
  const sigMatch = authHeader.match(/signature="([^"]+)"/);

  assert.ok(timestampMatch);
  assert.ok(nonceMatch);
  assert.ok(sigMatch);

  const expectedMessage = `POST\n/v3/pay/transactions/native\n${timestampMatch[1]}\n${nonceMatch[1]}\n${JSON.stringify({ out_trade_no: "wx_order_1" })}\n`;
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(expectedMessage);
  assert.equal(verifier.verify(publicKey, sigMatch[1], "base64"), true);
});

test("verifyWxpaySignature verifies WeChat response and webhook signatures with RSA-SHA256", () => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({ event_type: "TRANSACTION.SUCCESS" });
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(message);
  const signature = signer.sign(privateKey, "base64");

  const verified = verifyWxpaySignature({
    timestamp,
    nonce,
    body,
    signature,
    publicKey,
  });

  assert.equal(verified, true);
});

test("encryptWxpayResource and decryptWxpayResource work round-trip with AEAD_AES_256_GCM", () => {
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = {
    out_trade_no: "redbase_wx_12345",
    transaction_id: "4200002000202608140000000001",
    trade_state: "SUCCESS",
    amount: { total: 350000, currency: "CNY" },
  };

  const ciphertext = encryptWxpayResource({
    plainObject: payload,
    nonce,
    associated_data: "transaction",
    apiV3Key: TEST_API_V3_KEY,
  });

  const decrypted = decryptWxpayResource({
    ciphertext,
    nonce,
    associated_data: "transaction",
    apiV3Key: TEST_API_V3_KEY,
  });

  assert.deepEqual(decrypted, payload);
});

test("mapWxpayTradeState normalizes WeChat Pay trade states", () => {
  assert.equal(mapWxpayTradeState("SUCCESS"), "TRADE_SUCCESS");
  assert.equal(mapWxpayTradeState("NOTPAY"), "WAIT_BUYER_PAY");
  assert.equal(mapWxpayTradeState("USERPAYING"), "WAIT_BUYER_PAY");
  assert.equal(mapWxpayTradeState("CLOSED"), "TRADE_CLOSED");
  assert.equal(mapWxpayTradeState("REVOKED"), "TRADE_CLOSED");
  assert.equal(mapWxpayTradeState("PAYERROR"), "TRADE_CLOSED");
});

test("normalizeWxpayQueryData maps WeChat wire format to unified contract", () => {
  const normalized = normalizeWxpayQueryData({
    out_trade_no: "redbase_norm_1",
    transaction_id: "WX_TRANS_123",
    trade_state: "SUCCESS",
    amount: { total: 350000 },
    mchid: "1600000001",
    appid: "wx_app_test",
  });

  assert.equal(normalized.out_trade_no, "redbase_norm_1");
  assert.equal(normalized.trade_no, "WX_TRANS_123");
  assert.equal(normalized.trade_status, "TRADE_SUCCESS");
  assert.equal(normalized.total_amount, "3500.00");
  assert.equal(normalized.amount_fen, 350000);
});

test("FakeWxpayProvider correctly produces QR code, notify simulation, and query responses", async () => {
  const fakeProvider = new FakeWxpayProvider({
    appId: "wx_fake_app",
    mchId: "1600000099",
    fakeAllowed: true,
  });

  const qrCode = await fakeProvider.createQrCode({ outTradeNo: "fake_order_1" });
  assert.equal(qrCode, "weixin://wxpay/bizpayurl?pr=fake-fake_order_1");

  const notifyPayload = fakeProvider.buildNotifyPayload({
    outTradeNo: "fake_order_1",
    transactionId: "FAKE_WX_TRANS_99",
    amountFen: 350000,
    tradeState: "SUCCESS",
  });

  const verified = fakeProvider.verifyNotify({
    headers: notifyPayload.headers,
    rawBody: notifyPayload.rawBody,
  });
  assert.equal(verified, true);

  const parsedBody = JSON.parse(notifyPayload.rawBody);
  const decrypted = fakeProvider.decryptNotifyResource(parsedBody.resource);
  assert.equal(decrypted.out_trade_no, "fake_order_1");
  assert.equal(decrypted.transaction_id, "FAKE_WX_TRANS_99");
  assert.equal(decrypted.amount.total, 350000);
});

test("RealWxpayProvider queryOrder normalizes WeChat Pay response", async () => {
  const provider = makeRealWxProvider();
  provider.request = async (method, pathname) => {
    assert.equal(method, "GET");
    assert.ok(pathname.includes("redbase_wx_query_1"));
    return {
      status: 200,
      ok: true,
      data: {
        out_trade_no: "redbase_wx_query_1",
        transaction_id: "WX_TRANS_QUERY_1",
        trade_state: "SUCCESS",
        amount: { total: 350000 },
        mchid: "1600000001",
        appid: "wx_app_test",
      },
    };
  };

  const result = await provider.queryOrder("redbase_wx_query_1");
  assert.equal(result.notFound, false);
  assert.equal(result.data.out_trade_no, "redbase_wx_query_1");
  assert.equal(result.data.trade_no, "WX_TRANS_QUERY_1");
  assert.equal(result.data.trade_status, "TRADE_SUCCESS");
  assert.equal(result.data.total_amount, "3500.00");
});

test("RealWxpayProvider queryOrder handles 404 ORDER_NOT_EXIST", async () => {
  const provider = makeRealWxProvider();
  provider.request = async () => ({
    status: 404,
    ok: false,
    data: { code: "ORDER_NOT_EXIST", message: "订单不存在" },
  });

  const result = await provider.queryOrder("redbase_wx_missing");
  assert.equal(result.notFound, true);
  assert.deepEqual(result.data, {});
});

test("RealWxpayProvider closeTrade handles HTTP 204 success", async () => {
  const provider = makeRealWxProvider();
  provider.request = async (method, pathname) => {
    assert.equal(method, "POST");
    assert.ok(pathname.includes("/close"));
    return { status: 204, ok: true, data: {} };
  };

  const result = await provider.closeTrade("redbase_wx_close_1");
  assert.equal(result.alreadyPaid, false);
  assert.equal(result.tradeStatus, "TRADE_CLOSED");
});

test("WeChat Pay orders are reconciled and credited appropriately by reconcileOrders", async () => {
  insertUser({
    id: 2,
    name: "微信对账用户",
    phone: "13900000018",
    password: "hash",
    accountType: "customer",
    credits: 5,
    createdAt: "2026-08-14T00:00:00.000Z",
  });
  insertPaymentOrder({
    outTradeNo: "redbase_wx_reconcile_paid",
    userId: 2,
    idempotencyKey: "wx-reconcile-paid",
    plan: { id: "business-monthly", name: "单月版", credits: 1000, amountFen: 350000 },
    status: "pending",
    provider: "wxpay",
    nowIso: "2026-08-14T00:00:00.000Z",
    expiresAtIso: "2026-08-14T01:00:00.000Z",
  });

  const provider = makeRealWxProvider();
  provider.request = async () => ({
    status: 200,
    ok: true,
    data: {
      out_trade_no: "redbase_wx_reconcile_paid",
      transaction_id: "WX_TRANS_RECONCILE_PAID",
      trade_state: "SUCCESS",
      amount: { total: 350000 },
      mchid: "1600000001",
      appid: "wx_app_test",
    },
  });

  const creditsBefore = Number(findUserByPhone("13900000018").credits);
  const summary = await reconcileOrders({
    gateways: { wxpay: provider },
    nowIso: "2026-08-14T12:00:00.000Z",
  });

  assert.equal(summary.paid, 1);
  const settledOrder = findPaymentOrderByOutTradeNo("redbase_wx_reconcile_paid");
  assert.equal(settledOrder.status, "paid");
  assert.equal(settledOrder.provider, "wxpay");
  assert.equal(settledOrder.tradeNo, "WX_TRANS_RECONCILE_PAID");
  assert.equal(Number(findUserByPhone("13900000018").credits), creditsBefore + 1000);
});
