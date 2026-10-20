const { getDbProxy, transaction } = require("../connection");

const db = getDbProxy();
const TREND_ANALYSIS_RESERVATION_TTL_MS = 20 * 60 * 1000;
// Excellent remix billing reservations expire faster: model paths finish within seconds.
const EXCELLENT_BILLING_RESERVATION_TTL_MS = 10 * 60 * 1000;

function getCounter(name, fallback = 1) {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
  return Number(row?.value || fallback);
}

function setCounter(name, value) {
  db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(name, Number(value));
}

function allocateCounter(name, fallback = 1) {
  let nextValue = getCounter(name, fallback);
  if (name === "nextCreditEventId") {
    try {
      while (db.prepare("SELECT 1 FROM credit_events WHERE id = ?").get(nextValue)) {
        nextValue++;
      }
    } catch (_) {}
  } else if (name === "nextPaymentOrderId") {
    try {
      while (db.prepare("SELECT 1 FROM payment_orders WHERE id = ?").get(nextValue)) {
        nextValue++;
      }
    } catch (_) {}
  }
  setCounter(name, nextValue + 1);
  return nextValue;
}

function runTransaction(work) {
  return transaction(work)();
}

module.exports = {
  TREND_ANALYSIS_RESERVATION_TTL_MS,
  EXCELLENT_BILLING_RESERVATION_TTL_MS,
  getCounter,
  setCounter,
  allocateCounter,
  runTransaction,
};
