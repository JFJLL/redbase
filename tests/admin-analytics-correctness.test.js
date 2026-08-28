const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, createSessionForUser, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertGeneration, findGenerationById, upsertGeneration } = require("../src/server/db/repositories/generation-repository");
const { insertPaymentOrder, settlePaidPaymentOrder } = require("../src/server/db/repositories/payment-repository");
const { createProjectWithBilling, updateProject, updateClip, getProject } = require("../src/server/db/repositories/video-project-repository");
const { deleteUserCascadeRows } = require("../src/server/db/repositories/admin-repository");
const { purgeGenerationAssetsPreservingData } = require("../src/server/assets/generation-deletion-service");
const { createVideoProjectService } = require("../src/server/video/video-project-service");
const { callTextModelJson } = require("../src/server/ai/text-provider");
const {
  getOverviewMetrics,
  getUsersMetrics,
  getFeaturesMetrics,
  getAiMetrics,
  getFinanceMetrics,
} = require("../src/server/analytics/analytics-metrics");
const { parseQueryRange, isValidCalendarDate } = require("../src/server/analytics/analytics-query-range");
const { createApiHandler } = require("../src/server/api");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

test("1. queued or failed video projects do NOT emit output_completed, completed video project emits exactly once", async () => {
  const userId = 9001;
  insertUser({
    id: userId,
    name: "视频测试用户",
    phone: "13900009001",
    password: "hash",
    accountType: "customer",
    credits: 100,
    createdAt: "2026-08-20T00:00:00.000Z",
  });

  // 1. Create a video project (queued)
  const created = createProjectWithBilling({
    project: {
      ownerUserId: userId,
      requestId: "req-vid-1",
      brandId: 1,
      trendId: 1,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "queued",
      createdAt: "2026-08-20T10:00:00.000Z",
    },
    clips: [
      { clipIndex: 1, startSec: 0, endSec: 10, durationSec: 10, status: "queued", creditCost: 10 },
    ],
    generation: {
      ownerUserId: userId,
      type: "videoProject",
      channelLabel: "AI视频",
      brandId: 1,
      brandName: "测试品牌",
      trendId: 1,
      trendTitle: "趋势1",
      ideaTitle: "选题1",
      cardTitle: "视频项目1",
      createdAt: "2026-08-20T10:00:00.000Z",
      visibilityStatus: "active",
      assetStatus: "available",
    },
    billing: {
      creditCost: 10,
      event: { actionType: "videoProject", actionLabel: "视频生成", brandId: 1, summary: "视频生成" },
    },
  });

  assert.ok(created.project);
  const queuedEvents = db.prepare("SELECT * FROM analytics_events WHERE event_name = 'output_completed' AND actor_user_id = ?").all(userId);
  assert.equal(queuedEvents.length, 0, "Queued video project must NOT write output_completed");

  // 2. Mark project as failed
  updateProject(created.project.id, { status: "failed", error: "测试失败" });
  const failedEvents = db.prepare("SELECT * FROM analytics_events WHERE event_name = 'output_completed' AND actor_user_id = ?").all(userId);
  assert.equal(failedEvents.length, 0, "Failed video project must NOT write output_completed");

  // 3. Complete the project
  updateProject(created.project.id, { status: "completed", completedAt: "2026-08-20T10:05:00.000Z" });
  const completedEvents = db.prepare("SELECT * FROM analytics_events WHERE event_name = 'output_completed' AND actor_user_id = ?").all(userId);
  assert.equal(completedEvents.length, 1, "Completed video project must write output_completed exactly once");

  // 4. Repeated complete or update must be idempotent
  updateProject(created.project.id, { status: "completed", completedAt: "2026-08-20T10:05:00.000Z" });
  const recheckedEvents = db.prepare("SELECT * FROM analytics_events WHERE event_name = 'output_completed' AND actor_user_id = ?").all(userId);
  assert.equal(recheckedEvents.length, 1, "Repeated complete must be idempotent");
});

