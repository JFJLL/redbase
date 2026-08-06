const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const fs = require("node:fs");
const path = require("node:path");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const {
  upsertImageJob,
  findImageJobByOwner,
} = require("../../src/server/db/repositories/image-job-repository");
const {
  insertCreditEvent,
  findRefundForCreditEvent,
} = require("../../src/server/db/repositories/admin-repository");
const { findGenerationById, listGenerationsByOwner, upsertGeneration } = require("../../src/server/db/repositories/generation-repository");
const { findTrendItem } = require("../../src/server/api/domain-utils");
const { handleImageGenerationRoutes } = require("../../src/server/api/image-generation-routes");
const { handleHistoryRoutes } = require("../../src/server/api/history-routes");
const { createLocalGeneratedAssetStorage } = require("../../src/server/assets/local-generated-asset-storage");
const imageStore = require("../../src/server/assets/image-store");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Recovery Tester",
  phone: "13910000006",
  password: "hash",
  accountType: "customer",
  credits: 50,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertUser({
  id: 2,
  name: "Other Recovery Tester",
  phone: "13910000007",
  password: "hash",
  accountType: "customer",
  credits: 50,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "recovery-token", userId: 1, createdAt: "2026-08-01T00:00:00.000Z" });
insertSession({ token: "other-token", userId: 2, createdAt: "2026-08-01T00:00:00.000Z" });

insertBrand({
  id: 10,
  ownerUserId: 1,
  name: "Recovery Brand",
  industry: "母婴",
  audience: "新手妈妈",
  description: "恢复测试品牌",
  product: "测试产品",
  goal: "测试目标",
  knowledgeBase: "测试资料库",
  logo: null,
  assetTags: [],
});

upsertBrandFull({
  id: 10,
  ownerUserId: 1,
  name: "Recovery Brand",
  industry: "母婴",
  audience: "新手妈妈",
  description: "恢复测试品牌",
  product: "测试产品",
  goal: "测试目标",
  knowledgeBase: "测试资料库",
  logo: null,
  assetTags: [],
  analyses: [
    {
      id: 9001,
      name: "恢复分析",
      timestamp: "2026-08-01T00:00:00.000Z",
      brandBrief: {},
      trendSnapshot: [],
    },
  ],
  trends: [
    {
      key: "global",
      title: "全网热点指数",
      description: "测试维度",
      items: [
        {
          id: 100,
          stableKey: "recovery-trend",
          rank: 1,
          title: "恢复测试趋势",
          category: "测试",
          summary: "测试摘要",
          score: 90,
          reason: "测试原因",
          ideas: [{ title: "恢复选题", summary: "摘要", angle: "角度", brandFit: "结合", audience: "人群", hook: "钩子" }],
        },
      ],
    },
  ],
});

function createReq(url, cookie = "") {
  return {
    method: "GET",
    url,
    headers: { host: "localhost:3013", cookie },
  };
}

function createRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = JSON.parse(data);
    },
  };
}

function createRawRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || null;
    },
    end(data) {
      this.body = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "utf8");
    },
  };
}

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `job_${Math.random().toString(16).slice(2, 10)}`,
    ownerUserId: 1,
    status: "pending",
    provider: "wavespeed",
    providerMode: "text-to-image",
    providerResultUrl: "https://provider.example.com/result/secret-token-url",
    model: "test-model",
    metadata: {
      providerTaskId: "upstream-secret-task",
      prompt: "产品图提示词",
      title: "朋友圈标题",
      pageLabel: "第 1 张",
      copy: "文案",
      visualDirection: "视觉方向",
      style: "风格",
      composition: "构图",
      aspectRatio: "3:4",
      slideIndex: 0,
    },
    generationContext: {
      type: "moments",
      channelLabel: "朋友圈图",
      userId: 1,
      brandId: 10,
      trendId: 100,
      ideaIndex: 0,
      creditEventId: null,
      aspectRatio: "3:4",
    },
    imageUrl: "",
    error: "",
    generationId: null,
    createdAt: now,
    evaluationStartedAt: now,
    evaluationRunId: "",
    ...overrides,
  };
}

function buildImageJobResponse(job) {
  return {
    jobId: job.id,
    status: job.status,
    error: job.error || "",
    imageConcept: job.status === "completed" ? { imageUrl: job.imageUrl, previewUrl: job.imageUrl, title: job.metadata?.title || "" } : null,
  };
}

