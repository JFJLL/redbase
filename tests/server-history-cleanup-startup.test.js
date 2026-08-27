const http = require("http");
const https = require("https");
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";
process.env.PORT = "0";
// 隔离真实 OSS 配置（config.local.json/.env 中的 aliyun_oss，bucket redmagic）：
// readEnvOverride 对空字符串生效，loadAppConfig() 解析出的 assetStorage
// provider 将回退为 local。必须在 require 任何 src/server 模块之前设置，
// 因为 config.js 在模块加载时缓存配置。
process.env.ALIYUN_OSS_ENDPOINT = "";
process.env.ALIYUN_OSS_BUCKET = "";
process.env.ALIYUN_OSS_PREFIX = "";
process.env.ALIYUN_OSS_ACCESS_KEY_ID = "";
process.env.ALIYUN_OSS_ACCESS_KEY_SECRET = "";

const { ensureStore } = require("../src/server/store");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { upsertGeneration, findGenerationById } = require("../src/server/db/repositories/generation-repository");
const { beginVideoScriptRequest, findVideoScriptRequest } = require("../src/server/db/repositories/video-script-billing-repository");
const { start } = require("../src/server/index");

// 网络守卫：start() 期间任何出站请求都直接让测试失败。即使本地存在真实
// OSS 配置，测试也不得发起任何网络请求（含 http.get/https.get 派生入口）。
function createNetworkGuard(transport) {
  return function guardOutboundRequest(...args) {
    const first = args[0];
    const target = typeof first === "string"
      ? first
      : String(first?.hostname || first?.host || first?.url || "");
    assert.fail(
      `[network-guard] 本地存在真实 OSS 配置但测试不发网络请求：unexpected ${transport} request during startup test (target: ${target})`,
    );
  };
}

const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;
http.request = createNetworkGuard("http.request");
http.get = createNetworkGuard("http.get");
https.request = createNetworkGuard("https.request");
https.get = createNetworkGuard("https.get");

after(() => {
  http.request = originalHttpRequest;
  http.get = originalHttpGet;
  https.request = originalHttpsRequest;
  https.get = originalHttpsGet;
});

test("server startup removes expired generation history before listening", async () => {
  await ensureStore();
  insertUser({
    id: 8801,
    name: "Startup Cleanup",
    phone: "13910008801",
    password: "hash",
    accountType: "customer",
    credits: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  beginVideoScriptRequest({
    userId: 8801,
    requestId: "startup-stale-video-script",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    creditCost: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    event: {
      actionType: "videoScript",
      actionLabel: "视频脚本生成",
      channelLabel: "视频脚本",
      payload: { requestId: "startup-stale-video-script" },
    },
  });
  upsertGeneration({
    id: 8801,
    ownerUserId: 8801,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 0,
    brandName: "",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: "expired startup generation",
    createdAt: "2020-01-01T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: {},
  });

  const server = await start();
  try {
    assert.equal(findGenerationById(8801), null);
    assert.equal(findVideoScriptRequest(8801, "startup-stale-video-script").status, "refunded");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
