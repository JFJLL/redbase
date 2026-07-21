const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { CONFIG_FILE, loadAppConfig } = require("../../src/server/config");
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

function parseJsonBody(res) {
  return JSON.parse(res.body || "{}");
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

test("verifyFeishuTenant accepts any configured tenant key", () => {
  assert.equal(verifyFeishuTenant({ tenantKey: "tenant_b" }, ["tenant_a", "tenant_b"]), true);
  assert.equal(verifyFeishuTenant({ tenantKey: "tenant_c" }, ["tenant_a", "tenant_b"]), false);
  assert.equal(verifyFeishuTenant({ tenantKey: "tenant_a" }, ["", "tenant_a"]), true);
});

test("loadAppConfig parses multiple Feishu tenant keys from environment", () => {
  const previousTenantKey = process.env.FEISHU_TENANT_KEY;
  const previousTenantKeys = process.env.FEISHU_TENANT_KEYS;
  try {
    process.env.FEISHU_TENANT_KEY = "tenant_legacy";
    process.env.FEISHU_TENANT_KEYS = "tenant_a, tenant_b,,tenant_a";

    assert.deepEqual(loadAppConfig().feishu.tenantKeys, ["tenant_a", "tenant_b"]);
  } finally {
    if (previousTenantKey === undefined) {
      delete process.env.FEISHU_TENANT_KEY;
    } else {
      process.env.FEISHU_TENANT_KEY = previousTenantKey;
    }
    if (previousTenantKeys === undefined) {
      delete process.env.FEISHU_TENANT_KEYS;
    } else {
      process.env.FEISHU_TENANT_KEYS = previousTenantKeys;
    }
  }
});

test("loadAppConfig reads multiple Feishu tenant keys from config file", () => {
  const previousTenantKey = process.env.FEISHU_TENANT_KEY;
  const previousTenantKeys = process.env.FEISHU_TENANT_KEYS;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  try {
    delete process.env.FEISHU_TENANT_KEY;
    delete process.env.FEISHU_TENANT_KEYS;
    fs.existsSync = (filePath) => (filePath === CONFIG_FILE ? true : originalExistsSync(filePath));
    fs.readFileSync = (filePath, encoding) => {
      if (filePath !== CONFIG_FILE) return originalReadFileSync(filePath, encoding);
      return JSON.stringify({
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
          tenantKey: "tenant_legacy",
          tenantKeys: ["tenant_a", "tenant_b", "tenant_a"],
        },
      });
    };

    const config = loadAppConfig();

    assert.deepEqual(config.feishu.tenantKeys, ["tenant_a", "tenant_b"]);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    if (previousTenantKey === undefined) {
      delete process.env.FEISHU_TENANT_KEY;
    } else {
      process.env.FEISHU_TENANT_KEY = previousTenantKey;
    }
    if (previousTenantKeys === undefined) {
      delete process.env.FEISHU_TENANT_KEYS;
    } else {
      process.env.FEISHU_TENANT_KEYS = previousTenantKeys;
    }
  }
});

test("loadAppConfig reads multiple Feishu apps from config file", () => {
  const previousTenantKey = process.env.FEISHU_TENANT_KEY;
  const previousTenantKeys = process.env.FEISHU_TENANT_KEYS;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  try {
    delete process.env.FEISHU_TENANT_KEY;
    delete process.env.FEISHU_TENANT_KEYS;
    fs.existsSync = (filePath) => (filePath === CONFIG_FILE ? true : originalExistsSync(filePath));
    fs.readFileSync = (filePath, encoding) => {
      if (filePath !== CONFIG_FILE) return originalReadFileSync(filePath, encoding);
      return JSON.stringify({
        feishu: {
          enabled: true,
          baseUrl: "https://redbase.example",
          apps: [
            {
              key: "yimei",
              name: "易美传播",
              appId: "cli_yimei",
              appSecret: "secret_yimei",
              tenantKeys: ["tenant_yimei"],
            },
            {
              key: "hongmo",
              name: "弘摩科技",
              appId: "cli_hongmo",
              appSecret: "secret_hongmo",
              tenantKeys: ["tenant_hongmo"],
            },
          ],
        },
      });
    };

    const config = loadAppConfig();

    assert.deepEqual(
      config.feishu.apps.map((app) => ({ key: app.key, name: app.name, appId: app.appId, tenantKeys: app.tenantKeys })),
      [
        { key: "yimei", name: "易美传播", appId: "cli_yimei", tenantKeys: ["tenant_yimei"] },
        { key: "hongmo", name: "弘摩科技", appId: "cli_hongmo", tenantKeys: ["tenant_hongmo"] },
      ],
    );
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    if (previousTenantKey === undefined) {
      delete process.env.FEISHU_TENANT_KEY;
    } else {
      process.env.FEISHU_TENANT_KEY = previousTenantKey;
    }
    if (previousTenantKeys === undefined) {
      delete process.env.FEISHU_TENANT_KEYS;
    } else {
      process.env.FEISHU_TENANT_KEYS = previousTenantKeys;
    }
  }
});