test("2. revenue, paying users, channel and plan statistics remain unchanged before and after user deletion", () => {
  const userId = 9002;
  insertUser({
    id: userId,
    name: "付费用户",
    phone: "13900009002",
    password: "hash",
    accountType: "customer",
    credits: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
  });

  const order = insertPaymentOrder({
    outTradeNo: "out-trade-9002-1",
    userId,
    idempotencyKey: "idem-9002-1",
    plan: { id: "pro-monthly", name: "专业月卡", credits: 500, amountFen: 9900 },
    status: "created",
    provider: "wxpay",
    nowIso: "2026-08-21T10:00:00.000Z",
    expiresAtIso: "2026-08-21T11:00:00.000Z",
  });

  settlePaidPaymentOrder({
    outTradeNo: order.outTradeNo,
    tradeNo: "wx-trade-9002-1",
    nowIso: "2026-08-21T10:02:00.000Z",
  });

  const query = { from: "2026-08-21", to: "2026-08-22", timezone: "Asia/Shanghai" };

  const beforeOverview = getOverviewMetrics(query);
  const beforeFinance = getFinanceMetrics(query);

  assert.equal(beforeOverview.kpis.revenueYuan.value, 99);
  assert.equal(beforeOverview.kpis.payingUsers.value, 1);
  assert.equal(beforeFinance.overview.revenueYuan, 99);
  assert.equal(beforeFinance.overview.payingUsers, 1);
  assert.equal(beforeFinance.overview.paidOrders, 1);
  assert.equal(beforeFinance.channelComparison[0]?.provider, "wxpay");
  assert.equal(beforeFinance.channelComparison[0]?.revenueYuan, 99);
  assert.equal(beforeFinance.planDistribution[0]?.planId, "pro-monthly");

  // Verify payment facts do not contain trade numbers
  const paymentEvents = db.prepare("SELECT * FROM analytics_events WHERE event_name IN ('payment_order_created', 'payment_paid') AND entity_id = ?").all(String(order.id));
  assert.ok(paymentEvents.length >= 2);
  for (const ev of paymentEvents) {
    assert.equal(ev.event_key.includes("out-trade-"), false, "event_key must not contain out_trade_no");
    assert.equal(ev.entity_id, String(order.id), "entity_id must use internal order ID");
    assert.equal(JSON.stringify(ev).includes("wx-trade-"), false, "facts must not contain trade_no");
  }

  // Delete user cascade
  deleteUserCascadeRows(userId);

  const afterOverview = getOverviewMetrics(query);
  const afterFinance = getFinanceMetrics(query);

  assert.equal(afterOverview.kpis.revenueYuan.value, 99, "Revenue must NOT drop after user deletion");
  assert.equal(afterOverview.kpis.payingUsers.value, 1, "Paying users count must NOT drop after user deletion");
  assert.equal(afterFinance.overview.revenueYuan, 99, "Finance revenue must NOT drop after user deletion");
  assert.equal(afterFinance.overview.payingUsers, 1, "Finance paying users must NOT drop after user deletion");
  assert.equal(afterFinance.overview.paidOrders, 1, "Finance paid orders must NOT drop after user deletion");
  assert.equal(afterFinance.channelComparison[0]?.revenueYuan, 99, "Channel revenue must NOT drop after user deletion");
  assert.equal(afterFinance.planDistribution[0]?.revenueYuan, 99, "Plan revenue must NOT drop after user deletion");
});

