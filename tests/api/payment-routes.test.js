const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { handlePaymentRoutes, processAlipayNotify } = require("../../src/server/api/payment-routes");
const { getAlipayProvider } = require("../../src/server/integrations/alipay");
const {
  insertUser,
  insertSession,
  findUserByPhone,
} = require("../../src/server/db/repositories/auth-repository");
const {
  findPaymentOrderByOutTradeNo,
  markPaymentOrderExpired,
} = require("../../src/server/db/repositories/payment-repository");

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
    appId: "",
    privateKey: "",
    alipayPublicKey: "",
    sellerId: "",
    returnUrl: "http://127.0.0.1:3013/app/billing",
    notifyUrl: "",
  },
  billing: {
    rechargePlans: [{ id: "p1", name: "测试套餐 10 积分", credits: 10, amountFen: 1 }],
  },
};

insertUser({
  id: 1,
  name: "买家甲",
  phone: "13900000001",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-08-04T00:00:00.000Z",
});
insertSession({ token: "token-a", userId: 1, createdAt: "2026-08-04T00:00:00.000Z" });
insertUser({
  id: 2,
  name: "买家乙",
  phone: "13900000002",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-08-04T00:00:00.000Z",
});
insertSession({ token: "token-b", userId: 2, createdAt: "2026-08-04T00:00:00.000Z" });

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

async function createOrder(cookie = "redbase_session=token-a", idempotencyKey = `idem-${Date.now()}`) {
  return await api("POST", "/api/payments/alipay/orders", {
    cookie,
    body: { planId: "p1", idempotencyKey },
  });
}

function notifyParams(gateway, outTradeNo, overrides = {}) {
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  return gateway.buildNotifyParams({
    outTradeNo,
    tradeNo: `FAKE${Date.now()}${Math.floor(Math.random() * 10000)}`,
    totalAmount: order ? (order.amountFen / 100).toFixed(2) : "0.01",
    ...overrides,
  });
}

async function sendNotify(params) {
  return await api("POST", "/api/payments/alipay/notify", { form: params });
}

test("recharge plans require login and expose configured plans", async () => {
  const anon = await api("GET", "/api/billing/recharge-plans");
  assert.equal(anon.statusCode, 401);

  const res = await api("GET", "/api/billing/recharge-plans", { cookie: "redbase_session=token-a" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.plans, [{ id: "p1", name: "测试套餐 10 积分", credits: 10, amountYuan: "0.01" }]);
  assert.equal(body.fakeSettle, true);
});

test("P6: recharge plans are hidden when alipay is disabled", async () => {
  const disabledConfig = {
    ...appConfig,
    alipay: { ...appConfig.alipay, enabled: false },
  };
  const res = createRes();
  await handlePaymentRoutes(
    { appConfig: disabledConfig },
    createGetReq("/api/billing/recharge-plans", "redbase_session=token-a"),
    res,
    "/api/billing/recharge-plans",
  );

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.plans, []);
  assert.equal(body.fakeSettle, false);
});

test("P6: recharge plans are hidden when the payment gateway is unavailable", async () => {
  const noGatewayConfig = {
    ...appConfig,
    alipay: { ...appConfig.alipay, enabled: true, provider: "disabled", fakeAllowed: false },
  };
  const res = createRes();
  await handlePaymentRoutes(
    { appConfig: noGatewayConfig },
    createGetReq("/api/billing/recharge-plans", "redbase_session=token-a"),
    res,
    "/api/billing/recharge-plans",
  );

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.plans, []);
  assert.equal(body.fakeSettle, false);
});

test("P6: recharge plans stay visible when alipay is enabled and configured", async () => {
  const res = await api("GET", "/api/billing/recharge-plans", { cookie: "redbase_session=token-a" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.plans, [{ id: "p1", name: "测试套餐 10 积分", credits: 10, amountYuan: "0.01" }]);
  assert.equal(body.fakeSettle, true);
});

test("create order is idempotent and rejects unconfigured plans", async () => {
  const first = await createOrder("redbase_session=token-a", "idem-same-key-001");
  assert.equal(first.statusCode, 201);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.order.status, "pending");
  assert.match(firstBody.payUrl, /^http/);
  assert.equal(firstBody.qrCode, `https://qr.alipay.test/${firstBody.order.outTradeNo}`);
  assert.equal(firstBody.qrCodeError, "");
  assert.equal(firstBody.order.amountYuan, "0.01");

  const replay = await createOrder("redbase_session=token-a", "idem-same-key-001");
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body).order.outTradeNo, firstBody.order.outTradeNo);

  const missingPlan = await api("POST", "/api/payments/alipay/orders", {
    cookie: "redbase_session=token-a",
    body: { planId: "nope", idempotencyKey: "idem-missing-plan" },
  });
  assert.equal(missingPlan.statusCode, 400);
});

