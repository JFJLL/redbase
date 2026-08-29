const { getDbProxy } = require("../connection");
const { safeParseObject } = require("../snapshot-utils");
const { recordImageTaskAttempt } = require("../../analytics/ai-attempt-recorder");
const { GENERATION_TYPE_TO_FEATURE } = require("../../analytics/analytics-constants");

const db = getDbProxy();

const IMAGE_JOB_COLUMNS = `
  id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
  metadata_json, generation_context_json, image_url, error, generation_id,
  created_at_ms, updated_at, completed_at, asset_status, asset_bytes, assets_deleted_at
`;

function mapImageJobRow(row) {
  if (!row) return null;
  return {
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
    assetStatus: row.asset_status || "available",
    assetBytes: Number(row.asset_bytes || 0),
    assetsDeletedAt: row.assets_deleted_at || "",
  };
}

function findImageJobByOwner(jobId, ownerUserId) {
  return mapImageJobRow(db.prepare(`
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE id = ? AND owner_user_id = ?
  `).get(String(jobId || ""), Number(ownerUserId)));
}

/**
 * Current user's recoverable image jobs, oldest first — recovery authority.
 * 包含 pending/running，以及「已失败但从未退款」的任务：这类任务只能通过
 * 轮询触发幂等退款（服务重启的超时清扫只置 failed，不写退款标记），
 * 若不进入恢复列表，用户已扣积分将永远无法退回。
 */
function listActiveImageJobsByOwner(ownerUserId) {
  return db.prepare(`
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE owner_user_id = ?
      AND (
        status IN ('pending', 'running')
        OR (
          status = 'failed'
          AND json_extract(generation_context_json, '$.creditEventId') IS NOT NULL
          AND json_extract(generation_context_json, '$.refundCreditEventId') IS NULL
        )
      )
    ORDER BY created_at_ms ASC
  `).all(Number(ownerUserId)).map(mapImageJobRow);
}

/** 同组全部成员任务（含已完成/失败页）：恢复横幅按组回填终态页计数。 */
function listImageJobsByOwnerAndCarouselGroup(ownerUserId, carouselGroupId) {
  const groupId = String(carouselGroupId || "").trim();
  if (!groupId) return [];
  return db
    .prepare(
      `
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE owner_user_id = ?
      AND json_extract(generation_context_json, '$.carouselGroupId') = ?
    ORDER BY created_at_ms ASC
  `,
    )
    .all(Number(ownerUserId), groupId)
    .map(mapImageJobRow);
}

function upsertImageJob(ownerUserId, job) {
  if (!job?.id) return null;
  const nowIso = new Date().toISOString();
  const completedAt = job.status === "completed" ? job.completedAt || nowIso : job.completedAt || "";
  db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at, asset_status, asset_bytes, assets_deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
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
      completed_at = excluded.completed_at,
      asset_status = excluded.asset_status,
      asset_bytes = excluded.asset_bytes,
      assets_deleted_at = excluded.assets_deleted_at
      WHERE image_jobs.owner_user_id = excluded.owner_user_id
  `).run(
    job.id,
    Number(ownerUserId),
    job.status || "pending",
    job.provider || "keystone",
    job.providerMode || "",
    job.providerResultUrl || "",
    job.model || "",
    JSON.stringify(job.metadata && typeof job.metadata === "object" ? job.metadata : {}),
    JSON.stringify(job.generationContext && typeof job.generationContext === "object" ? job.generationContext : {}),
    job.imageUrl || "",
    job.error || "",
    job.generationId ?? null,
    Number(job.createdAt || Date.now()),
    nowIso,
    completedAt,
    job.assetStatus || "available",
    Number(job.assetBytes || 0),
    job.assetsDeletedAt || "",
  );
  const savedJob = findImageJobByOwner(job.id, ownerUserId);
  try {
    if (job.status === "completed") {
      const type = job.generationContext?.type || "";
      const feature = GENERATION_TYPE_TO_FEATURE[type] || type || "style_image";
      recordImageTaskAttempt({
        jobId: job.id,
        feature,
        provider: job.provider || "keystone",
        model: job.model || "",
        attemptNo: Number(job.metadata?.attemptNo || 1),
        status: "completed",
        durationMs: job.createdAt ? Math.max(0, Date.now() - Number(job.createdAt)) : 0,
        creditCost: Number(job.generationContext?.creditCost || 0),
        startedAt: job.metadata?.attemptStartedAt || (job.createdAt ? new Date(Number(job.createdAt)).toISOString() : nowIso),
        completedAt,
        actorUserId: ownerUserId,
      });
    } else if (job.status === "failed") {
      const type = job.generationContext?.type || "";
      const feature = GENERATION_TYPE_TO_FEATURE[type] || type || "style_image";
      recordImageTaskAttempt({
        jobId: job.id,
        feature,
        provider: job.provider || "keystone",
        model: job.model || "",
        attemptNo: Number(job.metadata?.attemptNo || 1),
        status: "failed",
        errorStage: "provider",
        errorMessage: job.error || "",
        durationMs: job.createdAt ? Math.max(0, Date.now() - Number(job.createdAt)) : 0,
        creditCost: 0,
        startedAt: job.metadata?.attemptStartedAt || (job.createdAt ? new Date(Number(job.createdAt)).toISOString() : nowIso),
        completedAt: nowIso,
        actorUserId: ownerUserId,
      });
    }
  } catch (_) {}
  return savedJob;
}

function deleteImageJobsForGeneration(generationId) {
  db.prepare("DELETE FROM image_jobs WHERE generation_id = ?").run(Number(generationId));
}

module.exports = {
  findImageJobByOwner,
  listActiveImageJobsByOwner,
  listImageJobsByOwnerAndCarouselGroup,
  upsertImageJob,
  deleteImageJobsForGeneration,
};
