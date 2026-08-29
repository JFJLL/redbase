const { insertAnalyticsEvent, anonymizeUserAnalytics } = require("./analytics-repository");
const { toShanghaiDateString } = require("./analytics-query-range");
const {
  ANALYTICS_FEATURES,
  CLIENT_EVENT_WHITELIST,
  normalizeAnalyticsFeature,
} = require("./analytics-constants");
const { buildSafeCreditAnalyticsMetadata } = require("./analytics-metadata");

function recordUserActiveDay({ userId, accountType, occurredAt } = {}) {
  if (!userId) return false;
  const nowIso = occurredAt || new Date().toISOString();
  const dayStr = toShanghaiDateString(nowIso);
  const eventKey = `user_active_day:${dayStr}:${userId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "user_active_day",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
  });
}

function recordUserRegistered({ userId, accountType, createdAt } = {}) {
  if (!userId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `user_registered:${userId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "user_registered",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    entityType: "user",
    entityId: String(userId),
  });
}

function recordBrandCreated({ brandId, userId, accountType, createdAt } = {}) {
  if (!brandId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `brand_created:${brandId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "brand_created",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    entityType: "brand",
    entityId: String(brandId),
  });
}

function recordTrendAnalysisStarted({ requestId, userId, brandId, bucketKey, createdAt } = {}) {
  if (!requestId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `trend_analysis_started:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "trend_analysis_started",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
    entityType: "trend_analysis",
    entityId: String(requestId),
    metadata: { brandId, bucketKey },
  });
}

function recordTrendAnalysisCompleted({ requestId, userId, brandId, bucketKey, durationMs, completedAt } = {}) {
  if (!requestId) return false;
  const nowIso = completedAt || new Date().toISOString();
  const eventKey = `trend_analysis_completed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "trend_analysis_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
    status: "completed",
    entityType: "trend_analysis",
    entityId: String(requestId),
    durationMs: Number(durationMs || 0),
    metadata: { brandId, bucketKey },
  });
}

function recordTrendAnalysisFailed({ requestId, userId, brandId, bucketKey, error, failedAt } = {}) {
  if (!requestId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `trend_analysis_failed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "trend_analysis_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
    status: "failed",
    entityType: "trend_analysis",
    entityId: String(requestId),
    metadata: { brandId, bucketKey, error: String(error || "").slice(0, 200) },
  });
}

