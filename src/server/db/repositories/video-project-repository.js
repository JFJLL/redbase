const { getDbProxy } = require("../connection");
const { safeParseArray, safeParseObject } = require("../snapshot-utils");
const { allocateCounter, runTransaction } = require("./core-repository");
const { findGenerationById, upsertGeneration } = require("./generation-repository");
const { findUserById } = require("./auth-repository");
const { spendCreditsWithEventInTransaction } = require("./admin-repository");
const {
  recordVideoProjectCreated,
  recordVideoProjectCompleted,
  recordVideoProjectFailed,
  recordOutputCompleted,
} = require("../../analytics/analytics-recorder");
const {
  ACTIVE_PROJECT_STATUSES,
  RECOVERABLE_PROJECT_STATUSES,
  TERMINAL_PROJECT_STATUSES,
} = require("../../video/video-project-statuses");

const db = getDbProxy();

const PROJECT_COLUMNS = `
  id, owner_user_id, generation_id, request_id, brand_id, trend_id, idea_index,
  video_model, mode, resolution, aspect_ratio, total_duration_sec, status,
  reference_asset_ids_json, visual_bible_json, script_json, estimated_credits,
  charged_credits, refunded_credits, credit_event_id, script_generation_id,
  input_assets_json, assembly_request_id, assembly_attempt, final_video_json, error,
  started_at, completed_at, failed_at, assembly_started_at, assembly_completed_at,
  asset_status, asset_count, asset_bytes, assets_deleted_at,
  created_at, updated_at
`;

const CLIP_COLUMNS = `
  id, project_id, clip_index, start_sec, end_sec, duration_sec, status,
  depends_on_clip_index, prompt, provider, provider_task_id, continuity_mode,
  reference_asset_ids_json, continuity_state_json, output_video_json,
  continuity_frame_json, credit_cost, attempt, retry_count, provider_key_ref,
  reservation_credit_event_id, submission_attempt, last_successful_poll_at,
  poll_failure_count, error, result_processing_failure_count,
  last_result_processing_error, last_result_processing_at,
  first_submitted_at, completed_at, failed_at, asset_status, asset_bytes, assets_deleted_at,
  created_at, updated_at
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
    providerKeyRef: String(row.provider_key_ref || ""),
    reservationCreditEventId: row.reservation_credit_event_id == null ? null : Number(row.reservation_credit_event_id),
    submissionAttempt: Number(row.submission_attempt || 0),
    lastSuccessfulPollAt: String(row.last_successful_poll_at || ""),
    pollFailureCount: Number(row.poll_failure_count || 0),
    error: String(row.error || ""),
    resultProcessingFailureCount: Number(row.result_processing_failure_count || 0),
    lastResultProcessingError: String(row.last_result_processing_error || ""),
    lastResultProcessingAt: String(row.last_result_processing_at || ""),
    firstSubmittedAt: String(row.first_submitted_at || ""),
    completedAt: String(row.completed_at || ""),
    failedAt: String(row.failed_at || ""),
    assetStatus: String(row.asset_status || "available"),
    assetBytes: Number(row.asset_bytes || 0),
    assetsDeletedAt: String(row.assets_deleted_at || ""),
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
    scriptGenerationId: row.script_generation_id == null ? null : Number(row.script_generation_id),
    inputAssets: safeParseArray(row.input_assets_json),
    assemblyRequestId: String(row.assembly_request_id || ""),
    assemblyAttempt: Number(row.assembly_attempt || 0),
    finalVideo: parseJsonObject(row.final_video_json),
    error: String(row.error || ""),
    startedAt: String(row.started_at || ""),
    completedAt: String(row.completed_at || ""),
    failedAt: String(row.failed_at || ""),
    assemblyStartedAt: String(row.assembly_started_at || ""),
    assemblyCompletedAt: String(row.assembly_completed_at || ""),
    assetStatus: String(row.asset_status || "available"),
    assetCount: Number(row.asset_count || 0),
    assetBytes: Number(row.asset_bytes || 0),
    assetsDeletedAt: String(row.assets_deleted_at || ""),
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

function findActiveProjectByContext({ ownerUserId, brandId, trendId, ideaIndex } = {}) {
  const activeStatuses = [...ACTIVE_PROJECT_STATUSES];
  const row = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE owner_user_id = ?
      AND brand_id = ?
      AND trend_id = ?
      AND idea_index = ?
      AND status IN (${activeStatuses.map(() => '?').join(',')})
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(Number(ownerUserId), Number(brandId), Number(trendId), Number(ideaIndex), ...activeStatuses);
  return row ? mapProjectRow(row) : null;
}

function findProjectByGenerationId(generationId, ownerUserId = null) {
  const row = ownerUserId == null
    ? db.prepare(`SELECT ${PROJECT_COLUMNS} FROM video_projects WHERE generation_id = ?`).get(Number(generationId))
    : db.prepare(`SELECT ${PROJECT_COLUMNS} FROM video_projects WHERE generation_id = ? AND owner_user_id = ?`).get(Number(generationId), Number(ownerUserId));
  return row ? mapProjectRow(row) : null;
}

function listProjectsByOwner(ownerUserId, { activeOnly = false, limit = 100, brandId, trendId, ideaIndex } = {}) {
  const activeStatuses = [...ACTIVE_PROJECT_STATUSES];
  const conditions = [];
  const params = [Number(ownerUserId)];
  if (activeOnly) {
    conditions.push(`status IN (${activeStatuses.map(() => "?").join(",")})`);
    params.push(...activeStatuses);
  }
  if (brandId != null && Number.isSafeInteger(Number(brandId)) && Number(brandId) > 0) {
    conditions.push("brand_id = ?");
    params.push(Number(brandId));
  }
  if (trendId != null && Number.isSafeInteger(Number(trendId)) && Number(trendId) > 0) {
    conditions.push("trend_id = ?");
    params.push(Number(trendId));
  }
  if (ideaIndex != null && Number.isSafeInteger(Number(ideaIndex)) && Number(ideaIndex) >= 0) {
    conditions.push("idea_index = ?");
    params.push(Number(ideaIndex));
  }
  const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";
  params.push(Math.max(1, Number(limit) || 100));
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
  const recoverableStatuses = [...RECOVERABLE_PROJECT_STATUSES];
  const rows = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE status IN (${recoverableStatuses.map(() => '?').join(',')})
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).all(...recoverableStatuses, Math.max(1, Number(limit) || 100));
  return rows.map((row) => mapProjectRow(row));
}

function listProjectsForRefundReconciliation({ limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT ${PROJECT_COLUMNS}
    FROM video_projects
    WHERE status IN ('partial_failed', 'uncertain', 'failed', 'completed', 'assembly_failed', 'project_data_failed')
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 100));
  return rows.map((row) => mapProjectRow(row));
}

const BILLING_COLUMNS = `
  id, request_id, user_id, project_id, generation_id, operation, status,
  credit_cost, credit_event_id, error, input_signature, clip_index, created_at, updated_at
