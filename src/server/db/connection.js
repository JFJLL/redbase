const Database = require("better-sqlite3");
const { DB_FILE } = require("../config");

let db = null;
let dbProxy = null;

function openDatabase() {
  if (!db) {
    db = new Database(DB_FILE);
    db.pragma("foreign_keys = ON");
  }
  return db;
}

function getDatabase() {
  if (!db) {
    throw new Error("Database has not been initialized. Call ensureStore() before accessing the store.");
  }
  return db;
}

function getDbProxy() {
  if (!dbProxy) {
    dbProxy = new Proxy(
      {},
      {
        get(_target, property) {
          const database = getDatabase();
          const value = database[property];
          return typeof value === "function" ? value.bind(database) : value;
        },
      },
    );
  }
  return dbProxy;
}

module.exports = {
  openDatabase,
  getDatabase,
  getDbProxy,
};
