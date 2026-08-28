const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { findImageJobByOwner, upsertImageJob } = require("../../src/server/db/repositories/image-job-repository");
const { listGenerationsByOwner } = require("../../src/server/db/repositories/generation-repository");
const { findTrendItem } = require("../../src/server/api/domain-utils");
const { handleImageGenerationRoutes } = require("../../src/server/api/image-generation-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 101,
  name: "Bg Tester",
  phone: "13910000101",
  password: "hash",
  accountType: "customer",
  credits: 50,
  createdAt: "2026-08-01T00:00:00.000Z",
});
insertSession({ token: "bg-token", userId: 101, createdAt: "2026-08-01T00:00:00.000Z" });

insertBrand({
  id: 201,
  ownerUserId: 101,
  name: "Bg Brand",
  industry: "科技",
  audience: "极客",
  description: "后台生图测试品牌",
  product: "AI工作站",
  goal: "提升效率",
  knowledgeBase: "测试资料库",
  logo: null,
  assetTags: [],
});

upsertBrandFull({
  id: 201,
  ownerUserId: 101,
  name: "Bg Brand",
  industry: "科技",
  audience: "极客",
  description: "后台生图测试品牌",
  product: "AI工作站",
  goal: "提升效率",
  knowledgeBase: "测试资料库",
  logo: null,
  assetTags: [],
  analyses: [],
  trends: [
    {
      key: "global",
      title: "全网热点",
      description: "维度",
      items: [
        {
          id: 301,
          stableKey: "bg-trend",
          rank: 1,
          title: "AI趋势",
          category: "科技",
          summary: "AI大模型趋势",
          score: 95,
          reason: "火爆",
          ideas: [
            {
              title: "AI选题1",
              summary: "选题摘要",
              angle: "角度",
              brandFit: "结合",
              audience: "人群",
              hook: "钩子",
              contentAssets: {
                moments: {
                  title: "AI选题1配图",
                  caption: "这是朋友圈文案",
                  visualDirection: "极简科技风",
                },
                xhsCarousel: {
                  title: "AI选题1组图",
                  publishTitle: "组图发布标题",
                  publishCaption: "组图发布文案",
                  caption: "组图说明",
                  slides: [0, 1, 2, 3].map((i) => ({
                    pageLabel: `第 ${i + 1} 张`,
                    title: `分镜 ${i + 1}`,
                    copy: `文案 ${i + 1}`,
                    prompt: `提示词 ${i + 1}`,
                    visualDirection: `视觉 ${i + 1}`,
                  })),
                },
                wechatLongImage: {
                  title: "AI选题1长图",
                  publishTitle: "公众号发布标题",
                  intro: "公众号导语",
                  positioning: "长图定位",
                  cta: "行动号召",
                  outline: ["大纲1", "大纲2"],
                  visualDirection: "长图视觉",
                },
              },
            },
          ],
        },
      ],
    },
  ],
});

function createReq(method, url, body = null, cookie = "redbase_session=bg-token") {
  const req = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie,
    ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}),
  };
  return req;
}

function createRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

function makeContext(overrides = {}) {
  let counter = 0;
  return {
    appConfig: { security: { assetSigningSecret: "test-secret" }, imageProvider: { provider: "wavespeed" } },
    imageJobs: new Map(),
    createImageJob: async ({ metadata = {} }) => {
      counter += 1;
      return {
        id: `ab12cd0${counter}`,
        ownerUserId: 101,
        status: "pending",
        provider: "wavespeed",
        providerMode: "text-to-image",
        providerResultUrl: "https://secret-provider.example.com/sensitive-token",
        model: "wavespeed-v2",
        metadata: {
          ...metadata,
          upstreamTaskId: "sensitive-task-id-123",
          apiKeyUsed: "secret-key-xyz",
        },
        generationContext: {},
        imageUrl: "",
        error: "",
        generationId: null,
        createdAt: Date.now(),
      };
    },
    resolveImageJob: async (job) => job,
    buildImageJobResponse: (job) => ({
      jobId: job.id,
      status: job.status,
      error: job.error || "",
      imageConcept: job.status === "completed" ? { imageUrl: job.imageUrl, previewUrl: job.imageUrl, title: job.metadata?.title || "" } : null,
    }),
    persistGenerationImages: async () => {},
    generatedAssetStorage: {
      stageDeleteMany: async () => ({ commit: async () => {}, rollback: async () => {} }),
    },
    findTrendItem,
    ...overrides,
  };
}

