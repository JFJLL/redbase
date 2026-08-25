const { bindRouteScope } = require("./route-scope");
const { findUserBySessionToken } = require("../db/repositories/auth-repository");
const {
  EXCELLENT_BOARD_DEFAULT,
  getExcellentContentBoard,
  getExcellentContentSource,
  getExcellentContents,
  refreshExcellentContents,
  getExcellentContentDetail,
  getExcellentContentTaxonomy,
  getExcellentContentSourcesList,
  findNoteInCaches,
  validateExcellentTaxonomyPath,
} = require("../services/excellent-content-service");
const {
  normalizePgyCategoryPath,
  normalizePgyIndustryPath,
} = require("../integrations/pgy-content-square");
const { analyzeExcellentNoteForRemix, ANALYSIS_VERSION } = require("../services/excellent-remix-analysis-service");
const {
  generateContentDirections,
  recommendTrendsForRemix,
  buildExcellentRemixFusionPlan,
  flattenBrandIdeas,
  resolveExistingIdea,
  normalizeLearningFocus,
  normalizeContentMode,
} = require("../services/excellent-remix-fusion-service");
const brandRepository = require("../db/repositories/brand-repository");
const {
  EXCELLENT_BILLING_KIND_DIRECTION,
  EXCELLENT_BILLING_KIND_FUSION,
  normalizeExcellentBillingRequestId,
  buildExcellentBillingSignature,
  reserveExcellentBillingRequest,
  settleExcellentBillingRequest,
  failExcellentBillingRequest,
  getDirectionBillingSnapshot,
} = require("../db/repositories/excellent-remix-billing-repository");
const {
  claimExcellentRefreshSlot,
  releaseExcellentRefreshSlot,
} = require("../services/excellent-refresh-cooldown");

const XHS_FUSION_SLIDE_COUNT = 4;

function buildExcellentImageProxyPath(
  noteId,
  imageIndex,
  { board = "", contentSource = "", categoryPath = "", industryPath = "" } = {},
) {
  const query = new URLSearchParams();
  if (board) query.set("board", board);
  if (contentSource) query.set("contentSource", contentSource);
  if (categoryPath) query.set("categoryPath", categoryPath);
  if (industryPath) query.set("industryPath", industryPath);
  const queryString = query.toString();
  return `/api/excellent-contents/${encodeURIComponent(String(noteId || ""))}/images/${Number(imageIndex)}/file${
    queryString ? `?${queryString}` : ""
  }`;
}

function rewriteExcellentImageUrl(value, imageIndex, params) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return value;
  return buildExcellentImageProxyPath(params.noteId, imageIndex, params);
}

/**
 * Single, stable image sequence for an excellent-content note: imageUrls (in
 * order), then coverUrls (in order), then coverUrl, then primaryCoverUrl.
 * Empty values are filtered, duplicates are dropped, and order is preserved so
 * the response rewrite and the image proxy always agree on index i.
 */
function normalizeExcellentImageSequence(item) {
  if (!item || typeof item !== "object") return [];
  const seen = new Set();
  const sequence = [];
  const push = (value) => {
    if (typeof value !== "string" || !String(value).trim()) return;
    if (seen.has(value)) return;
    seen.add(value);
    sequence.push(value);
  };
  if (Array.isArray(item.imageUrls)) {
    for (const value of item.imageUrls) push(value);
  }
  if (Array.isArray(item.coverUrls)) {
    for (const value of item.coverUrls) push(value);
  }
  push(item.coverUrl);
  push(item.primaryCoverUrl);
  return sequence;
}

/**
 * Rewrite cached remote image URLs to the same-origin SSRF-safe proxy path so
 * the browser never hits the XHS CDN hotlink wall directly. Relative URLs stay
 * untouched; non-image remote links (noteUrl, videoUrl) are never rewritten.
 * Every image field is rewritten against the unified sequence index so a
 * cover-only record resolves to index 0 and duplicated covers never shift.
 */
