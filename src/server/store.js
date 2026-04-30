const fsp = require("fs/promises");
const Database = require("better-sqlite3");
const { DATA_DIR, DB_FILE } = require("./config");

let db = null;

function createEmptyStore() {
  return {
    nextUserId: 2,
    nextBrandId: 1,
    nextAnalysisId: 9001,
    nextTrendId: 100,
    nextGenerationId: 1,
    nextCreditEventId: 1,
    nextProductImageId: 1,
    users: [
      {
        id: 1,
        name: "Test User",
        phone: "13800000000",
        password: "123456",
        accountType: "yimei",
        department: "其他",
        credits: 50,
        createdAt: "2026-04-25T00:00:00.000Z",
      },
    ],
    sessions: [],
    verificationCodes: {},
    brands: [],
    generations: [],
    creditEvents: [],
    productImages: [],
    imageJobs: [],
  };
}

function normalizeStore(input) {
  const defaults = createEmptyStore();
  const next = { ...defaults, ...(input || {}) };
  let changed = false;

  if (!Array.isArray(next.users) || next.users.length === 0) {
    next.users = defaults.users;
    changed = true;
  }

  next.users = next.users.map((user) => {
    const accountType = user.accountType === "yimei" ? "yimei" : "customer";
    const normalized = {
      id: Number(user.id),
      name: String(user.name || "").trim(),
      phone: String(user.phone || "").trim(),
      password: String(user.password || ""),
      accountType,
      department: accountType === "yimei" ? String(user.department || "其他") : "",
      credits: Number.isFinite(Number(user.credits)) ? Number(user.credits) : accountType === "yimei" ? 50 : 5,
      createdAt: String(user.createdAt || new Date().toISOString()),
    };

    if (
      normalized.accountType !== user.accountType ||
      normalized.department !== user.department ||
      normalized.credits !== user.credits
    ) {
      changed = true;
    }
    return normalized;
  });

  if (!Array.isArray(next.sessions)) {
    next.sessions = [];
    changed = true;
  }

  if (!next.verificationCodes || typeof next.verificationCodes !== "object") {
    next.verificationCodes = {};
    changed = true;
  }

  if (!Array.isArray(next.brands)) {
    next.brands = [];
    changed = true;
  }

  if (!Array.isArray(next.generations)) {
    next.generations = [];
    changed = true;
  }

  if (!Array.isArray(next.creditEvents)) {
    next.creditEvents = [];
    changed = true;
  }

  if (!Array.isArray(next.productImages)) {
    next.productImages = [];
    changed = true;
  }

  if (!Array.isArray(next.imageJobs)) {
    next.imageJobs = [];
    changed = true;
  }

  next.brands = next.brands.map((brand) => {
    const normalized = {
      id: Number(brand.id),
      ownerUserId: brand.ownerUserId == null ? 1 : Number(brand.ownerUserId),
      name: String(brand.name || "").trim(),
      industry: String(brand.industry || "").trim(),
      audience: String(brand.audience || "").trim(),
      description: String(brand.description || "").trim(),
      product: String(brand.product || "").trim(),
      goal: String(brand.goal || "").trim(),
      knowledgeBase: String(brand.knowledgeBase || ""),
      logo: normalizeBrandLogo(brand.logo),
      assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
      analyses: Array.isArray(brand.analyses) ? brand.analyses : [],
      trends: normalizeTrendBuckets(brand.trends),
    };

    if (normalized.ownerUserId !== brand.ownerUserId) changed = true;
    if (!Array.isArray(brand.assetTags) || !Array.isArray(brand.analyses) || !Array.isArray(brand.trends)) {
      changed = true;
    }

    normalized.analyses = normalized.analyses.map((analysis) => ({
      id: Number(analysis.id),
      name: String(analysis.name || "").trim(),
      timestamp: String(analysis.timestamp || ""),
      trendSnapshot: normalizeTrendBuckets(analysis.trendSnapshot),
    }));

    return normalized;
  });

  next.generations = next.generations.map((item) => ({
    id: Number(item.id),
    ownerUserId: Number(item.ownerUserId),
    type: String(item.type || ""),
    channelLabel: String(item.channelLabel || ""),
    brandId: Number(item.brandId),
    brandName: String(item.brandName || ""),
    trendId: Number(item.trendId),
    trendTitle: String(item.trendTitle || ""),
    ideaTitle: String(item.ideaTitle || ""),
    cardTitle: String(item.cardTitle || ""),
    createdAt: String(item.createdAt || ""),
    previewUrl: String(item.previewUrl || ""),
    summary: String(item.summary || ""),
    payload: item.payload && typeof item.payload === "object" ? item.payload : {},
  }));

  if (next.creditEvents.length === 0 && next.generations.length > 0 && !Number.isFinite(Number(input?.nextCreditEventId))) {
    next.creditEvents = inferCreditEventsFromGenerations(next.generations);
    changed = true;
  } else {
    next.creditEvents = next.creditEvents.map((event) => ({
      id: Number(event.id),
      userId: Number(event.userId),
      actionType: String(event.actionType || ""),
      actionLabel: String(event.actionLabel || ""),
      creditDelta: Number.isFinite(Number(event.creditDelta)) ? Number(event.creditDelta) : 0,
      creditCost: Number.isFinite(Number(event.creditCost)) ? Number(event.creditCost) : 0,
      createdAt: String(event.createdAt || ""),
      adminUserId: event.adminUserId == null ? null : Number(event.adminUserId),
      adminUserName: String(event.adminUserName || ""),
      brandId: event.brandId == null ? null : Number(event.brandId),
      brandName: String(event.brandName || ""),
      trendId: event.trendId == null ? null : Number(event.trendId),
      trendTitle: String(event.trendTitle || ""),
      ideaTitle: String(event.ideaTitle || ""),
      generationId: event.generationId == null ? null : Number(event.generationId),
      channelLabel: String(event.channelLabel || ""),
      summary: String(event.summary || ""),
      payload: event.payload && typeof event.payload === "object" ? event.payload : {},
    }));
  }

  next.productImages = next.productImages.map((item) => ({
    id: Number(item.id),
    ownerUserId: Number(item.ownerUserId),
    originalName: String(item.originalName || "product-image"),
    storedPath: String(item.storedPath || ""),
    mimeType: String(item.mimeType || ""),
    sizeBytes: Number.isFinite(Number(item.sizeBytes)) ? Number(item.sizeBytes) : 0,
    sha256: String(item.sha256 || ""),
    createdAt: String(item.createdAt || ""),
    lastUsedAt: item.lastUsedAt ? String(item.lastUsedAt) : "",
    deletedAt: item.deletedAt ? String(item.deletedAt) : "",
  }));

  next.imageJobs = next.imageJobs.map((item) => ({
    id: String(item.id || ""),
    ownerUserId: Number(item.ownerUserId),
    status: String(item.status || "pending"),
    provider: String(item.provider || "wavespeed"),
    providerMode: String(item.providerMode || ""),
    providerResultUrl: String(item.providerResultUrl || ""),
    model: String(item.model || ""),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
    generationContext: item.generationContext && typeof item.generationContext === "object" ? item.generationContext : null,
    imageUrl: String(item.imageUrl || ""),
    error: String(item.error || ""),
    generationId: item.generationId == null ? null : Number(item.generationId),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
    updatedAt: String(item.updatedAt || ""),
    completedAt: String(item.completedAt || ""),
  }));

  next.nextUserId = normalizeCounter(next.nextUserId, next.users.map((item) => item.id), defaults.nextUserId);
  next.nextBrandId = normalizeCounter(next.nextBrandId, next.brands.map((item) => item.id), defaults.nextBrandId);
  next.nextAnalysisId = normalizeCounter(
    next.nextAnalysisId,
    next.brands.flatMap((brand) => (brand.analyses || []).map((analysis) => analysis.id)),
    defaults.nextAnalysisId,
  );
  next.nextTrendId = normalizeCounter(
    next.nextTrendId,
    next.brands.flatMap((brand) => [
      ...flattenTrendBuckets(brand.trends).map((trend) => trend.id),
      ...(brand.analyses || []).flatMap((analysis) => flattenTrendBuckets(analysis.trendSnapshot).map((trend) => trend.id)),
    ]),
    defaults.nextTrendId,
  );
  next.nextGenerationId = normalizeCounter(
    next.nextGenerationId,
    next.generations.map((item) => item.id),
    defaults.nextGenerationId,
  );
  next.nextCreditEventId = normalizeCounter(
    next.nextCreditEventId,
    next.creditEvents.map((item) => item.id),
    defaults.nextCreditEventId,
  );
  next.nextProductImageId = normalizeCounter(
    next.nextProductImageId,
    next.productImages.map((item) => item.id),
    defaults.nextProductImageId,
  );

  return { store: next, changed };
}

