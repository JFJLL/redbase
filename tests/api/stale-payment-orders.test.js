"use strict";

const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const {
  handlePaymentRoutes,
  _resetReconcileCacheForTest,
} = require("../../src/server/api/payment-routes");
const { getAlipayProvider } = require("../../src/server/integrations/alipay");
const { getWxpayProvider } = require("../../src/server/integrations/wxpay");
const {
  insertUser,
  insertSession,
  findUserById,
} = require("../../src/server/db/repositories/auth-repository");
const {
  findPaymentOrderByOutTradeNo,
  updatePaymentOrderStatus,
} = require("../../src/server/db/repositories/payment-repository");
const { createQuote } = require("../../src/server/billing/quote-service");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();

const appConfig = {
  security: { cookieSecure: false },
  alipay: {
    enabled: true,
    provider: "fake",
    fakeAllowed: true,
    appId: "fake-alipay-app-id",
    privateKey: "",
    alipayPublicKey: "",
    sellerId: "",
    returnUrl: "http://127.0.0.1:3013/app/billing",
    notifyUrl: "",
  },
  wxpay: {
    enabled: true,
    provider: "fake",
    fakeAllowed: true,
    appId: "wx0000000000000000",
    mchId: "1600000000",
    serialNo: "0123456789ABCDEF0123456789ABCDEF01234567",
    apiV3Key: "0123456789abcdef0123456789abcdef",
    publicKeyId: "PUB_KEY_ID_00000000000000000000000000000001",
    publicKey: "PUB_KEY",
    privateKey: "PRIV_KEY",
    notifyUrl: "",
  },
  billing: {
    rechargePlans: [{ id: "p1", name: "测试套餐 10 积分", credits: 10, amountFen: 1 }],
  },
};

// Seed synthetic test users
insertUser({
  id: 101,
  name: "迁移买家101",
  phone: "13900000101",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-05-01T00:00:00.000Z",
});
insertSession({ token: "token-user-101", userId: 101, createdAt: "2026-05-01T00:00:00.000Z" });

insertUser({
  id: 102,
  name: "测试买家102",
  phone: "13900000102",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "token-user-102", userId: 102, createdAt: "2026-08-01T00:00:00.000Z" });

insertUser({
  id: 103,
  name: "测试买家103",
  phone: "13900000103",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "token-user-103", userId: 103, createdAt: "2026-08-01T00:00:00.000Z" });

insertUser({
  id: 104,
  name: "并发买家104",
  phone: "13900000104",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "token-user-104", userId: 104, createdAt: "2026-08-01T00:00:00.000Z" });

insertUser({
  id: 105,
  name: "锁测试买家105",
  phone: "13900000105",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "token-user-105", userId: 105, createdAt: "2026-08-01T00:00:00.000Z" });

insertUser({
  id: 106,
  name: "过期锁买家106",
  phone: "13900000106",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "token-user-106", userId: 106, createdAt: "2026-08-01T00:00:00.000Z" });

function createJsonReq(url, payload, cookie = "") {
  const req = Readable.from([Buffer.from(JSON.stringify(payload || {}), "utf8")]);
  req.method = "POST";
  req.url = url;
  req.headers = { host: "localhost:3013", "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  return req;
}

function createFormReq(url, params, cookie = "") {
  const req = Readable.from([Buffer.from(new URLSearchParams(params).toString(), "utf8")]);
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    "content-type": "application/x-www-form-urlencoded",
    ...(cookie ? { cookie } : {}),
  };
  return req;
}

function createGetReq(url, cookie = "") {
  return {
    method: "GET",
    url,
    headers: { host: "localhost:3013", ...(cookie ? { cookie } : {}) },
  };
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    writeHead(code, nextHeaders = {}) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(nextHeaders)) headers.set(key.toLowerCase(), value);
    },
    setHeader(key, value) { headers.set(key.toLowerCase(), value); },
    getHeader(key) { return headers.get(String(key).toLowerCase()); },
    end(data = "") { this.body = data; },
  };
}

