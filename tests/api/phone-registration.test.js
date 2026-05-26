const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { handleAuthRoutes } = require("../../src/server/api/auth-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

function createJsonReq(url, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]);
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    "content-type": "application/json",
  };
  return req;
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: null,
    writeHead(code, nextHeaders = {}) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(nextHeaders)) {
        headers.set(key.toLowerCase(), value);
      }
    },
    setHeader(key, value) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

test("phone registration always creates an external customer account", async () => {
  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: { security: { cookieSecure: false } },
    },
    createJsonReq("/api/auth/register", {
      phone: "13912345678",
      name: "外部客户",
      password: "secret123",
      accountType: "yimei",
      department: "客户一部",
    }),
    res,
    "/api/auth/register",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.user.accountType, "customer");
  assert.equal(res.body.user.department, "");
  assert.equal(res.body.user.credits, 5);
});