test("Feishu apps endpoint exposes configured login choices without secrets", async () => {
  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          baseUrl: "https://redbase.example",
          apps: [
            { key: "yimei", name: "易美传播", appId: "cli_yimei", appSecret: "secret_yimei", tenantKeys: ["tenant_yimei"] },
            { key: "hongmo", name: "弘摩科技", appId: "cli_hongmo", appSecret: "secret_hongmo", tenantKeys: ["tenant_hongmo"] },
          ],
        },
      },
    },
    createReq("/api/auth/feishu/apps"),
    res,
    "/api/auth/feishu/apps",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parseJsonBody(res), {
    apps: [
      { key: "yimei", name: "易美传播" },
      { key: "hongmo", name: "弘摩科技" },
    ],
  });
  assert.doesNotMatch(res.body, /secret_|cli_/);
});

test("Feishu start selects the requested configured app", async () => {
  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          baseUrl: "https://redbase.example",
          apps: [
            { key: "yimei", name: "易美传播", appId: "cli_yimei", appSecret: "secret_yimei", tenantKeys: ["tenant_yimei"] },
            { key: "hongmo", name: "弘摩科技", appId: "cli_hongmo", appSecret: "secret_hongmo", tenantKeys: ["tenant_hongmo"] },
          ],
        },
      },
    },
    createReq("/api/auth/feishu/start?app=hongmo"),
    res,
    "/api/auth/feishu/start",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  const location = new URL(res.getHeader("location"));
  assert.equal(location.searchParams.get("client_id"), "cli_hongmo");
  assert.equal(JSON.parse(Buffer.from(location.searchParams.get("state"), "base64url").toString("utf8")).app, "hongmo");
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
          tenantKeys: ["tenant_a", "tenant_b"],
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

  const user = findUserByPhone(buildFeishuAccountPhone("ou_enterprise", {
    appKey: "default",
    tenantKey: "tenant_a",
  }));
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
  assert.equal(findUserByPhone(buildFeishuAccountPhone("ou_external", {
    appKey: "default",
    tenantKey: "tenant_b",
  })), null);
});

test("Feishu callback prefers tenantKeys over legacy tenantKey", async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_legacy",
        tenant_key: "tenant_legacy",
        name: "旧企业用户",
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
          tenantKey: "tenant_legacy",
          tenantKeys: ["tenant_a", "tenant_b"],
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
  assert.equal(findUserByPhone(buildFeishuAccountPhone("ou_legacy", {
    appKey: "default",
    tenantKey: "tenant_legacy",
  })), null);
});

test("Feishu callback uses the app selected in OAuth state", async () => {
  const tokenRequests = [];
  const fakeFetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/token")) {
      tokenRequests.push(JSON.parse(options.body));
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_hongmo",
        tenant_key: "tenant_hongmo",
        name: "弘摩员工",
      },
    });
  };
  const state = Buffer.from(JSON.stringify({ app: "hongmo", next: "/" }), "utf8").toString("base64url");

  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          baseUrl: "https://redbase.example",
          apps: [
            { key: "yimei", name: "易美传播", appId: "cli_yimei", appSecret: "secret_yimei", tenantKeys: ["tenant_yimei"] },
            { key: "hongmo", name: "弘摩科技", appId: "cli_hongmo", appSecret: "secret_hongmo", tenantKeys: ["tenant_hongmo"] },
          ],
        },
      },
      fetch: fakeFetch,
    },
    createReq(`/api/auth/feishu/callback?code=oauth-code&state=${encodeURIComponent(state)}`),
    res,
    "/api/auth/feishu/callback",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader("location"), "/");
  assert.deepEqual(tokenRequests[0], {
    grant_type: "authorization_code",
    client_id: "cli_hongmo",
    client_secret: "secret_hongmo",
    code: "oauth-code",
    redirect_uri: "https://redbase.example/api/auth/feishu/callback",
  });
  assert.equal(findUserByPhone(buildFeishuAccountPhone("ou_hongmo", {
    appKey: "hongmo",
    tenantKey: "tenant_hongmo",
  })).name, "弘摩员工");
});

