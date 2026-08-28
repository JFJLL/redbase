const { getDbProxy } = require("../connection");
const { TREND_ANALYSIS_RESERVATION_TTL_MS, EXCELLENT_BILLING_RESERVATION_TTL_MS, runTransaction } = require("./core-repository");
const { findUserById } = require("./auth-repository");
const { insertCreditEvent, findCreditEventById } = require("./admin-repository");
const { findBrandByOwner, upsertBrandFull } = require("./brand-repository");
const {
  recordTrendAnalysisStarted,
  recordTrendAnalysisCompleted,
  recordTrendAnalysisFailed,
} = require("../../analytics/analytics-recorder");

const db = getDbProxy();
function normalizeRequestId(value) {
  const requestId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return "";
  return requestId;
}

function findTrendAnalysisRequest({ requestId, userId, brandId, bucketKey }) {
  return db.prepare(`
    SELECT request_id, user_id, brand_id, bucket_key, status, credit_cost,
           analysis_id, credit_event_id, error, created_at, updated_at
    FROM trend_analysis_requests
    WHERE request_id = ? AND user_id = ? AND brand_id = ? AND bucket_key = ?
  `).get(String(requestId), Number(userId), Number(brandId), String(bucketKey));
}

function expireStaleReservations(userId, nowMs) {
  const cutoff = new Date(nowMs - TREND_ANALYSIS_RESERVATION_TTL_MS).toISOString();
  db.prepare(`
    UPDATE trend_analysis_requests
    SET status = 'failed', error = 'reservation expired', updated_at = ?
    WHERE user_id = ? AND status = 'reserved' AND created_at < ?
  `).run(new Date(nowMs).toISOString(), Number(userId), cutoff);
}

