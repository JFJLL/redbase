const crypto = require("crypto");
const { getDbProxy } = require("../connection");
const {
  TREND_ANALYSIS_RESERVATION_TTL_MS,
  EXCELLENT_BILLING_RESERVATION_TTL_MS,
  runTransaction,
} = require("./core-repository");
const { findUserById } = require("./auth-repository");
const { insertCreditEvent, findCreditEventById } = require("./admin-repository");

const db = getDbProxy();

const EXCELLENT_BILLING_KIND_DIRECTION = "direction";
const EXCELLENT_BILLING_KIND_FUSION = "fusion";
// Rolling free window for content directions: first N model successes are free.
const DIRECTION_FREE_WINDOW_MS = 5 * 60 * 1000;
const DIRECTION_FREE_LIMIT = 3;
// Same-input results replay for free within this window.
const EXCELLENT_BILLING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const BILLING_COLUMNS = `
  request_id, user_id, kind, input_signature, status, credit_cost, counted, cache_hit,
  result_source, result_json, credit_event_id, error, created_at, completed_at, updated_at
`;

function normalizeExcellentBillingRequestId(value) {
  const requestId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return "";
  return requestId;
}

function normalizeSignatureValue(value) {
  if (Array.isArray(value)) return value.map(normalizeSignatureValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeSignatureValue(child)]),
  );
}

function buildExcellentBillingSignature(input) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeSignatureValue(input || {})), "utf8").digest("hex");
}

function parseResultJson(row) {
  if (!row || !row.result_json) return null;
  try {
    return JSON.parse(row.result_json);
  } catch (_error) {
    return null;
  }
}

function findExcellentBillingRequest({ requestId, userId, kind }) {
  return db.prepare(`
    SELECT ${BILLING_COLUMNS}
    FROM excellent_remix_billing_requests
    WHERE request_id = ? AND user_id = ? AND kind = ?
  `).get(String(requestId), Number(userId), String(kind));
}

function expireStaleExcellentBillingReservations(userId, nowMs) {
  const cutoff = new Date(nowMs - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString();
  db.prepare(`
    UPDATE excellent_remix_billing_requests
    SET status = 'failed', error = 'reservation expired', updated_at = ?
    WHERE user_id = ? AND status = 'reserved' AND created_at < ?
  `).run(new Date(nowMs).toISOString(), Number(userId), cutoff);
}

/** Successful non-cache model generations inside the rolling 5-minute window. */
function countDirectionSuccessesInWindow(userId, nowMs) {
  const cutoff = new Date(nowMs - DIRECTION_FREE_WINDOW_MS).toISOString();
  return Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM excellent_remix_billing_requests
    WHERE user_id = ? AND kind = ? AND status = 'completed' AND counted = 1 AND completed_at >= ?
  `).get(Number(userId), EXCELLENT_BILLING_KIND_DIRECTION, cutoff)?.total || 0);
}

/** In-flight direction generations also occupy free slots so concurrency cannot double-claim them. */
function countReservedDirectionAttempts(userId, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString();
  return Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM excellent_remix_billing_requests
    WHERE user_id = ? AND kind = ? AND status = 'reserved' AND counted = 1 AND created_at >= ?
  `).get(Number(userId), EXCELLENT_BILLING_KIND_DIRECTION, cutoff)?.total || 0);
}

function sumReservedExcellentBillingCredits(userId, excludeRequest = null) {
  if (excludeRequest) {
    return Number(db.prepare(`
      SELECT COALESCE(SUM(credit_cost), 0) AS total
      FROM excellent_remix_billing_requests
      WHERE user_id = ? AND status = 'reserved'
        AND NOT (request_id = ? AND kind = ?)
    `).get(Number(userId), String(excludeRequest.requestId), String(excludeRequest.kind))?.total || 0);
  }
  return Number(db.prepare(`
    SELECT COALESCE(SUM(credit_cost), 0) AS total
    FROM excellent_remix_billing_requests
    WHERE user_id = ? AND status = 'reserved'
  `).get(Number(userId))?.total || 0);
}

