const { getDbProxy } = require("../connection");
const { safeParseArray, safeParseObject } = require("../snapshot-utils");
const { TREND_ANALYSIS_RESERVATION_TTL_MS, allocateCounter, runTransaction } = require("./core-repository");
const { findUserById, updateUserCredits } = require("./auth-repository");
const { mapCreditEventRow, mapGenerationRow, mapUserRow } = require("./row-mappers");

const db = getDbProxy();
const ADMIN_OVERVIEW_LIMITS = {
  users: 500,
  brands: 300,
  generations: 300,
  creditEvents: 500,
};
const CREDIT_EVENT_COLUMNS = `
  id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
  admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
  generation_id, channel_label, summary, payload_json
`;

function insertCreditEvent(input) {
  const id = input.id ?? allocateCounter("nextCreditEventId", 1);
  db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    Number(input.userId),
    input.actionType,
    input.actionLabel,
    Number(input.creditDelta || 0),
    Number(input.creditCost || 0),
    input.createdAt || new Date().toISOString(),
    input.adminUserId ?? null,
    input.adminUserName || "",
    input.brandId ?? null,
    input.brandName || "",
    input.trendId ?? null,
    input.trendTitle || "",
    input.ideaTitle || "",
    input.generationId ?? null,
    input.channelLabel || "",
    input.summary || "",
    JSON.stringify(input.payload || {}),
  );
  return mapCreditEventRow(db.prepare(`SELECT ${CREDIT_EVENT_COLUMNS} FROM credit_events WHERE id = ?`).get(id));
}

function trySpendCreditsWithEvent({ userId, amount, event }) {
  return runTransaction(() => {
    const cost = Number(amount || 0);
    if (!Number.isFinite(cost) || cost <= 0) {
      return { spent: false, user: findUserById(userId), creditEvent: null };
    }

    const reservationCutoff = new Date(Date.now() - TREND_ANALYSIS_RESERVATION_TTL_MS).toISOString();
    const result = db.prepare(`
      UPDATE users
      SET credits = credits - ?
      WHERE id = ?
        AND credits - COALESCE((
          SELECT SUM(credit_cost)
          FROM trend_analysis_requests
          WHERE user_id = users.id AND status = 'reserved' AND created_at >= ?
        ), 0) >= ?
    `).run(cost, Number(userId), reservationCutoff, cost);
    if (result.changes !== 1) {
      return { spent: false, user: findUserById(userId), creditEvent: null };
    }

    const creditEvent = insertCreditEvent({
      ...(event || {}),
      userId,
      creditDelta: -cost,
      creditCost: cost,
    });
    return { spent: true, user: findUserById(userId), creditEvent };
  });
}

function findCreditEventById(creditEventId) {
  return mapCreditEventRow(db.prepare(`SELECT ${CREDIT_EVENT_COLUMNS} FROM credit_events WHERE id = ?`).get(Number(creditEventId)));
}

function listAllUsers() {
  return db.prepare(`
    SELECT id, name, phone, account_type, department, credits, created_at
    FROM users
    ORDER BY id ASC
  `).all().map(mapUserRow);
}

