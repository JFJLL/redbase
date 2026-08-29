const { insertAiTaskAttempt } = require("./analytics-repository");
const { normalizeAnalyticsFeature } = require("./analytics-constants");

function recordTextTaskAttempt(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 8);
  const taskType = input.taskType || "text_generation";
  const attemptKey = input.attemptKey || (input.entityId
    ? `${taskType}:${input.entityId}:${input.attemptNo || 1}`
    : `text:${taskType}:${Date.now()}:${rand}`);
  return insertAiTaskAttempt({
    attemptKey,
    feature: input.feature || "trend_analysis",
    taskType,
    entityType: input.entityType || "",
    entityId: String(input.entityId || ""),
    provider: input.provider || "",
    model: input.model || "",
    attemptKind: input.attemptKind || "initial",
    attemptNo: Number(input.attemptNo || 1),
    status: input.status || "completed",
    errorStage: input.errorStage || "",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    startedAt,
    completedAt: input.completedAt || "",
    durationMs: Number(input.durationMs || 0),
    firstByteMs: input.firstByteMs == null ? null : Number(input.firstByteMs),
    inputTokens: input.inputTokens == null ? null : Number(input.inputTokens),
    outputTokens: input.outputTokens == null ? null : Number(input.outputTokens),
    totalTokens: input.totalTokens == null ? null : Number(input.totalTokens),
    creditCost: Number(input.creditCost || 0),
    actorUserId: input.actorUserId ?? null,
    accountType: input.accountType || "",
    isBackfilled: input.isBackfilled || 0,
  });
}

function recordImageTaskAttempt(input = {}) {
  const startedAt = input.startedAt || (input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString());
  const taskType = input.taskType || "image_generation";
  const attemptKey = input.attemptKey || `${taskType}:${input.jobId || "job"}:${input.attemptNo || 1}`;
  return insertAiTaskAttempt({
    attemptKey,
    feature: normalizeAnalyticsFeature(input.feature, "style_image"),
    taskType,
    entityType: "image_job",
    entityId: String(input.jobId || ""),
    provider: input.provider || "",
    model: input.model || "",
    attemptKind: input.attemptKind || "initial",
    attemptNo: Number(input.attemptNo || 1),
    status: input.status || "completed",
    errorStage: input.errorStage || "",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    startedAt,
    completedAt: input.completedAt || "",
    durationMs: Number(input.durationMs || 0),
    creditCost: Number(input.creditCost || 0),
    actorUserId: input.actorUserId ?? null,
    accountType: input.accountType || "",
    isBackfilled: input.isBackfilled || 0,
  });
}

function recordVideoClipAttempt(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const taskType = input.taskType || "video_clip_generation";
  const stableEntityId = input.clipId || `${input.projectId}:${input.clipIndex || 0}`;
  const attemptKey = input.attemptKey || `${taskType}:${stableEntityId}:${input.attemptNo || 1}`;
  return insertAiTaskAttempt({
    attemptKey,
    feature: "video_project",
    taskType,
    entityType: "video_project",
    entityId: String(input.projectId || ""),
    projectId: input.projectId == null ? null : Number(input.projectId),
    clipId: input.clipId == null ? null : Number(input.clipId),
    provider: input.provider || "",
    model: input.model || "",
    providerKeyRef: input.providerKeyRef || "",
    providerTaskId: input.providerTaskId || "",
    attemptKind: input.attemptKind || "initial",
    attemptNo: Number(input.attemptNo || 1),
    status: input.status || "completed",
    errorStage: input.errorStage || "",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    startedAt,
    acceptedAt: input.acceptedAt || "",
    providerCompletedAt: input.providerCompletedAt || "",
    resultProcessingStartedAt: input.resultProcessingStartedAt || "",
    resultProcessingCompletedAt: input.resultProcessingCompletedAt || "",
    completedAt: input.completedAt || "",
    durationMs: Number(input.durationMs || 0),
    creditCost: Number(input.creditCost || 0),
    vendorCostFen: input.vendorCostFen == null ? null : Number(input.vendorCostFen),
    actorUserId: input.actorUserId ?? null,
    accountType: input.accountType || "",
    isBackfilled: input.isBackfilled || 0,
  });
}

function recordVideoResultProcessingAttempt(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const attemptKey = input.attemptKey || `video_result:${input.projectId}:${input.clipIndex || 0}:${input.attemptNo || 1}:${startedAt}`;
  return insertAiTaskAttempt({
    attemptKey,
    feature: "video_project",
    taskType: "video_result_processing",
    entityType: "video_project",
    entityId: String(input.projectId || ""),
    projectId: input.projectId == null ? null : Number(input.projectId),
    clipId: input.clipId == null ? null : Number(input.clipId),
    provider: input.provider || "",
    model: input.model || "",
    attemptKind: input.attemptKind || "initial",
    attemptNo: Number(input.attemptNo || 1),
    status: input.status || "completed",
    errorStage: input.errorStage || "",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    startedAt,
    completedAt: input.completedAt || "",
    durationMs: Number(input.durationMs || 0),
    creditCost: 0,
    actorUserId: input.actorUserId ?? null,
    accountType: input.accountType || "",
    isBackfilled: input.isBackfilled || 0,
  });
}

function recordVideoAssemblyAttempt(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const attemptKey = input.attemptKey || `video_assembly:${input.projectId}:${input.attemptNo || 1}:${startedAt}`;
  return insertAiTaskAttempt({
    attemptKey,
    feature: "video_project",
    taskType: "video_assembly",
    entityType: "video_project",
    entityId: String(input.projectId || ""),
    projectId: input.projectId == null ? null : Number(input.projectId),
    provider: "ffmpeg",
    model: "ffmpeg",
    attemptKind: input.attemptKind || "assembly_initial",
    attemptNo: Number(input.attemptNo || 1),
    status: input.status || "completed",
    errorStage: input.errorStage || "",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    startedAt,
    completedAt: input.completedAt || "",
    durationMs: Number(input.durationMs || 0),
    creditCost: 0,
    actorUserId: input.actorUserId ?? null,
    accountType: input.accountType || "",
    isBackfilled: input.isBackfilled || 0,
  });
}

module.exports = {
  recordTextTaskAttempt,
  recordImageTaskAttempt,
  recordVideoClipAttempt,
  recordVideoResultProcessingAttempt,
  recordVideoAssemblyAttempt,
};
