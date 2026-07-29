const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-billing-api-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "billing-api.sqlite");

const { openDatabase, getDbProxy } = require("../../src/server/db/connection");
const {
  initializeDatabaseSchema,
  ensureDatabaseIndexes,
  ensureSchemaUpgrades,
} = require("../../src/server/db/schema");
const { insertUser, insertSession, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../../src/server/db/repositories/excellent-content-cache-repository");
const { upsertRemixAnalysisCache } = require("../../src/server/db/repositories/excellent-remix-analysis-cache-repository");
const {
  buildMetadataOnlyAnalysis,
  buildSourceSignature,
  ANALYSIS_VERSION,
} = require("../../src/server/services/excellent-remix-analysis-service");
const { handleExcellentContentRoutes } = require("../../src/server/api/excellent-content-routes");
const { collectBody } = require("../../src/server/api/http-utils");
const { listAllCreditEvents } = require("../../src/server/db/repositories/admin-repository");
const {
  EXCELLENT_REFRESH_COOLDOWN_MS,
  claimExcellentRefreshSlot,
  releaseExcellentRefreshSlot,
  resetExcellentRefreshCooldowns,
} = require("../../src/server/services/excellent-refresh-cooldown");
const { DIRECTION_FREE_WINDOW_MS } = require("../../src/server/db/repositories/excellent-remix-billing-repository");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();
const db = getDbProxy();

// ---- fixtures -------------------------------------------------------------

const USERS = [
  { id: 301, name: "Rich Biller", phone: "13930000301", credits: 10, token: "bill-rich" },
  { id: 302, name: "Poor Biller", phone: "13930000302", credits: 0, token: "bill-poor" },
  { id: 303, name: "Fusion Biller", phone: "13930000303", credits: 5, token: "bill-fusion" },
  { id: 304, name: "Race Biller", phone: "13930000304", credits: 10, token: "bill-race" },
  { id: 305, name: "Cooldown User", phone: "13930000305", credits: 50, token: "bill-cool" },
  { id: 306, name: "Admin User", phone: "13800000006", credits: 50, token: "bill-admin" },
  { id: 307, name: "Lost Direction Response", phone: "13930000307", credits: 10, token: "bill-lost-direction" },
  { id: 308, name: "Lost Fusion Response", phone: "13930000308", credits: 5, token: "bill-lost-fusion" },
  { id: 309, name: "Signature Biller", phone: "13930000309", credits: 10, token: "bill-signature" },
];
for (const user of USERS) {
  insertUser({
    id: user.id,
    name: user.name,
    phone: user.phone,
    password: "hash",
    accountType: "customer",
    credits: user.credits,
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  insertSession({ token: user.token, userId: user.id, createdAt: "2026-07-29T00:00:00.000Z" });
}

const brandRepo = require("../../src/server/db/repositories/brand-repository");
const KNOWN_USER_IDS = new Set(USERS.map((user) => user.id));
let brandProfileRevision = "关注宝宝喂养与消化舒适";
let currentIdeaTitle = "转奶观察清单";
brandRepo.findBrandByOwner = (brandId, ownerUserId) => {
  const id = Number(brandId);
  if (!KNOWN_USER_IDS.has(Number(ownerUserId)) || (id !== 7 && id !== 8)) return null;
  return {
    id,
    ownerUserId: Number(ownerUserId),
    name: id === 7 ? "温和星球" : "第二品牌",
    industry: "母婴",
    audience: "新手妈妈",
    description: brandProfileRevision,
    product: "有机奶粉，温和好吸收",
    goal: "帮助家长更安心完成转奶",
    knowledgeBase: "",
    logo: null,
    trends: [{ items: [{
      id: 501,
      title: "转奶趋势",
      summary: "观察宝宝适应状态",
      ideas: [{ title: currentIdeaTitle, summary: "记录便便、睡眠与食欲", audience: "新手妈妈", angle: "观察清单", brandFit: "自然融入", hook: "三步看懂" }],
    }] }],
    analyses: [],
  };
};

function makeNote(noteId) {
  return {
    id: noteId,
    noteId,
    title: `转奶观察清单 ${noteId}`,
    author: { nickname: "育儿笔记" },
    imageUrls: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"],
    imageCount: 2,
    metrics: { readCount: 32000 },
    contentSource: "all",
  };
}
const NOTES = [makeNote("bill-note-1"), makeNote("bill-note-2"), makeNote("bill-note-3")];
upsertExcellentContentCache({
  sourceKey: "xhs_hot",
  categoryPath: "",
  items: NOTES,
  fetchedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

// Pre-seed reference analyses so directions/fusion never trigger analysis model calls.
const ANALYSIS_IDS = {};
for (const note of NOTES) {
  const sourceSignature = buildSourceSignature(note);
  upsertRemixAnalysisCache({
    noteId: note.noteId,
    boardKey: "xhs_hot",
    sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    analysisMode: "metadata_only",
    analysis: buildMetadataOnlyAnalysis(note, "xhs_hot"),
    modelName: "fixture-model",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    lastError: "",
  });
  ANALYSIS_IDS[note.noteId] = `${note.noteId}|xhs_hot|${sourceSignature}|${ANALYSIS_VERSION}`;
}

// ---- request helpers ------------------------------------------------------

function createPostReq(url, body = {}, cookie = "redbase_session=bill-rich") {
  const raw = Buffer.from(JSON.stringify(body || {}), "utf8");
  const req = Readable.from([raw]);
  req.method = "POST";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie,
    "content-type": "application/json",
    "content-length": String(raw.length),
  };
  return req;
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: null,
    writeHead(code, nextHeaders = {}) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(nextHeaders)) headers.set(key.toLowerCase(), value);
    },
    setHeader(key, value) {
      headers.set(String(key).toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

function billingContext(overrides = {}) {
  return {
    appConfig: {
      pgy: { enabled: false },
      textProvider: { apiKey: "test-key" },
      admin: { phones: ["13800000006"] },
      ...(overrides.appConfig || {}),
    },
    collectBody,
    getSessionToken: (req) => {
      const cookie = String(req.headers.cookie || "");
      const match = cookie.match(/redbase_session=([^;]+)/);
      return match ? match[1] : "";
    },
    buildApiUserLog: (user) => ({ id: user.id, phone: user.phone }),
    json: (res, code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    unauthorized: (res, message) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    },
    badRequest: (res, message) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    },
    notFound: (res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
    ...overrides,
  };
}

let requestSeq = 0;
function rid() {
  requestSeq += 1;
  return `api-billing-req-${String(requestSeq).padStart(5, "0")}`;
}

function modelDirectionsResult() {
  return {
    directions: [
      {
        transferMode: "theme_transfer",
        id: "d-theme",
        title: "主题迁移：转奶观察优先",
        oneSentence: "先观察后行动",
        targetAudience: "新手妈妈",
        scene: "夜间喂养",
        userProblem: "转奶焦虑",
        contentThesis: "转奶要看宝宝状态而不是节奏表",
        brandIntegration: "自然带出温和好吸收",
        whyMatchesReference: "同题材",
        originalityBoundary: "不复制原文",
      },
      {
        transferMode: "structure_transfer",
        id: "d-structure",
        title: "结构迁移：三步核对清单",
        oneSentence: "清单化表达",
        targetAudience: "新手妈妈",
        scene: "白天喂养",
        userProblem: "信息过载",
        contentThesis: "用清单结构讲清转奶观察点",
        brandIntegration: "清单末尾自然露出",
        whyMatchesReference: "同结构",
        originalityBoundary: "不复制原排版",
      },
      {
        transferMode: "brand_problem_transfer",
        id: "d-brand",
        title: "品牌问题：便便变化切入",
        oneSentence: "从问题切入",
        targetAudience: "新手妈妈",
        scene: "换奶期",
        userProblem: "便便变化看不懂",
        contentThesis: "从便便变化切入讲喂养调整",
        brandIntegration: "产品作为选项之一",
        whyMatchesReference: "同人群",
        originalityBoundary: "不使用原品牌",
      },
    ],
  };
}

function publishReadyFusionResult() {
  return {
    title: "转奶节奏实用指南",
    publishTitle: "宝宝转奶别着急先看清这三件事",
    publishCaption:
      "宝宝准备转奶时，信息越多越容易慌。与其照搬别人的进度，不如先观察自己的喂养场景，再核对产品说明和真正关心的体验。这份清单把判断顺序整理得更清楚：先看日常状态，再看包装说明，最后按家庭节奏做选择。过程中如果出现拿不准的变化，及时记录并向专业人士咨询，比追求统一进度更稳妥。温和星球有机奶粉会作为真实选项出现，最终仍要结合宝宝实际情况和产品说明判断。",
    slides: [
      {
        title: "转奶前先别急着换",
        copy: "宝宝正在适应新的喂养节奏时，先记录日常状态和原本的饮用情况，比盲目追求速度更重要。",
        visualDirection: "清晨餐桌上的奶瓶、记录本和奶粉罐自然同框，画面温暖并留出醒目标题区。",
      },
      {
        title: "先看宝宝真实状态",
        copy: "把进食、精神状态和日常表现放在一起观察，不用因为一次变化就匆忙下结论，也不要照搬别人的节奏。",
        visualDirection: "家长在生活化的喂养场景中做简短记录，人物动作自然，重点信息清晰可读。",
      },
      {
        title: "按顺序核对三件事",
        copy: "先确认当前喂养场景，再查看产品包装上的实际说明，最后比较宝宝和家庭真正需要的体验。",
        visualDirection: "用三张简洁步骤卡搭配真实产品包装和奶瓶，形成从左到右的清楚阅读顺序。",
      },
      {
        title: "自己的节奏更重要",
        copy: "温和星球有机奶粉可以作为选择之一认真比较，最终仍要结合宝宝的实际情况和产品说明来判断。",
        visualDirection: "柔和居家环境中的产品、奶瓶与行动清单组成收束画面，品牌露出自然不过度。",
      },
    ],
  };
}

/** Text model dispatcher: routes直连的 textModelImpl，按提示词分流方向/融合。 */
function makeTextModel(counters, behavior = {}) {
  return async (_appConfig, { systemPrompt }) => {
    const prompt = String(systemPrompt || "");
    // 融合成稿提示词也包含“内容方向”字样，先判断图文编辑标记。
    if (prompt.includes("图文编辑")) {
      counters.fusion += 1;
      if (behavior.fusion === "throw") throw new Error("fusion model down");
      if (behavior.fusion === "garbage") return { nonsense: true };
      return publishReadyFusionResult();
    }
    counters.directions += 1;
    if (behavior.directions === "throw") throw new Error("model down");
    if (behavior.directions === "garbage") return { nonsense: true };
    return modelDirectionsResult();
  };
}

function directionsBody({ noteId = "bill-note-1", brandId = 7, requestId = rid(), forceRegenerate = false } = {}) {
  return {
    board: "xhs_hot",
    brandId,
    learningFocus: ["structure", "hook"],
    sourceAnalysisId: ANALYSIS_IDS[noteId],
    requestId,
    forceRegenerate,
  };
}

function fusionBody({ noteId = "bill-note-1", brandId = 7, requestId = rid(), forceRegenerate = false } = {}) {
  return {
    board: "xhs_hot",
    brandId,
    contentMode: "custom",
    customDirection: "想讲宝宝转奶期间的便便变化与观察方法",
    useTrendContext: false,
    learningFocus: ["structure", "hook"],
    sourceAnalysisId: ANALYSIS_IDS[noteId],
    requestId,
    forceRegenerate,
  };
}

async function postDirections(ctx, body, cookie) {
  const res = createRes();
  const url = `/api/excellent-contents/${body.__noteId || "bill-note-1"}/content-directions`;
  const { __noteId, ...payload } = body;
  await handleExcellentContentRoutes(ctx, createPostReq(url, payload, cookie), res, url);
  return res;
}

async function postFusion(ctx, body, cookie) {
  const res = createRes();
  const url = `/api/excellent-contents/${body.__noteId || "bill-note-1"}/fusion-plan`;
  const { __noteId, ...payload } = body;
  await handleExcellentContentRoutes(ctx, createPostReq(url, payload, cookie), res, url);
  return res;
}

function chargeEventsFor(userId, actionType) {
  return listAllCreditEvents().filter(
    (event) => event.userId === userId && event.actionType === actionType && event.creditDelta < 0,
  );
}

function shiftDirectionWindowBack(userId, byMs) {
  const rows = db.prepare(`
    SELECT request_id, completed_at, created_at FROM excellent_remix_billing_requests
    WHERE user_id = ? AND kind = 'direction'
  `).all(userId);
  for (const row of rows) {
    const shiftIso = (value) => (value ? new Date(new Date(value).getTime() - byMs).toISOString() : value);
    db.prepare(`
      UPDATE excellent_remix_billing_requests
      SET completed_at = ?, created_at = ?
      WHERE request_id = ? AND user_id = ? AND kind = 'direction'
    `).run(shiftIso(row.completed_at), shiftIso(row.created_at), row.request_id, userId);
  }
}

// ---- tests ---------------------------------------------------------------

test("directions: 3 free across brands/notes, 4th charges, cache/replay/fallback free, window slides out", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-rich";

  // 前三次成功（跨品牌/跨笔记）免费。
  const combos = [
    { noteId: "bill-note-1", brandId: 7 },
    { noteId: "bill-note-2", brandId: 7 },
    { noteId: "bill-note-1", brandId: 8 },
  ];
  let lastBilling = null;
  for (let i = 0; i < combos.length; i += 1) {
    const res = await postDirections(ctx, { __noteId: combos[i].noteId, ...directionsBody({ ...combos[i] }) }, cookie);
    assert.equal(res.statusCode, 200, res.body?.error);
    assert.equal(res.body.source, "model");
    assert.equal(res.body.billing.charged, false);
    assert.equal(res.body.billing.windowCount, i + 1);
    assert.equal(res.body.billing.credits, 10);
    lastBilling = res.body.billing;
  }
  assert.equal(lastBilling.nextChargeable, true, "3rd free success must flag the next run as chargeable");
  assert.equal(counters.directions, 3);

  // 第 4 次（新输入）收 1 积分。
  const fourthBody = { __noteId: "bill-note-2", ...directionsBody({ noteId: "bill-note-2", brandId: 8 }) };
  const fourth = await postDirections(ctx, fourthBody, cookie);
  assert.equal(fourth.statusCode, 200);
  assert.equal(fourth.body.billing.charged, true);
  assert.equal(fourth.body.billing.creditCost, 1);
  assert.equal(fourth.body.billing.credits, 9);
  assert.equal(fourth.body.billing.nextChargeable, true);
  assert.equal(findUserById(301).credits, 9);
  assert.equal(chargeEventsFor(301, "excellentContentDirection").length, 1);
  assert.equal(counters.directions, 4);

  // 相同输入 + 新 requestId：24h 缓存命中，免费且不调模型、不计次。
  const cached = await postDirections(
    ctx,
    { __noteId: "bill-note-1", ...directionsBody({ noteId: "bill-note-1", brandId: 7 }) },
    cookie,
  );
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.billing.cacheHit, true);
  assert.equal(cached.body.billing.charged, false);
  assert.equal(cached.body.billing.windowCount, 4);
  assert.equal(counters.directions, 4, "cache hit must not call the model");
  assert.equal(findUserById(301).credits, 9);

  // 同 requestId 重放：免费返回历史结果。
  const replay = await postDirections(ctx, { __noteId: "bill-note-2", ...fourthBody }, cookie);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.billing.replayed, true);
  assert.equal(replay.body.billing.charged, false);
  assert.equal(counters.directions, 4, "requestId replay must not call the model");
  assert.equal(findUserById(301).credits, 9);

  // fallback（模型输出不合格）：返回 deterministic，不扣分、不计次、不进缓存。
  const fallbackCtx = billingContext({ excellentTextModelImpl: makeTextModel(counters, { directions: "garbage" }) });
  const fallbackRes = await postDirections(
    fallbackCtx,
    { __noteId: "bill-note-3", ...directionsBody({ noteId: "bill-note-3", brandId: 7, forceRegenerate: true }) },
    cookie,
  );
  assert.equal(fallbackRes.statusCode, 200);
  assert.equal(fallbackRes.body.source, "deterministic");
  assert.equal(fallbackRes.body.billing.charged, false);
  assert.equal(fallbackRes.body.billing.windowCount, 4, "fallback must not count into the window");
  assert.equal(findUserById(301).credits, 9);

  // 模型抛错也走 deterministic fallback：同样不扣分不计次。
  const throwCtx = billingContext({ excellentTextModelImpl: makeTextModel(counters, { directions: "throw" }) });
  const throwRes = await postDirections(
    throwCtx,
    { __noteId: "bill-note-3", ...directionsBody({ noteId: "bill-note-3", brandId: 8 }) },
    cookie,
  );
  assert.equal(throwRes.statusCode, 200);
  assert.equal(throwRes.body.source, "deterministic");
  assert.equal(throwRes.body.billing.charged, false);
  assert.equal(findUserById(301).credits, 9);

  // 时间窗滑出（把历史成功回拨 6 分钟）：恢复免费。
  // 选未进入 24h 缓存的输入（bill-note-3 × 品牌 7 之前只产生过 fallback，不会命中缓存）。
  shiftDirectionWindowBack(301, DIRECTION_FREE_WINDOW_MS + 60 * 1000);
  const afterWindow = await postDirections(
    ctx,
    { __noteId: "bill-note-3", ...directionsBody({ noteId: "bill-note-3", brandId: 7 }) },
    cookie,
  );
  assert.equal(afterWindow.statusCode, 200);
  assert.equal(afterWindow.body.billing.cacheHit, false, "fallback results must not populate the 24h cache");
  assert.equal(afterWindow.body.billing.charged, false, "window slide-out must restore free quota");
  assert.equal(afterWindow.body.billing.windowCount, 1);
  assert.equal(findUserById(301).credits, 9);
});

test("directions: insufficient balance returns 402 with zero model calls", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-poor";

  // 免费额度内正常使用（余额 0 也不受影响）。
  const combos = [
    { noteId: "bill-note-1", brandId: 7 },
    { noteId: "bill-note-2", brandId: 7 },
    { noteId: "bill-note-3", brandId: 7 },
  ];
  for (const combo of combos) {
    const res = await postDirections(ctx, { __noteId: combo.noteId, ...directionsBody(combo) }, cookie);
    assert.equal(res.statusCode, 200, res.body?.error);
    assert.equal(res.body.billing.charged, false);
  }
  assert.equal(counters.directions, 3);

  // 第 4 次需要收费：余额 0 → 402，模型调用次数不变。
  const blocked = await postDirections(
    ctx,
    { __noteId: "bill-note-1", ...directionsBody({ noteId: "bill-note-1", brandId: 8 }) },
    cookie,
  );
  assert.equal(blocked.statusCode, 402);
  assert.match(blocked.body.error, /需要 1 积分/);
  assert.match(blocked.body.error, /当前剩余 0 积分/);
  assert.equal(counters.directions, 3, "insufficient balance must not call the model");
  assert.equal(findUserById(302).credits, 0);
});

test("directions: concurrent same requestId generates once and charges once", async () => {
  const warmCounters = { directions: 0, fusion: 0 };
  const warmCtx = billingContext({ excellentTextModelImpl: makeTextModel(warmCounters) });
  const cookie = "redbase_session=bill-race";
  // 占满免费窗口，确保并发请求处于收费状态。
  const combos = [
    { noteId: "bill-note-1", brandId: 7 },
    { noteId: "bill-note-2", brandId: 7 },
    { noteId: "bill-note-3", brandId: 7 },
  ];
  for (const combo of combos) {
    const res = await postDirections(warmCtx, { __noteId: combo.noteId, ...directionsBody(combo) }, cookie);
    assert.equal(res.statusCode, 200, res.body?.error);
  }

  let releaseModel;
  const gate = new Promise((resolve) => {
    releaseModel = resolve;
  });
  let gatedCalls = 0;
  const gatedCtx = billingContext({
    excellentTextModelImpl: async (_appConfig, { systemPrompt }) => {
      if (String(systemPrompt || "").includes("图文编辑")) return publishReadyFusionResult();
      gatedCalls += 1;
      await gate;
      return modelDirectionsResult();
    },
  });
  const sharedRequestId = "race-direction-req-0001";
  const body = { __noteId: "bill-note-1", ...directionsBody({ noteId: "bill-note-1", brandId: 8, requestId: sharedRequestId }) };

  const resA = createRes();
  const urlA = "/api/excellent-contents/bill-note-1/content-directions";
  const { __noteId: _n1, ...payloadA } = body;
  const promiseA = handleExcellentContentRoutes(gatedCtx, createPostReq(urlA, payloadA, cookie), resA, urlA);
  while (gatedCalls === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  // 同 requestId 并发：第二个请求拿不到第二次生成。
  const resB = await postDirections(gatedCtx, body, cookie);
  assert.equal(resB.statusCode, 409);
  assert.equal(resB.body.code, "REQUEST_IN_PROGRESS");

  releaseModel();
  await promiseA;
  assert.equal(resA.statusCode, 200);
  assert.equal(resA.body.billing.charged, true);
  assert.equal(gatedCalls, 1, "same requestId must generate exactly once");
  assert.equal(findUserById(304).credits, 9);

  // 完成后的同 requestId 重放：不再扣费。
  const replay = await postDirections(gatedCtx, body, cookie);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.billing.replayed, true);
  assert.equal(replay.body.billing.charged, false);
  assert.equal(findUserById(304).credits, 9);
  assert.equal(chargeEventsFor(304, "excellentContentDirection").length, 1);

  // 同一 requestId 永久绑定首次输入，避免客户端误复用时把其他输入当作重放。
  const conflictingInput = await postDirections(
    gatedCtx,
    { __noteId: "bill-note-2", ...directionsBody({ noteId: "bill-note-2", brandId: 8, requestId: sharedRequestId }) },
    cookie,
  );
  assert.equal(conflictingInput.statusCode, 409);
  assert.equal(conflictingInput.body.code, "REQUEST_ID_CONFLICT");
  assert.equal(gatedCalls, 1, "conflicting input must not call the model");
  assert.equal(findUserById(304).credits, 9);
});

test("directions: a lost successful response retried with the same requestId replays without a second charge", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-lost-direction";
  for (const combo of [
    { noteId: "bill-note-1", brandId: 7 },
    { noteId: "bill-note-2", brandId: 7 },
    { noteId: "bill-note-3", brandId: 7 },
  ]) {
    const warm = await postDirections(ctx, { __noteId: combo.noteId, ...directionsBody(combo) }, cookie);
    assert.equal(warm.statusCode, 200, warm.body?.error);
  }
  const requestId = "lost-direction-response-0001";
  const body = {
    __noteId: "bill-note-1",
    ...directionsBody({ noteId: "bill-note-1", brandId: 8, requestId, forceRegenerate: true }),
  };

  const completedButLost = await postDirections(ctx, body, cookie);
  assert.equal(completedButLost.statusCode, 200);
  assert.equal(completedButLost.body.billing.charged, true);
  assert.equal(counters.directions, 4);
  assert.equal(findUserById(307).credits, 9);

  const replay = await postDirections(ctx, body, cookie);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.billing.replayed, true);
  assert.equal(replay.body.billing.charged, false);
  assert.equal(counters.directions, 4, "lost-response retry must not invoke the direction model twice");
  assert.equal(chargeEventsFor(307, "excellentContentDirection").length, 1);
  assert.equal(findUserById(307).credits, 9);
});