test("precreate failure preserves the PC pay link and returns a clear QR fallback", async () => {
  const gateway = getAlipayProvider(appConfig);
  const originalCreateQrCode = gateway.createQrCode;
  gateway.createQrCode = async () => { throw new Error("当前调用IP不在可信名单中"); };
  try {
    const response = await createOrder("redbase_session=token-a", `idem-precreate-fallback-${Date.now()}`);
    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.match(body.payUrl, /^http/);
    assert.equal(body.qrCode, "");
    assert.match(body.qrCodeError, /扫码支付暂不可用/);
  } finally {
    gateway.createQrCode = originalCreateQrCode;
  }
});

test("rollback mode blocks new orders but keeps notify processing", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-rollback-${Date.now()}`);
  const outTradeNo = JSON.parse(orderRes.body).order.outTradeNo;
  const disabledConfig = {
    ...appConfig,
    alipay: { ...appConfig.alipay, enabled: false },
  };

  const disabledRes = createRes();
  await handlePaymentRoutes(
    { appConfig: disabledConfig },
    createJsonReq(
      "/api/payments/alipay/orders",
      { planId: "p1", idempotencyKey: "idem-disabled" },
      "redbase_session=token-a",
    ),
    disabledRes,
    "/api/payments/alipay/orders",
  );
  assert.equal(disabledRes.statusCode, 503);

  const res = createRes();
  const params = notifyParams(gateway, outTradeNo);
  await handlePaymentRoutes(
    { appConfig: disabledConfig },
    createFormReq("/api/payments/alipay/notify", params),
    res,
    "/api/payments/alipay/notify",
  );
  assert.equal(res.body, "success");
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "paid");
});

test("notify rejects bad signature, wrong merchant, wrong amount and unknown orders", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder();
  const outTradeNo = JSON.parse(orderRes.body).order.outTradeNo;

  const badSign = await sendNotify({ ...notifyParams(gateway, outTradeNo), sign: "deadbeef" });
  assert.equal(badSign.body, "failure");

  const wrongApp = await sendNotify(notifyParams(gateway, outTradeNo, { app_id: "999" }));
  assert.equal(wrongApp.body, "failure");

  const wrongSeller = await sendNotify(notifyParams(gateway, outTradeNo, { seller_id: "999" }));
  assert.equal(wrongSeller.body, "failure");

  const wrongAmount = await sendNotify(notifyParams(gateway, outTradeNo, { total_amount: "999.99" }));
  assert.equal(wrongAmount.body, "failure");

  const unknown = await sendNotify(notifyParams(gateway, "redbase_does_not_exist"));
  assert.equal(unknown.body, "failure");
});

test("valid notify pays the order and credits exactly once", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-paid-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count;

  const params = notifyParams(gateway, order.outTradeNo);
  const first = await sendNotify(params);
  assert.equal(first.body, "success");
  const second = await sendNotify(params);
  assert.equal(second.body, "success");

  const stored = findPaymentOrderByOutTradeNo(order.outTradeNo);
  assert.equal(stored.status, "paid");
  assert.equal(stored.tradeNo, params.trade_no);
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count,
    eventsBefore + 1,
  );
  const event = db.prepare("SELECT * FROM credit_events WHERE action_type = 'alipay_recharge' ORDER BY id DESC LIMIT 1").get();
  assert.equal(event.credit_delta, 10);
  assert.equal(stored.creditEventId, event.id);
});

test("a second order cannot reuse an existing trade_no", async () => {
  const gateway = getAlipayProvider(appConfig);
  const firstRes = await createOrder("redbase_session=token-a", `idem-tradeno-${Date.now()}`);
  const secondRes = await createOrder("redbase_session=token-a", `idem-tradeno2-${Date.now()}`);
  const first = JSON.parse(firstRes.body).order;
  const second = JSON.parse(secondRes.body).order;

  const firstNotify = notifyParams(gateway, first.outTradeNo);
  assert.equal((await sendNotify(firstNotify)).body, "success");

  const duplicate = notifyParams(gateway, second.outTradeNo, { trade_no: firstNotify.trade_no });
  assert.equal((await sendNotify(duplicate)).body, "failure");
  assert.equal(findPaymentOrderByOutTradeNo(second.outTradeNo).status, "pending");
});

test("synchronous return never credits and late payment is allowed after expiry", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-return-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const creditsBefore = Number(findUserByPhone("13900000001").credits);

  const params = notifyParams(gateway, order.outTradeNo);
  const query = new URLSearchParams(params).toString();
  const returned = await api("GET", `/api/payments/alipay/return?${query}`);
  assert.equal(returned.statusCode, 302);
  assert.match(String(returned.getHeader("location")), /\/app\/billing\?/);
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");

  markPaymentOrderExpired({ outTradeNo: order.outTradeNo, nowIso: new Date().toISOString() });
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "expired");
  const late = await sendNotify(notifyParams(gateway, order.outTradeNo, { trade_no: `LATE${Date.now()}` }));
  assert.equal(late.body, "success");
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
});

test("twenty concurrent notifications credit only once without 500s", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-concurrent-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count;
  const params = notifyParams(gateway, order.outTradeNo);

  const results = await Promise.all(
    Array.from({ length: 20 }, () => sendNotify(params)),
  );
  assert.equal(results.every((res) => res.body === "success"), true);
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count,
    eventsBefore + 1,
  );
});

test("orders are scoped to the owner and close/paid transitions are guarded", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-scope-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;

  const foreign = await api("GET", `/api/payments/orders/${order.outTradeNo}`, { cookie: "redbase_session=token-b" });
  assert.equal(foreign.statusCode, 404);

  const ownList = await api("GET", "/api/payments/orders", { cookie: "redbase_session=token-a" });
  const list = JSON.parse(ownList.body).orders;
  assert.equal(list.some((item) => item.outTradeNo === order.outTradeNo), true);

  const foreignClose = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
    cookie: "redbase_session=token-b",
    body: {},
  });
  assert.equal(foreignClose.statusCode, 404);

  const paid = await sendNotify(notifyParams(gateway, order.outTradeNo));
  assert.equal(paid.body, "success");
  const closePaid = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
    cookie: "redbase_session=token-a",
    body: {},
  });
  assert.equal(closePaid.statusCode, 400);

  const closable = await createOrder("redbase_session=token-a", `idem-close-${Date.now()}`);
  const closableOrder = JSON.parse(closable.body).order;
  const closed = await api("POST", `/api/payments/alipay/orders/${closableOrder.outTradeNo}/close`, {
    cookie: "redbase_session=token-a",
    body: {},
  });
  assert.equal(closed.statusCode, 200);
  assert.equal(JSON.parse(closed.body).order.status, "closed");
});

test("P0: a closed order must never silently accept a later provider payment", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-closed-late-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const creditsBefore = Number(findUserByPhone("13900000001").credits);

  const closeRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
    cookie: "redbase_session=token-a",
    body: {},
  });
  assert.equal(closeRes.statusCode, 200);
  assert.equal(JSON.parse(closeRes.body).order.status, "closed");

  // Provider still (or again) reports a successful payment after local close.
  const lateTradeNo = `LATE${Date.now()}`;
  gateway.settle({ outTradeNo: order.outTradeNo, tradeNo: lateTradeNo, totalAmount: "0.01" });
  const notify = await sendNotify(
    gateway.buildNotifyParams({
      outTradeNo: order.outTradeNo,
      tradeNo: lateTradeNo,
      totalAmount: "0.01",
    }),
  );

  assert.equal(notify.body, "failure");
  const stored = findPaymentOrderByOutTradeNo(order.outTradeNo);
  assert.equal(stored.status, "closed");
  assert.equal(stored.auditReason, "closed_provider_paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
});

test("P0: closing an already paid provider order settles it instead of closing", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-close-already-paid-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  gateway.settle({ outTradeNo: order.outTradeNo, tradeNo: "ALREADY_PAID", totalAmount: "0.01" });

  const closeRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
    cookie: "redbase_session=token-a",
    body: {},
  });

  assert.equal(closeRes.statusCode, 200);
  assert.equal(JSON.parse(closeRes.body).order.status, "paid");
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
});

test("P0: closing without a gateway refuses locally instead of silently closing", async () => {
  const orderRes = await createOrder("redbase_session=token-a", `idem-close-no-gateway-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const noGatewayConfig = {
    ...appConfig,
    alipay: { ...appConfig.alipay, provider: "disabled", fakeAllowed: false },
  };

  const res = createRes();
  await handlePaymentRoutes(
    { appConfig: noGatewayConfig },
    createJsonReq(
      `/api/payments/alipay/orders/${order.outTradeNo}/close`,
      {},
      "redbase_session=token-a",
    ),
    res,
    `/api/payments/alipay/orders/${order.outTradeNo}/close`,
  );

  assert.equal(res.statusCode, 503);
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
});

