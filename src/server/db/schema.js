const { getDbProxy } = require("./connection");

const db = getDbProxy();

function tableExists(name) {
  return db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).count > 0;
}

function hasColumn(tableName, columnName) {
  if (!tableExists(tableName)) return false;
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function initializeDatabaseSchema() {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'customer',
      department TEXT NOT NULL DEFAULT '',
      credits INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      industry TEXT NOT NULL,
      audience TEXT NOT NULL,
      description TEXT NOT NULL,
      product TEXT NOT NULL,
      goal TEXT NOT NULL,
      knowledge_base TEXT NOT NULL,
      logo_json TEXT NOT NULL DEFAULT '{}',
      asset_tags_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY,
      brand_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      brand_brief_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trends (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trend_id INTEGER NOT NULL,
      stable_key TEXT NOT NULL DEFAULT '',
      brand_id INTEGER NOT NULL,
      analysis_id INTEGER,
      scope TEXT NOT NULL,
      bucket_key TEXT NOT NULL DEFAULT 'global',
      bucket_title TEXT NOT NULL DEFAULT '全网热点指数',
      bucket_description TEXT NOT NULL DEFAULT '从跨平台高讨论度内容里筛选可被品牌借势的热点方向。',
      rank INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      summary TEXT NOT NULL,
      score INTEGER NOT NULL,
      reason TEXT NOT NULL,
      custom_prompt TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_snapshot_json TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ideas (
      trend_row_id INTEGER NOT NULL,
      idea_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      angle TEXT NOT NULL,
      brand_fit TEXT NOT NULL,
      audience TEXT NOT NULL,
      hook TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      content_assets_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (trend_row_id, idea_index),
      FOREIGN KEY (trend_row_id) REFERENCES trends(row_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      channel_label TEXT NOT NULL,
      brand_id INTEGER NOT NULL,
      brand_name TEXT NOT NULL,
      trend_id INTEGER NOT NULL,
      trend_title TEXT NOT NULL,
      idea_title TEXT NOT NULL,
      card_title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      preview_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS image_jobs (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_mode TEXT NOT NULL DEFAULT '',
      provider_result_url TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      generation_context_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      generation_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      credit_delta INTEGER NOT NULL,
      credit_cost INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      admin_user_name TEXT NOT NULL DEFAULT '',
      brand_id INTEGER,
      brand_name TEXT NOT NULL DEFAULT '',
      trend_id INTEGER,
      trend_title TEXT NOT NULL DEFAULT '',
      idea_title TEXT NOT NULL DEFAULT '',
      generation_id INTEGER,
      channel_label TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trend_analysis_requests (
      request_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      bucket_key TEXT NOT NULL,
      status TEXT NOT NULL,
      credit_cost INTEGER NOT NULL,
      analysis_id INTEGER,
      credit_event_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id, brand_id, bucket_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE SET NULL,
      FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL
    );
  `);
}

function ensureDatabaseIndexes() {
  if (tableExists("trend_analysis_requests")) {
    db.prepare(`
      UPDATE trend_analysis_requests
      SET status = 'failed', error = 'superseded duplicate reservation', updated_at = ?
      WHERE status = 'reserved'
        AND rowid NOT IN (
          SELECT MIN(rowid)
          FROM trend_analysis_requests
          WHERE status = 'reserved'
          GROUP BY user_id, brand_id, bucket_key
        )
    `).run(new Date().toISOString());
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_brands_owner_user_id ON brands(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_analyses_brand_id ON analyses(brand_id);
    CREATE INDEX IF NOT EXISTS idx_trends_brand_scope ON trends(brand_id, scope);
    CREATE INDEX IF NOT EXISTS idx_trends_analysis_id ON trends(analysis_id);
    CREATE INDEX IF NOT EXISTS idx_generations_owner_user_id ON generations(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_generations_brand_id ON generations(brand_id);
    CREATE INDEX IF NOT EXISTS idx_credit_events_user_id ON credit_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_events_generation_id ON credit_events(generation_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_owner_user_id ON product_images(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_owner_sha ON product_images(owner_user_id, sha256, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_owner_user_id ON image_jobs(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_image_jobs_owner_created ON image_jobs(owner_user_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_trend_analysis_requests_user_status ON trend_analysis_requests(user_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trend_analysis_requests_active_bucket
      ON trend_analysis_requests(user_id, brand_id, bucket_key)
      WHERE status = 'reserved';
  `);
}

function clearStoredTrendSystemPrompts() {
  if (!tableExists("trends") || !hasColumn("trends", "system_prompt")) return;
  db.prepare("UPDATE trends SET system_prompt = '' WHERE system_prompt <> ''").run();
}

function ensureSchemaUpgrades() {
  if (tableExists("users")) {
    if (!hasColumn("users", "account_type")) {
      db.exec("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'yimei'");
    }
    if (!hasColumn("users", "department")) {
      db.exec("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '其他'");
    }
    if (!hasColumn("users", "credits")) {
      db.exec("ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 50");
    }
  }

  if (tableExists("trends")) {
    if (!hasColumn("trends", "stable_key")) {
      db.exec("ALTER TABLE trends ADD COLUMN stable_key TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn("trends", "bucket_key")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_key TEXT NOT NULL DEFAULT 'global'");
    }
    if (!hasColumn("trends", "bucket_title")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_title TEXT NOT NULL DEFAULT '全网热点指数'");
    }
    if (!hasColumn("trends", "bucket_description")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_description TEXT NOT NULL DEFAULT '从跨平台高讨论度内容里筛选可被品牌借势的热点方向。'");
    }
    if (!hasColumn("trends", "evidence_ids_json")) {
      db.exec("ALTER TABLE trends ADD COLUMN evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn("trends", "evidence_snapshot_json")) {
      db.exec("ALTER TABLE trends ADD COLUMN evidence_snapshot_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  if (tableExists("analyses") && !hasColumn("analyses", "brand_brief_json")) {
    db.exec("ALTER TABLE analyses ADD COLUMN brand_brief_json TEXT NOT NULL DEFAULT '{}'");
  }

  if (tableExists("ideas") && !hasColumn("ideas", "content_assets_json")) {
    db.exec("ALTER TABLE ideas ADD COLUMN content_assets_json TEXT NOT NULL DEFAULT '{}'");
  }

  if (tableExists("brands") && !hasColumn("brands", "logo_json")) {
    db.exec("ALTER TABLE brands ADD COLUMN logo_json TEXT NOT NULL DEFAULT '{}'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      channel_label TEXT NOT NULL,
      brand_id INTEGER NOT NULL,
      brand_name TEXT NOT NULL,
      trend_id INTEGER NOT NULL,
      trend_title TEXT NOT NULL,
      idea_title TEXT NOT NULL,
      card_title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      preview_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      credit_delta INTEGER NOT NULL,
      credit_cost INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      admin_user_name TEXT NOT NULL DEFAULT '',
      brand_id INTEGER,
      brand_name TEXT NOT NULL DEFAULT '',
      trend_id INTEGER,
      trend_title TEXT NOT NULL DEFAULT '',
      idea_title TEXT NOT NULL DEFAULT '',
      generation_id INTEGER,
      channel_label TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS image_jobs (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_mode TEXT NOT NULL DEFAULT '',
      provider_result_url TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      generation_context_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      generation_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trend_analysis_requests (
      request_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      bucket_key TEXT NOT NULL,
      status TEXT NOT NULL,
      credit_cost INTEGER NOT NULL,
      analysis_id INTEGER,
      credit_event_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id, brand_id, bucket_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE SET NULL,
      FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL
    );
  `);
}

function isSchemaCurrent() {
  return (
    hasCurrentStoreSchema() &&
    hasColumn("brands", "logo_json") &&
    !hasColumn("brands", "brand_images_json")
  );
}

function hasCurrentStoreSchema() {
  return (
    tableExists("counters") &&
    tableExists("users") &&
    tableExists("sessions") &&
    tableExists("verification_codes") &&
    tableExists("brands") &&
    tableExists("analyses") &&
    hasColumn("analyses", "brand_brief_json") &&
    tableExists("trends") &&
    tableExists("ideas") &&
    hasColumn("brands", "asset_tags_json") &&
    hasColumn("trends", "row_id") &&
    hasColumn("trends", "stable_key") &&
    hasColumn("trends", "scope") &&
    hasColumn("trends", "bucket_key") &&
    hasColumn("trends", "bucket_title") &&
    hasColumn("trends", "bucket_description") &&
    hasColumn("trends", "tags_json") &&
    hasColumn("trends", "evidence_ids_json") &&
    hasColumn("trends", "evidence_snapshot_json") &&
    hasColumn("ideas", "trend_row_id") &&
    hasColumn("ideas", "tags_json") &&
    hasColumn("ideas", "content_assets_json") &&
    tableExists("generations") &&
    tableExists("product_images") &&
    tableExists("image_jobs") &&
    tableExists("credit_events") &&
    tableExists("trend_analysis_requests")
  );
}

module.exports = {
  tableExists,
  hasColumn,
  initializeDatabaseSchema,
  ensureDatabaseIndexes,
  clearStoredTrendSystemPrompts,
  ensureSchemaUpgrades,
  isSchemaCurrent,
  hasCurrentStoreSchema,
};