function rewriteExcellentNoteImageUrls(note, params) {
  if (!note || typeof note !== "object") return note;
  const noteParams = {
    ...params,
    noteId: String(note.noteId || note.id || params.noteId || "").trim(),
  };
    const sequence = normalizeExcellentImageSequence(note);
  const directImageUrls = Array.isArray(note.imageUrls) ? [...note.imageUrls] : [];
  const directCoverUrls = Array.isArray(note.coverUrls) ? [...note.coverUrls] : [];
  const directCoverUrl = typeof note.coverUrl === "string" ? note.coverUrl : "";
  const directPrimaryCoverUrl = typeof note.primaryCoverUrl === "string" ? note.primaryCoverUrl : "";
  const sequenceIndex = (value) => {

    const index = sequence.indexOf(value);
    return index >= 0 ? index : 0;
  };
    const rewritten = {
    ...note,
    // Return the original, upstream-provided URLs for direct browser loading.
    // Keep the existing same-origin values below as a verified fallback path.
    directImageUrls,
    directCoverUrls,
    directCoverUrl,
    directPrimaryCoverUrl,
  };

  for (const [key, child] of Object.entries(note)) {
    if ((key === "imageUrls" || key === "coverUrls") && Array.isArray(child)) {
      rewritten[key] = child.map((value) => rewriteExcellentImageUrl(value, sequenceIndex(value), noteParams));
    } else if ((key === "coverUrl" || key === "primaryCoverUrl") && typeof child === "string") {
      rewritten[key] = rewriteExcellentImageUrl(child, sequenceIndex(child), noteParams);
    } else if (child && typeof child === "object") {
      rewritten[key] = rewriteExcellentNoteImageUrls(child, noteParams);
    }
  }
  return rewritten;
}

function rewriteExcellentImageUrlsResponse(result, params) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.items)) {
    result.items = result.items.map((item) => rewriteExcellentNoteImageUrls(item, params));
  }
  if (result.item && typeof result.item === "object") {
    result.item = rewriteExcellentNoteImageUrls(result.item, params);
  }
  return result;
}

function hasPublishReadyFusionFields(plan) {
  const pack = plan?.carouselPack;
  const slides = Array.isArray(pack?.slides) ? pack.slides : [];
  if (slides.length !== XHS_FUSION_SLIDE_COUNT) return false;
  if (!String(pack?.publishTitle || "").trim() || !String(pack?.publishCaption || "").trim()) return false;
  return slides.every(
    (slide) =>
      String(slide?.title || "").trim() &&
      String(slide?.copy || "").trim() &&
      String(slide?.visualDirection || "").trim(),
  );
}

/** Server-authoritative billing summary sent with every charged endpoint response. */
function buildDirectionBilling({ requestId, cacheHit, replayed, charged, creditCost, user, snapshot }) {
  return {
    requestId,
    cacheHit: Boolean(cacheHit),
    replayed: Boolean(replayed),
    charged: Boolean(charged),
    creditCost: charged ? Number(creditCost || 0) : 0,
    credits: Number(user?.credits || 0),
    windowCount: Number(snapshot?.windowCount || 0),
    freeLimit: Number(snapshot?.freeLimit || 0),
    windowMs: Number(snapshot?.windowMs || 0),
    nextChargeable: Boolean(snapshot?.nextChargeable),
  };
}

function buildFusionBilling({ requestId, cacheHit, replayed, charged, creditCost, user }) {
  return {
    requestId,
    cacheHit: Boolean(cacheHit),
    replayed: Boolean(replayed),
    charged: Boolean(charged),
    creditCost: charged ? Number(creditCost || 0) : 0,
    credits: Number(user?.credits || 0),
  };
}

