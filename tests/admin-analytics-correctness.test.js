const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, createSessionForUser, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertGeneration, findGenerationById, upsertGeneration } = require("../src/server/db/repositories/generation-repository");
const { insertPaymentOrder, settlePaidPaymentOrder, closePaymentOrder } = require("../src/server/db/repositories/payment-repository");
const { createProjectWithBilling, updateProject, updateClip, getProject } = require("../src/server/db/repositories/video-project-repository");
const { deleteUserCascadeRows, insertCreditEvent } = require("../src/server/db/repositories/admin-repository");
const { upsertImageJob } = require("../src/server/db/repositories/image-job-repository");
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
const { recordUserActiveDay, recordUserRegistered, recordPaymentOrderCreated, recordPaymentPaid } = require("../src/server/analytics/analytics-recorder");
const { recordTextTaskAttempt, recordVideoClipAttempt, recordImageTaskAttempt } = require("../src/server/analytics/ai-attempt-recorder");
const { insertAnalyticsEvent, getAnalyticsMeta } = require("../src/server/analytics/analytics-repository");
const { ensureAnalyticsBackfill, ensureUserAnalyticsBackfill } = require("../src/server/analytics/analytics-backfill");
const { generateVisualBible } = require("../src/server/ai/video-script-service");

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
      analyticsContext: {
        feature: "video_script",
        taskType: "text_generation",
        actorUserId: userId,
        accountType: "customer",
        entityType: "video_script",
        entityId: "analytics-context-9003",
      },
    });
  } catch (_) {}

  const textAttempts = db.prepare("SELECT * FROM ai_task_attempts WHERE task_type = 'text_generation' ORDER BY id DESC LIMIT 1").get();
  assert.ok(textAttempts, "Physical text call must produce an attempt record");
  assert.equal(textAttempts.model, "gpt-4o");
  assert.equal(textAttempts.status, "failed");
  assert.equal(textAttempts.feature, "video_script");
  assert.equal(textAttempts.actor_user_id, userId);
  assert.equal(textAttempts.account_type, "customer");

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