test("a provider-missing trade closes locally only after a confirming query", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-close-missing-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;
  gateway.closeTrade = async () => {
    throw Object.assign(new Error("支付宝交易不存在"), { code: "ALIPAY_TRADE_NOT_EXIST" });
  };
  gateway.queryOrder = async () => ({ data: {}, notFound: true, responseHttpStatus: 200 });
  try {
    const response = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.providerTradeNotFound, true);
    assert.equal(body.order.status, "closed");
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "closed");
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("a missing-trade close remains pending when the confirmation query finds a live trade", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-close-live-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;
  gateway.closeTrade = async () => {
    throw Object.assign(new Error("支付宝交易不存在"), { code: "ALIPAY_TRADE_NOT_EXIST" });
  };
  gateway.queryOrder = async () => ({
    data: {
      out_trade_no: order.outTradeNo,
      trade_status: "WAIT_BUYER_PAY",
      total_amount: "0.01",
    },
    notFound: false,
  });
  try {
    const response = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("a missing-trade close does not locally close an already closed provider trade", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-close-provider-closed-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const originalCloseTrade = gateway.closeTrade;
  const originalQueryOrder = gateway.queryOrder;
  gateway.closeTrade = async () => {
    throw Object.assign(new Error("支付宝交易不存在"), { code: "ALIPAY_TRADE_NOT_EXIST" });
  };
  gateway.queryOrder = async () => ({
    data: { out_trade_no: order.outTradeNo, trade_status: "TRADE_CLOSED", total_amount: "0.01" },
    notFound: false,
  });
  try {
    const response = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    assert.equal(response.statusCode, 409);
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
  } finally {
    gateway.closeTrade = originalCloseTrade;
    gateway.queryOrder = originalQueryOrder;
  }
});

test("fake settle page settles through the same notify path", async () => {
  const orderRes = await createOrder("redbase_session=token-a", `idem-fake-settle-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const settled = await api("GET", `/api/payments/fake/alipay/settle?outTradeNo=${order.outTradeNo}`);
  assert.equal(settled.statusCode, 200);
  assert.equal(JSON.parse(settled.body).order.status, "paid");
  assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "paid");
});

test("owned pending orders can refresh their pay link and actively reconcile payment status", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-active-check-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;

  const payLink = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/pay-link`, {
    cookie: "redbase_session=token-a",
    body: {},
  });
  assert.equal(payLink.statusCode, 200);
  const payLinkBody = JSON.parse(payLink.body);
  assert.match(payLinkBody.payUrl, /^http/);
  assert.equal(payLinkBody.qrCode, `https://qr.alipay.test/${order.outTradeNo}`);

  const foreignPayLink = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/pay-link`, {
    cookie: "redbase_session=token-b",
    body: {},
  });
  assert.equal(foreignPayLink.statusCode, 404);

  const foreignCheck = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/check`, {
    cookie: "redbase_session=token-b",
    body: {},
  });
  assert.equal(foreignCheck.statusCode, 404);

  gateway.settle({ outTradeNo: order.outTradeNo, tradeNo: `CHECK${Date.now()}`, totalAmount: "0.01" });
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  const checked = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/check`, {
    cookie: "redbase_session=token-a",
    body: {},
  });

  assert.equal(checked.statusCode, 200);
  assert.equal(JSON.parse(checked.body).order.status, "paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);

  const checkedAgain = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/check`, {
    cookie: "redbase_session=token-a",
    body: {},
  });
  assert.equal(checkedAgain.statusCode, 200);
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
});