`;

function mapBillingRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    requestId: String(row.request_id || ""),
    userId: Number(row.user_id),
    projectId: Number(row.project_id),
    generationId: Number(row.generation_id),
    operation: String(row.operation || "create"),
    status: String(row.status || "reserved"),
    creditCost: Number(row.credit_cost || 0),
    creditEventId: row.credit_event_id == null ? null : Number(row.credit_event_id),
    error: String(row.error || ""),
    inputSignature: String(row.input_signature || ""),
    clipIndex: row.clip_index == null ? null : Number(row.clip_index),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function findVideoBillingRequestByOwnerRequestId(ownerUserId, requestId) {
  const row = db.prepare(`
    SELECT ${BILLING_COLUMNS}
    FROM video_project_billing_requests
    WHERE user_id = ? AND request_id = ?
    LIMIT 1
  `).get(Number(ownerUserId), String(requestId || "").trim());
  return mapBillingRow(row);
}

function insertVideoBillingRequest(input) {
  const now = input.createdAt || nowIso();
  const id = input.id ?? allocateCounter("nextVideoBillingReservationId", 1);
  db.prepare(`
    INSERT INTO video_project_billing_requests (
      id, request_id, user_id, project_id, generation_id, operation, status,
      credit_cost, credit_event_id, error, input_signature, clip_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
    Number(id), String(input.requestId || ""), Number(input.userId), Number(input.projectId),
    Number(input.generationId), String(input.operation || "create"), String(input.status || "reserved"),
    Number(input.creditCost || 0), input.creditEventId ?? null, String(input.error || ""),
    String(input.inputSignature || ""), input.clipIndex == null ? null : Number(input.clipIndex), now, now,
  );
  return mapBillingRow(db.prepare(`SELECT ${BILLING_COLUMNS} FROM video_project_billing_requests WHERE id = ?`).get(Number(id)));
}