async function api(method, url, options = {}) {
  const res = createRes();
  let req;
  if (method === "POST") {
    req = options.form
      ? createFormReq(url, options.form, options.cookie)
      : createJsonReq(url, options.body, options.cookie);
  } else {
    req = createGetReq(url, options.cookie);
  }
  await handlePaymentRoutes({ appConfig }, req, res, new URL(url, "http://localhost:3013").pathname);
  return res;
}

test("1. 双渠道迁移态旧business-monthly（order_kind plan、quote_id/cycle空、几月前expired/pending）阻塞已安全处理后可新建套餐", async () => {
  // Seed legacy stale order for user 101 under Alipay: order_kind='plan', quote_id='', cycle='', status='pending'
  const legacyAlipayNo = "rb_legacy_monthly_alipay_101";
  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name,
      plan_credits, amount_fen, status, provider, created_at, updated_at,
      expires_at, order_kind, quote_id, cycle, fulfillment_status
    ) VALUES (
      ?, 101, 'legacy-idem-alipay-101', 'business-monthly', '企业月卡',
      5000, 29900, 'pending', 'alipay', '2026-05-01T00:00:00.000Z', '2026-05-01T00:30:00.000Z',
      '2026-05-01T00:30:00.000Z', 'plan', '', '', 'unfulfilled'
    )
  `).run(legacyAlipayNo);

  // Alipay: create new plan quote and attempt to create order
  const alipayQuote = createQuote({ userId: 101, kind: "plan", itemId: "pro", cycle: "monthly" });
  const alipayRes = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-101",
    body: { quoteId: alipayQuote.quoteId, idempotencyKey: `idem-alipay-new-${Date.now()}` },
  });

  assert.notEqual(
    alipayRes.statusCode,
    409,
    `Alipay: Stale legacy plan order must not block new plan order creation with 409 (got: ${alipayRes.body})`
  );
  assert.equal(
    alipayRes.statusCode,
    201,
    `Alipay: Expected 201 Created but got ${alipayRes.statusCode}: ${alipayRes.body}`
  );
  const alipayBody = JSON.parse(alipayRes.body);
  assert.ok(alipayBody.order?.outTradeNo, "Alipay: created order must have outTradeNo");

  // Old legacy order must be transitioned to closed so it cannot block or remain pending
  const oldAlipayOrder = findPaymentOrderByOutTradeNo(legacyAlipayNo);
  assert.equal(
    oldAlipayOrder.status,
    "closed",
    `Alipay: Old legacy stale order must be transitioned to 'closed' (actual: ${oldAlipayOrder.status})`
  );

  // Close newly created order so user 101 has no active lock for wxpay test
  db.prepare("UPDATE payment_orders SET status = 'closed' WHERE out_trade_no = ?").run(alipayBody.order.outTradeNo);
  db.prepare("DELETE FROM account_plan_order_locks WHERE user_id = 101").run();

  // Seed legacy stale order for user 101 under Wxpay (covering status='expired')
  const legacyWxNo = "rb_legacy_monthly_wxpay_101";
  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name,
      plan_credits, amount_fen, status, provider, created_at, updated_at,
      expires_at, order_kind, quote_id, cycle, fulfillment_status
    ) VALUES (
      ?, 101, 'legacy-idem-wxpay-101', 'business-monthly', '企业月卡',
      5000, 29900, 'expired', 'wxpay', '2026-05-02T00:00:00.000Z', '2026-05-02T00:30:00.000Z',
      '2026-05-02T00:30:00.000Z', 'plan', '', '', 'unfulfilled'
    )
  `).run(legacyWxNo);

  // Wxpay: create new plan quote and attempt to create order
  const wxQuote = createQuote({ userId: 101, kind: "plan", itemId: "pro", cycle: "monthly" });
  const wxRes = await api("POST", "/api/payments/wxpay/orders", {
    cookie: "redbase_session=token-user-101",
    body: { quoteId: wxQuote.quoteId, idempotencyKey: `idem-wx-new-${Date.now()}` },
  });

  assert.notEqual(
    wxRes.statusCode,
    409,
    `Wxpay: Stale legacy plan order must not block new plan order creation with 409 (got: ${wxRes.body})`
  );
  assert.equal(
    wxRes.statusCode,
    201,
    `Wxpay: Expected 201 Created but got ${wxRes.statusCode}: ${wxRes.body}`
  );
  const wxBody = JSON.parse(wxRes.body);
  assert.ok(wxBody.order?.outTradeNo, "Wxpay: created order must have outTradeNo");

  const oldWxOrder = findPaymentOrderByOutTradeNo(legacyWxNo);
  assert.equal(
    oldWxOrder.status,
    "closed",
    `Wxpay: Old legacy stale order must be transitioned to 'closed' (actual: ${oldWxOrder.status})`
  );
});

