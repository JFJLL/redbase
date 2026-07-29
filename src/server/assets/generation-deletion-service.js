const { deleteGenerationRows, deleteGenerationRowsBatch } = require("../db/repositories/generation-repository");

function collectGenerationAssets(generation) {
  const assets = [];
  const seen = new Set();

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.objectKey === "string" && value.objectKey) {
      assertGenerationAssetOwnership(value, generation);
      const identity = `aliyun_oss:${value.objectKey}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        assets.push({ ...value, provider: "aliyun_oss" });
      }
    } else if (typeof value.storedPath === "string" && value.storedPath && /(^|[\\/])generated-images[\\/]/.test(value.storedPath)) {
      assertGenerationAssetOwnership(value, generation);
      const identity = `local:${value.storedPath}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        assets.push({ ...value, provider: "local" });
      }
    }
    Object.values(value).forEach(visit);
  }

  visit(generation?.payload);
  return assets;
}

function assertGenerationAssetOwnership(asset, generation) {
  const location = String(asset?.objectKey || asset?.storedPath || "");
  const normalized = location.replace(/\\/g, "/");
  if (!location || normalized.includes("../") || normalized.startsWith("../")) {
    throw Object.assign(new Error("Generated asset is outside its generation scope"), { code: "ASSET_SCOPE_VIOLATION" });
  }
  const segments = normalized.split("/").filter(Boolean);
  const generatedIndex = segments.lastIndexOf("generated-images");
  const usersIndex = generatedIndex + 1;
  const ownerIndex = generatedIndex + 2;
  const ownerUserId = String(Number(generation?.ownerUserId));
  const generationId = String(Number(generation?.id));
  const scopedPath = segments.slice(ownerIndex + 1);
  const [year, month] = scopedPath;
  const filename = scopedPath.at(-1) || "";
  const hasValidDateDirectories = /^\d{4}$/.test(year || "") && /^(0[1-9]|1[0-2])$/.test(month || "");
  const isCurrentLayout = scopedPath.length === 4 && scopedPath[2] === generationId && filename.startsWith(`gi_${generationId}_`);
  const isLegacyLayout = scopedPath.length === 3 && filename.startsWith(`gi_${generationId}_`);
  const matchesScope =
    generatedIndex >= 0 &&
    segments[usersIndex] === "users" &&
    segments[ownerIndex] === ownerUserId &&
    hasValidDateDirectories &&
    (isCurrentLayout || isLegacyLayout);
  if (!matchesScope) {
    throw Object.assign(new Error("Generated asset is outside its generation scope"), { code: "ASSET_SCOPE_VIOLATION" });
  }
  return true;
}

async function removeGenerationAssetsAndRows(generation, options = {}) {
  if (!generation?.id) return { ok: true, alreadyDeleted: true, deletedGenerationId: null };
  if (!options.storage || typeof options.storage.deleteMany !== "function") {
    throw new Error("Generated asset storage is required for generation deletion");
  }
  const assets = collectGenerationAssets(generation);
  await options.storage.deleteMany(assets);
  const deletedAt = options.deletedAt || new Date().toISOString();
  const deleteReason = String(options.deleteReason || "user_history_delete");
  const rows = (options.deleteGenerationRows || deleteGenerationRows)(generation.id, { deletedAt, deleteReason });
  return {
    ok: true,
    alreadyDeleted: rows?.generationDeleted === false,
    deletedGenerationId: Number(generation.id),
    deletedAssetCount: assets.length,
    deletedImageJobCount: Number(rows?.imageJobsDeleted || 0),
    retainedCreditEventCount: Number(rows?.creditEventsUpdated || 0),
  };
}

function collectGenerationsAssets(generations = []) {
  return generations.flatMap((generation) => collectGenerationAssets(generation));
}

async function removeGenerationsAssets(generations = [], options = {}) {
  if (!options.storage || typeof options.storage.deleteMany !== "function") {
    throw new Error("Generated asset storage is required for generation deletion");
  }
  // Validate every asset scope before the first irreversible storage operation.
  const assets = collectGenerationsAssets(generations);
  await options.storage.deleteMany(assets);
  return { ok: true, deletedAssetCount: assets.length };
}

async function removeGenerationsAssetsAndRows(generations = [], options = {}) {
  const source = generations.filter((generation) => generation?.id);
  const assetResult = await removeGenerationsAssets(source, options);
  const deletedAt = options.deletedAt || new Date().toISOString();
  const deleteReason = String(options.deleteReason || "user_history_delete");
  const rows = (options.deleteGenerationRowsBatch || deleteGenerationRowsBatch)(source.map((generation) => ({
    generationId: generation.id,
    deletedAt,
    deleteReason,
  })));
  return {
    ok: true,
    deletedGenerationIds: rows.filter((row) => row.generationDeleted).map((row) => row.generationId),
    deletedAssetCount: assetResult.deletedAssetCount,
    deletedImageJobCount: rows.reduce((sum, row) => sum + Number(row.imageJobsDeleted || 0), 0),
    retainedCreditEventCount: rows.reduce((sum, row) => sum + Number(row.creditEventsUpdated || 0), 0),
  };
}

module.exports = {
  collectGenerationAssets,
  collectGenerationsAssets,
  assertGenerationAssetOwnership,
  removeGenerationAssetsAndRows,
  removeGenerationsAssets,
  removeGenerationsAssetsAndRows,
};