function updateVideoBillingRequest(id, patch = {}) {
  const current = mapBillingRow(db.prepare(`SELECT ${BILLING_COLUMNS} FROM video_project_billing_requests WHERE id = ?`).get(Number(id)));
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`
    UPDATE video_project_billing_requests
    SET status = ?, credit_cost = ?, credit_event_id = ?, error = ?, input_signature = ?, clip_index = ?, updated_at = ?
    WHERE id = ?
  `).run(String(next.status), Number(next.creditCost || 0), next.creditEventId ?? null, String(next.error || ""), String(next.inputSignature || ""), next.clipIndex == null ? null : Number(next.clipIndex), nowIso(), Number(id));
  return mapBillingRow(db.prepare(`SELECT ${BILLING_COLUMNS} FROM video_project_billing_requests WHERE id = ?`).get(Number(id)));
}

function createProjectWithBilling({ project, clips, generation, billing, preventDuplicateActiveProject = true }) {
  return runTransaction(() => {
    const existing = findProjectByOwnerAndRequestId(project.ownerUserId, project.requestId);
    if (existing) {
      const match = (project.brandId == null || Number(existing.brandId) === Number(project.brandId)) &&
        (project.trendId == null || Number(existing.trendId) === Number(project.trendId)) &&
        (project.ideaIndex == null || Number(existing.ideaIndex) === Number(project.ideaIndex)) &&
        (project.scriptGenerationId == null || Number(existing.scriptGenerationId) === Number(project.scriptGenerationId)) &&
        (project.model == null || String(existing.model || "").toLowerCase() === String(project.model).toLowerCase()) &&
        (project.mode == null || String(existing.mode || "").toLowerCase() === String(project.mode).toLowerCase()) &&
        (project.resolution == null || String(existing.resolution || "") === String(project.resolution)) &&
        (project.aspectRatio == null || String(existing.aspectRatio || "") === String(project.aspectRatio)) &&
        (project.totalDurationSec == null || Number(existing.totalDurationSec) === Number(project.totalDurationSec));

      if (!match) {
        const error = new Error("视频项目请求已被使用但参数不一致");
        error.code = "VIDEO_IDEMPOTENCY_CONFLICT";
        throw error;
      }
      const existingProject = getProject(existing.id, { ownerUserId: project.ownerUserId });
      return {
        reused: true,
        project: existingProject,
        generation: existingProject ? findGenerationById(existingProject.generationId) : null,
        user: findUserById(project.ownerUserId),
        billingRequest: findVideoBillingRequestByOwnerRequestId(project.ownerUserId, project.requestId),
      };
    }
    if (preventDuplicateActiveProject) {
      const active = findActiveProjectByContext(project);
      if (active) {
        return {
          reused: true,
          project: getProject(active.id, { ownerUserId: project.ownerUserId }),
          generation: findGenerationById(active.generationId),
          user: findUserById(project.ownerUserId),
          billingRequest: findVideoBillingRequestByOwnerRequestId(project.ownerUserId, active.requestId),
        };
      }
    }

    const projectId = project.id ?? allocateCounter("nextVideoProjectId", 1);
    const generationId = project.generationId ?? generation?.id ?? allocateCounter("nextGenerationId", 1);
    const createdGeneration = upsertGeneration({ ...generation, id: generationId });
    if (!createdGeneration) throw new Error("视频脚本生成记录创建失败");
    const createdProject = insertProject({ ...project, id: projectId, generationId, creditEventId: null });
    if (!createdProject) throw new Error("视频项目创建失败");
    const createdClips = (clips || []).map((clip) => insertClip({ ...clip, projectId, reservationCreditEventId: null }));

    const charged = spendCreditsWithEventInTransaction({
      userId: project.ownerUserId,
      amount: billing.creditCost,
      event: {
        ...(billing.event || {}),
        generationId,
        payload: { ...(billing.event?.payload || {}), projectId, generationId, requestId: project.requestId },
      },
    });
    if (!charged?.spent || !charged.creditEvent?.id) {
      const error = new Error("积分不足或扣除失败");
      error.code = "INSUFFICIENT_CREDITS";
      throw error;
    }

    const reservation = insertVideoBillingRequest({
      requestId: project.requestId,
      userId: project.ownerUserId,
      projectId,
      generationId,
      operation: "create",
      status: "reserved",
      creditCost: billing.creditCost,
      creditEventId: charged.creditEvent.id,
    });
    if (!reservation) throw new Error("视频计费 reservation 创建失败");
    updateProject(projectId, { creditEventId: charged.creditEvent.id, chargedCredits: billing.creditCost });
    for (const clip of createdClips) updateClip(clip.id, { reservationCreditEventId: charged.creditEvent.id });
    updateVideoBillingRequest(reservation.id, { status: "committed" });
    const finalProject = getProject(projectId, { ownerUserId: project.ownerUserId });
    try {
      recordVideoProjectCreated({
        projectId,
        userId: project.ownerUserId,
        model: project.model,
        mode: project.mode,
        resolution: project.resolution,
        aspectRatio: project.aspectRatio,
        totalDurationSec: project.totalDurationSec,
        estimatedCredits: billing.creditCost,
        createdAt: finalProject.createdAt,
      });
    } catch (_) {}
    return {
      reused: false,
      project: finalProject,
      generation: findGenerationById(generationId),
      user: findUserById(project.ownerUserId),
      billingRequest: findVideoBillingRequestByOwnerRequestId(project.ownerUserId, project.requestId),
    };
  });
}

