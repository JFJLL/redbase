const { getDbProxy } = require("../connection");
const { allocateCounter, runTransaction } = require("./core-repository");
const { findUserById } = require("./auth-repository");
const { findGenerationByOwner, upsertGeneration } = require("./generation-repository");
const {
  spendCreditsWithEventInTransaction,
  refundCreditEventIfNeededInTransaction,
  updateCreditEventGeneration,
} = require("./admin-repository");

const db = getDbProxy();
const VIDEO_SCRIPT_REQUEST_STALE_MS = 15 * 60 * 1000;
const REQUEST_COLUMNS = `
  id, request_id, user_id, brand_id, trend_id, idea_index, model, mode, status,
  credit_cost, credit_event_id, generation_id, error, input_signature, created_at, updated_at
`;

function mapVideoScriptRequest(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    requestId: String(row.request_id || ""),
    userId: Number(row.user_id),
    brandId: Number(row.brand_id),
    trendId: Number(row.trend_id),
    ideaIndex: Number(row.idea_index),
    model: String(row.model || ""),
    mode: String(row.mode || ""),
    status: String(row.status || "running"),
    creditCost: Number(row.credit_cost || 0),
    creditEventId: row.credit_event_id == null ? null : Number(row.credit_event_id),
    generationId: row.generation_id == null ? null : Number(row.generation_id),
    error: String(row.error || ""),
    inputSignature: String(row.input_signature || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function findVideoScriptRequest(userId, requestId) {
  return mapVideoScriptRequest(db.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM video_script_requests
    WHERE user_id = ? AND request_id = ?
    LIMIT 1
  `).get(Number(userId), String(requestId || "").trim()));
}

function insertRequest(input) {
  const now = String(input.createdAt || new Date().toISOString());
  const id = input.id ?? allocateCounter("nextVideoScriptRequestId", 1);
  db.prepare(`
    INSERT INTO video_script_requests (
      id, request_id, user_id, brand_id, trend_id, idea_index, model, mode,
      status, credit_cost, credit_event_id, generation_id, error, input_signature, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(id), String(input.requestId), Number(input.userId), Number(input.brandId), Number(input.trendId),
    Number(input.ideaIndex), String(input.model || ""), String(input.mode || ""), String(input.status || "running"),
    Number(input.creditCost || 0), input.creditEventId ?? null, input.generationId ?? null, String(input.error || ""),
    String(input.inputSignature || ""), now, now,
  );
  return findVideoScriptRequest(input.userId, input.requestId);
}

function updateRequest(requestId, userId, patch = {}) {
  const current = findVideoScriptRequest(userId, requestId);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`
    UPDATE video_script_requests
    SET status = ?, credit_event_id = ?, generation_id = ?, error = ?, updated_at = ?
    WHERE user_id = ? AND request_id = ?
  `).run(
    String(next.status), next.creditEventId ?? null, next.generationId ?? null, String(next.error || ""),
    new Date().toISOString(), Number(userId), String(requestId),
  );
  return findVideoScriptRequest(userId, requestId);
}

function beginVideoScriptRequest({ userId, requestId, brandId, trendId, ideaIndex, model, mode, creditCost, event, createdAt, inputSignature } = {}) {
  return runTransaction(() => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      const error = new Error("缺少视频脚本 requestId");
      error.code = "VIDEO_SCRIPT_REQUEST_ID_REQUIRED";
      throw error;
    }
    const existing = findVideoScriptRequest(userId, normalizedRequestId);
    if (existing) {
      return { started: false, request: existing, user: findUserById(userId), creditEvent: null };
    }

    const charged = spendCreditsWithEventInTransaction({ userId, amount: creditCost, event });
    if (!charged?.spent || !charged.creditEvent?.id) {
      return { started: false, insufficient: true, request: null, user: charged?.user || findUserById(userId), creditEvent: null };
    }
    const request = insertRequest({
      requestId: normalizedRequestId,
      userId,
      brandId,
      trendId,
      ideaIndex,
      model,
      mode,
      status: "running",
      creditCost,
      creditEventId: charged.creditEvent.id,
      createdAt,
      inputSignature,
    });
    return { started: true, request, user: charged.user, creditEvent: charged.creditEvent };
  });
}

function completeVideoScriptRequest({ userId, requestId, generation } = {}) {
  return runTransaction(() => {
    const request = findVideoScriptRequest(userId, requestId);
    if (!request) {
      const error = new Error("视频脚本计费请求不存在");
      error.code = "VIDEO_SCRIPT_REQUEST_NOT_FOUND";
      throw error;
    }
    if (request.status === "completed") {
      return {
        completed: false,
        request,
        generation: request.generationId ? findGenerationByOwner(request.generationId, userId) : null,
        user: findUserById(userId),
      };
    }
    if (request.status !== "running") {
      return { completed: false, request, generation: null, user: findUserById(userId) };
    }

    const generationId = generation.id ?? allocateCounter("nextGenerationId", 1);
    const created = upsertGeneration({ ...generation, id: generationId });
    if (!created) throw new Error("视频脚本生成记录创建失败");
    const linkedEvent = updateCreditEventGeneration(request.creditEventId, created, created.payload, {
      requireUserId: userId,
      allowedActionTypes: ["videoScript"],
    });
    if (!linkedEvent) throw new Error("视频脚本计费事件关联失败");
    const completedRequest = updateRequest(request.requestId, userId, {
      status: "completed",
      generationId: created.id,
      error: "",
    });
    return { completed: true, request: completedRequest, generation: created, user: findUserById(userId) };
  });
}

function failVideoScriptRequest({ userId, requestId, reason } = {}) {
  return runTransaction(() => {
    const request = findVideoScriptRequest(userId, requestId);
    if (!request) return { request: null, refund: null, user: findUserById(userId) };
    if (request.status === "completed" || request.status === "failed" || request.status === "refunded") {
      return { request, refund: null, user: findUserById(userId) };
    }
    const refund = refundCreditEventIfNeededInTransaction({
      creditEventId: request.creditEventId,
      userId,
      reason: reason || "video script generation failed",
    });
    const nextStatus = refund.refunded || refund.refundEvent ? "refunded" : "failed";
    const updated = updateRequest(request.requestId, userId, {
      status: nextStatus,
      error: String(reason || "视频脚本生成失败").slice(0, 500),
    });
    return { request: updated, refund, user: findUserById(userId) };
  });
}

function listStaleVideoScriptRequests({ nowMs = Date.now(), staleMs = VIDEO_SCRIPT_REQUEST_STALE_MS, limit = 100 } = {}) {
  const cutoff = new Date(Number(nowMs) - Math.max(1, Number(staleMs) || VIDEO_SCRIPT_REQUEST_STALE_MS)).toISOString();
  return db.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM video_script_requests
    WHERE status = 'running' AND updated_at < ?
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).all(cutoff, Math.max(1, Number(limit) || 100)).map(mapVideoScriptRequest);
}

function recoverStaleVideoScriptRequests(options = {}) {
  const recovered = [];
  for (const request of listStaleVideoScriptRequests(options)) {
    recovered.push(failVideoScriptRequest({
      userId: request.userId,
      requestId: request.requestId,
      reason: "视频脚本服务中断，已自动退还积分，请重新发起请求。",
    }));
  }
  return recovered;
}

module.exports = {
  VIDEO_SCRIPT_REQUEST_STALE_MS,
  mapVideoScriptRequest,
  findVideoScriptRequest,
  beginVideoScriptRequest,
  completeVideoScriptRequest,
  failVideoScriptRequest,
  listStaleVideoScriptRequests,
  recoverStaleVideoScriptRequests,
};
