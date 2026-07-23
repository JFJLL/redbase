const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");

const db = getDbProxy();

const ASSET_TYPE_PRODUCT = "product";
const ASSET_TYPE_OTHER = "other";
const ASSET_TYPE_UNASSIGNED = "unassigned";

function normalizeAssetType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === ASSET_TYPE_PRODUCT) return ASSET_TYPE_PRODUCT;
  if (raw === ASSET_TYPE_OTHER) return ASSET_TYPE_OTHER;
  return ASSET_TYPE_UNASSIGNED;
}

function normalizeBrandId(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function mapProductImageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    brandId: normalizeBrandId(row.brand_id),
    assetType: normalizeAssetType(row.asset_type),
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

const IMAGE_COLUMNS =
  "id, owner_user_id, brand_id, asset_type, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at";

function listProductImagesByOwner(ownerUserId) {
  return db
    .prepare(
      `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ? AND deleted_at = ''
    ORDER BY COALESCE(NULLIF(last_used_at, ''), created_at) DESC, id DESC
  `,
    )
    .all(Number(ownerUserId))
    .map(mapProductImageRow);
}

/**
 * Strict brand-scoped product assets for excellent remix pickers.
 * Never returns unassigned, other-brand, or non-product rows.
 */
function listProductImagesByOwnerAndBrand(ownerUserId, brandId) {
  const safeBrandId = normalizeBrandId(brandId);
  if (!safeBrandId) return [];
  return db
    .prepare(
      `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ?
      AND brand_id = ?
      AND asset_type = ?
      AND deleted_at = ''
    ORDER BY COALESCE(NULLIF(last_used_at, ''), created_at) DESC, id DESC
  `,
    )
    .all(Number(ownerUserId), safeBrandId, ASSET_TYPE_PRODUCT)
    .map(mapProductImageRow);
}

/** Unassigned product-library assets that can be claimed into a brand. */
function listUnassignedProductImagesByOwner(ownerUserId) {
  return db
    .prepare(
      `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ?
      AND brand_id = 0
      AND asset_type = ?
      AND deleted_at = ''
    ORDER BY COALESCE(NULLIF(last_used_at, ''), created_at) DESC, id DESC
  `,
    )
    .all(Number(ownerUserId), ASSET_TYPE_UNASSIGNED)
    .map(mapProductImageRow);
}

/**
 * Move an unassigned library image into a brand product scope.
 * Same-file brand duplicates are preferred when sha256 already exists on that brand.
 */
function claimUnassignedProductImageToBrand(imageId, ownerUserId, brandId) {
  const safeBrandId = normalizeBrandId(brandId);
  if (!safeBrandId) return null;
  return runTransaction(() => {
    const current = findProductImageByOwner(imageId, ownerUserId);
    if (!current) return null;
    if (Number(current.brandId) === safeBrandId && current.assetType === ASSET_TYPE_PRODUCT) {
      return current;
    }
    if (Number(current.brandId) !== 0 || current.assetType !== ASSET_TYPE_UNASSIGNED) {
      return null;
    }
    const existing = findDuplicateProductImage({
      ownerUserId,
      brandId: safeBrandId,
      assetType: ASSET_TYPE_PRODUCT,
      sha256: current.sha256,
    });
    if (existing) {
      // Keep brand copy; soft-delete the unassigned duplicate to avoid two identical rows confusing the UI.
      markProductImageDeleted(current.id, new Date().toISOString());
      return existing;
    }
    db.prepare(
      `
      UPDATE product_images
      SET brand_id = ?, asset_type = ?
      WHERE id = ? AND owner_user_id = ? AND brand_id = 0 AND asset_type = ? AND deleted_at = ''
    `,
    ).run(safeBrandId, ASSET_TYPE_PRODUCT, Number(imageId), Number(ownerUserId), ASSET_TYPE_UNASSIGNED);
    return findProductImageByOwner(imageId, ownerUserId);
  });
}

function findProductImageByOwner(imageId, ownerUserId) {
  return mapProductImageRow(
    db
      .prepare(
        `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE id = ? AND owner_user_id = ? AND deleted_at = ''
  `,
      )
      .get(Number(imageId), Number(ownerUserId)),
  );
}

function findProductImageByOwnerBrandAndType(imageId, ownerUserId, brandId, assetType = ASSET_TYPE_PRODUCT) {
  const safeBrandId = normalizeBrandId(brandId);
  if (!safeBrandId) return null;
  return mapProductImageRow(
    db
      .prepare(
        `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE id = ?
      AND owner_user_id = ?
      AND brand_id = ?
      AND asset_type = ?
      AND deleted_at = ''
  `,
      )
      .get(Number(imageId), Number(ownerUserId), safeBrandId, normalizeAssetType(assetType)),
  );
}

function findProductImageById(imageId) {
  return mapProductImageRow(
    db
      .prepare(
        `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE id = ? AND deleted_at = ''
  `,
      )
      .get(Number(imageId)),
  );
}

/**
 * Brand-scoped dedupe. Same file may belong to brand A and brand B independently.
 * Call with object: { ownerUserId, brandId, assetType, sha256 }
 * Legacy call (ownerUserId, sha256) is treated as unassigned scope.
 */
function findDuplicateProductImage(ownerUserIdOrOpts, sha256Maybe) {
  let ownerUserId;
  let brandId = 0;
  let assetType = ASSET_TYPE_UNASSIGNED;
  let sha256 = "";
  if (ownerUserIdOrOpts && typeof ownerUserIdOrOpts === "object" && !Array.isArray(ownerUserIdOrOpts)) {
    ownerUserId = Number(ownerUserIdOrOpts.ownerUserId);
    brandId = normalizeBrandId(ownerUserIdOrOpts.brandId);
    assetType = normalizeAssetType(
      ownerUserIdOrOpts.assetType != null
        ? ownerUserIdOrOpts.assetType
        : brandId > 0
          ? ASSET_TYPE_PRODUCT
          : ASSET_TYPE_UNASSIGNED,
    );
    sha256 = String(ownerUserIdOrOpts.sha256 || "");
  } else {
    ownerUserId = Number(ownerUserIdOrOpts);
    brandId = 0;
    assetType = ASSET_TYPE_UNASSIGNED;
    sha256 = String(sha256Maybe || "");
  }
  return mapProductImageRow(
    db
      .prepare(
        `
    SELECT ${IMAGE_COLUMNS}
    FROM product_images
    WHERE owner_user_id = ?
      AND brand_id = ?
      AND asset_type = ?
      AND sha256 = ?
      AND deleted_at = ''
  `,
      )
      .get(ownerUserId, brandId, assetType, sha256),
  );
}

function insertProductImage(input) {
  return runTransaction(() => {
    const id = input.id ?? allocateCounter("nextProductImageId", 1);
    const brandId = normalizeBrandId(input.brandId);
    const assetType = normalizeAssetType(
      input.assetType != null
        ? input.assetType
        : brandId > 0
          ? ASSET_TYPE_PRODUCT
          : ASSET_TYPE_UNASSIGNED,
    );
    db.prepare(
      `
      INSERT INTO product_images (
        id, owner_user_id, brand_id, asset_type, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      Number(input.ownerUserId),
      brandId,
      assetType,
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
  db.prepare("UPDATE product_images SET deleted_at = ? WHERE id = ?").run(
    deletedAt || new Date().toISOString(),
    Number(imageId),
  );
  return mapProductImageRow(
    db.prepare(`SELECT ${IMAGE_COLUMNS} FROM product_images WHERE id = ?`).get(Number(imageId)),
  );
}

function touchProductImageUsed(imageId, lastUsedAt) {
  db.prepare("UPDATE product_images SET last_used_at = ? WHERE id = ?").run(
    lastUsedAt || new Date().toISOString(),
    Number(imageId),
  );
  return findProductImageById(imageId);
}

module.exports = {
  ASSET_TYPE_PRODUCT,
  ASSET_TYPE_OTHER,
  ASSET_TYPE_UNASSIGNED,
  normalizeAssetType,
  normalizeBrandId,
  listProductImagesByOwner,
  listProductImagesByOwnerAndBrand,
  listUnassignedProductImagesByOwner,
  claimUnassignedProductImageToBrand,
  findProductImageByOwner,
  findProductImageByOwnerBrandAndType,
  findProductImageById,
  findDuplicateProductImage,
  insertProductImage,
  markProductImageDeleted,
  touchProductImageUsed,
};