function makeContext(overrides = {}) {
  return {
    appConfig: { security: { assetSigningSecret: "test-secret" }, imageProvider: { provider: "wavespeed" } },
    imageJobs: new Map(),
    resolveImageJob: async (job) => job,
    buildImageJobResponse,
    persistGenerationImages: async () => {},
    generatedAssetStorage: {
      stageDeleteMany: async () => ({ commit: async () => {}, rollback: async () => {} }),
    },
    findTrendItem,
    ...overrides,
  };
}

test("GET /api/image-jobs/active rejects unauthenticated requests", async () => {
  const res = createRes();
  const handled = await handleImageGenerationRoutes(makeContext(), createReq("/api/image-jobs/active"), res, "/api/image-jobs/active");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test("GET /api/image-jobs/active returns only the current user's pending/running jobs with a safe recovery snapshot", async () => {
  upsertImageJob(1, makeJob({ id: "active-moments-1", status: "pending" }));
  upsertImageJob(1, makeJob({ id: "active-running-1", status: "running" }));
  upsertImageJob(1, makeJob({ id: "active-done-1", status: "completed", imageUrl: "https://cdn.example.com/1.png" }));
  upsertImageJob(1, makeJob({ id: "active-fail-1", status: "failed", error: "timeout" }));
  upsertImageJob(2, makeJob({ id: "active-other-1", status: "pending", ownerUserId: 2, generationContext: { type: "moments", userId: 2, brandId: 10, trendId: 100, ideaIndex: 0 } }));

  const res = createRes();
  const handled = await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
    res,
    "/api/image-jobs/active",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);

  const ids = res.body.jobs.map((job) => job.jobId);
  assert.deepEqual(new Set(ids), new Set(["active-moments-1", "active-running-1"]));
  assert.equal(ids.includes("active-other-1"), false, "other user's jobs must never leak");
  assert.equal(ids.includes("active-done-1"), false, "terminal jobs are not recoverable work");
  assert.equal(ids.includes("active-fail-1"), false);

  const snapshot = res.body.jobs.find((job) => job.jobId === "active-moments-1");
  assert.equal(snapshot.type, "moments");
  assert.equal(snapshot.brandId, 10);
  assert.equal(snapshot.trendId, 100);
  assert.equal(snapshot.ideaIndex, 0);
  assert.equal(snapshot.aspectRatio, "3:4");
  assert.equal("providerResultUrl" in snapshot, false, "provider result URL must never be exposed");
  assert.equal("provider" in snapshot, false);
  assert.equal("model" in snapshot, false);
  assert.equal("metadata" in snapshot, false);
  assert.equal(snapshot.slide.pageLabel, "第 1 张", "slide metadata needed to rebuild a carousel pack is exposed");
  assert.equal(snapshot.slide.prompt, "产品图提示词");
});

test("GET /api/image-jobs/active includes carousel group context for pack rebuild", async () => {
  upsertImageJob(
    1,
    makeJob({
      id: "active-slide-0",
      status: "pending",
      generationContext: {
        type: "xhsCarouselSlide",
        singleSlideOnly: true,
        userId: 1,
        brandId: 10,
        trendId: 100,
        ideaIndex: 0,
        slideIndex: 0,
        carouselGroupId: "group-recovery-1",
        carouselTitle: "组图标题",
        publishTitle: "发布标题",
        publishCaption: "发布文案",
        caption: "文案",
        creditEventId: 7001,
        aspectRatio: "3:4",
      },
    }),
  );
  const res = createRes();
  await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
    res,
    "/api/image-jobs/active",
  );
  const snapshot = res.body.jobs.find((job) => job.jobId === "active-slide-0");
  assert.equal(snapshot.type, "xhsCarouselSlide");
  assert.equal(snapshot.carouselGroupId, "group-recovery-1");
  assert.equal(snapshot.slideIndex, 0);
  assert.equal(snapshot.creditEventId, 7001);
  assert.equal(snapshot.carouselTitle, "组图标题");
  assert.equal("imageUrl" in snapshot.slide, false, "pending slides expose no image URL");
  assert.equal(snapshot.slide.slideIndex, 0);
});

