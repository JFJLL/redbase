"use strict";

const { getDbProxy, transaction } = require("../db/connection");
const { getNowTimestamp, getNowIso } = require("./period-utils");

function syncUserCreditsCache(userId, db = getDbProxy()) {
  const uid = Number(userId);
  const nowIso = getNowIso();
  const lotCount = db.prepare("SELECT COUNT(*) AS count FROM credit_lots WHERE user_id = ?").get(uid)?.count || 0;
  if (lotCount === 0) {
    const user = db.prepare("SELECT credits FROM users WHERE id = ?").get(uid);
    if (user && user.credits > 0) {
      migrateLegacyUserCredits(uid, db);
    }
  }
  const row = db.prepare(`
    SELECT COALESCE(SUM(remaining_credits - reserved_credits), 0) AS available
    FROM credit_lots
    WHERE user_id = ?
      AND status = 'active'
      AND starts_at <= ?
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(uid, nowIso, nowIso);

  const available = Math.max(0, Number(row?.available || 0));
  db.prepare(`UPDATE users SET credits = ? WHERE id = ?`).run(available, uid);
  return available;
}

function rescanExpiredLots(userId, nowMs = getNowTimestamp(), db = getDbProxy()) {
  const uid = Number(userId);
  const nowIso = new Date(nowMs).toISOString();

  const expiredLots = db.prepare(`
    SELECT id, remaining_credits, reserved_credits
    FROM credit_lots
    WHERE user_id = ?
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).all(uid, nowIso);

  for (const lot of expiredLots) {
    if (lot.reserved_credits <= 0) {
      db.prepare(`UPDATE credit_lots SET status = 'expired', updated_at = ? WHERE id = ?`)
        .run(nowIso, lot.id);
    }
  }

  syncUserCreditsCache(uid, db);
}

function getUserWalletBalances(userId, nowMs = getNowTimestamp(), db = getDbProxy()) {
  const uid = Number(userId);
  migrateLegacyUserCredits(uid, db);
  rescanExpiredLots(uid, nowMs, db);
  const nowIso = new Date(nowMs).toISOString();

  const rows = db.prepare(`
    SELECT id, source_type, source_label, remaining_credits, reserved_credits, expires_at
    FROM credit_lots
    WHERE user_id = ?
      AND status = 'active'
      AND starts_at <= ?
      AND (expires_at IS NULL OR expires_at > ?)
  `).all(uid, nowIso, nowIso);

  let totalAvailable = 0;
  let periodBalance = 0;
  let permanentBalance = 0;
  let legacyBalance = 0;

  for (const row of rows) {
    const unreserved = Math.max(0, row.remaining_credits - row.reserved_credits);
    totalAvailable += unreserved;
    if (row.expires_at === null) {
      permanentBalance += unreserved;
      if (row.source_type === "legacy") {
        legacyBalance += unreserved;
      }
    } else {
      periodBalance += unreserved;
    }
  }

  return {
    totalAvailable,
    periodBalance,
    permanentBalance,
    legacyBalance,
  };
}

function createCreditLot({
  userId,
  sourceType,
  sourceLabel,
  orderId = null,
  subscriptionId = null,
  grantId = null,
  credits,
  startsAt,
  expiresAt = null,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);
  const amount = Number(credits);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`创建积分批次失败：积分数必须为正整数（${credits}）`);
  }

  const result = db.prepare(`
    INSERT INTO credit_lots (
      user_id, source_type, source_label, order_id, subscription_id, grant_id,
      initial_credits, remaining_credits, reserved_credits, used_credits,
      starts_at, expires_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'active', ?, ?)
  `).run(
    uid,
    sourceType,
    sourceLabel,
    orderId,
    subscriptionId,
    grantId,
    amount,
    amount,
    startsAt || nowIso,
    expiresAt || null,
    nowIso,
    nowIso
  );

  syncUserCreditsCache(uid, db);
  return result.lastInsertRowid;
}

function getActiveUsableLotsInFifoOrder(userId, nowIso = getNowIso(), db = getDbProxy()) {
  return db.prepare(`
    SELECT * FROM credit_lots
    WHERE user_id = ?
      AND status = 'active'
      AND starts_at <= ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND remaining_credits > reserved_credits
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC,
      expires_at ASC,
      id ASC
  `).all(Number(userId), nowIso, nowIso);
}

