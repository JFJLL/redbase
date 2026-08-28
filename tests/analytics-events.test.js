const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const {
  recordUserActiveDay,
  recordUserRegistered,
  recordBrandCreated,
  recordOutputCompleted,
  recordUserDeleted,
} = require("../src/server/analytics/analytics-recorder");
const { toShanghaiDateString, parseQueryRange } = require("../src/server/analytics/analytics-query-range");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

test("user_active_day records uniquely per user per Asia/Shanghai natural day", () => {
  const userId = 801;
  // 2026-08-28 01:00 UTC = 2026-08-28 09:00 Shanghai
  const firstTime = "2026-08-28T01:00:00.000Z";
  // 2026-08-28 10:00 UTC = 2026-08-28 18:00 Shanghai (same day)
  const secondTime = "2026-08-28T10:00:00.000Z";
  // 2026-08-28 17:00 UTC = 2026-08-29 01:00 Shanghai (next day in UTC+8)
  const nextDayTime = "2026-08-28T17:00:00.000Z";

  const res1 = recordUserActiveDay({ userId, occurredAt: firstTime });
  assert.equal(res1, true);

  const res2 = recordUserActiveDay({ userId, occurredAt: secondTime });
  assert.equal(res2, false, "Same user same Shanghai day must be ignored as duplicate");

  const res3 = recordUserActiveDay({ userId, occurredAt: nextDayTime });
  assert.equal(res3, true, "Next Shanghai day must create a new active day record");

  const count = db.prepare("SELECT COUNT(*) AS cnt FROM analytics_events WHERE event_name = 'user_active_day' AND actor_key = ?").get(`user:${userId}`).cnt;
  assert.equal(count, 2);
});

test("Asia/Shanghai date calculation accurately crosses UTC boundaries", () => {
  // 2026-08-28 15:59:59 UTC -> 2026-08-28 in Shanghai
  assert.equal(toShanghaiDateString(Date.parse("2026-08-28T15:59:59.000Z")), "2026-08-28");
  // 2026-08-28 16:00:00 UTC -> 2026-08-29 in Shanghai
  assert.equal(toShanghaiDateString(Date.parse("2026-08-28T16:00:00.000Z")), "2026-08-29");
});

test("user deletion clears actor_user_id to NULL while retaining actor_key and aggregates", () => {
  const userId = 802;
  insertUser({
    id: userId,
    name: "即将删除用户",
    phone: "13800000802",
    password: "hash",
    accountType: "customer",
    credits: 10,
    createdAt: "2026-08-01T00:00:00.000Z",
  });

  recordUserRegistered({ userId, createdAt: "2026-08-01T00:00:00.000Z" });
  recordOutputCompleted({ generationId: 8021, userId, type: "style_image", creditCost: 1 });

  const beforeEvents = db.prepare("SELECT actor_user_id, actor_key FROM analytics_events WHERE actor_key = ?").all(`user:${userId}`);
  assert.equal(beforeEvents.length, 2);
  assert.equal(beforeEvents[0].actor_user_id, userId);

  recordUserDeleted({ userId, deletedAt: "2026-08-28T10:00:00.000Z" });

  const afterEvents = db.prepare("SELECT actor_user_id, actor_key FROM analytics_events WHERE actor_key = ?").all(`user:${userId}`);
  assert.equal(afterEvents.length, 3); // 2 previous + 1 user_deleted
  for (const e of afterEvents) {
    assert.equal(e.actor_user_id, null, "actor_user_id must be cleared on deletion");
    assert.equal(e.actor_key, `user:${userId}`, "actor_key must be retained");
  }
});

test("analytics facts do not store PII, plaintext phones, or secret keys", () => {
  const sampleEvents = db.prepare("SELECT metadata_json, actor_key FROM analytics_events LIMIT 50").all();
  for (const ev of sampleEvents) {
    const text = JSON.stringify(ev);
    assert.equal(/1[3-9]d{9}/.test(text), false, "Analytics facts must not contain 11-digit phone numbers");
    assert.equal(text.includes("password"), false, "Analytics facts must not contain passwords");
    assert.equal(text.includes("secret"), false, "Analytics facts must not contain secrets");
  }
});