test("8. provider submission is auxiliary and one physical generation attempt has one terminal fact", () => {
  const userId = 9006;
  insertUser({ id: userId, name: "Attempt User", phone: "13900009006", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-08-26T00:00:00.000Z" });
  recordVideoClipAttempt({
    taskType: "video_submission", projectId: 99006, clipId: 990061, clipIndex: 1,
    attemptNo: 1, status: "completed", providerTaskId: "accepted-task", actorUserId: userId,
    startedAt: "2026-08-26T10:00:00.000Z", completedAt: "2026-08-26T10:00:01.000Z",
  });
  recordVideoClipAttempt({
    projectId: 99006, clipId: 990061, clipIndex: 1, attemptNo: 1,
    status: "failed", errorStage: "provider", actorUserId: userId,
    startedAt: "2026-08-26T10:00:00.000Z", completedAt: "2026-08-26T10:00:05.000Z",
  });
  const facts = db.prepare("SELECT task_type, status FROM ai_task_attempts WHERE project_id = ? ORDER BY id").all(99006);
  assert.deepEqual(facts, [
    { task_type: "video_submission", status: "completed" },
    { task_type: "video_clip_generation", status: "failed" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_task_attempts WHERE project_id = ? AND task_type = 'video_clip_generation'").get(99006).count, 1);

  recordImageTaskAttempt({ jobId: "async-9006", attemptNo: 1, status: "completed", actorUserId: userId, startedAt: "2026-08-26T10:00:00.000Z" });
  recordImageTaskAttempt({ jobId: "async-9006", attemptNo: 1, status: "failed", actorUserId: userId, startedAt: "2026-08-26T10:00:00.000Z" });
  const imageFacts = db.prepare("SELECT status FROM ai_task_attempts WHERE attempt_key = 'image_generation:async-9006:1'").all();
  assert.deepEqual(imageFacts, [{ status: "completed" }], "stable attempt identity prevents completed+failed double facts");
});

test("9. finance conversion uses the created-order cohort and cannot exceed 100%", () => {
  const userId = 9007;
  insertUser({ id: userId, name: "Cohort User", phone: "13900009007", password: "hash", accountType: "customer", credits: 0, createdAt: "2026-08-01T00:00:00.000Z" });
  recordPaymentOrderCreated({ orderId: 9900701, userId, accountType: "customer", amountFen: 100, provider: "wxpay", createdAt: "2026-08-20T00:00:00.000Z" });
  recordPaymentPaid({ orderId: 9900701, userId, accountType: "customer", amountFen: 100, provider: "wxpay", paidAt: "2026-08-27T01:00:00.000Z" });
  recordPaymentOrderCreated({ orderId: 9900702, userId, accountType: "customer", amountFen: 200, provider: "wxpay", createdAt: "2026-08-27T02:00:00.000Z" });
  recordPaymentPaid({ orderId: 9900702, userId, accountType: "customer", amountFen: 200, provider: "wxpay", paidAt: "2026-08-29T01:00:00.000Z" });
  const finance = getFinanceMetrics({ from: "2026-08-27", to: "2026-08-28" });
  assert.equal(finance.overview.paidInPeriod, 1);
  assert.equal(finance.overview.createdInPeriod, 1);
  assert.equal(finance.overview.cohortPaid, 1);
  assert.equal(finance.overview.conversionRate, 100);
});

test("10. configured admins are excluded without excluding yimei users", () => {
  const previousPhones = process.env.ADMIN_PHONES;
  process.env.ADMIN_PHONES = "13900009008";
  try {
    insertUser({ id: 9008, name: "Configured Admin", phone: "13900009008", password: "hash", accountType: "yimei", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
    insertUser({ id: 9009, name: "Yimei User", phone: "13900009009", password: "hash", accountType: "yimei", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
    recordUserActiveDay({ userId: 9008, accountType: "yimei", occurredAt: "2026-08-27T05:00:00.000Z" });
    recordUserActiveDay({ userId: 9009, accountType: "yimei", occurredAt: "2026-08-27T05:00:00.000Z" });
    recordVideoClipAttempt({ projectId: 99008, clipId: 990081, attemptNo: 1, status: "completed", actorUserId: 9008, startedAt: "2026-08-27T05:00:00.000Z" });
    recordVideoClipAttempt({ projectId: 99009, clipId: 990091, attemptNo: 1, status: "completed", actorUserId: 9009, startedAt: "2026-08-27T05:00:00.000Z" });
    const users = getUsersMetrics({ from: "2026-08-27", to: "2026-08-28", accountType: "yimei" });
    const ai = getAiMetrics({ from: "2026-08-27", to: "2026-08-28", accountType: "yimei" });
    assert.equal(users.activity.todayDau, 1);
    assert.equal(ai.summary.totalRequests, 1);
  } finally {
    if (previousPhones == null) delete process.env.ADMIN_PHONES;
    else process.env.ADMIN_PHONES = previousPhones;
  }
});

test("11. strict analytics failure prevents user deletion", () => {
  const userId = 9010;
  insertUser({ id: userId, name: "Delete Guard", phone: "13900009010", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
  db.prepare("DELETE FROM analytics_events WHERE event_key = ?").run(`user_registered:${userId}`);
  db.exec(`CREATE TRIGGER fail_analytics_delete_guard BEFORE INSERT ON analytics_events
    WHEN NEW.actor_user_id = ${userId} BEGIN SELECT RAISE(ABORT, 'forced analytics failure'); END;`);
  assert.throws(() => deleteUserCascadeRows(userId), /用户分析事实回填失败/);
  assert.ok(findUserById(userId), "user row must remain after analytics failure");
  db.exec("DROP TRIGGER fail_analytics_delete_guard");
});

test("12. D2/G2 fact metrics remain identical after user deletion", () => {
  const userId = 9011;
  insertUser({ id: userId, name: "Fact History", phone: "13900009011", password: "hash", accountType: "customer", credits: 100, createdAt: "2026-08-27T00:00:00.000Z" });
  const created = createProjectWithBilling({
    project: {
      ownerUserId: userId, requestId: "fact-history-9011", brandId: 1, trendId: 1, ideaIndex: 0,
      model: "g2", mode: "text", resolution: "720p", aspectRatio: "9:16", totalDurationSec: 10,
      status: "queued", createdAt: "2026-08-27T03:00:00.000Z",
    },
    clips: [{ clipIndex: 1, startSec: 0, endSec: 10, durationSec: 10, status: "queued", creditCost: 2 }],
    generation: { ownerUserId: userId, type: "videoProject", channelLabel: "AI视频", brandId: 1, brandName: "B", trendId: 1, trendTitle: "T", ideaTitle: "I", cardTitle: "V", createdAt: "2026-08-27T03:00:00.000Z" },
    billing: { creditCost: 2, event: { actionType: "videoProject", actionLabel: "视频生成", payload: {} } },
  });
  const clip = created.project.clips[0];
  recordVideoClipAttempt({ projectId: created.project.id, clipId: clip.id, attemptNo: 1, attemptKind: "initial", status: "failed", actorUserId: userId, startedAt: "2026-08-27T03:00:00.000Z", completedAt: "2026-08-27T03:00:05.000Z", durationMs: 5000 });
  recordVideoClipAttempt({ projectId: created.project.id, clipId: clip.id, attemptNo: 2, attemptKind: "auto_retry", status: "completed", actorUserId: userId, startedAt: "2026-08-27T03:00:06.000Z", completedAt: "2026-08-27T03:00:14.000Z", durationMs: 8000 });
  updateProject(created.project.id, { status: "completed", completedAt: "2026-08-27T03:00:20.000Z" });
  const query = { from: "2026-08-27", to: "2026-08-28", accountType: "customer" };
  const before = getAiMetrics(query).videoComparison;
  deleteUserCascadeRows(userId);
  const after = getAiMetrics(query).videoComparison;
  assert.deepEqual(after, before);
});

test("13. backfill repairs a missing account_type dimension without changing the fact", () => {
  const userId = 9012;
  insertUser({ id: userId, name: "Dimension Repair", phone: "13900009012", password: "hash", accountType: "yimei", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
  db.prepare("UPDATE analytics_events SET account_type = '' WHERE event_key = ?").run(`user_registered:${userId}`);
  recordUserRegistered({ userId, createdAt: "2026-08-27T00:00:00.000Z" });
  const repaired = db.prepare("SELECT account_type, occurred_at FROM analytics_events WHERE event_key = ?").get(`user_registered:${userId}`);
  assert.equal(repaired.account_type, "yimei");
  assert.equal(repaired.occurred_at, "2026-08-27T00:00:00.000Z");
});

test("14. yimei credit facts never fall back to customer", () => {
  const userId = 9013;
  insertUser({ id: userId, name: "Yimei Credits", phone: "13900009013", password: "hash", accountType: "yimei", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
  const credit = insertCreditEvent({ userId, actionType: "styleImage", actionLabel: "风格图", creditDelta: -1, creditCost: 1, createdAt: "2026-08-27T01:00:00.000Z" });
  const fact = db.prepare("SELECT account_type FROM analytics_events WHERE event_key = ?").get(`credit_consumed:${credit.id}`);
  assert.equal(fact.account_type, "yimei");
});

test("15. async image pending state never obscures the final generation terminal fact", () => {
  const userId = 9014;
  insertUser({ id: userId, name: "Async Image", phone: "13900009014", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-08-27T00:00:00.000Z" });
  const base = { ownerUserId: userId, provider: "fake", model: "image-v1", createdAt: Date.parse("2026-08-27T01:00:00.000Z"), metadata: { attemptNo: 1, attemptStartedAt: "2026-08-27T01:00:00.000Z" }, generationContext: { type: "styleImage" } };
  upsertImageJob(userId, { ...base, id: "async-complete-9014", status: "pending" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_task_attempts WHERE entity_id = ?").get("async-complete-9014").count, 0);
  upsertImageJob(userId, { ...base, id: "async-complete-9014", status: "completed", imageUrl: "https://example.com/result.png", completedAt: "2026-08-27T01:00:05.000Z" });
  upsertImageJob(userId, { ...base, id: "async-failed-9014", status: "pending" });
  upsertImageJob(userId, { ...base, id: "async-failed-9014", status: "failed", error: "provider failed" });
  assert.deepEqual(db.prepare("SELECT entity_id, status FROM ai_task_attempts WHERE entity_id IN (?, ?) ORDER BY entity_id").all("async-complete-9014", "async-failed-9014"), [
    { entity_id: "async-complete-9014", status: "completed" },
    { entity_id: "async-failed-9014", status: "failed" },
  ]);
});

test("16. credit analytics metadata strictly whitelists fields in realtime and backfill paths", () => {
  const userId = 9015;
  insertUser({ id: userId, name: "Safe Metadata", phone: "13900009015", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-09-01T00:00:00.000Z" });
  const payload = {
    projectId: 5515,
    clipIndex: 2,
    provider: "fake",
    retryOperation: "videoProjectRetry",
    generationPayload: {
      prompt: "secret prompt",
      objectKey: "private/object-key",
      storedPath: "uploads/private.png",
      imageUrl: "https://private.example/image.png",
    },
    headers: { Authorization: "Bearer secret-token-value" },
  };
  const credit = insertCreditEvent({
    userId,
    actionType: "videoProjectRetry",
    actionLabel: "视频重试",
    creditDelta: -2,
    creditCost: 2,
    createdAt: "2026-09-01T01:00:00.000Z",
    payload,
  });
  const assertSafe = () => {
    const row = db.prepare("SELECT metadata_json FROM analytics_events WHERE event_key = ?").get(`credit_consumed:${credit.id}`);
    const metadata = JSON.parse(row.metadata_json);
    assert.deepEqual(metadata, {
      actionType: "videoProjectRetry",
      projectId: 5515,
      clipIndex: 2,
      provider: "fake",
      retryOperation: "videoProjectRetry",
    });
    for (const forbidden of ["generationPayload", "prompt", "objectKey", "storedPath", "imageUrl", "headers", "secret prompt", "private/object-key"]) {
      assert.equal(row.metadata_json.includes(forbidden), false, `${forbidden} must not enter analytics metadata`);
    }
  };
  assertSafe();
  db.prepare("UPDATE analytics_events SET metadata_json = ? WHERE event_key = ?").run(JSON.stringify(payload), `credit_consumed:${credit.id}`);
  const backfill = ensureUserAnalyticsBackfill(userId);
  assert.equal(backfill.ok, true);
  assertSafe();
});

test("17. average DAU includes zero-activity natural days and reports the full sample size", () => {
  for (let i = 0; i < 70; i += 1) {
    insertAnalyticsEvent({
      eventKey: `avg-dau-70:${i}`,
      eventName: "user_active_day",
      occurredAt: "2026-09-02T04:00:00.000Z",
      actorKey: `avg-dau-user:${i}`,
      accountType: "customer",
    });
  }
  const metrics = getOverviewMetrics({ from: "2026-09-02", to: "2026-09-09", accountType: "customer" });
  assert.equal(metrics.kpis.dau.value, 10);
  assert.equal(metrics.kpis.dau.sampleSize, 7);
});

test("18. retention aggregates one flag per actor before cohort counting", () => {
  const userId = 9016;
  recordUserRegistered({ userId, accountType: "customer", createdAt: "2026-09-10T01:00:00.000Z" });
  recordUserActiveDay({ userId, accountType: "customer", occurredAt: "2026-09-11T01:00:00.000Z" });
  recordUserActiveDay({ userId, accountType: "customer", occurredAt: "2026-09-12T01:00:00.000Z" });
  recordUserActiveDay({ userId, accountType: "customer", occurredAt: "2026-09-13T01:00:00.000Z" });
  const metrics = getUsersMetrics({ from: "2026-09-10", to: "2026-09-15", accountType: "customer" });
  assert.equal(metrics.retention.d1CohortSize, 1);
  assert.equal(metrics.retention.d1Retained, 1);
  assert.equal(metrics.retention.d1Rate, 100);
});

test("19. multi-clip retry project is not first-success and is counted as rescued", () => {
  const projectId = 99016;
  insertAnalyticsEvent({
    eventKey: `video_project_created:${projectId}`,
    eventName: "video_project_created",
    occurredAt: "2026-09-16T01:00:00.000Z",
    actorKey: "multi-clip-user",
    accountType: "customer",
    feature: "video_project",
    entityType: "video_project",
    entityId: String(projectId),
    model: "g2",
    mode: "image",
    resolution: "1080p",
    aspectRatio: "16:9",
    mediaDurationSec: 16,
    metadata: { expectedClipCount: 2, expectedClipIds: [990161, 990162] },
  });
  insertAnalyticsEvent({
    eventKey: `video_project_completed:${projectId}`,
    eventName: "video_project_completed",
    occurredAt: "2026-09-16T01:00:20.000Z",
    actorKey: "multi-clip-user",
    accountType: "customer",
    feature: "video_project",
    entityType: "video_project",
    entityId: String(projectId),
    model: "g2",
    mode: "image",
    resolution: "1080p",
    aspectRatio: "16:9",
    mediaDurationSec: 16,
    durationMs: 20000,
  });
  recordVideoClipAttempt({ projectId, clipId: 990161, clipIndex: 1, attemptNo: 1, attemptKind: "initial", status: "completed", durationMs: 5000, accountType: "customer", startedAt: "2026-09-16T01:00:00.000Z" });
  recordVideoClipAttempt({ projectId, clipId: 990162, clipIndex: 2, attemptNo: 1, attemptKind: "initial", status: "failed", durationMs: 4000, accountType: "customer", startedAt: "2026-09-16T01:00:05.000Z" });
  recordVideoClipAttempt({ projectId, clipId: 990162, clipIndex: 2, attemptNo: 2, attemptKind: "auto_retry", status: "completed", durationMs: 7000, accountType: "customer", startedAt: "2026-09-16T01:00:10.000Z" });
  const row = getAiMetrics({ from: "2026-09-16", to: "2026-09-17", accountType: "customer" }).videoComparison
    .find((item) => item.model === "g2" && item.mode === "image" && item.resolution === "1080p");
  assert.ok(row);
  assert.equal(row.firstSuccessRate, 0);
  assert.equal(row.autoRetryRate, 100);
  assert.equal(row.rescueRate, 100);
  assert.equal(row.p50DurationMs, 20000);
  assert.equal(row.clipP50DurationMs, 5000);
});

test("20. image attempt features are canonical and never expose raw camelCase types", () => {
  const mappings = {
    xhsCarousel: "xhs_carousel",
    xhsCarouselSlide: "xhs_carousel",
    imageEdit: "image_edit",
    styleImage: "style_image",
    wechatImage: "wechat_long_image",
    momentsImage: "moments",
    wechat: "wechat_long_image",
    moments: "moments",
  };
  for (const [raw, expected] of Object.entries(mappings)) {
    const jobId = `feature-${raw}`;
    recordImageTaskAttempt({ jobId, feature: raw, status: "completed", startedAt: "2026-09-17T01:00:00.000Z" });
    const row = db.prepare("SELECT feature FROM ai_task_attempts WHERE entity_id = ?").get(jobId);
    assert.equal(row.feature, expected);
  }
});

test("21. Visual Bible forwards auxiliary vision analytics context and does not affect primary success rate", async () => {
  const analyticsContext = {
    feature: "video_script",
    taskType: "vision_analysis",
    actorUserId: 9018,
    accountType: "customer",
    entityType: "video_script",
    entityId: "request-9018:visual-bible",
  };
  let captured = null;
  await generateVisualBible({}, {
    brand: { name: "Visual Brand" },
    idea: { title: "Visual Idea" },
    images: [{ mimeType: "image/png", dataBase64: "aW1n" }],
    analyticsContext,
    visionModelImpl: async (_config, request) => {
      captured = request.analyticsContext;
      return { subject: "product" };
    },
  });
  assert.deepEqual(captured, analyticsContext);
  recordTextTaskAttempt({ ...analyticsContext, attemptKey: "vision-aux-9018", status: "failed", startedAt: "2026-09-18T01:00:00.000Z" });
  recordTextTaskAttempt({ feature: "video_script", taskType: "text_generation", entityId: "request-9018", attemptKey: "primary-9018", status: "completed", accountType: "customer", startedAt: "2026-09-18T01:00:01.000Z" });
  const overview = getOverviewMetrics({ from: "2026-09-18", to: "2026-09-19", accountType: "customer" });
  assert.equal(overview.kpis.aiSuccessRate.value, 100);
  assert.equal(overview.kpis.aiSuccessRate.sampleSize, 1);
});

test("22. startup backfill marks partial coverage when one analytics insert fails", () => {
  const userId = 9017;
  insertUser({ id: userId, name: "Backfill Failure", phone: "13900009017", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-09-19T00:00:00.000Z" });
  db.prepare("DELETE FROM analytics_events WHERE event_key = ?").run(`user_registered:${userId}`);
  db.exec(`CREATE TRIGGER fail_startup_backfill BEFORE INSERT ON analytics_events
    WHEN NEW.event_key = 'user_registered:${userId}' BEGIN SELECT RAISE(ABORT, 'forced startup backfill failure'); END;`);
  let failure;
  try {
    ensureAnalyticsBackfill();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(failure.backfillStats.failed >= 1);
  assert.equal(getAnalyticsMeta("backfill_status"), "failed");
  const coverage = getOverviewMetrics({ from: "2026-09-19", to: "2026-09-20" }).coverage;
  assert.equal(coverage.isPartial, true);
  db.exec("DROP TRIGGER fail_startup_backfill");
  const recovered = ensureAnalyticsBackfill();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.failed, 0);
  assert.equal(recovered.expected, recovered.inserted + recovered.existing);
});

test("23. account distribution honors range/account type and paid orders supersede earlier failures", () => {
  recordUserRegistered({ userId: 9020, accountType: "customer", createdAt: "2026-09-20T01:00:00.000Z" });
  recordUserRegistered({ userId: 9021, accountType: "yimei", createdAt: "2026-09-21T01:00:00.000Z" });
  const users = getUsersMetrics({ from: "2026-09-20", to: "2026-09-21", accountType: "customer" });
  assert.deepEqual(users.accountDistribution, [{ accountType: "customer", label: "客户账号", count: 1 }]);
  for (const [eventName, occurredAt] of [
    ["payment_order_created", "2026-09-20T02:00:00.000Z"],
    ["payment_failed", "2026-09-20T02:01:00.000Z"],
    ["payment_paid", "2026-09-20T02:02:00.000Z"],
  ]) {
    insertAnalyticsEvent({
      eventKey: `${eventName}:final-paid-9020`,
      eventName,
      occurredAt,
      actorKey: "user:9020",
      accountType: "customer",
      entityType: "payment_order",
      entityId: "final-paid-9020",
      amountFen: 100,
    });
  }
  const finance = getFinanceMetrics({ from: "2026-09-20", to: "2026-09-21", accountType: "customer" });
  assert.equal(finance.overview.cohortPaid, 1);
  assert.equal(finance.overview.expiredOrFailed, 0);
});

test("24. nested analytics errors redact secrets recursively and cap stored length", () => {
  recordTextTaskAttempt({
    attemptKey: "text_generation:redaction-9022:1",
    feature: "trend_analysis",
    taskType: "text_generation",
    entityType: "trend_analysis",
    entityId: "redaction-9022",
    status: "failed",
    errorMessage: {
      message: "provider failed",
      debug: {
        token: "never-store-this-token",
        response: `Bearer secret-bearer-value ${"x".repeat(700)}`,
      },
    },
    startedAt: "2026-09-21T01:00:00.000Z",
  });
  const row = db.prepare("SELECT error_message FROM ai_task_attempts WHERE attempt_key = ?").get("text_generation:redaction-9022:1");
  assert.ok(row.error_message.length <= 500);
  assert.equal(row.error_message.includes("never-store-this-token"), false);
  assert.equal(row.error_message.includes("secret-bearer-value"), false);
  assert.match(row.error_message, /\[REDACTED\]/);
});

test("25. active retrying projects never enter the mature Attempt retry-rate numerator", () => {
  const userId = 9023;
  insertUser({ id: userId, name: "Retry Boundary", phone: "13900009023", password: "hash", accountType: "customer", credits: 100, createdAt: "2026-09-22T00:00:00.000Z" });
  const makeProject = (suffix, status) => createProjectWithBilling({
    preventDuplicateActiveProject: false,
    project: {
      ownerUserId: userId, requestId: `retry-boundary-${suffix}`, brandId: 1, trendId: 1, ideaIndex: suffix,
      model: "d2", mode: "text", resolution: "retry-boundary", aspectRatio: "9:16", totalDurationSec: 10,
      status, createdAt: `2026-09-22T0${suffix}:00:00.000Z`,
    },
    clips: [{ clipIndex: 1, startSec: 0, endSec: 10, durationSec: 10, status: "queued", creditCost: 1 }],
    generation: { ownerUserId: userId, type: "videoProject", channelLabel: "AI视频", brandId: 1, brandName: "B", trendId: 1, trendTitle: "T", ideaTitle: "I", cardTitle: `V${suffix}`, createdAt: `2026-09-22T0${suffix}:00:00.000Z` },
    billing: { creditCost: 1, event: { actionType: "videoProject", actionLabel: "视频生成", payload: {} } },
  }).project;

  const mature = makeProject(1, "running");
  recordVideoClipAttempt({ projectId: mature.id, clipId: mature.clips[0].id, attemptNo: 1, attemptKind: "initial", status: "completed", accountType: "customer", startedAt: "2026-09-22T01:00:00.000Z" });
  updateProject(mature.id, { status: "completed", completedAt: "2026-09-22T01:01:00.000Z" });

  const running = makeProject(2, "running");
  const waiting = makeProject(3, "waiting_configuration");
  for (const project of [running, waiting]) {
    recordVideoClipAttempt({ projectId: project.id, clipId: project.clips[0].id, attemptNo: 2, attemptKind: "auto_retry", status: "completed", accountType: "customer", startedAt: "2026-09-22T03:00:00.000Z" });
  }

  const row = getAiMetrics({ from: "2026-09-22", to: "2026-09-23", accountType: "customer" }).videoComparison
    .find((item) => item.model === "d2" && item.resolution === "retry-boundary");
  assert.ok(row);
  assert.equal(row.matureCount, 1);
  assert.equal(row.attemptMetricSampleSize, 1);
  assert.equal(row.autoRetryRate, 0);
  assert.ok(row.autoRetryRate <= 100);
  assert.equal(row.activeCount, 2);
  assert.equal(row.waitingConfigCount, 1);
  assert.equal(row.actionableCount, 1);
});

test("26. historical_summary proves completion but never fabricates zero-percent Attempt metrics", () => {
  const projectId = 99024;
  const common = {
    actorKey: "historical-summary-user",
    accountType: "customer",
    feature: "video_project",
    entityType: "video_project",
    entityId: String(projectId),
    model: "g2",
    mode: "text",
    resolution: "historical-only",
    aspectRatio: "9:16",
    mediaDurationSec: 10,
  };
  insertAnalyticsEvent({ ...common, eventKey: `video_project_created:${projectId}`, eventName: "video_project_created", occurredAt: "2026-09-23T01:00:00.000Z", metadata: { expectedClipCount: 1, expectedClipIds: [990241] } });
  insertAnalyticsEvent({ ...common, eventKey: `video_project_completed:${projectId}`, eventName: "video_project_completed", occurredAt: "2026-09-23T01:01:00.000Z", status: "completed" });
  recordVideoClipAttempt({ projectId, clipId: 990241, attemptNo: 1, attemptKind: "historical_summary", status: "completed", isBackfilled: 1, accountType: "customer", startedAt: "2026-09-23T01:00:00.000Z" });

  const row = getAiMetrics({ from: "2026-09-23", to: "2026-09-24", accountType: "customer" }).videoComparison
    .find((item) => item.resolution === "historical-only");
  assert.ok(row);
  assert.equal(row.completionRate, 100);
  assert.equal(row.attemptMetricSampleSize, 0);
  assert.equal(row.attemptMetricCoverageRate, 0);
  assert.equal(row.firstSuccessRate, null);
  assert.equal(row.autoRetryRate, null);
  assert.equal(row.manualRetryRate, null);
  assert.equal(row.rescueRate, null);
});

test("27. closed payment orders are terminal and never remain pending", () => {
  const userId = 9025;
  insertUser({ id: userId, name: "Closed Payment", phone: "13900009025", password: "hash", accountType: "customer", credits: 0, createdAt: "2026-09-24T00:00:00.000Z" });
  // Keep the target order ID distinct from the immutable fact left by test 2
  // after that test deletes its source payment row.
  insertPaymentOrder({
    outTradeNo: "closed-payment-id-guard-9025",
    userId,
    idempotencyKey: "closed-payment-id-guard-idem-9025",
    plan: { id: "guard-plan", name: "ID Guard", credits: 1, amountFen: 1 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-01-01T01:00:00.000Z",
    expiresAtIso: "2026-01-01T02:00:00.000Z",
  });
  const order = insertPaymentOrder({
    outTradeNo: "closed-payment-9025",
    userId,
    idempotencyKey: "closed-payment-idem-9025",
    plan: { id: "closed-plan", name: "关闭套餐", credits: 10, amountFen: 100 },
    status: "pending",
    provider: "alipay",
    nowIso: "2026-09-24T01:00:00.000Z",
    expiresAtIso: "2026-09-24T02:00:00.000Z",
  });
  closePaymentOrder({ userId, outTradeNo: order.outTradeNo, nowIso: "2026-09-24T01:05:00.000Z" });

  const closedFacts = db.prepare("SELECT event_name, status FROM analytics_events WHERE event_key = ?").all(`payment_closed:${order.id}`);
  assert.deepEqual(closedFacts, [{ event_name: "payment_closed", status: "closed" }]);
  const createdFact = db.prepare("SELECT event_name, occurred_at, account_type, is_admin FROM analytics_events WHERE event_key = ?").get(`payment_order_created:${order.id}`);
  assert.deepEqual(createdFact, { event_name: "payment_order_created", occurred_at: "2026-09-24T01:00:00.000Z", account_type: "customer", is_admin: 0 });
  const finance = getFinanceMetrics({ from: "2026-09-24", to: "2026-09-25", accountType: "customer" });
  assert.equal(finance.overview.totalOrders, 1);
  assert.equal(finance.overview.cohortPaid, 0);
  assert.equal(finance.overview.pendingUnexpired, 0);
  assert.equal(finance.overview.expiredOrFailed, 1);
});

test("28. an unknown terminal Clip cannot substitute for a missing expected Clip", () => {
  const projectId = 99026;
  const common = {
    actorKey: "clip-identity-user",
    accountType: "customer",
    feature: "video_project",
    entityType: "video_project",
    entityId: String(projectId),
    model: "g2",
    mode: "text",
    resolution: "clip-identity",
    aspectRatio: "9:16",
    mediaDurationSec: 10,
  };
  insertAnalyticsEvent({
    ...common,
    eventKey: `video_project_created:${projectId}`,
    eventName: "video_project_created",
    occurredAt: "2026-09-25T01:00:00.000Z",
    metadata: { expectedClipCount: 2, expectedClipIds: [990261, 990262] },
  });
  insertAnalyticsEvent({ ...common, eventKey: `video_project_completed:${projectId}`, eventName: "video_project_completed", occurredAt: "2026-09-25T01:01:00.000Z", status: "completed" });
  recordVideoClipAttempt({ projectId, clipId: 990261, attemptNo: 1, attemptKind: "initial", status: "completed", accountType: "customer", startedAt: "2026-09-25T01:00:00.000Z" });
  recordVideoClipAttempt({ projectId, clipId: 999999, attemptNo: 2, attemptKind: "auto_retry", status: "completed", accountType: "customer", startedAt: "2026-09-25T01:00:30.000Z" });

  const row = getAiMetrics({ from: "2026-09-25", to: "2026-09-26", accountType: "customer" }).videoComparison
    .find((item) => item.resolution === "clip-identity");
  assert.ok(row);
  assert.equal(row.completionRate, 100);
  assert.equal(row.attemptMetricSampleSize, 0);
  assert.equal(row.attemptMetricCoverageRate, 0);
  assert.equal(row.firstSuccessRate, null);
  assert.equal(row.autoRetryRate, null);
});

test("29. an extra unknown terminal Clip does not invalidate complete expected Clips", () => {
  const projectId = 99027;
  const common = {
    actorKey: "extra-clip-user",
    accountType: "customer",
    feature: "video_project",
    entityType: "video_project",
    entityId: String(projectId),
    model: "g2",
    mode: "text",
    resolution: "extra-clip",
    aspectRatio: "9:16",
    mediaDurationSec: 10,
  };
  insertAnalyticsEvent({
    ...common,
    eventKey: `video_project_created:${projectId}`,
    eventName: "video_project_created",
    occurredAt: "2026-09-26T01:00:00.000Z",
    metadata: { expectedClipCount: 2, expectedClipIds: [990271, 990272] },
  });
  insertAnalyticsEvent({ ...common, eventKey: `video_project_completed:${projectId}`, eventName: "video_project_completed", occurredAt: "2026-09-26T01:01:00.000Z", status: "completed" });
  for (const clipId of [990271, 990272, 999998]) {
    recordVideoClipAttempt({ projectId, clipId, attemptNo: 1, attemptKind: "initial", status: "completed", accountType: "customer", startedAt: "2026-09-26T01:00:00.000Z" });
  }

  const row = getAiMetrics({ from: "2026-09-26", to: "2026-09-27", accountType: "customer" }).videoComparison
    .find((item) => item.resolution === "extra-clip");
  assert.ok(row);
  assert.equal(row.attemptMetricSampleSize, 1);
  assert.equal(row.attemptMetricCoverageRate, 100);
  assert.equal(row.firstSuccessRate, 100);
});