test("brand profile and current idea edits invalidate the 24h billing cache", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-signature";
  const originalProfile = brandProfileRevision;
  const originalIdeaTitle = currentIdeaTitle;
  try {
    const firstDirection = await postDirections(ctx, directionsBody({ requestId: "signature-direction-0001" }), cookie);
    assert.equal(firstDirection.statusCode, 200, firstDirection.body?.error);
    brandProfileRevision = "更新后的品牌人群与产品定位";
    const changedBrandDirection = await postDirections(ctx, directionsBody({ requestId: "signature-direction-0002" }), cookie);
    assert.equal(changedBrandDirection.statusCode, 200, changedBrandDirection.body?.error);
    assert.equal(changedBrandDirection.body.billing.cacheHit, false);
    assert.equal(counters.directions, 2, "brand content change must call the model again");

    const existingIdeaBody = (requestId) => ({
      ...fusionBody({ requestId }),
      contentMode: "existing_idea",
      customDirection: "",
      existingIdeaRef: { scope: "current", analysisId: null, trendId: 501, ideaIndex: 0 },
    });
    const firstFusion = await postFusion(ctx, existingIdeaBody("signature-fusion-0001"), cookie);
    assert.equal(firstFusion.statusCode, 200, firstFusion.body?.error);
    currentIdeaTitle = "更新后的转奶选题内容";
    const changedIdeaFusion = await postFusion(ctx, existingIdeaBody("signature-fusion-0002"), cookie);
    assert.equal(changedIdeaFusion.statusCode, 200, changedIdeaFusion.body?.error);
    assert.equal(changedIdeaFusion.body.billing.cacheHit, false);
    assert.equal(counters.fusion, 2, "current idea content change must call the model again");
  } finally {
    brandProfileRevision = originalProfile;
    currentIdeaTitle = originalIdeaTitle;
  }
});

