const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");

const db = getDbProxy();

function mapProductImageRow(row) {
  if (!row) return null;
  return {
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
  };
}

const IMAGE_COLUMNS = "id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at";

function listProductImagesByOwner(ownerUserId) {
  return db.prepare(`
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ? AND deleted_at = ''
    ORDER BY COALESCE(NULLIF(last_used_at, ''), created_at) DESC, id DESC
  `).all(Number(ownerUserId)).map(mapProductImageRow);
}

function findProductImageByOwner(imageId, ownerUserId) {
  return mapProductImageRow(db.prepare(`
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE id = ? AND owner_user_id = ? AND deleted_at = ''
  `).get(Number(imageId), Number(ownerUserId)));
}

function findProductImageById(imageId) {
  return mapProductImageRow(db.prepare(`
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE id = ? AND deleted_at = ''
  `).get(Number(imageId)));
}

function findDuplicateProductImage(ownerUserId, sha256) {
  return mapProductImageRow(db.prepare(`
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ? AND sha256 = ? AND deleted_at = ''
  `).get(Number(ownerUserId), String(sha256 || "")));
}

function insertProductImage(input) {
  return runTransaction(() => {
    const id = input.id ?? allocateCounter("nextProductImageId", 1);
    db.prepare(`
      INSERT INTO product_images (id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      Number(input.ownerUserId),
      input.originalName,
      input.storedPath,
      input.mimeType,
      Number(input.sizeBytes || 0),
      input.sha256,
      input.createdAt,
      input.lastUsedAt || "",
      input.deletedAt || "",
    );
    return findProductImageById(id);
  });
}

function markProductImageDeleted(imageId, deletedAt) {
  db.prepare("UPDATE product_images SET deleted_at = ? WHERE id = ?").run(deletedAt || new Date().toISOString(), Number(imageId));
  return mapProductImageRow(db.prepare(`SELECT ${IMAGE_COLUMNS} FROM product_images WHERE id = ?`).get(Number(imageId)));
}

function touchProductImageUsed(imageId, lastUsedAt) {
  db.prepare("UPDATE product_images SET last_used_at = ? WHERE id = ?").run(lastUsedAt || new Date().toISOString(), Number(imageId));
  return findProductImageById(imageId);
}

module.exports = {
  listProductImagesByOwner,
  findProductImageByOwner,
  findProductImageById,
  findDuplicateProductImage,
  insertProductImage,
  markProductImageDeleted,
  touchProductImageUsed,
};