function sumReservedTrendCredits(userId, nowMs = Date.now()) {
  // Align with trySpendCreditsWithEvent: stale trend reservations must not block billing forever.
  const cutoff = new Date(nowMs - TREND_ANALYSIS_RESERVATION_TTL_MS).toISOString();
  return Number(db.prepare(`
    SELECT COALESCE(SUM(credit_cost), 0) AS total
    FROM trend_analysis_requests
    WHERE user_id = ? AND status = 'reserved' AND created_at >= ?
  `).get(Number(userId), cutoff)?.total || 0);
}

/** Latest same-input model success within 24h — replays for free. */
function findCachedExcellentBillingResult({ userId, kind, inputSignature, nowMs }) {
  const cutoff = new Date(nowMs - EXCELLENT_BILLING_CACHE_TTL_MS).toISOString();
  const row = db.prepare(`
    SELECT ${BILLING_COLUMNS}
    FROM excellent_remix_billing_requests
    WHERE user_id = ? AND kind = ? AND input_signature = ?
      AND status = 'completed' AND result_source = 'model' AND result_json <> ''
      AND completed_at >= ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(Number(userId), String(kind), String(inputSignature), cutoff);
  if (!row) return null;
  const result = parseResultJson(row);
  return result ? { row, result } : null;
}

/**
 * Reserve a billing slot before any model call. Statuses:
 * - invalid: requestId is malformed
 * - replay: this requestId already completed — return stored result, never re-charge
 * - pending: same requestId still reserved (concurrent duplicate)
 * - cache: same-input 24h hit — recorded as a free completed row
 * - insufficient: charging is required but balance (minus reservations) cannot cover it
 * - reserved: caller may run the model; `willCharge` says whether success costs credits
 */
function reserveExcellentBillingRequest({
  requestId,
  userId,
  kind,
  inputSignature,
  creditCost,
  forceRegenerate = false,
  now = new Date(),
}) {
  return runTransaction(() => {
    const normalizedRequestId = normalizeExcellentBillingRequestId(requestId);
    if (!normalizedRequestId) return { status: "invalid" };
    const nowMs = now.getTime();
    expireStaleExcellentBillingReservations(userId, nowMs);

    const existing = findExcellentBillingRequest({ requestId: normalizedRequestId, userId, kind });
    if (existing && existing.input_signature !== String(inputSignature)) {
      return { status: "conflict", request: existing, user: findUserById(userId) };
    }
    if (existing && existing.status === "completed") {
      return {
        status: "replay",
        request: existing,
        result: parseResultJson(existing),
        user: findUserById(userId),
        creditEvent: existing.credit_event_id ? findCreditEventById(existing.credit_event_id) : null,
      };
    }
    if (existing && existing.status === "reserved") {
      return { status: "pending", request: existing, user: findUserById(userId) };
    }

    if (!forceRegenerate) {
      const cached = findCachedExcellentBillingResult({ userId, kind, inputSignature, nowMs });
      if (cached) {
        const timestamp = now.toISOString();
        db.prepare(`
          INSERT INTO excellent_remix_billing_requests (
            request_id, user_id, kind, input_signature, status, credit_cost, counted, cache_hit,
            result_source, result_json, credit_event_id, error, created_at, completed_at, updated_at
          ) VALUES (?, ?, ?, ?, 'completed', 0, 0, 1, 'cache', ?, NULL, '', ?, ?, ?)
          ON CONFLICT(request_id, user_id, kind) DO UPDATE SET
            status = 'completed', credit_cost = 0, counted = 0, cache_hit = 1,
            result_source = 'cache', result_json = excluded.result_json,
            error = '', completed_at = excluded.completed_at, updated_at = excluded.updated_at
        `).run(
          normalizedRequestId,
          Number(userId),
          String(kind),
          String(inputSignature),
          cached.row.result_json,
          timestamp,
          timestamp,
          timestamp,
        );
        return {
          status: "cache",
          result: cached.result,
          user: findUserById(userId),
          windowCount: countDirectionSuccessesInWindow(userId, nowMs),
        };
      }
    }

    let cost = Math.max(0, Number(creditCost || 0));
    let windowFreeUsed = 0;
    if (kind === EXCELLENT_BILLING_KIND_DIRECTION) {
      windowFreeUsed = countDirectionSuccessesInWindow(userId, nowMs) + countReservedDirectionAttempts(userId, nowMs);
      if (windowFreeUsed < DIRECTION_FREE_LIMIT) cost = 0;
    }

    const user = findUserById(userId);
    if (!user) return { status: "invalid" };
    if (cost > 0) {
      const reserved = sumReservedExcellentBillingCredits(userId) + sumReservedTrendCredits(userId, nowMs);
      if (Number(user.credits || 0) - reserved < cost) {
        return { status: "insufficient", user, requiredCredits: cost, reservedCredits: reserved };
      }
    }

    const timestamp = now.toISOString();
    const counted = kind === EXCELLENT_BILLING_KIND_DIRECTION ? 1 : 0;
    db.prepare(`
      INSERT INTO excellent_remix_billing_requests (
        request_id, user_id, kind, input_signature, status, credit_cost, counted, cache_hit,
        result_source, result_json, credit_event_id, error, created_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'reserved', ?, ?, 0, '', '', NULL, '', ?, '', ?)
      ON CONFLICT(request_id, user_id, kind) DO UPDATE SET
        status = 'reserved', input_signature = excluded.input_signature,
        credit_cost = excluded.credit_cost, counted = excluded.counted, cache_hit = 0,
        result_source = '', result_json = '', credit_event_id = NULL, error = '',
        created_at = excluded.created_at, completed_at = '', updated_at = excluded.updated_at
    `).run(
      normalizedRequestId,
      Number(userId),
      String(kind),
      String(inputSignature),
      cost,
      counted,
      timestamp,
      timestamp,
    );
    return {
      status: "reserved",
      request: findExcellentBillingRequest({ requestId: normalizedRequestId, userId, kind }),
      willCharge: cost > 0,
      creditCost: cost,
      user,
      windowFreeUsed,
    };
  });
}

/**
 * Settle a reserved request after the model returned.
 * resultSource 'model': counts (directions), charges the reserved cost atomically, records the credit event.
 * resultSource 'fallback': completes for free — no count, no charge, never cached for replay-by-input.
 */
function settleExcellentBillingRequest({
  requestId,
  userId,
  kind,
  inputSignature,
  reservationToken,
  resultSource,
  resultJson,
  event,
  now = new Date(),
}) {
  const outcome = runTransaction(() => {
    const request = findExcellentBillingRequest({ requestId, userId, kind });
    if (!request) throw new Error("计费请求不存在或已过期，请重新生成。");
    if (
      request.input_signature !== String(inputSignature || "") ||
      request.created_at !== String(reservationToken || "")
    ) {
      const error = new Error("计费请求已被新的生成尝试替代，请重试。");
      error.code = "STALE_BILLING_ATTEMPT";
      error.statusCode = 409;
      throw error;
    }
    if (request.status === "completed") {
      return {
        replayed: true,
        charged: false,
        user: findUserById(userId),
        creditEvent: request.credit_event_id ? findCreditEventById(request.credit_event_id) : null,
        windowCount: countDirectionSuccessesInWindow(userId, now.getTime()),
      };
    }
    if (request.status !== "reserved") throw new Error("计费请求状态已失效，请重新生成。");

    const isModelResult = resultSource === "model";
    const cost = isModelResult ? Number(request.credit_cost || 0) : 0;
    let creditEvent = null;
    if (cost > 0) {
      const trendCutoff = new Date(now.getTime() - TREND_ANALYSIS_RESERVATION_TTL_MS).toISOString();
      const excellentCutoff = new Date(now.getTime() - EXCELLENT_BILLING_RESERVATION_TTL_MS).toISOString();
      const spend = db.prepare(`
        UPDATE users SET credits = credits - ?
        WHERE id = ?
          AND credits - COALESCE((
            SELECT SUM(credit_cost) FROM excellent_remix_billing_requests
            WHERE user_id = users.id AND status = 'reserved' AND created_at >= ?
              AND NOT (request_id = ? AND kind = ?)
          ), 0) - COALESCE((
            SELECT SUM(credit_cost) FROM trend_analysis_requests
            WHERE user_id = users.id AND status = 'reserved' AND created_at >= ?
          ), 0) >= ?
      `).run(cost, Number(userId), excellentCutoff, String(requestId), String(kind), trendCutoff, cost);
      if (spend.changes !== 1) {
        // Mark failed inside this transaction, then report the error after commit
        // so the status update is not rolled back by the throw.
        db.prepare(`
          UPDATE excellent_remix_billing_requests
          SET status = 'failed', error = 'insufficient credits at settle', updated_at = ?
          WHERE request_id = ? AND user_id = ? AND kind = ?
        `).run(now.toISOString(), String(requestId), Number(userId), String(kind));
        return { insufficientAtSettle: true };
      }
      creditEvent = insertCreditEvent({
        ...(event || {}),
        userId,
        creditDelta: -cost,
        creditCost: cost,
        payload: { ...(event?.payload || {}), requestId, billingKind: kind },
      });
    }

    const timestamp = now.toISOString();
    const counted = isModelResult && kind === EXCELLENT_BILLING_KIND_DIRECTION ? 1 : 0;
    db.prepare(`
      UPDATE excellent_remix_billing_requests
      SET status = 'completed', counted = ?, credit_cost = ?, result_source = ?, result_json = ?,
          credit_event_id = ?, error = '', completed_at = ?, updated_at = ?
      WHERE request_id = ? AND user_id = ? AND kind = ?
    `).run(
      counted,
      cost,
      isModelResult ? "model" : "fallback",
      String(resultJson || ""),
      creditEvent ? Number(creditEvent.id) : null,
      timestamp,
      timestamp,
      String(requestId),
      Number(userId),
      String(kind),
    );
    return {
      replayed: false,
      charged: cost > 0,
      creditCost: cost,
      user: findUserById(userId),
      creditEvent,
      windowCount: countDirectionSuccessesInWindow(userId, now.getTime()),
    };
  });
  if (outcome && outcome.insufficientAtSettle) {
    const error = new Error("积分余额已发生变化，本次结果未保存，请重新生成。");
    error.code = "INSUFFICIENT_CREDITS";
    error.statusCode = 402;
    throw error;
  }
  return outcome;
}

/** Model errors / invalid output: release the reservation without charging or counting. */
function failExcellentBillingRequest({
  requestId,
  userId,
  kind,
  inputSignature,
  reservationToken,
  error,
  now = new Date(),
}) {
  return runTransaction(() => {
    db.prepare(`
      UPDATE excellent_remix_billing_requests
      SET status = 'failed', credit_cost = 0, counted = 0, error = ?, updated_at = ?
      WHERE request_id = ? AND user_id = ? AND kind = ? AND input_signature = ? AND created_at = ? AND status = 'reserved'
    `).run(
      String(error || "excellent billing request failed").slice(0, 500),
      now.toISOString(),
      String(requestId),
      Number(userId),
      String(kind),
      String(inputSignature || ""),
      String(reservationToken || ""),
    );
  });
}

/** Snapshot for API responses: how many window slots are used and whether the next run costs credits. */
function getDirectionBillingSnapshot(userId, now = new Date()) {
  const windowCount = countDirectionSuccessesInWindow(userId, now.getTime());
  // In-flight generations already hold free slots, so the "next run" forecast counts them too.
  const inFlight = countReservedDirectionAttempts(userId, now.getTime());
  return {
    windowCount,
    freeLimit: DIRECTION_FREE_LIMIT,
    windowMs: DIRECTION_FREE_WINDOW_MS,
    nextChargeable: windowCount + inFlight >= DIRECTION_FREE_LIMIT,
  };
}

module.exports = {
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
  EXCELLENT_BILLING_RESERVATION_TTL_MS,
  DIRECTION_FREE_WINDOW_MS,
  DIRECTION_FREE_LIMIT,
  EXCELLENT_BILLING_CACHE_TTL_MS,
  normalizeExcellentBillingRequestId,
  buildExcellentBillingSignature,
  findExcellentBillingRequest,
  findCachedExcellentBillingResult,
  countDirectionSuccessesInWindow,
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  getDirectionBillingSnapshot,
};
