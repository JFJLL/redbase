const { getDbProxy } = require("../connection");

const db = getDbProxy();

const CACHE_COLUMNS = `
  source_key, category_path, items_json, fetched_at, expires_at, last_error
`;

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function mapCacheRow(row) {
  if (!row) return null;
  return {
    sourceKey: String(row.source_key || ""),
    categoryPath: String(row.category_path || ""),
    items: parseJson(row.items_json, []),
    fetchedAt: String(row.fetched_at || ""),
    expiresAt: String(row.expires_at || ""),
    lastError: String(row.last_error || ""),
  };
}

function findExcellentContentCache(sourceKey, categoryPath = "") {
  const row = db
    .prepare(
      `SELECT ${CACHE_COLUMNS} FROM excellent_content_cache WHERE source_key = ? AND category_path = ?`,
    )
    .get(String(sourceKey || ""), String(categoryPath || ""));
  return mapCacheRow(row);
}

function upsertExcellentContentCache({
  sourceKey,
  categoryPath = "",
  items = [],
  fetchedAt,
  expiresAt,
  lastError = "",
} = {}) {
  const now = new Date().toISOString();
  const safeSourceKey = String(sourceKey || "").trim();
  const safeCategoryPath = String(categoryPath || "");
  if (!safeSourceKey) {
    throw new Error("excellent content cache requires sourceKey");
  }
  const itemsJson = JSON.stringify(Array.isArray(items) ? items : []);
  db.prepare(
    `
    INSERT INTO excellent_content_cache (
      source_key, category_path, items_json, fetched_at, expires_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, category_path) DO UPDATE SET
      items_json = excluded.items_json,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      last_error = excluded.last_error
  `,
  ).run(
    safeSourceKey,
    safeCategoryPath,
    itemsJson,
    String(fetchedAt || now),
    String(expiresAt || now),
    String(lastError || ""),
  );
  return findExcellentContentCache(safeSourceKey, safeCategoryPath);
}

function recordExcellentContentCacheError(sourceKey, categoryPath = "", lastError = "") {
  const existing = findExcellentContentCache(sourceKey, categoryPath);
  if (!existing) {
    return null;
  }
  db.prepare(
    `
    UPDATE excellent_content_cache
    SET last_error = ?
    WHERE source_key = ? AND category_path = ?
  `,
  ).run(String(lastError || "").slice(0, 500), String(sourceKey || ""), String(categoryPath || ""));
  return findExcellentContentCache(sourceKey, categoryPath);
}

module.exports = {
  findExcellentContentCache,
  upsertExcellentContentCache,
  recordExcellentContentCacheError,
};