async function handleExcellentContentRoutes(context, req, res, pathname) {
  const {
    appConfig,
    getSessionToken,
    buildApiUserLog,
    json,
    unauthorized,
    badRequest,
    collectBody,
    CREDIT_COSTS,
    isAdminUser,
    sanitizeUser,
    isRemoteImageUrl,
    assertSafeRemoteImageUrl,
    requestPinnedRemoteImage,
    readGeneratedImageResponseBuffer,
    buildPgyImageRequestHeaders,
    inferImageMimeTypeFromUrl,
    MAX_GENERATED_IMAGE_BYTES,
    PRODUCT_IMAGE_MIME_EXTENSIONS,
  } = bindRouteScope(context);

  function requireUser() {
    const token = getSessionToken(req);
    const user = token ? findUserBySessionToken(token) : null;
    if (!user) {
      unauthorized(res, "请先登录");
      return null;
    }
    req.__redbaseApiUser = buildApiUserLog(user);
    return user;
  }

  function sendExcellentError(error, fallbackMessage) {
    const status =
      Number(error?.statusCode) ||
      (error?.code === "INVALID_BOARD" ||
      error?.code === "INVALID_SOURCE" ||
      error?.code === "INVALID_TAXONOMY" ||
      error?.code === "INVALID_NOTE" ||
      error?.code === "DIRECTION_REQUIRED" ||
      error?.code === "CUSTOM_DIRECTION_TOO_SHORT" ||
      error?.code === "CUSTOM_DIRECTION_TOO_LONG" ||
      error?.code === "INVALID_IDEA_REF"
        ? 400
        : error?.code === "NOTE_NOT_FOUND" ||
            error?.code === "BRAND_NOT_FOUND" ||
            error?.code === "IDEA_NOT_FOUND"
          ? 404
          : 502);
    if (status === 400) {
      badRequest(res, error.message || "请求参数无效");
    } else if (status === 404) {
      json(res, 404, {
        error: error.message || fallbackMessage,
        code: error.code || "NOT_FOUND",
      });
    } else {
      json(res, status, {
        error: error.message || fallbackMessage,
        code: error.code || "EXCELLENT_CONTENT_UNAVAILABLE",
      });
    }
  }

  function writeInsufficientCredits(user, cost) {
    json(res, 402, {
      error: `积分不足，本次操作需要 ${cost} 积分，当前剩余 ${Number(user?.credits || 0)} 积分。`,
      code: "INSUFFICIENT_CREDITS",
      requiredCredits: Number(cost || 0),
      credits: Number(user?.credits || 0),
    });
  }

  if (req.method === "GET" && pathname === "/api/excellent-contents/content-sources") {
    if (!requireUser()) return true;
    json(res, 200, getExcellentContentSourcesList());
    return true;
  }

  if (req.method === "GET" && pathname === "/api/excellent-contents/taxonomy") {
    if (!requireUser()) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const boardRaw = String(url.searchParams.get("board") || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
    if (!getExcellentContentBoard(boardRaw)) {
      badRequest(res, "暂不支持该内容板块。");
      return true;
    }
    try {
      const result = await getExcellentContentTaxonomy(context.appConfig, { board: boardRaw });
      json(res, 200, result);
    } catch (error) {
      sendExcellentError(error, "类目数据暂时不可用");
    }
    return true;
  }

  // Explicit manual refresh — only path that may call Pgy note search for this feature.
  // Free for everyone, but ordinary users get a 60s per-user cooldown; admins bypass it.
  if (req.method === "POST" && pathname === "/api/excellent-contents/refresh") {
    const user = requireUser();
    if (!user) return true;
    const refreshSlot = claimExcellentRefreshSlot(user.id, {
      isAdmin: isAdminUser(user, context.appConfig),
    });
    if (!refreshSlot.allowed) {
      json(res, 429, {
        error: `更新太频繁，请 ${refreshSlot.retryAfterSeconds} 秒后再试。`,
        code: "REFRESH_COOLDOWN",
        retryAfterSeconds: refreshSlot.retryAfterSeconds,
      });
      return true;
    }
    try {
      const payload = (await collectBody(req)) || {};
      const boardRaw =
        String(payload.board || payload.source || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
      if (!getExcellentContentBoard(boardRaw)) {
        releaseExcellentRefreshSlot(user.id);
        badRequest(res, "暂不支持该内容板块。");
        return true;
      }
      const contentSourceRaw = String(payload.contentSource || "all").trim() || "all";
      if (!getExcellentContentSource(contentSourceRaw)) {
        releaseExcellentRefreshSlot(user.id);
        badRequest(res, "暂不支持该内容来源。");
        return true;
      }
      const categoryPath = normalizePgyCategoryPath(payload.categoryPath || "");
      const industryPath = normalizePgyIndustryPath(payload.industryPath || "");
      const result = await refreshExcellentContents(context.appConfig, {
        board: boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      const boardDef = getExcellentContentBoard(boardRaw);
      rewriteExcellentImageUrlsResponse(result, {
        board: boardDef?.value || boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      json(res, 200, result);
    } catch (error) {
      // Upstream failure must not lock the user out for a minute.
      releaseExcellentRefreshSlot(user.id);
      sendExcellentError(error, "优秀内容暂时无法更新，请稍后重试。");
    }
    return true;
  }

  const detailMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/detail$/);
  if (req.method === "GET" && detailMatch) {
    if (!requireUser()) return true;
    const noteId = decodeURIComponent(detailMatch[1] || "").trim();
    if (!noteId) {
      badRequest(res, "缺少笔记 ID");
      return true;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const boardRaw = String(url.searchParams.get("board") || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
    if (!getExcellentContentBoard(boardRaw)) {
      badRequest(res, "暂不支持该内容板块。");
      return true;
    }
    const contentSourceRaw = String(url.searchParams.get("contentSource") || "all").trim() || "all";
    if (!getExcellentContentSource(contentSourceRaw)) {
      badRequest(res, "暂不支持该内容来源。");
      return true;
    }
    const categoryPath = normalizePgyCategoryPath(url.searchParams.get("categoryPath") || "");
    const industryPath = normalizePgyIndustryPath(url.searchParams.get("industryPath") || "");
    try {
      const result = await getExcellentContentDetail(context.appConfig, {
        noteId,
        board: boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      const boardDef = getExcellentContentBoard(boardRaw);
      rewriteExcellentImageUrlsResponse(result, {
        board: boardDef?.value || boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      json(res, 200, result);
    } catch (error) {
      sendExcellentError(error, "详情暂时不可用");
    }
    return true;
  }

  // Same-origin SSRF-safe image proxy: resolves the URL from the cache by
  // noteId + image index only (never accepts an arbitrary URL parameter).
  const excellentImageProxyMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/images\/(\d+)\/file$/);
  if (req.method === "GET" && excellentImageProxyMatch) {
    if (!requireUser()) return true;
    const noteId = decodeURIComponent(excellentImageProxyMatch[1] || "").trim();
    const imageIndex = Number(excellentImageProxyMatch[2]);
    if (!noteId || !Number.isInteger(imageIndex) || imageIndex < 0) {
      badRequest(res, "图片参数无效");
      return true;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const boardRaw =
      String(url.searchParams.get("board") || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
    const contentSourceRaw = String(url.searchParams.get("contentSource") || "all").trim() || "all";
    const categoryPath = normalizePgyCategoryPath(url.searchParams.get("categoryPath") || "");
    const industryPath = normalizePgyIndustryPath(url.searchParams.get("industryPath") || "");
    let hit;
    try {
      const taxonomy = await validateExcellentTaxonomyPath(appConfig, {
        board: boardRaw,
        categoryPath,
        industryPath,
      });
      hit = findNoteInCaches(noteId, boardRaw, {
        contentSource: contentSourceRaw,
        taxonomyPath: taxonomy.taxonomyPath,
      });
    } catch (error) {
      sendExcellentError(error, "图片暂时不可用");
      return true;
    }
    const item = hit?.item || null;
    const urls = normalizeExcellentImageSequence(item);
    const imageUrl = urls[imageIndex];
    if (!imageUrl) {
      json(res, 404, { error: "该图片不存在或已失效", code: "IMAGE_NOT_FOUND" });
      return true;
    }
    if (!isRemoteImageUrl(imageUrl)) {
      json(res, 400, { error: "该图片无法通过代理加载", code: "IMAGE_URL_NOT_PROXYABLE" });
      return true;
    }
    try {
      const target = await assertSafeRemoteImageUrl(imageUrl);
      const response = await requestPinnedRemoteImage(target, {
        headers: buildPgyImageRequestHeaders(appConfig, target.parsed),
      });
      if (!response.ok) {
        if (typeof response.body?.resume === "function") response.body.resume();
        json(res, 502, {
          error: "图片暂时无法获取，请稍后重试",
          code: "REMOTE_IMAGE_UNAVAILABLE",
          upstreamStatus: Number(response.status || 0) || undefined,
        });
        return true;
      }
      const headerMimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mimeType = headerMimeType
        ? PRODUCT_IMAGE_MIME_EXTENSIONS[headerMimeType]
          ? headerMimeType
          : ""
        : inferImageMimeTypeFromUrl(imageUrl);
      if (!PRODUCT_IMAGE_MIME_EXTENSIONS[mimeType]) {
        if (typeof response.body?.resume === "function") response.body.resume();
        json(res, 502, { error: "上游返回的不是图片内容", code: "REMOTE_IMAGE_NOT_IMAGE" });
        return true;
      }
      const buffer = await readGeneratedImageResponseBuffer(response, MAX_GENERATED_IMAGE_BYTES);
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(buffer.length),
      });
      res.end(buffer);
    } catch (error) {
      json(res, 502, { error: "图片暂时无法获取，请稍后重试", code: "REMOTE_IMAGE_UNAVAILABLE" });
    }
    return true;
  }

  const remixAnalysisMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/remix-analysis$/);
  if (req.method === "POST" && remixAnalysisMatch) {
    const user = requireUser();
    if (!user) return true;
    const noteId = decodeURIComponent(remixAnalysisMatch[1] || "").trim();
    if (!noteId) {
      badRequest(res, "缺少笔记 ID");
      return true;
    }
    try {
      const payload = (await collectBody(req)) || {};
      const boardRaw = String(payload.board || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
      if (!getExcellentContentBoard(boardRaw)) {
        badRequest(res, "暂不支持该内容板块。");
        return true;
      }
      const contentSourceRaw = String(payload.contentSource || "all").trim() || "all";
      if (!getExcellentContentSource(contentSourceRaw)) {
        badRequest(res, "暂不支持该内容来源。");
        return true;
      }
      const analysis = await analyzeExcellentNoteForRemix(context.appConfig, {
        noteId,
        board: boardRaw,
        contentSource: contentSourceRaw,
        categoryPath: normalizePgyCategoryPath(payload.categoryPath || ""),
        industryPath: normalizePgyIndustryPath(payload.industryPath || ""),
      });
      json(res, 200, { analysis });
    } catch (error) {
      sendExcellentError(error, "参考方法分析暂时不可用");
    }
    return true;
  }

  const contentDirectionsMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/content-directions$/);
  if (req.method === "POST" && contentDirectionsMatch) {
    const user = requireUser();
    if (!user) return true;
    const noteId = decodeURIComponent(contentDirectionsMatch[1] || "").trim();
    if (!noteId) {
      badRequest(res, "缺少笔记 ID");
      return true;
    }
    const payload = (await collectBody(req)) || {};
    const brandId = Number(payload.brandId);
    if (!Number.isFinite(brandId) || brandId <= 0) {
      badRequest(res, "请选择品牌");
      return true;
    }
    const requestId = normalizeExcellentBillingRequestId(payload.requestId);
    if (!requestId) {
      badRequest(res, "缺少有效的请求标识（requestId），请刷新页面后重试。");
      return true;
    }
    const forceRegenerate = payload.forceRegenerate === true;
    const board = String(payload.board || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
    const learningFocus = normalizeLearningFocus(payload.learningFocus);
    const contentSource = String(payload.contentSource || "all").trim() || "all";
    const categoryPath = normalizePgyCategoryPath(payload.categoryPath || "");
    const industryPath = normalizePgyIndustryPath(payload.industryPath || "");
    const sourceAnalysisId = String(payload.sourceAnalysisId || payload.analysisId || "").trim();
    const brand = brandRepository.findBrandByOwner(brandId, user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限。");
      return true;
    }
    // Server-side input signature: same inputs replay from the 24h cache for free.
    const inputSignature = buildExcellentBillingSignature({
      v: 1,
      kind: EXCELLENT_BILLING_KIND_DIRECTION,
      userId: user.id,
      noteId,
      board,
      brandId,
      brand,
      sourceAnalysisId,
      learningFocus,
      contentSource,
      categoryPath,
      industryPath,
      analysisVersion: ANALYSIS_VERSION,
    });
    const directionCost = Number(CREDIT_COSTS?.excellentContentDirection || 1);
    const reservation = reserveExcellentBillingRequest({
      requestId,
      userId: user.id,
      kind: EXCELLENT_BILLING_KIND_DIRECTION,
      inputSignature,
      creditCost: directionCost,
      forceRegenerate,
    });
    if (reservation.status === "invalid") {
      badRequest(res, "请求标识无效，请刷新页面后重试。");
      return true;
    }
    if (reservation.status === "conflict") {
      json(res, 409, { error: "requestId 已绑定到其他生成输入，请使用新的请求标识。", code: "REQUEST_ID_CONFLICT" });
      return true;
    }
    if (reservation.status === "pending") {
      json(res, 409, { error: "相同请求正在处理中，请稍候。", code: "REQUEST_IN_PROGRESS" });
      return true;
    }
    if (reservation.status === "insufficient") {
      writeInsufficientCredits(reservation.user, reservation.requiredCredits || directionCost);
      return true;
    }
    if (reservation.status === "replay" || reservation.status === "cache") {
      if (!reservation.result) {
        json(res, 502, { error: "历史结果已失效，请重新生成。", code: "REPLAY_RESULT_MISSING" });
        return true;
      }
      json(res, 200, {
        ...reservation.result,
        user: sanitizeUser(reservation.user),
        billing: buildDirectionBilling({
          requestId,
          cacheHit: reservation.status === "cache",
          replayed: reservation.status === "replay",
          charged: false,
          creditCost: 0,
          user: reservation.user,
          snapshot: getDirectionBillingSnapshot(user.id),
        }),
      });
      return true;
    }
    try {
      const result = await generateContentDirections(context.appConfig, {
        userId: user.id,
        noteId,
        board,
        brandId,
        sourceAnalysisId,
        learningFocus,
        contentSource,
        categoryPath,
        industryPath,
        textModelImpl: context.excellentTextModelImpl,
        visionModelImpl: context.excellentVisionModelImpl,
      });
      const isModelResult = result.source === "model";
      const brand = brandRepository.findBrandByOwner(brandId, user.id);
      const settle = settleExcellentBillingRequest({
        requestId,
        userId: user.id,
        kind: EXCELLENT_BILLING_KIND_DIRECTION,
        inputSignature,
        reservationToken: reservation.request.created_at,
        resultSource: isModelResult ? "model" : "fallback",
        resultJson: JSON.stringify(result),
        event: {
          actionType: "excellentContentDirection",
          actionLabel: "优秀内容内容方向生成",
          brandId,
          brandName: brand?.name || "",
          channelLabel: "优秀内容",
          summary: `内容方向 · ${noteId}`,
          payload: { noteId, board },
        },
      });
      json(res, 200, {
        ...result,
        user: sanitizeUser(settle.user),
        billing: buildDirectionBilling({
          requestId,
          cacheHit: false,
          replayed: Boolean(settle.replayed),
          charged: settle.charged,
          creditCost: settle.creditCost,
          user: settle.user,
          snapshot: getDirectionBillingSnapshot(user.id),
        }),
      });
    } catch (error) {
      failExcellentBillingRequest({
        requestId,
        userId: user.id,
        kind: EXCELLENT_BILLING_KIND_DIRECTION,
        inputSignature,
        reservationToken: reservation.request.created_at,
        error: error?.message,
      });
      if (error?.code === "INSUFFICIENT_CREDITS") {
        json(res, 402, { error: error.message, code: error.code });
        return true;
      }
      sendExcellentError(error, "内容方向生成失败");
    }
    return true;
  }

  const recommendTrendsMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/recommend-trends$/);
  if (req.method === "POST" && recommendTrendsMatch) {
    const user = requireUser();
    if (!user) return true;
    const noteId = decodeURIComponent(recommendTrendsMatch[1] || "").trim();
    try {
      const payload = (await collectBody(req)) || {};
      const brandId = Number(payload.brandId);
      if (!Number.isFinite(brandId) || brandId <= 0) {
        badRequest(res, "请选择品牌");
        return true;
      }
      const result = await recommendTrendsForRemix({
        userId: user.id,
        brandId,
        noteId,
        board: payload.board || EXCELLENT_BOARD_DEFAULT,
        contentMode: payload.contentMode,
        direction: payload.direction || payload.smartDirection || null,
        existingIdeaRef: payload.existingIdeaRef || null,
        customDirection: payload.customDirection || "",
        sourceAnalysisId: payload.sourceAnalysisId || "",
      });
      json(res, 200, result);
    } catch (error) {
      sendExcellentError(error, "趋势推荐暂时不可用");
    }
    return true;
  }

  const fusionPlanMatch = pathname.match(/^\/api\/excellent-contents\/([^/]+)\/fusion-plan$/);
  if (req.method === "POST" && fusionPlanMatch) {
    const user = requireUser();
    if (!user) return true;
    const noteId = decodeURIComponent(fusionPlanMatch[1] || "").trim();
    if (!noteId) {
      badRequest(res, "缺少笔记 ID");
      return true;
    }
    const payload = (await collectBody(req)) || {};
    const brandId = Number(payload.brandId);
    if (!Number.isFinite(brandId) || brandId <= 0) {
      badRequest(res, "请选择品牌");
      return true;
    }
    const requestId = normalizeExcellentBillingRequestId(payload.requestId);
    if (!requestId) {
      badRequest(res, "缺少有效的请求标识（requestId），请刷新页面后重试。");
      return true;
    }
    const forceRegenerate = payload.forceRegenerate === true;
    const board = String(payload.board || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
    const learningFocus = normalizeLearningFocus(payload.learningFocus);
    const contentMode = normalizeContentMode(payload.contentMode);
    const smartDirection = payload.smartDirection || payload.direction || null;
    const existingIdeaRef = payload.existingIdeaRef || null;
    const customDirection = String(payload.customDirection || "").trim();
    const useTrendContext = Boolean(payload.useTrendContext);
    const contentSource = String(payload.contentSource || "all").trim() || "all";
    const categoryPath = normalizePgyCategoryPath(payload.categoryPath || "");
    const industryPath = normalizePgyIndustryPath(payload.industryPath || "");
    const sourceAnalysisId = String(payload.sourceAnalysisId || payload.analysisId || "").trim();
    const brand = brandRepository.findBrandByOwner(brandId, user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限。");
      return true;
    }
    let resolvedExistingIdea = null;
    if (contentMode === "existing_idea") {
      try {
        resolvedExistingIdea = resolveExistingIdea(brand, existingIdeaRef || {});
      } catch (error) {
        sendExcellentError(error, "所选内容方向已失效");
        return true;
      }
    }
    // Signature covers user/brand/note/analysis version/learning focus/content direction/trend context.
    const inputSignature = buildExcellentBillingSignature({
      v: 1,
      kind: EXCELLENT_BILLING_KIND_FUSION,
      userId: user.id,
      brandId,
      brand,
      noteId,
      board,
      analysisVersion: ANALYSIS_VERSION,
      sourceAnalysisId,
      learningFocus,
      contentMode,
      smartDirection,
      existingIdeaRef: existingIdeaRef
        ? {
            scope: String(existingIdeaRef.scope || ""),
            analysisId: existingIdeaRef.analysisId ?? null,
            trendId: existingIdeaRef.trendId ?? null,
            ideaIndex: existingIdeaRef.ideaIndex ?? null,
          }
        : null,
      resolvedExistingIdea,
      customDirection,
      useTrendContext,
      trendId: payload.trendId ?? null,
      contentSource,
      categoryPath,
      industryPath,
    });
    const fusionCost = Number(CREDIT_COSTS?.excellentFusionPlan || 1);
    // New generations pre-reserve 1 credit; only a valid AI plan settles the charge.
    const reservation = reserveExcellentBillingRequest({
      requestId,
      userId: user.id,
      kind: EXCELLENT_BILLING_KIND_FUSION,
      inputSignature,
      creditCost: fusionCost,
      forceRegenerate,
    });
    if (reservation.status === "invalid") {
      badRequest(res, "请求标识无效，请刷新页面后重试。");
      return true;
    }
    if (reservation.status === "conflict") {
      json(res, 409, { error: "requestId 已绑定到其他生成输入，请使用新的请求标识。", code: "REQUEST_ID_CONFLICT" });
      return true;
    }
    if (reservation.status === "pending") {
      json(res, 409, { error: "相同请求正在处理中，请稍候。", code: "REQUEST_IN_PROGRESS" });
      return true;
    }
    if (reservation.status === "insufficient") {
      writeInsufficientCredits(reservation.user, reservation.requiredCredits || fusionCost);
      return true;
    }
    if (reservation.status === "replay" || reservation.status === "cache") {
      if (!reservation.result) {
        json(res, 502, { error: "历史方案已失效，请重新生成。", code: "REPLAY_RESULT_MISSING" });
        return true;
      }
      json(res, 200, {
        fusionPlan: reservation.result,
        user: sanitizeUser(reservation.user),
        billing: buildFusionBilling({
          requestId,
          cacheHit: reservation.status === "cache",
          replayed: reservation.status === "replay",
          charged: false,
          creditCost: 0,
          user: reservation.user,
        }),
      });
      return true;
    }
    try {
      const plan = await buildExcellentRemixFusionPlan(context.appConfig, {
        userId: user.id,
        noteId,
        board,
        contentSource,
        categoryPath,
        industryPath,
        brandId,
        learningFocus,
        contentMode: payload.contentMode,
        smartDirection,
        existingIdeaRef,
        customDirection,
        useTrendContext,
        trendId: payload.trendId,
        sourceAnalysisId,
        textModelImpl: context.excellentTextModelImpl,
        visionModelImpl: context.excellentVisionModelImpl,
      });
      // Only a complete AI plan is billable; deterministic fallback releases the reservation.
      const isValidAiPlan = plan.contentGenerationMode === "ai" && hasPublishReadyFusionFields(plan);
      const brand = brandRepository.findBrandByOwner(brandId, user.id);
      const settle = settleExcellentBillingRequest({
        requestId,
        userId: user.id,
        kind: EXCELLENT_BILLING_KIND_FUSION,
        inputSignature,
        reservationToken: reservation.request.created_at,
        resultSource: isValidAiPlan ? "model" : "fallback",
        resultJson: JSON.stringify(plan),
        event: {
          actionType: "excellentFusionPlan",
          actionLabel: "优秀内容融合方案生成",
          brandId,
          brandName: brand?.name || "",
          channelLabel: "优秀内容",
          summary: `融合方案 · ${noteId}`,
          payload: { noteId, board, contentMode },
        },
      });
      json(res, 200, {
        fusionPlan: plan,
        user: sanitizeUser(settle.user),
        billing: buildFusionBilling({
          requestId,
          cacheHit: false,
          replayed: Boolean(settle.replayed),
          charged: settle.charged,
          creditCost: settle.creditCost,
          user: settle.user,
        }),
      });
    } catch (error) {
      failExcellentBillingRequest({
        requestId,
        userId: user.id,
        kind: EXCELLENT_BILLING_KIND_FUSION,
        inputSignature,
        reservationToken: reservation.request.created_at,
        error: error?.message,
      });
      if (error?.code === "INSUFFICIENT_CREDITS") {
        json(res, 402, { error: error.message, code: error.code });
        return true;
      }
      sendExcellentError(error, "融合方案生成失败");
    }
    return true;
  }

  // Flattened idea library for existing_idea mode (no trend-first UX).
  const ideaLibraryMatch = pathname.match(/^\/api\/brands\/(\d+)\/excellent-remix-ideas$/);
  if (req.method === "GET" && ideaLibraryMatch) {
    const user = requireUser();
    if (!user) return true;
    const brandId = Number(ideaLibraryMatch[1]);
    const brand = brandRepository.findBrandByOwner(brandId, user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限。");
      return true;
    }
    json(res, 200, { brandId, ideas: flattenBrandIdeas(brand) });
    return true;
  }

  // Cache-only list. forceRefresh / waitForFresh query flags are intentionally ignored.
  if (req.method === "GET" && pathname === "/api/excellent-contents") {
    if (!requireUser()) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const boardRaw =
      String(url.searchParams.get("board") || url.searchParams.get("source") || EXCELLENT_BOARD_DEFAULT).trim() ||
      EXCELLENT_BOARD_DEFAULT;
    if (!getExcellentContentBoard(boardRaw)) {
      badRequest(res, "暂不支持该内容板块。");
      return true;
    }
    const contentSourceRaw = String(url.searchParams.get("contentSource") || "all").trim() || "all";
    if (!getExcellentContentSource(contentSourceRaw)) {
      badRequest(res, "暂不支持该内容来源。");
      return true;
    }
    const categoryPath = normalizePgyCategoryPath(url.searchParams.get("categoryPath") || "");
    const industryPath = normalizePgyIndustryPath(url.searchParams.get("industryPath") || "");
    try {
      const result = await getExcellentContents(context.appConfig, {
        board: boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      const boardDef = getExcellentContentBoard(boardRaw);
      rewriteExcellentImageUrlsResponse(result, {
        board: boardDef?.value || boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
      });
      json(res, 200, result);
    } catch (error) {
      sendExcellentError(error, "优秀内容暂时不可用，请稍后重试。");
    }
    return true;
  }

  return false;
}

module.exports = {
  handleExcellentContentRoutes,
  normalizeExcellentImageSequence,
};
