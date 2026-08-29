const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { getAlipayProvider } = require("../../src/server/integrations/alipay");
const { reconcileOrders } = require("../../src/server/billing/reconcile-orders");
const { getFinanceMetrics } = require("../../src/server/analytics/analytics-metrics");
const {
  insertUser,
  findUserByPhone,
} = require("../../src/server/db/repositories/auth-repository");
const {
  insertPaymentOrder,
  findPaymentOrderByOutTradeNo,
  closePaymentOrder,
} = require("../../src/server/db/repositories/payment-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();
const appConfig = {
  alipay: { provider: "fake", fakeAllowed: true },
};
const gateway = getAlipayProvider(appConfig);

insertUser({
  id: 1,
  name: "对账用户",
  phone: "13900000001",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-08-04T00:00:00.000Z",
});

const NOW = "2026-08-04T12:00:00.000Z";

function seedOrder(outTradeNo, idempotencyKey, expiresAtIso, status = "pending") {
  insertPaymentOrder({
    outTradeNo,
    userId: 1,
    idempotencyKey,
    plan: { id: "p1", name: "测试套餐", credits: 10, amountFen: 1 },
    status,
    nowIso: "2026-08-04T00:00:00.000Z",
    expiresAtIso,
  });
}

test("an expired order that was actually paid is settled by reconciliation", async () => {
  const outTradeNo = "redbase_reconcile_expired_paid_1";
  seedOrder(outTradeNo, "reconcile-expired-paid-1", "2026-08-04T01:00:00.000Z");
  gateway.settle({ outTradeNo, tradeNo: "RECONCILE_PAID_1", totalAmount: "0.01" });
  const creditsBefore = Number(findUserByPhone("13900000001").credits);

  const summary = await reconcileOrders({ gateway, nowIso: NOW });

  assert.equal(summary.paid, 1);
  assert.equal(findPaymentOrderByOutTradeNo(outTradeNo).status, "paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore + 10);
});

test("an expired unpaid order is marked expired and stays reconcilable", async () => {
  const outTradeNo = "redbase_reconcile_expired_unpaid_1";
  seedOrder(outTradeNo, "reconcile-expired-unpaid-1", "2026-08-04T01:00:00.000Z");

  const summary = await reconcileOrders({ gateway, nowIso: NOW });

  assert.equal(summary.expired, 1);
  const order = findPaymentOrderByOutTradeNo(outTradeNo);
  assert.equal(order.status, "expired");
  const failedEventKey = `payment_failed:${order.id}`;
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE event_key = ?").get(failedEventKey).count,
    1,
  );

  const finance = getFinanceMetrics({ from: "2026-08-04", to: "2026-08-05", accountType: "customer" });
  assert.equal(finance.overview.expiredOrFailed, 1);
  assert.equal(finance.overview.pendingUnexpired, 0);

  await reconcileOrders({ gateway, nowIso: NOW });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE event_key = ?").get(failedEventKey).count,
    1,
  );
});

test("a closed order that was actually paid is flagged for audit, never silently dropped", async () => {
  const outTradeNo = "redbase_reconcile_closed_paid_1";
  seedOrder(outTradeNo, "reconcile-closed-paid-1", "2026-08-04T02:00:00.000Z");
  closePaymentOrder({ userId: 1, outTradeNo, nowIso: "2026-08-04T03:00:00.000Z" });
  gateway.settle({ outTradeNo, tradeNo: "RECONCILE_CLOSED_PAID_1", totalAmount: "0.01" });
  const creditsBefore = Number(findUserByPhone("13900000001").credits);
  const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count;

  const summary = await reconcileOrders({ gateway, nowIso: NOW });

  assert.equal(summary.audit, 1);
  const stored = findPaymentOrderByOutTradeNo(outTradeNo);
  assert.equal(stored.status, "closed");
  assert.equal(stored.auditReason, "closed_provider_paid");
  assert.equal(Number(findUserByPhone("13900000001").credits), creditsBefore);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE action_type = 'alipay_recharge'").get().count,
    eventsBefore,
  );
});
