const { bindRouteScope } = require("./route-scope");
const { requireAdminFromSql } = require("./admin-auth");
const { getDbProxy } = require("../db/connection");
const {
  getOverviewMetrics,
  getUsersMetrics,
  getFeaturesMetrics,
  getAiMetrics,
  getFinanceMetrics,
  getSystemMetrics,
} = require("../analytics/analytics-metrics");
const { recordClientEvent } = require("../analytics/analytics-recorder");
const { safeParseObject } = require("../db/snapshot-utils");

const db = getDbProxy();

// In-memory short TTL cache (20 seconds) for analytics queries
const queryCache = new Map();
const CACHE_TTL_MS = 20 * 1000;

function getCached(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    queryCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  // Evict old entries if cache grows too large
  if (queryCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of queryCache.entries()) {
      if (now > v.expiresAt) queryCache.delete(k);
    }
  }
  queryCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function parsePagination(url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

async function handleAdminAnalyticsRoutes(context, req, res, pathname) {
  const {
    appConfig,
    getSessionToken,
    buildApiUserLog,
    isAdminUser,
    collectBody,
    json,
    badRequest,
    unauthorized,
    forbidden,
    notFound,
  } = bindRouteScope(context);

  function checkAdmin() {
    return requireAdminFromSql(req, res, { getSessionToken, buildApiUserLog, isAdminUser, appConfig, unauthorized, forbidden });
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const queryParams = Object.fromEntries(url.searchParams.entries());

  // --- Client Lightweight Events Endpoint ---
  if (req.method === "POST" && pathname === "/api/analytics/events") {
    const token = getSessionToken(req);
    if (!token) {
      unauthorized(res, "请先登录");
      return true;
    }
    const user = db.prepare("SELECT id, account_type FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(token);
    if (!user) {
      unauthorized(res, "登录会话已失效");
      return true;
    }

    let body;
    try {
      body = await collectBody(req, { maxBytes: 2048 });
    } catch (e) {
      badRequest(res, "事件数据过大");
      return true;
    }

    const eventName = String(body?.eventName || "").trim();
    try {
      recordClientEvent({
        eventName,
        userId: user.id,
        accountType: user.account_type,
        metadata: body?.metadata,
      });
      json(res, 200, { ok: true });
    } catch (err) {
      if (err.status === 400) {
        badRequest(res, err.message);
      } else {
        json(res, 500, { error: "记录事件失败" });
      }
    }
    return true;
  }

  // --- Analytics Aggregation Endpoints ---
  if (req.method === "GET" && pathname.startsWith("/api/admin/analytics/")) {
    const admin = checkAdmin();
    if (!admin) return true;

    const cacheKey = `${pathname}?${url.searchParams.toString()}`;
    const cached = getCached(cacheKey);
    if (cached) {
      json(res, 200, cached, { "Cache-Control": "private, no-cache" });
      return true;
    }

    try {
      let data;
      if (pathname === "/api/admin/analytics/overview") {
        data = getOverviewMetrics(queryParams);
      } else if (pathname === "/api/admin/analytics/users") {
        data = getUsersMetrics(queryParams);
      } else if (pathname === "/api/admin/analytics/features") {
        data = getFeaturesMetrics(queryParams);
      } else if (pathname === "/api/admin/analytics/ai") {
        data = getAiMetrics(queryParams);
      } else if (pathname === "/api/admin/analytics/finance") {
        data = getFinanceMetrics(queryParams);
      } else if (pathname === "/api/admin/analytics/system") {
        data = getSystemMetrics(queryParams, { videoProjectService: context.videoProjectService });
      } else {
        return false;
      }

      setCached(cacheKey, data);
      json(res, 200, data, { "Cache-Control": "private, no-cache" });
      return true;
    } catch (err) {
      if (err.status === 400) {
        badRequest(res, err.message);
        return true;
      }
      console.error("[admin-analytics] error:", err);
      json(res, 500, { error: err.message || "分析指标计算失败" });
      return true;
    }
  }

  // --- Data Management Pagination Endpoints ---
  if (req.method === "GET" && pathname.startsWith("/api/admin/data/")) {
    const admin = checkAdmin();
    if (!admin) return true;

    const { page, pageSize, offset } = parsePagination(url);
    const q = String(url.searchParams.get("q") || "").trim();

    // 1. Users
    if (pathname === "/api/admin/data/users") {
      const accountType = String(url.searchParams.get("accountType") || "").trim();
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(name LIKE ? OR phone LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      if (accountType) {
        conditions.push("account_type = ?");
        params.push(accountType);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM users ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT id, name, phone, account_type AS accountType, department, credits, created_at AS createdAt,
          (SELECT COUNT(*) FROM brands WHERE owner_user_id = users.id) AS brandCount,
          (SELECT COUNT(*) FROM generations WHERE owner_user_id = users.id) AS generationCount,
          (SELECT COALESCE(SUM(CASE WHEN credit_delta < 0 THEN COALESCE(NULLIF(credit_cost, 0), ABS(credit_delta)) ELSE 0 END), 0) FROM credit_events WHERE user_id = users.id) AS consumedTokens,
          (SELECT COALESCE(SUM(CASE WHEN credit_delta > 0 THEN credit_delta ELSE 0 END), 0) FROM credit_events WHERE user_id = users.id) AS grantedTokens
        FROM users
        ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset);
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 2. Brands
    if (pathname === "/api/admin/data/brands") {
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(b.name LIKE ? OR b.industry LIKE ? OR b.description LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM brands b ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT b.id, b.owner_user_id AS ownerUserId, b.name, b.industry, b.audience, b.description,
          b.product, b.goal, b.profile_type AS profileType, b.created_at AS createdAt, b.updated_at AS updatedAt,
          u.name AS userName, u.phone AS userPhone,
          (SELECT COUNT(*) FROM analyses a WHERE a.brand_id = b.id) AS analysisCount,
          (SELECT COUNT(*) FROM trends t WHERE t.brand_id = b.id AND t.scope = 'current') AS trendCount
        FROM brands b
        LEFT JOIN users u ON u.id = b.owner_user_id
        ${where}
        ORDER BY b.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset).map((r) => ({
        ...r,
        user: r.userName ? { id: r.ownerUserId, name: r.userName, phone: r.userPhone } : null,
      }));
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 3. Generations (Lean list)
    if (pathname === "/api/admin/data/generations") {
      const type = String(url.searchParams.get("type") || "").trim();
      const visibilityStatus = String(url.searchParams.get("visibilityStatus") || "").trim();
      const assetStatus = String(url.searchParams.get("assetStatus") || "").trim();
      const from = String(url.searchParams.get("from") || "").trim();
      const to = String(url.searchParams.get("to") || "").trim();
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(g.card_title LIKE ? OR g.summary LIKE ? OR g.trend_title LIKE ? OR g.brand_name LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (type) {
        conditions.push("g.type = ?");
        params.push(type);
      }
      if (visibilityStatus) {
        conditions.push("g.visibility_status = ?");
        params.push(visibilityStatus);
      }
      if (assetStatus) {
        conditions.push("g.asset_status = ?");
        params.push(assetStatus);
      }
      if (from) {
        conditions.push("g.created_at >= ?");
        params.push(from);
      }
      if (to) {
        conditions.push("g.created_at < ?");
        params.push(to);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM generations g LEFT JOIN users u ON u.id = g.owner_user_id ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT g.id, g.owner_user_id AS ownerUserId, g.type, g.channel_label AS channelLabel,
          g.brand_id AS brandId, g.brand_name AS brandName, g.trend_id AS trendId,
          g.trend_title AS trendTitle, g.idea_title AS ideaTitle, g.card_title AS cardTitle,
          g.created_at AS createdAt, g.preview_url AS previewUrl, g.summary,
          g.visibility_status AS visibilityStatus, g.asset_status AS assetStatus,
          g.asset_count AS assetCount, g.asset_bytes AS assetBytes, g.assets_deleted_at AS assetsDeletedAt,
          u.name AS userName, u.phone AS userPhone
        FROM generations g
        LEFT JOIN users u ON u.id = g.owner_user_id
        ${where}
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset).map((r) => ({
        ...r,
        user: r.userName ? { id: r.ownerUserId, name: r.userName, phone: r.userPhone } : null,
      }));
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 4. Credit Events
    if (pathname === "/api/admin/data/credit-events") {
      const actionType = String(url.searchParams.get("actionType") || "").trim();
      const userId = url.searchParams.get("userId");
      const from = String(url.searchParams.get("from") || "").trim();
      const to = String(url.searchParams.get("to") || "").trim();
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(c.summary LIKE ? OR c.action_label LIKE ? OR c.brand_name LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (actionType) {
        conditions.push("c.action_type = ?");
        params.push(actionType);
      }
      if (userId) {
        conditions.push("c.user_id = ?");
        params.push(Number(userId));
      }
      if (from) {
        conditions.push("c.created_at >= ?");
        params.push(from);
      }
      if (to) {
        conditions.push("c.created_at < ?");
        params.push(to);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM credit_events c LEFT JOIN users u ON u.id = c.user_id ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT c.id, c.user_id AS userId, c.action_type AS actionType, c.action_label AS actionLabel,
          c.credit_delta AS creditDelta, c.credit_cost AS creditCost, c.created_at AS createdAt,
          c.admin_user_id AS adminUserId, c.admin_user_name AS adminUserName,
          c.brand_id AS brandId, c.brand_name AS brandName, c.trend_id AS trendId,
          c.trend_title AS trendTitle, c.idea_title AS ideaTitle, c.generation_id AS generationId,
          c.channel_label AS channelLabel, c.summary,
          u.name AS userName, u.phone AS userPhone
        FROM credit_events c
        LEFT JOIN users u ON u.id = c.user_id
        ${where}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset).map((r) => ({
        ...r,
        user: r.userName ? { id: r.userId, name: r.userName, phone: r.userPhone } : null,
      }));
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 5. Payment Orders
    if (pathname === "/api/admin/data/payment-orders") {
      const provider = String(url.searchParams.get("provider") || "").trim();
      const status = String(url.searchParams.get("status") || "").trim();
      const from = String(url.searchParams.get("from") || "").trim();
      const to = String(url.searchParams.get("to") || "").trim();
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(p.out_trade_no LIKE ? OR p.trade_no LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (provider) {
        conditions.push("p.provider = ?");
        params.push(provider);
      }
      if (status) {
        conditions.push("p.status = ?");
        params.push(status);
      }
      if (from) {
        conditions.push("p.created_at >= ?");
        params.push(from);
      }
      if (to) {
        conditions.push("p.created_at < ?");
        params.push(to);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM payment_orders p LEFT JOIN users u ON u.id = p.user_id ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT p.id, p.out_trade_no AS outTradeNo, p.user_id AS userId, p.plan_id AS planId,
          p.plan_name AS planName, p.plan_credits AS planCredits, p.amount_fen AS amountFen,
          p.status, p.provider, p.trade_no AS tradeNo, p.credit_event_id AS creditEventId,
          p.created_at AS createdAt, p.paid_at AS paidAt, p.expires_at AS expiresAt,
          p.audit_reason AS auditReason,
          u.name AS userName, u.phone AS userPhone
        FROM payment_orders p
        LEFT JOIN users u ON u.id = p.user_id
        ${where}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset).map((r) => ({
        ...r,
        amountYuan: Number(r.amountFen || 0) / 100,
        user: r.userName ? { id: r.userId, name: r.userName, phone: r.userPhone } : null,
      }));
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 6. Video Projects List
    if (pathname === "/api/admin/data/video-projects") {
      const model = String(url.searchParams.get("model") || "").trim();
      const status = String(url.searchParams.get("status") || "").trim();
      const from = String(url.searchParams.get("from") || "").trim();
      const to = String(url.searchParams.get("to") || "").trim();
      const conditions = [];
      const params = [];
      if (q) {
        conditions.push("(v.request_id LIKE ? OR v.error LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (model) {
        conditions.push("v.video_model = ?");
        params.push(model);
      }
      if (status) {
        conditions.push("v.status = ?");
        params.push(status);
      }
      if (from) {
        conditions.push("v.created_at >= ?");
        params.push(from);
      }
      if (to) {
        conditions.push("v.created_at < ?");
        params.push(to);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM video_projects v LEFT JOIN users u ON u.id = v.owner_user_id ${where}`).get(...params);
      const total = Number(countRow?.total || 0);
      const items = db.prepare(`
        SELECT v.id, v.owner_user_id AS ownerUserId, v.generation_id AS generationId,
          v.request_id AS requestId, v.video_model AS model, v.mode, v.resolution,
          v.aspect_ratio AS aspectRatio, v.total_duration_sec AS totalDurationSec,
          v.status, v.estimated_credits AS estimatedCredits, v.charged_credits AS chargedCredits,
          v.refunded_credits AS refundedCredits, v.asset_status AS assetStatus,
          v.created_at AS createdAt, v.completed_at AS completedAt, v.failed_at AS failedAt,
          v.error,
          u.name AS userName, u.phone AS userPhone
        FROM video_projects v
        LEFT JOIN users u ON u.id = v.owner_user_id
        ${where}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset).map((r) => ({
        ...r,
        netCredits: Number(r.chargedCredits || 0) - Number(r.refundedCredits || 0),
        user: r.userName ? { id: r.ownerUserId, name: r.userName, phone: r.userPhone } : null,
      }));
      json(res, 200, { total, page, pageSize, items });
      return true;
    }

    // 7. Video Project Detail
    const projectDetailMatch = pathname.match(/^\/api\/admin\/data\/video-projects\/(\d+)$/);
    if (projectDetailMatch) {
      const projectId = Number(projectDetailMatch[1]);
      const projectRow = db.prepare(`
        SELECT v.*, u.name AS userName, u.phone AS userPhone
        FROM video_projects v
        LEFT JOIN users u ON u.id = v.owner_user_id
        WHERE v.id = ?
      `).get(projectId);
      if (!projectRow) {
        notFound(res);
        return true;
      }

      const clips = db.prepare(`
        SELECT id, clip_index AS clipIndex, start_sec AS startSec, end_sec AS endSec,
          duration_sec AS durationSec, status, prompt, provider, attempt, retry_count AS retryCount,
          error, first_submitted_at AS firstSubmittedAt, completed_at AS completedAt, failed_at AS failedAt,
          asset_status AS assetStatus
        FROM video_clips
        WHERE project_id = ?
        ORDER BY clip_index ASC
      `).all(projectId);

      const script = safeParseObject(projectRow.script_json);
      const finalVideo = safeParseObject(projectRow.final_video_json);

      json(res, 200, {
        project: {
          id: projectRow.id,
          ownerUserId: projectRow.owner_user_id,
          generationId: projectRow.generation_id,
          requestId: projectRow.request_id,
          model: projectRow.video_model,
          mode: projectRow.mode,
          resolution: projectRow.resolution,
          aspectRatio: projectRow.aspect_ratio,
          totalDurationSec: projectRow.total_duration_sec,
          status: projectRow.status,
          estimatedCredits: projectRow.estimated_credits,
          chargedCredits: projectRow.charged_credits,
          refundedCredits: projectRow.refunded_credits,
          netCredits: projectRow.charged_credits - projectRow.refunded_credits,
          error: projectRow.error,
          startedAt: projectRow.started_at,
          completedAt: projectRow.completed_at,
          failedAt: projectRow.failed_at,
          assemblyStartedAt: projectRow.assembly_started_at,
          assemblyCompletedAt: projectRow.assembly_completed_at,
          assetStatus: projectRow.asset_status,
          assetCount: projectRow.asset_count,
          assetBytes: projectRow.asset_bytes,
          assetsDeletedAt: projectRow.assets_deleted_at,
          createdAt: projectRow.created_at,
          updatedAt: projectRow.updated_at,
          scriptConcept: script.creativeConcept || "",
          hasFinalVideo: Boolean(finalVideo.asset && !finalVideo.asset.purged),
          user: projectRow.userName ? { id: projectRow.owner_user_id, name: projectRow.userName, phone: projectRow.userPhone } : null,
          clips,
        },
      });
      return true;
    }
  }

  return false;
}

module.exports = {
  handleAdminAnalyticsRoutes,
};
