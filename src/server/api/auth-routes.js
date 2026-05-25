const { bindRouteScope } = require("./route-scope");
const { hashPassword, verifyAndMigratePassword } = require("../auth/passwords");
const { setSessionCookie, clearSessionCookie } = require("../auth/cookies");
const {
  buildFeishuAccountPhone,
  buildFeishuAuthorizeUrl,
  exchangeFeishuCodeForToken,
  fetchFeishuUserInfo,
  verifyFeishuTenant,
} = require("../auth/feishu");
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
    fetch: fetchImpl,
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

  if (req.method === "GET" && pathname === "/api/auth/feishu/start") {
    const feishuConfig = normalizeFeishuConfig(appConfig, req);
    if (!isFeishuConfigReady(feishuConfig)) {
      redirect(res, "/?authError=feishu_config");
      return true;
    }

    redirect(
      res,
      buildFeishuAuthorizeUrl({
        appId: feishuConfig.appId,
        redirectUri: feishuConfig.redirectUri,
        state: "/",
      }),
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/api/auth/feishu/callback") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.searchParams.get("error")) {
      redirect(res, "/?authError=feishu_denied");
      return true;
    }

    const code = String(url.searchParams.get("code") || "").trim();
    if (!code) {
      badRequest(res, "缺少飞书授权码");
      return true;
    }

    const feishuConfig = normalizeFeishuConfig(appConfig, req);
    if (!isFeishuConfigReady(feishuConfig)) {
      redirect(res, "/?authError=feishu_config");
      return true;
    }

    try {
      const accessToken = await exchangeFeishuCodeForToken({
        code,
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        redirectUri: feishuConfig.redirectUri,
        fetchImpl,
      });
      const userInfo = await fetchFeishuUserInfo({ accessToken, fetchImpl });
      if (!userInfo.openId) {
        redirect(res, "/?authError=feishu_profile");
        return true;
      }
      if (!verifyFeishuTenant(userInfo, feishuConfig.tenantKey)) {
        console.warn("[feishu-auth] tenant mismatch", {
          receivedTenantKey: userInfo.tenantKey || "",
          configuredTenantKey: feishuConfig.tenantKey,
        });
        redirect(res, "/?authError=feishu_tenant");
        return true;
      }

      const token = randomToken();
      const phone = buildFeishuAccountPhone(userInfo.openId);
      let savedUser = findUserByPhone(phone);
      if (savedUser) {
        savedUser = createSessionForUser(savedUser.id, token);
      } else {
        savedUser = createUserWithSession({
          token,
          user: {
            name: userInfo.name || "飞书用户",
            phone,
            password: await hashPassword(`feishu:${randomToken()}`),
            accountType: "yimei",
            department: "飞书企业成员",
            credits: INITIAL_CREDITS.yimei,
            createdAt: new Date().toISOString(),
          },
        });
      }

      req.__redbaseApiUser = buildApiUserLog(savedUser);
      setSessionCookie(res, token, { secure: appConfig.security.cookieSecure });
      redirect(res, "/");
    } catch (error) {
      console.error("[feishu-auth] callback failed", error);
      redirect(res, "/?authError=feishu_failed");
    }
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

function normalizeFeishuConfig(appConfig, req) {
  const feishu = appConfig?.feishu || {};
  const baseUrl = String(feishu.baseUrl || "").trim() || getRequestBaseUrl(req);
  return {
    enabled: Boolean(feishu.enabled),
    appId: String(feishu.appId || "").trim(),
    appSecret: String(feishu.appSecret || "").trim(),
    tenantKey: String(feishu.tenantKey || "").trim(),
    redirectUri: `${baseUrl.replace(/\/+$/, "")}/api/auth/feishu/callback`,
  };
}

function isFeishuConfigReady(config) {
  return Boolean(config.enabled && config.appId && config.appSecret && config.tenantKey && config.redirectUri);
}

function getRequestBaseUrl(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${protocol}://${host}` : "";
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end("");
}

module.exports = {
  handleAuthRoutes,
};