function spendCreditsFromLots({
  userId,
  amount,
  creditEventId,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);
  const cost = Number(amount);
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    return [];
  }

  const lots = getActiveUsableLotsInFifoOrder(uid, nowIso, db);
  let needed = cost;
  const allocations = [];

  for (const lot of lots) {
    if (needed <= 0) break;
    const availableInLot = lot.remaining_credits - lot.reserved_credits;
    if (availableInLot <= 0) continue;

    const take = Math.min(availableInLot, needed);
    const nextRemaining = lot.remaining_credits - take;
    const nextUsed = lot.used_credits + take;
    const nextStatus = nextRemaining === 0 ? "exhausted" : "active";

    db.prepare(`
      UPDATE credit_lots
      SET remaining_credits = ?, used_credits = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRemaining, nextUsed, nextStatus, nowIso, lot.id);

    db.prepare(`
      INSERT INTO credit_lot_allocations (
        credit_event_id, lot_id, user_id, credits_used, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(creditEventId, lot.id, uid, take, nowIso);

    allocations.push({
      lotId: lot.id,
      sourceType: lot.source_type,
      sourceLabel: lot.source_label,
      creditsUsed: take,
    });

    needed -= take;
  }

  if (needed > 0) {
    throw new Error(`可用积分不足：还差 ${needed} 积分`);
  }

  syncUserCreditsCache(uid, db);
  return allocations;
}

function reserveCreditsFromLots({
  userId,
  amount,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);
  const cost = Number(amount);
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    return [];
  }

  const lots = getActiveUsableLotsInFifoOrder(uid, nowIso, db);
  let needed = cost;
  const reservations = [];

  for (const lot of lots) {
    if (needed <= 0) break;
    const availableInLot = lot.remaining_credits - lot.reserved_credits;
    if (availableInLot <= 0) continue;

    const take = Math.min(availableInLot, needed);
    const nextReserved = lot.reserved_credits + take;

    db.prepare(`
      UPDATE credit_lots
      SET reserved_credits = ?, updated_at = ?
      WHERE id = ?
    `).run(nextReserved, nowIso, lot.id);

    reservations.push({
      lotId: lot.id,
      reservedCredits: take,
    });

    needed -= take;
  }

  if (needed > 0) {
    // Rollback partial reservation
    for (const res of reservations) {
      db.prepare(`
        UPDATE credit_lots
        SET reserved_credits = reserved_credits - ?, updated_at = ?
        WHERE id = ?
      `).run(res.reservedCredits, nowIso, res.lotId);
    }
    throw new Error(`可用积分不足以完成预占：需要 ${cost} 积分，缺少 ${needed} 积分`);
  }

  syncUserCreditsCache(uid, db);
  return reservations;
}

function settleReservedCreditsFromLots({
  userId,
  creditEventId,
  reservations,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);
  const allocations = [];

  for (const res of reservations) {
    const lot = db.prepare(`SELECT * FROM credit_lots WHERE id = ?`).get(res.lotId);
    if (!lot) continue;

    const take = Math.min(lot.reserved_credits, res.reservedCredits);
    const nextReserved = Math.max(0, lot.reserved_credits - take);
    const nextRemaining = Math.max(0, lot.remaining_credits - take);
    const nextUsed = lot.used_credits + take;
    const isExpired = lot.expires_at && lot.expires_at <= nowIso;
    const nextStatus = nextRemaining === 0 ? "exhausted" : isExpired && nextReserved === 0 ? "expired" : "active";

    db.prepare(`
      UPDATE credit_lots
      SET reserved_credits = ?, remaining_credits = ?, used_credits = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextReserved, nextRemaining, nextUsed, nextStatus, nowIso, lot.id);

    if (creditEventId) {
      db.prepare(`
        INSERT INTO credit_lot_allocations (
          credit_event_id, lot_id, user_id, credits_used, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(creditEventId, lot.id, uid, take, nowIso);
    }

    allocations.push({
      lotId: lot.id,
      creditsUsed: take,
    });
  }

  syncUserCreditsCache(uid, db);
  return allocations;
}

function releaseReservedCreditsFromLots({
  userId,
  reservations,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);

  for (const res of reservations) {
    const lot = db.prepare(`SELECT * FROM credit_lots WHERE id = ?`).get(res.lotId);
    if (!lot) continue;

    const releaseAmount = Math.min(lot.reserved_credits, res.reservedCredits);
    const nextReserved = Math.max(0, lot.reserved_credits - releaseAmount);
    const isExpired = lot.expires_at && lot.expires_at <= nowIso;
    const nextStatus = lot.remaining_credits === 0 ? "exhausted" : isExpired && nextReserved === 0 ? "expired" : "active";

    db.prepare(`
      UPDATE credit_lots
      SET reserved_credits = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextReserved, nextStatus, nowIso, lot.id);
  }

  syncUserCreditsCache(uid, db);
}

function migrateLegacyUserCredits(userId, db = getDbProxy()) {
  const uid = Number(userId);
  const lotCount = db.prepare(`
    SELECT COUNT(*) AS count FROM credit_lots WHERE user_id = ?
  `).get(uid)?.count || 0;
  if (lotCount > 0) return 0;

  const user = db.prepare(`SELECT id, credits, created_at FROM users WHERE id = ?`).get(uid);
  if (!user || user.credits <= 0) return 0;

  const nowIso = getNowIso();
  createCreditLot({
    userId: uid,
    sourceType: "legacy",
    sourceLabel: "历史保留积分",
    credits: user.credits,
    startsAt: user.created_at || nowIso,
    expiresAt: null, // Permanent!
    nowIso,
  }, db);

  return user.credits;
}

function migrateAllLegacyUsers(db = getDbProxy()) {
  const users = db.prepare(`SELECT id, credits FROM users WHERE credits > 0`).all();
  let migratedCount = 0;
  let migratedCreditsTotal = 0;
  for (const user of users) {
    const migrated = migrateLegacyUserCredits(user.id, db);
    if (migrated > 0) {
      migratedCount++;
      migratedCreditsTotal += migrated;
    }
  }
  return { migratedCount, migratedCreditsTotal };
}

module.exports = {
  syncUserCreditsCache,
  rescanExpiredLots,
  getUserWalletBalances,
  createCreditLot,
  getActiveUsableLotsInFifoOrder,
  spendCreditsFromLots,
  reserveCreditsFromLots,
  settleReservedCreditsFromLots,
  releaseReservedCreditsFromLots,
  migrateLegacyUserCredits,
  migrateAllLegacyUsers,
};
