const { getDbProxy } = require("./connection");
const { transaction } = require("./connection");
const { loadAppConfig } = require("../config");
const { isAdminUser } = require("../api/domain-utils");
const {
  reconstructSubscriptionSnapshot,
  inspectSubscriptionSnapshot,
} = require("../billing/snapshot-recovery");

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
  {
    version: 11,
    name: "analytics-admin-snapshots-and-backfill-status",
    apply() {
      const addColumnIfMissing = (tableName, columnName, definition) => {
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        if (!columns.some((column) => column.name === columnName)) {
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
        }
      };
      addColumnIfMissing("analytics_events", "is_admin", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing("ai_task_attempts", "is_admin", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing("video_clips", "attempt_started_at", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing("video_clips", "next_attempt_kind", "TEXT NOT NULL DEFAULT 'initial'");
      addColumnIfMissing("video_clips", "retry_origin", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing("video_clips", "billing_operation", "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_analytics_events_admin_occurred
          ON analytics_events(is_admin, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_ai_attempts_admin_started
          ON ai_task_attempts(is_admin, started_at);
      `);

      const appConfig = loadAppConfig();
      const adminIds = db.prepare("SELECT id, phone FROM users").all()
        .filter((user) => isAdminUser(user, appConfig))
        .map((user) => Number(user.id));
      if (adminIds.length) {
        const placeholders = adminIds.map(() => "?").join(",");
        db.prepare(`UPDATE analytics_events SET is_admin = 1 WHERE actor_user_id IN (${placeholders})`).run(...adminIds);
        db.prepare(`UPDATE ai_task_attempts SET is_admin = 1 WHERE actor_user_id IN (${placeholders})`).run(...adminIds);
      }

      const now = new Date().toISOString();
      const insertMeta = db.prepare("INSERT OR IGNORE INTO analytics_meta (key, value, updated_at) VALUES (?, ?, ?)");
      insertMeta.run("backfill_status", "pending", now);
      insertMeta.run("backfill_error", "", now);
    },
  },
  {
    version: 12,
    name: "video-result-attempt-kind",
    apply() {
      const columns = db.prepare("PRAGMA table_info(video_clips)").all();
      if (!columns.some((column) => column.name === "next_result_attempt_kind")) {
        db.exec("ALTER TABLE video_clips ADD COLUMN next_result_attempt_kind TEXT NOT NULL DEFAULT 'initial'");
      }
    },
  },
  {
    version: 13,
    name: "billing-v2-subscription-ledger",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          plan_id TEXT NOT NULL,
          cycle TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          service_start TEXT NOT NULL,
          service_end TEXT NOT NULL,
          anchor_day INTEGER NOT NULL,
          current_period_start TEXT NOT NULL,
          current_period_end TEXT NOT NULL,
          current_period_grant INTEGER NOT NULL,
          upgrade_cumulative_increment INTEGER NOT NULL DEFAULT 0,
          pricing_basis_fen INTEGER NOT NULL,
          actual_paid_total_fen INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
          ON subscriptions(user_id, status);

        CREATE TABLE IF NOT EXISTS subscription_schedules (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          order_id INTEGER NOT NULL,
          plan_id TEXT NOT NULL,
          cycle TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          amount_fen INTEGER NOT NULL,
          monthly_credits INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_schedules_unique_pending
          ON subscription_schedules(user_id) WHERE status = 'scheduled';

        CREATE TABLE IF NOT EXISTS subscription_grants (
          id INTEGER PRIMARY KEY,
          subscription_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          period_index INTEGER NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          credits INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          granted_at TEXT,
          credit_lot_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_grants_unique
          ON subscription_grants(subscription_id, period_index);

        CREATE TABLE IF NOT EXISTS credit_lots (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          source_type TEXT NOT NULL,
          source_label TEXT NOT NULL,
          order_id INTEGER,
          subscription_id INTEGER,
          grant_id INTEGER,
          initial_credits INTEGER NOT NULL,
          remaining_credits INTEGER NOT NULL,
          reserved_credits INTEGER NOT NULL DEFAULT 0,
          used_credits INTEGER NOT NULL DEFAULT 0,
          starts_at TEXT NOT NULL,
          expires_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_credit_lots_user_status_exp
          ON credit_lots(user_id, status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_credit_lots_user_active
          ON credit_lots(user_id, status);

        CREATE TABLE IF NOT EXISTS credit_lot_allocations (
          id INTEGER PRIMARY KEY,
          credit_event_id INTEGER NOT NULL,
          lot_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          credits_used INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_lot_alloc_event
          ON credit_lot_allocations(credit_event_id);
        CREATE INDEX IF NOT EXISTS idx_lot_alloc_lot
          ON credit_lot_allocations(lot_id);

        CREATE TABLE IF NOT EXISTS billing_quotes (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          cycle TEXT,
          catalog_version TEXT NOT NULL,
          amount_fen INTEGER NOT NULL,
          issued_now INTEGER NOT NULL,
          start_at TEXT NOT NULL,
          end_at TEXT,
          period_end_at TEXT,
          scheduled INTEGER NOT NULL DEFAULT 0,
          meta_json TEXT NOT NULL DEFAULT '{}',
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_billing_quotes_user
          ON billing_quotes(user_id, created_at);
      `);

      const orderCols = db.prepare("PRAGMA table_info(payment_orders)").all().map((c) => c.name);
      if (!orderCols.includes("quote_id")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN quote_id TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("fulfilled_at")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN fulfilled_at TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("fulfillment_status")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled'");
        db.exec("UPDATE payment_orders SET fulfillment_status = 'fulfilled', fulfilled_at = paid_at WHERE status = 'paid'");
      }
      if (!orderCols.includes("cycle")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN cycle TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("order_kind")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'plan'");
      }
      if (!orderCols.includes("order_action")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN order_action TEXT NOT NULL DEFAULT 'activate'");
      }
      if (!orderCols.includes("issued_now")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN issued_now INTEGER NOT NULL DEFAULT 0");
      }
      if (!orderCols.includes("service_start")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN service_start TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("service_end")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN service_end TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("period_end")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN period_end TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 14,
    name: "billing-v2-remediation",
    apply() {
      const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
      if (!userCols.includes("legacy_credits_migrated")) {
        db.exec("ALTER TABLE users ADD COLUMN legacy_credits_migrated INTEGER NOT NULL DEFAULT 0");
        db.exec("UPDATE users SET legacy_credits_migrated = 1 WHERE id IN (SELECT DISTINCT user_id FROM credit_lots)");
      }

      const scheduleCols = db.prepare("PRAGMA table_info(subscription_schedules)").all().map((c) => c.name);
      if (!scheduleCols.includes("anchor_day")) {
        db.exec("ALTER TABLE subscription_schedules ADD COLUMN anchor_day INTEGER NOT NULL DEFAULT 0");
      }
      if (!scheduleCols.includes("snapshot_json")) {
        db.exec("ALTER TABLE subscription_schedules ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
      }

      const subCols = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
      if (!subCols.includes("upgrade_cumulative_exact")) {
        db.exec("ALTER TABLE subscriptions ADD COLUMN upgrade_cumulative_exact REAL NOT NULL DEFAULT 0");
      }
      if (!subCols.includes("snapshot_json")) {
        db.exec("ALTER TABLE subscriptions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
      }

      const orderCols = db.prepare("PRAGMA table_info(payment_orders)").all().map((c) => c.name);
      if (!orderCols.includes("snapshot_json")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!orderCols.includes("audit_reason")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_reason TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("audit_at")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_at TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("anchor_day")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN anchor_day INTEGER NOT NULL DEFAULT 0");
      }

      const quoteCols = db.prepare("PRAGMA table_info(billing_quotes)").all().map((c) => c.name);
      if (!quoteCols.includes("subscription_id")) {
        db.exec("ALTER TABLE billing_quotes ADD COLUMN subscription_id INTEGER");
      }
      if (!quoteCols.includes("original_plan_id")) {
        db.exec("ALTER TABLE billing_quotes ADD COLUMN original_plan_id TEXT NOT NULL DEFAULT ''");
      }
      if (!quoteCols.includes("original_service_end")) {
        db.exec("ALTER TABLE billing_quotes ADD COLUMN original_service_end TEXT NOT NULL DEFAULT ''");
      }
      if (!quoteCols.includes("subscription_version")) {
        db.exec("ALTER TABLE billing_quotes ADD COLUMN subscription_version TEXT NOT NULL DEFAULT ''");
      }

      const activeDupes = db.prepare(`
        SELECT user_id, COUNT(*) AS count
        FROM subscriptions
        WHERE status = 'active'
        GROUP BY user_id
        HAVING count > 1
      `).all();
      if (activeDupes.length > 0) {
        db.prepare(`
          UPDATE subscriptions
          SET status = 'superseded', updated_at = datetime('now')
          WHERE status = 'active' AND service_end <= datetime('now')
        `).run();
      }
      try {
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unique_active ON subscriptions(user_id) WHERE status = 'active';");
      } catch (idxErr) {
        console.warn("[migration 14 audit] 用户存在未到期的重复生效订阅，需人工核对处置，暂缓创建唯一索引", idxErr?.message);
      }
    },
  },
  {
    version: 15,
    name: "billing-v2-closeout",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_credit_reservations (
          task_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          task_type TEXT NOT NULL,
          lot_id INTEGER NOT NULL,
          reserved_credits INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'reserved',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (task_id, lot_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_res_user_status ON task_credit_reservations(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_task_res_task ON task_credit_reservations(task_id);
      `);

      const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
      if (!userCols.includes("legacy_credits_migrated")) {
        db.exec("ALTER TABLE users ADD COLUMN legacy_credits_migrated INTEGER NOT NULL DEFAULT 0");
      }
      db.exec("UPDATE users SET legacy_credits_migrated = 1 WHERE id IN (SELECT DISTINCT user_id FROM credit_lots)");

      const orderCols = db.prepare("PRAGMA table_info(payment_orders)").all().map((c) => c.name);
      if (!orderCols.includes("snapshot_json")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!orderCols.includes("anchor_day")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN anchor_day INTEGER NOT NULL DEFAULT 0");
      }
      if (!orderCols.includes("audit_reason")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_reason TEXT NOT NULL DEFAULT ''");
      }
      if (!orderCols.includes("audit_at")) {
        db.exec("ALTER TABLE payment_orders ADD COLUMN audit_at TEXT NOT NULL DEFAULT ''");
      }

      try {
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unique_active ON subscriptions(user_id) WHERE status = 'active';");
      } catch (_) {}
    },
  },
  {
    version: 16,
    name: "billing-v2-remediation",
    apply() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS account_plan_order_locks (
          user_id INTEGER PRIMARY KEY,
          out_trade_no TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (out_trade_no) REFERENCES payment_orders(out_trade_no) ON DELETE CASCADE
        );
      `);

      const resCols = db.prepare("PRAGMA table_info(task_credit_reservations)").all().map((c) => c.name);
      if (resCols.length > 0 && !resCols.includes("task_key")) {
        db.exec("ALTER TABLE task_credit_reservations ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE task_credit_reservations SET task_key = task_type || ':' || user_id || ':' || task_id WHERE task_key = ''");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_res_key_status ON task_credit_reservations(task_key, status);
      `);

      try {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_lots_grant
          ON credit_lots(grant_id) WHERE grant_id IS NOT NULL;
        `);
      } catch (_) {}

      try {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_lots_order_source
          ON credit_lots(order_id, source_type)
          WHERE order_id IS NOT NULL AND grant_id IS NULL AND source_type = 'topup';
        `);
      } catch (_) {}
    },
  },
  {
    version: 17,
    name: "billing-v2-remaining-closeout",
    apply() {
      // Reconstruct task_credit_reservations table to fix the physical primary key.
      // In SQLite, altering a table's primary key requires recreating the table.
      // The physical primary key becomes 'id INTEGER PRIMARY KEY AUTOINCREMENT',
      // and the business uniqueness constraint is UNIQUE (task_key, lot_id).
      const hasOldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_credit_reservations'").get();
      if (hasOldTable) {
        db.exec(`
          CREATE TABLE task_credit_reservations_v17 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_key TEXT NOT NULL,
            task_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            task_type TEXT NOT NULL,
            lot_id INTEGER NOT NULL,
            reserved_credits INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'reserved',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
          );
        `);

        const oldCols = db.prepare("PRAGMA table_info(task_credit_reservations)").all().map((c) => c.name);
        const hasTaskKeyCol = oldCols.includes("task_key");
        const oldRows = db.prepare("SELECT * FROM task_credit_reservations").all();
        const insertStmt = db.prepare(`
          INSERT INTO task_credit_reservations_v17 (
            task_key, task_id, user_id, task_type, lot_id, reserved_credits, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const row of oldRows) {
          let canonicalKey = hasTaskKeyCol && row.task_key ? String(row.task_key).trim() : "";
          if (!canonicalKey) {
            if (row.task_type === "trend_analysis") {
              try {
                const req = db.prepare(`
                  SELECT brand_id, bucket_key FROM trend_analysis_requests
                  WHERE user_id = ? AND request_id = ?
                `).all(row.user_id, row.task_id);
                if (req && req.length === 1) {
                  canonicalKey = `trend_analysis:${row.user_id}:${req[0].brand_id}:${req[0].bucket_key}:${row.task_id}`;
                } else {
                  canonicalKey = `trend_analysis:${row.user_id}:::${row.task_id}`;
                }
              } catch (_) {
                canonicalKey = `trend_analysis:${row.user_id}:::${row.task_id}`;
              }
            } else if (String(row.task_type).startsWith("excellent_")) {
              const kind = String(row.task_type).replace(/^excellent_/, "");
              const cleanTid = String(row.task_id).startsWith(`${kind}_`) ? String(row.task_id).slice(kind.length + 1) : String(row.task_id);
              canonicalKey = `excellent_${kind}:${row.user_id}:${cleanTid}`;
            } else {
              canonicalKey = `${row.task_type}:${row.user_id}:${row.task_id}`;
            }
          }

          insertStmt.run(
            canonicalKey,
            String(row.task_id),
            Number(row.user_id),
            String(row.task_type),
            Number(row.lot_id),
            Number(row.reserved_credits),
            String(row.status || "reserved"),
            String(row.created_at || new Date().toISOString()),
            String(row.updated_at || new Date().toISOString())
          );
        }

        db.exec(`
          DROP TABLE task_credit_reservations;
          ALTER TABLE task_credit_reservations_v17 RENAME TO task_credit_reservations;
          CREATE UNIQUE INDEX IF NOT EXISTS uq_task_res_key_lot ON task_credit_reservations(task_key, lot_id);
          CREATE INDEX IF NOT EXISTS idx_task_res_key_status ON task_credit_reservations(task_key, status);
          CREATE INDEX IF NOT EXISTS idx_task_res_user_status ON task_credit_reservations(user_id, status);
          CREATE INDEX IF NOT EXISTS idx_task_res_task ON task_credit_reservations(task_id);
        `);
      } else {
        db.exec(`
          CREATE TABLE IF NOT EXISTS task_credit_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_key TEXT NOT NULL,
            task_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            task_type TEXT NOT NULL,
            lot_id INTEGER NOT NULL,
            reserved_credits INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'reserved',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
          );
          CREATE UNIQUE INDEX IF NOT EXISTS uq_task_res_key_lot ON task_credit_reservations(task_key, lot_id);
          CREATE INDEX IF NOT EXISTS idx_task_res_key_status ON task_credit_reservations(task_key, status);
          CREATE INDEX IF NOT EXISTS idx_task_res_user_status ON task_credit_reservations(user_id, status);
          CREATE INDEX IF NOT EXISTS idx_task_res_task ON task_credit_reservations(task_id);
        `);
      }
    },
  },
  {
    version: 18,
    name: "billing-v2-reservation-identity-alignment",
    apply() {
      // 1. Ensure task_key column exists in trend_analysis_requests
      const trendCols = db.prepare("PRAGMA table_info(trend_analysis_requests)").all().map((c) => c.name);
      if (!trendCols.includes("task_key")) {
        db.exec("ALTER TABLE trend_analysis_requests ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
      }
      db.exec(`
        UPDATE trend_analysis_requests
        SET task_key = 'trend_analysis:' || user_id || ':' || brand_id || ':' || bucket_key || ':' || request_id
        WHERE task_key = ''
      `);

      // 2. Ensure task_key column exists in excellent_remix_billing_requests
      const hasExcTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='excellent_remix_billing_requests'").get();
      if (hasExcTable) {
        const excCols = db.prepare("PRAGMA table_info(excellent_remix_billing_requests)").all().map((c) => c.name);
        if (!excCols.includes("task_key")) {
          db.exec("ALTER TABLE excellent_remix_billing_requests ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
        }
        db.exec(`
          UPDATE excellent_remix_billing_requests
          SET task_key = 'excellent_' || kind || ':' || user_id || ':' || request_id || ':' || created_at
          WHERE task_key = ''
        `);
      }

      // 3. Align non-canonical keys in task_credit_reservations
      const resRows = db.prepare("SELECT * FROM task_credit_reservations").all();
      for (const row of resRows) {
        if (row.task_type === "trend_analysis") {
          const parts = String(row.task_key || "").split(":");
          const isOldFormat = parts.length < 5 || parts[2] === "" || parts[3] === "";
          if (isOldFormat) {
            const reqs = db.prepare(`
              SELECT brand_id, bucket_key, request_id, task_key FROM trend_analysis_requests
              WHERE user_id = ? AND request_id = ?
            `).all(row.user_id, row.task_id);
            if (reqs && reqs.length === 1) {
              const canonicalKey = `trend_analysis:${row.user_id}:${reqs[0].brand_id}:${reqs[0].bucket_key}:${row.task_id}`;
              db.prepare("UPDATE task_credit_reservations SET task_key = ? WHERE id = ?").run(canonicalKey, row.id);
              db.prepare("UPDATE trend_analysis_requests SET task_key = ? WHERE user_id = ? AND request_id = ?").run(canonicalKey, row.user_id, row.task_id);
            } else if (reqs && reqs.length > 1) {
              db.prepare("UPDATE task_credit_reservations SET status = 'audit_required' WHERE id = ?").run(row.id);
            }
          }
        } else if (String(row.task_type).startsWith("excellent_")) {
          const kind = String(row.task_type).replace(/^excellent_/, "");
          const cleanTid = String(row.task_id).startsWith(`${kind}_`) ? String(row.task_id).slice(kind.length + 1) : String(row.task_id);
          const parts = String(row.task_key || "").split(":");
          const isAlreadyCanonical = parts.length >= 4 && parts[0] === `excellent_${kind}` && parts[1] === String(row.user_id) && parts[2] === cleanTid && parts[3] !== "";
          if (isAlreadyCanonical) {
            continue;
          }

          let canonicalKey = "";
          let req = null;
          try {
            req = db.prepare(`
              SELECT request_id, created_at, task_key, status FROM excellent_remix_billing_requests
              WHERE user_id = ? AND request_id = ? AND kind = ?
            `).get(row.user_id, cleanTid, kind);
          } catch (_) {}

          if (row.status === "reserved" && req && req.status === "reserved" && req.created_at) {
            canonicalKey = `excellent_${kind}:${row.user_id}:${cleanTid}:${req.created_at}`;
          } else {
            canonicalKey = `excellent_${kind}:${row.user_id}:${cleanTid}:${row.created_at}`;
          }

          const exists = db.prepare("SELECT 1 FROM task_credit_reservations WHERE task_key = ? AND lot_id = ? AND id != ?").get(canonicalKey, row.lot_id, row.id);
          if (!exists) {
            db.prepare("UPDATE task_credit_reservations SET task_key = ? WHERE id = ?").run(canonicalKey, row.id);
            if (req && req.status === "reserved" && (!req.task_key || req.task_key === "")) {
              db.prepare("UPDATE excellent_remix_billing_requests SET task_key = ? WHERE user_id = ? AND request_id = ? AND kind = ?").run(canonicalKey, row.user_id, cleanTid, kind);
            }
          } else {
            db.prepare("UPDATE task_credit_reservations SET status = 'audit_required' WHERE id = ?").run(row.id);
          }
        }
      }

      // 4. Backfill empty snapshot_json in subscriptions
      const subs = db.prepare("SELECT * FROM subscriptions WHERE snapshot_json = '' OR snapshot_json = '{}'").all();
      for (const sub of subs) {
        const snapshot = reconstructSubscriptionSnapshot(sub, db);
        if (snapshot) {
          db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(snapshot), sub.id);
        }
      }
    },
  },
  {
    version: 19,
    name: "billing-v2-attempt-identity-and-snapshot-repair",
    apply() {
      // 1. Repair historical released/settled reservations where an earlier migration may have overwritten task_key
      const badExcRows = db.prepare(`
        SELECT r.id, r.user_id, r.task_id, r.task_type, r.task_key, r.created_at, r.lot_id, r.status
        FROM task_credit_reservations r
        WHERE r.status IN ('released', 'settled')
          AND r.task_type LIKE 'excellent_%'
      `).all();

      for (const row of badExcRows) {
        const kind = String(row.task_type).replace(/^excellent_/, "");
        const cleanTid = String(row.task_id).startsWith(`${kind}_`) ? String(row.task_id).slice(kind.length + 1) : String(row.task_id);
        const parts = String(row.task_key || "").split(":");
        if (parts.length >= 4) {
          const keyTimestamp = parts.slice(3).join(":");
          let activeReq = null;
          try {
            activeReq = db.prepare(`
              SELECT created_at FROM excellent_remix_billing_requests
              WHERE user_id = ? AND request_id = ? AND kind = ? AND status = 'reserved'
            `).get(row.user_id, cleanTid, kind);
          } catch (_) {}
          if (activeReq && activeReq.created_at === keyTimestamp && activeReq.created_at !== row.created_at) {
            const restoredKey = `excellent_${kind}:${row.user_id}:${cleanTid}:${row.created_at}`;
            const exists = db.prepare("SELECT 1 FROM task_credit_reservations WHERE task_key = ? AND lot_id = ? AND id != ?").get(restoredKey, row.lot_id, row.id);
            if (!exists) {
              db.prepare("UPDATE task_credit_reservations SET task_key = ? WHERE id = ?").run(restoredKey, row.id);
            } else {
              db.prepare("UPDATE task_credit_reservations SET status = 'audit_required' WHERE id = ?").run(row.id);
            }
          }
        }
      }

      // 2. Audit and repair all subscriptions where bad snapshot was backfilled
      const allSubs = db.prepare("SELECT * FROM subscriptions").all();
      for (const sub of allSubs) {
        let currentSnap = null;
        try { currentSnap = JSON.parse(sub.snapshot_json || "{}"); } catch (_) {}
        const expected = reconstructSubscriptionSnapshot(sub, db);
        if (expected) {
          const isMissing = !currentSnap || !currentSnap.monthlyCredits;
          const isWrongCredits = currentSnap && currentSnap.monthlyCredits !== expected.monthlyCredits;
          const isWrongPlan = currentSnap && currentSnap.planId && currentSnap.planId !== sub.plan_id;
          if (isMissing || isWrongCredits || isWrongPlan) {
            db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(expected), sub.id);
          }
        }
      }
    },
  },
  {
    version: 20,
    name: "billing-v2-snapshot-provenance-repair",
    apply() {
      const allSubs = db.prepare("SELECT * FROM subscriptions").all();
      for (const sub of allSubs) {
        const inspection = inspectSubscriptionSnapshot(sub, db);
        let currentSnap = null;
        try { currentSnap = JSON.parse(sub.snapshot_json || "{}"); } catch (_) {}

        if (inspection.status === "resolved" && inspection.snapshot) {
          const expected = inspection.snapshot;
          const isMissing = !currentSnap || !currentSnap.monthlyCredits;
          const isWrongCredits = currentSnap && currentSnap.monthlyCredits !== expected.monthlyCredits;
          const isWrongPlan = currentSnap && currentSnap.planId && currentSnap.planId !== sub.plan_id;
          if (isMissing || isWrongCredits || isWrongPlan) {
            db.prepare("UPDATE subscriptions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(expected), sub.id);
          }
        } else if (inspection.status === "unresolved" || inspection.status === "conflict") {
          if (currentSnap && (currentSnap.planId !== sub.plan_id || inspection.status === "unresolved")) {
            if (inspection.status === "unresolved") {
              db.prepare("UPDATE subscriptions SET snapshot_json = '' WHERE id = ?").run(sub.id);
            }
          }
        }
      }
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