test("P0: paid-on-close rejects missing identity or a wrong amount", async () => {
  const gateway = getAlipayProvider(appConfig);
  const originalCloseTrade = gateway.closeTrade.bind(gateway);
  const runCase = async (suffix, closeResult) => {
    const orderRes = await createOrder("redbase_session=token-a", `idem-close-unsafe-${suffix}-${Date.now()}`);
    const order = JSON.parse(orderRes.body).order;
    gateway.closeTrade = async () => closeResult(order);
    const creditsBefore = Number(findUserByPhone("13900000001").credits);
    const closeRes = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/close`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    assert.equal(closeRes.statusCode, 502);
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
    assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
  };
  try {
    await runCase("amount", (order) => ({
      alreadyPaid: true,
      outTradeNo: order.outTradeNo,
      tradeNo: `BADAMOUNT${Date.now()}`,
      totalAmount: "9.99",
    }));
    await runCase("identity", () => ({ alreadyPaid: true, tradeNo: "", totalAmount: "0.01" }));
  } finally {
    gateway.closeTrade = originalCloseTrade;
  }
});

test("active reconciliation rejects a same-amount response for a different order", async () => {
  const gateway = getAlipayProvider(appConfig);
  const orderRes = await createOrder("redbase_session=token-a", `idem-active-mismatch-${Date.now()}`);
  const order = JSON.parse(orderRes.body).order;
  const originalQueryOrder = gateway.queryOrder.bind(gateway);
  gateway.queryOrder = async () => ({
    data: {
      out_trade_no: "redbase_different_order",
      trade_no: `MISMATCH${Date.now()}`,
      trade_status: "TRADE_SUCCESS",
      total_amount: "0.01",
    },
  });
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  try {
    const checked = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/check`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    assert.equal(checked.statusCode, 502);
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
    assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
  } finally {
    gateway.queryOrder = originalQueryOrder;
  }
});

