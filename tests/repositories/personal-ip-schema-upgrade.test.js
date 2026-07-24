const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const {
  initializeDatabaseSchema,
  ensureSchemaUpgrades,
  ensureDatabaseIndexes,
  hasCurrentStoreSchema,
} = require("../../src/server/db/schema");
const { deleteBrandById } = require("../../src/server/db/repositories/brand-repository");

const db = openDatabase();
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'customer',
    department TEXT NOT NULL DEFAULT '',
    credits INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL
  );
  CREATE TABLE brands (
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
  INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at)
  VALUES (1, 'Legacy User', '13910000991', 'hash', 'customer', '', 5, '2026-07-01T00:00:00.000Z');
  INSERT INTO brands (
    id, owner_user_id, name, industry, audience, description, product, goal,
    knowledge_base, logo_json, asset_tags_json
  ) VALUES (
    11, 1, 'Legacy Brand', '家居', '租房人群', '旧版本品牌档案', '折叠桌',
    '内容增长', '', '{}', '[]'
  );
`);

test("schema upgrade preserves old brands as brand profiles and adds personal-IP storage", () => {
  initializeDatabaseSchema();
  ensureSchemaUpgrades();
  ensureDatabaseIndexes();

  const columns = new Set(db.prepare("PRAGMA table_info(brands)").all().map((row) => row.name));
  assert.equal(columns.has("profile_type"), true);
  assert.equal(columns.has("content_pillars_json"), true);
  assert.equal(columns.has("persona_style"), true);

  const legacy = db.prepare(`
    SELECT profile_type, content_pillars_json, persona_style
    FROM brands
    WHERE id = 11
  `).get();
  assert.deepEqual(legacy, {
    profile_type: "brand",
    content_pillars_json: "[]",
    persona_style: "",
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'creator_materials'").get().count,
    1,
  );
  assert.equal(hasCurrentStoreSchema(), true);

  db.prepare(`
    INSERT INTO creator_materials (owner_user_id, brand_id, kind, title, content, tags_json, created_at, updated_at)
    VALUES (1, 11, 'experience', '旧档案素材', '删除档案时必须一起删除', '[]', '2026-07-01', '2026-07-01')
  `).run();
  deleteBrandById(11);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM creator_materials WHERE brand_id = 11").get().count, 0);
});
