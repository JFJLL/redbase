const { getDbProxy } = require("../connection");
const { safeParseObject } = require("../snapshot-utils");
const { allocateCounter, runTransaction } = require("./core-repository");

const db = getDbProxy();

function mapGenerationRow(row) {
  if (!row) return null;
  return {
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
  };
}

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

function listAllGenerations() {
  return db.prepare(`
    SELECT ${GENERATION_COLUMNS}
    FROM generations
    ORDER BY created_at DESC, id DESC
  `).all().map(mapGenerationRow);
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

function deleteGenerationRows(generationId) {
  db.prepare("DELETE FROM image_jobs WHERE generation_id = ? OR json_extract(generation_context_json, '$.sourceGenerationId') = ?").run(
    Number(generationId),
    Number(generationId),
  );
  db.prepare(`
    UPDATE credit_events
    SET generation_id = NULL,
        payload_json = ?
    WHERE generation_id = ?
  `).run(JSON.stringify({ deletedGenerationId: Number(generationId), deletedAt: new Date().toISOString() }), Number(generationId));
  db.prepare("DELETE FROM generations WHERE id = ?").run(Number(generationId));
}

module.exports = {
  listGenerationsByOwner,
  listAllGenerations,
  findGenerationByOwner,
  findGenerationById,
  upsertGeneration,
  insertGeneration,
  deleteGenerationRows,
};
