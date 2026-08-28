const { deleteGenerationRows, deleteGenerationRowsBatch } = require("../db/repositories/generation-repository");
const { getDbProxy } = require("../db/connection");
const { runTransaction } = require("../db/repositories/core-repository");
const { safeParseObject, safeParseArray } = require("../db/snapshot-utils");
const { recordAssetPurgeCompleted, recordAssetPurgeFailed, recordGenerationDeleted } = require("../analytics/analytics-recorder");

const db = getDbProxy();

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

function cleanPayloadPreservingData(payload, deletedAt) {
  if (Array.isArray(payload)) {
    return payload.map((item) => cleanPayloadPreservingData(item, deletedAt));
  }
  if (!payload || typeof payload !== "object") return payload;
  const cleaned = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "objectKey" || key === "storedPath") {
      continue;
    }
    if (["finalVideoUrl", "finalPosterUrl", "previewUrl", "imageUrl", "providerResultUrl", "videoUrl", "posterUrl"].includes(key)) {
      cleaned[key] = "";
      continue;
    }
    if (value && typeof value === "object" && (value.objectKey || value.storedPath)) {
      cleaned[key] = {
        provider: value.provider || "local",
        mimeType: value.mimeType || "",
        sizeBytes: Number(value.sizeBytes || value.bytes || 0),
        purged: true,
        purgedAt: deletedAt,
      };
      continue;
    }
    cleaned[key] = cleanPayloadPreservingData(value, deletedAt);
  }
  return cleaned;
}

