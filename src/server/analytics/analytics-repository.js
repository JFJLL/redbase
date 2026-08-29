const { getDbProxy } = require("../db/connection");
const { getReleaseSha, normalizeAnalyticsFeature } = require("./analytics-constants");
const { sanitizeAnalyticsError, sanitizeAnalyticsMetadata } = require("./analytics-metadata");
const { loadAppConfig } = require("../config");
const { isAdminUser } = require("../api/domain-utils");

const db = getDbProxy();
const analyticsWriteStats = { expected: 0, inserted: 0, existing: 0, failed: 0 };
let strictWriteDepth = 0;

function sanitizeErrorMessage(msg) {
  return sanitizeAnalyticsError(msg);
}

function resolveActorSnapshot(input = {}) {
  const actorUserId = input.actorUserId == null ? null : Number(input.actorUserId);
  const user = actorUserId == null
    ? null
    : db.prepare("SELECT id, phone, account_type FROM users WHERE id = ?").get(actorUserId);
  return {
    actorUserId,
    accountType: String(input.accountType || user?.account_type || ""),
    isAdmin: input.isAdmin == null
      ? Number(Boolean(user && isAdminUser(user, loadAppConfig())))
      : Number(Boolean(input.isAdmin)),
  };
}

function insertAnalyticsEvent(input = {}, options = {}) {
  if (!input.eventKey || !input.eventName || !input.occurredAt) {
    return null;
  }
  const nowIso = new Date().toISOString();
  const actorKey = input.actorKey || (input.actorUserId ? `user:${input.actorUserId}` : "");
  const releaseSha = input.releaseSha != null ? String(input.releaseSha) : getReleaseSha();
  const metadataJson = JSON.stringify(sanitizeAnalyticsMetadata(input.metadata));
  const actor = resolveActorSnapshot(input);
  const existedBefore = Boolean(db.prepare("SELECT 1 FROM analytics_events WHERE event_key = ?").get(String(input.eventKey)));
  analyticsWriteStats.expected += 1;

  try {
    const stmt = db.prepare(`
      INSERT INTO analytics_events (
        event_key, event_name, occurred_at, actor_key, actor_user_id, account_type, is_admin,
        feature, entity_type, entity_id, source_table, source_id, status,
        provider, model, mode, resolution, aspect_ratio, duration_ms,
        media_duration_sec, credit_delta, credit_cost, amount_fen, quantity,
        asset_bytes, metadata_json, release_sha, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      ) ON CONFLICT(event_key) DO UPDATE SET
        account_type = CASE WHEN analytics_events.account_type = '' THEN excluded.account_type ELSE analytics_events.account_type END,
        is_admin = CASE WHEN analytics_events.is_admin = 0 AND excluded.is_admin = 1 THEN 1 ELSE analytics_events.is_admin END,
        feature = CASE WHEN analytics_events.feature = '' THEN excluded.feature ELSE analytics_events.feature END,
        duration_ms = CASE WHEN analytics_events.duration_ms = 0 AND excluded.duration_ms > 0 THEN excluded.duration_ms ELSE analytics_events.duration_ms END,
        metadata_json = CASE WHEN ? = 1 THEN excluded.metadata_json ELSE analytics_events.metadata_json END
    `);
    const result = stmt.run(
      String(input.eventKey),
      String(input.eventName),
      String(input.occurredAt),
      String(actorKey),
      actor.actorUserId,
      actor.accountType,
      actor.isAdmin,
      normalizeAnalyticsFeature(input.feature, input.feature ? "other" : ""),
      String(input.entityType || ""),
      String(input.entityId || ""),
      String(input.sourceTable || ""),
      String(input.sourceId || ""),
      String(input.status || ""),
      String(input.provider || ""),
      String(input.model || ""),
      String(input.mode || ""),
      String(input.resolution || ""),
      String(input.aspectRatio || ""),
      Number(input.durationMs || 0),
      Number(input.mediaDurationSec || 0),
      Number(input.creditDelta || 0),
      Number(input.creditCost || 0),
      Number(input.amountFen || 0),
      Number(input.quantity == null ? 1 : input.quantity),
      Number(input.assetBytes || 0),
      metadataJson,
      releaseSha,
      nowIso,
      Number(Boolean(input.replaceMetadata)),
    );
    if (existedBefore) analyticsWriteStats.existing += 1;
    else analyticsWriteStats.inserted += 1;
    return !existedBefore && result.changes > 0;
  } catch (error) {
    analyticsWriteStats.failed += 1;
    if (options.strict || strictWriteDepth > 0) throw error;
    console.warn("[analytics] failed to insert event:", error.message);
    return false;
  }
}

function getAnalyticsWriteStats() {
  return { ...analyticsWriteStats };
}

function runWithStrictAnalyticsWrites(fn) {
  strictWriteDepth += 1;
  try {
    return fn();
  } finally {
    strictWriteDepth -= 1;
  }
}