test("2. GET列表过期不持续pending（gateway可关闭则closed，gateway失败则expired但不释放锁）", async () => {
  if (typeof _resetReconcileCacheForTest === "function") _resetReconcileCacheForTest();

  // Part A: Gateway is available and confirms trade closed/not found -> transitions to closed
  const outTradeNoClosed = `rb_stale_get_order_closed_${Date.now()}`;
  const pastIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name,
      plan_credits, amount_fen, status, provider, created_at, updated_at,
      expires_at, order_kind, quote_id, cycle, fulfillment_status
    ) VALUES (
      ?, 102, ?, 'p1', '测试套餐',
      10, 1, 'pending', 'alipay', ?, ?,
      ?, 'topup', '', '', 'unfulfilled'
    )
  `).run(outTradeNoClosed, `idem-stale-closed-${Date.now()}`, pastIso, pastIso, pastIso);

  const resA = await api("GET", "/api/payments/orders", { cookie: "redbase_session=token-user-102" });
  assert.equal(resA.statusCode, 200);
  const bodyA = JSON.parse(resA.body);
  const foundA = (bodyA.orders || []).find((o) => o.outTradeNo === outTradeNoClosed);
  assert.ok(foundA, "Order must be returned in GET /api/payments/orders");
  assert.notEqual(
    foundA.status,
    "pending",
    `Order with past expires_at must not remain 'pending' in GET /api/payments/orders (actual status: ${foundA.status})`
  );
  assert.equal(
    foundA.status,
    "closed",
    `When gateway closes unpaid trade, status must transition to 'closed' (actual status: ${foundA.status})`
  );

  // Part B: Gateway unavailable / failed -> marks order expired but retains plan lock
  const outTradeNoExpired = `rb_stale_lock_106_${Date.now()}`;
  db.prepare(`
    INSERT INTO payment_orders (
      out_trade_no, user_id, idempotency_key, plan_id, plan_name,
      plan_credits, amount_fen, status, provider, created_at, updated_at,
      expires_at, order_kind, quote_id, cycle, fulfillment_status
    ) VALUES (
      ?, 106, ?, 'pro', '专业版',
      400, 99900, 'pending', 'alipay', ?, ?,
      ?, 'plan', '', '', 'unfulfilled'
    )
  `).run(outTradeNoExpired, `idem-stale-lock-${Date.now()}`, pastIso, pastIso, pastIso);

  db.prepare(`
    INSERT INTO account_plan_order_locks (user_id, out_trade_no, plan_id, created_at)
    VALUES (106, ?, 'pro', ?)
  `).run(outTradeNoExpired, pastIso);

  const gateway = getAlipayProvider(appConfig);
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;

  try {
    // Gateway throws on both query and close
    gateway.closeTrade = async () => { throw new Error("Gateway offline"); };
    gateway.queryOrder = async () => { throw new Error("Gateway offline"); };

    if (typeof _resetReconcileCacheForTest === "function") _resetReconcileCacheForTest();

    const resB = await api("GET", "/api/payments/orders", { cookie: "redbase_session=token-user-106" });
    assert.equal(resB.statusCode, 200);
    const bodyB = JSON.parse(resB.body);
    const foundB = (bodyB.orders || []).find((o) => o.outTradeNo === outTradeNoExpired);
    assert.ok(foundB, "Order must be returned in GET /api/payments/orders");
    assert.equal(
      foundB.status,
      "expired",
      `When gateway fails/offline, expired order status must be 'expired' (actual status: ${foundB.status})`
    );

    // Assert that the lock in account_plan_order_locks is NOT released
    const lockRow = db.prepare("SELECT * FROM account_plan_order_locks WHERE user_id = 106").get();
    assert.ok(lockRow, "Lock in account_plan_order_locks must NOT be released when gateway check failed");
    assert.equal(lockRow.out_trade_no, outTradeNoExpired);
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("3. 有效pending仍409且pendingOrder正确", async () => {
  // Create an active plan order for user 103 with future expiry
  const quote1 = createQuote({ userId: 103, kind: "plan", itemId: "pro", cycle: "monthly" });
  const createRes1 = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-103",
    body: { quoteId: quote1.quoteId, idempotencyKey: `idem-active-plan-1-${Date.now()}` },
  });
  assert.equal(createRes1.statusCode, 201);
  const order1 = JSON.parse(createRes1.body).order;
  assert.equal(order1.status, "pending");

  // Attempt to create another plan order while order1 is actively pending
  const quote2 = createQuote({ userId: 103, kind: "plan", itemId: "pro", cycle: "monthly" });
  const createRes2 = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-103",
    body: { quoteId: quote2.quoteId, idempotencyKey: `idem-active-plan-2-${Date.now()}` },
  });

  assert.equal(
    createRes2.statusCode,
    409,
    `Expected 409 Conflict for active pending plan order, got ${createRes2.statusCode}: ${createRes2.body}`
  );
  const errBody = JSON.parse(createRes2.body);
  assert.ok(errBody.error, "Error message must be present in 409 response");
  assert.ok(errBody.pendingOrder, "pendingOrder object must be returned in 409 response");
  assert.equal(errBody.pendingOrder.outTradeNo, order1.outTradeNo, "pendingOrder.outTradeNo must match active order");
  assert.equal(errBody.pendingOrder.status, "pending", "pendingOrder.status must be pending");
  assert.equal(errBody.pendingOrder.orderKind, "plan", "pendingOrder.orderKind must be plan");
});

test("4. 渠道已付先正常履约不误关（断言积分与credit_event增量、重试不重复入账）", async () => {
  const quote = createQuote({ userId: 102, kind: "topup", itemId: "fuel-small" });
  const orderRes = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-102",
    body: { quoteId: quote.quoteId, idempotencyKey: `idem-paid-close-${Date.now()}` },
  });
  assert.equal(orderRes.statusCode, 201);
  const order = JSON.parse(orderRes.body).order;

  const initialCredits = findUserById(102).credits;
  const initialCreditEventsCount = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 102").get().c;

  const gateway = getAlipayProvider(appConfig);
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;

  try {
    // Gateway indicates trade has already been paid
    gateway.closeTrade = async () => {
      const err = new Error("TRADE_ALREADY_PAID");
      err.code = "TRADE_ALREADY_PAID";
      throw err;
    };
    gateway.queryOrder = async () => ({
      data: {
        trade_status: "TRADE_SUCCESS",
        out_trade_no: order.outTradeNo,
        trade_no: "ALIPAY_PAID_TRADE_999",
        total_amount: (order.amountFen / 100).toFixed(2),
        success_time: new Date().toISOString(),
      },
    });

    // Client requests to close the order
    const closeRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-user-102",
      body: {},
    });

    assert.equal(closeRes.statusCode, 200, `Expected 200 on close of already-paid order, got ${closeRes.statusCode}`);
    const closeBody = JSON.parse(closeRes.body);
    assert.equal(closeBody.order.status, "paid", "Order must be settled as 'paid', NOT closed");
    assert.ok(
      closeBody.paidOnClose || closeBody.reconciledOnClose,
      "Response must indicate paid/reconciled on close"
    );

    // Verify DB state
    const dbOrder = findPaymentOrderByOutTradeNo(order.outTradeNo);
    assert.equal(dbOrder.status, "paid", "DB order status must be paid");
    assert.equal(dbOrder.fulfillmentStatus, "fulfilled", "DB order must be fulfilled");

    // Verify account credits and credit_event delta
    const postCredits = findUserById(102).credits;
    const expectedAdded = quote.issuedNow || quote.issued_now || 50;
    assert.equal(
      postCredits,
      initialCredits + expectedAdded,
      `Credits must be incremented by ${expectedAdded} (initial: ${initialCredits}, post: ${postCredits})`
    );

    assert.ok(dbOrder.creditEventId, "Fulfilled order must record creditEventId in DB");
    const rechargeEvent = db.prepare("SELECT * FROM credit_events WHERE id = ?").get(dbOrder.creditEventId);
    assert.ok(rechargeEvent, "Recharge credit event must exist in credit_events table");
    assert.equal(rechargeEvent.action_type, "topup_purchase", "Credit event action_type must be 'topup_purchase'");
    assert.equal(rechargeEvent.credit_delta, expectedAdded, `Credit event delta must match added credits (${expectedAdded})`);
    assert.equal(rechargeEvent.user_id, 102, "Credit event user_id must match order user");

    const rechargeEventsCount = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 102 AND action_type = 'topup_purchase'").get().c;
    assert.equal(rechargeEventsCount, 1, "Exactly one alipay_recharge event must exist for this fulfillment");

    // Idempotent retry: Closing or checking again must NOT issue double credits or duplicate events
    await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-user-102",
      body: {},
    });
    const finalCredits = findUserById(102).credits;
    assert.equal(
      finalCredits,
      postCredits,
      "Retrying close must NOT double-issue credits"
    );
    const finalRechargeEventsCount = db.prepare("SELECT COUNT(*) AS c FROM credit_events WHERE user_id = 102 AND action_type = 'topup_purchase'").get().c;
    assert.equal(
      finalRechargeEventsCount,
      1,
      "Retrying close must NOT create duplicate alipay_recharge events"
    );
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("5. 关闭/查询都失败保留状态和锁（plan订单失败后lock仍关联原单且再建plan仍409）", async () => {
  // Use independent user 105 to create a plan order (which acquires account_plan_order_locks)
  const quote = createQuote({ userId: 105, kind: "plan", itemId: "pro", cycle: "monthly" });
  const orderRes = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-105",
    body: { quoteId: quote.quoteId, idempotencyKey: `idem-plan-lock-test-${Date.now()}` },
  });
  assert.equal(orderRes.statusCode, 201);
  const order = JSON.parse(orderRes.body).order;
  assert.equal(order.status, "pending");

  // Verify lock exists initially
  const lockBefore = db.prepare("SELECT * FROM account_plan_order_locks WHERE user_id = 105").get();
  assert.ok(lockBefore, "account_plan_order_locks must exist after plan order creation");
  assert.equal(lockBefore.out_trade_no, order.outTradeNo);

  const gateway = getAlipayProvider(appConfig);
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;

  try {
    // Both closeTrade and queryOrder fail with network/internal error
    gateway.closeTrade = async () => {
      const err = new Error("Gateway connection timeout");
      err.code = "GATEWAY_TIMEOUT";
      throw err;
    };
    gateway.queryOrder = async () => {
      const err = new Error("Query service unavailable");
      err.code = "SERVICE_UNAVAILABLE";
      throw err;
    };

    const closeRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-user-105",
      body: {},
    });

    assert.equal(closeRes.statusCode, 502, `Expected 502 Bad Gateway when provider fails, got ${closeRes.statusCode}`);

    // DB order status must remain pending
    const dbOrder = findPaymentOrderByOutTradeNo(order.outTradeNo);
    assert.equal(dbOrder.status, "pending", "Order status must remain 'pending' after failed close & query");

    // Lock in account_plan_order_locks must still be retained
    const lockAfter = db.prepare("SELECT * FROM account_plan_order_locks WHERE user_id = 105").get();
    assert.ok(lockAfter, "account_plan_order_locks must NOT be removed when close & query fail");
    assert.equal(lockAfter.out_trade_no, order.outTradeNo, "Lock must still point to original outTradeNo");

    // Creating another plan order must still return 409 Conflict
    const quote2 = createQuote({ userId: 105, kind: "plan", itemId: "pro", cycle: "monthly" });
    const createRes2 = await api("POST", "/api/payments/alipay/orders", {
      cookie: "redbase_session=token-user-105",
      body: { quoteId: quote2.quoteId, idempotencyKey: `idem-plan-blocked-${Date.now()}` },
    });
    assert.equal(
      createRes2.statusCode,
      409,
      `Attempting to create another plan order while locked must return 409 (got: ${createRes2.statusCode})`
    );
    const conflictBody = JSON.parse(createRes2.body);
    assert.equal(
      conflictBody.pendingOrder?.outTradeNo,
      order.outTradeNo,
      "Conflict response must reference the retained pending order"
    );
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("6. wrong-provider close/check/pay-link拒绝", async () => {
  // Create an Alipay order
  const alipayQuote = createQuote({ userId: 102, kind: "topup", itemId: "fuel-small" });
  const alipayOrderRes = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-user-102",
    body: { quoteId: alipayQuote.quoteId, idempotencyKey: `idem-wrong-alipay-${Date.now()}` },
  });
  const alipayOrder = JSON.parse(alipayOrderRes.body).order;

  // Calling Wxpay endpoints for this Alipay order must reject with 400
  const wxClose = await api("POST", `/api/payments/wxpay/orders/${alipayOrder.outTradeNo}/close`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(wxClose.statusCode, 400, "Wxpay close must reject Alipay order with 400");
  assert.match(JSON.parse(wxClose.body).error, /订单支付渠道不匹配/);

  const wxCheck = await api("POST", `/api/payments/wxpay/orders/${alipayOrder.outTradeNo}/check`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(wxCheck.statusCode, 400, "Wxpay check must reject Alipay order with 400");
  assert.match(JSON.parse(wxCheck.body).error, /订单支付渠道不匹配/);

  const wxPayLink = await api("POST", `/api/payments/wxpay/orders/${alipayOrder.outTradeNo}/pay-link`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(wxPayLink.statusCode, 400, "Wxpay pay-link must reject Alipay order with 400");
  assert.match(JSON.parse(wxPayLink.body).error, /订单支付渠道不匹配/);

  // Create a Wxpay order
  const wxQuote = createQuote({ userId: 102, kind: "topup", itemId: "fuel-small" });
  const wxOrderRes = await api("POST", "/api/payments/wxpay/orders", {
    cookie: "redbase_session=token-user-102",
    body: { quoteId: wxQuote.quoteId, idempotencyKey: `idem-wrong-wx-${Date.now()}` },
  });
  const wxOrder = JSON.parse(wxOrderRes.body).order;

  // Calling Alipay endpoints for this Wxpay order must reject with 400
  const alipayClose = await api("POST", `/api/payments/alipay/orders/${wxOrder.outTradeNo}/close`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(alipayClose.statusCode, 400, "Alipay close must reject Wxpay order with 400");
  assert.match(JSON.parse(alipayClose.body).error, /订单支付渠道不匹配/);

  const alipayCheck = await api("POST", `/api/payments/alipay/orders/${wxOrder.outTradeNo}/check`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(alipayCheck.statusCode, 400, "Alipay check must reject Wxpay order with 400");
  assert.match(JSON.parse(alipayCheck.body).error, /订单支付渠道不匹配/);

  const alipayPayLink = await api("POST", `/api/payments/alipay/orders/${wxOrder.outTradeNo}/pay-link`, {
    cookie: "redbase_session=token-user-102",
    body: {},
  });
  assert.equal(alipayPayLink.statusCode, 400, "Alipay pay-link must reject Wxpay order with 400");
  assert.match(JSON.parse(alipayPayLink.body).error, /订单支付渠道不匹配/);
});

test("7. 已closed/expired/paid幂等重放不得重造QR", async () => {
  const gateway = getAlipayProvider(appConfig);
  let createQrCodeCallCount = 0;
  const originalCreateQrCode = gateway.createQrCode;
  gateway.createQrCode = async (...args) => {
    createQrCodeCallCount += 1;
    return originalCreateQrCode.apply(gateway, args);
  };

  try {
    for (const terminalStatus of ["closed", "expired", "paid"]) {
      const idemKey = `idem-terminal-replay-${terminalStatus}-${Date.now()}`;
      const quote = createQuote({ userId: 102, kind: "topup", itemId: "fuel-small" });
      const createRes = await api("POST", "/api/payments/alipay/orders", {
        cookie: "redbase_session=token-user-102",
        body: { quoteId: quote.quoteId, idempotencyKey: idemKey },
      });
      assert.equal(createRes.statusCode, 201);
      const order = JSON.parse(createRes.body).order;

      // Update to terminal status
      updatePaymentOrderStatus({
        outTradeNo: order.outTradeNo,
        status: terminalStatus,
        nowIso: new Date().toISOString(),
      });

      const qrCallsBefore = createQrCodeCallCount;

      // Replay order creation with the exact same idempotency key
      const replayRes = await api("POST", "/api/payments/alipay/orders", {
        cookie: "redbase_session=token-user-102",
        body: { quoteId: quote.quoteId, idempotencyKey: idemKey },
      });

      // Must not recreate QR code or call gateway.createQrCode
      assert.equal(
        createQrCodeCallCount,
        qrCallsBefore,
        `gateway.createQrCode must not be invoked on terminal (${terminalStatus}) replay`
      );
      const replayOrder = JSON.parse(replayRes.body).order;
      assert.equal(
        replayOrder.status,
        terminalStatus,
        `Order status must remain '${terminalStatus}' after replay`
      );

      // pay-link endpoint must also reject terminal orders and not invoke createQrCode
      const payLinkRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/pay-link`, {
        cookie: "redbase_session=token-user-102",
        body: {},
      });
      assert.equal(payLinkRes.statusCode, 400, `pay-link must reject terminal (${terminalStatus}) orders with 400`);
      assert.equal(createQrCodeCallCount, qrCallsBefore, "pay-link must not create QR for terminal orders");
    }
  } finally {
    gateway.createQrCode = originalCreateQrCode;
  }
});