test("GET /api/image-jobs/active includes failed jobs that were never refunded", async () => {
  insertCreditEvent({
    id: 9002,
    userId: 1,
    actionType: "momentsImage",
    actionLabel: "朋友圈图生成",
    creditDelta: -1,
    creditCost: 1,
    brandId: 10,
    brandName: "Recovery Brand",
    trendId: 100,
    trendTitle: "恢复测试趋势",
    ideaTitle: "恢复选题",
    generationId: null,
    channelLabel: "朋友圈图",
    summary: "朋友圈图生成",
    payload: {},
  });
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd40e0",
      status: "failed",
      error: "timeout",
      generationContext: { type: "moments", channelLabel: "朋友圈图", userId: 1, brandId: 10, trendId: 100, ideaIndex: 0, creditEventId: 9002, aspectRatio: "3:4" },
    }),
  );
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd40e1",
      status: "failed",
      error: "timeout",
      generationContext: { type: "moments", channelLabel: "朋友圈图", userId: 1, brandId: 10, trendId: 100, ideaIndex: 0, creditEventId: null, aspectRatio: "3:4" },
    }),
  );

  const res = createRes();
  await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
    res,
    "/api/image-jobs/active",
  );
  const ids = new Set(res.body.jobs.map((job) => job.jobId));
  assert.equal(ids.has("ab12cd40e0"), true, "failed-but-unrefunded charged jobs must be recoverable");
  assert.equal(ids.has("ab12cd40e1"), false, "failed jobs without a charge are not recoverable work");

  // 轮询该失败任务：恰好退款一次，并回写 refundCreditEventId。
  const pollRes = createRes();
  await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/ab12cd40e0", "redbase_session=recovery-token"),
    pollRes,
    "/api/image-jobs/ab12cd40e0",
  );
  assert.equal(pollRes.statusCode, 200);
  assert.ok(pollRes.body.user, "failed poll must return refunded user");
  const job = findImageJobByOwner("ab12cd40e0", 1);
  assert.ok(job.generationContext.refundCreditEventId, "refund marker persisted on the job");
  const { getDbProxy } = require("../../src/server/db/connection");
  const refunds = getDbProxy()
    .prepare("SELECT id FROM credit_events WHERE user_id = ? AND CAST(json_extract(payload_json, '$.refundForCreditEventId') AS INTEGER) = ?")
    .all(1, 9002);
  assert.equal(refunds.length, 1);

  // 退款后不再进入 active 列表。
  const secondRes = createRes();
  await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
    secondRes,
    "/api/image-jobs/active",
  );
  assert.equal(secondRes.body.jobs.some((snapshot) => snapshot.jobId === "ab12cd40e0"), false);
});

test("GET /api/image-jobs/active backfills terminal members of active carousel groups", async () => {
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd42e0",
      status: "running",
      generationContext: {
        type: "xhsCarouselSlide",
        singleSlideOnly: true,
        userId: 1,
        brandId: 10,
        trendId: 100,
        ideaIndex: 0,
        slideIndex: 1,
        carouselGroupId: "g-backfill",
        creditEventId: 9101,
        aspectRatio: "3:4",
      },
    }),
  );
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd42e1",
      status: "completed",
      imageUrl: "https://cdn.example.com/backfill-0.png",
      generationContext: {
        type: "xhsCarouselSlide",
        singleSlideOnly: true,
        userId: 1,
        brandId: 10,
        trendId: 100,
        ideaIndex: 0,
        slideIndex: 0,
        carouselGroupId: "g-backfill",
        creditEventId: 9101,
        aspectRatio: "3:4",
      },
    }),
  );

  const res = createRes();
  await handleImageGenerationRoutes(
    makeContext(),
    createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
    res,
    "/api/image-jobs/active",
  );
  const byId = new Map(res.body.jobs.map((job) => [job.jobId, job]));
  assert.equal(byId.has("ab12cd42e0"), true);
  assert.equal(byId.has("ab12cd42e1"), true, "terminal group member must be backfilled");
  assert.equal(byId.get("ab12cd42e1").status, "completed");
  assert.equal(byId.get("ab12cd42e1").slide.imageUrl, "https://cdn.example.com/backfill-0.png");
});

