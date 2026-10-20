const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { safeReconcileAndCloseOrder } = require("../../src/server/billing/reconcile-orders");
const { insertUser, insertSession, findUserByPhone, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { handlePaymentRoutes, _resetReconcileCacheForTest } = require("../../src/server/api/payment-routes");
const { insertPaymentOrder, findPaymentOrderByOutTradeNo } = require("../../src/server/db/repositories/payment-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();

insertUser({
  id: 10,
  name: "安全关单测试用户",
  phone: "13900000088",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});

function seedTestOrder(outTradeNo, status = "pending", amountFen = 9900) {
  return insertPaymentOrder({
    outTradeNo,
    userId: 10,
    idempotencyKey: "idem-" + outTradeNo,
    plan: { id: "p10", name: "测试套餐", credits: 50, amountFen },
    status,
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T01:00:00.000Z",
  });
}

test("safeReconcileAndCloseOrder in dryRun mode queries provider but NEVER calls closeTrade or writes to DB", async () => {
  const outTradeNo = "rb_safe_dryrun_test_1";
  const order = seedTestOrder(outTradeNo, "pending");

  let closeTradeCalls = 0;
  let queryOrderCalls = 0;

  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async (tradeNo) => {
      queryOrderCalls++;
      return {
        data: {
          out_trade_no: tradeNo,
          trade_status: "WAIT_BUYER_PAY",
          total_amount: "99.00",
          app_id: "2023000000000000",
          seller_id: "2088000000000000",
        },
        notFound: false,
      };
    },
    closeTrade: async () => {
      closeTradeCalls++;
      return { tradeStatus: "TRADE_CLOSED" };
    },
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
    dryRun: true,
  });

  assert.equal(queryOrderCalls, 1);
  assert.equal(closeTradeCalls, 0, "dryRun must NEVER call closeTrade");
  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");

  const stored = findPaymentOrderByOutTradeNo(outTradeNo);
  assert.equal(stored.status, "pending", "dryRun must zero-write to DB");
});

test("safeReconcileAndCloseOrder refuses to call closeTrade when query returns unknown status", async () => {
  const outTradeNo = "rb_safe_unknown_status_1";
  const order = seedTestOrder(outTradeNo, "pending");

  let closeTradeCalls = 0;
  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async (tradeNo) => ({
      data: {
        out_trade_no: tradeNo,
        trade_status: "SOME_STRANGE_STATE",
        total_amount: "99.00",
        app_id: "2023000000000000",
        seller_id: "2088000000000000",
      },
      notFound: false,
    }),
    closeTrade: async () => {
      closeTradeCalls++;
      return { tradeStatus: "TRADE_CLOSED" };
    },
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
  });

  assert.equal(closeTradeCalls, 0, "Unknown status must never call closeTrade");
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_PROVIDER_STATUS");
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "pending");
});

test("safeReconcileAndCloseOrder refuses to call closeTrade when WAIT_BUYER_PAY query has wrong out_trade_no or appId", async () => {
  const outTradeNo = "rb_safe_wrong_id_1";
  const order = seedTestOrder(outTradeNo, "pending");

  let closeTradeCalls = 0;
  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async () => ({
      data: {
        out_trade_no: "DIFFERENT_ORDER_NUMBER",
        trade_status: "WAIT_BUYER_PAY",
        total_amount: "99.00",
        app_id: "2023000000000000",
        seller_id: "2088000000000000",
      },
      notFound: false,
    }),
    closeTrade: async () => {
      closeTradeCalls++;
      return { tradeStatus: "TRADE_CLOSED" };
    },
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
  });

  assert.equal(closeTradeCalls, 0, "Wrong out_trade_no on WAIT must never call closeTrade");
  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTITY_MISMATCH");
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "pending");
});

test("safeReconcileAndCloseOrder rejects paid-on-close when outTradeNo is missing or empty", async () => {
  const outTradeNo = "rb_safe_paid_no_outtrade_1";
  const order = seedTestOrder(outTradeNo, "pending");

  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async (tradeNo) => ({
      data: {
        out_trade_no: tradeNo,
        trade_status: "WAIT_BUYER_PAY",
        total_amount: "99.00",
        app_id: "2023000000000000",
        seller_id: "2088000000000000",
      },
      notFound: false,
    }),
    closeTrade: async () => ({
      alreadyPaid: true,
      outTradeNo: "", // Missing outTradeNo!
      tradeNo: "T123456",
      totalAmount: "99.00",
      appId: "2023000000000000",
      sellerId: "2088000000000000",
    }),
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "IDENTITY_MISMATCH");
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "pending");
});