function retryProjectWithBilling({ projectId, ownerUserId, clipIndex, requestId, creditCost, prompt, allowCompleted = false, event }) {
  return runTransaction(() => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      const error = new Error("缺少视频重试 requestId");
      error.code = "VIDEO_REQUEST_ID_REQUIRED";
      throw error;
    }
    const existingReservation = findVideoBillingRequestByOwnerRequestId(ownerUserId, normalizedRequestId);
    if (existingReservation) {
      if (existingReservation.operation !== "retry" ||
          Number(existingReservation.projectId) !== Number(projectId) ||
          (existingReservation.clipIndex != null && Number(existingReservation.clipIndex) !== Number(clipIndex))) {
        const error = new Error("视频重试请求已被使用但参数不一致");
        error.code = "VIDEO_IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return {
        reused: true,
        project: getProject(existingReservation.projectId, { ownerUserId }),
        user: findUserById(ownerUserId),
        billingRequest: existingReservation,
      };
    }
    const project = getProject(projectId, { ownerUserId });
    if (!project) {
      const error = new Error("视频项目不存在");
      error.code = "VIDEO_PROJECT_NOT_FOUND";
      throw error;
    }
    const target = project.clips.find((clip) => clip.index === Number(clipIndex));
    if (!target) {
      const error = new Error("视频镜头不存在");
      error.code = "VIDEO_CLIP_NOT_FOUND";
      throw error;
    }
    const regeneratingCompletedClip = allowCompleted && target.status === "completed";
    if (!["failed", "uncertain_submission", "cancelled"].includes(target.status) && !regeneratingCompletedClip) {
      const error = new Error("只有已完成、失败、待确认或已取消的镜头才能重新生成");
      error.code = "VIDEO_CLIP_RETRY_NOT_ALLOWED";
      throw error;
    }
    const targetDependency = target.dependsOnClipIndex == null
      ? null
      : project.clips.find((clip) => clip.index === target.dependsOnClipIndex);
    if (targetDependency && targetDependency.status !== "completed") {
      const error = new Error("请先完成前置镜头后再重试当前镜头");
      error.code = "VIDEO_CLIP_RETRY_NOT_ALLOWED";
      throw error;
    }
    const retryableClips = regeneratingCompletedClip
      ? [target]
      : project.clips.filter((clip) => clip.index >= target.index && clip.status !== "completed");
    const cost = Number(creditCost || retryableClips.reduce((sum, clip) => sum + Number(clip.creditCost || 0), 0));
    if (!Number.isFinite(cost) || cost <= 0) {
      const error = new Error("没有需要重新计费的镜头");
      error.code = "VIDEO_CLIP_RETRY_NOT_NEEDED";
      throw error;
    }
    const charged = spendCreditsWithEventInTransaction({
      userId: ownerUserId,
      amount: cost,
      event: {
        ...(event || {}),
        generationId: project.generationId,
        payload: { ...(event?.payload || {}), projectId: project.id, clipIndex: target.index, requestId: normalizedRequestId },
      },
    });
    if (!charged?.spent || !charged.creditEvent?.id) {
      const error = new Error("积分不足，无法重试剩余镜头");
      error.code = "INSUFFICIENT_CREDITS";
      throw error;
    }
    const reservation = insertVideoBillingRequest({
      requestId: normalizedRequestId,
      userId: ownerUserId,
      projectId: project.id,
      generationId: project.generationId,
      operation: "retry",
      status: "reserved",
      creditCost: cost,
      creditEventId: charged.creditEvent.id,
      clipIndex: target.index,
    });
    if (!reservation) throw new Error("视频重试计费 reservation 创建失败");
    for (const clip of retryableClips) {
      const dependency = clip.dependsOnClipIndex == null ? null : project.clips.find((item) => item.index === clip.dependsOnClipIndex);
      updateClip(clip.id, {
        status: clip.index === target.index && (!dependency || dependency.status === "completed") ? "queued" : "waiting_dependency",
        providerTaskId: "",
        providerKeyRef: "",
        outputVideo: {},
        continuityFrame: {},
        prompt: clip.index === target.index && String(prompt || "").trim() ? String(prompt).trim() : clip.prompt,
        error: "",
        retryCount: Number(clip.retryCount || 0) + (clip.index === target.index ? 1 : 0),
        reservationCreditEventId: charged.creditEvent.id,
        pollFailureCount: 0,
        lastSuccessfulPollAt: "",
      });
    }
    updateProject(project.id, {
      status: "queued",
      error: "",
      finalVideo: {},
      chargedCredits: project.chargedCredits + cost,
    });
    updateVideoBillingRequest(reservation.id, { status: "committed" });
    return {
      reused: false,
      project: getProject(project.id, { ownerUserId }),
      user: findUserById(ownerUserId),
      billingRequest: findVideoBillingRequestByOwnerRequestId(ownerUserId, normalizedRequestId),
    };
  });
}