function insertAiTaskAttempt(input = {}, options = {}) {
  if (!input.attemptKey || !input.feature || !input.taskType || !input.startedAt || !input.status) {
    return null;
  }
  const nowIso = new Date().toISOString();
  const actorKey = input.actorKey || (input.actorUserId ? `user:${input.actorUserId}` : "");
  const releaseSha = input.releaseSha != null ? String(input.releaseSha) : getReleaseSha();
  const metadataJson = JSON.stringify(sanitizeAnalyticsMetadata(input.metadata));
  const errorMsg = sanitizeErrorMessage(input.errorMessage);
  const actor = resolveActorSnapshot(input);
  const existedBefore = Boolean(db.prepare("SELECT 1 FROM ai_task_attempts WHERE attempt_key = ?").get(String(input.attemptKey)));
  analyticsWriteStats.expected += 1;

  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO ai_task_attempts (
        attempt_key, feature, task_type, entity_type, entity_id, project_id, clip_id,
        actor_key, actor_user_id, account_type, is_admin, provider, model, provider_key_ref,
        provider_task_id, attempt_kind, attempt_no, status, error_stage, error_code,
        error_message, started_at, accepted_at, provider_completed_at,
        result_processing_started_at, result_processing_completed_at, completed_at,
        duration_ms, first_byte_ms, input_tokens, output_tokens, total_tokens,
        credit_cost, vendor_cost_fen, is_backfilled, metadata_json, release_sha, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);
    const result = stmt.run(
      String(input.attemptKey),
      normalizeAnalyticsFeature(input.feature, "other"),
      String(input.taskType),
      String(input.entityType || ""),
      String(input.entityId || ""),
      input.projectId == null ? null : Number(input.projectId),
      input.clipId == null ? null : Number(input.clipId),
      String(actorKey),
      actor.actorUserId,
      actor.accountType,
      actor.isAdmin,
      String(input.provider || ""),
      String(input.model || ""),
      String(input.providerKeyRef || ""),
      String(input.providerTaskId || ""),
      String(input.attemptKind || "initial"),
      Number(input.attemptNo || 1),
      String(input.status),
      String(input.errorStage || ""),
      String(input.errorCode || ""),
      errorMsg,
      String(input.startedAt),
      String(input.acceptedAt || ""),
      String(input.providerCompletedAt || ""),
      String(input.resultProcessingStartedAt || ""),
      String(input.resultProcessingCompletedAt || ""),
      String(input.completedAt || ""),
      Number(input.durationMs || 0),
      input.firstByteMs == null ? null : Number(input.firstByteMs),
      input.inputTokens == null ? null : Number(input.inputTokens),
      input.outputTokens == null ? null : Number(input.outputTokens),
      input.totalTokens == null ? null : Number(input.totalTokens),
      Number(input.creditCost || 0),
      input.vendorCostFen == null ? null : Number(input.vendorCostFen),
      Number(input.isBackfilled ? 1 : 0),
      metadataJson,
      releaseSha,
      nowIso,
    );
    if (existedBefore) analyticsWriteStats.existing += 1;
    else analyticsWriteStats.inserted += 1;
    return !existedBefore && result.changes > 0;
  } catch (error) {
    analyticsWriteStats.failed += 1;
    if (options.strict || strictWriteDepth > 0) throw error;
    console.warn("[analytics] failed to insert ai attempt:", error.message);
    return false;
  }
}

function getAnalyticsMeta(key) {
  const row = db.prepare("SELECT value FROM analytics_meta WHERE key = ?").get(String(key));
  return row ? row.value : null;
}

function setAnalyticsMeta(key, value) {
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO analytics_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), String(value), nowIso);
}

function getAllAnalyticsMeta() {
  const rows = db.prepare("SELECT key, value, updated_at FROM analytics_meta").all();
  const meta = {};
  for (const row of rows) {
    meta[row.key] = row.value;
  }
  return meta;
}

function anonymizeUserAnalytics(userId) {
  const uid = Number(userId);
  db.prepare("UPDATE analytics_events SET actor_user_id = NULL WHERE actor_user_id = ?").run(uid);
  db.prepare("UPDATE ai_task_attempts SET actor_user_id = NULL WHERE actor_user_id = ?").run(uid);
}

function getDbStats() {
  try {
    const pageCountRow = db.prepare("PRAGMA page_count").get();
    const pageSizeRow = db.prepare("PRAGMA page_size").get();
    const pageCount = Number(pageCountRow?.page_count || 0);
    const pageSize = Number(pageSizeRow?.page_size || 4096);
    const dbSizeBytes = pageCount * pageSize;
    return {
      databaseAvailable: true,
      dbSizeBytes,
      pageCount,
      pageSize,
    };
  } catch (error) {
    return {
      databaseAvailable: false,
      dbSizeBytes: 0,
      pageCount: 0,
      pageSize: 4096,
    };
  }
}

module.exports = {
  sanitizeErrorMessage,
  resolveActorSnapshot,
  getAnalyticsWriteStats,
  runWithStrictAnalyticsWrites,
  insertAnalyticsEvent,
  insertAiTaskAttempt,
  getAnalyticsMeta,
  setAnalyticsMeta,
  getAllAnalyticsMeta,
  anonymizeUserAnalytics,
  getDbStats,
};
