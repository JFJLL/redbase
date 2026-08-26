const { getDbProxy } = require("../connection");
const { safeParseArray, safeParseObject } = require("../snapshot-utils");
const { allocateCounter, runTransaction } = require("./core-repository");

const db = getDbProxy();

const PROJECT_COLUMNS = `
  id, owner_user_id, generation_id, request_id, brand_id, trend_id, idea_index,
  video_model, mode, resolution, aspect_ratio, total_duration_sec, status,
  reference_asset_ids_json, visual_bible_json, script_json, estimated_credits,
  charged_credits, refunded_credits, credit_event_id, final_video_json, error,
  created_at, updated_at
`;

const CLIP_COLUMNS = `
  id, project_id, clip_index, start_sec, end_sec, duration_sec, status,
  depends_on_clip_index, prompt, provider, provider_task_id, continuity_mode,
  reference_asset_ids_json, continuity_state_json, output_video_json,
  continuity_frame_json, credit_cost, attempt, retry_count, error, created_at, updated_at
`;

function parseJsonObject(value) {
  return safeParseObject(value);
}

function nowIso() {
  return new Date().toISOString();
}

function mapClipRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    index: Number(row.clip_index),
    clipIndex: Number(row.clip_index),
    startSec: Number(row.start_sec),
    endSec: Number(row.end_sec),
    durationSec: Number(row.duration_sec),
    status: String(row.status || "waiting_dependency"),
    dependsOnClipIndex: row.depends_on_clip_index == null ? null : Number(row.depends_on_clip_index),
    prompt: String(row.prompt || ""),
    provider: String(row.provider || ""),
    providerTaskId: String(row.provider_task_id || ""),
    continuityMode: String(row.continuity_mode || ""),
    referenceAssetIds: safeParseArray(row.reference_asset_ids_json),
    continuityState: parseJsonObject(row.continuity_state_json),
    outputVideo: parseJsonObject(row.output_video_json),
    continuityFrame: parseJsonObject(row.continuity_frame_json),
    creditCost: Number(row.credit_cost || 0),
    attempt: Number(row.attempt || 0),
    retryCount: Number(row.retry_count || 0),
    error: String(row.error || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function mapProjectRow(row, clips = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ownerUserId: Number(row.owner_user_id),
    generationId: Number(row.generation_id),
    requestId: String(row.request_id || ""),
    brandId: Number(row.brand_id),
    trendId: Number(row.trend_id),
    ideaIndex: Number(row.idea_index),
    model: String(row.video_model || "d2"),
    videoModel: String(row.video_model || "d2"),
    mode: String(row.mode || "text"),
    resolution: String(row.resolution || "720p"),
    aspectRatio: String(row.aspect_ratio || "9:16"),
    totalDurationSec: Number(row.total_duration_sec),
    status: String(row.status || "preparing"),
    referenceAssetIds: safeParseArray(row.reference_asset_ids_json),
    visualBible: parseJsonObject(row.visual_bible_json),
    script: parseJsonObject(row.script_json),
    estimatedCredits: Number(row.estimated_credits || 0),
    chargedCredits: Number(row.charged_credits || 0),
    refundedCredits: Number(row.refunded_credits || 0),
    creditEventId: row.credit_event_id == null ? null : Number(row.credit_event_id),
    finalVideo: parseJsonObject(row.final_video_json),
    error: String(row.error || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    clips: clips || undefined,
  };
}

function getProjectRow(projectId, ownerUserId = null) {
  const where = ownerUserId == null ? "id = ?" : "id = ? AND owner_user_id = ?";
  const params = ownerUserId == null ? [Number(projectId)] : [Number(projectId), Number(ownerUserId)];
  return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM video_projects WHERE ${where}`).get(...params) || null;
}

function getProject(projectId, options = {}) {
  const row = getProjectRow(projectId, options.ownerUserId);
  if (!row) return null;
  const clips = db.prepare(`
    SELECT ${CLIP_COLUMNS}
    FROM video_clips
    WHERE project_id = ?
    ORDER BY clip_index ASC
  `).all(Number(row.id)).map(mapClipRow);
  return mapProjectRow(row, clips);
}

function findProjectByOwnerAndRequestId(ownerUserId, requestId) {
  const row = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE owner_user_id = ? AND request_id = ?
    LIMIT 1
  `).get(Number(ownerUserId), String(requestId || "").trim());
  return row ? mapProjectRow(row) : null;
}