test("safeReconcileAndCloseOrder does not accept empty or WAIT closeResult as success", async () => {
  const outTradeNo = "rb_safe_fake_empty_close_1";
  const order = seedTestOrder(outTradeNo, "pending");

  let secondQueryCalls = 0;
  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async (tradeNo) => {
      secondQueryCalls++;
      return {
        data: {
          out_trade_no: tradeNo,
          trade_status: "WAIT_BUYER_PAY",
          total_amount: "99.00",
          app_id: "2023000000000000",
          seller_id: "2088000000000000",
        },
        notFound: false,
      };
    },
    closeTrade: async () => ({}), // Empty object, not TRADE_CLOSED
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
  });

  assert.equal(secondQueryCalls, 2);
  assert.equal(result.ok, false);
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "pending");
});

test("safeReconcileAndCloseOrder settles via reconcileOne if verifyQuery finds TRADE_SUCCESS after close", async () => {
  const outTradeNo = "rb_safe_verify_query_paid_1";
  const order = seedTestOrder(outTradeNo, "pending");

  let queryCount = 0;
  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async (tradeNo) => {
      queryCount++;
      if (queryCount === 1) {
        return {
          data: {
            out_trade_no: tradeNo,
            trade_status: "WAIT_BUYER_PAY",
            total_amount: "99.00",
            app_id: "2023000000000000",
            seller_id: "2088000000000000",
          },
          notFound: false,
        };
      }
      return {
        data: {
          out_trade_no: tradeNo,
          trade_no: "REAL_SETTLED_TRADE_NO_99",
          trade_status: "TRADE_SUCCESS",
          total_amount: "99.00",
          app_id: "2023000000000000",
          seller_id: "2088000000000000",
          paid_at: "2026-08-01T02:00:00.000Z",
        },
        notFound: false,
      };
    },
    closeTrade: async () => ({
      code: "UNKNOWN", // Non-conclusive close result
    }),
  };

  const result = await safeReconcileAndCloseOrder(order, mockGateway, {
    nowIso: "2026-08-01T02:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "paid");
  assert.equal(result.reconciledOnClose, true);
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "paid");
});