test("active signs local generated-image URLs of terminal group members; external CDN URLs stay untouched; signed resource 200 / unsigned 401", async () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const tmpRoot = path.resolve(__dirname, "..", "..", "outputs", `recovery-signing-${process.pid}`);
  const storedPath = path.join("uploads", "generated-images", "users", "1", "2026", "08", "8801", "gi_8801_0.png");
  const absoluteStored = path.join(tmpRoot, storedPath);
  fs.mkdirSync(path.dirname(absoluteStored), { recursive: true });
  fs.writeFileSync(absoluteStored, pngBytes);
  try {
    upsertGeneration({
      id: 8801,
      ownerUserId: 1,
      type: "xhsCarousel",
      channelLabel: "小红书组图",
      brandId: 10,
      brandName: "Recovery Brand",
      trendId: 100,
      trendTitle: "恢复测试趋势",
      ideaTitle: "恢复选题",
      cardTitle: "签名组图",
      createdAt: "2026-08-05T00:00:00.000Z",
      previewUrl: "/api/generated-images/8801/slides/0/file",
      summary: "签名组图",
      payload: {
        carouselGroupId: "g-sign",
        generatedMode: "partialSlides",
        slides: [{ sourceSlideIndex: 0, pageLabel: "第 1 张", localImage: { storedPath, mimeType: "image/png" } }],
        editHistory: [],
      },
    });
    upsertImageJob(
      1,
      makeJob({
        id: "ab12cd43e0",
        status: "running",
        generationContext: {
          type: "xhsCarouselSlide",
          singleSlideOnly: true,
          userId: 1,
          brandId: 10,
          trendId: 100,
          ideaIndex: 0,
          slideIndex: 2,
          carouselGroupId: "g-sign",
          creditEventId: 9101,
          aspectRatio: "3:4",
        },
      }),
    );
    upsertImageJob(
      1,
      makeJob({
        id: "ab12cd43e1",
        status: "completed",
        imageUrl: "/api/generated-images/8801/slides/0/file",
        generationContext: {
          type: "xhsCarouselSlide",
          singleSlideOnly: true,
          userId: 1,
          brandId: 10,
          trendId: 100,
          ideaIndex: 0,
          slideIndex: 0,
          carouselGroupId: "g-sign",
          creditEventId: 9101,
          aspectRatio: "3:4",
        },
      }),
    );
    upsertImageJob(
      1,
      makeJob({
        id: "ab12cd43e2",
        status: "completed",
        imageUrl: "https://cdn.example.com/sign-cdn.png",
        generationContext: {
          type: "xhsCarouselSlide",
          singleSlideOnly: true,
          userId: 1,
          brandId: 10,
          trendId: 100,
          ideaIndex: 0,
          slideIndex: 1,
          carouselGroupId: "g-sign",
          creditEventId: 9101,
          aspectRatio: "3:4",
        },
      }),
    );

    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq("/api/image-jobs/active", "redbase_session=recovery-token"),
      res,
      "/api/image-jobs/active",
    );
    assert.equal(res.statusCode, 200);
    const byId = new Map(res.body.jobs.map((job) => [job.jobId, job]));
    const local = byId.get("ab12cd43e1");
    assert.ok(local, "completed local member must be backfilled into the active payload");
    const localUrl = local.slide.imageUrl;
    assert.match(
      localUrl,
      /^\/api\/generated-images\/8801\/slides\/0\/file\?assetExpires=\d+&assetSignature=[A-Za-z0-9_-]+$/,
      "local generated-image URL in the recovery payload must be signed with assetExpires/assetSignature",
    );
    assert.equal(local.slide.previewUrl, localUrl, "previewUrl must use the same signed URL");
    assert.equal("providerResultUrl" in local, false, "provider result URL must never be exposed");
    assert.equal("provider" in local, false);
    assert.equal("model" in local, false);
    assert.equal("metadata" in local, false);

    const cdn = byId.get("ab12cd43e2");
    assert.equal(cdn.slide.imageUrl, "https://cdn.example.com/sign-cdn.png", "external CDN URL must never be rewritten");
    assert.equal(cdn.slide.imageUrl.includes("assetExpires"), false, "external CDN URL must not be signed");

    const assetStorage = createLocalGeneratedAssetStorage({ dataDir: tmpRoot });
    const resourceContext = {
      appConfig: { security: { assetSigningSecret: "test-secret" } },
      generatedAssetStorage: assetStorage,
      // 与 src/server/api.js 生产接线一致：路由内 serveStoredGeneratedImage(res, asset, generation)
      // 必须由上层注入 assetStorage，否则 storage 参数会错位为 generation 对象。
      serveStoredGeneratedImage: (res, asset, generation) =>
        imageStore.serveStoredGeneratedImage(res, asset, assetStorage, generation),
    };
    const unsignedRes = createRawRes();
    await handleHistoryRoutes(
      resourceContext,
      createReq("/api/generated-images/8801/slides/0/file"),
      unsignedRes,
      "/api/generated-images/8801/slides/0/file",
    );
    assert.equal(unsignedRes.statusCode, 401, "unsigned local generated-image request must keep returning 401");

    const signedRes = createRawRes();
    await handleHistoryRoutes(
      resourceContext,
      createReq(localUrl),
      signedRes,
      "/api/generated-images/8801/slides/0/file",
    );
    assert.equal(signedRes.statusCode, 200, "signed local generated-image request must return the real image");
    assert.equal(signedRes.headers["Content-Type"], "image/png");
    assert.deepEqual(signedRes.body, pngBytes, "served bytes must be the stored local image");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("two tabs concurrently polling the same completed job write history exactly once and link the charged credit event", async () => {
  insertCreditEvent({
    id: 9301,
    userId: 1,
    actionType: "momentsImage",
    actionLabel: "朋友圈图生成",
    creditDelta: -1,
    creditCost: 1,
    brandId: 10,
    brandName: "Recovery Brand",
    trendId: 100,
    trendTitle: "恢复测试趋势",
    ideaTitle: "恢复选题",
    generationId: null,
    channelLabel: "朋友圈图",
    summary: "朋友圈图生成",
    payload: {},
  });
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd34ef",
      status: "completed",
      imageUrl: "https://cdn.example.com/poll-once.png",
      generationContext: { type: "moments", channelLabel: "朋友圈图", userId: 1, brandId: 10, trendId: 100, ideaIndex: 0, creditEventId: 9301, aspectRatio: "3:4" },
    }),
  );

  async function pollAsTab() {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq("/api/image-jobs/ab12cd34ef", "redbase_session=recovery-token"),
      res,
      "/api/image-jobs/ab12cd34ef",
    );
    return res;
  }

  const [first, second] = await Promise.all([pollAsTab(), pollAsTab()]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.generationId, second.body.generationId);
  assert.ok(first.body.generationId > 0);

  const rows = listGenerationsByOwner(1);
  const matches = rows.filter((row) => row.payload?.imageUrl === "https://cdn.example.com/poll-once.png" || row.previewUrl === "https://cdn.example.com/poll-once.png");
  assert.equal(matches.length, 1, "history must be written exactly once across two tab polls");

  const job = findImageJobByOwner("ab12cd34ef", 1);
  assert.equal(job.generationId, first.body.generationId, "job generation link is persisted");
  const { getDbProxy } = require("../../src/server/db/connection");
  const linked = getDbProxy()
    .prepare("SELECT generation_id AS generationId, json_extract(payload_json, '$.generationPayload.imageUrl') AS payloadImageUrl FROM credit_events WHERE id = ? AND user_id = ?")
    .get(9301, 1);
  assert.equal(linked.generationId, first.body.generationId, "credit event must link to the persisted generation");
  assert.equal(linked.payloadImageUrl, "https://cdn.example.com/poll-once.png", "credit event payload must carry the persisted generation payload");
});

