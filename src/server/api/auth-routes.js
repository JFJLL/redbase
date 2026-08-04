const { bindRouteScope } = require("./route-scope");
const { hashPassword, verifyAndMigratePassword } = require("../auth/passwords");
const { setSessionCookie, clearSessionCookie } = require("../auth/cookies");
const { issueVerificationCode, hmacVerificationCode } = require("../auth/verification-service");
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
  createUserWithSession,
  registerUserWithVerification,
  resetPasswordWithVerification,
  createSessionForUser,
  migrateUserPhoneWithSession,
  deleteSession,
} = require("../db/repositories/auth-repository");

const INITIAL_CREDITS = {
  yimei: 50,
  customer: 5,
};

const VERIFICATION_PURPOSES = new Set(["register"]);

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
    const purpose = String(payload.purpose || "register").trim();
    if (purpose === "reset_password") {
      // 通用发码接口只服务注册。重置必须走专用接口，避免通过
      // 200/429 差异枚举账号；此处不查询用户、不发送短信、不写码。
      json(res, 400, { error: "请使用专用重置验证码接口" });
      return true;
    }
    if (!VERIFICATION_PURPOSES.has(purpose)) {
      badRequest(res, "不支持的验证码用途");
      return true;
    }
    const result = await issueVerificationCode({
      appConfig,
      purpose,
      phone: payload.phone,
      req,
    });
    if (!result.ok) {
      json(res, result.status || 500, { error: result.message });
      return true;
    }
    json(res, 200, {
      message: result.message,
      ...(result.demoCode ? { demoCode: result.demoCode } : {}),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const payload = await collectBody(req);
    const { phone, name, password, code } = payload;
    const accountType = "customer";
    const department = "";
    if (!isValidPhone(phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }
    if (!name || !password || String(password).length < 6) {
      badRequest(res, "请填写昵称并设置至少 6 位密码");
      return true;
    }
    if (!code || !/^\d{6}$/.test(String(code))) {
      badRequest(res, "请输入 6 位验证码");
      return true;
    }
    if (phoneExists(phone)) {
      badRequest(res, "该手机号已注册");
      return true;
    }

    const token = randomToken();
    const smsConfig = appConfig?.sms || {};
    if (!smsConfig.pepper) {
      badRequest(res, "验证码服务未启用");
      return true;
    }
    const user = {
      name,
      phone,
      password: await hashPassword(password),
      accountType,
      department,
      credits: INITIAL_CREDITS[accountType],
      createdAt: new Date().toISOString(),
    };
    let savedUser;
    try {
      savedUser = registerUserWithVerification({
        user,
        token,
        purpose: "register",
        phone,
        codeHmac: hmacVerificationCode(smsConfig.pepper, "register", phone, code),
        nowMs: Date.now(),
        maxAttempts: Number(smsConfig.maxAttempts || 5),
      });
    } catch (error) {
      if (String(error?.code || "") === "VERIFICATION_INVALID") {
        badRequest(res, "验证码错误或已过期");
        return true;
      }
      throw error;
    }

    req.__redbaseApiUser = buildApiUserLog(savedUser);
    setSessionCookie(res, token, { secure: appConfig.security.cookieSecure });
    json(res, 201, {
      user: sanitizeUser(savedUser),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/reset-password/send-code") {
    const payload = await collectBody(req);
    if (!isValidPhone(payload.phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }
    const result = await issueVerificationCode({
      appConfig,
      purpose: "reset_password",
      phone: payload.phone,
      req,
    });
    if (!result.ok) {
      // 统一响应：配置问题与限流仍返回对应错误，但不区分账号是否存在。
      json(res, result.status || 500, { error: result.message });
      return true;
    }
    json(res, 200, {
      message: "如果该手机号已注册，验证码已发送。",
      ...(result.demoCode ? { demoCode: result.demoCode } : {}),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/reset-password") {
    const payload = await collectBody(req);
    const { phone, code, password } = payload;
    if (!isValidPhone(phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }
    if (!code || !/^\d{6}$/.test(String(code))) {
      badRequest(res, "请输入 6 位验证码");
      return true;
    }
    if (!password || String(password).length < 6) {
      badRequest(res, "请设置至少 6 位新密码");
      return true;
    }
    const smsConfig = appConfig?.sms || {};
    if (!smsConfig.pepper) {
      badRequest(res, "验证码服务未启用");
      return true;
    }
    try {
      resetPasswordWithVerification({
        phone,
        codeHmac: hmacVerificationCode(smsConfig.pepper, "reset_password", phone, code),
        passwordHash: await hashPassword(password),
        nowMs: Date.now(),
        maxAttempts: Number(smsConfig.maxAttempts || 5),
      });
    } catch (error) {
      if (String(error?.code || "") === "VERIFICATION_INVALID") {
        badRequest(res, "验证码错误或已过期");
        return true;
      }
      throw error;
    }
    clearSessionCookie(res, { secure: appConfig.security.cookieSecure });
    json(res, 200, { ok: true, message: "密码已重置，请重新登录。" });
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

  if (req.method === "GET" && pathname === "/api/auth/feishu/apps") {
    const feishuConfig = normalizeFeishuConfig(appConfig, req);
    json(res, 200, {
      apps: getReadyFeishuApps(feishuConfig).map((app) => ({
        key: app.key,
        name: app.name,
      })),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/auth/feishu/start") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const feishuConfig = normalizeFeishuConfig(appConfig, req, url.searchParams.get("app"));
    if (!isFeishuConfigReady(feishuConfig)) {
      redirect(res, "/?authError=feishu_config");
      return true;
    }

    console.log("[feishu-auth] authorize redirect", {
      appKey: feishuConfig.appKey,
      redirectUri: feishuConfig.redirectUri,
      requestBaseUrl: getRequestBaseUrl(req),
    });

    redirect(
      res,
      buildFeishuAuthorizeUrl({
        appId: feishuConfig.appId,
        redirectUri: feishuConfig.redirectUri,
        state: encodeFeishuState({ app: feishuConfig.appKey, next: "/" }),
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

    const state = decodeFeishuState(url.searchParams.get("state"));
    const feishuConfig = normalizeFeishuConfig(appConfig, req, state.app);
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
      if (!verifyFeishuTenant(userInfo, feishuConfig.tenantKeys)) {
        console.warn("[feishu-auth] tenant mismatch", {
          appKey: feishuConfig.appKey,
          receivedTenantPresent: Boolean(userInfo.tenantKey),
          configuredTenantCount: feishuConfig.tenantKeys.length,
        });
        redirect(res, "/?authError=feishu_tenant");
        return true;
      }

      const token = randomToken();
      const phone = buildFeishuAccountPhone(userInfo.openId, {
        appKey: feishuConfig.appKey,
        tenantKey: userInfo.tenantKey,
      });
      let savedUser = findUserByPhone(phone);
      if (savedUser) {
        savedUser = createSessionForUser(savedUser.id, token);
      } else if (feishuConfig.apps.length === 1 && feishuConfig.tenantKeys.length === 1) {
        const legacyUser = findUserByPhone(buildFeishuAccountPhone(userInfo.openId));
        if (legacyUser) {
          savedUser = migrateUserPhoneWithSession(legacyUser.id, phone, token);
        }
      }
      if (!savedUser) {
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
      redirect(res, normalizeRedirectPath(state.next) || "/");
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

function normalizeFeishuConfig(appConfig, req, appKey = "") {
  const feishu = appConfig?.feishu || {};
  const baseUrl = String(feishu.baseUrl || "").trim() || getRequestBaseUrl(req);
  const apps = normalizeFeishuApps(feishu);
  const selectedApp = selectFeishuApp(apps, appKey);
  return {
    enabled: Boolean(feishu.enabled),
    appKey: selectedApp?.key || "",
    appName: selectedApp?.name || "",
    appId: String(selectedApp?.appId || "").trim(),
    appSecret: String(selectedApp?.appSecret || "").trim(),
    tenantKey: String(selectedApp?.tenantKey || "").trim(),
    tenantKeys: selectedApp?.tenantKeys || [],
    apps,
    redirectUri: `${baseUrl.replace(/\/+$/, "")}/api/auth/feishu/callback`,
  };
}

function isFeishuConfigReady(config) {
  return Boolean(config.enabled && config.appId && config.appSecret && config.redirectUri);
}

function normalizeTenantKeys(feishu) {
  const configuredTenantKeys = Array.isArray(feishu?.tenantKeys) ? feishu.tenantKeys : [];
  const tenantKeys = configuredTenantKeys.length ? configuredTenantKeys : [feishu?.tenantKey];
  return tenantKeys
    .map((tenantKey) => String(tenantKey || "").trim())
    .filter(Boolean)
    .filter((tenantKey, index, all) => all.indexOf(tenantKey) === index);
}

function normalizeFeishuApps(feishu) {
  const configuredApps = Array.isArray(feishu?.apps) && feishu.apps.length
    ? feishu.apps
    : [{
        key: "default",
        name: "飞书企业",
        appId: feishu?.appId,
        appSecret: feishu?.appSecret,
        tenantKey: feishu?.tenantKey,
        tenantKeys: feishu?.tenantKeys,
      }];
  return configuredApps
    .map((app, index) => ({
      key: String(app?.key || app?.name || `app-${index + 1}`).trim(),
      name: String(app?.name || app?.key || `飞书企业 ${index + 1}`).trim(),
      appId: String(app?.appId || "").trim(),
      appSecret: String(app?.appSecret || "").trim(),
      tenantKey: String(app?.tenantKey || "").trim(),
      tenantKeys: normalizeTenantKeys(app),
    }))
    .filter((app, index, all) => app.key && all.findIndex((item) => item.key === app.key) === index);
}

function selectFeishuApp(apps, appKey) {
  const requestedKey = String(appKey || "").trim();
  if (requestedKey) {
    return apps.find((app) => app.key === requestedKey) || null;
  }
  return apps[0] || null;
}

function getReadyFeishuApps(config) {
  if (!config.enabled) return [];
  return config.apps.filter((app) => app.appId && app.appSecret);
}

function encodeFeishuState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeFeishuState(value) {
  const state = String(value || "").trim();
  if (!state) return {};
  if (state.startsWith("/")) return { next: state };
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalizeRedirectPath(value) {
  const path = String(value || "").trim();
  return path.startsWith("/") && !path.startsWith("//") ? path : "";
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
