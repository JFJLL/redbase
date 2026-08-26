const { getDbProxy } = require("./connection");
const { transaction } = require("./connection");

const db = getDbProxy();

const VERSIONED_MIGRATIONS = [
  {
    version: 1,
    name: "sms-verification-and-rate-limits",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sms_verification_challenges (
          id INTEGER PRIMARY KEY,
          purpose TEXT NOT NULL,
          phone TEXT NOT NULL,
          code_hmac TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          sent_count INTEGER NOT NULL DEFAULT 0,
          last_sent_at_ms INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL,
          consumed_at_ms INTEGER,
          UNIQUE (purpose, phone)
        );
        CREATE INDEX IF NOT EXISTS idx_sms_challenges_expiry
          ON sms_verification_challenges(expires_at_ms);

        CREATE TABLE IF NOT EXISTS sms_send_rate_limits (
          scope TEXT NOT NULL,
          bucket_key TEXT NOT NULL,
          window_start_ms INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, bucket_key, window_start_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_sms_rate_window
          ON sms_send_rate_limits(scope, window_start_ms);

        DELETE FROM verification_codes;
      `);
    },
  },
  {
    version: 2,
    name: "alipay-payment-orders",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_orders (
          id INTEGER PRIMARY KEY,
          out_trade_no TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          plan_name TEXT NOT NULL,
          plan_credits INTEGER NOT NULL,
          amount_fen INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          provider TEXT NOT NULL DEFAULT 'alipay',
          trade_no TEXT NOT NULL DEFAULT '',
          credit_event_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paid_at TEXT NOT NULL DEFAULT '',
          expires_at TEXT NOT NULL,
          last_notified_at TEXT NOT NULL DEFAULT '',
          notify_count INTEGER NOT NULL DEFAULT 0,
          audit_reason TEXT NOT NULL DEFAULT '',
          audit_at TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_user_idem
          ON payment_orders(user_id, idempotency_key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_trade_no
          ON payment_orders(trade_no) WHERE trade_no <> '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_credit_event
          ON payment_orders(credit_event_id) WHERE credit_event_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_payment_orders_user_status
          ON payment_orders(user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_payment_orders_status_expiry
          ON payment_orders(status, expires_at);
      `);
    },
  },
  {
    version: 3,
    name: "payment-order-audit-flag",
    apply() {
      const columns = db.prepare("PRAGMA table_info(payment_orders)").all().map((row) => row.name);
      if (!columns.includes("audit_reason")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_reason TEXT NOT NULL DEFAULT ''");
      }
      if (!columns.includes("audit_at")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_at TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 4,
    name: "persistent-video-projects",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS video_projects (
          id INTEGER PRIMARY KEY,
          owner_user_id INTEGER NOT NULL,
          generation_id INTEGER NOT NULL UNIQUE,
          request_id TEXT NOT NULL,
          brand_id INTEGER NOT NULL,
          trend_id INTEGER NOT NULL,
          idea_index INTEGER NOT NULL,
          video_model TEXT NOT NULL,
          mode TEXT NOT NULL,
          resolution TEXT NOT NULL,
          aspect_ratio TEXT NOT NULL,
          total_duration_sec INTEGER NOT NULL,
          status TEXT NOT NULL,
          reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
          visual_bible_json TEXT NOT NULL DEFAULT '{}',
          script_json TEXT NOT NULL DEFAULT '{}',
          estimated_credits INTEGER NOT NULL DEFAULT 0,
          charged_credits INTEGER NOT NULL DEFAULT 0,
          refunded_credits INTEGER NOT NULL DEFAULT 0,
          credit_event_id INTEGER,
          final_video_json TEXT NOT NULL DEFAULT '{}',
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE,
          FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL,
          UNIQUE (owner_user_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS video_clips (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          clip_index INTEGER NOT NULL,
          start_sec INTEGER NOT NULL,
          end_sec INTEGER NOT NULL,
          duration_sec INTEGER NOT NULL,
          status TEXT NOT NULL,
          depends_on_clip_index INTEGER,
          prompt TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          provider_task_id TEXT NOT NULL DEFAULT '',
          continuity_mode TEXT NOT NULL DEFAULT '',
          reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
          continuity_state_json TEXT NOT NULL DEFAULT '{}',
          output_video_json TEXT NOT NULL DEFAULT '{}',
          continuity_frame_json TEXT NOT NULL DEFAULT '{}',
          credit_cost INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES video_projects(id) ON DELETE CASCADE,
          UNIQUE (project_id, clip_index)
        );
        CREATE INDEX IF NOT EXISTS idx_video_projects_owner_created ON video_projects(owner_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_video_projects_status_updated ON video_projects(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_video_clips_project_status ON video_clips(project_id, status, clip_index);
      `);
    },
  },
];

function getAppliedMigrationVersions() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  return new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
}

function applyVersionedMigrations() {
  const applied = getAppliedMigrationVersions();
  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)
  `);
  for (const migration of VERSIONED_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    transaction(() => {
      migration.apply();
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    })();
    applied.add(migration.version);
  }
}

async function migrateSchemaIfNeeded({ tableExists, isSchemaCurrent, readStoreFromDbAnySchema, normalizeStore, initializeDatabaseSchema, writeStore }) {
  if (!tableExists("users")) return;
  if (isSchemaCurrent()) return;

  const snapshot = normalizeStore(readStoreFromDbAnySchema()).store;
  db.exec(`
    DROP TABLE IF EXISTS ideas;
    DROP TABLE IF EXISTS trends;
    DROP TABLE IF EXISTS current_trend_idea_tags;
    DROP TABLE IF EXISTS current_trend_ideas;
    DROP TABLE IF EXISTS current_trend_tags;
    DROP TABLE IF EXISTS current_trends;
    DROP TABLE IF EXISTS analysis_trend_idea_tags;
    DROP TABLE IF EXISTS analysis_trend_ideas;
    DROP TABLE IF EXISTS analysis_trend_tags;
    DROP TABLE IF EXISTS analysis_trends;
    DROP TABLE IF EXISTS analyses;
    DROP TABLE IF EXISTS brand_asset_tags;
    DROP TABLE IF EXISTS brand_images;
    DROP TABLE IF EXISTS brands;
    DROP TABLE IF EXISTS product_images;
    DROP TABLE IF EXISTS image_jobs;
    DROP TABLE IF EXISTS verification_codes;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS counters;
    DROP TABLE IF EXISTS app_state;
  `);
  initializeDatabaseSchema();
  await writeStore(snapshot);
}

module.exports = {
  migrateSchemaIfNeeded,
  VERSIONED_MIGRATIONS,
  applyVersionedMigrations,
};