test("active reconciliation reports provider amount and status anomalies", async () => {
  const gateway = getAlipayProvider(appConfig);
  const originalQueryOrder = gateway.queryOrder.bind(gateway);
  const runCase = async (suffix, data) => {
    const orderRes = await createOrder("redbase_session=token-a", `idem-active-anomaly-${suffix}-${Date.now()}`);
    const order = JSON.parse(orderRes.body).order;
    gateway.queryOrder = async () => ({ data: { out_trade_no: order.outTradeNo, ...data } });
    const creditsBefore = Number(findUserByPhone("13900000001").credits);
    const checked = await api("POST", `/api/payments/alipay/orders/${order.outTradeNo}/check`, {
      cookie: "redbase_session=token-a",
      body: {},
    });
    assert.equal(checked.statusCode, 502);
    assert.equal(findPaymentOrderByOutTradeNo(order.outTradeNo).status, "pending");
    assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
  };
  try {
    await runCase("amount", { trade_no: `AMOUNT${Date.now()}`, trade_status: "TRADE_SUCCESS", total_amount: "9.99" });
    await runCase("status", { trade_no: `STATUS${Date.now()}`, trade_status: "TRADE_SUSPICIOUS", total_amount: "0.01" });
  } finally {
    gateway.queryOrder = originalQueryOrder;
  }
});

test("processAlipayNotify returns failure for unknown trade status", () => {
  const gateway = getAlipayProvider(appConfig);
  const result = processAlipayNotify({
    params: gateway.buildNotifyParams({
      outTradeNo: "x",
      tradeNo: "x",
      totalAmount: "0.01",
      tradeStatus: "TRADE_UNKNOWN",
    }),
    appConfig,
    gateway,
    nowIso: new Date().toISOString(),
  });
  assert.equal(result.ok, false);
});