function claimVideoResultRetry({ userId, requestId, projectId, clipIndex }) {
  return runTransaction(() => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      const error = new Error("缺少结果重试 requestId");
      error.code = "VIDEO_REQUEST_ID_REQUIRED";
      throw error;
    }
    const existingReservation = findVideoBillingRequestByOwnerRequestId(userId, normalizedRequestId);
    if (existingReservation) {
      if (existingReservation.operation !== "retry_result" ||
          Number(existingReservation.projectId) !== Number(projectId) ||
          (existingReservation.clipIndex != null && Number(existingReservation.clipIndex) !== Number(clipIndex))) {
        const error = new Error("结果重试请求已被使用但参数不一致");
        error.code = "VIDEO_IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return {
        reused: true,
        project: getProject(existingReservation.projectId, { ownerUserId: userId }),
        user: findUserById(userId),
        billingRequest: existingReservation,
      };
    }
    const project = getProject(projectId, { ownerUserId: userId });
    if (!project) {
      const error = new Error("视频项目不存在");
      error.code = "VIDEO_PROJECT_NOT_FOUND";
      throw error;
    }
    const clip = project.clips.find((candidate) => candidate.index === Number(clipIndex));
    if (!clip) {
      const error = new Error("视频镜头不存在");
      error.code = "VIDEO_CLIP_NOT_FOUND";
      throw error;
    }
    if (clip.status === "completed") {
      return {
        reused: true,
        project,
        user: findUserById(userId),
        billingRequest: null,
      };
    }
    if (!["result_processing_failed", "processing_result"].includes(clip.status)) {
      const error = new Error("当前镜头状态不支持重新处理结果");
      error.code = "VIDEO_CLIP_RETRY_RESULT_NOT_ALLOWED";
      throw error;
    }
    const reservation = insertVideoBillingRequest({
      requestId: normalizedRequestId,
      userId,
      projectId: project.id,
      generationId: project.generationId,
      operation: "retry_result",
      status: "committed",
     creditCost: 0,
     creditEventId: null,
     clipIndex: clip.index,
   });
   updateClip(clip.id, {
     status: "processing_result",
     resultProcessingFailureCount: 0,
     lastResultProcessingError: "",
     error: "",
   });
   updateProject(project.id, {
      status: "processing_result",
     error: "",
   });
   return {
      reused: false,
      project: getProject(projectId, { ownerUserId: userId }),
      user: findUserById(userId),
      billingRequest: reservation,
    };
  });
}

