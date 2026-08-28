const { findUserBySessionToken } = require("../db/repositories/auth-repository");

function requireAdminFromSql(req, res, { getSessionToken, buildApiUserLog, isAdminUser, appConfig, unauthorized, forbidden }) {
  const token = typeof getSessionToken === "function" ? getSessionToken(req) : null;
  const user = token ? findUserBySessionToken(token) : null;
  if (!user) {
    if (typeof unauthorized === "function") {
      unauthorized(res, "请先登录");
    } else {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "请先登录" }));
    }
    return null;
  }
  const checkIsAdmin = typeof isAdminUser === "function"
    ? isAdminUser
    : (u, cfg) => Boolean(cfg?.admin?.phone && u.phone === cfg.admin.phone);
  if (!checkIsAdmin(user, appConfig)) {
    if (typeof forbidden === "function") {
      forbidden(res, "当前账号没有管理后台权限");
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "当前账号没有管理后台权限" }));
    }
    return null;
  }
  if (typeof buildApiUserLog === "function") {
    req.__redbaseApiUser = buildApiUserLog(user);
  }
  return user;
}

module.exports = {
  requireAdminFromSql,
};
