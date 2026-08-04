const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { getSmsProvider } = require("../../src/server/integrations/sms");
const {
  generateVerificationCode,
  hmacVerificationCode,
  issueVerificationCode,
} = require("../../src/server/auth/verification-service");
const {
  findVerificationChallenge,
  consumeVerificationChallengeIfValid,
} = require("../../src/server/db/repositories/auth-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const NOW = Date.parse("2026-08-04T00:00:00.000Z");

function makeConfig(overrides = {}) {
  return {
    security: { trustedProxies: [] },
    sms: {
      provider: "fake",
      fakeAllowed: true,
      pepper: "test-pepper",
      codeTtlMs: 5 * 60 * 1000,
      resendCooldownMs: 60 * 1000,
      maxAttempts: 5,
      limits: {
        phonePerHour: 5,
        phonePerDay: 10,
        ipPerHour: 20,
        ipPerDay: 100,
        globalPerDay: 1000,
      },
      ...overrides,
    },
  };
}

function fakeReq(ip = "127.0.0.1") {
  return { headers: {}, socket: { remoteAddress: ip } };
}

function consume(appConfig, purpose, phone, code, nowMs = NOW) {
  return consumeVerificationChallengeIfValid({
    purpose,
    phone,
    codeHmac: hmacVerificationCode(appConfig.sms.pepper, purpose, phone, code),
    nowMs,
    maxAttempts: Number(appConfig.sms.maxAttempts || 5),
  });
}

test("generates a 6-digit numeric code", () => {
  for (let index = 0; index < 50; index += 1) {
    const code = generateVerificationCode();
    assert.match(code, /^\d{6}$/);
  }
});

test("stores only an HMAC and never the plaintext code", async () => {
  const appConfig = makeConfig();
  const result = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900001111",
    req: fakeReq(),
    nowMs: NOW,
  });
  assert.equal(result.ok, true);
  assert.match(result.demoCode, /^\d{6}$/);
  const row = findVerificationChallenge("register", "13900001111");
  assert.ok(row);
  assert.equal(row.code_hmac, hmacVerificationCode("test-pepper", "register", "13900001111", result.demoCode));
  assert.doesNotMatch(row.code_hmac, new RegExp(result.demoCode));
});

test("purpose isolation: register code cannot reset a password", async () => {
  const appConfig = makeConfig();
  const result = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900002222",
    req: fakeReq(),
    nowMs: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(consume(appConfig, "reset_password", "13900002222", result.demoCode, NOW), false);
  assert.equal(consume(appConfig, "register", "13900002222", result.demoCode, NOW), true);
});

test("expired codes are rejected and removed", async () => {
  const appConfig = makeConfig();
  const result = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900003333",
    req: fakeReq(),
    nowMs: NOW,
  });
  const expiredAt = NOW + Number(appConfig.sms.codeTtlMs) + 1000;
  assert.equal(consume(appConfig, "register", "13900003333", result.demoCode, expiredAt), false);
  assert.equal(findVerificationChallenge("register", "13900003333"), undefined);
});

test("max attempts: five wrong tries invalidate the challenge", async () => {
  const appConfig = makeConfig();
  const result = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900004444",
    req: fakeReq(),
    nowMs: NOW,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(consume(appConfig, "register", "13900004444", "000000", NOW), false);
  }
  assert.equal(consume(appConfig, "register", "13900004444", result.demoCode, NOW), false);
  assert.equal(findVerificationChallenge("register", "13900004444"), undefined);
});

test("resend within cooldown is rejected and keeps the old code valid", async () => {
  const appConfig = makeConfig();
  const first = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900005555",
    req: fakeReq(),
    nowMs: NOW,
  });
  const cooldownResult = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900005555",
    req: fakeReq(),
    nowMs: NOW + 30 * 1000,
  });
  assert.equal(cooldownResult.ok, false);
  assert.equal(cooldownResult.status, 429);
  assert.equal(consume(appConfig, "register", "13900005555", first.demoCode, NOW + 30 * 1000), true);
});

test("provider failure keeps the previous valid code", async () => {
  const appConfig = makeConfig();
  const provider = getSmsProvider(appConfig);
  const first = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900006666",
    req: fakeReq(),
    nowMs: NOW,
  });
  provider.failNext = true;
  const failed = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900006666",
    req: fakeReq(),
    nowMs: NOW + 90 * 1000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 502);
  const row = findVerificationChallenge("register", "13900006666");
  assert.equal(row.code_hmac, hmacVerificationCode("test-pepper", "register", "13900006666", first.demoCode));
  assert.equal(consume(appConfig, "register", "13900006666", first.demoCode, NOW + 90 * 1000), true);
});

test("successful resend invalidates the previous code", async () => {
  const appConfig = makeConfig();
  const first = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900007777",
    req: fakeReq(),
    nowMs: NOW,
  });
  const second = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900007777",
    req: fakeReq(),
    nowMs: NOW + 90 * 1000,
  });
  assert.equal(second.ok, true);
  assert.notEqual(second.demoCode, first.demoCode);
  assert.equal(consume(appConfig, "register", "13900007777", first.demoCode, NOW + 90 * 1000), false);
  assert.equal(consume(appConfig, "register", "13900007777", second.demoCode, NOW + 90 * 1000), true);
});

test("phone/hour rate limit blocks the next send", async () => {
  const appConfig = makeConfig({ limits: { phonePerHour: 1, phonePerDay: 10, ipPerHour: 20, ipPerDay: 100, globalPerDay: 1000 } });
  const first = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900008888",
    req: fakeReq(),
    nowMs: NOW,
  });
  assert.equal(first.ok, true);
  const second = await issueVerificationCode({
    appConfig,
    purpose: "register",
    phone: "13900008888",
    req: fakeReq(),
    nowMs: NOW + 90 * 1000,
  });
  assert.equal(second.ok, false);
  assert.equal(second.status, 429);
});

test("IP address is only trusted from configured proxies", () => {
  const { getClientIp } = require("../../src/server/auth/verification-service");
  const direct = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(getClientIp(direct, []), "127.0.0.1");
  assert.equal(getClientIp(direct, ["127.0.0.1"]), "1.2.3.4");
  assert.equal(getClientIp(direct, ["10.0.0.1"]), "127.0.0.1");
});
