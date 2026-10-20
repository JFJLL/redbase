"use strict";

const path = require("path");
const fs = require("fs");

const dbPath = process.argv[2];
const action = process.argv[3];
const workerId = process.argv[4];
const barrierFile = process.argv[5];

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = dbPath;

const { openDatabase, getDbProxy, transaction } = require("../../../src/server/db/connection");
const {
  reserveCreditsForTask,
  settleCreditsForTask,
  getUserWalletBalances,
} = require("../../../src/server/billing/credit-ledger");
const {
  advanceSubscriptionLifecycles,
} = require("../../../src/server/billing/subscription-service");
const {
  insertPaymentOrder,
} = require("../../../src/server/db/repositories/payment-repository");

const conn = openDatabase();
try {
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
} catch (_) {}

const startTime = Date.now();
while (!fs.existsSync(barrierFile)) {
  if (Date.now() - startTime > 10000) {
    process.send ? process.send({ error: "barrier_timeout" }) : console.error("barrier_timeout");
    process.exit(1);
  }
  const waitTill = new Date(new Date().getTime() + 10);
  while (waitTill > new Date()) {}
}

let result = {};
if (action === "reserve") {
  try {
    const reservations = transaction(() => {
      return reserveCreditsForTask({
        userId: 1,
        taskId: `worker_task_${workerId}`,
        taskType: "concurrent_test",
        amount: 10,
        nowIso: new Date().toISOString(),
      }, conn);
    })();
    result = { success: true, count: reservations.length, reservations };
  } catch (err) {
    result = { success: false, error: err.message };
  }
} else if (action === "advance") {
  try {
    const advanceNow = Number(process.argv[6] || Date.now());
    advanceSubscriptionLifecycles(advanceNow, conn);
    result = { success: true };
  } catch (err) {
    result = { success: false, error: err.message };
  }
} else if (action === "create_plan_order") {
  try {
    const outTradeNo = `order_conc_${workerId}_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const order = transaction(() => {
      return insertPaymentOrder({
        outTradeNo,
        userId: 1,
        idempotencyKey: `idem_worker_${workerId}`,
        plan: { id: "pro", name: "专业版", amountFen: 7900, credits: 400 },
        status: "created",
        provider: "alipay",
        nowIso,
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        quote: { id: `q_worker_${workerId}`, item_id: "pro", kind: "plan", issued_now: 400, amount_fen: 7900, cycle: "monthly", action: "activate", expires_at: "2030-01-01T00:00:00.000Z" },
        acquireLock: true,
      });
    })();
    result = { success: true, orderId: order.id, outTradeNo };
  } catch (err) {
    result = { success: false, error: err.message, code: err.code };
  }
}

if (process.send) {
  process.send(result);
} else {
  console.log(JSON.stringify(result));
}
try { conn.close(); } catch (_) {}
process.exit(0);
