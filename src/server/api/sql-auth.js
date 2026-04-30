const { findUserBySessionToken } = require("../db/repositories/auth-repository");

function getAuthenticatedSqlUser(req, helpers) {
  const token = helpers.getSessionToken(req);
  const user = token ? findUserBySessionToken(token) : null;
  if (user && req) {
    req.__redbaseApiUser = helpers.buildApiUserLog(user);
  }
  return user;
}

function requireSqlAuth(req, res, helpers) {
  const user = getAuthenticatedSqlUser(req, helpers);
  if (!user) {
    helpers.unauthorized(res, "请先登录");
    return null;
  }
  return user;
}

module.exports = {
  getAuthenticatedSqlUser,
  requireSqlAuth,
};