function claimAssemblyRetry({ projectId, ownerUserId, requestId }) {
  return runTransaction(() => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      const error = new Error("缺少成片拼接 requestId");
      error.code = "VIDEO_REQUEST_ID_REQUIRED";
      throw error;
    }
    const project = getProject(projectId, { ownerUserId });
    if (!project) {
      const error = new Error("视频项目不存在");
      error.code = "VIDEO_PROJECT_NOT_FOUND";
      throw error;
    }
    if (project.status === "completed") return { shouldRun: false, project };
    if (project.status === "assembling") return { shouldRun: false, project };
    if (project.status !== "assembly_failed") {
      const error = new Error("只有最终成片拼接失败的项目才能重新拼接");
      error.code = "VIDEO_ASSEMBLY_RETRY_NOT_ALLOWED";
      throw error;
    }
    if (!(project.clips || []).length || !(project.clips || []).every((clip) => clip.status === "completed")) {
      const error = new Error("所有视频片段完成后才能重新拼接");
      error.code = "VIDEO_ASSEMBLY_RETRY_NOT_ALLOWED";
      throw error;
    }
    if (project.assemblyRequestId && project.assemblyRequestId === normalizedRequestId) {
      return { shouldRun: false, project };
    }
    const next = updateProject(project.id, {
      status: "assembling",
      assemblyRequestId: normalizedRequestId,
      assemblyAttempt: project.assemblyAttempt + 1,
      error: "",
    });
    return { shouldRun: true, project: next };
  });
}

function claimAssemblyStart(projectId) {
  return runTransaction(() => {
    const project = getProject(projectId);
    if (!project) return { shouldRun: false, project: null };
    if (project.status === "completed" || project.status === "assembling" || project.status === "assembly_failed") {
      return { shouldRun: false, project };
    }
    if (!(project.clips || []).length || !(project.clips || []).every((clip) => clip.status === "completed")) {
      return { shouldRun: false, project };
    }
    const result = db.prepare(`
      UPDATE video_projects
      SET status = 'assembling', assembly_attempt = assembly_attempt + 1, error = '', updated_at = ?
      WHERE id = ? AND status IN ('preparing', 'queued', 'running', 'processing_result', 'partial_failed')
    `).run(nowIso(), Number(projectId));
    return {
      shouldRun: result.changes === 1,
      project: getProject(projectId),
    };
  });
}

