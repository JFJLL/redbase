const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { handleAuthRoutes } = require("../../src/server/api/auth-routes");
const { getSmsProvider } = require("../../src/server/integrations/sms");
const {
  insertUser,
  insertSession,
  findUserByPhone,
  findUserBySessionToken,
  findSessionByToken,
} = require("../../src/server/db/repositories/auth-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const db = getDbProxy();

const appConfig = {
  security: { cookieSecure: false, trustedProxies: [] },
  sms: {
    provider: "fake",
    fakeAllowed: true,
    pepper: "test-pepper",
    codeTtlMs: 300000,
    resendCooldownMs: 60000,
    maxAttempts: 5,
    limits: { phonePerHour: 20, phonePerDay: 50, ipPerHour: 40, ipPerDay: 200, globalPerDay: 5000 },
  },
};

function createReq(url, payload, cookie = "") {
  const req = Readable.from([Buffer.from(JSON.stringify(payload || {}), "utf8")]);
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
    ...{ "x-forwarded-for": "" },
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
      for (const [key, value] of Object.entries(nextHeaders)) headers.set(key.toLowerCase(), value);
    },
    setHeader(key, value) { headers.set(key.toLowerCase(), value); },
    getHeader(key) { return headers.get(String(key).toLowerCase()); },
    end(data = "") { this.body = data ? JSON.parse(data) : null; },
  };
}

async function callAuth(url, payload, cookie = "") {
  const res = createRes();
  await handleAuthRoutes({ appConfig }, createReq(url, payload, cookie), res, url);
  return res;
}