test("GET orders with 101 stale orders rotates past first 100 failing orders and safely closes the 101st order (batch size max 3)", async () => {
  _resetReconcileCacheForTest();
  insertUser({
    id: 200,
    name: "101单轮转测试用户",
    phone: "13900000100",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  insertSession({ token: "token-user-200", userId: 200, createdAt: "2026-08-01T00:00:00.000Z" });

  // Seed 101 orders, all expired in the past
  for (let i = 1; i <= 101; i++) {
    insertPaymentOrder({
      outTradeNo: `rb_rot_order_${i}`,
      userId: 200,
      idempotencyKey: `rot-idem-${i}`,
      plan: { id: "p20", name: "轮转套餐", credits: 10, amountFen: 100 },
      status: "pending",
      provider: "alipay",
      nowIso: "2026-08-01T00:00:00.000Z",
      expiresAtIso: "2026-08-01T00:30:00.000Z",
    });
  }

  const testConfig = {
    security: { cookieSecure: false },
    alipay: { enabled: true, provider: "fake", fakeAllowed: true },
  };
  const { getAlipayProvider } = require("../../src/server/integrations/alipay");
  const gateway = getAlipayProvider(testConfig);
  const origQuery = gateway.queryOrder;

  let maxConcurrentPerCall = 0;
  let currentConcurrent = 0;

  try {
    gateway.queryOrder = async (outTradeNo) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrentPerCall) maxConcurrentPerCall = currentConcurrent;
      try {
        if (outTradeNo === "rb_rot_order_101") {
          return { notFound: true, data: {} };
        }
        throw new Error("Provider temporary network failure");
      } finally {
        currentConcurrent--;
      }
    };

    const callGetOrders = async () => {
      let body = "";
      const req = {
        method: "GET",
        url: "/api/payments/orders",
        headers: { host: "localhost:3013", cookie: "redbase_session=token-user-200" },
      };
      const res = {
        statusCode: 0,
        writeHead(code) { this.statusCode = code; },
        setHeader() {},
        end(data) { body = data; },
      };
      await handlePaymentRoutes({ appConfig: testConfig }, req, res, "/api/payments/orders");
      return { statusCode: res.statusCode, body: JSON.parse(body || "{}") };
    };

    // Process in batches of 3: 35 calls will cycle through all 101 orders
    for (let c = 0; c < 35; c++) {
      await callGetOrders();
    }

    assert.ok(maxConcurrentPerCall <= 3, `Max concurrent per call must not exceed 3, got ${maxConcurrentPerCall}`);
    const order101 = findPaymentOrderByOutTradeNo("rb_rot_order_101");
    assert.equal(order101.status, "closed", "Order #101 must be reached and safely closed");
  } finally {
    gateway.queryOrder = origQuery;
  }
});
test("GET orders repeated refreshes do not duplicate payment_failed analytics events", async () => {
  insertUser({
    id: 30,
    name: "审计幂等测试用户",
    phone: "13900000030",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  insertSession({ token: "token-user-30", userId: 30, createdAt: "2026-08-01T00:00:00.000Z" });

  insertPaymentOrder({
    outTradeNo: "rb_analytics_dup_test_1",
    userId: 30,
    idempotencyKey: "analytics-dup-1",
    plan: { id: "p30", name: "审计套餐", credits: 10, amountFen: 100 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:10:00.000Z",
  });

  const callGet = async () => {
    const req = { method: "GET", url: "/api/payments/orders", headers: { host: "localhost:3013", cookie: "redbase_session=token-user-30" } };
    const res = { writeHead() {}, setHeader() {}, end() {} };
    await handlePaymentRoutes({ appConfig: { alipay: { provider: "fake", fakeAllowed: true } } }, req, res, "/api/payments/orders");
  };

  // First call sweeps and marks expired + records analytics event
  await callGet();
  const count1 = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE event_name = 'payment_failed' AND actor_user_id = 30").get().c;
  // Second call must NOT duplicate analytics event
  await callGet();
  const count2 = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE event_name = 'payment_failed' AND actor_user_id = 30").get().c;
  assert.equal(count1, 1, "Exactly one failed analytics event recorded");
  assert.equal(count2, 1, "Repeated GET must not duplicate analytics event");
});


test("/check on order with status=pending and past expiresAt reconciles: paid settles, unpaid marks expired (Alipay & Wxpay)", async () => {
  insertUser({
    id: 50,
    name: "Check对账过期单测试用户",
    phone: "13900000050",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  insertSession({ token: "token-user-50", userId: 50, createdAt: "2026-08-01T00:00:00.000Z" });

  const testConfig = {
    security: { cookieSecure: false },
    alipay: { enabled: true, provider: "fake", fakeAllowed: true },
    wxpay: { enabled: true, provider: "fake", fakeAllowed: true, appId: "wx0000000000000000", mchId: "1600000000" },
  };
  const { getAlipayProvider } = require("../../src/server/integrations/alipay");
  const { getWxpayProvider } = require("../../src/server/integrations/wxpay");
  const aliGateway = getAlipayProvider(testConfig);
  const wxGateway = getWxpayProvider(testConfig);

  // Case 1: Alipay pending order with past expiresAt, provider confirms paid
  insertPaymentOrder({
    outTradeNo: "rb_check_ali_past_paid",
    userId: 50,
    idempotencyKey: "check-ali-past-paid",
    plan: { id: "p50", name: "积分包", credits: 20, amountFen: 100 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:10:00.000Z",
  });
  aliGateway.settle({ outTradeNo: "rb_check_ali_past_paid", tradeNo: "ALI_TRADE_CHECK_PAID", totalAmount: "1.00" });

  let resAli = { statusCode: 0, writeHead(c) { this.statusCode = c; }, setHeader() {}, end(d) { this.body = d; } };
  await handlePaymentRoutes(
    { appConfig: testConfig },
    { method: "POST", url: "/api/payments/alipay/orders/rb_check_ali_past_paid/check", headers: { host: "localhost:3013", cookie: "redbase_session=token-user-50" } },
    resAli,
    "/api/payments/alipay/orders/rb_check_ali_past_paid/check"
  );
  assert.equal(resAli.statusCode, 200);
  assert.equal(findPaymentOrderByOutTradeNo("rb_check_ali_past_paid").status, "paid", "Pending order with past expiresAt must be settled if paid");

  // Case 2: Alipay pending order with past expiresAt, provider confirms unpaid (WAIT_BUYER_PAY)
  insertPaymentOrder({
    outTradeNo: "rb_check_ali_past_unpaid",
    userId: 50,
    idempotencyKey: "check-ali-past-unpaid",
    plan: { id: "p50", name: "积分包", credits: 20, amountFen: 100 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:10:00.000Z",
  });

  let resAliUnpaid = { statusCode: 0, writeHead(c) { this.statusCode = c; }, setHeader() {}, end(d) { this.body = d; } };
  await handlePaymentRoutes(
    { appConfig: testConfig },
    { method: "POST", url: "/api/payments/alipay/orders/rb_check_ali_past_unpaid/check", headers: { host: "localhost:3013", cookie: "redbase_session=token-user-50" } },
    resAliUnpaid,
    "/api/payments/alipay/orders/rb_check_ali_past_unpaid/check"
  );
  assert.equal(resAliUnpaid.statusCode, 200);
  assert.equal(findPaymentOrderByOutTradeNo("rb_check_ali_past_unpaid").status, "expired", "Pending order with past expiresAt must be marked expired if unpaid");

  // Case 3: Wxpay pending order with past expiresAt, provider confirms paid
  insertPaymentOrder({
    outTradeNo: "rb_check_wx_past_paid",
    userId: 50,
    idempotencyKey: "check-wx-past-paid",
    plan: { id: "p50", name: "微信积分包", credits: 20, amountFen: 100 },
    status: "pending",
    provider: "wxpay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:10:00.000Z",
  });
  wxGateway.settle({ outTradeNo: "rb_check_wx_past_paid", transactionId: "WX_TRADE_CHECK_PAID", amountFen: 100 });

  let resWx = { statusCode: 0, writeHead(c) { this.statusCode = c; }, setHeader() {}, end(d) { this.body = d; } };
  await handlePaymentRoutes(
    { appConfig: testConfig },
    { method: "POST", url: "/api/payments/wxpay/orders/rb_check_wx_past_paid/check", headers: { host: "localhost:3013", cookie: "redbase_session=token-user-50" } },
    resWx,
    "/api/payments/wxpay/orders/rb_check_wx_past_paid/check"
  );
  assert.equal(resWx.statusCode, 200);
  assert.equal(findPaymentOrderByOutTradeNo("rb_check_wx_past_paid").status, "paid", "Wxpay pending order with past expiresAt must settle if paid");
});

test("/check on paid unfulfilled order with audit_reason or audit_required does NOT retry fulfillment or grant credits", async () => {
  insertUser({
    id: 60,
    name: "Audit防重试用户",
    phone: "13900000060",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  insertSession({ token: "token-user-60", userId: 60, createdAt: "2026-08-01T00:00:00.000Z" });

  const order = insertPaymentOrder({
    outTradeNo: "rb_check_audit_guard_1",
    userId: 60,
    idempotencyKey: "check-audit-guard-1",
    plan: { id: "p60", name: "审计保护包", credits: 50, amountFen: 100 },
    status: "paid",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:30:00.000Z",
  });

  db.prepare("UPDATE payment_orders SET status = 'paid', fulfillment_status = 'unfulfilled', audit_reason = 'manual_review_required' WHERE out_trade_no = ?")
    .run(order.outTradeNo);

  const creditsBefore = findUserById(60).credits;
  const eventsBefore = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 60").get().c;

  let res = { statusCode: 0, writeHead(c) { this.statusCode = c; }, setHeader() {}, end(d) { this.body = d; } };
  await handlePaymentRoutes(
    { appConfig: { alipay: { provider: "fake", fakeAllowed: true } } },
    { method: "POST", url: `/api/payments/alipay/orders/${order.outTradeNo}/check`, headers: { host: "localhost:3013", cookie: "redbase_session=token-user-60" } },
    res,
    `/api/payments/alipay/orders/${order.outTradeNo}/check`
  );

  assert.equal(res.statusCode, 200);
  const creditsAfter = findUserById(60).credits;
  const eventsAfter = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 60").get().c;
  assert.equal(creditsAfter, creditsBefore, "Credits must not be granted for order with audit_reason");
  assert.equal(eventsAfter, eventsBefore, "No credit_event must be recorded for order with audit_reason");

  const finalOrder = findPaymentOrderByOutTradeNo(order.outTradeNo);
  assert.equal(finalOrder.fulfillmentStatus, "unfulfilled", "Order must remain unfulfilled while audit_reason exists");
});


test("reconcileOne catches concurrent close during await queryOrder, marks closed_provider_paid audit, and does NOT credit user", async () => {
  insertUser({
    id: 70,
    name: "并发关单查单用户",
    phone: "13900000070",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  insertSession({ token: "token-user-70", userId: 70, createdAt: "2026-08-01T00:00:00.000Z" });

  const order = insertPaymentOrder({
    outTradeNo: "rb_race_close_paid_70",
    userId: 70,
    idempotencyKey: "race-close-paid-70",
    plan: { id: "p70", name: "并发测试套餐", credits: 100, amountFen: 9900 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:30:00.000Z",
  });

  const { closePaymentOrder } = require("../../src/server/db/repositories/payment-repository");
  const { reconcileOne } = require("../../src/server/billing/reconcile-orders");

  let deferredResolve;
  const deferredPromise = new Promise((resolve) => {
    deferredResolve = resolve;
  });

  const mockGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async () => {
      return await deferredPromise;
    },
  };

  const initialCredits = findUserById(70).credits;

  const reconcilePromise = reconcileOne(order, mockGateway, {
    nowIso: "2026-08-01T01:00:00.000Z",
    dryRun: false,
  });

  const closed = closePaymentOrder({
    userId: 70,
    outTradeNo: order.outTradeNo,
    nowIso: "2026-08-01T00:50:00.000Z",
  });
  assert.equal(closed.status, "closed", "Order was closed concurrently in DB");

  deferredResolve({
    data: {
      out_trade_no: order.outTradeNo,
      trade_no: "RACE_SETTLED_TRADE_70",
      trade_status: "TRADE_SUCCESS",
      total_amount: "99.00",
      app_id: "2023000000000000",
      seller_id: "2088000000000000",
      gmt_payment: "2026-08-01 00:45:00",
    },
    notFound: false,
  });

  const outcome = await reconcilePromise;

  assert.equal(outcome, "audit", "Outcome must be audit when order was closed concurrently");
  const finalOrder = findPaymentOrderByOutTradeNo(order.outTradeNo);
  assert.equal(finalOrder.status, "closed", "Order status must remain closed, not revived to paid");
  assert.equal(finalOrder.auditReason, "closed_provider_paid", "Audit reason must be recorded as closed_provider_paid");
  assert.equal(findUserById(70).credits, initialCredits, "User must NOT receive credits for closed order");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 70").get().c, 0, "No credit_events must be recorded");

  // Verify dryRun does NOT write audit or modify DB
  const dryOrder = insertPaymentOrder({
    outTradeNo: "rb_race_dryrun_closed_70",
    userId: 70,
    idempotencyKey: "race-dry-70",
    plan: { id: "p70", name: "dryRun测试套餐", credits: 100, amountFen: 9900 },
    status: "closed",
    provider: "alipay",
    nowIso: "2026-08-01T00:00:00.000Z",
    expiresAtIso: "2026-08-01T00:30:00.000Z",
  });
  const dryGateway = {
    appId: "2023000000000000",
    sellerId: "2088000000000000",
    queryOrder: async () => ({
      data: {
        out_trade_no: dryOrder.outTradeNo,
        trade_no: "DRY_PAID_TRADE_70",
        trade_status: "TRADE_SUCCESS",
        total_amount: "99.00",
        app_id: "2023000000000000",
        seller_id: "2088000000000000",
      },
      notFound: false,
    }),
  };
  const dryOutcome = await reconcileOne(dryOrder, dryGateway, { nowIso: "2026-08-01T01:00:00.000Z", dryRun: true });
  assert.equal(dryOutcome, "audit");
  const dryStored = findPaymentOrderByOutTradeNo(dryOrder.outTradeNo);
  assert.equal(dryStored.auditReason, "", "dryRun must zero-write auditReason to DB");
  assert.equal(findUserById(70).credits, initialCredits);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 70").get().c, 0);
});