function findProjectByGenerationId(generationId, ownerUserId = null) {
  const row = ownerUserId == null
    ? db.prepare(`SELECT ${PROJECT_COLUMNS} FROM video_projects WHERE generation_id = ?`).get(Number(generationId))
    : db.prepare(`SELECT ${PROJECT_COLUMNS} FROM video_projects WHERE generation_id = ? AND owner_user_id = ?`).get(Number(generationId), Number(ownerUserId));
  return row ? mapProjectRow(row) : null;
}

function listProjectsByOwner(ownerUserId, { activeOnly = false, limit = 100 } = {}) {
  const statuses = ["preparing", "queued", "running", "partial_failed", "failed", "completed", "cancelled"];
  const activeStatuses = statuses.slice(0, 4);
  const where = activeOnly ? `AND status IN (${activeStatuses.map(() => "?").join(",")})` : "";
  const params = activeOnly ? [Number(ownerUserId), ...activeStatuses, Math.max(1, Number(limit) || 100)] : [Number(ownerUserId), Math.max(1, Number(limit) || 100)];
  const rows = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE owner_user_id = ? ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params);
  return rows.map((row) => mapProjectRow(row));
}

function listRecoverableProjects({ limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE status IN ('preparing', 'queued', 'running', 'partial_failed')
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 100));
  return rows.map((row) => mapProjectRow(row));
}

function insertProject(input) {
  const now = input.createdAt || nowIso();
  const id = input.id ?? allocateCounter("nextVideoProjectId", 1);
  db.prepare(`
    INSERT INTO video_projects (
      id, owner_user_id, generation_id, request_id, brand_id, trend_id, idea_index,
      video_model, mode, resolution, aspect_ratio, total_duration_sec, status,
      reference_asset_ids_json, visual_bible_json, script_json, estimated_credits,
      charged_credits, refunded_credits, credit_event_id, final_video_json, error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(id), Number(input.ownerUserId), Number(input.generationId), String(input.requestId),
    Number(input.brandId), Number(input.trendId), Number(input.ideaIndex), String(input.model || "d2"),
    String(input.mode || "text"), String(input.resolution || "720p"), String(input.aspectRatio || "9:16"),
    Number(input.totalDurationSec), String(input.status || "preparing"), JSON.stringify(input.referenceAssetIds || []),
    JSON.stringify(input.visualBible || {}), JSON.stringify(input.script || {}), Number(input.estimatedCredits || 0),
    Number(input.chargedCredits || 0), Number(input.refundedCredits || 0), input.creditEventId ?? null,
    JSON.stringify(input.finalVideo || {}), String(input.error || ""), now, now,
  );
  return getProject(id);
}

function insertClip(input) {
  const now = input.createdAt || nowIso();
  const id = input.id ?? allocateCounter("nextVideoClipId", 1);
  db.prepare(`
    INSERT INTO video_clips (
      id, project_id, clip_index, start_sec, end_sec, duration_sec, status,
      depends_on_clip_index, prompt, provider, provider_task_id, continuity_mode,
      reference_asset_ids_json, continuity_state_json, output_video_json,
      continuity_frame_json, credit_cost, attempt, retry_count, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(id), Number(input.projectId), Number(input.clipIndex), Number(input.startSec), Number(input.endSec),
    Number(input.durationSec), String(input.status || "waiting_dependency"), input.dependsOnClipIndex ?? null,
    String(input.prompt || ""), String(input.provider || ""), String(input.providerTaskId || ""),
    String(input.continuityMode || ""), JSON.stringify(input.referenceAssetIds || []),
    JSON.stringify(input.continuityState || {}), JSON.stringify(input.outputVideo || {}),
    JSON.stringify(input.continuityFrame || {}), Number(input.creditCost || 0), Number(input.attempt || 0),
    Number(input.retryCount || 0), String(input.error || ""), now, now,
  );
  return getClip(id);
}

function getClip(clipId, ownerUserId = null) {
  const row = ownerUserId == null
    ? db.prepare(`SELECT ${CLIP_COLUMNS} FROM video_clips WHERE id = ?`).get(Number(clipId))
    : db.prepare(`
      SELECT ${CLIP_COLUMNS}
      FROM video_clips
      JOIN video_projects ON video_projects.id = video_clips.project_id
      WHERE video_clips.id = ? AND video_projects.owner_user_id = ?
    `).get(Number(clipId), Number(ownerUserId));
  return mapClipRow(row);
}

function listClips(projectId) {
  return db.prepare(`
    SELECT ${CLIP_COLUMNS}
    FROM video_clips
    WHERE project_id = ?
    ORDER BY clip_index ASC
  `).all(Number(projectId)).map(mapClipRow);
}

function updateProject(projectId, patch = {}) {
  const existing = getProject(projectId);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE video_projects SET
      status = ?, reference_asset_ids_json = ?, visual_bible_json = ?, script_json = ?,
      estimated_credits = ?, charged_credits = ?, refunded_credits = ?, credit_event_id = ?,
      final_video_json = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(next.status || existing.status), JSON.stringify(next.referenceAssetIds || existing.referenceAssetIds || []),
    JSON.stringify(next.visualBible || existing.visualBible || {}), JSON.stringify(next.script || existing.script || {}),
    Number(next.estimatedCredits ?? existing.estimatedCredits ?? 0), Number(next.chargedCredits ?? existing.chargedCredits ?? 0),
    Number(next.refundedCredits ?? existing.refundedCredits ?? 0), next.creditEventId ?? existing.creditEventId ?? null,
    JSON.stringify(next.finalVideo || existing.finalVideo || {}), String(next.error ?? existing.error ?? ""), updatedAt,
    Number(projectId),
  );
  return getProject(projectId);
}