function listAdminUsersByIds(userIds) {
  const ids = [...new Set(userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, name, phone, account_type, department, credits, created_at
    FROM users
    WHERE id IN (${placeholders})
  `).all(...ids).map(mapUserRow);
}

function listAllCreditEvents() {
  return db.prepare(`
    SELECT ${CREDIT_EVENT_COLUMNS}
    FROM credit_events
    ORDER BY created_at DESC, id DESC
  `).all().map(mapCreditEventRow);
}

function readAdminOverviewStats() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS user_count,
      (SELECT COUNT(*) FROM brands) AS brand_count,
      (SELECT COUNT(*) FROM generations) AS generation_count,
      (SELECT COALESCE(SUM(CASE WHEN credit_delta < 0 THEN COALESCE(NULLIF(credit_cost, 0), ABS(credit_delta)) ELSE 0 END), 0) FROM credit_events) AS total_consumed_tokens,
      (SELECT COALESCE(SUM(CASE WHEN credit_delta > 0 THEN credit_delta ELSE 0 END), 0) FROM credit_events) AS total_granted_tokens,
      (SELECT COALESCE(SUM(credits), 0) FROM users) AS current_credits_total
  `).get();
  return {
    userCount: Number(row?.user_count || 0),
    brandCount: Number(row?.brand_count || 0),
    generationCount: Number(row?.generation_count || 0),
    totalConsumedTokens: Number(row?.total_consumed_tokens || 0),
    totalGrantedTokens: Number(row?.total_granted_tokens || 0),
    currentCreditsTotal: Number(row?.current_credits_total || 0),
  };
}

function listAdminUserMetrics(limit = ADMIN_OVERVIEW_LIMITS.users) {
  return db.prepare(`
    WITH brand_counts AS (
      SELECT owner_user_id, COUNT(*) AS brand_count
      FROM brands
      GROUP BY owner_user_id
    ),
    generation_counts AS (
      SELECT owner_user_id, COUNT(*) AS generation_count, MAX(created_at) AS last_generation_at
      FROM generations
      GROUP BY owner_user_id
    ),
    credit_totals AS (
      SELECT
        user_id,
        COALESCE(SUM(CASE WHEN credit_delta < 0 THEN COALESCE(NULLIF(credit_cost, 0), ABS(credit_delta)) ELSE 0 END), 0) AS consumed_tokens,
        COALESCE(SUM(CASE WHEN credit_delta > 0 THEN credit_delta ELSE 0 END), 0) AS granted_tokens,
        MAX(created_at) AS last_credit_at
      FROM credit_events
      GROUP BY user_id
    ),
    generation_credit_totals AS (
      SELECT
        user_id,
        COALESCE(SUM(CASE WHEN credit_delta < 0 THEN COALESCE(NULLIF(credit_cost, 0), ABS(credit_delta)) ELSE 0 END), 0) AS generation_tokens
      FROM credit_events
      WHERE generation_id IS NOT NULL
      GROUP BY user_id
    )
    SELECT
      u.id, u.name, u.phone, u.account_type, u.department, u.credits, u.created_at,
      COALESCE(b.brand_count, 0) AS brand_count,
      COALESCE(g.generation_count, 0) AS generation_count,
      COALESCE(c.consumed_tokens, 0) AS consumed_tokens,
      COALESCE(gc.generation_tokens, 0) AS generation_tokens,
      COALESCE(c.granted_tokens, 0) AS granted_tokens,
      MAX(COALESCE(g.last_generation_at, ''), COALESCE(c.last_credit_at, '')) AS last_active_at
    FROM users u
    LEFT JOIN brand_counts b ON b.owner_user_id = u.id
    LEFT JOIN generation_counts g ON g.owner_user_id = u.id
    LEFT JOIN credit_totals c ON c.user_id = u.id
    LEFT JOIN generation_credit_totals gc ON gc.user_id = u.id
    ORDER BY consumed_tokens DESC, generation_count DESC, u.id ASC
    LIMIT ?
  `).all(Number(limit)).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    accountType: row.account_type || "customer",
    department: row.department || "",
    credits: Number(row.credits || 0),
    createdAt: row.created_at,
    currentCredits: Number(row.credits || 0),
    brandCount: Number(row.brand_count || 0),
    generationCount: Number(row.generation_count || 0),
    consumedTokens: Number(row.consumed_tokens || 0),
    generationTokens: Number(row.generation_tokens || 0),
    grantedTokens: Number(row.granted_tokens || 0),
    lastActiveAt: row.last_active_at || "",
  }));
}

function listAdminBrandViews(limit = ADMIN_OVERVIEW_LIMITS.brands) {
  return db.prepare(`
    SELECT
      b.id, b.owner_user_id, b.name, b.industry, b.audience, b.description, b.product, b.goal,
      b.knowledge_base, b.logo_json, b.asset_tags_json,
      u.id AS user_id, u.name AS user_name, u.phone AS user_phone, u.account_type AS user_account_type, u.department AS user_department,
      (SELECT COUNT(*) FROM analyses a WHERE a.brand_id = b.id) AS analysis_count,
      (SELECT COUNT(*) FROM trends t WHERE t.brand_id = b.id AND t.scope = 'current') AS trend_count
    FROM brands b
    LEFT JOIN users u ON u.id = b.owner_user_id
    ORDER BY b.id DESC
    LIMIT ?
  `).all(Number(limit)).map((row) => {
    const logo = safeParseObject(row.logo_json);
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name || "",
      industry: row.industry || "",
      audience: row.audience || "",
      description: row.description || "",
      product: row.product || "",
      goal: row.goal || "",
      knowledgeBase: row.knowledge_base || "",
      assetTags: safeParseArray(row.asset_tags_json),
      logoName: logo.originalName || "",
      hasLogo: Boolean(logo.storedPath),
      analysisCount: Number(row.analysis_count || 0),
      trendCount: Number(row.trend_count || 0),
      createdAt: "",
      user: row.user_id
        ? {
            id: row.user_id,
            name: row.user_name,
            phone: row.user_phone,
            accountType: row.user_account_type || "customer",
            department: row.user_department || "",
          }
        : null,
    };
  });
}

