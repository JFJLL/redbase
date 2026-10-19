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

const conn = openDatabase();

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
}

if (process.send) {
  process.send(result);
} else {
  console.log(JSON.stringify(result));
}
process.exit(0);
