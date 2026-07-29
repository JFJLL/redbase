const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { mapGenerationRow } = require("./row-mappers");

const db = getDbProxy();

const GENERATION_COLUMNS = `
  id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
  card_title, created_at, preview_url, summary, payload_json
`;

function listGenerationsByOwner(ownerUserId) {
  return db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    WHERE owner_user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(Number(ownerUserId)).map(mapGenerationRow);
}

function normalizeSearchFilters(filters = {}) {
  return {
    brandId: filters.brandId ? Number(filters.brandId) : undefined,
    type: filters.type ? String(filters.type).trim() : undefined,
    q: filters.q ? String(filters.q).trim() : undefined,
    from: filters.from ? String(filters.from).trim() : undefined,
    to: filters.to ? String(filters.to).trim() : undefined,
  };
}

function searchGenerations(ownerUserId, filters = {}) {
  const normalized = normalizeSearchFilters(filters);
  let sql = `
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    WHERE owner_user_id = ?
  `;
  const params = [Number(ownerUserId)];

  if (Number.isFinite(normalized.brandId)) {
    sql += " AND brand_id = ?";
    params.push(normalized.brandId);
  }
  if (normalized.type) {
    sql += " AND type = ?";
    params.push(normalized.type);
  }
  if (normalized.q) {
    sql += " AND (card_title LIKE ? OR summary LIKE ? OR trend_title LIKE ? OR brand_name LIKE ? OR idea_title LIKE ?)";
    const q = `%${normalized.q}%`;
    params.push(q, q, q, q, q);
  }
  if (normalized.from) {
    sql += " AND created_at >= ?";
    params.push(normalized.from);
  }
  if (normalized.to) {
    sql += " AND created_at <= ?";
    params.push(normalized.to);
  }

  sql += " ORDER BY created_at DESC, id DESC";
  return db.prepare(sql).all(...params).map(mapGenerationRow);
}

function listAllGenerations() {
  return db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    ORDER BY created_at DESC, id DESC
  `).all().map(mapGenerationRow);
}

function listExpiredGenerations(cutoffIso) {
  return db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    WHERE julianday(created_at) IS NULL
      OR julianday(created_at) <= julianday(?)
    ORDER BY julianday(created_at) ASC, id ASC
  `).all(String(cutoffIso || "")).map(mapGenerationRow);
}

function payloadContainsGeneratedAsset(value, asset) {
  if (Array.isArray(value)) return value.some((item) => payloadContainsGeneratedAsset(item, asset));
  if (!value || typeof value !== "object") return false;
  if (asset?.objectKey && value.objectKey === asset.objectKey) return true;
  if (asset?.storedPath && value.storedPath === asset.storedPath) return true;
  return Object.values(value).some((item) => payloadContainsGeneratedAsset(item, asset));
}

function isGeneratedAssetReferenced(asset) {
  if (!asset?.objectKey && !asset?.storedPath) return false;
  return listAllGenerations().some((generation) => payloadContainsGeneratedAsset(generation.payload, asset));
}

function findGenerationByOwner(generationId, ownerUserId) {
  return mapGenerationRow(db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    WHERE id = ? AND owner_user_id = ?
  `).get(Number(generationId), Number(ownerUserId)));
}

function findGenerationById(generationId) {
  return mapGenerationRow(db.prepare(`SELECT ${GENERATION_COLUMNS} FROM generations WHERE id = ?`).get(Number(generationId)));
}

function findXhsCarouselGenerationByGroup(ownerUserId, carouselGroupId) {
  const groupId = String(carouselGroupId || "").trim();
  if (!groupId) return null;
  return mapGenerationRow(db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    WHERE owner_user_id = ?
      AND type = 'xhsCarousel'
      AND json_extract(payload_json, '$.carouselGroupId') = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(Number(ownerUserId), groupId));
}

function upsertGeneration(generation) {
  db.prepare(`
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
  `).run(
    generation.id,
    generation.ownerUserId,
    generation.type,
    generation.channelLabel,
    generation.brandId,
    generation.brandName,
    generation.trendId,
    generation.trendTitle,
    generation.ideaTitle,
    generation.cardTitle,
    generation.createdAt,
    generation.previewUrl || "",
    generation.summary || "",
    JSON.stringify(generation.payload || {}),
  );
  return findGenerationById(generation.id);
}

function insertGeneration(generation) {
  return runTransaction(() => {
    const generationId = generation.id ?? allocateCounter("nextGenerationId", 1);
    return upsertGeneration({ ...generation, id: generationId });
  });
}

function deleteGenerationRowsStatement(generationId, options = {}) {
  const id = Number(generationId);
  const deletedAt = String(options.deletedAt || new Date().toISOString());
  const deleteReason = String(options.deleteReason || "user_history_delete");
  const imageJobs = db.prepare(
    "DELETE FROM image_jobs WHERE generation_id = ? OR json_extract(generation_context_json, '$.sourceGenerationId') = ?",
  ).run(id, id);
  const creditEvents = db.prepare(`
      UPDATE credit_events
      SET generation_id = NULL,
          payload_json = json_set(
            CASE
              WHEN json_valid(payload_json) THEN
                CASE WHEN json_type(payload_json) = 'object' THEN payload_json ELSE '{}' END
              ELSE '{}'
            END,
            '$.generationDeletion',
            json_object(
              'deletedGenerationId', ?,
              'deletedAt', ?,
              'deleteReason', ?
            )
          )
      WHERE generation_id = ?
    `).run(id, deletedAt, deleteReason, id);
  const generation = db.prepare("DELETE FROM generations WHERE id = ?").run(id);
  return {
    generationId: id,
    imageJobsDeleted: imageJobs.changes,
    creditEventsUpdated: creditEvents.changes,
    generationDeleted: generation.changes > 0,
  };
}

function deleteGenerationRows(generationId, options = {}) {
  return runTransaction(() => deleteGenerationRowsStatement(generationId, options));
}

function deleteGenerationRowsBatch(entries = [], options = {}) {
  return runTransaction(() => {
    const rows = entries.map((entry) => deleteGenerationRowsStatement(entry.generationId, entry));
    if (typeof options.afterDelete === "function") options.afterDelete(rows);
    return rows;
  });
}

module.exports = {
  listGenerationsByOwner,
  searchGenerations,
  listAllGenerations,
  isGeneratedAssetReferenced,
  listExpiredGenerations,
  findGenerationByOwner,
  findGenerationById,
  findXhsCarouselGenerationByGroup,
  upsertGeneration,
  insertGeneration,
  deleteGenerationRows,
  deleteGenerationRowsBatch,
};
