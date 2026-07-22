const { bindRouteScope } = require("./route-scope");
const { findUserBySessionToken } = require("../db/repositories/auth-repository");
const {
  EXCELLENT_SOURCE_DEFAULT,
  getExcellentContentSource,
  getExcellentContents,
} = require("../services/excellent-content-service");
const { normalizePgyCategoryPath } = require("../integrations/pgy-content-square");

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

  if (req.method === "GET" && pathname === "/api/excellent-contents") {
    if (!requireUser()) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sourceRaw = String(url.searchParams.get("source") || EXCELLENT_SOURCE_DEFAULT).trim() || EXCELLENT_SOURCE_DEFAULT;
    if (!getExcellentContentSource(sourceRaw)) {
      badRequest(res, "暂不支持该内容来源。");
      return true;
    }
    const categoryPath = normalizePgyCategoryPath(url.searchParams.get("categoryPath") || "");
    const waitForFreshRaw = String(url.searchParams.get("waitForFresh") || "").trim().toLowerCase();
    const waitForFresh = waitForFreshRaw === "1" || waitForFreshRaw === "true";
    try {
      const result = await getExcellentContents(context.appConfig, {
        source: sourceRaw,
        categoryPath,
        waitForFresh,
      });
      json(res, 200, result);
    } catch (error) {
      const status = Number(error?.statusCode) || (error?.code === "INVALID_SOURCE" ? 400 : 502);
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