function listAdminGenerations(limit = ADMIN_OVERVIEW_LIMITS.generations) {
  return db.prepare(`
    SELECT id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    FROM generations
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(Number(limit)).map(mapGenerationRow);
}

function listCreditEventsForGenerationIds(generationIds) {
  const ids = [...new Set(generationIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT ${CREDIT_EVENT_COLUMNS}
    FROM credit_events
    WHERE generation_id IN (${placeholders})
    ORDER BY created_at DESC, id DESC
  `).all(...ids).map(mapCreditEventRow);
}

function listRecentCreditEvents(limit = ADMIN_OVERVIEW_LIMITS.creditEvents) {
  return db.prepare(`
    SELECT ${CREDIT_EVENT_COLUMNS}
    FROM credit_events
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(Number(limit)).map(mapCreditEventRow);
}

function readAdminOverviewStore() {
  const userMetrics = listAdminUserMetrics();
  const brandViews = listAdminBrandViews();
  const generations = listAdminGenerations();
  const recentCreditEvents = listRecentCreditEvents();
  const generationCreditEvents = listCreditEventsForGenerationIds(generations.map((generation) => generation.id));
  const creditEventsById = new Map([...recentCreditEvents, ...generationCreditEvents].map((event) => [event.id, event]));
  const creditEvents = [...creditEventsById.values()];
  const users = listAdminUsersByIds([
    ...userMetrics.map((user) => user.id),
    ...brandViews.map((brand) => brand.ownerUserId),
    ...generations.map((generation) => generation.ownerUserId),
    ...creditEvents.flatMap((event) => [event.userId, event.adminUserId]),
  ]);
  return {
    statsOverride: readAdminOverviewStats(),
    userMetrics,
    users,
    brandViews,
    brands: [],
    generations,
    creditEvents,
  };
}

function readUserDeletionAssets(userId) {
  const numericUserId = Number(userId);
  const brandLogoStoredPaths = db.prepare(`
    SELECT logo_json
    FROM brands
    WHERE owner_user_id = ?
  `).all(numericUserId)
    .map((row) => safeParseObject(row.logo_json).storedPath)
    .filter(Boolean);
  const generations = db.prepare(`
    SELECT id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    FROM generations
    WHERE owner_user_id = ?
  `).all(numericUserId).map(mapGenerationRow);
  const productImages = db.prepare(`
    SELECT id, owner_user_id, stored_path
    FROM product_images
    WHERE owner_user_id = ?
  `).all(numericUserId).map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    storedPath: row.stored_path,
  }));
  return { brandLogoStoredPaths, generations, productImages };
}

function findRefundForCreditEvent(creditEventId, userId) {
  return mapCreditEventRow(db.prepare(`
    SELECT ${CREDIT_EVENT_COLUMNS}
    FROM credit_events
    WHERE user_id = ?
      AND credit_delta > 0
      AND CAST(json_extract(payload_json, '$.refundForCreditEventId') AS INTEGER) = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(Number(userId), Number(creditEventId)));
}

function refundCreditEventIfNeeded({ creditEventId, userId, reason }) {
  return runTransaction(() => {
    const originalEvent = findCreditEventById(creditEventId);
    if (!originalEvent || Number(originalEvent.userId) !== Number(userId) || Number(originalEvent.creditDelta || 0) >= 0) {
      return { refunded: false, originalEvent: originalEvent || null, refundEvent: null, user: findUserById(userId) };
    }

    const existingRefund = findRefundForCreditEvent(originalEvent.id, userId);
    if (existingRefund) {
      return { refunded: false, originalEvent, refundEvent: existingRefund, user: findUserById(userId) };
    }

    const refundAmount = Math.abs(Number(originalEvent.creditDelta || originalEvent.creditCost || 0));
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return { refunded: false, originalEvent, refundEvent: null, user: findUserById(userId) };
    }

    const user = findUserById(userId);
    if (!user) {
      return { refunded: false, originalEvent, refundEvent: null, user: null };
    }

    updateUserCredits(user.id, Number(user.credits || 0) + refundAmount);
    const refundEvent = insertCreditEvent({
      userId: user.id,
      actionType: `${originalEvent.actionType}Refund`,
      actionLabel: `${originalEvent.actionLabel || "积分扣除"}退款`,
      creditDelta: refundAmount,
      creditCost: 0,
      brandId: originalEvent.brandId,
      brandName: originalEvent.brandName,
      trendId: originalEvent.trendId,
      trendTitle: originalEvent.trendTitle,
      ideaTitle: originalEvent.ideaTitle,
      generationId: originalEvent.generationId,
      channelLabel: originalEvent.channelLabel,
      summary: `${originalEvent.actionLabel || "积分扣除"}失败，自动退还 ${refundAmount} 积分`,
      payload: {
        refundForCreditEventId: originalEvent.id,
        refundReason: String(reason || "image job failed").slice(0, 500),
        refundedAt: new Date().toISOString(),
      },
    });
    return { refunded: true, originalEvent, refundEvent, user: findUserById(user.id) };
  });
}