function insertProject(input) {
  const now = input.createdAt || nowIso();
  const id = input.id ?? allocateCounter("nextVideoProjectId", 1);
  db.prepare(`
    INSERT INTO video_projects (
      id, owner_user_id, generation_id, request_id, brand_id, trend_id, idea_index,
      video_model, mode, resolution, aspect_ratio, total_duration_sec, status,
      reference_asset_ids_json, visual_bible_json, script_json, estimated_credits,
      charged_credits, refunded_credits, credit_event_id, script_generation_id,
      input_assets_json, assembly_request_id, assembly_attempt, final_video_json, error,
      started_at, completed_at, failed_at, assembly_started_at, assembly_completed_at,
      asset_status, asset_count, asset_bytes, assets_deleted_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    Number(id), Number(input.ownerUserId), Number(input.generationId), String(input.requestId),
    Number(input.brandId), Number(input.trendId), Number(input.ideaIndex), String(input.model || "d2"),
    String(input.mode || "text"), String(input.resolution || "720p"), String(input.aspectRatio || "9:16"),
    Number(input.totalDurationSec), String(input.status || "preparing"), JSON.stringify(input.referenceAssetIds || []),
    JSON.stringify(input.visualBible || {}), JSON.stringify(input.script || {}), Number(input.estimatedCredits || 0),
    Number(input.chargedCredits || 0), Number(input.refundedCredits || 0), input.creditEventId ?? null,
    input.scriptGenerationId ?? null, JSON.stringify(input.inputAssets || []), String(input.assemblyRequestId || ""),
    Number(input.assemblyAttempt || 0), JSON.stringify(input.finalVideo || {}), String(input.error || ""),
    String(input.startedAt || ""), String(input.completedAt || ""), String(input.failedAt || ""),
    String(input.assemblyStartedAt || ""), String(input.assemblyCompletedAt || ""),
    String(input.assetStatus || "available"), Number(input.assetCount || 0), Number(input.assetBytes || 0),
    String(input.assetsDeletedAt || ""), now, now,
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
      continuity_frame_json, credit_cost, attempt, retry_count, provider_key_ref,
      reservation_credit_event_id, submission_attempt, last_successful_poll_at,
      poll_failure_count, error, result_processing_failure_count,
      last_result_processing_error, last_result_processing_at,
      first_submitted_at, completed_at, failed_at, asset_status, asset_bytes, assets_deleted_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    Number(id), Number(input.projectId), Number(input.clipIndex), Number(input.startSec), Number(input.endSec),
    Number(input.durationSec), String(input.status || "waiting_dependency"), input.dependsOnClipIndex ?? null,
    String(input.prompt || ""), String(input.provider || ""), String(input.providerTaskId || ""),
    String(input.continuityMode || ""), JSON.stringify(input.referenceAssetIds || []),
    JSON.stringify(input.continuityState || {}), JSON.stringify(input.outputVideo || {}),
    JSON.stringify(input.continuityFrame || {}), Number(input.creditCost || 0), Number(input.attempt || 0),
    Number(input.retryCount || 0), String(input.providerKeyRef || ""), input.reservationCreditEventId ?? null,
    Number(input.submissionAttempt || 0), String(input.lastSuccessfulPollAt || ""), Number(input.pollFailureCount || 0),
    String(input.error || ""), Number(input.resultProcessingFailureCount || 0),
    String(input.lastResultProcessingError || ""), String(input.lastResultProcessingAt || ""),
    String(input.firstSubmittedAt || ""), String(input.completedAt || ""), String(input.failedAt || ""),
    String(input.assetStatus || "available"), Number(input.assetBytes || 0), String(input.assetsDeletedAt || ""),
    now, now,
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
      script_generation_id = ?, input_assets_json = ?, assembly_request_id = ?, assembly_attempt = ?,
      final_video_json = ?, error = ?,
      started_at = ?, completed_at = ?, failed_at = ?, assembly_started_at = ?, assembly_completed_at = ?,
      asset_status = ?, asset_count = ?, asset_bytes = ?, assets_deleted_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    String(next.status || existing.status), JSON.stringify(next.referenceAssetIds || existing.referenceAssetIds || []),
    JSON.stringify(next.visualBible || existing.visualBible || {}), JSON.stringify(next.script || existing.script || {}),
    Number(next.estimatedCredits ?? existing.estimatedCredits ?? 0), Number(next.chargedCredits ?? existing.chargedCredits ?? 0),
    Number(next.refundedCredits ?? existing.refundedCredits ?? 0), next.creditEventId ?? existing.creditEventId ?? null,
    next.scriptGenerationId ?? existing.scriptGenerationId ?? null, JSON.stringify(next.inputAssets || existing.inputAssets || []),
    String(next.assemblyRequestId ?? existing.assemblyRequestId ?? ""), Number(next.assemblyAttempt ?? existing.assemblyAttempt ?? 0),
    JSON.stringify(next.finalVideo || existing.finalVideo || {}), String(next.error ?? existing.error ?? ""),
    String(next.startedAt ?? existing.startedAt ?? ""), String(next.completedAt ?? existing.completedAt ?? ""),
    String(next.failedAt ?? existing.failedAt ?? ""), String(next.assemblyStartedAt ?? existing.assemblyStartedAt ?? ""),
    String(next.assemblyCompletedAt ?? existing.assemblyCompletedAt ?? ""),
    String(next.assetStatus ?? existing.assetStatus ?? "available"), Number(next.assetCount ?? existing.assetCount ?? 0),
    Number(next.assetBytes ?? existing.assetBytes ?? 0), String(next.assetsDeletedAt ?? existing.assetsDeletedAt ?? ""),
    updatedAt,
    Number(projectId),
  );
  if (patch.status === "completed") {
    try {
      const userRow = db.prepare("SELECT account_type FROM users WHERE id = ?").get(next.ownerUserId);
      const completedAt = next.completedAt || updatedAt;
      recordVideoProjectCompleted({
        projectId,
        userId: next.ownerUserId,
        model: next.model,
        mode: next.mode,
        resolution: next.resolution,
        aspectRatio: next.aspectRatio,
        totalDurationSec: next.totalDurationSec,
        chargedCredits: next.chargedCredits,
        refundedCredits: next.refundedCredits,
        durationMs: next.startedAt ? Math.max(0, Date.now() - Date.parse(next.startedAt)) : 0,
        completedAt,
      });
      recordOutputCompleted({
        eventKey: `output_completed:video:${projectId}`,
        generationId: next.generationId,
        userId: next.ownerUserId,
        accountType: userRow?.account_type || "customer",
        type: "videoProject",
        model: next.model,
        creditCost: Number(next.chargedCredits || 0) - Number(next.refundedCredits || 0),
        completedAt,
      });
    } catch (_) {}
  } else if (["failed", "project_data_failed"].includes(patch.status)) {
    try {
      recordVideoProjectFailed({
        projectId,
        userId: next.ownerUserId,
        model: next.model,
        mode: next.mode,
        error: next.error,
        failedAt: next.failedAt || updatedAt,
      });
    } catch (_) {}
  }
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
      retry_count = ?, provider_key_ref = ?, reservation_credit_event_id = ?, submission_attempt = ?,
      last_successful_poll_at = ?, poll_failure_count = ?, error = ?,
      result_processing_failure_count = ?, last_result_processing_error = ?,
      last_result_processing_at = ?,
      first_submitted_at = ?, completed_at = ?, failed_at = ?, asset_status = ?, asset_bytes = ?, assets_deleted_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    String(next.status || existing.status), next.dependsOnClipIndex ?? null, String(next.prompt ?? (existing.prompt || "")),
    String(next.provider ?? (existing.provider || "")), String(next.providerTaskId ?? (existing.providerTaskId || "")),
    String(next.continuityMode ?? (existing.continuityMode || "")), JSON.stringify(next.referenceAssetIds || existing.referenceAssetIds || []),
    JSON.stringify(next.continuityState || existing.continuityState || {}), JSON.stringify(next.outputVideo || existing.outputVideo || {}),
    JSON.stringify(next.continuityFrame || existing.continuityFrame || {}), Number(next.creditCost ?? existing.creditCost ?? 0),
    Number(next.attempt ?? existing.attempt ?? 0), Number(next.retryCount ?? existing.retryCount ?? 0),
    String(next.providerKeyRef ?? existing.providerKeyRef ?? ""), next.reservationCreditEventId ?? existing.reservationCreditEventId ?? null,
    Number(next.submissionAttempt ?? existing.submissionAttempt ?? 0), String(next.lastSuccessfulPollAt ?? existing.lastSuccessfulPollAt ?? ""),
    Number(next.pollFailureCount ?? existing.pollFailureCount ?? 0), String(next.error ?? existing.error ?? ""),
    Number(next.resultProcessingFailureCount ?? existing.resultProcessingFailureCount ?? 0),
    String(next.lastResultProcessingError ?? existing.lastResultProcessingError ?? ""),
    String(next.lastResultProcessingAt ?? existing.lastResultProcessingAt ?? ""),
    String(next.firstSubmittedAt ?? existing.firstSubmittedAt ?? ""),
    String(next.completedAt ?? existing.completedAt ?? ""),
    String(next.failedAt ?? existing.failedAt ?? ""),
    String(next.assetStatus ?? existing.assetStatus ?? "available"),
    Number(next.assetBytes ?? existing.assetBytes ?? 0),
    String(next.assetsDeletedAt ?? existing.assetsDeletedAt ?? ""),
    nowIso(),
    Number(clipId),
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
  findActiveProjectByContext,
  findProjectByGenerationId,
  listProjectsByOwner,
  listRecoverableProjects,
  listProjectsForRefundReconciliation,
  insertProject,
  insertClip,
  getClip,
  listClips,
  updateProject,
  updateClip,
  updateClipByProjectIndex,
  createProjectWithClips,
  BILLING_COLUMNS,
  mapBillingRow,
  findVideoBillingRequestByOwnerRequestId,
  insertVideoBillingRequest,
  updateVideoBillingRequest,
  createProjectWithBilling,
  retryProjectWithBilling,
  claimVideoResultRetry,
  claimAssemblyRetry,
  claimAssemblyStart,
};