function purgeGenerationDataInTransaction(generation, { assets, deletedAt, totalBytes }) {
  const genId = Number(generation.id);
  const cleanedPayload = cleanPayloadPreservingData(generation.payload, deletedAt);
  const hasAssets = assets.length > 0;
  const assetStatus = hasAssets ? "purged" : "none";

  db.prepare(`
    UPDATE generations SET
      visibility_status = 'expired',
      asset_status = ?,
      asset_count = ?,
      asset_bytes = ?,
      assets_deleted_at = ?,
      assets_delete_error = '',
      preview_url = '',
      payload_json = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    assetStatus,
    assets.length,
    totalBytes,
    deletedAt,
    JSON.stringify(cleanedPayload),
    deletedAt,
    genId,
  );

  db.prepare(`
    UPDATE image_jobs SET
      asset_status = 'purged',
      asset_bytes = (CASE WHEN asset_bytes > 0 THEN asset_bytes ELSE ? END),
      assets_deleted_at = ?,
      image_url = '',
      provider_result_url = '',
      updated_at = ?
    WHERE generation_id = ? OR json_extract(generation_context_json, '$.sourceGenerationId') = ?
  `).run(
    totalBytes,
    deletedAt,
    deletedAt,
    genId,
    genId,
  );

  const projects = db.prepare("SELECT id, final_video_json, input_assets_json FROM video_projects WHERE generation_id = ?").all(genId);
  for (const p of projects) {
    const fv = safeParseObject(p.final_video_json);
    const cleanFinal = {
      mimeType: fv.mimeType || "video/mp4",
      sizeBytes: Number(fv.sizeBytes || 0),
      purged: true,
      purgedAt: deletedAt,
      asset: null,
      posterAsset: null,
    };
    const rawInputs = safeParseArray(p.input_assets_json);
    const cleanInputs = rawInputs.map((item) => ({
      position: item.position,
      sourceImageId: item.sourceImageId,
      originalName: item.originalName || "",
      mimeType: item.mimeType || "image/png",
      sizeBytes: Number(item.sizeBytes || 0),
      purged: true,
      purgedAt: deletedAt,
      asset: null,
    }));

    const clips = db.prepare("SELECT id, output_video_json, continuity_frame_json FROM video_clips WHERE project_id = ?").all(p.id);
    for (const c of clips) {
      const ov = safeParseObject(c.output_video_json);
      const cf = safeParseObject(c.continuity_frame_json);
      const cleanOv = {
        mimeType: ov.mimeType || "video/mp4",
        sizeBytes: Number(ov.sizeBytes || 0),
        purged: true,
        purgedAt: deletedAt,
        asset: null,
        posterAsset: null,
      };
      const cleanCf = {
        mimeType: cf.mimeType || "image/jpeg",
        sizeBytes: Number(cf.sizeBytes || 0),
        purged: true,
        purgedAt: deletedAt,
        asset: null,
      };
      const clipBytes = Number(ov.sizeBytes || 0) + Number(cf.sizeBytes || 0);
      db.prepare(`
        UPDATE video_clips SET
          asset_status = 'purged',
          asset_bytes = ?,
          assets_deleted_at = ?,
          output_video_json = ?,
          continuity_frame_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(clipBytes, deletedAt, JSON.stringify(cleanOv), JSON.stringify(cleanCf), deletedAt, c.id);
    }

    db.prepare(`
      UPDATE video_projects SET
        asset_status = 'purged',
        asset_count = ?,
        asset_bytes = ?,
        assets_deleted_at = ?,
        final_video_json = ?,
        input_assets_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(assets.length, totalBytes, deletedAt, JSON.stringify(cleanFinal), JSON.stringify(cleanInputs), deletedAt, p.id);
  }

  recordAssetPurgeCompleted({
    generationId: genId,
    count: assets.length,
    bytes: totalBytes,
    purgedAt: deletedAt,
  });
}

async function purgeGenerationAssetsPreservingData(generation, options = {}) {
  if (!generation?.id) return { ok: true, alreadyPurged: true, generationId: null };
  if (generation.visibilityStatus === "expired" && (generation.assetStatus === "purged" || generation.assetStatus === "none")) {
    return { ok: true, alreadyPurged: true, generationId: Number(generation.id) };
  }
  if (!options.storage || typeof options.storage.deleteMany !== "function") {
    throw new Error("Generated asset storage is required for generation asset purge");
  }

  const assets = collectGenerationAssets(generation);
  const totalBytes = assets.reduce((sum, a) => sum + Number(a.sizeBytes || a.bytes || 0), 0);
  const deletedAt = options.deletedAt || new Date().toISOString();

  let staged;
  try {
    staged = typeof options.storage.stageDeleteMany === "function"
      ? await options.storage.stageDeleteMany(assets)
      : (await options.storage.deleteMany(assets), { deletedAssetCount: assets.length, rollback: async () => {}, commit: async () => {} });
  } catch (error) {
    const errMessage = String(error?.message || "Asset delete staging failed").slice(0, 200);
    try {
      db.prepare(`
        UPDATE generations SET
          asset_status = 'purge_failed',
          assets_delete_error = ?,
          updated_at = ?
        WHERE id = ?
      `).run(errMessage, deletedAt, Number(generation.id));
      recordAssetPurgeFailed({
        generationId: Number(generation.id),
        error: errMessage,
        failedAt: deletedAt,
      });
    } catch (_) {}
    throw error;
  }

  try {
    runTransaction(() => {
      purgeGenerationDataInTransaction(generation, { assets, deletedAt, totalBytes });
    });
  } catch (dbError) {
    if (staged?.rollback) await staged.rollback().catch(() => {});
    throw dbError;
  }

  if (staged?.commit) await staged.commit();

  return {
    ok: true,
    purgedGenerationId: Number(generation.id),
    purgedAssetCount: assets.length,
    purgedBytes: totalBytes,
  };
}

async function purgeGenerationsAssetsPreservingData(generations = [], options = {}) {
  const source = generations.filter((g) => g?.id);
  const purgedIds = [];
  const failedIds = [];
  let totalBytes = 0;
  for (const gen of source) {
    try {
      const res = await purgeGenerationAssetsPreservingData(gen, options);
      if (res?.purgedGenerationId) {
        purgedIds.push(res.purgedGenerationId);
        totalBytes += Number(res.purgedBytes || 0);
      }
    } catch (err) {
      failedIds.push(gen.id);
    }
  }
  return {
    ok: true,
    purgedCount: purgedIds.length,
    purgedGenerationIds: purgedIds,
    failedGenerationIds: failedIds,
    totalPurgedBytes: totalBytes,
  };
}

async function removeGenerationAssetsAndRows(generation, options = {}) {
  if (!generation?.id) return { ok: true, alreadyDeleted: true, deletedGenerationId: null };
  if (!options.storage || typeof options.storage.deleteMany !== "function") {
    throw new Error("Generated asset storage is required for generation deletion");
  }
  const assets = collectGenerationAssets(generation);
  const staged = typeof options.storage.stageDeleteMany === "function"
    ? await options.storage.stageDeleteMany(assets)
    : (await options.storage.deleteMany(assets), { deletedAssetCount: assets.length, rollback: async () => {}, commit: async () => {} });
  const deletedAt = options.deletedAt || new Date().toISOString();
  const deleteReason = String(options.deleteReason || "user_history_delete");
  let rows;
  try {
    rows = (options.deleteGenerationRows || deleteGenerationRows)(generation.id, { deletedAt, deleteReason });
    recordGenerationDeleted({ generationId: Number(generation.id), userId: generation.ownerUserId, deletedAt });
  } catch (error) {
    await staged.rollback();
    throw error;
  }
  await staged.commit();
  return {
    ok: true,
    alreadyDeleted: rows?.generationDeleted === false,
    deletedGenerationId: Number(generation.id),
    deletedAssetCount: Number(staged.deletedAssetCount ?? assets.length),
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
  const staged = typeof options.storage.stageDeleteMany === "function"
    ? await options.storage.stageDeleteMany(assets)
    : (await options.storage.deleteMany(assets), { deletedAssetCount: assets.length, rollback: async () => {}, commit: async () => {} });
  return { ok: true, deletedAssetCount: Number(staged.deletedAssetCount ?? assets.length), ...staged };
}

async function removeGenerationsAssetsAndRows(generations = [], options = {}) {
  const source = generations.filter((generation) => generation?.id);
  const assetResult = await removeGenerationsAssets(source, options);
  const deletedAt = options.deletedAt || new Date().toISOString();
  const deleteReason = String(options.deleteReason || "user_history_delete");
  let rows;
  try {
    rows = (options.deleteGenerationRowsBatch || deleteGenerationRowsBatch)(source.map((generation) => ({
      generationId: generation.id,
      deletedAt,
      deleteReason,
    })));
    for (const gen of source) {
      recordGenerationDeleted({ generationId: Number(gen.id), userId: gen.ownerUserId, deletedAt });
    }
  } catch (error) {
    await assetResult.rollback();
    throw error;
  }
  await assetResult.commit();
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
  cleanPayloadPreservingData,
  purgeGenerationAssetsPreservingData,
  purgeGenerationsAssetsPreservingData,
  removeGenerationAssetsAndRows,
  removeGenerationsAssets,
  removeGenerationsAssetsAndRows,
};
