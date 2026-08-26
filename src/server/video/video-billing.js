const { getDbProxy } = require("../db/connection");
const { runTransaction } = require("../db/repositories/core-repository");
const { findUserById, updateUserCredits } = require("../db/repositories/auth-repository");
const { insertCreditEvent } = require("../db/repositories/admin-repository");

const db = getDbProxy();

function findRefundEvent({ userId, refundKey }) {
  return db.prepare(`
    SELECT id, user_id, credit_delta, credit_cost, payload_json
    FROM credit_events
    WHERE user_id = ?
      AND action_type = 'videoProjectRefund'
      AND json_extract(payload_json, '$.refundKey') = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(Number(userId), String(refundKey || ""));
}

function refundVideoCredits({
  userId,
  amount,
  refundKey,
  reservationCreditEventId,
  refundRange,
  reason,
  generationId,
  brandId,
  trendId,
  ideaTitle,
  projectId,
} = {}) {
  return runTransaction(() => {
    const refundAmount = Math.max(0, Math.floor(Number(amount) || 0));
    const reservationEventId = Number(reservationCreditEventId || 0) || null;
    const range = String(refundRange || "").trim();
    const scopedRefundKey = String(
      refundKey || `video-project:${Number(projectId) || 0}:reservation:${reservationEventId || "unknown"}:range:${range || "full"}`,
    );
    const existing = findRefundEvent({ userId, refundKey: scopedRefundKey });
    if (existing) return { refunded: false, amount: 0, eventId: Number(existing.id) };
    if (!refundAmount) return { refunded: false, amount: 0, eventId: null };
    const user = findUserById(userId);
    if (!user) return { refunded: false, amount: 0, eventId: null };
    updateUserCredits(user.id, Number(user.credits || 0) + refundAmount);
    const event = insertCreditEvent({
      userId: user.id,
      actionType: "videoProjectRefund",
      actionLabel: "AI 视频失败退款",
      creditDelta: refundAmount,
      creditCost: 0,
      generationId: generationId ?? null,
      brandId: brandId ?? null,
      trendId: trendId ?? null,
      ideaTitle: ideaTitle || "",
      channelLabel: "AI 视频",
      summary: `AI 视频任务失败，退还 ${refundAmount} 积分`,
      payload: {
        projectId: Number(projectId) || null,
        reservationCreditEventId: reservationEventId,
        refundRange: range,
        refundKey: scopedRefundKey,
        refundReason: String(reason || "video clip failed").slice(0, 500),
        refundedAt: new Date().toISOString(),
      },
    });
    if (reservationEventId) {
      const totals = db.prepare(`
        SELECT b.credit_cost AS creditCost,
          COALESCE((
            SELECT SUM(CASE WHEN credit_delta > 0 THEN credit_delta ELSE 0 END)
            FROM credit_events
            WHERE user_id = b.user_id
              AND action_type = 'videoProjectRefund'
              AND CAST(json_extract(payload_json, '$.reservationCreditEventId') AS INTEGER) = b.credit_event_id
          ), 0) AS refundedCredits
        FROM video_project_billing_requests b
        WHERE b.credit_event_id = ? AND b.user_id = ?
      `).get(reservationEventId, Number(userId));
      if (totals && Number(totals.refundedCredits) >= Number(totals.creditCost)) {
        db.prepare("UPDATE video_project_billing_requests SET status = 'refunded', updated_at = ? WHERE credit_event_id = ? AND user_id = ?")
          .run(new Date().toISOString(), reservationEventId, Number(userId));
      }
    }
    return { refunded: true, amount: refundAmount, eventId: event?.id || null, refundKey: scopedRefundKey };
  });
}

module.exports = {
  findRefundEvent,
  refundVideoCredits,
};