test("fusion: a lost successful response retried with the same requestId replays without a second charge", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-lost-fusion";
  const requestId = "lost-fusion-response-0001";
  const body = {
    __noteId: "bill-note-1",
    ...fusionBody({ noteId: "bill-note-1", requestId, forceRegenerate: true }),
  };

  const completedButLost = await postFusion(ctx, body, cookie);
  assert.equal(completedButLost.statusCode, 200);
  assert.equal(completedButLost.body.billing.charged, true);
  assert.equal(counters.fusion, 1);
  assert.equal(findUserById(308).credits, 4);

  const replay = await postFusion(ctx, body, cookie);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.billing.replayed, true);
  assert.equal(replay.body.billing.charged, false);
  assert.equal(counters.fusion, 1, "lost-response retry must not invoke the fusion model twice");
  assert.equal(chargeEventsFor(308, "excellentFusionPlan").length, 1);
  assert.equal(findUserById(308).credits, 4);
});

test("fusion: valid AI charges 1, cache replay 0, force regenerate charges again, fallback 0, error path releases", async () => {
  const counters = { directions: 0, fusion: 0 };
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel(counters) });
  const cookie = "redbase_session=bill-fusion";

  // 有效 AI 方案：预占后结算 1 积分。
  const first = await postFusion(ctx, { __noteId: "bill-note-1", ...fusionBody({}) }, cookie);
  assert.equal(first.statusCode, 200, first.body?.error);
  assert.equal(first.body.fusionPlan.contentGenerationMode, "ai");
  assert.equal(first.body.fusionPlan.carouselPack.slides.length, 4);
  assert.equal(first.body.billing.charged, true);
  assert.equal(first.body.billing.creditCost, 1);
  assert.equal(first.body.billing.credits, 4);
  assert.equal(findUserById(303).credits, 4);
  assert.equal(counters.fusion, 1);

  // 相同输入 + 新 requestId：24h 缓存命中，免费且不调模型。
  const cached = await postFusion(ctx, { __noteId: "bill-note-1", ...fusionBody({}) }, cookie);
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.billing.cacheHit, true);
  assert.equal(cached.body.billing.charged, false);
  assert.equal(cached.body.fusionPlan.contentGenerationMode, "ai");
  assert.equal(counters.fusion, 1, "fusion cache hit must not call the model");
  assert.equal(findUserById(303).credits, 4);

  // forceRegenerate=true：跳缓存生成新版本，再收 1 积分。
  const forced = await postFusion(ctx, { __noteId: "bill-note-1", ...fusionBody({ forceRegenerate: true }) }, cookie);
  assert.equal(forced.statusCode, 200);
  assert.equal(forced.body.billing.cacheHit, false);
  assert.equal(forced.body.billing.charged, true);
  assert.equal(findUserById(303).credits, 3);
  assert.equal(counters.fusion, 2);

  // fallback（模型输出无效 JSON 结构）：返回 deterministic 方案，0 扣费。
  const fallbackCtx = billingContext({ excellentTextModelImpl: makeTextModel(counters, { fusion: "garbage" }) });
  const fb = await postFusion(
    fallbackCtx,
    { __noteId: "bill-note-2", ...fusionBody({ noteId: "bill-note-2" }) },
    cookie,
  );
  assert.equal(fb.statusCode, 200);
  assert.equal(fb.body.fusionPlan.contentGenerationMode, "deterministic_fallback");
  assert.equal(fb.body.billing.charged, false);
  assert.equal(findUserById(303).credits, 3);

  // 模型抛错/超时同样落到 fallback：0 扣费。
  const throwCtx = billingContext({ excellentTextModelImpl: makeTextModel(counters, { fusion: "throw" }) });
  const thrown = await postFusion(
    throwCtx,
    { __noteId: "bill-note-3", ...fusionBody({ noteId: "bill-note-3" }) },
    cookie,
  );
  assert.equal(thrown.statusCode, 200);
  assert.equal(thrown.body.fusionPlan.contentGenerationMode, "deterministic_fallback");
  assert.equal(thrown.body.billing.charged, false);
  assert.equal(findUserById(303).credits, 3);

  // fallback 不进缓存：同输入再次请求仍会尝试生成（这次成功则收费）。
  const retryAfterFallback = await postFusion(
    ctx,
    { __noteId: "bill-note-2", ...fusionBody({ noteId: "bill-note-2" }) },
    cookie,
  );
  assert.equal(retryAfterFallback.statusCode, 200);
  assert.equal(retryAfterFallback.body.fusionPlan.contentGenerationMode, "ai");
  assert.equal(retryAfterFallback.body.billing.charged, true);
  assert.equal(findUserById(303).credits, 2);

  // 路由级错误（笔记不存在）：释放预占，0 扣费。
  const errorRes = await postFusion(ctx, { __noteId: "missing-note", ...fusionBody({ noteId: "bill-note-1" }) }, cookie);
  assert.ok(errorRes.statusCode >= 400);
  assert.equal(findUserById(303).credits, 2);

  // 同 requestId 并发/重放只产生一份方案与一次扣费。
  const replayBody = { __noteId: "bill-note-3", ...fusionBody({ noteId: "bill-note-3", forceRegenerate: true }) };
  const okRes = await postFusion(ctx, replayBody, cookie);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.billing.charged, true);
  assert.equal(findUserById(303).credits, 1);
  const replayRes = await postFusion(ctx, replayBody, cookie);
  assert.equal(replayRes.statusCode, 200);
  assert.equal(replayRes.body.billing.replayed, true);
  assert.equal(replayRes.body.billing.charged, false);
  assert.equal(findUserById(303).credits, 1);

  // 余额不足：0 余额用户直接 402，模型调用为 0。
  const poorCounters = { directions: 0, fusion: 0 };
  const poorCtx = billingContext({ excellentTextModelImpl: makeTextModel(poorCounters) });
  const blocked = await postFusion(poorCtx, { __noteId: "bill-note-1", ...fusionBody({}) }, "redbase_session=bill-poor");
  assert.equal(blocked.statusCode, 402);
  assert.match(blocked.body.error, /需要 1 积分/);
  assert.equal(poorCounters.fusion, 0, "insufficient balance must not call the fusion model");
});

