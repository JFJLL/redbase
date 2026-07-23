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
      error?.code === "INVALID_TAXONOMY"
        ? 400
        : 502);
    if (status === 400) {
      badRequest(res, error.message || "请求参数无效");
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
