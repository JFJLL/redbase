const { bindRouteScope } = require("./route-scope");
const { findUserBySessionToken } = require("../db/repositories/auth-repository");
const {
  EXCELLENT_BOARD_DEFAULT,
  getExcellentContentBoard,
  getExcellentContentSource,
  getExcellentContents,
  getExcellentContentDetail,
  getExcellentContentTaxonomy,
  getExcellentContentSourcesList,
} = require("../services/excellent-content-service");
const {
  normalizePgyCategoryPath,
  normalizePgyIndustryPath,
} = require("../integrations/pgy-content-square");

async function handleExcellentContentRoutes(context, req, res, pathname) {
  const { getSessionToken, buildApiUserLog, json, unauthorized, badRequest } = bindRouteScope(context);

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
      const status = Number(error?.statusCode) || 502;
      if (status === 400) {
        badRequest(res, error.message || "请求参数无效");
      } else {
        json(res, status, {
          error: error.message || "类目数据暂时不可用",
          code: error.code || "TAXONOMY_UNAVAILABLE",
        });
      }
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
    try {
      const result = await getExcellentContentDetail(context.appConfig, {
        noteId,
        board: boardRaw,
      });
      json(res, 200, result);
    } catch (error) {
      const status = Number(error?.statusCode) || 502;
      if (status === 400) {
        badRequest(res, error.message || "请求参数无效");
      } else {
        json(res, status, {
          error: error.message || "详情暂时不可用",
          code: error.code || "DETAIL_UNAVAILABLE",
        });
      }
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/excellent-contents") {
    if (!requireUser()) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    // Prefer board; legacy source= treated as board id (xhs_hot).
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
    const waitForFreshRaw = String(url.searchParams.get("waitForFresh") || "").trim().toLowerCase();
    const waitForFresh = waitForFreshRaw === "1" || waitForFreshRaw === "true";
    try {
      const result = await getExcellentContents(context.appConfig, {
        board: boardRaw,
        contentSource: contentSourceRaw,
        categoryPath,
        industryPath,
        waitForFresh,
      });
      json(res, 200, result);
    } catch (error) {
      const status =
        Number(error?.statusCode) ||
        (error?.code === "INVALID_BOARD" || error?.code === "INVALID_SOURCE" ? 400 : 502);
      if (status === 400) {
        badRequest(res, error.message || "请求参数无效");
      } else {
        json(res, status, {
          error: error.message || "优秀内容暂时不可用，请稍后重试。",
          code: error.code || "EXCELLENT_CONTENT_UNAVAILABLE",
        });
      }
    }
    return true;
  }

  return false;
}

module.exports = {
  handleExcellentContentRoutes,
};