function normalizeBrandLogo(input) {
  if (!input || typeof input !== "object") return null;
  const storedPath = String(input.storedPath || "");
  if (!storedPath) return null;
  return {
    originalName: String(input.originalName || "brand-logo"),
    storedPath,
    mimeType: String(input.mimeType || ""),
    sizeBytes: Number.isFinite(Number(input.sizeBytes)) ? Number(input.sizeBytes) : 0,
    sha256: String(input.sha256 || ""),
    createdAt: String(input.createdAt || ""),
    updatedAt: String(input.updatedAt || input.createdAt || ""),
  };
}

function inferCreditEventsFromGenerations(generations) {
  let nextId = 1;
  return generations.map((item) => {
    const creditCost = inferGenerationCreditCost(item.type);
    return {
      id: nextId++,
      userId: Number(item.ownerUserId),
      actionType: "generation",
      actionLabel: item.channelLabel || "内容生成",
      creditDelta: -creditCost,
      creditCost,
      createdAt: String(item.createdAt || ""),
      adminUserId: null,
      adminUserName: "",
      brandId: Number(item.brandId),
      brandName: String(item.brandName || ""),
      trendId: Number(item.trendId),
      trendTitle: String(item.trendTitle || ""),
      ideaTitle: String(item.ideaTitle || ""),
      generationId: Number(item.id),
      channelLabel: String(item.channelLabel || ""),
      summary: String(item.summary || item.cardTitle || ""),
      payload: { inferred: true, source: "generation-history" },
    };
  });
}

