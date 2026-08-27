const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { insertProductImage } = require("../../src/server/db/repositories/product-image-repository");
const { findGenerationByOwner } = require("../../src/server/db/repositories/generation-repository");
const { createApiHandler } = require("../../src/server/api");
const { createAiServices } = require("../../src/server/ai");
const { DEFAULT_APP_CONFIG } = require("../../src/server/config");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const TEST_USER = {
  id: 101,
  name: "Video Tester",
  phone: "13900000101",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-08-20T00:00:00.000Z",
};

const OTHER_USER = {
  id: 102,
  name: "Other User",
  phone: "13900000102",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-08-20T00:00:00.000Z",
};

insertUser(TEST_USER);
insertUser(OTHER_USER);

const SAMPLE_TRENDS = [
  {
    key: "traffic",
    title: "流量趋势",
    description: "流量热点",
    items: [
      {
        id: 501,
        stableKey: "trend-501",
        rank: 1,
        score: 95,
        reason: "高热度话题",
        title: "露营咖啡热点",
        category: "生活方式",
        summary: "户外手冲咖啡成为年轻人露营新时尚",
        ideas: [
          {
            title: "山野清晨的第一杯冰手冲",
            summary: "在露营帐篷前冲一杯清凉咖啡",
            angle: "消暑露营手冲",
            brandFit: "结合品牌手冲壶与冷萃豆",
            audience: "户外爱好者",
            hook: "听听冰块碰撞的声音",
            tags: ["户外露营", "手冲咖啡"],
          },
        ],
      },
    ],
  },
];

const BRAND = insertBrand({
  id: 1,
  ownerUserId: TEST_USER.id,
  name: "野奢咖啡",
  industry: "食品饮料",
  profileType: "brand",
  description: "专业户外精品咖啡品牌",
  product: "便携手冲器具与精品咖啡豆",
  audience: "25-35岁热爱户外的年轻人",
  goal: "打造户外咖啡第一品牌",
});
upsertBrandFull({
  ...BRAND,
  trends: SAMPLE_TRENDS,
});

function createMockServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const handled = await handler(req, res, url.pathname);
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  return server;
}

function makeRequest(server, options, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = { ...(options.headers || {}) };
    let postData = "";
    if (body) {
      postData = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData);
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

test("POST /video-script requires authentication", async (t) => {
  const ai = createAiServices(DEFAULT_APP_CONFIG);
  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
    },
    { requestId: "req-unauth" },
  );

  assert.equal(res.status, 401);
});

test("POST /video-script rejects brand not owned by user", async (t) => {
  const ai = createAiServices(DEFAULT_APP_CONFIG);
  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const sessionToken = "session-user-102";
  insertSession({ token: sessionToken, userId: OTHER_USER.id, createdAt: new Date().toISOString() });

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
    { requestId: "req-other-user" },
  );

  assert.equal(res.status, 400);
  assert.match(res.body.error, /没有访问权限/);
});