test("8. 挂起createQrCode同时close/notify终态不被pending覆盖", async () => {
  const scenarios = [
    { provider: "alipay", terminal: "paid" },
    { provider: "alipay", terminal: "closed" },
    { provider: "wxpay", terminal: "paid" },
    { provider: "wxpay", terminal: "closed" },
  ];

  for (const { provider, terminal } of scenarios) {
    const gateway = provider === "alipay" ? getAlipayProvider(appConfig) : getWxpayProvider(appConfig);
    const originalCreateQrCode = gateway.createQrCode;

    let enteredSignal;
    const enteredPromise = new Promise((resolve) => { enteredSignal = resolve; });

    let releaseSignal;
    const releasePromise = new Promise((resolve) => { releaseSignal = resolve; });

    let capturedOutTradeNo = null;

    gateway.createQrCode = async (params) => {
      capturedOutTradeNo = params.outTradeNo;
      enteredSignal(params.outTradeNo);
      await releasePromise;
      return originalCreateQrCode.apply(gateway, [params]);
    };

    try {
      const quote = createQuote({ userId: 104, kind: "topup", itemId: "fuel-small" });
      const idemKey = `idem-race-${provider}-${terminal}-${Date.now()}`;
      const initialCredits = findUserById(104).credits;

      // Start order creation in background
      const orderPromise = api("POST", `/api/payments/${provider}/orders`, {
        cookie: "redbase_session=token-user-104",
        body: { quoteId: quote.quoteId, idempotencyKey: idemKey },
      });

      // Bounded wait for createQrCode entry (timeout 2000ms)
      const enteredTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout waiting for createQrCode entry (${provider}/${terminal})`)), 2000)
      );
      await Promise.race([enteredPromise, enteredTimeout]);

      assert.ok(capturedOutTradeNo, `capturedOutTradeNo must be present for ${provider}/${terminal}`);
      const inFlightOrder = findPaymentOrderByOutTradeNo(capturedOutTradeNo);
      assert.ok(inFlightOrder, `In-flight order must exist in DB for ${provider}/${terminal}`);
      assert.equal(inFlightOrder.status, "created", `In-flight order status must initially be 'created' for ${provider}/${terminal}`);

      // While createQrCode is suspended, trigger real notify/settle or close
      if (terminal === "paid") {
        const settleRes = await api("GET", `/api/payments/fake/${provider}/settle?outTradeNo=${encodeURIComponent(capturedOutTradeNo)}`);
        assert.equal(settleRes.statusCode, 200, `Fake settle must return 200 (got: ${settleRes.body})`);
      } else {
        const closeRes = await api("POST", `/api/payments/${provider}/orders/${encodeURIComponent(capturedOutTradeNo)}/close`, {
          cookie: "redbase_session=token-user-104",
          body: {},
        });
        assert.equal(closeRes.statusCode, 200, `Close must return 200 (got: ${closeRes.body})`);
      }

      const preReleaseOrder = findPaymentOrderByOutTradeNo(capturedOutTradeNo);
      assert.equal(
        preReleaseOrder.status,
        terminal,
        `Order status in DB must be '${terminal}' before createQrCode release for ${provider}/${terminal}`
      );

      // Release createQrCode
      releaseSignal();

      // Await order creation completion
      const orderRes = await orderPromise;
      const orderBody = JSON.parse(orderRes.body);

      // Assert final DB status remains terminal and is NOT overwritten by pending
      const finalOrder = findPaymentOrderByOutTradeNo(capturedOutTradeNo);
      assert.equal(
        finalOrder.status,
        terminal,
        `Order status in DB must remain '${terminal}' and NOT be overwritten by pending for ${provider}/${terminal}`
      );

      // Assert order creation response must NOT expose usable QR or payUrl when already terminal
      assert.equal(
        orderBody.qrCode || "",
        "",
        `Order creation response must have empty qrCode when order was already ${terminal} (${provider})`
      );
      assert.equal(
        orderBody.payUrl || "",
        "",
        `Order creation response must have empty payUrl when order was already ${terminal} (${provider})`
      );

      // Assert credits: paid increments exactly once, closed does not increment
      const finalCredits = findUserById(104).credits;
      const expectedCreditsAdded = quote.issuedNow || quote.issued_now || 50;
      if (terminal === "paid") {
        assert.equal(
          finalCredits,
          initialCredits + expectedCreditsAdded,
          `Paid order must credit user exactly once for ${provider} (initial: ${initialCredits}, final: ${finalCredits}, added: ${expectedCreditsAdded})`
        );
      } else {
        assert.equal(
          finalCredits,
          initialCredits,
          `Closed order must not increment user credits for ${provider} (initial: ${initialCredits}, final: ${finalCredits})`
        );
      }
    } finally {
      if (typeof releaseSignal === "function") releaseSignal();
      gateway.createQrCode = originalCreateQrCode;
    }
  }
});
