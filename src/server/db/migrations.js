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
  {
    version: 5,
    name: "harden-video-project-billing-and-recovery",
    apply() {
      const projectColumns = db.prepare("PRAGMA table_info(video_projects)").all().map((row) => row.name);
      const clipColumns = db.prepare("PRAGMA table_info(video_clips)").all().map((row) => row.name);
      const addProjectColumn = (name, definition) => {
        if (!projectColumns.includes(name)) db.exec(`ALTER TABLE video_projects ADD COLUMN ${name} ${definition}`);
      };
      const addClipColumn = (name, definition) => {
        if (!clipColumns.includes(name)) db.exec(`ALTER TABLE video_clips ADD COLUMN ${name} ${definition}`);
      };

      addProjectColumn("script_generation_id", "INTEGER");
      addProjectColumn("input_assets_json", "TEXT NOT NULL DEFAULT '[]'");
      addProjectColumn("assembly_request_id", "TEXT NOT NULL DEFAULT ''");
      addProjectColumn("assembly_attempt", "INTEGER NOT NULL DEFAULT 0");
      addClipColumn("provider_key_ref", "TEXT NOT NULL DEFAULT ''");
      addClipColumn("reservation_credit_event_id", "INTEGER");
      addClipColumn("submission_attempt", "INTEGER NOT NULL DEFAULT 0");
      addClipColumn("last_successful_poll_at", "TEXT NOT NULL DEFAULT ''");
      addClipColumn("poll_failure_count", "INTEGER NOT NULL DEFAULT 0");

      db.exec(`
        CREATE TABLE IF NOT EXISTS video_project_billing_requests (
          id INTEGER PRIMARY KEY,
          request_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          generation_id INTEGER NOT NULL,
          operation TEXT NOT NULL DEFAULT 'create',
          status TEXT NOT NULL DEFAULT 'reserved',
          credit_cost INTEGER NOT NULL DEFAULT 0,
          credit_event_id INTEGER,
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES video_projects(id) ON DELETE CASCADE,
          FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE,
          FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL,
          UNIQUE (user_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_video_project_billing_project
          ON video_project_billing_requests(project_id, operation, status);
        CREATE INDEX IF NOT EXISTS idx_video_project_billing_event
          ON video_project_billing_requests(credit_event_id);
      `);
    },
  },
  {
    version: 6,
    name: "idempotent-video-script-billing",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS video_script_requests (
          id INTEGER PRIMARY KEY,
          request_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          brand_id INTEGER NOT NULL,
          trend_id INTEGER NOT NULL,
          idea_index INTEGER NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running',
          credit_cost INTEGER NOT NULL DEFAULT 1,
          credit_event_id INTEGER,
          generation_id INTEGER,
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL,
          FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE SET NULL,
          UNIQUE (user_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_video_script_requests_status_updated
          ON video_script_requests(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_video_script_requests_generation
          ON video_script_requests(generation_id);
      `);
    },
  },
  {
    version: 7,
    name: "video-result-persistence-and-semantic-idempotency",
    apply() {
      const clipColumns = db.prepare("PRAGMA table_info(video_clips)").all().map((row) => row.name);
      const scriptColumns = db.prepare("PRAGMA table_info(video_script_requests)").all().map((row) => row.name);
      const billingColumns = db.prepare("PRAGMA table_info(video_project_billing_requests)").all().map((row) => row.name);

      const addClipColumn = (name, definition) => {
        if (!clipColumns.includes(name)) db.exec(`ALTER TABLE video_clips ADD COLUMN ${name} ${definition}`);
      };
      const addScriptColumn = (name, definition) => {
        if (!scriptColumns.includes(name)) db.exec(`ALTER TABLE video_script_requests ADD COLUMN ${name} ${definition}`);
      };
      const addBillingColumn = (name, definition) => {
        if (!billingColumns.includes(name)) db.exec(`ALTER TABLE video_project_billing_requests ADD COLUMN ${name} ${definition}`);
      };

      addClipColumn("result_processing_failure_count", "INTEGER NOT NULL DEFAULT 0");
      addClipColumn("last_result_processing_error", "TEXT NOT NULL DEFAULT ''");
      addClipColumn("last_result_processing_at", "TEXT NOT NULL DEFAULT ''");

      addScriptColumn("input_signature", "TEXT NOT NULL DEFAULT ''");

      addBillingColumn("input_signature", "TEXT NOT NULL DEFAULT ''");
      addBillingColumn("clip_index", "INTEGER");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_video_script_requests_signature
          ON video_script_requests(user_id, input_signature);
      `);
    },
  },
  {
    version: 8,
    name: "asset-retention-and-lifecycle",
    apply() {
      const getColumns = (tableName) => {
        const exists = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
        if (!exists || !exists.count) return [];
        return db.prepare("PRAGMA table_info(" + tableName + ")").all().map((row) => row.name);
      };
      const addColumn = (tableName, columnName, definition) => {
        const cols = getColumns(tableName);
        if (!cols.includes(columnName)) {
          db.exec("ALTER TABLE " + tableName + " ADD COLUMN " + columnName + " " + definition);
        }
      };

      // generations
      addColumn("generations", "visibility_status", "TEXT NOT NULL DEFAULT 'active'");
      addColumn("generations", "asset_status", "TEXT NOT NULL DEFAULT 'available'");
      addColumn("generations", "asset_count", "INTEGER NOT NULL DEFAULT 0");
      addColumn("generations", "asset_bytes", "INTEGER NOT NULL DEFAULT 0");
      addColumn("generations", "assets_deleted_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("generations", "assets_delete_error", "TEXT NOT NULL DEFAULT ''");
      addColumn("generations", "updated_at", "TEXT NOT NULL DEFAULT ''");

      // image_jobs
      addColumn("image_jobs", "asset_status", "TEXT NOT NULL DEFAULT 'available'");
      addColumn("image_jobs", "asset_bytes", "INTEGER NOT NULL DEFAULT 0");
      addColumn("image_jobs", "assets_deleted_at", "TEXT NOT NULL DEFAULT ''");

      // video_projects
      addColumn("video_projects", "started_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_projects", "completed_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_projects", "failed_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_projects", "assembly_started_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_projects", "assembly_completed_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_projects", "asset_status", "TEXT NOT NULL DEFAULT 'available'");
      addColumn("video_projects", "asset_count", "INTEGER NOT NULL DEFAULT 0");
      addColumn("video_projects", "asset_bytes", "INTEGER NOT NULL DEFAULT 0");
      addColumn("video_projects", "assets_deleted_at", "TEXT NOT NULL DEFAULT ''");

      // video_clips
      addColumn("video_clips", "first_submitted_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_clips", "completed_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_clips", "failed_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("video_clips", "asset_status", "TEXT NOT NULL DEFAULT 'available'");
      addColumn("video_clips", "asset_bytes", "INTEGER NOT NULL DEFAULT 0");
      addColumn("video_clips", "assets_deleted_at", "TEXT NOT NULL DEFAULT ''");

      // brands
      addColumn("brands", "created_at", "TEXT NOT NULL DEFAULT ''");
      addColumn("brands", "updated_at", "TEXT NOT NULL DEFAULT ''");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at);
        CREATE INDEX IF NOT EXISTS idx_generations_type_created ON generations(type, created_at);
        CREATE INDEX IF NOT EXISTS idx_generations_vis_created ON generations(visibility_status, created_at);
        CREATE INDEX IF NOT EXISTS idx_generations_asset_created ON generations(asset_status, created_at);

        CREATE INDEX IF NOT EXISTS idx_credit_events_created ON credit_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_credit_events_action_created ON credit_events(action_type, created_at);

        CREATE INDEX IF NOT EXISTS idx_payment_orders_paid ON payment_orders(paid_at);
        CREATE INDEX IF NOT EXISTS idx_payment_orders_prov_status_created ON payment_orders(provider, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_image_jobs_status_created_ms ON image_jobs(status, created_at_ms);
        CREATE INDEX IF NOT EXISTS idx_image_jobs_prov_model_created_ms ON image_jobs(provider, model, created_at_ms);

        CREATE INDEX IF NOT EXISTS idx_video_projects_created ON video_projects(created_at);
        CREATE INDEX IF NOT EXISTS idx_video_projects_model_created ON video_projects(video_model, created_at);
        CREATE INDEX IF NOT EXISTS idx_video_projects_status_created ON video_projects(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_video_projects_mode_created ON video_projects(mode, created_at);

        CREATE INDEX IF NOT EXISTS idx_video_clips_status_created ON video_clips(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_video_clips_provider_created ON video_clips(provider, created_at);

        CREATE INDEX IF NOT EXISTS idx_brands_created_at ON brands(created_at);
      `);
    },
  },
  {
    version: 9,
    name: "analytics-facts-and-ai-attempts",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_key TEXT NOT NULL UNIQUE,
          event_name TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          actor_key TEXT NOT NULL DEFAULT '',
          actor_user_id INTEGER,
          account_type TEXT NOT NULL DEFAULT '',
          feature TEXT NOT NULL DEFAULT '',
          entity_type TEXT NOT NULL DEFAULT '',
          entity_id TEXT NOT NULL DEFAULT '',
          source_table TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT '',
          resolution TEXT NOT NULL DEFAULT '',
          aspect_ratio TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          media_duration_sec INTEGER NOT NULL DEFAULT 0,
          credit_delta INTEGER NOT NULL DEFAULT 0,
          credit_cost INTEGER NOT NULL DEFAULT 0,
          amount_fen INTEGER NOT NULL DEFAULT 0,
          quantity INTEGER NOT NULL DEFAULT 1,
          asset_bytes INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          release_sha TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_name_occurred ON analytics_events(event_name, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_occurred ON analytics_events(occurred_at);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_actor_occurred ON analytics_events(actor_key, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_analytics_events_feature_occurred ON analytics_events(feature, occurred_at);

        CREATE TABLE IF NOT EXISTS ai_task_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          attempt_key TEXT NOT NULL UNIQUE,
          feature TEXT NOT NULL,
          task_type TEXT NOT NULL,
          entity_type TEXT NOT NULL DEFAULT '',
          entity_id TEXT NOT NULL DEFAULT '',
          project_id INTEGER,
          clip_id INTEGER,
          actor_key TEXT NOT NULL DEFAULT '',
          actor_user_id INTEGER,
          account_type TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          provider_key_ref TEXT NOT NULL DEFAULT '',
          provider_task_id TEXT NOT NULL DEFAULT '',
          attempt_kind TEXT NOT NULL DEFAULT 'initial',
          attempt_no INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          error_stage TEXT NOT NULL DEFAULT '',
          error_code TEXT NOT NULL DEFAULT '',
          error_message TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL,
          accepted_at TEXT NOT NULL DEFAULT '',
          provider_completed_at TEXT NOT NULL DEFAULT '',
          result_processing_started_at TEXT NOT NULL DEFAULT '',
          result_processing_completed_at TEXT NOT NULL DEFAULT '',
          completed_at TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          first_byte_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          total_tokens INTEGER,
          credit_cost INTEGER NOT NULL DEFAULT 0,
          vendor_cost_fen INTEGER,
          is_backfilled INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          release_sha TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_attempts_task_started ON ai_task_attempts(task_type, started_at);
        CREATE INDEX IF NOT EXISTS idx_ai_attempts_feature_started ON ai_task_attempts(feature, started_at);
        CREATE INDEX IF NOT EXISTS idx_ai_attempts_status_started ON ai_task_attempts(status, started_at);
        CREATE INDEX IF NOT EXISTS idx_ai_attempts_prov_model_started ON ai_task_attempts(provider, model, started_at);

        CREATE TABLE IF NOT EXISTS analytics_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      const insertMeta = db.prepare("INSERT OR IGNORE INTO analytics_meta (key, value, updated_at) VALUES (?, ?, ?)");
      insertMeta.run("analytics_schema_version", "1", now);
      insertMeta.run("tracking_started_at", now, now);
      insertMeta.run("client_tracking_started_at", now, now);
      insertMeta.run("backfill_completed_at", "", now);
      insertMeta.run("backfill_source_max_at", "", now);
    },
  },
  {
    version: 10,
    name: "payment-provider-label-correction",
    apply() {
      db.exec(`
        UPDATE credit_events
        SET action_type = 'wxpay_recharge',
            action_label = '微信支付充值',
            summary = CASE
              WHEN summary LIKE '%支付宝%' THEN REPLACE(summary, '支付宝', '微信支付')
              ELSE '微信支付充值'
            END
        WHERE id IN (
          SELECT credit_event_id
          FROM payment_orders
          WHERE provider = 'wxpay'
            AND credit_event_id IS NOT NULL
        );
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
