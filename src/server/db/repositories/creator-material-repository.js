const { getDbProxy } = require("../connection");
const { allocateCounter } = require("./core-repository");

const db = getDbProxy();
const MATERIAL_KINDS = new Set([
  "experience",
  "case",
  "viewpoint",
  "quote",
  // Keep compatibility with creator-material rows from earlier RedBase drafts.
  "opinion",
  "question",
  "scene",
  "idea",
]);

function normalizeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，\n]/);
  return [...new Set(source.map((item) => normalizeText(item, 24)).filter(Boolean))].slice(0, 8);
}

function normalizeKind(value) {
  return MATERIAL_KINDS.has(value) ? value : "viewpoint";
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function mapCreatorMaterialRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ownerUserId: Number(row.owner_user_id),
    brandId: Number(row.brand_id),
    kind: normalizeKind(row.kind),
    title: row.title || "",
    content: row.content || "",
    tags: parseTags(row.tags_json),
    sourceDate: row.source_date || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

function listCreatorMaterials(ownerUserId, brandId = null) {
  const rows = brandId
    ? db.prepare(`
        SELECT id, owner_user_id, brand_id, kind, title, content, tags_json, source_date, created_at, updated_at
        FROM creator_materials
        WHERE owner_user_id = ? AND brand_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(Number(ownerUserId), Number(brandId))
    : db.prepare(`
        SELECT id, owner_user_id, brand_id, kind, title, content, tags_json, source_date, created_at, updated_at
        FROM creator_materials
        WHERE owner_user_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(Number(ownerUserId));
  return rows.map(mapCreatorMaterialRow);
}

function findCreatorMaterialByOwner(id, ownerUserId) {
  return mapCreatorMaterialRow(
    db.prepare(`
      SELECT id, owner_user_id, brand_id, kind, title, content, tags_json, source_date, created_at, updated_at
      FROM creator_materials
      WHERE id = ? AND owner_user_id = ?
    `).get(Number(id), Number(ownerUserId)),
  );
}

function insertCreatorMaterial(input) {
  const id = allocateCounter("nextCreatorMaterialId", 1);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO creator_materials (
      id, owner_user_id, brand_id, kind, title, content, tags_json, source_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    Number(input.ownerUserId),
    Number(input.brandId),
    normalizeKind(input.kind),
    normalizeText(input.title, 100),
    normalizeText(input.content, 1800),
    JSON.stringify(normalizeTags(input.tags)),
    normalizeText(input.sourceDate, 20),
    now,
    now,
  );
  return findCreatorMaterialByOwner(id, input.ownerUserId);
}

function updateCreatorMaterial(id, ownerUserId, input) {
  const existing = findCreatorMaterialByOwner(id, ownerUserId);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE creator_materials
    SET kind = ?, title = ?, content = ?, tags_json = ?, source_date = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ?
  `).run(
    normalizeKind(input.kind ?? existing.kind),
    normalizeText(input.title ?? existing.title, 100),
    normalizeText(input.content ?? existing.content, 1800),
    JSON.stringify(normalizeTags(input.tags ?? existing.tags)),
    normalizeText(input.sourceDate ?? existing.sourceDate, 20),
    now,
    Number(id),
    Number(ownerUserId),
  );
  return findCreatorMaterialByOwner(id, ownerUserId);
}

function deleteCreatorMaterial(id, ownerUserId) {
  return db.prepare(
    "DELETE FROM creator_materials WHERE id = ? AND owner_user_id = ?",
  ).run(Number(id), Number(ownerUserId)).changes === 1;
}

module.exports = {
  MATERIAL_KINDS,
  mapCreatorMaterialRow,
  listCreatorMaterials,
  findCreatorMaterialByOwner,
  insertCreatorMaterial,
  updateCreatorMaterial,
  deleteCreatorMaterial,
};
