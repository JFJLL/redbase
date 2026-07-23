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
} = require("../services/excellent-content-service");
const {
  normalizePgyCategoryPath,
  normalizePgyIndustryPath,
} = require("../integrations/pgy-content-square");
const { analyzeExcellentNoteForRemix } = require("../services/excellent-remix-analysis-service");
const {
  generateContentDirections,
  recommendTrendsForRemix,
  buildExcellentRemixFusionPlan,
  flattenBrandIdeas,
} = require("../services/excellent-remix-fusion-service");
const brandRepository = require("../db/repositories/brand-repository");

async function handleExcellentContentRoutes(context, req, res, pathname) {
  const { getSessionToken, buildApiUserLog, json, unauthorized, badRequest, collectBody } =
    bindRouteScope(context);

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
  if (req.method === "POST" && pathname === "/api/excellent-contents/refresh") {
    if (!requireUser()) return true;
    try {
      const payload = (await collectBody(req)) || {};
      const boardRaw =
        String(payload.board || payload.source || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
      if (!getExcellentContentBoard(boardRaw)) {
        badRequest(res, "暂不支持该内容板块。");
        return true;
      }
      const contentSourceRaw = String(payload.contentSource || "all").trim() || "all";
      if (!getExcellentContentSource(contentSourceRaw)) {
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
      json(res, 200, result);
    } catch (error) {
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
      json(res, 200, result);
    } catch (error) {
      sendExcellentError(error, "详情暂时不可用");
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
    try {
      const payload = (await collectBody(req)) || {};
      const brandId = Number(payload.brandId);
      if (!Number.isFinite(brandId) || brandId <= 0) {
        badRequest(res, "请选择品牌");
        return true;
      }
      const result = await generateContentDirections(context.appConfig, {
        userId: user.id,
        noteId,
        board: String(payload.board || EXCELLENT_BOARD_DEFAULT),
        brandId,
        sourceAnalysisId: payload.sourceAnalysisId || payload.analysisId || "",
        learningFocus: payload.learningFocus,
        contentSource: payload.contentSource || "all",
        categoryPath: normalizePgyCategoryPath(payload.categoryPath || ""),
        industryPath: normalizePgyIndustryPath(payload.industryPath || ""),
      });
      json(res, 200, result);
    } catch (error) {
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
    try {
      const payload = (await collectBody(req)) || {};
      const brandId = Number(payload.brandId);
      if (!Number.isFinite(brandId) || brandId <= 0) {
        badRequest(res, "请选择品牌");
        return true;
      }
      const plan = await buildExcellentRemixFusionPlan(context.appConfig, {
        userId: user.id,
        noteId,
        board: payload.board || EXCELLENT_BOARD_DEFAULT,
        contentSource: payload.contentSource || "all",
        categoryPath: normalizePgyCategoryPath(payload.categoryPath || ""),
        industryPath: normalizePgyIndustryPath(payload.industryPath || ""),
        brandId,
        learningFocus: payload.learningFocus,
        contentMode: payload.contentMode,
        smartDirection: payload.smartDirection || payload.direction || null,
        existingIdeaRef: payload.existingIdeaRef || null,
        customDirection: payload.customDirection || "",
        useTrendContext: Boolean(payload.useTrendContext),
        trendId: payload.trendId,
        sourceAnalysisId: payload.sourceAnalysisId || payload.analysisId || "",
      });
      json(res, 200, { fusionPlan: plan });
    } catch (error) {
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
};
