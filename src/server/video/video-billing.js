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

function refundVideoCredits({ userId, amount, refundKey, reason, generationId, brandId, trendId, ideaTitle, projectId } = {}) {
  return runTransaction(() => {
    const refundAmount = Math.max(0, Math.floor(Number(amount) || 0));
    const existing = findRefundEvent({ userId, refundKey });
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
        refundKey: String(refundKey || ""),
        refundReason: String(reason || "video clip failed").slice(0, 500),
        refundedAt: new Date().toISOString(),
      },
    });
    return { refunded: true, amount: refundAmount, eventId: event?.id || null };
  });
}

module.exports = {
  findRefundEvent,
  refundVideoCredits,
};