function inferGenerationCreditCost(type) {
  return type === "xhsCarousel" ? 4 : 1;
}

function isTrendBucket(value) {
  return value && typeof value === "object" && Array.isArray(value.items);
}

function normalizeTrendBuckets(trends) {
  const source = Array.isArray(trends) ? trends : [];
  if (!source.length) return [];

  if (!source.some(isTrendBucket)) {
    return [
      {
        key: "global",
        title: "全网热点指数",
        description: "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
        items: source,
      },
    ];
  }

  return source.map((bucket, index) => ({
    key: String(bucket.key || (index === 0 ? "global" : `bucket-${index + 1}`)),
    title: String(bucket.title || (index === 0 ? "全网热点指数" : "热点趋势")),
    description: String(bucket.description || "适合当前品牌借势的热点方向。"),
    items: Array.isArray(bucket.items) ? bucket.items : [],
  }));
}

function flattenTrendBuckets(trends) {
  return normalizeTrendBuckets(trends).flatMap((bucket) =>
    bucket.items.map((trend) => ({
      ...trend,
      bucketKey: bucket.key,
      bucketTitle: bucket.title,
      bucketDescription: bucket.description,
    })),
  );
}

function groupTrendRows(rows, target) {
  for (const trend of rows) {
    const key = trend.bucketKey || "global";
    let bucket = target.find((item) => item.key === key);
    if (!bucket) {
      bucket = {
        key,
        title: trend.bucketTitle || "全网热点指数",
        description: trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
        items: [],
      };
      target.push(bucket);
    }
    bucket.items.push({
      id: trend.id,
      rank: trend.rank,
      title: trend.title,
      category: trend.category,
      summary: trend.summary,
      score: trend.score,
      tags: trend.tags,
      reason: trend.reason,
      customPrompt: trend.customPrompt,
      systemPrompt: trend.systemPrompt,
      ideas: trend.ideas,
    });
  }
}

function normalizeCounter(candidate, ids, fallback) {
  const maxId = ids.map((id) => Number(id)).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), fallback - 1);
  const minimumNext = Math.max(maxId + 1, fallback);
  if (Number.isFinite(Number(candidate))) {
    return Math.max(Number(candidate), minimumNext);
  }
  return minimumNext;
}

function tableExists(name) {
  return db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).count > 0;
}

