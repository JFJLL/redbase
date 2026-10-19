"use strict";

const { getDbProxy, transaction } = require("../db/connection");
const { getNowTimestamp, getNowIso } = require("./period-utils");
const { allocateCounter } = require("../db/repositories/core-repository");

function insertLedgerCreditEvent(db, {
  userId,
  actionType,
  actionLabel,
  creditDelta,
  creditCost = 0,
  createdAt,
  summary = "",
  payload = {},
}) {
  const eventId = allocateCounter("nextCreditEventId", 1);
  db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost,
      created_at, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    Number(userId),
    actionType,
    actionLabel,
    Number(creditDelta || 0),
    Number(creditCost || 0),
    createdAt || getNowIso(),
    summary,
    JSON.stringify(payload || {})
  );
  return { id: eventId };
}

function syncUserCreditsCache(userId, db = getDbProxy()) {
  const uid = Number(userId);
  migrateLegacyUserCredits(uid, db);
  const nowIso = getNowIso();
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
    SELECT id, remaining_credits, reserved_credits, source_type, source_label
    FROM credit_lots
    WHERE user_id = ?
      AND (status = 'active' OR (status = 'expired' AND remaining_credits > 0))
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).all(uid, nowIso);

  for (const lot of expiredLots) {
    transaction(() => {
      if (lot.reserved_credits <= 0) {
        const toExpire = lot.remaining_credits;
        db.prepare(`UPDATE credit_lots SET remaining_credits = 0, status = 'expired', updated_at = ? WHERE id = ?`)
          .run(nowIso, lot.id);

        if (toExpire > 0) {
          insertLedgerCreditEvent(db, {
            userId: uid,
            actionType: "cycle_expire",
            actionLabel: "周期积分到期",
            creditDelta: -toExpire,
            creditCost: 0,
            createdAt: nowIso,
            summary: `周期积分到期失效 ${toExpire} 积分`,
            payload: {
              lotId: lot.id,
              sourceType: lot.source_type,
              expiredCredits: toExpire,
              reason: "full_cycle_expired",
            },
          });
        }
      } else {
        const unreserved = Math.max(0, lot.remaining_credits - lot.reserved_credits);
        if (unreserved > 0) {
          db.prepare(`
            UPDATE credit_lots
            SET remaining_credits = reserved_credits, updated_at = ?
            WHERE id = ?
          `).run(nowIso, lot.id);

          insertLedgerCreditEvent(db, {
            userId: uid,
            actionType: "cycle_expire",
            actionLabel: "周期积分到期",
            creditDelta: -unreserved,
            creditCost: 0,
            createdAt: nowIso,
            summary: `周期积分未预占部分到期失效 ${unreserved} 积分`,
            payload: {
              lotId: lot.id,
              sourceType: lot.source_type,
              expiredCredits: unreserved,
              reason: "unreserved_cycle_expired",
            },
          });
        }
      }
    })();
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

  // Ensure unmigrated legacy credits are safely migrated BEFORE inserting any new lot!
  if (sourceType !== "legacy") {
    migrateLegacyUserCredits(uid, db);
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

  migrateLegacyUserCredits(uid, db);
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

  migrateLegacyUserCredits(uid, db);
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
  taskKey = "",
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  const uid = Number(userId);

  for (const res of reservations) {
    const lot = db.prepare(`SELECT * FROM credit_lots WHERE id = ? AND user_id = ?`).get(res.lotId, uid);
    if (!lot) continue;

    const releaseAmount = Math.min(lot.reserved_credits, res.reservedCredits);
    if (releaseAmount <= 0) continue;

    const nextReserved = Math.max(0, lot.reserved_credits - releaseAmount);
    const isExpired = Boolean(lot.expires_at && lot.expires_at <= nowIso);

    if (isExpired) {
      const nextRemaining = Math.max(0, lot.remaining_credits - releaseAmount);
      const nextStatus = nextRemaining === 0 ? "exhausted" : nextReserved === 0 ? "expired" : "active";

      db.prepare(`
        UPDATE credit_lots
        SET reserved_credits = ?, remaining_credits = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(nextReserved, nextRemaining, nextStatus, nowIso, lot.id);

      insertLedgerCreditEvent(db, {
        userId: uid,
        actionType: "cycle_expire",
        actionLabel: "周期积分到期",
        creditDelta: -releaseAmount,
        creditCost: 0,
        createdAt: nowIso,
        summary: `任务释放后已过期失效 ${releaseAmount} 积分`,
        payload: {
          lotId: lot.id,
          sourceType: lot.source_type,
          expiredCredits: releaseAmount,
          taskKey: String(taskKey || ""),
          reason: "task_release_expired",
        },
      });
    } else {
      const nextStatus = lot.remaining_credits === 0 ? "exhausted" : "active";
      db.prepare(`
        UPDATE credit_lots
        SET reserved_credits = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(nextReserved, nextStatus, nowIso, lot.id);
    }
  }

  syncUserCreditsCache(uid, db);
}

function migrateLegacyUserCredits(userId, db = getDbProxy()) {
  const uid = Number(userId);
  const user = db.prepare(`
    SELECT id, credits, legacy_credits_migrated, created_at FROM users WHERE id = ?
  `).get(uid);
  if (!user) return 0;
  if (user.legacy_credits_migrated === 1) return 0;

  const lotStats = db.prepare(`
    SELECT COUNT(*) AS total_lots,
           SUM(CASE WHEN source_type = 'legacy' THEN 1 ELSE 0 END) AS legacy_lots
    FROM credit_lots WHERE user_id = ?
  `).get(uid);
  if (lotStats && lotStats.total_lots > 0) {
    db.prepare(`UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?`).run(uid);
    return 0;
  }

  const credits = Number(user.credits || 0);
  const nowIso = getNowIso();
  if (credits > 0) {
    const lotResult = db.prepare(`
      INSERT INTO credit_lots (
        user_id, source_type, source_label, order_id, subscription_id, grant_id,
        initial_credits, remaining_credits, reserved_credits, used_credits,
        starts_at, expires_at, status, created_at, updated_at
      ) VALUES (?, 'legacy', '历史保留积分', NULL, NULL, NULL, ?, ?, 0, 0, ?, NULL, 'active', ?, ?)
    `).run(uid, credits, credits, user.created_at || nowIso, nowIso, nowIso);

    insertLedgerCreditEvent(db, {
      userId: uid,
      actionType: "legacy_migration",
      actionLabel: "历史积分结转",
      creditDelta: 0,
      creditCost: 0,
      createdAt: nowIso,
      summary: `历史有效积分结转为永久积分（${credits} 积分）`,
      payload: { lotId: lotResult.lastInsertRowid, originalCredits: credits },
    });
  }

  db.prepare(`UPDATE users SET legacy_credits_migrated = 1 WHERE id = ?`).run(uid);
  syncUserCreditsCache(uid, db);
  return credits;
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

function buildCanonicalTaskKey({ userId, taskType = "task", taskId, brandId, bucketKey, taskKey }) {
  if (taskKey) return String(taskKey);
  const uid = Number(userId);
  const type = String(taskType);
  const tid = String(taskId);
  if (type === "trend_analysis" || brandId !== undefined || bucketKey !== undefined) {
    const bId = brandId !== undefined ? String(brandId) : "";
    const bKey = bucketKey !== undefined ? String(bucketKey) : "";
    return `trend_analysis:${uid}:${bId}:${bKey}:${tid}`;
  }
  return `${type}:${uid}:${tid}`;
}

function ensureTaskReservationTable(db = getDbProxy()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_credit_reservations (
      task_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      lot_id INTEGER NOT NULL,
      reserved_credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_key, lot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_res_user_status ON task_credit_reservations(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_res_key_status ON task_credit_reservations(task_key, status);
    CREATE INDEX IF NOT EXISTS idx_task_res_task ON task_credit_reservations(task_id);
  `);
  const cols = db.prepare("PRAGMA table_info(task_credit_reservations)").all().map((c) => c.name);
  if (!cols.includes("task_key")) {
    db.exec("ALTER TABLE task_credit_reservations ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE task_credit_reservations SET task_key = task_type || ':' || user_id || ':' || task_id WHERE task_key = ''");
    db.exec("CREATE INDEX IF NOT EXISTS idx_task_res_key_status ON task_credit_reservations(task_key, status)");
  }
}

function reserveCreditsForTask({
  userId,
  taskId,
  taskType = "task",
  taskKey,
  brandId,
  bucketKey,
  amount,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  ensureTaskReservationTable(db);
  const uid = Number(userId);
  const cost = Number(amount);
  if (!Number.isSafeInteger(cost) || cost <= 0) return [];
  const canonicalKey = buildCanonicalTaskKey({ userId: uid, taskType, taskId, brandId, bucketKey, taskKey });

  const existing = db.prepare(`
    SELECT lot_id AS lotId, reserved_credits AS reservedCredits, status, user_id, task_type
    FROM task_credit_reservations
    WHERE task_key = ?
  `).all(canonicalKey);
  if (existing && existing.length > 0) {
    const isAllReserved = existing.every((r) => r.status === "reserved");
    if (isAllReserved) {
      const totalReserved = existing.reduce((sum, r) => sum + r.reservedCredits, 0);
      if (totalReserved === cost && Number(existing[0].user_id) === uid && existing[0].task_type === taskType) {
        return existing.map((r) => ({ lotId: r.lotId, reservedCredits: r.reservedCredits }));
      }
      throw Object.assign(new Error("任务预占参数冲突：同一任务已存在不同金额或类型的预占"), { code: "RESERVATION_CONFLICT" });
    }
    const hasSettled = existing.some((r) => r.status === "settled");
    if (hasSettled) {
      throw Object.assign(new Error("任务预占已处于终态，不能重新预占"), { code: "RESERVATION_TERMINAL" });
    }
    db.prepare(`DELETE FROM task_credit_reservations WHERE task_key = ? AND status = 'released'`).run(canonicalKey);
  }

  const reservations = reserveCreditsFromLots({ userId: uid, amount: cost, nowIso }, db);
  const insertStmt = db.prepare(`
    INSERT INTO task_credit_reservations (
      task_key, user_id, task_type, task_id, lot_id, reserved_credits, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
  `);
  for (const r of reservations) {
    insertStmt.run(canonicalKey, uid, taskType, String(taskId), r.lotId, r.reservedCredits, nowIso, nowIso);
  }
  return reservations;
}

function settleCreditsForTask({
  userId,
  taskId,
  taskType = "task",
  taskKey,
  brandId,
  bucketKey,
  creditEventId,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  ensureTaskReservationTable(db);
  const uid = Number(userId);
  const canonicalKey = buildCanonicalTaskKey({ userId: uid, taskType, taskId, brandId, bucketKey, taskKey });
  let reservedRows = db.prepare(`
    SELECT lot_id AS lotId, reserved_credits AS reservedCredits, user_id
    FROM task_credit_reservations
    WHERE task_key = ? AND status = 'reserved'
  `).all(canonicalKey);

  if (!reservedRows || reservedRows.length === 0) {
    reservedRows = db.prepare(`
      SELECT lot_id AS lotId, reserved_credits AS reservedCredits, user_id
      FROM task_credit_reservations
      WHERE user_id = ? AND task_id = ? AND status = 'reserved'
    `).all(uid, String(taskId));
  }

  if (!reservedRows || reservedRows.length === 0) {
    const alreadySettled = db.prepare(`
      SELECT lot_id AS lotId, reserved_credits AS reservedCredits
      FROM task_credit_reservations
      WHERE (task_key = ? OR (user_id = ? AND task_id = ?)) AND status = 'settled'
    `).all(canonicalKey, uid, String(taskId));
    if (alreadySettled && alreadySettled.length > 0) {
      return alreadySettled;
    }
    return [];
  }

  for (const row of reservedRows) {
    if (Number(row.user_id) !== uid) {
      throw Object.assign(new Error("预占记录归属与结算用户不匹配"), { code: "RESERVATION_USER_MISMATCH" });
    }
    const lot = db.prepare(`SELECT user_id FROM credit_lots WHERE id = ?`).get(row.lotId);
    if (!lot || Number(lot.user_id) !== uid) {
      throw Object.assign(new Error("预占关联批次不属于当前用户"), { code: "LOT_USER_MISMATCH" });
    }
  }

  const allocations = settleReservedCreditsFromLots({
    userId: uid,
    creditEventId,
    reservations: reservedRows,
    nowIso,
  }, db);

  db.prepare(`
    UPDATE task_credit_reservations
    SET status = 'settled', updated_at = ?
    WHERE (task_key = ? OR (user_id = ? AND task_id = ?)) AND status = 'reserved'
  `).run(nowIso, canonicalKey, uid, String(taskId));

  return allocations;
}

function releaseCreditsForTask({
  userId,
  taskId,
  taskType = "task",
  taskKey,
  brandId,
  bucketKey,
  nowIso = getNowIso(),
}, db = getDbProxy()) {
  ensureTaskReservationTable(db);
  const uid = Number(userId);
  const canonicalKey = buildCanonicalTaskKey({ userId: uid, taskType, taskId, brandId, bucketKey, taskKey });
  let reservedRows = db.prepare(`
    SELECT lot_id AS lotId, reserved_credits AS reservedCredits, user_id
    FROM task_credit_reservations
    WHERE task_key = ? AND status = 'reserved'
  `).all(canonicalKey);

  if (!reservedRows || reservedRows.length === 0) {
    reservedRows = db.prepare(`
      SELECT lot_id AS lotId, reserved_credits AS reservedCredits, user_id
      FROM task_credit_reservations
      WHERE user_id = ? AND task_id = ? AND status = 'reserved'
    `).all(uid, String(taskId));
  }

  if (!reservedRows || reservedRows.length === 0) {
    return;
  }

  for (const row of reservedRows) {
    if (Number(row.user_id) !== uid) {
      throw Object.assign(new Error("预占记录归属与释放用户不匹配"), { code: "RESERVATION_USER_MISMATCH" });
    }
    const lot = db.prepare(`SELECT user_id FROM credit_lots WHERE id = ?`).get(row.lotId);
    if (!lot || Number(lot.user_id) !== uid) {
      throw Object.assign(new Error("预占关联批次不属于当前用户"), { code: "LOT_USER_MISMATCH" });
    }
  }

  releaseReservedCreditsFromLots({
    userId: uid,
    reservations: reservedRows,
    taskKey: canonicalKey,
    nowIso,
  }, db);

  db.prepare(`
    UPDATE task_credit_reservations
    SET status = 'released', updated_at = ?
    WHERE (task_key = ? OR (user_id = ? AND task_id = ?)) AND status = 'reserved'
  `).run(nowIso, canonicalKey, uid, String(taskId));
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
  reserveCreditsForTask,
  settleCreditsForTask,
  releaseCreditsForTask,
  buildCanonicalTaskKey,
  ensureTaskReservationTable,
  migrateLegacyUserCredits,
  migrateAllLegacyUsers,
  insertLedgerCreditEvent,
};