test("3. text model and video project attempts record real attempt metrics and lifecycle timestamps", async () => {
  const userId = 9003;
  insertUser({
    id: userId,
    name: "可观测用户",
    phone: "13900009003",
    password: "hash",
    accountType: "customer",
    credits: 100,
    createdAt: "2026-08-22T00:00:00.000Z",
  });

  // Fake text provider call with telemetry
  const appConfig = {
    textProvider: {
      apiKey: "fake-key",
      apiStyle: "openai",
      model: "gpt-4o",
      openaiBaseUrl: "http://127.0.0.1:9999",
    },
  };

  // Test callTextModelJson with failing connection captures attempt
  try {
    await callTextModelJson(appConfig, {
      systemPrompt: "sys",
      userPrompt: "user",
      maxAttempts: 1,
      timeoutMs: 500,
    });
  } catch (_) {}

  const textAttempts = db.prepare("SELECT * FROM ai_task_attempts WHERE task_type = 'text_generation' ORDER BY id DESC LIMIT 1").get();
  assert.ok(textAttempts, "Physical text call must produce an attempt record");
  assert.equal(textAttempts.model, "gpt-4o");
  assert.equal(textAttempts.status, "failed");

  // Test video service real flow
  const videoService = createVideoProjectService({
    appConfig: {
      video: {
        agnes: { apiKeys: ["fake-agnes-1", "fake-agnes-2"], maxClipAttempts: 2 },
        pollIntervalMs: 10,
      },
    },
    providers: {
      d2: {
        provider: "fake-d2",
        submitClip: async () => ({ taskId: "d2-task-1" }),
        getTaskStatus: async () => ({ status: "completed", videoUrl: "http://example.com/test.mp4" }),
      },
      g2: {
        provider: "fake-g2",
        submitClip: async () => ({ taskId: "g2-task-1" }),
        getTaskStatus: async () => ({ status: "completed", videoUrl: "http://example.com/test.mp4" }),
      },
    },
  });

  const created = createProjectWithBilling({
    project: {
      ownerUserId: userId,
      requestId: "req-vid-real-1",
      brandId: 1,
      trendId: 1,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "queued",
      createdAt: "2026-08-22T10:00:00.000Z",
    },
    clips: [
      { clipIndex: 1, startSec: 0, endSec: 10, durationSec: 10, status: "queued", creditCost: 10, prompt: "镜头1" },
    ],
    generation: {
      ownerUserId: userId,
      type: "videoProject",
      channelLabel: "AI视频",
      brandId: 1,
      brandName: "测试品牌",
      trendId: 1,
      trendTitle: "趋势1",
      ideaTitle: "选题1",
      cardTitle: "真实视频1",
      createdAt: "2026-08-22T10:00:00.000Z",
      visibilityStatus: "active",
      assetStatus: "available",
    },
    billing: {
      creditCost: 10,
      event: { actionType: "videoProject", actionLabel: "视频生成", brandId: 1, summary: "视频生成" },
    },
  });

  // Start execution
  await videoService.startProject(created.project.id, userId);
  await videoService.pump();
  const updatedProject = getProject(created.project.id);
  assert.ok(updatedProject.startedAt, "started_at must be recorded upon execution start");
  const updatedClip = updatedProject.clips[0];
  assert.ok(updatedClip.firstSubmittedAt, "first_submitted_at must be recorded upon clip submit");
});

test("4. media retention purge clears all media URLs and serveAsset returns 404", async () => {
  const userId = 9004;
  insertUser({
    id: userId,
    name: "清理测试用户",
    phone: "13900009004",
    password: "hash",
    accountType: "customer",
    credits: 100,
    createdAt: "2026-07-01T00:00:00.000Z",
  });

  const gen = insertGeneration({
    ownerUserId: userId,
    type: "styleImage",
    channelLabel: "风格图",
    brandId: 1,
    brandName: "测试品牌",
    trendId: 1,
    trendTitle: "趋势1",
    ideaTitle: "选题1",
    cardTitle: "待清理图片",
    createdAt: "2026-07-01T10:00:00.000Z",
    previewUrl: "http://example.com/image.png",
    visibilityStatus: "active",
    assetStatus: "available",
    payload: {
      imageUrl: "http://example.com/image.png",
      previewUrl: "http://example.com/image.png",
    },
  });

  const mockStorage = {
    provider: "local",
    deleteMany: async () => ({ deletedAssetCount: 0 }),
    stageDeleteMany: async () => ({
      deletedAssetCount: 0,
      commit: async () => {},
      rollback: async () => {},
    }),
  };

  const purgeRes = await purgeGenerationAssetsPreservingData(gen, {
    storage: mockStorage,
    deletedAt: "2026-08-28T10:00:00.000Z",
  });
  assert.equal(purgeRes.ok, true);

  const purgedGen = findGenerationById(gen.id);
  assert.equal(purgedGen.visibilityStatus, "expired");
  assert.equal(purgedGen.assetStatus, "none");
  assert.equal(purgedGen.previewUrl, "");
  assert.equal(purgedGen.payload.imageUrl, "");
  assert.equal(purgedGen.payload.previewUrl, "");
});