function hasColumn(tableName, columnName) {
  if (!tableExists(tableName)) return false;
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function safeParseArray(text) {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function safeParseObject(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
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
      position INTEGER NOT NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trends (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trend_id INTEGER NOT NULL,
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
  `);
}

function ensureDatabaseIndexes() {
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
  `);
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
    if (!hasColumn("trends", "bucket_key")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_key TEXT NOT NULL DEFAULT 'global'");
    }
    if (!hasColumn("trends", "bucket_title")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_title TEXT NOT NULL DEFAULT '全网热点指数'");
    }
    if (!hasColumn("trends", "bucket_description")) {
      db.exec("ALTER TABLE trends ADD COLUMN bucket_description TEXT NOT NULL DEFAULT '从跨平台高讨论度内容里筛选可被品牌借势的热点方向。'");
    }
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
    tableExists("trends") &&
    tableExists("ideas") &&
    hasColumn("brands", "asset_tags_json") &&
    hasColumn("trends", "row_id") &&
    hasColumn("trends", "scope") &&
    hasColumn("trends", "bucket_key") &&
    hasColumn("trends", "bucket_title") &&
    hasColumn("trends", "bucket_description") &&
    hasColumn("trends", "tags_json") &&
    hasColumn("ideas", "trend_row_id") &&
    hasColumn("ideas", "tags_json") &&
    tableExists("generations") &&
    tableExists("product_images") &&
    tableExists("image_jobs") &&
    tableExists("credit_events")
  );
}

async function migrateSchemaIfNeeded() {
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

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("foreign_keys = ON");
  initializeDatabaseSchema();
  ensureSchemaUpgrades();
  await migrateSchemaIfNeeded();
  ensureDatabaseIndexes();

  const hasUsers = tableExists("users") && db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0;
  if (!hasUsers) {
    await writeStore(createEmptyStore());
    return;
  }

  const { store, changed } = normalizeStore(readStoreFromDbAnySchema());
  if (changed) {
    await writeStore(store);
  }
}

async function readStore() {
  const { store, changed } = normalizeStore(readStoreFromDbAnySchema());
  if (changed) {
    await writeStore(store);
  }
  return store;
}

function mapBy(items, keySelector) {
  const map = new Map();
  for (const item of items || []) {
    map.set(keySelector(item), item);
  }
  return map;
}

function sameStoreRecord(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function deleteMissingRows(currentItems, keySelector, nextKeys, deleteRow) {
  const nextKeySet = new Set((nextKeys || []).map((key) => String(key)));
  for (const item of currentItems || []) {
    const key = keySelector(item);
    if (!nextKeySet.has(String(key))) {
      deleteRow(key);
    }
  }
}

async function writeStore(data) {
  const store = normalizeStore(data).store;
  const current = hasCurrentStoreSchema() ? readStoreFromDbAnySchema() : createEmptyStore();

  const upsertCounter = db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `);
  const upsertUser = db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      password = excluded.password,
      account_type = excluded.account_type,
      department = excluded.department,
      credits = excluded.credits,
      created_at = excluded.created_at
  `);
  const deleteUser = db.prepare("DELETE FROM users WHERE id = ?");
  const upsertSession = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      created_at = excluded.created_at
  `);
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
  const upsertVerification = db.prepare(`
    INSERT INTO verification_codes (phone, code, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at
  `);
  const deleteVerification = db.prepare("DELETE FROM verification_codes WHERE phone = ?");
  const upsertBrand = db.prepare(`
    INSERT INTO brands (
      id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, logo_json, asset_tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      name = excluded.name,
      industry = excluded.industry,
      audience = excluded.audience,
      description = excluded.description,
      product = excluded.product,
      goal = excluded.goal,
      knowledge_base = excluded.knowledge_base,
      logo_json = excluded.logo_json,
      asset_tags_json = excluded.asset_tags_json
  `);
  const deleteBrand = db.prepare("DELETE FROM brands WHERE id = ?");
  const deleteBrandIdeas = db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id = ?)");
  const deleteBrandTrends = db.prepare("DELETE FROM trends WHERE brand_id = ?");
  const deleteBrandAnalyses = db.prepare("DELETE FROM analyses WHERE brand_id = ?");
  const insertAnalysis = db.prepare("INSERT INTO analyses (id, brand_id, name, timestamp, position) VALUES (?, ?, ?, ?, ?)");
  const insertTrend = db.prepare(`
    INSERT INTO trends (
      trend_id, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIdea = db.prepare(`
    INSERT INTO ideas (
      trend_row_id, idea_index, title, summary, angle, brand_fit, audience, hook, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertGeneration = db.prepare(`
    INSERT INTO generations (
      id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      type = excluded.type,
      channel_label = excluded.channel_label,
      brand_id = excluded.brand_id,
      brand_name = excluded.brand_name,
      trend_id = excluded.trend_id,
      trend_title = excluded.trend_title,
      idea_title = excluded.idea_title,
      card_title = excluded.card_title,
      created_at = excluded.created_at,
      preview_url = excluded.preview_url,
      summary = excluded.summary,
      payload_json = excluded.payload_json
  `);
  const deleteGeneration = db.prepare("DELETE FROM generations WHERE id = ?");
  const upsertProductImage = db.prepare(`
    INSERT INTO product_images (
      id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      original_name = excluded.original_name,
      stored_path = excluded.stored_path,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      sha256 = excluded.sha256,
      created_at = excluded.created_at,
      last_used_at = excluded.last_used_at,
      deleted_at = excluded.deleted_at
  `);
  const deleteProductImage = db.prepare("DELETE FROM product_images WHERE id = ?");
  const upsertImageJob = db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      status = excluded.status,
      provider = excluded.provider,
      provider_mode = excluded.provider_mode,
      provider_result_url = excluded.provider_result_url,
      model = excluded.model,
      metadata_json = excluded.metadata_json,
      generation_context_json = excluded.generation_context_json,
      image_url = excluded.image_url,
      error = excluded.error,
      generation_id = excluded.generation_id,
      created_at_ms = excluded.created_at_ms,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at
  `);
  const deleteImageJob = db.prepare("DELETE FROM image_jobs WHERE id = ?");
  const upsertCreditEvent = db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      action_type = excluded.action_type,
      action_label = excluded.action_label,
      credit_delta = excluded.credit_delta,
      credit_cost = excluded.credit_cost,
      created_at = excluded.created_at,
      admin_user_id = excluded.admin_user_id,
      admin_user_name = excluded.admin_user_name,
      brand_id = excluded.brand_id,
      brand_name = excluded.brand_name,
      trend_id = excluded.trend_id,
      trend_title = excluded.trend_title,
      idea_title = excluded.idea_title,
      generation_id = excluded.generation_id,
      channel_label = excluded.channel_label,
      summary = excluded.summary,
      payload_json = excluded.payload_json
  `);
  const deleteCreditEvent = db.prepare("DELETE FROM credit_events WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    upsertCounter.run("nextUserId", store.nextUserId);
    upsertCounter.run("nextBrandId", store.nextBrandId);
    upsertCounter.run("nextAnalysisId", store.nextAnalysisId);
    upsertCounter.run("nextTrendId", store.nextTrendId);
    upsertCounter.run("nextGenerationId", store.nextGenerationId);
    upsertCounter.run("nextCreditEventId", store.nextCreditEventId);
    upsertCounter.run("nextProductImageId", store.nextProductImageId);

    const currentUsersById = mapBy(current.users, (item) => item.id);
    const currentSessionsByToken = mapBy(current.sessions, (item) => item.token);
    const currentVerificationsByPhone = new Map(
      Object.entries(current.verificationCodes || {}).map(([phone, record]) => [String(phone), { phone, ...record }]),
    );
    const currentBrandsById = mapBy(current.brands, (item) => item.id);
    const currentGenerationsById = mapBy(current.generations, (item) => item.id);
    const currentProductImagesById = mapBy(current.productImages, (item) => item.id);
    const currentImageJobsById = mapBy(current.imageJobs, (item) => item.id);
    const currentCreditEventsById = mapBy(current.creditEvents, (item) => item.id);

    for (const user of store.users) {
      if (!sameStoreRecord(currentUsersById.get(user.id), user)) {
        upsertUser.run(
          user.id,
          user.name,
          user.phone,
          user.password,
          user.accountType || "customer",
          user.department || "",
          Number(user.credits || 0),
          user.createdAt,
        );
      }
    }
    deleteMissingRows(current.users, (item) => item.id, store.users.map((item) => item.id), (id) => deleteUser.run(id));

    for (const session of store.sessions) {
      if (!sameStoreRecord(currentSessionsByToken.get(session.token), session)) {
        upsertSession.run(session.token, session.userId, session.createdAt);
      }
    }
    deleteMissingRows(
      current.sessions,
      (item) => item.token,
      store.sessions.map((item) => item.token),
      (token) => deleteSession.run(token),
    );

    for (const [phone, record] of Object.entries(store.verificationCodes || {})) {
      const nextRecord = { phone, code: record.code, expiresAt: record.expiresAt };
      if (!sameStoreRecord(currentVerificationsByPhone.get(String(phone)), nextRecord)) {
        upsertVerification.run(phone, record.code, record.expiresAt);
      }
    }
    deleteMissingRows(
      Array.from(currentVerificationsByPhone.values()),
      (item) => item.phone,
      Object.keys(store.verificationCodes || {}),
      (phone) => deleteVerification.run(phone),
    );

    const deleteBrandContent = (brandId) => {
      deleteBrandIdeas.run(brandId);
      deleteBrandTrends.run(brandId);
      deleteBrandAnalyses.run(brandId);
    };

    const insertBrandContent = (brand) => {
      for (const [analysisPosition, analysis] of (brand.analyses || []).entries()) {
        insertAnalysis.run(analysis.id, brand.id, analysis.name, analysis.timestamp, analysisPosition);

        for (const [trendPosition, trend] of flattenTrendBuckets(analysis.trendSnapshot).entries()) {
          const trendResult = insertTrend.run(
            trend.id,
            brand.id,
            analysis.id,
            "snapshot",
            trend.bucketKey || "global",
            trend.bucketTitle || "全网热点指数",
            trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
            trend.rank,
            trend.title,
            trend.category,
            trend.summary,
            trend.score,
            trend.reason,
            trend.customPrompt || "",
            trend.systemPrompt || "",
              JSON.stringify(Array.isArray(trend.tags) ? trend.tags : []),
              trendPosition,
          );

          for (const [ideaIndex, idea] of (trend.ideas || []).entries()) {
            insertIdea.run(
              trendResult.lastInsertRowid,
              ideaIndex,
              idea.title,
              idea.summary,
              idea.angle,
              idea.brandFit,
              idea.audience,
              idea.hook,
              JSON.stringify(Array.isArray(idea.tags) ? idea.tags : []),
            );
          }
        }
      }

      for (const [trendPosition, trend] of flattenTrendBuckets(brand.trends).entries()) {
        const trendResult = insertTrend.run(
          trend.id,
          brand.id,
          null,
          "current",
          trend.bucketKey || "global",
          trend.bucketTitle || "全网热点指数",
          trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
          trend.rank,
          trend.title,
          trend.category,
          trend.summary,
          trend.score,
          trend.reason,
          trend.customPrompt || "",
          trend.systemPrompt || "",
          JSON.stringify(Array.isArray(trend.tags) ? trend.tags : []),
          trendPosition,
        );

        for (const [ideaIndex, idea] of (trend.ideas || []).entries()) {
          insertIdea.run(
            trendResult.lastInsertRowid,
            ideaIndex,
            idea.title,
            idea.summary,
            idea.angle,
            idea.brandFit,
            idea.audience,
            idea.hook,
            JSON.stringify(Array.isArray(idea.tags) ? idea.tags : []),
          );
        }
      }
    };

    deleteMissingRows(current.brands, (item) => item.id, store.brands.map((item) => item.id), (id) => {
      deleteBrandContent(id);
      deleteBrand.run(id);
    });

    for (const brand of store.brands) {
      if (sameStoreRecord(currentBrandsById.get(brand.id), brand)) continue;
      upsertBrand.run(
        brand.id,
        brand.ownerUserId,
        brand.name,
        brand.industry,
        brand.audience,
        brand.description,
        brand.product,
        brand.goal,
        brand.knowledgeBase || "",
        JSON.stringify(brand.logo || {}),
        JSON.stringify(Array.isArray(brand.assetTags) ? brand.assetTags : []),
      );
      deleteBrandContent(brand.id);
      insertBrandContent(brand);
    }

    for (const item of store.generations || []) {
      if (!sameStoreRecord(currentGenerationsById.get(item.id), item)) {
        upsertGeneration.run(
          item.id,
          item.ownerUserId,
          item.type,
          item.channelLabel,
          item.brandId,
          item.brandName,
          item.trendId,
          item.trendTitle,
          item.ideaTitle,
          item.cardTitle,
          item.createdAt,
          item.previewUrl || "",
          item.summary || "",
          JSON.stringify(item.payload || {}),
        );
      }
    }
    deleteMissingRows(
      current.generations,
      (item) => item.id,
      (store.generations || []).map((item) => item.id),
      (id) => deleteGeneration.run(id),
    );

    for (const image of store.productImages || []) {
      if (!sameStoreRecord(currentProductImagesById.get(image.id), image)) {
        upsertProductImage.run(
          image.id,
          image.ownerUserId,
          image.originalName,
          image.storedPath,
          image.mimeType,
          Number(image.sizeBytes || 0),
          image.sha256,
          image.createdAt,
          image.lastUsedAt || "",
          image.deletedAt || "",
        );
      }
    }
    deleteMissingRows(
      current.productImages,
      (item) => item.id,
      (store.productImages || []).map((item) => item.id),
      (id) => deleteProductImage.run(id),
    );

    for (const job of store.imageJobs || []) {
      if (!sameStoreRecord(currentImageJobsById.get(job.id), job)) {
        upsertImageJob.run(
          job.id,
          job.ownerUserId,
          job.status,
          job.provider,
          job.providerMode || "",
          job.providerResultUrl || "",
          job.model || "",
          JSON.stringify(job.metadata || {}),
          JSON.stringify(job.generationContext || {}),
          job.imageUrl || "",
          job.error || "",
          job.generationId,
          Number(job.createdAt || Date.now()),
          job.updatedAt || "",
          job.completedAt || "",
        );
      }
    }
    deleteMissingRows(
      current.imageJobs,
      (item) => item.id,
      (store.imageJobs || []).map((item) => item.id),
      (id) => deleteImageJob.run(id),
    );

    for (const event of store.creditEvents || []) {
      if (!sameStoreRecord(currentCreditEventsById.get(event.id), event)) {
        upsertCreditEvent.run(
          event.id,
          event.userId,
          event.actionType,
          event.actionLabel,
          Number(event.creditDelta || 0),
          Number(event.creditCost || 0),
          event.createdAt,
          event.adminUserId,
          event.adminUserName || "",
          event.brandId,
          event.brandName || "",
          event.trendId,
          event.trendTitle || "",
          event.ideaTitle || "",
          event.generationId,
          event.channelLabel || "",
          event.summary || "",
          JSON.stringify(event.payload || {}),
        );
      }
    }
    deleteMissingRows(
      current.creditEvents,
      (item) => item.id,
      (store.creditEvents || []).map((item) => item.id),
      (id) => deleteCreditEvent.run(id),
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readStoreFromDbAnySchema() {
  if (hasCurrentStoreSchema()) {
    return readStoreFromCurrentSchema();
  }
  return readStoreFromLegacySchema();
}

function readStoreFromCurrentSchema() {
  const counters = Object.fromEntries(
    db.prepare("SELECT name, value FROM counters").all().map((row) => [row.name, row.value]),
  );

  const users = db.prepare("SELECT id, name, phone, password, account_type, department, credits, created_at FROM users ORDER BY id ASC").all().map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    password: row.password,
    accountType: row.account_type,
    department: row.department,
    credits: row.credits,
    createdAt: row.created_at,
  }));

  const sessions = db.prepare("SELECT token, user_id, created_at FROM sessions ORDER BY created_at DESC").all().map((row) => ({
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
  }));

  const verificationCodes = Object.fromEntries(
    db.prepare("SELECT phone, code, expires_at FROM verification_codes").all().map((row) => [
      row.phone,
      { code: row.code, expiresAt: row.expires_at },
    ]),
  );

  const brandLogoColumn = hasColumn("brands", "logo_json") ? "logo_json" : "'{}' AS logo_json";
  const brands = db.prepare(`
    SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, ${brandLogoColumn}, asset_tags_json
    FROM brands
    ORDER BY id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    industry: row.industry,
    audience: row.audience,
    description: row.description,
    product: row.product,
    goal: row.goal,
    knowledgeBase: row.knowledge_base,
    logo: normalizeBrandLogo(safeParseObject(row.logo_json)),
    assetTags: safeParseArray(row.asset_tags_json),
    analyses: [],
    trends: [],
  }));

  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const analysisMap = new Map();
  const analysisRows = db.prepare(`
    SELECT id, brand_id, name, timestamp, position
    FROM analyses
    ORDER BY brand_id DESC, position ASC
  `).all();

  for (const row of analysisRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand) continue;
    const analysis = {
      id: row.id,
      name: row.name,
      timestamp: row.timestamp,
      trendSnapshot: [],
    };
    brand.analyses.push(analysis);
    analysisMap.set(row.id, analysis);
  }

  const trendRows = db.prepare(`
    SELECT row_id, trend_id, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json
    FROM trends
    ORDER BY brand_id DESC, scope ASC, analysis_id ASC, bucket_key ASC, position ASC
  `).all();

  for (const row of trendRows) {
    const trend = {
      id: row.trend_id,
      bucketKey: row.bucket_key,
      bucketTitle: row.bucket_title,
      bucketDescription: row.bucket_description,
      rank: row.rank,
      title: row.title,
      category: row.category,
      summary: row.summary,
      score: row.score,
      tags: safeParseArray(row.tags_json),
      reason: row.reason,
      customPrompt: row.custom_prompt || "",
      systemPrompt: row.system_prompt || "",
      ideas: readIdeasForTrendRow(row.row_id),
    };

    if (row.scope === "current") {
      const brand = brandMap.get(row.brand_id);
      if (brand) {
        groupTrendRows([trend], brand.trends);
      }
      continue;
    }

    const analysis = analysisMap.get(row.analysis_id);
    if (analysis) {
      groupTrendRows([trend], analysis.trendSnapshot);
    }
  }

  const generations = db.prepare(`
    SELECT id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    FROM generations
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    type: row.type,
    channelLabel: row.channel_label,
    brandId: row.brand_id,
    brandName: row.brand_name,
    trendId: row.trend_id,
    trendTitle: row.trend_title,
    ideaTitle: row.idea_title,
    cardTitle: row.card_title,
    createdAt: row.created_at,
    previewUrl: row.preview_url,
    summary: row.summary,
    payload: safeParseObject(row.payload_json),
  }));

  const creditEvents = db.prepare(`
    SELECT id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    FROM credit_events
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    userId: row.user_id,
    actionType: row.action_type,
    actionLabel: row.action_label,
    creditDelta: row.credit_delta,
    creditCost: row.credit_cost,
    createdAt: row.created_at,
    adminUserId: row.admin_user_id,
    adminUserName: row.admin_user_name,
    brandId: row.brand_id,
    brandName: row.brand_name,
    trendId: row.trend_id,
    trendTitle: row.trend_title,
    ideaTitle: row.idea_title,
    generationId: row.generation_id,
    channelLabel: row.channel_label,
    summary: row.summary,
    payload: safeParseObject(row.payload_json),
  }));

  const productImages = db.prepare(`
    SELECT id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at
    FROM product_images
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    originalName: row.original_name,
    storedPath: row.stored_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || "",
    deletedAt: row.deleted_at || "",
  }));

  const imageJobs = db.prepare(`
    SELECT id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    FROM image_jobs
    ORDER BY created_at_ms DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    provider: row.provider,
    providerMode: row.provider_mode || "",
    providerResultUrl: row.provider_result_url || "",
    model: row.model || "",
    metadata: safeParseObject(row.metadata_json),
    generationContext: safeParseObject(row.generation_context_json),
    imageUrl: row.image_url || "",
    error: row.error || "",
    generationId: row.generation_id == null ? null : row.generation_id,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at || "",
    completedAt: row.completed_at || "",
  }));

  return {
    nextUserId: counters.nextUserId,
    nextBrandId: counters.nextBrandId,
    nextAnalysisId: counters.nextAnalysisId,
    nextTrendId: counters.nextTrendId,
    nextGenerationId: counters.nextGenerationId,
    nextCreditEventId: counters.nextCreditEventId,
    nextProductImageId: counters.nextProductImageId,
    users,
    sessions,
    verificationCodes,
    brands,
    generations,
    creditEvents,
    productImages,
    imageJobs,
  };
}