async function issueCode(phone, purpose = "register") {
  const path = purpose === "reset_password"
    ? "/api/auth/reset-password/send-code"
    : "/api/auth/send-code";
  const res = await callAuth(path, { phone, ...(purpose === "reset_password" ? {} : { purpose }) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.demoCode;
}

test("send-code returns a demo code only in the fake test environment", async () => {
  const res = await callAuth("/api/auth/send-code", { phone: "13900001111", purpose: "register" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.demoCode, /^\d{6}$/);
});

test("register requires a valid six-digit code", async () => {
  const withoutCode = await callAuth("/api/auth/register", {
    phone: "13900002222",
    name: "无码",
    password: "secret66",
  });
  assert.equal(withoutCode.statusCode, 400);
  assert.match(withoutCode.body.error, /验证码/);

  const wrongCode = await callAuth("/api/auth/register", {
    phone: "13900002222",
    name: "错码",
    password: "secret66",
    code: "000000",
  });
  assert.equal(wrongCode.statusCode, 400);
  assert.match(wrongCode.body.error, /验证码/);
});

test("register consumes the code atomically and creates a session", async () => {
  const phone = "13900003333";
  const code = await issueCode(phone);
  const res = await callAuth("/api/auth/register", {
    phone,
    name: "小红",
    password: "secret66",
    code,
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.user.phone, phone);
  assert.match(String(res.getHeader("set-cookie")), /redbase_session=/);

  const reused = await callAuth("/api/auth/register", {
    phone,
    name: "重复",
    password: "secret66",
    code,
  });
  assert.equal(reused.statusCode, 400);
  assert.equal(reused.body.error, "该手机号已注册");

  const secondRegister = await callAuth("/api/auth/register", {
    phone: "13900004444",
    name: "另一人",
    password: "secret66",
    code,
  });
  assert.equal(secondRegister.statusCode, 400);
  assert.match(secondRegister.body.error, /验证码/);
});

test("reset send-code answers uniformly for existing and missing phones", async () => {
  insertUser({
    id: 9001,
    name: "重置用户",
    phone: "13900006666",
    password: "legacy-hash",
    accountType: "customer",
    credits: 5,
    createdAt: new Date().toISOString(),
  });
  const missing = await callAuth("/api/auth/reset-password/send-code", { phone: "13900005555" });
  const existing = await callAuth("/api/auth/reset-password/send-code", { phone: "13900006666" });
  assert.equal(missing.statusCode, 200);
  assert.equal(existing.statusCode, 200);
  assert.equal(missing.body.message, existing.body.message);
  assert.match(existing.body.demoCode, /^\d{6}$/);
});

test("reset password changes the password and deletes every old session", async () => {
  const phone = "13900008888";
  insertUser({
    id: 9002,
    name: "重置用户二",
    phone,
    password: "legacy-hash",
    accountType: "customer",
    credits: 5,
    createdAt: new Date().toISOString(),
  });
  const user = findUserByPhone(phone);
  insertSession({ token: "old-token-1", userId: user.id, createdAt: new Date().toISOString() });
  insertSession({ token: "old-token-2", userId: user.id, createdAt: new Date().toISOString() });
  const code = await issueCode(phone, "reset_password");

  const res = await callAuth("/api/auth/reset-password", {
    phone,
    code,
    password: "new-secret-88",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(String(res.getHeader("set-cookie")), /redbase_session=;.*Max-Age=0/);
  assert.equal(findSessionByToken("old-token-1"), null);
  assert.equal(findSessionByToken("old-token-2"), null);

  const login = await callAuth("/api/auth/login", { phone, password: "new-secret-88" });
  assert.equal(login.statusCode, 200);
});

test("reset password answers uniformly for wrong code whether the account exists", async () => {
  const missing = await callAuth("/api/auth/reset-password", {
    phone: "13900007777",
    code: "000000",
    password: "secret66",
  });
  const existing = await callAuth("/api/auth/reset-password", {
    phone: "13900006666",
    code: "000000",
    password: "secret66",
  });
  assert.equal(missing.statusCode, existing.statusCode);
  assert.equal(missing.body.error, existing.body.error);
});

test("sessions stay valid for users who did not reset", async () => {
  const user = findUserByPhone("13900006666");
  const token = "keeper-token";
  insertSession({ token, userId: user.id, createdAt: new Date().toISOString() });
  assert.equal(findUserBySessionToken(token).id, user.id);
});

test("P5: generic send-code rejects reset_password uniformly for existing and missing phones", async () => {
  insertUser({
    id: 9003,
    name: "P5 已注册用户",
    phone: "13900009991",
    password: "legacy-hash",
    accountType: "customer",
    credits: 5,
    createdAt: new Date().toISOString(),
  });

  const existing = await callAuth("/api/auth/send-code", {
    phone: "13900009991",
    purpose: "reset_password",
  });
  const missing = await callAuth("/api/auth/send-code", {
    phone: "13900009992",
    purpose: "reset_password",
  });

  assert.equal(existing.statusCode, missing.statusCode);
  assert.deepEqual(existing.body, missing.body);
  assert.equal(existing.statusCode, 400);
  assert.match(existing.body.error, /专用/);
});

test("P5: repeated generic reset_password requests cannot distinguish accounts by 200/429", async () => {
  const existing = "13900009993";
  const missing = "13900009994";
  insertUser({
    id: 9004,
    name: "P5 连续用户",
    phone: existing,
    password: "legacy-hash",
    accountType: "customer",
    credits: 5,
    createdAt: new Date().toISOString(),
  });

  const existingResponses = [];
  const missingResponses = [];
  for (let index = 0; index < 2; index += 1) {
    existingResponses.push(await callAuth("/api/auth/send-code", { phone: existing, purpose: "reset_password" }));
    missingResponses.push(await callAuth("/api/auth/send-code", { phone: missing, purpose: "reset_password" }));
  }

  const existingShape = existingResponses.map((res) => ({ status: res.statusCode, body: res.body }));
  const missingShape = missingResponses.map((res) => ({ status: res.statusCode, body: res.body }));
  assert.deepEqual(existingShape, missingShape);
  assert.equal(existingShape.every((item) => item.status === 400), true);
});

test("P5: rejected generic reset_password does not call the SMS provider or write a challenge", async () => {
  const provider = getSmsProvider(appConfig);
  provider.reset();
  const before = db.prepare(`
    SELECT COUNT(*) AS count FROM sms_verification_challenges
    WHERE purpose = 'reset_password'
  `).get().count;

  const res = await callAuth("/api/auth/send-code", {
    phone: "13900009995",
    purpose: "reset_password",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(provider.sentByPhone.has("13900009995"), false);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM sms_verification_challenges
      WHERE purpose = 'reset_password'
    `).get().count,
    before,
  );
});

test("P5: register send-code and dedicated reset-password send-code remain usable", async () => {
  const registerRes = await callAuth("/api/auth/send-code", {
    phone: "13900009996",
    purpose: "register",
  });
  assert.equal(registerRes.statusCode, 200);
  assert.match(registerRes.body.demoCode, /^\d{6}$/);

  const resetRes = await callAuth("/api/auth/reset-password/send-code", {
    phone: "13900009997",
  });
  assert.equal(resetRes.statusCode, 200);
  assert.match(resetRes.body.demoCode, /^\d{6}$/);
});