function findGenerationForCreditEvent(creditEventId, userId) {
  return db.prepare(`
    SELECT generation_id AS generationId
    FROM credit_events
    WHERE id = ? AND user_id = ? AND generation_id IS NOT NULL
  `).get(Number(creditEventId), Number(userId))?.generationId ?? null;
}

function updateCreditEventGeneration(creditEventId, generation, generationPayload, options = {}) {
  const event = findCreditEventById(creditEventId);
  if (!event) return null;
  if (options.requireUserId != null && Number(event.userId) !== Number(options.requireUserId)) {
    return null;
  }
  if (Array.isArray(options.allowedActionTypes) && options.allowedActionTypes.length) {
    if (!options.allowedActionTypes.includes(event.actionType)) {
      return null;
    }
  }
  const payload = {
    ...(event.payload || {}),
    generationPayload: generationPayload || generation?.payload || {},
  };
  db.prepare(`
    UPDATE credit_events
    SET generation_id = ?,
        channel_label = ?,
        summary = ?,
        payload_json = ?
    WHERE id = ?
  `).run(
    generation.id,
    generation.channelLabel || event.channelLabel,
    generation.summary || generation.cardTitle || event.summary,
    JSON.stringify(payload),
    Number(creditEventId),
  );
  return findCreditEventById(creditEventId);
}

function updateCreditEventEditResult(creditEventId, editEntry, sourceGenerationId) {
  const event = findCreditEventById(creditEventId);
  if (!event) return null;
  db.prepare(`
    UPDATE credit_events
    SET generation_id = ?,
        payload_json = ?
    WHERE id = ?
  `).run(
    Number(sourceGenerationId) || event.generationId,
    JSON.stringify({
      ...(event.payload || {}),
      editResult: editEntry,
    }),
    Number(creditEventId),
  );
  return findCreditEventById(creditEventId);
}

function attachGenerationToLatestCreditEvent({ user, actionType, brand, trend, idea, generation, generationPayload }) {
  const event = db.prepare(`
    SELECT ${CREDIT_EVENT_COLUMNS}
    FROM credit_events
    WHERE user_id = ?
      AND action_type = ?
      AND generation_id IS NULL
      AND brand_id = ?
      AND trend_id = ?
      AND (idea_title = '' OR idea_title = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(user.id, actionType, brand.id, trend.id, idea.title);
  if (!event) return null;
  return updateCreditEventGeneration(event.id, generation, generationPayload);
}

function addCredits({ targetUserId, amount, adminUser, note }) {
  return runTransaction(() => {
    const targetUser = findUserById(targetUserId);
    if (!targetUser) return null;
    const nextCredits = Number(targetUser.credits || 0) + Number(amount || 0);
    updateUserCredits(targetUser.id, nextCredits);
    const updatedUser = findUserById(targetUser.id);
    insertCreditEvent({
      userId: targetUser.id,
      actionType: "adminAddCredits",
      actionLabel: "管理员加额度",
      creditDelta: amount,
      creditCost: 0,
      adminUserId: adminUser.id,
      adminUserName: adminUser.name,
      summary: String(note || "").trim() || `管理员为用户增加 ${amount} 额度`,
      payload: { note: String(note || "").trim() },
    });
    return updatedUser;
  });
}

function deleteUserCascadeRows(userId) {
  return runTransaction(() => {
    const user = findUserById(userId);
    if (!user) return null;
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM verification_codes WHERE phone = ?").run(user.phone);
    db.prepare("DELETE FROM credit_events WHERE user_id = ? OR admin_user_id = ?").run(user.id, user.id);
    db.prepare("DELETE FROM image_jobs WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM product_images WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM generations WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?))").run(user.id);
    db.prepare("DELETE FROM trends WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?)").run(user.id);
    db.prepare("DELETE FROM analyses WHERE brand_id IN (SELECT id FROM brands WHERE owner_user_id = ?)").run(user.id);
    db.prepare("DELETE FROM brands WHERE owner_user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    return user;
  });
}

module.exports = {
  insertCreditEvent,
  trySpendCreditsWithEvent,
  findCreditEventById,
  listAllUsers,
  listAdminUsersByIds,
  listAllCreditEvents,
  readAdminOverviewStats,
  listAdminUserMetrics,
  listAdminBrandViews,
  listAdminGenerations,
  readAdminOverviewStore,
  readUserDeletionAssets,
  findRefundForCreditEvent,
  refundCreditEventIfNeeded,
  findGenerationForCreditEvent,
  updateCreditEventGeneration,
  updateCreditEventEditResult,
  attachGenerationToLatestCreditEvent,
  addCredits,
  deleteUserCascadeRows,
};