test("a failed job is refunded exactly once across concurrent polls from two tabs", async () => {
  const creditEvent = insertCreditEvent({
    id: 9001,
    userId: 1,
    actionType: "momentsImage",
    actionLabel: "朋友圈图生成",
    creditDelta: -1,
    creditCost: 1,
    brandId: 10,
    brandName: "Recovery Brand",
    trendId: 100,
    trendTitle: "恢复测试趋势",
    ideaTitle: "恢复选题",
    generationId: null,
    channelLabel: "朋友圈图",
    summary: "朋友圈图生成",
    payload: {},
  });
  assert.equal(creditEvent.creditDelta, -1);
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd34f0",
      status: "failed",
      error: "图片生成失败",
      generationContext: { type: "moments", channelLabel: "朋友圈图", userId: 1, brandId: 10, trendId: 100, ideaIndex: 0, creditEventId: 9001, aspectRatio: "3:4" },
    }),
  );

  async function pollAsTab() {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq("/api/image-jobs/ab12cd34f0", "redbase_session=recovery-token"),
      res,
      "/api/image-jobs/ab12cd34f0",
    );
    return res;
  }

  const { getDbProxy } = require("../../src/server/db/connection");
  const creditsBefore = getDbProxy().prepare("SELECT credits FROM users WHERE id = ?").get(1).credits;
  const responses = await Promise.all([pollAsTab(), pollAsTab(), pollAsTab(), pollAsTab()]);
  const first = responses[0];
  assert.equal(first.body.status, "failed");
  for (const res of responses) {
    assert.equal(res.statusCode, 200, "concurrent failed polls must never return 500");
    assert.ok(res.body.user, "failed poll must return the updated user with refunded credits");
    assert.equal(res.body.user.credits, creditsBefore + 1, "credits must be restored exactly once");
  }

  const refund = findRefundForCreditEvent(9001, 1);
  assert.ok(refund, "refund event must exist");
  const job = findImageJobByOwner("ab12cd34f0", 1);
  assert.equal(job.generationContext.refundCreditEventId, refund.id, "job-level refund marker is persisted");

  const allRefunds = [];
  allRefunds.push(
    ...getDbProxy()
      .prepare("SELECT id FROM credit_events WHERE user_id = ? AND CAST(json_extract(payload_json, '$.refundForCreditEventId') AS INTEGER) = ?")
      .all(1, 9001),
  );
  assert.equal(allRefunds.length, 1, "refund must happen exactly once across concurrent polls");
  assert.equal(getDbProxy().prepare("SELECT credits FROM users WHERE id = ?").get(1).credits, creditsBefore + 1, "user credits must be restored once and only once");
});