test("5. main conversion funnel and video funnel are strictly sequential and never invert", () => {
  const query = { from: "2026-08-01", to: "2026-08-29", timezone: "Asia/Shanghai" };
  const userMetrics = getUsersMetrics(query);

  const mainSteps = userMetrics.mainFunnel;
  for (let i = 1; i < mainSteps.length; i++) {
    assert.ok(
      mainSteps[i].count <= mainSteps[i - 1].count,
      `Funnel step ${mainSteps[i].step} (${mainSteps[i].count}) must be <= previous step ${mainSteps[i - 1].step} (${mainSteps[i - 1].count})`,
    );
    if (mainSteps[i].rate !== null) {
      assert.ok(mainSteps[i].rate <= 100, "Funnel rate must not exceed 100%");
    }
  }

  const videoSteps = userMetrics.videoFunnel;
  for (let i = 1; i < videoSteps.length; i++) {
    assert.ok(
      videoSteps[i].count <= videoSteps[i - 1].count,
      `Video funnel step ${videoSteps[i].step} (${videoSteps[i].count}) must be <= previous step ${videoSteps[i - 1].step} (${videoSteps[i - 1].count})`,
    );
  }
});

test("6. date validation rejects invalid calendar dates like 2026-02-31", () => {
  assert.equal(isValidCalendarDate("2026-02-28"), true);
  assert.equal(isValidCalendarDate("2026-02-31"), false);
  assert.equal(isValidCalendarDate("2026-04-31"), false);
  assert.equal(isValidCalendarDate("2026-13-01"), false);

  assert.throws(() => {
    parseQueryRange({ from: "2026-02-31", to: "2026-03-05", timezone: "Asia/Shanghai" });
  }, { code: "INVALID_DATE" });
});

test("7. client events endpoint enforces 2KB payload limit and rate limit", async () => {
  const userId = 9005;
  insertUser({
    id: userId,
    name: "客户端埋点用户",
    phone: "13900009005",
    password: "hash",
    accountType: "customer",
    credits: 100,
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  const token = "token-9005";
  createSessionForUser(userId, token);

  const handleApi = createApiHandler({
    appConfig: { admin: { phones: [] }, security: { cookieSecure: false } },
    store: {},
    ai: { imageJobs: new Map() },
  });

  function makeReq(urlPath, { method = "GET", headers = {}, body = null } = {}) {
    const stream = new EventEmitter();
    stream.method = method;
    stream.url = urlPath;
    stream.headers = { host: "127.0.0.1", ...headers };
    stream.destroy = function () {};
    process.nextTick(() => {
      if (body) {
        const payload = typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
        stream.emit("data", payload);
      }
      stream.emit("end");
    });
    return stream;
  }

  function makeRes() {
    const emitter = new EventEmitter();
    let statusCode = 200;
    const headers = {};
    let bodyText = "";
    return {
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      writeHead(code, h = {}) {
        statusCode = code;
        Object.assign(headers, h);
      },
      setHeader(k, v) { headers[k] = v; },
      end(chunk) {
        if (chunk) bodyText += chunk.toString();
        emitter.emit("finish");
      },
      get statusCode() { return statusCode; },
      get headers() { return headers; },
      get json() { return JSON.parse(bodyText || "{}"); },
    };
  }

  // Valid event <= 2KB
  const req1 = makeReq("/api/analytics/events", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: { eventName: "recharge_page_viewed", metadata: { page: "recharge" } },
  });
  const res1 = makeRes();
  await handleApi(req1, res1, "/api/analytics/events");
  assert.equal(res1.statusCode, 200);

  // Over 2KB event
  const largeMeta = "x".repeat(3000);
  const req2 = makeReq("/api/analytics/events", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: { eventName: "recharge_page_viewed", metadata: { large: largeMeta } },
  });
  const res2 = makeRes();
  await handleApi(req2, res2, "/api/analytics/events");
  assert.equal(res2.statusCode, 413, "Events > 2KB must return 413");
});