test("batch xhs-carousel creates 4 slide jobs with shared carouselGroupId and safe copy fields", async () => {
  const context = makeContext();
  const req = createReq("POST", "/api/brands/201/trends/301/ideas/0/xhs-carousel", {
    aspectRatio: "3:4",
    carouselGroupId: "group-custom-101",
  });
  const res = createRes();

  const handled = await handleImageGenerationRoutes(context, req, res, "/api/brands/201/trends/301/ideas/0/xhs-carousel");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.carouselGroupId, "group-custom-101");
  assert.equal(res.body.slideJobs.length, 4);

  // Check jobs in DB have carouselGroupId and safe copy fields
  for (const slideJob of res.body.slideJobs) {
    const job = findImageJobByOwner(slideJob.jobId, 101);
    assert.ok(job);
    assert.equal(job.generationContext.carouselGroupId, "group-custom-101");
    assert.equal(job.generationContext.carouselTitle, "AI选题1组图");
    assert.equal(job.generationContext.publishTitle, "组图发布标题");
    assert.equal(job.generationContext.publishCaption, "组图发布文案");
    assert.ok(job.generationContext.sourceSlide);
  }
});

test("GET /api/image-jobs/active returns safe recovery snapshot with copy fields, no secrets or provider internals", async () => {
  const context = makeContext();
  const req = createReq("GET", "/api/image-jobs/active");
  const res = createRes();

  await handleImageGenerationRoutes(context, req, res, "/api/image-jobs/active");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.jobs.length >= 4);

  for (const snapshot of res.body.jobs) {
    assert.equal("provider" in snapshot, false, "provider name must not leak");
    assert.equal("providerResultUrl" in snapshot, false, "provider URL must not leak");
    assert.equal("model" in snapshot, false, "model name must not leak");
    assert.equal("upstreamTaskId" in snapshot, false, "upstreamTaskId must not leak");
    assert.equal("apiKeyUsed" in snapshot, false, "apiKey must not leak");

    assert.ok(snapshot.jobId);
    assert.ok(snapshot.type);
    if (snapshot.type === "xhsCarouselSlide") {
      assert.equal(snapshot.carouselGroupId, "group-custom-101");
      assert.equal(snapshot.publishTitle, "组图发布标题");
      assert.ok(snapshot.slide);
      assert.ok(snapshot.slide.pageLabel);
    }
  }
});

test("polling completed slide job merges into group generation row idempotently", async () => {
  const context = makeContext({
    resolveImageJob: async (job) => ({
      ...job,
      status: "completed",
      imageUrl: `https://cdn.example.com/${job.id}.png`,
    }),
  });

  const req = createReq("GET", "/api/image-jobs/job_bg_1");
  const res = createRes();

  await handleImageGenerationRoutes(context, req, res, "/api/image-jobs/ab12cd01");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "completed");
  assert.ok(res.body.generationId);

  const generations = listGenerationsByOwner(101).filter((g) => g.payload?.carouselGroupId === "group-custom-101");
  assert.equal(generations.length, 1);
  assert.equal(generations[0].payload.slides[0].imageUrl, "https://cdn.example.com/ab12cd01.png");

  // Polling second slide merges into the same generation row
  const req2 = createReq("GET", "/api/image-jobs/ab12cd02");
  const res2 = createRes();
  await handleImageGenerationRoutes(context, req2, res2, "/api/image-jobs/ab12cd02");
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.generationId, generations[0].id);

  const generationsAfter = listGenerationsByOwner(101).filter((g) => g.payload?.carouselGroupId === "group-custom-101");
  assert.equal(generationsAfter.length, 1, "both slides must share the same generation row");
  assert.equal(generationsAfter[0].payload.slides[0].imageUrl, "https://cdn.example.com/ab12cd01.png");
  assert.equal(generationsAfter[0].payload.slides[1].imageUrl, "https://cdn.example.com/ab12cd02.png");
});