function seedCompletedSlideJobs(groupId) {
  for (let index = 0; index < 4; index += 1) {
    upsertImageJob(
      1,
      makeJob({
        id: `ab12cd35e${index}`,
        status: "completed",
        imageUrl: `https://cdn.example.com/${groupId}-${index}.png`,
        metadata: {
          title: `组图 ${index}`,
          pageLabel: `第 ${index + 1} 张`,
          prompt: `提示词 ${index}`,
          copy: `文案 ${index}`,
          aspectRatio: "3:4",
          slideIndex: index,
        },
        generationContext: {
          type: "xhsCarouselSlide",
          singleSlideOnly: true,
          userId: 1,
          brandId: 10,
          trendId: 100,
          ideaIndex: 0,
          slideIndex: index,
          carouselGroupId: groupId,
          carouselTitle: `组图 ${groupId}`,
          publishTitle: `发布 ${groupId}`,
          publishCaption: `文案 ${groupId}`,
          caption: `文案 ${groupId}`,
          creditEventId: null,
          aspectRatio: "3:4",
        },
      }),
    );
  }
}

test("two tabs completing the same recovered carousel group produce exactly one history row", async () => {
  const groupId = "group-concurrent-complete";
  seedCompletedSlideJobs(groupId);

  async function completeAsTab() {
    const carouselPack = {
      title: `组图 ${groupId}`,
      publishTitle: `发布 ${groupId}`,
      publishCaption: `文案 ${groupId}`,
      caption: `文案 ${groupId}`,
      aspectRatio: "3:4",
      carouselGroupId: groupId,
      slides: [0, 1, 2, 3].map((index) => ({
        title: `组图 ${index}`,
        pageLabel: `第 ${index + 1} 张`,
        prompt: `提示词 ${index}`,
        copy: `文案 ${index}`,
        imageUrl: `https://cdn.example.com/${groupId}-${index}.png`,
        previewUrl: `https://cdn.example.com/${groupId}-${index}.png`,
      })),
    };
    const raw = Buffer.from(JSON.stringify({ carouselPack, creditEventId: null }), "utf8");
    const req = Readable.from([raw]);
    req.method = "POST";
    req.url = `/api/brands/10/trends/100/ideas/0/xhs-carousel/complete`;
    req.headers = {
      host: "localhost:3013",
      cookie: "redbase_session=recovery-token",
      "content-type": "application/json",
      "content-length": String(raw.length),
    };
    const res = createRes();
    await handleImageGenerationRoutes(makeContext(), req, res, `/api/brands/10/trends/100/ideas/0/xhs-carousel/complete`);
    return res;
  }

  const [first, second] = await Promise.all([completeAsTab(), completeAsTab()]);
  assert.equal(first.statusCode, 200, first.body?.error || "first tab must succeed");
  assert.equal(second.statusCode, 200, second.body?.error || "second tab must succeed");
  assert.equal(first.body.generation.id, second.body.generation.id, "both tabs resolve to the same generation");

  const rows = listGenerationsByOwner(1).filter((row) => row.type === "xhsCarousel" && row.payload?.carouselGroupId === groupId);
  assert.equal(rows.length, 1, "concurrent completes must produce exactly one history row");
});

