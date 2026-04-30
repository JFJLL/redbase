const { getDbProxy, transaction } = require("../connection");

const db = getDbProxy();

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
  const nextValue = getCounter(name, fallback);
  setCounter(name, nextValue + 1);
  return nextValue;
}

function runTransaction(work) {
  return transaction(work)();
}

module.exports = {
  getCounter,
  setCounter,
  allocateCounter,
  runTransaction,
};
