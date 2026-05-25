const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { findUserByPhone } = require("../../src/server/db/repositories/auth-repository");
const { handleAuthRoutes } = require("../../src/server/api/auth-routes");
const {
  buildFeishuAccountPhone,
  buildFeishuAuthorizeUrl,
  exchangeFeishuCodeForToken,
  fetchFeishuUserInfo,
  verifyFeishuTenant,
} = require("../../src/server/auth/feishu");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function createReq(url) {
  return {
    method: "GET",
    url,
    headers: {
      host: "localhost:3013",
    },
  };
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    writeHead(code, nextHeaders = {}) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(nextHeaders)) {
        headers.set(key.toLowerCase(), value);
      }
    },
    setHeader(key, value) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = data;
    },
  };
}

test("buildFeishuAuthorizeUrl uses configured app and callback", () => {
  const url = new URL(
    buildFeishuAuthorizeUrl({
      appId: "cli_a",
      redirectUri: "https://redbase.example/api/auth/feishu/callback",
      state: "after-login",
    }),
  );

  assert.equal(url.origin + url.pathname, "https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  assert.equal(url.searchParams.get("client_id"), "cli_a");
  assert.equal(url.searchParams.get("redirect_uri"), "https://redbase.example/api/auth/feishu/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "auth:user.id:read");
  assert.equal(url.searchParams.get("state"), "after-login");
});

test("Feishu token and user-info helpers parse tenant identity", async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes("/oauth/token")) {
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_test",
        union_id: "onion_test",
        tenant_key: "tenant_a",
        name: "易美员工",
        email: "staff@example.com",
      },
    });
  };

  const token = await exchangeFeishuCodeForToken({
    code: "oauth-code",
    appId: "cli_a",
    appSecret: "secret",
    redirectUri: "https://redbase.example/api/auth/feishu/callback",
    fetchImpl: fakeFetch,
  });
  const userInfo = await fetchFeishuUserInfo({ accessToken: token, fetchImpl: fakeFetch });

  assert.equal(token, "user-token");
  assert.equal(userInfo.openId, "ou_test");
  assert.equal(userInfo.tenantKey, "tenant_a");
  assert.equal(userInfo.name, "易美员工");
  assert.equal(calls.length, 2);
});

test("verifyFeishuTenant only accepts the configured tenant", () => {
  assert.equal(verifyFeishuTenant({ tenantKey: "tenant_a" }, "tenant_a"), true);
  assert.equal(verifyFeishuTenant({ tenantKey: "tenant_b" }, "tenant_a"), false);
  assert.equal(verifyFeishuTenant({ tenantKey: "" }, "tenant_a"), false);
});

test("Feishu callback creates a RedBase session for enterprise users", async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_enterprise",
        tenant_key: "tenant_a",
        name: "企业员工",
      },
    });
  };

  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
          tenantKey: "tenant_a",
          baseUrl: "https://redbase.example",
        },
      },
      fetch: fakeFetch,
    },
    createReq("/api/auth/feishu/callback?code=oauth-code"),
    res,
    "/api/auth/feishu/callback",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader("location"), "/");
  assert.match(String(res.getHeader("set-cookie")), /redbase_session=/);

  const user = findUserByPhone(buildFeishuAccountPhone("ou_enterprise"));
  assert.equal(user.name, "企业员工");
  assert.equal(user.accountType, "yimei");
  assert.equal(user.department, "飞书企业成员");
});

test("Feishu callback rejects users from other tenants", async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_external",
        tenant_key: "tenant_b",
        name: "外部用户",
      },
    });
  };

  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
          tenantKey: "tenant_a",
          baseUrl: "https://redbase.example",
        },
      },
      fetch: fakeFetch,
    },
    createReq("/api/auth/feishu/callback?code=oauth-code"),
    res,
    "/api/auth/feishu/callback",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader("location"), "/?authError=feishu_tenant");
  assert.equal(findUserByPhone(buildFeishuAccountPhone("ou_external")), null);
});