test("two tabs polling the same completed carousel slide persist one shared group generation", async () => {
  const groupId = "group-concurrent-poll";
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd36e0",
      status: "completed",
      imageUrl: "https://cdn.example.com/concurrent-poll.png",
      metadata: { title: "单页", pageLabel: "第 1 张", prompt: "p", copy: "c", slideIndex: 0, aspectRatio: "3:4" },
      generationContext: {
        type: "xhsCarouselSlide",
        singleSlideOnly: true,
        userId: 1,
        brandId: 10,
        trendId: 100,
        ideaIndex: 0,
        slideIndex: 0,
        carouselGroupId: groupId,
        creditEventId: null,
        aspectRatio: "3:4",
      },
    }),
  );

  async function pollAsTab() {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq("/api/image-jobs/ab12cd36e0", "redbase_session=recovery-token"),
      res,
      "/api/image-jobs/ab12cd36e0",
    );
    return res;
  }

  await Promise.all([pollAsTab(), pollAsTab()]);
  const rows = listGenerationsByOwner(1).filter((row) => row.type === "xhsCarousel" && row.payload?.carouselGroupId === groupId);
  assert.equal(rows.length, 1, "concurrent slide polls must share one group history row");
  const job = findImageJobByOwner("ab12cd36e0", 1);
  assert.equal(job.generationId, rows[0].id);
});

test("two tabs first-polling the same completed single image write history exactly once", async () => {
  insertCreditEvent({
    id: 9302,
    userId: 1,
    actionType: "momentsImage",
    actionLabel: "朋友圈图生成",
    creditDelta: -1,
    creditCost: 1,
    brandId: 10,
    brandName: "Recovery Brand",
    trendId: 100,
    trendTitle: "恢复测试趋势",
    ideaTitle: "恢复选题",
    generationId: null,
    channelLabel: "朋友圈图",
    summary: "朋友圈图生成",
    payload: {},
  });
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd37e0",
      status: "completed",
      imageUrl: "https://cdn.example.com/single-concurrent.png",
      generationContext: { type: "moments", channelLabel: "朋友圈图", userId: 1, brandId: 10, trendId: 100, ideaIndex: 0, creditEventId: 9302, aspectRatio: "3:4" },
    }),
  );

  async function pollAsTab() {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq("/api/image-jobs/ab12cd37e0", "redbase_session=recovery-token"),
      res,
      "/api/image-jobs/ab12cd37e0",
    );
    return res;
  }

  const [first, second] = await Promise.all([pollAsTab(), pollAsTab()]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.generationId, second.body.generationId, "both tabs resolve to the same generation");
  const rows = listGenerationsByOwner(1).filter((row) => row.type === "moments" && row.previewUrl === "https://cdn.example.com/single-concurrent.png");
  assert.equal(rows.length, 1, "concurrent first polls must not duplicate single-image history");
  const { getDbProxy } = require("../../src/server/db/connection");
  const linked = getDbProxy().prepare("SELECT generation_id AS generationId FROM credit_events WHERE id = ? AND user_id = ?").get(9302, 1);
  assert.equal(linked.generationId, rows[0].id, "credit event must link to the single persisted generation, not a duplicate");
});

