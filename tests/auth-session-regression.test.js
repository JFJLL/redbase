// 迁移说明：本文件原有 7 个针对旧原生前端（public/app.js、public/js/api-client.js）
// 的会话隔离回归用例（clearSession / sessionEpoch / STALE_SESSION_REQUEST），
// 已随旧前端删除同强度迁移到 Vue 实现的 vitest 用例：
//   frontend/src/shared/stores/__tests__/session-isolation.test.ts
// （AbortSignal 作用域 + notifyAuthReset + Pinia syncOwner 为新等价机制）。
// 下方保留的用例只依赖 src/server，不属于前端迁移范围。
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { handleAuthRoutes } = require("../src/server/api/auth-routes");

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    writeHead(code, values = {}) {
      this.statusCode = code;
      Object.entries(values).forEach(([key, value]) => headers.set(key.toLowerCase(), value));
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    setHeader(key, value) {
      headers.set(String(key).toLowerCase(), value);
    },
    end() {},
  };
}

test("Feishu start logs the selected app and exact redirect URI without credentials", async () => {
  const req = {
    method: "GET",
    url: "/api/auth/feishu/start?app=yimei",
    headers: {
      host: "127.0.0.1:3013",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "redbase.china-yimei.cn",
    },
  };
  const res = createRes();
  const entries = [];
  const originalLog = console.log;
  console.log = (...args) => entries.push(args);
  try {
    await handleAuthRoutes(
      {
        appConfig: {
          security: { cookieSecure: true },
          feishu: {
            enabled: true,
            baseUrl: "https://redbase.china-yimei.cn",
            apps: [
              {
                key: "yimei",
                name: "易美传播",
                appId: "cli_test",
                appSecret: "secret_test",
                tenantKeys: ["tenant_test"],
              },
            ],
          },
        },
      },
      req,
      res,
      "/api/auth/feishu/start",
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(res.statusCode, 302);
  assert.deepEqual(entries, [[
    "[feishu-auth] authorize redirect",
    {
      appKey: "yimei",
      redirectUri: "https://redbase.china-yimei.cn/api/auth/feishu/callback",
      requestBaseUrl: "https://redbase.china-yimei.cn",
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(entries), /cli_test|secret_test|tenant_test/);
});