function readIdeasForTrendRow(trendRowId) {
  return db.prepare(`
    SELECT idea_index, title, summary, angle, brand_fit, audience, hook, tags_json
    FROM ideas
    WHERE trend_row_id = ?
    ORDER BY idea_index ASC
  `).all(trendRowId).map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: safeParseArray(row.tags_json),
  }));
}

function readStoreFromLegacySchema() {
  const counters = Object.fromEntries(
    db.prepare("SELECT name, value FROM counters").all().map((row) => [row.name, row.value]),
  );

  const users = db.prepare("SELECT id, name, phone, password, created_at FROM users ORDER BY id ASC").all().map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    password: row.password,
    accountType: "yimei",
    department: "其他",
    credits: 50,
    createdAt: row.created_at,
  }));

  const sessions = db.prepare("SELECT token, user_id, created_at FROM sessions ORDER BY created_at DESC").all().map((row) => ({
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
  }));

  const verificationCodes = Object.fromEntries(
    db.prepare("SELECT phone, code, expires_at FROM verification_codes").all().map((row) => [
      row.phone,
      { code: row.code, expiresAt: row.expires_at },
    ]),
  );

  const brands = db.prepare(`
    SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base
    FROM brands
    ORDER BY id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    industry: row.industry,
    audience: row.audience,
    description: row.description,
    product: row.product,
    goal: row.goal,
    knowledgeBase: row.knowledge_base,
    assetTags: readLegacyBrandAssetTags(row.id),
    analyses: [],
    trends: [],
  }));

  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const analysisRows = db.prepare(`
    SELECT id, brand_id, name, timestamp, position
    FROM analyses
    ORDER BY brand_id DESC, position ASC
  `).all();

  for (const row of analysisRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand) continue;
    brand.analyses.push({
      id: row.id,
      name: row.name,
      timestamp: row.timestamp,
      trendSnapshot: readLegacyAnalysisTrends(row.id),
    });
  }

  for (const brand of brands) {
    brand.trends = readLegacyCurrentTrends(brand.id);
  }

  return {
    nextUserId: counters.nextUserId,
    nextBrandId: counters.nextBrandId,
    nextAnalysisId: counters.nextAnalysisId,
    nextTrendId: counters.nextTrendId,
    nextGenerationId: counters.nextGenerationId || 1,
    nextCreditEventId: counters.nextCreditEventId || 1,
    nextProductImageId: counters.nextProductImageId || 1,
    users,
    sessions,
    verificationCodes,
    brands,
    generations: [],
    creditEvents: [],
    productImages: [],
    imageJobs: [],
  };
}

function readLegacyBrandAssetTags(brandId) {
  if (tableExists("brand_asset_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM brand_asset_tags
      WHERE brand_id = ?
      ORDER BY position ASC
    `).all(brandId);
    if (rows.length) return rows.map((row) => row.tag);
  }

  if (hasColumn("brands", "asset_tags_json")) {
    const row = db.prepare("SELECT asset_tags_json FROM brands WHERE id = ?").get(brandId);
    return safeParseArray(row?.asset_tags_json);
  }

  return [];
}

