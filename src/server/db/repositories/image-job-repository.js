const { getDbProxy } = require("../connection");
const { safeParseObject } = require("../snapshot-utils");

const db = getDbProxy();

const IMAGE_JOB_COLUMNS = `
  id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
  metadata_json, generation_context_json, image_url, error, generation_id,
  created_at_ms, updated_at, completed_at
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
  };
}

function findImageJobByOwner(jobId, ownerUserId) {
  return mapImageJobRow(db.prepare(`
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE id = ? AND owner_user_id = ?
  `).get(String(jobId || ""), Number(ownerUserId)));
}

function upsertImageJob(ownerUserId, job) {
  if (!job?.id) return null;
  const nowIso = new Date().toISOString();
  const completedAt = job.status === "completed" ? job.completedAt || nowIso : job.completedAt || "";
  db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      completed_at = excluded.completed_at
      WHERE image_jobs.owner_user_id = excluded.owner_user_id
  `).run(
    job.id,
    Number(ownerUserId),
    job.status || "pending",
    job.provider || "wavespeed",
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
  );
  return findImageJobByOwner(job.id, ownerUserId);
}

function deleteImageJobsForGeneration(generationId) {
  db.prepare("DELETE FROM image_jobs WHERE generation_id = ?").run(Number(generationId));
}

module.exports = {
  findImageJobByOwner,
  upsertImageJob,
  deleteImageJobsForGeneration,
};