function reserveTrendAnalysisRequest({ requestId, userId, brandId, bucketKey, creditCost, now = new Date() }) {
  return runTransaction(() => {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) return { status: "invalid" };
    const nowMs = now.getTime();
    expireStaleReservations(userId, nowMs);
    const existing = findTrendAnalysisRequest({ requestId: normalizedRequestId, userId, brandId, bucketKey });
    if (existing) {
      return {
        status: existing.status,
        existing: true,
        request: existing,
        user: findUserById(userId),
        brand: existing.status === "completed" ? findBrandByOwner(brandId, userId) : null,
        creditEvent: existing.credit_event_id ? findCreditEventById(existing.credit_event_id) : null,
      };
    }
    const activeBucketRequest = db.prepare(`
      SELECT request_id, user_id, brand_id, bucket_key, status, credit_cost,
             analysis_id, credit_event_id, error, created_at, updated_at
      FROM trend_analysis_requests
      WHERE user_id = ? AND brand_id = ? AND bucket_key = ? AND status = 'reserved'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(Number(userId), Number(brandId), String(bucketKey));
    if (activeBucketRequest) {
      return {
        status: "reserved",
        existing: true,
        request: activeBucketRequest,
        user: findUserById(userId),
        brand: null,
        creditEvent: null,
      };
    }
    const user = findUserById(userId);
    const reserved = Number(db.prepare(`
      SELECT COALESCE(SUM(credit_cost), 0) AS total
      FROM trend_analysis_requests
      WHERE user_id = ? AND status = 'reserved'
    `).get(Number(userId))?.total || 0);
    // Excellent remix billing reservations also freeze balance; both sides must see each other.
    const excellentCutoff = new Date(nowMs - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString();
    const excellentReserved = Number(db.prepare(`
      SELECT COALESCE(SUM(credit_cost), 0) AS total
      FROM excellent_remix_billing_requests
      WHERE user_id = ? AND status = 'reserved' AND created_at >= ?
    `).get(Number(userId), excellentCutoff)?.total || 0);
    const cost = Math.max(0, Number(creditCost || 0));
    if (!user || Number(user.credits || 0) - reserved - excellentReserved < cost) {
      return { status: "insufficient", user, reservedCredits: reserved + excellentReserved };
    }
    const timestamp = now.toISOString();
    db.prepare(`
      INSERT INTO trend_analysis_requests (
        request_id, user_id, brand_id, bucket_key, status, credit_cost,
        analysis_id, credit_event_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'reserved', ?, NULL, NULL, '', ?, ?)
    `).run(normalizedRequestId, Number(userId), Number(brandId), String(bucketKey), cost, timestamp, timestamp);
    try {
      recordTrendAnalysisStarted({
        requestId: normalizedRequestId,
        userId,
        brandId,
        bucketKey,
        createdAt: timestamp,
      });
    } catch (_) {}
    return {
      status: "reserved",
      existing: false,
      request: findTrendAnalysisRequest({ requestId: normalizedRequestId, userId, brandId, bucketKey }),
      user,
      reservedCredits: reserved + cost,
    };
  });
}

function completeTrendAnalysisRequest({ requestId, userId, brandId, bucketKey, analysisId, event, buildBrand }) {
  return runTransaction(() => {
    const request = findTrendAnalysisRequest({ requestId, userId, brandId, bucketKey });
    if (!request) throw new Error("趋势分析请求不存在或已过期。");
    if (request.status === "completed") {
      return {
        replayed: true,
        brand: findBrandByOwner(brandId, userId),
        user: findUserById(userId),
        creditEvent: request.credit_event_id ? findCreditEventById(request.credit_event_id) : null,
      };
    }
    if (request.status !== "reserved") throw new Error("趋势分析请求状态已失效，请重新生成。");

    const currentBrand = findBrandByOwner(brandId, userId);
    if (!currentBrand) throw new Error("品牌不存在或已被删除。");
    const nextBrand = buildBrand(currentBrand);
    const savedBrand = upsertBrandFull(nextBrand);
    const excellentSettleCutoff = new Date(Date.now() - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString();
    const spend = db.prepare(`
      UPDATE users SET credits = credits - ?
      WHERE id = ?
        AND credits - COALESCE((
          SELECT SUM(credit_cost)
          FROM trend_analysis_requests
          WHERE user_id = users.id
            AND status = 'reserved'
            AND NOT (request_id = ? AND brand_id = ? AND bucket_key = ?)
        ), 0) - COALESCE((
          SELECT SUM(credit_cost)
          FROM excellent_remix_billing_requests
          WHERE user_id = users.id AND status = 'reserved' AND created_at >= ?
        ), 0) >= ?
    `).run(
      Number(request.credit_cost),
      Number(userId),
      String(requestId),
      Number(brandId),
      String(bucketKey),
      excellentSettleCutoff,
      Number(request.credit_cost),
    );
    if (spend.changes !== 1) throw new Error("积分余额已发生变化，本次趋势未保存，请重新生成。");
    const creditEvent = insertCreditEvent({
      ...(event || {}),
      userId,
      creditDelta: -Number(request.credit_cost),
      creditCost: Number(request.credit_cost),
      payload: { ...(event?.payload || {}), requestId, bucketKey, analysisId },
    });
    const timestamp = new Date().toISOString();
    db.prepare(`
      UPDATE trend_analysis_requests
      SET status = 'completed', analysis_id = ?, credit_event_id = ?, error = '', updated_at = ?
      WHERE request_id = ? AND user_id = ? AND brand_id = ? AND bucket_key = ?
    `).run(Number(analysisId), Number(creditEvent.id), timestamp, requestId, Number(userId), Number(brandId), String(bucketKey));
    try {
      recordTrendAnalysisCompleted({
        requestId,
        userId,
        brandId,
        bucketKey,
        completedAt: timestamp,
      });
    } catch (_) {}
    return { replayed: false, brand: savedBrand, user: findUserById(userId), creditEvent };
  });
}

function failTrendAnalysisRequest({ requestId, userId, brandId, bucketKey, error }) {
  return runTransaction(() => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      UPDATE trend_analysis_requests
      SET status = 'failed', error = ?, updated_at = ?
      WHERE request_id = ? AND user_id = ? AND brand_id = ? AND bucket_key = ? AND status = 'reserved'
    `).run(
      String(error || "trend analysis failed").slice(0, 500),
      timestamp,
      String(requestId),
      Number(userId),
      Number(brandId),
      String(bucketKey),
    );
    try {
      recordTrendAnalysisFailed({
        requestId,
        userId,
        brandId,
        bucketKey,
        error,
        failedAt: timestamp,
      });
    } catch (_) {}
  });
}

module.exports = {
  normalizeRequestId,
  findTrendAnalysisRequest,
  reserveTrendAnalysisRequest,
  completeTrendAnalysisRequest,
  failTrendAnalysisRequest,
};
