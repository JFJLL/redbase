const { bindRouteScope } = require("./route-scope");
const { hashPassword, verifyAndMigratePassword } = require("../auth/passwords");
const { setSessionCookie, clearSessionCookie } = require("../auth/cookies");
const {
  findUserByPhone,
  findUserBySessionToken,
  phoneExists,
  updateUserPassword,
  upsertVerificationCode,
  createUserWithSession,
  createSessionForUser,
  deleteSession,
} = require("../db/repositories/auth-repository");

const VERIFICATION_CODE_MIN = 100000;
const VERIFICATION_CODE_RANGE = 900000;
const VERIFICATION_CODE_EXPIRY_MS = 5 * 60 * 1000;
const INITIAL_CREDITS = {
  yimei: 50,
  customer: 5,
};

async function handleAuthRoutes(context, req, res, pathname) {
  const {
    appConfig,
    randomToken,
    isValidPhone,
    sanitizeUser,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    isAdminUser,
    json,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  if (req.method === "POST" && pathname === "/api/auth/send-code") {
    const payload = await collectBody(req);
    if (!isValidPhone(payload.phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }

    const code = String(Math.floor(VERIFICATION_CODE_MIN + Math.random() * VERIFICATION_CODE_RANGE));
    upsertVerificationCode(payload.phone, code, Date.now() + VERIFICATION_CODE_EXPIRY_MS);
    json(res, 200, {
      message: "验证码已生成，可直接用于当前环境注册。",
      demoCode: code,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const payload = await collectBody(req);
    const { phone, name, password } = payload;
    const accountType = payload.accountType === "yimei" ? "yimei" : "customer";
    const department = accountType === "yimei" ? String(payload.department || "").trim() : "";
    if (!isValidPhone(phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }
    if (!name || !password || String(password).length < 6) {
      badRequest(res, "请填写昵称并设置至少 6 位密码");
      return true;
    }
    if (accountType === "yimei" && !department) {
      badRequest(res, "请选择部门");
      return true;
    }

    if (phoneExists(phone)) {
      badRequest(res, "该手机号已注册");
      return true;
    }

    const token = randomToken();
    const user = {
      name,
      phone,
      password: await hashPassword(password),
      accountType,
      department,
      credits: INITIAL_CREDITS[accountType],
      createdAt: new Date().toISOString(),
    };
    const savedUser = createUserWithSession({ user, token });

    req.__redbaseApiUser = buildApiUserLog(savedUser);
    setSessionCookie(res, token, { secure: appConfig.security.cookieSecure });
    json(res, 201, {
      user: sanitizeUser(savedUser),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const payload = await collectBody(req);
    const { phone, password } = payload;
    const user = findUserByPhone(phone);
    const verified = await verifyAndMigratePassword(user, password);
    if (!verified.ok) {
      unauthorized(res, "手机号或密码错误");
      return true;
    }
    if (verified.migrated) {
      updateUserPassword(user.id, user.password);
    }

    const token = randomToken();
    const savedUser = createSessionForUser(user.id, token);
    req.__redbaseApiUser = buildApiUserLog(savedUser);
    setSessionCookie(res, token, { secure: appConfig.security.cookieSecure });
    json(res, 200, {
      user: sanitizeUser(savedUser),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/session") {
    const token = getSessionToken(req);
    const user = token ? findUserBySessionToken(token) : null;
    if (!user) {
      unauthorized(res, "登录状态已失效");
      return true;
    }
    json(res, 200, { user: { ...sanitizeUser(user), isAdmin: isAdminUser(user, appConfig) } });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = getSessionToken(req);
    if (token) {
      deleteSession(token);
    }
    clearSessionCookie(res, { secure: appConfig.security.cookieSecure });
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleAuthRoutes,
};