function updateClip(clipId, patch = {}) {
  const existing = getClip(clipId);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  db.prepare(`
    UPDATE video_clips SET
      status = ?, depends_on_clip_index = ?, prompt = ?, provider = ?, provider_task_id = ?,
      continuity_mode = ?, reference_asset_ids_json = ?, continuity_state_json = ?,
      output_video_json = ?, continuity_frame_json = ?, credit_cost = ?, attempt = ?,
      retry_count = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(next.status || existing.status), next.dependsOnClipIndex ?? null, String(next.prompt ?? (existing.prompt || "")),
    String(next.provider ?? (existing.provider || "")), String(next.providerTaskId ?? (existing.providerTaskId || "")),
    String(next.continuityMode ?? (existing.continuityMode || "")), JSON.stringify(next.referenceAssetIds || existing.referenceAssetIds || []),
    JSON.stringify(next.continuityState || existing.continuityState || {}), JSON.stringify(next.outputVideo || existing.outputVideo || {}),
    JSON.stringify(next.continuityFrame || existing.continuityFrame || {}), Number(next.creditCost ?? existing.creditCost ?? 0),
    Number(next.attempt ?? existing.attempt ?? 0), Number(next.retryCount ?? existing.retryCount ?? 0),
    String(next.error ?? existing.error ?? ""), nowIso(), Number(clipId),
  );
  return getClip(clipId);
}

function updateClipByProjectIndex(projectId, clipIndex, patch = {}) {
  const row = db.prepare(`SELECT id FROM video_clips WHERE project_id = ? AND clip_index = ?`).get(Number(projectId), Number(clipIndex));
  return row ? updateClip(row.id, patch) : null;
}

function createProjectWithClips(project, clips) {
  return runTransaction(() => {
    const created = insertProject(project);
    const createdClips = clips.map((clip) => insertClip({ ...clip, projectId: created.id }));
    return getProject(created.id, { ownerUserId: created.ownerUserId, clips: createdClips });
  });
}

module.exports = {
  PROJECT_COLUMNS,
  CLIP_COLUMNS,
  mapProjectRow,
  mapClipRow,
  getProject,
  findProjectByOwnerAndRequestId,
  findProjectByGenerationId,
  listProjectsByOwner,
  listRecoverableProjects,
  insertProject,
  insertClip,
  getClip,
  listClips,
  updateProject,
  updateClip,
  updateClipByProjectIndex,
  createProjectWithClips,
};
