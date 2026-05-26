const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const FEISHU_SCOPE = "auth:user.id:read";
const FEISHU_REQUEST_TIMEOUT_MS = 10000;

function buildFeishuAuthorizeUrl({ appId, redirectUri, state = "" }) {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set("client_id", String(appId || "").trim());
  url.searchParams.set("redirect_uri", String(redirectUri || "").trim());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FEISHU_SCOPE);
  if (state) {
    url.searchParams.set("state", String(state));
  }
  return url.toString();
}

async function exchangeFeishuCodeForToken({ code, appId, appSecret, redirectUri, fetchImpl = globalThis.fetch }) {
  assertFetch(fetchImpl);
  const data = await postJson(
    fetchImpl,
    FEISHU_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: String(appId || "").trim(),
      client_secret: String(appSecret || "").trim(),
      code: String(code || "").trim(),
      redirect_uri: String(redirectUri || "").trim(),
    },
    "Feishu token exchange failed",
  );

  if (data.error || data.code) {
    throw new Error(`Feishu token exchange failed: ${data.error_description || data.msg || data.error || data.code}`);
  }
  if (!data.access_token) {
    throw new Error("Feishu token exchange failed: access_token missing");
  }
  return data.access_token;
}

async function fetchFeishuUserInfo({ accessToken, fetchImpl = globalThis.fetch }) {
  assertFetch(fetchImpl);
  const data = await getJson(
    fetchImpl,
    FEISHU_USER_INFO_URL,
    {
      Authorization: `Bearer ${String(accessToken || "").trim()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    "Feishu user info failed",
  );

  if (data.code !== 0) {
    throw new Error(`Feishu user info failed: ${data.msg || data.code}`);
  }

  const profile = data.data || {};
  return {
    openId: String(profile.open_id || "").trim(),
    unionId: String(profile.union_id || "").trim(),
    tenantKey: String(profile.tenant_key || "").trim(),
    name: String(profile.name || profile.en_name || "").trim(),
    email: String(profile.email || profile.enterprise_email || "").trim(),
  };
}

function verifyFeishuTenant(userInfo, tenantKey) {
  const receivedTenantKey = String(userInfo?.tenantKey || "").trim();
  const expectedTenantKeys = (Array.isArray(tenantKey) ? tenantKey : [tenantKey])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!receivedTenantKey || !expectedTenantKeys.length) return false;
  return expectedTenantKeys.includes(receivedTenantKey);
}

function buildFeishuAccountPhone(openId) {
  return `feishu:${String(openId || "").trim()}`;
}

async function postJson(fetchImpl, url, payload, label) {
  return requestJson(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, label);
}

async function getJson(fetchImpl, url, headers, label) {
  return requestJson(fetchImpl, url, {
    method: "GET",
    headers,
  }, label);
}

async function requestJson(fetchImpl, url, options, label) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FEISHU_REQUEST_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller?.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for Feishu auth requests");
  }
}

module.exports = {
  FEISHU_SCOPE,
  buildFeishuAccountPhone,
  buildFeishuAuthorizeUrl,
  exchangeFeishuCodeForToken,
  fetchFeishuUserInfo,
  verifyFeishuTenant,
};
