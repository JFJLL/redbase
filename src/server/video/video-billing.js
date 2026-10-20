const { getDbProxy } = require("../db/connection");
const { runTransaction } = require("../db/repositories/core-repository");
const { findUserById, updateUserCredits } = require("../db/repositories/auth-repository");
const { insertCreditEvent } = require("../db/repositories/admin-repository");
const { createCreditLot, syncUserCreditsCache } = require("../billing/credit-ledger");
const { getNowIso } = require("../billing/period-utils");

const db = getDbProxy();

const VALID_VIDEO_DEBIT_ACTIONS = new Set([
  "videoProject",
  "videoProjectRetry",
]);

function getV13MigrationAppliedAt() {
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!tableExists) return null;
  const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 13").get();
  return row?.applied_at || null;
}

function parseRefundRange(rangeStr) {
  if (!rangeStr) return null;
  const match = String(rangeStr).trim().match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  if (isNaN(start) || isNaN(end) || start > end) return null;
  return { start, end };
}

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

function sumVideoProjectRefundCredits({ userId, projectId } = {}) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN credit_delta > 0 THEN credit_delta ELSE 0 END), 0) AS refunded_credits
    FROM credit_events
    WHERE user_id = ?
      AND action_type = 'videoProjectRefund'
      AND CAST(json_extract(payload_json, '$.projectId') AS INTEGER) = ?
  `).get(Number(userId), Number(projectId));
  return Number(row?.refunded_credits || 0);
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
    const curRange = parseRefundRange(range);
    if (range && !curRange) {
      return { refunded: false, amount: 0, eventId: null, code: "INVALID_REFUND_RANGE" };
    }
    const scopedRefundKey = String(
      refundKey || `video-project:${Number(projectId) || 0}:reservation:${reservationEventId || "unknown"}:range:${range || "full"}`,
    );
    const existing = findRefundEvent({ userId, refundKey: scopedRefundKey });
    if (existing) return { refunded: false, amount: 0, eventId: Number(existing.id) };
    if (!refundAmount) return { refunded: false, amount: 0, eventId: null };
    const user = findUserById(userId);
    if (!user) return { refunded: false, amount: 0, eventId: null };

    if (!reservationEventId) {
      return { refunded: false, amount: 0, eventId: null, code: "MISSING_RESERVATION_EVENT" };
    }

    const nowIso = getNowIso();

    const origEvent = reservationEventId
      ? db.prepare("SELECT id, user_id, action_type, credit_delta, credit_cost, created_at FROM credit_events WHERE id = ?").get(reservationEventId)
      : null;
    if (origEvent && Number(origEvent.user_id) !== Number(user.id)) {
      return { refunded: false, amount: 0, eventId: null, code: "USER_MISMATCH" };
    }
    if (origEvent) {
      if (Number(origEvent.credit_delta || 0) >= 0) {
        return {
          refunded: false,
          amount: 0,
          eventId: null,
          code: "INVALID_ORIGINAL_EVENT",
          reason: `Original event ${reservationEventId} is not a negative debit (creditDelta: ${origEvent.credit_delta})`,
        };
      }
      if (!VALID_VIDEO_DEBIT_ACTIONS.has(origEvent.action_type)) {
        return {
          refunded: false,
          amount: 0,
          eventId: null,
          code: "INVALID_ORIGINAL_EVENT",
          reason: `Original event ${reservationEventId} has non-video action_type: ${origEvent.action_type}`,
        };
      }
    }

    // 2. Fetch original allocation rows (audit preserved, rows never deleted or altered)
    const allocations = db.prepare(`
      SELECT id, credit_event_id, lot_id, user_id, credits_used, created_at
      FROM credit_lot_allocations
      WHERE credit_event_id = ?
      ORDER BY id ASC
    `).all(reservationEventId);

    if (allocations.length === 0) {
      // Missing allocations path: billing request alone is not debit proof.
      // Must have original negative debit event with matching user and video action.
      const billingReq = reservationEventId
        ? db.prepare("SELECT id, user_id, credit_cost, credit_event_id, status FROM video_project_billing_requests WHERE credit_event_id = ?").get(reservationEventId)
        : null;

      if (!origEvent || Number(origEvent.credit_delta || 0) >= 0 || !VALID_VIDEO_DEBIT_ACTIONS.has(origEvent.action_type)) {
        return { refunded: false, amount: 0, eventId: null, code: "NO_CHARGE_EVIDENCE" };
      }
      if (billingReq && Number(billingReq.user_id) !== Number(user.id)) {
        return { refunded: false, amount: 0, eventId: null, code: "USER_MISMATCH" };
      }

      // AFFIRMATIVE pre-V13 check:
      const v13AppliedAt = getV13MigrationAppliedAt();
      const debitCreatedAt = origEvent?.created_at || null;
      const v13Ms = v13AppliedAt ? Date.parse(v13AppliedAt) : NaN;
      const debitMs = debitCreatedAt ? Date.parse(debitCreatedAt) : NaN;
      const isProvenPreV13 = Boolean(
        Number.isFinite(debitMs) &&
        Number.isFinite(v13Ms) &&
        debitMs < v13Ms
      );

      if (!isProvenPreV13) {
        // Unknown or post-V13 provenance MUST audit; never convert unknown provenance to permanent
        if (billingReq) {
          db.prepare("UPDATE video_project_billing_requests SET status = 'audit_required', error = ?, updated_at = ? WHERE id = ?")
            .run("Reservation missing lot allocations requires audit; unproven pre-V13 provenance", nowIso, billingReq.id);
        }
        return {
          refunded: false,
          amount: 0,
          eventId: null,
          code: "POST_V2_MISSING_ALLOCATIONS_AUDIT",
          auditRequired: true,
          reason: `Reservation ${reservationEventId} lacks lot allocations and is not demonstrably pre-V13 (created_at: ${debitCreatedAt}, v13_applied_at: ${v13AppliedAt}); manual audit required`,
        };
      }

      const originalCost = Math.abs(Number(origEvent.credit_delta));
      if (originalCost <= 0) {
        return { refunded: false, amount: 0, eventId: null, code: "NO_CHARGE_EVIDENCE" };
      }

      const priorLegacyRefunds = db.prepare(`
        SELECT id, credit_delta, payload_json
        FROM credit_events
        WHERE user_id = ?
          AND action_type = 'videoProjectRefund'
          AND CAST(json_extract(payload_json, '$.reservationCreditEventId') AS INTEGER) = ?
      `).all(Number(user.id), reservationEventId);

      // Overlap protection on legacy path: malformed or overlapping ranges cannot authorize extra returns
      if (curRange) {
        for (const prior of priorLegacyRefunds) {
          let p = {};
          try { p = JSON.parse(prior.payload_json || "{}"); } catch (_) {}
          const priorRange = parseRefundRange(p.refundRange);
          if (!priorRange || Math.max(curRange.start, priorRange.start) <= Math.min(curRange.end, priorRange.end)) {
            if (billingReq) {
              db.prepare("UPDATE video_project_billing_requests SET status = 'audit_required', error = ?, updated_at = ? WHERE id = ?")
                .run("Overlapping or malformed refund range on legacy reservation requires manual audit", nowIso, billingReq.id);
            }
            return {
              refunded: false,
              amount: 0,
              eventId: null,
              code: "OVERLAPPING_REFUND_RANGE",
              auditRequired: true,
              reason: `Requested refund range ${range} overlaps with prior refunded range for reservation ${reservationEventId}`,
            };
          }
        }
      }

      const totalPreviouslyRefunded = priorLegacyRefunds.reduce((sum, e) => sum + Math.max(0, Number(e.credit_delta || 0)), 0);
      const remainingRefundable = Math.max(0, originalCost - totalPreviouslyRefunded);

      if (refundAmount > remainingRefundable) {
        return {
          refunded: false,
          amount: 0,
          eventId: null,
          code: "OVERREFUND_EXCEEDS_CHARGED",
          reason: `Requested refund ${refundAmount} exceeds remaining legacy refundable balance ${remainingRefundable} for reservation ${reservationEventId}`,
        };
      }

      const compLotId = Number(createCreditLot({
        userId: user.id,
        sourceType: "compensation",
        sourceLabel: "视频任务失败返还",
        credits: refundAmount,
        startsAt: nowIso,
        expiresAt: null,
      }, db));
      syncUserCreditsCache(user.id, db);

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
          refundedAt: nowIso,
          lotRefunds: [{ lotId: compLotId, creditsRestored: refundAmount, legacyCompensation: true }],
          legacyControlledRefund: true,
        },
      });

      if (billingReq) {
        const totalAfter = totalPreviouslyRefunded + refundAmount;
        if (totalAfter >= originalCost) {
          db.prepare(`
            UPDATE video_project_billing_requests
            SET status = 'refunded', updated_at = ?
            WHERE credit_event_id = ? AND user_id = ?
          `).run(nowIso, reservationEventId, Number(user.id));
        }
      }

      return {
        refunded: true,
        amount: refundAmount,
        eventId: event?.id || null,
        refundKey: scopedRefundKey,
        lotRefunds: [{ lotId: compLotId, creditsRestored: refundAmount, legacyCompensation: true }],
      };
    }

    // User scoping check
    if (allocations.some((a) => Number(a.user_id) !== Number(user.id))) {
      return { refunded: false, amount: 0, eventId: null, code: "USER_MISMATCH" };
    }

    // 3. Inspect prior refunds for this reservation event
    const priorRefundEvents = db.prepare(`
      SELECT id, credit_delta, payload_json, created_at
      FROM credit_events
      WHERE user_id = ?
        AND action_type = 'videoProjectRefund'
        AND CAST(json_extract(payload_json, '$.reservationCreditEventId') AS INTEGER) = ?
      ORDER BY id ASC
    `).all(Number(user.id), reservationEventId);

    // Migration-era boundary: if any prior refund lacks per-lot metadata,
    // the buggy historical implementation may have already restored all allocations.
    // Refuse further automated partial refunds to prevent double-restoration.
    for (const prior of priorRefundEvents) {
      let p = {};
      try {
        p = JSON.parse(prior.payload_json || "{}");
      } catch (_) {}
      if (!Array.isArray(p.lotRefunds) || p.lotRefunds.length === 0) {
        const billing = reservationEventId
          ? db.prepare("SELECT id FROM video_project_billing_requests WHERE credit_event_id = ?").get(reservationEventId)
          : null;
        if (billing) {
          db.prepare("UPDATE video_project_billing_requests SET status = 'audit_required', error = ?, updated_at = ? WHERE id = ?")
            .run("Historical refund lacks allocation metadata; audit required", getNowIso(), billing.id);
        }
        return {
          refunded: false,
          amount: 0,
          eventId: null,
          code: "HISTORICAL_REFUND_NEEDS_AUDIT",
          auditRequired: true,
          reason: `Prior refund event ${prior.id} lacks per-lot allocation metadata; manual audit required`,
        };
      }

      // Check for overlapping refund ranges on same original event
      if (curRange) {
        const priorRange = parseRefundRange(p.refundRange);
        const billing = reservationEventId
          ? db.prepare("SELECT id FROM video_project_billing_requests WHERE credit_event_id = ?").get(reservationEventId)
          : null;
        if (!priorRange) {
          if (billing) {
            db.prepare("UPDATE video_project_billing_requests SET status = 'audit_required', error = ?, updated_at = ? WHERE id = ?")
              .run("Prior refund range unknown or malformed; manual audit required", nowIso, billing.id);
          }
          return {
            refunded: false,
            amount: 0,
            eventId: null,
            code: "OVERLAPPING_REFUND_RANGE",
            auditRequired: true,
            reason: `Prior refund event ${prior.id} has malformed or missing refundRange; manual audit required`,
          };
        }
        const overlap = Math.max(curRange.start, priorRange.start) <= Math.min(curRange.end, priorRange.end);
        if (overlap) {
          if (billing) {
            db.prepare("UPDATE video_project_billing_requests SET status = 'audit_required', error = ?, updated_at = ? WHERE id = ?")
              .run("Overlapping refund range requires manual audit", nowIso, billing.id);
          }
          return {
            refunded: false,
            amount: 0,
            eventId: null,
            code: "OVERLAPPING_REFUND_RANGE",
            auditRequired: true,
            reason: `Requested refund range ${range} overlaps with prior refunded range ${p.refundRange} for reservation ${reservationEventId}`,
          };
        }
      }
    }

    // 4. Calculate previously refunded amounts per lot
    const refundedByLot = new Map();
    for (const prior of priorRefundEvents) {
      let p = {};
      try {
        p = JSON.parse(prior.payload_json || "{}");
      } catch (_) {}
      for (const item of p.lotRefunds || []) {
        const lid = Number(item.lotId);
        const restored = Number(item.creditsRestored || 0);
        refundedByLot.set(lid, (refundedByLot.get(lid) || 0) + restored);
      }
    }

    const lotChargedMap = new Map();
    for (const alloc of allocations) {
      const lid = Number(alloc.lot_id);
      lotChargedMap.set(lid, (lotChargedMap.get(lid) || 0) + Number(alloc.credits_used || 0));
    }

    const totalCharged = Array.from(lotChargedMap.values()).reduce((sum, v) => sum + v, 0);
    const totalPreviouslyRefunded = Array.from(refundedByLot.values()).reduce((sum, v) => sum + v, 0);
    const remainingRefundable = Math.max(0, totalCharged - totalPreviouslyRefunded);

    if (refundAmount > remainingRefundable) {
      return {
        refunded: false,
        amount: 0,
        eventId: null,
        code: "OVERREFUND_EXCEEDS_CHARGED",
        reason: `Requested refund ${refundAmount} exceeds remaining refundable balance ${remainingRefundable} for reservation ${reservationEventId}`,
      };
    }

    // 5. Distribute requested refund over original charged lots in reverse allocation order (LIFO)
    let remainingToDistribute = refundAmount;
    const lotRestorations = [];

    const reversedAllocations = allocations.slice().reverse();
    const seenLotIds = new Set();
    const lotOrder = [];
    for (const alloc of reversedAllocations) {
      const lid = Number(alloc.lot_id);
      if (!seenLotIds.has(lid)) {
        seenLotIds.add(lid);
        lotOrder.push(lid);
      }
    }

    for (const lid of lotOrder) {
      if (remainingToDistribute <= 0) break;
      const charged = lotChargedMap.get(lid) || 0;
      const alreadyRefunded = refundedByLot.get(lid) || 0;
      const headroom = Math.max(0, charged - alreadyRefunded);
      if (headroom <= 0) continue;

      const take = Math.min(headroom, remainingToDistribute);
      lotRestorations.push({ lotId: lid, creditsRestored: take });
      remainingToDistribute -= take;
    }

    if (remainingToDistribute > 0) {
      throw new Error(`Failed to allocate entire refund amount across original lots for reservation ${reservationEventId}`);
    }

    // 6. Update credit lots atomically
    const expiredLotsToAccount = [];

    for (const item of lotRestorations) {
      const lot = db.prepare("SELECT * FROM credit_lots WHERE id = ? AND user_id = ?").get(item.lotId, Number(user.id));
      if (!lot) {
        throw new Error(`Credit lot ${item.lotId} not found for user ${user.id}`);
      }

      const isExpired = Boolean(lot.expires_at && lot.expires_at <= nowIso);
      const nextUsed = Math.max(0, lot.used_credits - item.creditsRestored);

      if (isExpired) {
        // Expired lot: used_credits is reduced, but remaining_credits must not be inflated into active balance.
        // An explicit cycle_expire event is inserted atomically below for exact ledger conservation.
        db.prepare(`
          UPDATE credit_lots
          SET used_credits = ?,
              status = 'expired',
              updated_at = ?
          WHERE id = ?
        `).run(nextUsed, nowIso, item.lotId);

        expiredLotsToAccount.push({ lotId: item.lotId, sourceType: lot.source_type, credits: item.creditsRestored });
      } else {
        const nextRemaining = lot.remaining_credits + item.creditsRestored;
        const nextStatus = nextRemaining === 0 ? "exhausted" : "active";
        db.prepare(`
          UPDATE credit_lots
          SET remaining_credits = ?,
              used_credits = ?,
              status = ?,
              updated_at = ?
          WHERE id = ?
        `).run(nextRemaining, nextUsed, nextStatus, nowIso, item.lotId);
      }
    }

    // 7. Sync user's active credits cache (does not count expired lots)
    syncUserCreditsCache(user.id, db);

    // 8. Record the videoProjectRefund credit event with lotRefunds payload
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
        refundedAt: nowIso,
        lotRefunds: lotRestorations,
      },
    });

    // 8b. For any expired lot restorations, insert explicit cycle_expire events atomically
    for (const exp of expiredLotsToAccount) {
      const expireIdempotencyKey = `lot_expire:video_refund:${exp.lotId}:${scopedRefundKey}`;
      insertCreditEvent({
        userId: user.id,
        actionType: "cycle_expire",
        actionLabel: "周期积分到期",
        creditDelta: -exp.credits,
        creditCost: 0,
        createdAt: nowIso,
        summary: `视频退款后已过期周期积分失效 ${exp.credits} 积分`,
        payload: {
          lotId: exp.lotId,
          sourceType: exp.sourceType,
          refundKey: scopedRefundKey,
          reservationCreditEventId: reservationEventId,
          idempotencyKey: expireIdempotencyKey,
          reason: "video_refund_expired",
        },
      });
    }

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
          .run(nowIso, reservationEventId, Number(userId));
      }
    }
    return { refunded: true, amount: refundAmount, eventId: event?.id || null, refundKey: scopedRefundKey, lotRefunds: lotRestorations };
  });
}

module.exports = {
  findRefundEvent,
  refundVideoCredits,
  sumVideoProjectRefundCredits,
};
