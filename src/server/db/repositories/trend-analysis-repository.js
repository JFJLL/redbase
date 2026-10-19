const { getDbProxy } = require("../connection");
const { TREND_ANALYSIS_RESERVATION_TTL_MS, EXCELLENT_BILLING_RESERVATION_TTL_MS, runTransaction } = require("./core-repository");
const { findUserById } = require("./auth-repository");
const { insertCreditEvent, findCreditEventById } = require("./admin-repository");
const { findBrandByOwner, upsertBrandFull } = require("./brand-repository");
const {
  spendCreditsFromLots,
  syncUserCreditsCache,
  migrateLegacyUserCredits,
  reserveCreditsForTask,
  settleCreditsForTask,
  releaseCreditsForTask,
  buildCanonicalTaskKey,
  getUserWalletBalances,
} = require("../../billing/credit-ledger");
const { getNowIso, getNowTimestamp } = require("../../billing/period-utils");
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
           analysis_id, credit_event_id, error, created_at, updated_at, task_key
    FROM trend_analysis_requests
    WHERE request_id = ? AND user_id = ? AND brand_id = ? AND bucket_key = ?
  `).get(String(requestId), Number(userId), Number(brandId), String(bucketKey));
}

function expireStaleReservations(userId, nowMs = getNowTimestamp()) {
  const cutoff = new Date(nowMs - TREND_ANALYSIS_RESERVATION_TTL_MS).toISOString();
  const nowIso = getNowIso();
  const stale = db.prepare(`
    SELECT request_id, brand_id, bucket_key, task_key FROM trend_analysis_requests
    WHERE user_id = ? AND status = 'reserved' AND created_at < ?
  `).all(Number(userId), cutoff);
  for (const row of stale) {
    const canonicalTaskKey = row.task_key || buildCanonicalTaskKey({ userId, taskType: "trend_analysis", taskId: row.request_id, brandId: row.brand_id, bucketKey: row.bucket_key });
    releaseCreditsForTask({
      userId,
      taskKey: canonicalTaskKey,
      taskId: row.request_id,
      taskType: "trend_analysis",
      brandId: row.brand_id,
      bucketKey: row.bucket_key,
      nowIso,
    }, db);
  }
  db.prepare(`
    UPDATE trend_analysis_requests
    SET status = 'failed', error = 'reservation expired', updated_at = ?
    WHERE user_id = ? AND status = 'reserved' AND created_at < ?
  `).run(nowIso, Number(userId), cutoff);
  syncUserCreditsCache(userId, db);
}

function reserveTrendAnalysisRequest({ requestId, userId, brandId, bucketKey, creditCost, now }) {
  return runTransaction(() => {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) return { status: "invalid" };
    const nowMs = now ? now.getTime() : getNowTimestamp();
    const timestamp = now ? now.toISOString() : getNowIso();
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
    const cost = Math.max(0, Number(creditCost || 0));
    const user = findUserById(userId);
    const wallet = getUserWalletBalances(userId, nowMs, db);
    const unmigratedTrend = Number(db.prepare(`
      SELECT COALESCE(SUM(credit_cost), 0) AS total
      FROM trend_analysis_requests r
      WHERE r.user_id = ? AND r.status = 'reserved'
        AND NOT EXISTS (
          SELECT 1 FROM task_credit_reservations t
          WHERE t.task_key = r.task_key
            AND t.status = 'reserved'
        )
    `).get(Number(userId))?.total || 0);

    const unmigratedExcellent = Number(db.prepare(`
      SELECT COALESCE(SUM(credit_cost), 0) AS total
      FROM excellent_remix_billing_requests r
      WHERE r.user_id = ? AND r.status = 'reserved' AND r.created_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM task_credit_reservations t
          WHERE t.task_key = r.task_key
            AND t.status = 'reserved'
        )
    `).get(Number(userId), new Date(nowMs - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString())?.total || 0);

    const effectiveAvailable = wallet.totalAvailable - unmigratedTrend - unmigratedExcellent;
    if (effectiveAvailable < cost) {
      return { status: "insufficient", user: findUserById(userId), reservedCredits: unmigratedTrend + unmigratedExcellent };
    }

    const canonicalTaskKey = buildCanonicalTaskKey({ userId, taskType: "trend_analysis", taskId: normalizedRequestId, brandId, bucketKey });
    if (cost > 0) {
      reserveCreditsForTask({
        userId: Number(userId),
        taskKey: canonicalTaskKey,
        taskId: normalizedRequestId,
        taskType: "trend_analysis",
        brandId,
        bucketKey,
        amount: cost,
        nowIso: timestamp,
      }, db);
    }
    db.prepare(`
      INSERT INTO trend_analysis_requests (
        request_id, user_id, brand_id, bucket_key, status, credit_cost,
        analysis_id, credit_event_id, error, created_at, updated_at, task_key
      ) VALUES (?, ?, ?, ?, 'reserved', ?, NULL, NULL, '', ?, ?, ?)
    `).run(normalizedRequestId, Number(userId), Number(brandId), String(bucketKey), cost, timestamp, timestamp, canonicalTaskKey);
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
      reservedCredits: cost,
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
    const timestamp = getNowIso();
    const cost = Number(request.credit_cost || 0);
    let creditEvent = null;
    const canonicalTaskKey = request.task_key || buildCanonicalTaskKey({ userId, taskType: "trend_analysis", taskId: requestId, brandId, bucketKey });
    if (cost > 0) {
      creditEvent = insertCreditEvent({
        ...(event || {}),
        userId,
        creditDelta: -cost,
        creditCost: cost,
        payload: { ...(event?.payload || {}), requestId, bucketKey, analysisId },
      });
      const settled = settleCreditsForTask({
        userId,
        taskKey: canonicalTaskKey,
        taskId: requestId,
        taskType: "trend_analysis",
        brandId,
        bucketKey,
        creditEventId: creditEvent.id,
        nowIso: timestamp,
      }, db);
      if (!settled || settled.length === 0) {
        throw Object.assign(new Error(`结算任务预占失败，未找到有效预占: ${canonicalTaskKey}`), {
          code: "RESERVATION_SETTLE_FAILED",
        });
      }
      syncUserCreditsCache(userId, db);
    }
    db.prepare(`
      UPDATE trend_analysis_requests
      SET status = 'completed', analysis_id = ?, credit_event_id = ?, error = '', updated_at = ?
      WHERE request_id = ? AND user_id = ? AND brand_id = ? AND bucket_key = ?
    `).run(analysisId ? Number(analysisId) : null, creditEvent ? Number(creditEvent.id) : null, timestamp, requestId, Number(userId), Number(brandId), String(bucketKey));
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
    const existingReq = findTrendAnalysisRequest({ requestId, userId, brandId, bucketKey });
    const timestamp = getNowIso();
    const canonicalTaskKey = existingReq?.task_key || buildCanonicalTaskKey({ userId, taskType: "trend_analysis", taskId: requestId, brandId, bucketKey });
    releaseCreditsForTask({
      userId,
      taskKey: canonicalTaskKey,
      taskId: requestId,
      taskType: "trend_analysis",
      brandId,
      bucketKey,
      nowIso: timestamp,
    }, db);
    syncUserCreditsCache(userId, db);
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
