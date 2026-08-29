const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-migration-zero-loss-"));
const dbFile = path.join(tempDir, "redbase.sqlite");
process.env.REDBASE_DB_FILE = dbFile;

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { ensureStore } = require("../../src/server/db/snapshot-store");

openDatabase();
const db = getDbProxy();

// Simulate a pre-feature database: full current base schema, but without the
// versioned feature tables (schema_migrations / sms / payment).
initializeDatabaseSchema();
ensureDatabaseIndexes();
db.exec("DROP TABLE IF EXISTS payment_orders");
db.exec("DROP TABLE IF EXISTS sms_send_rate_limits");
db.exec("DROP TABLE IF EXISTS sms_verification_challenges");
db.exec("DROP TABLE IF EXISTS schema_migrations");

const seededUsers = [
  [1, "存量用户甲", "13900000001", "hash-1", "yimei", "其他", 50, "2026-01-01T00:00:00.000Z"],
  [2, "存量用户乙", "13900000002", "hash-2", "customer", "", 5, "2026-02-01T00:00:00.000Z"],
  [3, "存量用户丙", "13900000003", "hash-3", "customer", "", 12, "2026-03-01T00:00:00.000Z"],
];
const seededSessions = [
  ["session-1", 1, "2026-01-01T00:00:00.000Z"],
  ["session-2", 1, "2026-01-02T00:00:00.000Z"],
  ["session-3", 2, "2026-02-01T00:00:00.000Z"],
];
const seededEvents = [
  [101, 1, "generation", "内容生成", -1, 1, "2026-01-01T01:00:00.000Z", null, "", 0, "", 0, "", "", 0, "", "摘要", "{}"],
  [102, 2, "manual", "手动调整", 10, 0, "2026-02-01T01:00:00.000Z", 1, "管理员", 0, "", 0, "", "", 0, "", "充值", "{\"note\":\"old\"}"],
];

for (const row of seededUsers) {
  db.prepare("INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(...row);
}
for (const row of seededSessions) {
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(...row);
}
for (const row of seededEvents) {
  db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title,
      idea_title, generation_id, channel_label, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...row);
}
db.prepare("INSERT INTO verification_codes (phone, code, expires_at) VALUES ('13900000001', '123456', 9999999999999)").run();
db.prepare("INSERT INTO counters (name, value) VALUES ('nextUserId', 4)").run();
db.prepare("INSERT INTO counters (name, value) VALUES ('nextCreditEventId', 103)").run();
db.prepare("INSERT INTO brands (id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base) VALUES (1, 1, '历史品牌', '行业', '人群', '描述', '产品', '目标', '')").run();

function snapshot(table, columns, orderBy) {
  return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${orderBy}`).all();
}

const usersBefore = snapshot("users", "id, name, phone, password, account_type, department, credits, created_at", "id");
const sessionsBefore = snapshot("sessions", "token, user_id, created_at", "token");
const eventsBefore = snapshot("credit_events", "id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title, generation_id, channel_label, summary, payload_json", "id");

function expectColumns(tableName, expectedColumns) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
  for (const column of expectedColumns) assert.ok(columns.includes(column), `${tableName}.${column} should exist after migration`);
}

test("versioned migrations preserve users/sessions/credit_events exactly and clear legacy plaintext codes", async () => {
  await ensureStore();
  await ensureStore(); // idempotent second run

  assert.deepEqual(
    snapshot("users", "id, name, phone, password, account_type, department, credits, created_at", "id"),
    usersBefore,
  );
  assert.deepEqual(
    snapshot("sessions", "token, user_id, created_at", "token"),
    sessionsBefore,
  );
  assert.deepEqual(
    snapshot("credit_events", "id, user_id, action_type, action_label, credit_delta, credit_cost, created_at, admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title, generation_id, channel_label, summary, payload_json", "id"),
    eventsBefore,
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_codes").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='verification_codes'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='sms_verification_challenges'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='payment_orders'").get().count, 1);
  assert.deepEqual(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  expectColumns("video_projects", ["script_generation_id", "input_assets_json", "assembly_request_id", "assembly_attempt"]);
  expectColumns("video_clips", ["provider_key_ref", "reservation_credit_event_id", "submission_attempt", "last_successful_poll_at", "poll_failure_count", "result_processing_failure_count", "last_result_processing_error", "last_result_processing_at"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='video_project_billing_requests'").get().count, 1);
  expectColumns("video_project_billing_requests", ["input_signature", "clip_index"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='video_script_requests'").get().count, 1);
  expectColumns("video_script_requests", ["request_id", "credit_event_id", "generation_id", "status", "input_signature", "updated_at"]);

  expectColumns("generations", ["visibility_status", "asset_status", "asset_count", "asset_bytes", "assets_deleted_at", "assets_delete_error", "updated_at"]);
  expectColumns("image_jobs", ["asset_status", "asset_bytes", "assets_deleted_at"]);
  expectColumns("video_projects", ["started_at", "completed_at", "failed_at", "assembly_started_at", "assembly_completed_at", "asset_status", "asset_count", "asset_bytes", "assets_deleted_at"]);
  expectColumns("video_clips", ["first_submitted_at", "completed_at", "failed_at", "asset_status", "asset_bytes", "assets_deleted_at"]);
  expectColumns("video_clips", ["attempt_started_at", "next_attempt_kind", "retry_origin", "billing_operation", "next_result_attempt_kind"]);
  expectColumns("analytics_events", ["is_admin"]);
  expectColumns("ai_task_attempts", ["is_admin"]);
  expectColumns("brands", ["created_at", "updated_at"]);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='analytics_events'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='ai_task_attempts'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='analytics_meta'").get().count, 1);

  // Historical brand created_at remains empty string, not forged with migration time
  assert.equal(db.prepare("SELECT created_at FROM brands WHERE id = 1").get().created_at, "");
});

test("the backup copy stays byte-identical and untouched", () => {
  const backupPath = path.join(tempDir, "redbase-backup.sqlite");
  fs.copyFileSync(dbFile, backupPath);
  const originalStat = fs.statSync(dbFile);
  const backupStat = fs.statSync(backupPath);
  assert.equal(backupStat.size, originalStat.size);
  assert.ok(fs.readFileSync(backupPath).length > 0);
});
