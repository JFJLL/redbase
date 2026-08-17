const { getDbProxy } = require("../connection");
const { safeParseObject } = require("../snapshot-utils");

const db = getDbProxy();

const IMAGE_JOB_COLUMNS = `
  id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
  metadata_json, generation_context_json, image_url, error, generation_id,
  created_at_ms, updated_at, completed_at
`;

const ACTIVE_STATUSES = ["pending", "running"];

function nowIso() {
  return new Date().toISOString();
}

function mapImageJobRow(row) {
  if (!row) return null;
  const metadata = safeParseObject(row.metadata_json);
  const generationContext = safeParseObject(row.generation_context_json);
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    provider: row.provider,
    providerMode: row.provider_mode || "",
    providerResultUrl: row.provider_result_url || "",
    model: row.model || "",
    metadata,
    generationContext,
    imageUrl: row.image_url || "",
    error: row.error || "",
    generationId: row.generation_id == null ? null : row.generation_id,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at || "",
    completedAt: row.completed_at || "",
    evaluationStartedAt: metadata.evaluationStartedAt || row.created_at_ms,
    evaluationRunId: metadata.evaluationRunId || "",
  };
}

function serializeMetadata(job) {
  const metadata = job.metadata && typeof job.metadata === "object" ? { ...job.metadata } : {};
  if (job.evaluationStartedAt != null) {
    metadata.evaluationStartedAt = Number(job.evaluationStartedAt);
  }
  if (job.evaluationRunId) {
    metadata.evaluationRunId = String(job.evaluationRunId);
  }
  return JSON.stringify(metadata);
}

function serializeGenerationContext(job) {
  return JSON.stringify(
    job.generationContext && typeof job.generationContext === "object" ? job.generationContext : {},
  );
}

function normalizeStatus(status) {
  const value = String(status || "pending").trim().toLowerCase();
  if (value === "running" || value === "completed" || value === "failed") return value;
  return "pending";
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}

function createJob(job) {
  if (!job?.id) {
    throw new Error("image job id is required");
  }
  const status = normalizeStatus(job.status);
  const updatedAt = nowIso();
  const completedAt = isTerminalStatus(status) ? job.completedAt || updatedAt : job.completedAt || "";
  db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(job.id),
    Number(job.ownerUserId || 0),
    status,
    job.provider || "keystone",
    job.providerMode || "",
    job.providerResultUrl || "",
    job.model || "",
    serializeMetadata(job),
    serializeGenerationContext(job),
    job.imageUrl || "",
    job.error || "",
    job.generationId ?? null,
    Number(job.createdAt || Date.now()),
    updatedAt,
    completedAt,
  );
  return getJob(job.id);
}

function getJob(jobId) {
  const id = String(jobId || "");
  if (!id) return null;
  return mapImageJobRow(db.prepare(`
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE id = ?
  `).get(id));
}

function updateJob(job) {
  if (!job?.id) {
    throw new Error("image job id is required");
  }
  const existing = getJob(job.id);
  if (!existing) {
    return createJob(job);
  }
  const status = normalizeStatus(job.status);
  const updatedAt = nowIso();
  const completedAt = isTerminalStatus(status)
    ? job.completedAt || existing.completedAt || updatedAt
    : "";
  db.prepare(`
    UPDATE image_jobs SET
      owner_user_id = ?,
      status = ?,
      provider = ?,
      provider_mode = ?,
      provider_result_url = ?,
      model = ?,
      metadata_json = ?,
      generation_context_json = ?,
      image_url = ?,
      error = ?,
      generation_id = ?,
      created_at_ms = ?,
      updated_at = ?,
      completed_at = ?
    WHERE id = ?
  `).run(
    Number(job.ownerUserId != null ? job.ownerUserId : existing.ownerUserId || 0),
    status,
    job.provider || existing.provider || "keystone",
    job.providerMode != null ? job.providerMode : existing.providerMode || "",
    job.providerResultUrl != null ? job.providerResultUrl : existing.providerResultUrl || "",
    job.model != null ? job.model : existing.model || "",
    serializeMetadata({ ...existing, ...job, metadata: job.metadata != null ? job.metadata : existing.metadata }),
    serializeGenerationContext({
      generationContext: job.generationContext != null ? job.generationContext : existing.generationContext,
    }),
    job.imageUrl != null ? job.imageUrl : existing.imageUrl || "",
    job.error != null ? job.error : existing.error || "",
    job.generationId !== undefined ? job.generationId : existing.generationId,
    Number(job.createdAt || existing.createdAt || Date.now()),
    updatedAt,
    completedAt,
    String(job.id),
  );
  return getJob(job.id);
}

function listPendingJobs({ limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT ${IMAGE_JOB_COLUMNS}
    FROM image_jobs
    WHERE status IN ('pending', 'running')
    ORDER BY created_at_ms ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 100));
  return rows.map(mapImageJobRow);
}

function markFailed(jobId, error = "timeout") {
  const id = String(jobId || "");
  if (!id) return null;
  const existing = getJob(id);
  if (!existing) return null;
  if (isTerminalStatus(existing.status)) return existing;
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE image_jobs SET
      status = 'failed',
      error = ?,
      updated_at = ?,
      completed_at = ?
    WHERE id = ?
      AND status IN ('pending', 'running')
  `).run(String(error || "timeout"), updatedAt, updatedAt, id);
  return getJob(id);
}

module.exports = {
  ACTIVE_STATUSES,
  createJob,
  getJob,
  updateJob,
  listPendingJobs,
  markFailed,
};