test("directions/fusion require a valid requestId", async () => {
  const ctx = billingContext({ excellentTextModelImpl: makeTextModel({ directions: 0, fusion: 0 }) });
  const missing = await postDirections(
    ctx,
    { __noteId: "bill-note-1", ...directionsBody({}), requestId: "" },
    "redbase_session=bill-rich",
  );
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.error, /requestId/);

  const badFusion = await postFusion(
    ctx,
    { __noteId: "bill-note-1", ...fusionBody({}), requestId: "bad id" },
    "redbase_session=bill-rich",
  );
  assert.equal(badFusion.statusCode, 400);
});

test("refresh cooldown: normal user gets 429 while cooling down, admin bypasses, failure releases", async () => {
  resetExcellentRefreshCooldowns();
  const ctx = billingContext();
  const cookie = "redbase_session=bill-cool";

  // 上游失败（pgy 关闭）→ 502，且失败会释放冷却：立刻重试仍是 502 而不是 429。
  const firstFail = createRes();
  await handleExcellentContentRoutes(
    ctx,
    createPostReq("/api/excellent-contents/refresh", { board: "xhs_hot" }, cookie),
    firstFail,
    "/api/excellent-contents/refresh",
  );
  assert.equal(firstFail.statusCode, 502);
  const retryAfterFail = createRes();
  await handleExcellentContentRoutes(
    ctx,
    createPostReq("/api/excellent-contents/refresh", { board: "xhs_hot" }, cookie),
    retryAfterFail,
    "/api/excellent-contents/refresh",
  );
  assert.equal(retryAfterFail.statusCode, 502, "failed refresh must not lock the user into cooldown");

  // 冷却生效：模拟一次成功刷新后的占位，普通用户 60 秒内 429。
  resetExcellentRefreshCooldowns();
  claimExcellentRefreshSlot(305, { isAdmin: false });
  const cooled = createRes();
  await handleExcellentContentRoutes(
    ctx,
    createPostReq("/api/excellent-contents/refresh", { board: "xhs_hot" }, cookie),
    cooled,
    "/api/excellent-contents/refresh",
  );
  assert.equal(cooled.statusCode, 429);
  assert.equal(cooled.body.code, "REFRESH_COOLDOWN");
  assert.ok(cooled.body.retryAfterSeconds >= 1 && cooled.body.retryAfterSeconds <= 60);

  // 管理员绕过冷却：即使占位存在，也不会返回 429（继续走上游 → 502）。
  claimExcellentRefreshSlot(306, { isAdmin: false });
  const adminRes = createRes();
  await handleExcellentContentRoutes(
    ctx,
    createPostReq("/api/excellent-contents/refresh", { board: "xhs_hot" }, "redbase_session=bill-admin"),
    adminRes,
    "/api/excellent-contents/refresh",
  );
  assert.notEqual(adminRes.statusCode, 429, "admin must bypass the refresh cooldown");
  assert.equal(adminRes.statusCode, 502);
  resetExcellentRefreshCooldowns();
});

test("refresh cooldown timing helper: deny within 60s, allow after, release clears", () => {
  resetExcellentRefreshCooldowns();
  const t0 = 1_000_000;
  assert.equal(claimExcellentRefreshSlot(901, { now: t0 }).allowed, true);
  const denied = claimExcellentRefreshSlot(901, { now: t0 + 30 * 1000 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 30);
  assert.equal(claimExcellentRefreshSlot(901, { now: t0 + EXCELLENT_REFRESH_COOLDOWN_MS }).allowed, true);
  releaseExcellentRefreshSlot(901);
  assert.equal(claimExcellentRefreshSlot(901, { now: t0 + EXCELLENT_REFRESH_COOLDOWN_MS + 1000 }).allowed, true);
  assert.equal(claimExcellentRefreshSlot(902, { isAdmin: true, now: t0 }).allowed, true);
  assert.equal(claimExcellentRefreshSlot(902, { isAdmin: true, now: t0 + 1000 }).allowed, true, "admin never cools down");
  resetExcellentRefreshCooldowns();
});