test("POST /video-script generates script, deducts 1 credit, is idempotent with requestId", async (t) => {
  // Fake Google model server
  let modelCallCount = 0;
  let receivedParts = [];
  const modelServer = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      modelCallCount += 1;
      const parsed = JSON.parse(raw);
      receivedParts = parsed.contents?.[0]?.parts || [];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "山野清晨手冲咖啡视频脚本",
                      creativeConcept: "露营消暑手冲咖啡",
                      totalDurationSec: 30,
                      aspectRatio: "9:16",
                      globalSubjectReference: "户外手冲咖啡壶",
                      globalStyleReference: "清晨自然光电影感",
                      globalContinuity: "动作流畅推进",
                      audioDirection: {
                        music: "轻快吉他旋律",
                        ambience: "冰块与水流声",
                        voiceStyle: "治愈自然独白",
                      },
                      clips: [
                        {
                          index: 1,
                          startSec: 0,
                          endSec: 5,
                          durationSec: 5,
                          purpose: "开场抓人",
                          firstFrame: "冰块落入玻璃杯特写",
                          lastFrame: "杯壁泛起水汽",
                          subjectReference: "冰块与玻璃杯",
                          scene: "晨光下的露营帐篷前",
                          subjectAction: "冰块旋转",
                          cameraMovement: "慢速微距推近",
                          environmentMotion: "光影流转",
                          lightingAndStyle: "清晨自然逆光",
                          audioPrompt: "冰块撞击声",
                          prompt: "Cinematic close-up of ice cubes in glass, morning sun.",
                        },
                        {
                          index: 2,
                          startSec: 5,
                          endSec: 30,
                          durationSec: 25,
                          purpose: "产品萃取亮点",
                          firstFrame: "细水流注水",
                          lastFrame: "咖啡滴落完成",
                          subjectReference: "野奢手冲壶",
                          scene: "露营木桌",
                          subjectAction: "平稳画圈注水",
                          cameraMovement: "45度环绕",
                          environmentMotion: "咖啡香气微烟升腾",
                          lightingAndStyle: "暖调通透光泽",
                          audioPrompt: "注水声与滴滤声",
                          prompt: "Cinematic macro shot of coffee brewing in nature.",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => modelServer.close(resolve)));
  const { port: modelPort } = modelServer.address();

  const appConfig = {
    ...DEFAULT_APP_CONFIG,
    textProvider: {
      apiStyle: "google",
      model: "gemini-3.6-flash",
      baseUrl: `http://127.0.0.1:${modelPort}`,
      apiKey: "fixture-google-key",
      maxOutputTokens: 8192,
    },
  };

  const ai = createAiServices(appConfig);
  const handler = createApiHandler({ appConfig, store: {}, ai });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const sessionToken = "session-user-101";
  insertSession({ token: sessionToken, userId: TEST_USER.id, createdAt: new Date().toISOString() });

  const initialCredits = findUserById(TEST_USER.id).credits;
  const requestId = "stable-req-001";

  // First request
  const res1 = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
    {
      requestId,
      aspectRatioSelection: "9:16",
      model: "d2",
      mode: "text",
      resolution: "720p",
      videoDuration: "30",
      useProductImages: true,
      productImages: [{ id: 999999 }],
      videoReferenceImageIds: [999999],
      styleReferenceImages: [
        {
          name: "style-ref.png",
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
  );

  if (res1.status !== 200) console.error("res1 error:", res1.body);
  assert.equal(res1.status, 200);
  assert.equal(res1.body.generation.type, "videoScript");
  assert.equal(res1.body.generation.channelLabel, "视频脚本");
  assert.equal(res1.body.videoScript.title, "山野清晨手冲咖啡视频脚本");
  assert.equal(res1.body.videoScript.totalDurationSec, 30);
  assert.equal(res1.body.videoScript.clips.length, 3);
  const storedGeneration = findGenerationByOwner(res1.body.generation.id, TEST_USER.id);
  assert.deepEqual(storedGeneration.payload.videoReferenceImageIds, []);
  assert.deepEqual(storedGeneration.payload.semanticInput.referenceImageIds, []);

  // Verifies 1 credit deducted
  assert.equal(findUserById(TEST_USER.id).credits, initialCredits - 1);
  assert.equal(modelCallCount, 1);

  // Verifies multimodal inlineData was sent
  assert.ok(receivedParts.some((p) => p.inlineData && p.inlineData.mimeType === "image/png"));

  // Second request with SAME requestId (idempotency)
  const res2 = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
    {
      requestId,
      aspectRatioSelection: "9:16",
    },
  );

  assert.equal(res2.status, 200);
  assert.equal(res2.body.generation.id, res1.body.generation.id);
  // Model was NOT called again
  assert.equal(modelCallCount, 1);
  // Credits were NOT deducted again
  assert.equal(findUserById(TEST_USER.id).credits, initialCredits - 1);
});

test("POST /video-script refunds credit when model generation fails", async (t) => {
  const modelServer = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model overloaded" } }));
    });
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => modelServer.close(resolve)));
  const { port: modelPort } = modelServer.address();

  const appConfig = {
    ...DEFAULT_APP_CONFIG,
    textProvider: {
      apiStyle: "google",
      model: "gemini-3.6-flash",
      baseUrl: `http://127.0.0.1:${modelPort}`,
      apiKey: "fixture-google-key",
    },
  };

  const ai = createAiServices(appConfig);
  const handler = createApiHandler({ appConfig, store: {}, ai });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const sessionToken = "session-user-101-fail";
  insertSession({ token: sessionToken, userId: TEST_USER.id, createdAt: new Date().toISOString() });
  const creditsBefore = findUserById(TEST_USER.id).credits;

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
    {
      requestId: "req-fail-refund",
      aspectRatioSelection: "9:16",
    },
  );

  assert.equal(res.status, 400);
  assert.match(res.body.error, /视频脚本生成失败/);
  // Credits fully refunded
  assert.equal(findUserById(TEST_USER.id).credits, creditsBefore);
});