function recordExcellentDirectionCompleted({ requestId, userId, durationMs, creditCost, completedAt } = {}) {
  if (!requestId) return false;
  const nowIso = completedAt || new Date().toISOString();
  const eventKey = `excellent_direction_completed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "excellent_direction_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.EXCELLENT_DIRECTION,
    status: "completed",
    entityType: "direction",
    entityId: String(requestId),
    durationMs: Number(durationMs || 0),
    creditCost: Number(creditCost || 0),
  });
}

function recordExcellentDirectionFailed({ requestId, userId, error, failedAt } = {}) {
  if (!requestId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `excellent_direction_failed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "excellent_direction_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.EXCELLENT_DIRECTION,
    status: "failed",
    entityType: "direction",
    entityId: String(requestId),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordExcellentFusionCompleted({ requestId, userId, durationMs, creditCost, completedAt } = {}) {
  if (!requestId) return false;
  const nowIso = completedAt || new Date().toISOString();
  const eventKey = `excellent_fusion_completed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "excellent_fusion_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.EXCELLENT_FUSION,
    status: "completed",
    entityType: "fusion",
    entityId: String(requestId),
    durationMs: Number(durationMs || 0),
    creditCost: Number(creditCost || 0),
  });
}

function recordExcellentFusionFailed({ requestId, userId, error, failedAt } = {}) {
  if (!requestId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `excellent_fusion_failed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "excellent_fusion_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    feature: ANALYTICS_FEATURES.EXCELLENT_FUSION,
    status: "failed",
    entityType: "fusion",
    entityId: String(requestId),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordOutputCompleted({
  eventKey,
  generationId,
  userId,
  accountType,
  type,
  model,
  creditCost,
  durationMs,
  completedAt,
  entityType = "generation",
  entityId,
} = {}) {
  const key = eventKey || (generationId ? `output_completed:${generationId}` : "");
  if (!key) return false;
  const nowIso = completedAt || new Date().toISOString();
  const feature = normalizeAnalyticsFeature(type);
  const effectiveEntityId = entityId != null ? String(entityId) : (generationId ? String(generationId) : "");
  return insertAnalyticsEvent({
    eventKey: key,
    eventName: "output_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature,
    status: "completed",
    entityType: entityType || "generation",
    entityId: effectiveEntityId,
    sourceTable: generationId ? "generations" : "",
    sourceId: generationId ? String(generationId) : "",
    model: String(model || ""),
    creditCost: Number(creditCost || 0),
    durationMs: Number(durationMs || 0),
  });
}

function recordOutputFailed({
  eventKey,
  generationId,
  userId,
  accountType,
  type,
  model,
  error,
  failedAt,
  entityType = "generation",
  entityId,
} = {}) {
  const key = eventKey || (generationId ? `output_failed:${generationId}` : "");
  if (!key) return false;
  const nowIso = failedAt || new Date().toISOString();
  const feature = normalizeAnalyticsFeature(type);
  const effectiveEntityId = entityId != null ? String(entityId) : (generationId ? String(generationId) : "");
  return insertAnalyticsEvent({
    eventKey: key,
    eventName: "output_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature,
    status: "failed",
    entityType: entityType || "generation",
    entityId: effectiveEntityId,
    sourceTable: generationId ? "generations" : "",
    sourceId: generationId ? String(generationId) : "",
    model: String(model || ""),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordVideoScriptStarted({ requestId, userId, accountType, brandId, createdAt } = {}) {
  if (!requestId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `video_script_started:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_script_started",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
    entityType: "video_script",
    entityId: String(requestId),
    metadata: { brandId },
  });
}

function recordVideoScriptCompleted({ requestId, userId, accountType, generationId, creditCost, durationMs, completedAt } = {}) {
  if (!requestId) return false;
  const nowIso = completedAt || new Date().toISOString();
  const eventKey = `video_script_completed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_script_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
    status: "completed",
    entityType: "video_script",
    entityId: String(requestId),
    sourceTable: "generations",
    sourceId: generationId ? String(generationId) : "",
    creditCost: Number(creditCost || 1),
    durationMs: Number(durationMs || 0),
  });
}

function recordVideoScriptFailed({ requestId, userId, accountType, error, failedAt } = {}) {
  if (!requestId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `video_script_failed:${requestId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_script_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
    status: "failed",
    entityType: "video_script",
    entityId: String(requestId),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordVideoProjectCreated({ projectId, userId, accountType, model, mode, resolution, aspectRatio, totalDurationSec, estimatedCredits, createdAt } = {}) {
  if (!projectId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `video_project_created:${projectId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_project_created",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
    entityType: "video_project",
    entityId: String(projectId),
    model: String(model || ""),
    mode: String(mode || ""),
    resolution: String(resolution || ""),
    aspectRatio: String(aspectRatio || ""),
    mediaDurationSec: Number(totalDurationSec || 0),
    creditCost: Number(estimatedCredits || 0),
    metadata: { estimatedCredits: Number(estimatedCredits || 0) },
  });
}

function recordVideoProjectCompleted({ projectId, userId, accountType, model, mode, resolution, aspectRatio, totalDurationSec, chargedCredits, refundedCredits, durationMs, completedAt } = {}) {
  if (!projectId) return false;
  const nowIso = completedAt || new Date().toISOString();
  const eventKey = `video_project_completed:${projectId}`;
  const netCredits = Number(chargedCredits || 0) - Number(refundedCredits || 0);
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_project_completed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
    status: "completed",
    entityType: "video_project",
    entityId: String(projectId),
    model: String(model || ""),
    mode: String(mode || ""),
    resolution: String(resolution || ""),
    aspectRatio: String(aspectRatio || ""),
    mediaDurationSec: Number(totalDurationSec || 0),
    creditCost: netCredits,
    durationMs: Number(durationMs || 0),
    metadata: {
      chargedCredits: Number(chargedCredits || 0),
      refundedCredits: Number(refundedCredits || 0),
      completedAt: nowIso,
    },
  });
}

function recordVideoProjectFailed({ projectId, userId, accountType, model, mode, resolution, aspectRatio, totalDurationSec, chargedCredits, refundedCredits, error, failedAt } = {}) {
  if (!projectId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `video_project_failed:${projectId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "video_project_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
    status: "failed",
    entityType: "video_project",
    entityId: String(projectId),
    model: String(model || ""),
    mode: String(mode || ""),
    resolution: String(resolution || ""),
    aspectRatio: String(aspectRatio || ""),
    mediaDurationSec: Number(totalDurationSec || 0),
    metadata: {
      error: String(error || "").slice(0, 200),
      chargedCredits: Number(chargedCredits || 0),
      refundedCredits: Number(refundedCredits || 0),
      failedAt: nowIso,
    },
  });
}

function recordPaymentOrderCreated({ orderId, userId, accountType, amountFen, planId, planName, planCredits, provider, createdAt } = {}) {
  if (!orderId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `payment_order_created:${orderId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "payment_order_created",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    entityType: "payment_order",
    entityId: String(orderId),
    provider: String(provider || ""),
    amountFen: Number(amountFen || 0),
    metadata: { planId: planId || "", planName: planName || "", planCredits: Number(planCredits || 0) },
  });
}

function recordPaymentPaid({ orderId, userId, accountType, amountFen, planId, planName, planCredits, provider, paidAt } = {}) {
  if (!orderId) return false;
  const nowIso = paidAt || new Date().toISOString();
  const eventKey = `payment_paid:${orderId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "payment_paid",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    status: "paid",
    entityType: "payment_order",
    entityId: String(orderId),
    provider: String(provider || ""),
    amountFen: Number(amountFen || 0),
    creditDelta: Number(planCredits || 0),
    metadata: { planId: planId || "", planName: planName || "", planCredits: Number(planCredits || 0) },
  });
}

function recordPaymentFailed({ orderId, userId, accountType, amountFen, provider, error, failedAt } = {}) {
  if (!orderId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `payment_failed:${orderId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "payment_failed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    status: "failed",
    entityType: "payment_order",
    entityId: String(orderId),
    provider: String(provider || ""),
    amountFen: Number(amountFen || 0),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordCreditConsumed({ creditEventId, userId, accountType, actionType, feature, creditDelta, creditCost, generationId, createdAt, metadata } = {}) {
  if (!creditEventId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `credit_consumed:${creditEventId}`;
  const cost = Math.abs(Number(creditCost || creditDelta || 0));
  const feat = normalizeAnalyticsFeature(feature || actionType, "");
  return insertAnalyticsEvent({
    eventKey,
    eventName: "credit_consumed",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: feat,
    entityType: "credit_event",
    entityId: String(creditEventId),
    sourceTable: "generations",
    sourceId: generationId ? String(generationId) : "",
    creditDelta: -cost,
    creditCost: cost,
    metadata: buildSafeCreditAnalyticsMetadata({ ...(metadata && typeof metadata === "object" ? metadata : {}), actionType }),
    replaceMetadata: true,
  });
}

function recordCreditRefunded({ creditEventId, userId, accountType, actionType, feature, creditDelta, refundForCreditEventId, createdAt, metadata } = {}) {
  if (!creditEventId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `credit_refunded:${creditEventId}`;
  const amount = Math.abs(Number(creditDelta || 0));
  const feat = normalizeAnalyticsFeature(feature || actionType, "");
  return insertAnalyticsEvent({
    eventKey,
    eventName: "credit_refunded",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    feature: feat,
    entityType: "credit_event",
    entityId: String(creditEventId),
    creditDelta: amount,
    metadata: buildSafeCreditAnalyticsMetadata({ ...(metadata && typeof metadata === "object" ? metadata : {}), actionType, refundForCreditEventId }),
    replaceMetadata: true,
  });
}

function recordCreditGranted({ creditEventId, userId, accountType, actionType, creditDelta, adminUserId, createdAt } = {}) {
  if (!creditEventId) return false;
  const nowIso = createdAt || new Date().toISOString();
  const eventKey = `credit_granted:${creditEventId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "credit_granted",
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    entityType: "credit_event",
    entityId: String(creditEventId),
    creditDelta: Number(creditDelta || 0),
    metadata: buildSafeCreditAnalyticsMetadata({ actionType }),
    replaceMetadata: true,
  });
}

function recordAssetPurgeCompleted({ generationId, count, bytes, purgedAt } = {}) {
  if (!generationId) return false;
  const nowIso = purgedAt || new Date().toISOString();
  const eventKey = `asset_purge_completed:${generationId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "asset_purge_completed",
    occurredAt: nowIso,
    entityType: "generation",
    entityId: String(generationId),
    quantity: Number(count || 0),
    assetBytes: Number(bytes || 0),
  });
}

function recordAssetPurgeFailed({ generationId, error, failedAt } = {}) {
  if (!generationId) return false;
  const nowIso = failedAt || new Date().toISOString();
  const eventKey = `asset_purge_failed:${generationId}:${Date.now()}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "asset_purge_failed",
    occurredAt: nowIso,
    entityType: "generation",
    entityId: String(generationId),
    metadata: { error: String(error || "").slice(0, 200) },
  });
}

function recordGenerationDeleted({ generationId, userId, deletedAt } = {}) {
  if (!generationId) return false;
  const nowIso = deletedAt || new Date().toISOString();
  const eventKey = `generation_deleted:${generationId}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName: "generation_deleted",
    occurredAt: nowIso,
    actorUserId: userId,
    entityType: "generation",
    entityId: String(generationId),
  });
}

function recordUserDeleted({ userId, deletedAt } = {}) {
  if (!userId) return false;
  const nowIso = deletedAt || new Date().toISOString();
  const eventKey = `user_deleted:${userId}`;
  const inserted = insertAnalyticsEvent({
    eventKey,
    eventName: "user_deleted",
    occurredAt: nowIso,
    actorKey: `user:${userId}`,
    actorUserId: null,
    entityType: "user",
    entityId: String(userId),
  }, { strict: true });
  // Keep immutable dimensions but remove the direct user foreign identifier in
  // the same surrounding database transaction as the business-row deletion.
  anonymizeUserAnalytics(userId);
  return inserted;
}

function recordClientEvent({ eventName, userId, accountType, metadata } = {}) {
  if (!CLIENT_EVENT_WHITELIST.has(String(eventName))) {
    const err = new Error("不支持的客户端埋点事件");
    err.code = "INVALID_EVENT_NAME";
    err.status = 400;
    throw err;
  }
  if (!userId) {
    const err = new Error("请先登录");
    err.code = "UNAUTHORIZED";
    err.status = 401;
    throw err;
  }
  // Sanitize metadata: whitelist safe primitive keys only
  const safeMeta = {};
  if (metadata && typeof metadata === "object") {
    const allowedKeys = ["page", "step", "projectId", "planId", "assetType", "source"];
    for (const key of allowedKeys) {
      if (metadata[key] != null && typeof metadata[key] !== "object") {
        safeMeta[key] = String(metadata[key]).slice(0, 100);
      }
    }
  }
  const nowIso = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 8);
  const eventKey = `client:${eventName}:${userId}:${Date.now()}:${rand}`;
  return insertAnalyticsEvent({
    eventKey,
    eventName,
    occurredAt: nowIso,
    actorUserId: userId,
    accountType,
    metadata: safeMeta,
  });
}

module.exports = {
  recordUserActiveDay,
  recordUserRegistered,
  recordBrandCreated,
  recordTrendAnalysisStarted,
  recordTrendAnalysisCompleted,
  recordTrendAnalysisFailed,
  recordExcellentDirectionCompleted,
  recordExcellentDirectionFailed,
  recordExcellentFusionCompleted,
  recordExcellentFusionFailed,
  recordOutputCompleted,
  recordOutputFailed,
  recordVideoScriptStarted,
  recordVideoScriptCompleted,
  recordVideoScriptFailed,
  recordVideoProjectCreated,
  recordVideoProjectCompleted,
  recordVideoProjectFailed,
  recordPaymentOrderCreated,
  recordPaymentPaid,
  recordPaymentFailed,
  recordCreditConsumed,
  recordCreditRefunded,
  recordCreditGranted,
  recordAssetPurgeCompleted,
  recordAssetPurgeFailed,
  recordGenerationDeleted,
  recordUserDeleted,
  recordClientEvent,
};