test("legacy bulk carousel slide jobs without a group id still persist grouped history on poll", async () => {
  for (let index = 0; index < 2; index += 1) {
    upsertImageJob(
      1,
      makeJob({
        id: `ab12cd39e${index}`,
        status: "completed",
        imageUrl: `https://cdn.example.com/legacy-${index}.png`,
        metadata: { title: `旧版 ${index}`, pageLabel: `第 ${index + 1} 张`, prompt: `p${index}`, slideIndex: index, aspectRatio: "3:4" },
        generationContext: {
          type: "xhsCarouselSlide",
          userId: 1,
          brandId: 10,
          trendId: 100,
          ideaIndex: 0,
          slideIndex: index,
          creditEventId: 9100,
          aspectRatio: "3:4",
        },
      }),
    );
  }

  async function pollAsTab(index) {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq(`/api/image-jobs/ab12cd39e${index}`, "redbase_session=recovery-token"),
      res,
      `/api/image-jobs/ab12cd39e${index}`,
    );
    return res;
  }

  await pollAsTab(0);
  await pollAsTab(1);

  const rows = listGenerationsByOwner(1).filter((row) => row.type === "xhsCarousel" && row.payload?.carouselGroupId === "legacy-9100");
  assert.equal(rows.length, 1, "legacy jobs share one grouped history row keyed by creditEventId");
  const filled = rows[0].payload.slides.filter((slide) => Boolean(String(slide.imageUrl || slide.previewUrl || "").trim()));
  assert.equal(filled.length, 2, "both legacy slides are persisted into the shared group row");
});

test("concurrent edit-append and slide-merge on the same carousel group row keep both writes", async () => {
  const { upsertGeneration } = require("../../src/server/db/repositories/generation-repository");
  upsertGeneration({
    id: 8801,
    ownerUserId: 1,
    type: "xhsCarousel",
    channelLabel: "小红书组图",
    brandId: 10,
    brandName: "Recovery Brand",
    trendId: 100,
    trendTitle: "恢复测试趋势",
    ideaTitle: "恢复选题",
    cardTitle: "锁并发组图",
    createdAt: "2026-08-05T00:00:00.000Z",
    previewUrl: "https://cdn.example.com/lock-0.png",
    summary: "锁并发组图",
    payload: {
      carouselGroupId: "g-lock-race",
      generatedMode: "partialSlides",
      slides: [
        {
          sourceSlideIndex: 0,
          pageLabel: "第 1 张",
          imageUrl: "https://cdn.example.com/lock-0.png",
          previewUrl: "https://cdn.example.com/lock-0.png",
        },
      ],
      editHistory: [],
    },
  });
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd41e0",
      status: "completed",
      imageUrl: "https://cdn.example.com/lock-edit.png",
      generationContext: {
        type: "imageEdit",
        channelLabel: "改图",
        userId: 1,
        creditEventId: null,
        sourceGenerationId: 8801,
        sourceImageUrl: "https://cdn.example.com/lock-0.png",
        editPrompt: "并发改图",
        aspectRatio: "3:4",
      },
    }),
  );
  upsertImageJob(
    1,
    makeJob({
      id: "ab12cd41e1",
      status: "completed",
      imageUrl: "https://cdn.example.com/lock-1.png",
      metadata: { title: "第二页", pageLabel: "第 2 张", prompt: "p1", slideIndex: 1, aspectRatio: "3:4" },
      generationContext: {
        type: "xhsCarouselSlide",
        singleSlideOnly: true,
        userId: 1,
        brandId: 10,
        trendId: 100,
        ideaIndex: 0,
        slideIndex: 1,
        carouselGroupId: "g-lock-race",
        creditEventId: null,
        aspectRatio: "3:4",
      },
    }),
  );

  async function pollAsTab(jobId) {
    const res = createRes();
    await handleImageGenerationRoutes(
      makeContext(),
      createReq(`/api/image-jobs/${jobId}`, "redbase_session=recovery-token"),
      res,
      `/api/image-jobs/${jobId}`,
    );
    return res;
  }

  await Promise.all([pollAsTab("ab12cd41e0"), pollAsTab("ab12cd41e1")]);

  const row = listGenerationsByOwner(1).find((generation) => generation.id === 8801);
  assert.ok(row, "seeded group row must still exist");
  assert.equal(Array.isArray(row.payload.editHistory) ? row.payload.editHistory.length : 0, 1, "edit entry preserved");
  const filled = row.payload.slides.filter((slide) => Boolean(String(slide.imageUrl || slide.previewUrl || "").trim()));
  assert.equal(filled.length, 2, "merged slide preserved alongside the edit entry");
});