test("GET /api/history returns complete videoScript payload without stripping fields", async (t) => {
  const modelServer = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "带娃出游必备清单，应对突发感冒不慌张",
                      creativeConcept: "出游备药与急救指南",
                      totalDurationSec: 15,
                      aspectRatio: "9:16",
                      globalSubjectReference: "母婴急救包与小快克",
                      globalStyleReference: "温馨自然光影",
                      globalContinuity: "动作连贯",
                      audioDirection: {
                        music: "轻快温馨BGM",
                        ambience: "自然环境声",
                        voiceStyle: "亲切叮嘱语调",
                      },
                      clips: [
                        {
                          index: 1,
                          startSec: 0,
                          endSec: 7,
                          durationSec: 7,
                          purpose: "开场吸睛与场景切入",
                          firstFrame: "妈妈整理帆布包特写",
                          lastFrame: "小男孩揉鼻子特写",
                          subjectReference: "随身急救包",
                          scene: "阳光草坪露营餐桌前",
                          subjectAction: "妈妈整理随身物品",
                          cameraMovement: "低角度慢速推近",
                          environmentMotion: "微风吹拂",
                          lightingAndStyle: "自然晨光侧逆光",
                          audioPrompt: "轻快音乐与微风声",
                          voiceover: "带娃出门最怕孩子突发感冒？",
                          dialogue: "",
                          onScreenText: "带娃出行急救清单",
                          transition: "快速平滑横移转场",
                          continuity: "光影方向一致",
                          prompt: "电影级画质，阳光明媚的草坪露营餐桌前，妈妈正在整理随身帆布包，小男孩在背景草地上欢快奔跑，自然晨光侧逆光，微风吹拂发丝，4k超高清细节。",
                        },
                        {
                          index: 2,
                          startSec: 7,
                          endSec: 15,
                          durationSec: 8,
                          purpose: "核心亮点与关怀收尾",
                          firstFrame: "分装小药盒特写",
                          lastFrame: "母子相视微笑",
                          subjectReference: "独立分装药包",
                          scene: "野餐桌特写",
                          subjectAction: "妈妈递出温水杯",
                          cameraMovement: "平滑横移升至母子中景",
                          environmentMotion: "树影斑驳流转",
                          lightingAndStyle: "暖调温馨氛围",
                          audioPrompt: "水杯轻放声与治愈音乐",
                          voiceover: "这份出行急救清单，让你在旅途中稳住阵脚。",
                          dialogue: "",
                          onScreenText: "稳住不慌 快乐出发",
                          transition: "定格淡出",
                          continuity: "母子位置连续",
                          prompt: "电影级画质，妈妈将温水杯递给小男孩，温馨对视微笑，暖色调高光通透，画面干净温馨，电影级色彩，8k真实质感。",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => modelServer.close(resolve)));
  const { port: modelPort } = modelServer.address();

  const appConfig = {
    ...DEFAULT_APP_CONFIG,
    textProvider: {
      apiStyle: "google",
      model: "gemini-3.6-flash",
      baseUrl: `http://127.0.0.1:${modelPort}`,
      apiKey: "fixture-google-key",
      maxOutputTokens: 8192,
    },
  };

  const ai = createAiServices(appConfig);
  const handler = createApiHandler({ appConfig, store: {}, ai });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const sessionToken = "session-user-101-history-test";
  insertSession({ token: sessionToken, userId: TEST_USER.id, createdAt: new Date().toISOString() });

  // 1. Generate video script
  const generateRes = await makeRequest(
    server,
    {
      method: "POST",
      path: `/api/brands/${BRAND.id}/trends/501/ideas/0/video-script`,
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
    {
      requestId: "req-history-full-check",
      aspectRatioSelection: "9:16",
      videoDuration: "15",
    },
  );

  assert.equal(generateRes.status, 200);
  assert.equal(generateRes.body.videoScript.totalDurationSec, 15);
  assert.equal(generateRes.body.videoScript.clips.length, 2);

  // 2. Fetch /api/history and verify payload contains videoScript intact
  const historyRes = await makeRequest(
    server,
    {
      method: "GET",
      path: "/api/history",
      headers: { Cookie: `redbase_session=${sessionToken}` },
    },
  );

  assert.equal(historyRes.status, 200);
  const historyItem = historyRes.body.generations.find((item) => item.id === generateRes.body.generation.id);
  assert.ok(historyItem, "history item must exist");
  console.log("historyItem is:", JSON.stringify(historyItem, null, 2));
  assert.equal(historyItem.type, "videoScript");
  assert.ok(historyItem.payload.videoScript, "payload.videoScript must not be stripped by sanitizePayloadForClient");
  assert.equal(historyItem.payload.videoScript.title, "带娃出游必备清单，应对突发感冒不慌张");
  assert.equal(historyItem.payload.videoScript.totalDurationSec, 15);
  assert.equal(historyItem.payload.videoScript.clips.length, 2);
  assert.equal(historyItem.payload.videoScript.clips[0].firstFrame, "妈妈整理帆布包特写");
  const compiledPrompt = historyItem.payload.videoScript.clips[0].prompt;
  assert.match(compiledPrompt, /【场景环境】/);
  assert.match(compiledPrompt, /阳光草坪露营餐桌前/);
  assert.match(compiledPrompt, /【声音设计】/);
  assert.match(compiledPrompt, /轻快音乐与微风声/);
  assert.doesNotMatch(compiledPrompt, /电影级画质/);
});