function readLegacyAnalysisTrends(analysisId) {
  const rows = db.prepare(`
    SELECT *
    FROM analysis_trends
    WHERE analysis_id = ?
    ORDER BY snapshot_order ASC
  `).all(analysisId);

  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    title: row.title,
    category: row.category,
    summary: row.summary,
    score: row.score,
    tags: readLegacyAnalysisTrendTags(analysisId, row.id, row.tags_json),
    reason: row.reason,
    customPrompt: row.custom_prompt || "",
    systemPrompt: row.system_prompt || "",
    ideas: readLegacyAnalysisTrendIdeas(analysisId, row.id),
  }));
}

function readLegacyAnalysisTrendTags(analysisId, trendId, legacyJson) {
  if (tableExists("analysis_trend_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM analysis_trend_tags
      WHERE analysis_id = ? AND trend_id = ?
      ORDER BY position ASC
    `).all(analysisId, trendId);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyAnalysisTrendIdeas(analysisId, trendId) {
  const selectSql = hasColumn("analysis_trend_ideas", "analysis_id")
    ? "SELECT * FROM analysis_trend_ideas WHERE analysis_id = ? AND trend_id = ? ORDER BY idea_index ASC"
    : "SELECT * FROM analysis_trend_ideas WHERE trend_id = ? ORDER BY idea_index ASC";
  const rows = hasColumn("analysis_trend_ideas", "analysis_id")
    ? db.prepare(selectSql).all(analysisId, trendId)
    : db.prepare(selectSql).all(trendId);

  return rows.map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: readLegacyAnalysisIdeaTags(analysisId, trendId, row.idea_index, row.tags_json),
  }));
}

function readLegacyAnalysisIdeaTags(analysisId, trendId, ideaIndex, legacyJson) {
  if (tableExists("analysis_trend_idea_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM analysis_trend_idea_tags
      WHERE analysis_id = ? AND trend_id = ? AND idea_index = ?
      ORDER BY position ASC
    `).all(analysisId, trendId, ideaIndex);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyCurrentTrends(brandId) {
  const rows = db.prepare(`
    SELECT *
    FROM current_trends
    WHERE brand_id = ?
    ORDER BY rank ASC, id ASC
  `).all(brandId);

  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    title: row.title,
    category: row.category,
    summary: row.summary,
    score: row.score,
    tags: readLegacyCurrentTrendTags(row.id, row.tags_json),
    reason: row.reason,
    customPrompt: row.custom_prompt || "",
    systemPrompt: row.system_prompt || "",
    ideas: readLegacyCurrentTrendIdeas(row.id),
  }));
}

function readLegacyCurrentTrendTags(trendId, legacyJson) {
  if (tableExists("current_trend_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM current_trend_tags
      WHERE trend_id = ?
      ORDER BY position ASC
    `).all(trendId);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyCurrentTrendIdeas(trendId) {
  return db.prepare(`
    SELECT *
    FROM current_trend_ideas
    WHERE trend_id = ?
    ORDER BY idea_index ASC
  `).all(trendId).map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: readLegacyCurrentIdeaTags(trendId, row.idea_index, row.tags_json),
  }));
}

function readLegacyCurrentIdeaTags(trendId, ideaIndex, legacyJson) {
  if (tableExists("current_trend_idea_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM current_trend_idea_tags
      WHERE trend_id = ? AND idea_index = ?
      ORDER BY position ASC
    `).all(trendId, ideaIndex);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

module.exports = {
  ensureStore,
  readStore,
  writeStore,
};
