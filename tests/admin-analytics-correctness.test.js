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
const { recordVideoClipAttempt, recordImageTaskAttempt } = require("../src/server/analytics/ai-attempt-recorder");

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