test("Feishu callbacks namespace identical open IDs by app and tenant", async () => {
  const appConfig = {
    security: { cookieSecure: false },
    feishu: {
      enabled: true,
      baseUrl: "https://redbase.example",
      apps: [
        { key: "yimei-scope", name: "易美传播", appId: "cli_yimei_scope", appSecret: "secret_yimei", tenantKeys: ["tenant_yimei_scope"] },
        { key: "hongmo-scope", name: "弘摩科技", appId: "cli_hongmo_scope", appSecret: "secret_hongmo", tenantKeys: ["tenant_hongmo_scope"] },
      ],
    },
  };
  const fakeFetch = async (url, options = {}) => {
    if (String(url).includes("/oauth/token")) {
      const request = JSON.parse(options.body);
      return jsonResponse({ access_token: `token-${request.client_id}` });
    }
    const authorization = String(options.headers?.Authorization || "");
    const isYimei = authorization.includes("cli_yimei_scope");
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_same_across_apps",
        tenant_key: isYimei ? "tenant_yimei_scope" : "tenant_hongmo_scope",
        name: isYimei ? "易美同号员工" : "弘摩同号员工",
      },
    });
  };

  for (const app of ["yimei-scope", "hongmo-scope"]) {
    const state = Buffer.from(JSON.stringify({ app, next: "/" }), "utf8").toString("base64url");
    const res = createRes();
    await handleAuthRoutes(
      { appConfig, fetch: fakeFetch },
      createReq(`/api/auth/feishu/callback?code=oauth-code&state=${encodeURIComponent(state)}`),
      res,
      "/api/auth/feishu/callback",
    );
    assert.equal(res.statusCode, 302);
    assert.equal(res.getHeader("location"), "/");
  }

  const yimeiUser = findUserByPhone(buildFeishuAccountPhone("ou_same_across_apps", {
    appKey: "yimei-scope",
    tenantKey: "tenant_yimei_scope",
  }));
  const hongmoUser = findUserByPhone(buildFeishuAccountPhone("ou_same_across_apps", {
    appKey: "hongmo-scope",
    tenantKey: "tenant_hongmo_scope",
  }));
  assert.ok(yimeiUser);
  assert.ok(hongmoUser);
  assert.notEqual(yimeiUser.id, hongmoUser.id);
  assert.equal(yimeiUser.name, "易美同号员工");
  assert.equal(hongmoUser.name, "弘摩同号员工");
});

test("Feishu callback logs tenant mismatch for apps awaiting tenant key discovery", async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return jsonResponse({ access_token: "user-token" });
    }
    return jsonResponse({
      code: 0,
      data: {
        open_id: "ou_pending",
        tenant_key: "tenant_pending",
        name: "待授权员工",
      },
    });
  };
  const state = Buffer.from(JSON.stringify({ app: "pending", next: "/" }), "utf8").toString("base64url");

  const res = createRes();
  const handled = await handleAuthRoutes(
    {
      appConfig: {
        security: { cookieSecure: false },
        feishu: {
          enabled: true,
          baseUrl: "https://redbase.example",
          apps: [
            { key: "pending", name: "待配置企业", appId: "cli_pending", appSecret: "secret_pending", tenantKeys: [] },
          ],
        },
      },
      fetch: fakeFetch,
    },
    createReq(`/api/auth/feishu/callback?code=oauth-code&state=${encodeURIComponent(state)}`),
    res,
    "/api/auth/feishu/callback",
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader("location"), "/?authError=feishu_tenant");
  assert.equal(findUserByPhone(buildFeishuAccountPhone("ou_pending", {
    appKey: "pending",
    tenantKey: "tenant_pending",
  })), null);
});
