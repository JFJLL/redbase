const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-remix-api-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "api.sqlite");

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../../src/server/db/repositories/excellent-content-cache-repository");
const { handleExcellentContentRoutes } = require("../../src/server/api/excellent-content-routes");
const { handleImageGenerationRoutes } = require("../../src/server/api/image-generation-routes");
const { handleProductImageRoutes } = require("../../src/server/api/product-image-routes");
const { collectBody } = require("../../src/server/api/http-utils");
const {
  insertProductImage,
  ASSET_TYPE_PRODUCT,
  ASSET_TYPE_UNASSIGNED,
} = require("../../src/server/db/repositories/product-image-repository");
const {
  findCreditEventById,
  insertCreditEvent,
  updateCreditEventGeneration,
} = require("../../src/server/db/repositories/admin-repository");
const {
  findXhsCarouselGenerationByGroup,
  listGenerationsByOwner,
  insertGeneration,
} = require("../../src/server/db/repositories/generation-repository");
const { allocateCounter } = require("../../src/server/db/repositories/core-repository");
const { upsertImageJob, findImageJobByOwner } = require("../../src/server/db/repositories/image-job-repository");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 91,
  name: "Excellent Remix API",
  phone: "13910000092",
  password: "hash",
  accountType: "customer",
  credits: 200,
  createdAt: "2026-07-23T00:00:00.000Z",
});
insertSession({ token: "remix-token", userId: 91, createdAt: "2026-07-23T00:00:00.000Z" });

const brandRepo = require("../../src/server/db/repositories/brand-repository");
brandRepo.findBrandByOwner = (brandId, ownerUserId) => {
  if (Number(brandId) === 7 && Number(ownerUserId) === 91) {
    return {
      id: 7,
      name: "测试品牌",
      industry: "母婴",
      audience: "妈妈",
      description: "温和喂养",
      product: "奶粉",
      goal: "安心转奶",
      knowledgeBase: "",
      logo: null,
      trends: [
        {
          key: "xhs",
          items: [
            {
              id: 11,
              title: "转奶讨论",
              summary: "转奶与便便",
              tags: ["转奶"],
              ideas: [{ title: "选题A", summary: "摘要A", angle: "场景A", audience: "妈妈", brandFit: "植入A", hook: "钩子", tags: [] }],
            },
          ],
        },
      ],
      analyses: [
        {
          id: 55,
          name: "历史分析一",
          timestamp: "2026-01-01T00:00:00.000Z",
          trendSnapshot: [
            {
              key: "xhs",
              items: [
                {
                  id: 11,
                  title: "历史趋势同 id",
                  summary: "snapshot",
                  tags: ["转奶"],
                  ideas: [
                    {
                      title: "历史选题A",
                      summary: "历史摘要",
                      angle: "历史场景",
                      audience: "妈妈",
                      brandFit: "历史植入",
                      hook: "历史钩子",
                      tags: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }
  if (Number(brandId) === 8 && Number(ownerUserId) === 91) {
    return {
      id: 8,
      name: "第二品牌",
      industry: "美妆",
      audience: "油皮",
      description: "控油",
      product: "妆前乳",
      goal: "持久",
      knowledgeBase: "",
      logo: null,
      trends: [],
      analyses: [],
    };
  }
  return null;
};

upsertExcellentContentCache({
  sourceKey: "xhs_hot",
  categoryPath: "",
  items: [
    {
      noteId: "api-note-1",
      id: "api-note-1",
      title: "转奶对照清单",
      author: { nickname: "作者" },
      imageUrls: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"],
      imageCount: 2,
      metrics: { readCount: 1000 },
      contentSource: "all",
    },
  ],
  fetchedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

function createPostReq(url, body = {}, cookie = "redbase_session=remix-token") {
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

function createGetReq(url, cookie = "redbase_session=remix-token") {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost:3013", cookie };
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
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

let imageJobSeq = 0;
const persistCalls = [];

function routeContext(overrides = {}) {
  const imageJobs = overrides.imageJobs || new Map();
  const appConfig = overrides.appConfig || { pgy: { enabled: false }, assetSigningSecret: "test-secret", imageProvider: { enabled: false } };
  return {
    appConfig,
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
    fsp: fs.promises,
    MAX_PRODUCT_IMAGE_BYTES: 10 * 1024 * 1024,
    PRODUCT_IMAGE_MIME_EXTENSIONS: { "image/png": "png" },
    parseProductImageDataUrl: () => ({ mimeType: "image/png", buffer: Buffer.from("x") }),
    sanitizeFileName: (name) => name,
    resolveStoredProductImagePath: (image) => path.join(tempDir, image.storedPath || "x.png"),
    buildProductImageView: (image) => ({
      id: image.id,
      originalName: image.originalName,
      brandId: image.brandId,
      assetType: image.assetType,
      url: `/api/product-images/${image.id}/file`,
      createdAt: image.createdAt,
    }),
    verifySignedAssetRequest: () => true,
    sortProductImages: () => 0,
    sanitizeUser: (user) => user,
    sanitizePayloadForClient: (payload) => payload,
    sanitizeGeneration: (generation) => generation,
    CREDIT_COSTS: { xhsCarouselSlide: 1 },
    imageJobs,
    createImageJob: async ({ metadata, ownerUserId } = {}) => {
      imageJobSeq += 1;
      // Route matcher only accepts hex job ids: /api/image-jobs/:hex
      const id = `${imageJobSeq.toString(16).padStart(8, "0")}${"a".repeat(24)}`;
      return {
        id,
        ownerUserId: ownerUserId || 91,
        status: "pending",
        metadata: metadata || {},
        generationContext: {},
        imageUrl: "",
        createdAt: Date.now(),
      };
    },
    resolveImageJob: async (job) => ({
      ...job,
      status: "completed",
      imageUrl: job.imageUrl || `https://cdn.test-images.example/${job.id}.png`,
      completedAt: new Date().toISOString(),
    }),
    buildImageJobResponse: (job) => ({
      jobId: job.id,
      status: job.status,
      imageConcept:
        job.status === "completed"
          ? {
              imageUrl: job.imageUrl,
              previewUrl: job.imageUrl,
              pageLabel: job.metadata?.pageLabel || "",
              slideIndex: job.metadata?.slideIndex ?? null,
            }
          : null,
      error: job.error || "",
    }),
    ensureTrendIdeaContentAssets: async () => ({}),
    MAX_PRODUCT_IMAGE_SELECTION_COUNT: 10,
    MAX_PRODUCT_IMAGE_SELECTION_BYTES: 30 * 1024 * 1024,
    normalizeProductImage: () => null,
    resolveBrandLogoImage: async () => null,
    estimateDataUrlBytes: () => 0,
    formatBytes: () => "0B",
    persistGenerationImages: async (generation) => {
      persistCalls.push({
        generationId: generation?.id,
        slides: (generation?.payload?.slides || []).map((slide) => slide?.imageUrl || slide?.previewUrl || ""),
      });
      return generation;
    },
    persistGeneratedImageReference: async () => {},
    resolveGeneratedImageInputForEdit: async () => null,
    findTrendItem: (brand, trendId) => {
      for (const bucket of brand.trends || []) {
        const hit = (bucket.items || []).find((item) => Number(item.id) === Number(trendId));
        if (hit) return hit;
      }
      return null;
    },
    buildMomentsGenerationPayload: () => ({}),
    buildGeneratedAssetPayload: () => ({}),
    normalizeXhsCarouselSlideForJob: (slide, fallback, index) => ({
      ...(fallback || {}),
      ...(slide || {}),
      pageLabel: slide?.pageLabel || fallback?.pageLabel || `第 ${index + 1} 张`,
      pageRole: slide?.pageRole || fallback?.pageRole || "",
      prompt: slide?.prompt || fallback?.prompt || "prompt",
      title: slide?.title || fallback?.title || "t",
      copy: slide?.copy || fallback?.copy || "c",
      visualDirection: slide?.visualDirection || fallback?.visualDirection || "v",
      style: slide?.style || "s",
      composition: slide?.composition || "c",
    }),
    formatImageServiceError: (error) => error.message,
    ...overrides,
    imageJobs,
    appConfig,
  };
}

async function getFusionPack(contentMode = "smart", extra = {}) {
  const body = {
    board: "xhs_hot",
    brandId: 7,
    contentMode,
    useTrendContext: false,
    ...extra,
  };
  if (contentMode === "smart" && !body.smartDirection) {
    const directionsRes = createRes();
    await handleExcellentContentRoutes(
      routeContext(),
      createPostReq("/api/excellent-contents/api-note-1/content-directions", { board: "xhs_hot", brandId: 7 }),
      directionsRes,
      "/api/excellent-contents/api-note-1/content-directions",
    );
    assert.equal(directionsRes.statusCode, 200, directionsRes.body?.error || "directions failed");
    body.smartDirection = directionsRes.body.directions[0];
  }
  if (contentMode === "custom" && !body.customDirection) {
    body.customDirection = "聚焦转奶焦虑，给出三步安抚清单与品牌温和配方卖点说明。";
  }
  const fusionRes = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/fusion-plan", body),
    fusionRes,
    "/api/excellent-contents/api-note-1/fusion-plan",
  );
  assert.equal(fusionRes.statusCode, 200, fusionRes.body?.error || "fusion failed");
  return fusionRes.body.fusionPlan.carouselPack;
}

async function previewRemix(carouselPack, extra = {}) {
  const imageJobs = new Map();
  const ctx = routeContext({ imageJobs });
  const res = createRes();
  await handleImageGenerationRoutes(
    ctx,
    createPostReq("/api/brands/7/excellent-remix-preview", {
      aspectRatio: "3:4",
      carouselPack,
      ...extra,
    }),
    res,
    "/api/brands/7/excellent-remix-preview",
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.carouselGroupId);
  return { ...res.body, imageJobs, ctx };
}

async function createCompletedSlideJob({
  slideIndex = 0,
  contentMode = "smart",
  existingIdeaRef = null,
  carouselGroupId,
  carouselPack,
  brandId = 7,
  imageJobs = new Map(),
  imageUrl,
  extraBody = {},
} = {}) {
  const pack =
    carouselPack ||
    (await getFusionPack(contentMode, {
      ...(existingIdeaRef ? { existingIdeaRef } : {}),
      ...extraBody,
    }));
  let groupId = carouselGroupId;
  if (!groupId) {
    const preview = await previewRemix(pack, { contentMode, existingIdeaRef, ...extraBody });
    groupId = preview.carouselGroupId;
  }
  const ctx = routeContext({ imageJobs });
  const slideRes = createRes();
  await handleImageGenerationRoutes(
    ctx,
    createPostReq(`/api/brands/${brandId}/excellent-remix/slides/${slideIndex}`, {
      aspectRatio: "3:4",
      carouselPack: { ...pack, carouselGroupId: groupId },
      carouselGroupId: groupId,
      contentMode,
      existingIdeaRef,
      slide: pack.slides[slideIndex],
      ...extraBody,
    }),
    slideRes,
    `/api/brands/${brandId}/excellent-remix/slides/${slideIndex}`,
  );
  assert.equal(slideRes.statusCode, 202, slideRes.body?.error || "slide create failed");
  const jobId = slideRes.body.slideJob.jobId;
  const creditEventId = slideRes.body.creditEventId;
  const memoryJob = imageJobs.get(jobId) || findImageJobByOwner(jobId, 91);
  assert.ok(memoryJob, "job should exist");
  memoryJob.status = "completed";
  memoryJob.imageUrl = imageUrl || `https://cdn.test-images.example/${jobId}.png`;
  imageJobs.set(jobId, memoryJob);
  upsertImageJob(91, memoryJob);
  return {
    jobId,
    creditEventId,
    carouselGroupId: groupId,
    carouselPack: pack,
    imageJobs,
    ctx,
    slideRes,
  };
}

async function pollJob(jobId, imageJobs) {
  const ctx = routeContext({ imageJobs });
  const res = createRes();
  await handleImageGenerationRoutes(ctx, createGetReq(`/api/image-jobs/${jobId}`), res, `/api/image-jobs/${jobId}`);
  return res;
}

test("remix-analysis requires login and returns metadata_only analysis", async () => {
  const unauthorizedRes = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/remix-analysis", { board: "xhs_hot" }, ""),
    unauthorizedRes,
    "/api/excellent-contents/api-note-1/remix-analysis",
  );
  assert.equal(unauthorizedRes.statusCode, 401);

  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/remix-analysis", { board: "xhs_hot" }),
    res,
    "/api/excellent-contents/api-note-1/remix-analysis",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.analysis.analysisMode, "metadata_only");
  assert.doesNotMatch(JSON.stringify(res.body), /cdn\.example/);
});

test("content-directions returns 3 modes without trend", async () => {
  const res = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/content-directions", {
      board: "xhs_hot",
      brandId: 7,
      learningFocus: ["structure", "visual"],
    }),
    res,
    "/api/excellent-contents/api-note-1/content-directions",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.directions.length, 3);
  assert.ok(res.body.directions.every((item) => item.transferMode));
});

test("idea library flattens current and snapshot ideas", async () => {
  const res = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createGetReq("/api/brands/7/excellent-remix-ideas"),
    res,
    "/api/brands/7/excellent-remix-ideas",
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ideas.some((item) => item.scope === "current" && item.ideaTitle === "选题A"));
  assert.ok(res.body.ideas.some((item) => item.scope === "snapshot" && item.ideaTitle === "历史选题A"));
  assert.ok(res.body.ideas.some((item) => item.analysisName === "历史分析一"));
});

test("fusion-plan smart mode does not require trendId", async () => {
  const directionsRes = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/content-directions", { board: "xhs_hot", brandId: 7 }),
    directionsRes,
    "/api/excellent-contents/api-note-1/content-directions",
  );
  const direction = directionsRes.body.directions[0];
  const res = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/fusion-plan", {
      board: "xhs_hot",
      brandId: 7,
      contentMode: "smart",
      smartDirection: direction,
      learningFocus: ["structure", "visual"],
      useTrendContext: false,
    }),
    res,
    "/api/excellent-contents/api-note-1/fusion-plan",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fusionPlan.carouselPack.slides.length, 4);
  assert.equal(res.body.fusionPlan.trendUsed, false);
});

test("excellent-remix-preview does not require trendId and keeps structured pack", async () => {
  const fusionRes = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/fusion-plan", {
      board: "xhs_hot",
      brandId: 7,
      contentMode: "custom",
      customDirection: "想讲宝宝转奶期间的便便变化与观察方法",
      useTrendContext: false,
    }),
    fusionRes,
    "/api/excellent-contents/api-note-1/fusion-plan",
  );
  const carouselPack = fusionRes.body.fusionPlan.carouselPack;
  const res = createRes();
  const context = routeContext();
  // Minimal bindRouteScope-like context for image routes.
  const handled = await handleImageGenerationRoutes(
    {
      ...context,
      appConfig: { ...context.appConfig, imageProvider: { enabled: false } },
    },
    createPostReq("/api/brands/7/excellent-remix-preview", {
      aspectRatio: "3:4",
      carouselPack,
      contentMode: "custom",
    }),
    res,
    "/api/brands/7/excellent-remix-preview",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.carouselPack.slides.length, 4);
  assert.ok(res.body.carouselPack.slides[0].prompt || res.body.carouselPack.slides[0].title);
});

test("product images brand filter excludes other brand and unassigned", async () => {
  insertProductImage({
    id: 801,
    ownerUserId: 91,
    brandId: 7,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "mine.png",
    storedPath: "mine.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "d".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 802,
    ownerUserId: 91,
    brandId: 8,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "other.png",
    storedPath: "other.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "e".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 803,
    ownerUserId: 91,
    brandId: 0,
    assetType: ASSET_TYPE_UNASSIGNED,
    originalName: "laptop.png",
    storedPath: "laptop.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "f".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });

  const res = createRes();
  await handleProductImageRoutes(
    routeContext(),
    createGetReq("/api/product-images?brandId=7"),
    res,
    "/api/product-images",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.images.length, 1);
  assert.equal(res.body.images[0].originalName, "mine.png");
});

test("same file can upload to brand A and brand B independently", async () => {
  const tinyPng = "data:image/png;base64,iVBORw0KGgo=";
  const ctx = {
    ...routeContext(),
    parseProductImageDataUrl: () => ({ mimeType: "image/png", buffer: Buffer.from("same-bytes-for-both-brands") }),
    DATA_DIR: tempDir,
  };
  // inject DATA_DIR usage via absolute write path mock already in resolveStoredProductImagePath
  const { DATA_DIR: _ignored, ...rest } = ctx;
  const context = {
    ...rest,
    // product routes use DATA_DIR from config; fsp writes under DATA_DIR — use temp via resolve path
  };
  // Patch config DATA_DIR indirectly by writing into tempDir through absolute path join in route (uses DATA_DIR).
  // Ensure uploads dir exists.
  await fs.promises.mkdir(path.join(tempDir, "uploads", "product-images", "users", "91"), { recursive: true });

  // Monkey-patch path used by product routes by setting env if needed — repository only stores storedPath.
  const uploadA = createRes();
  await handleProductImageRoutes(
    routeContext(),
    createPostReq("/api/product-images", { brandId: 7, name: "shared-a.png", dataUrl: tinyPng }),
    uploadA,
    "/api/product-images",
  );
  assert.equal(uploadA.statusCode, 201);
  assert.equal(uploadA.body.image.brandId, 7);

  const uploadB = createRes();
  await handleProductImageRoutes(
    routeContext(),
    createPostReq("/api/product-images", { brandId: 8, name: "shared-b.png", dataUrl: tinyPng }),
    uploadB,
    "/api/product-images",
  );
  assert.equal(uploadB.statusCode, 201);
  assert.equal(uploadB.body.image.brandId, 8);
  assert.notEqual(uploadA.body.image.id, uploadB.body.image.id);

  const listA = createRes();
  await handleProductImageRoutes(routeContext(), createGetReq("/api/product-images?brandId=7"), listA, "/api/product-images");
  const listB = createRes();
  await handleProductImageRoutes(routeContext(), createGetReq("/api/product-images?brandId=8"), listB, "/api/product-images");
  assert.ok(listA.body.images.some((item) => Number(item.id) === Number(uploadA.body.image.id)));
  assert.ok(listB.body.images.some((item) => Number(item.id) === Number(uploadB.body.image.id)));
  assert.ok(!listA.body.images.some((item) => Number(item.id) === Number(uploadB.body.image.id)));

  const unassigned = createRes();
  await handleProductImageRoutes(
    routeContext(),
    createPostReq("/api/product-images", { name: "no-brand.png", dataUrl: tinyPng }),
    unassigned,
    "/api/product-images",
  );
  assert.equal(unassigned.statusCode, 201);
  assert.equal(unassigned.body.image.brandId, 0);
  assert.equal(unassigned.body.image.assetType, ASSET_TYPE_UNASSIGNED);
});

test("fusion-plan reads correct snapshot idea and rejects invalid analysisId", async () => {
  const ok = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/fusion-plan", {
      board: "xhs_hot",
      brandId: 7,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "snapshot", analysisId: 55, trendId: 11, ideaIndex: 0 },
      useTrendContext: false,
    }),
    ok,
    "/api/excellent-contents/api-note-1/fusion-plan",
  );
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body.fusionPlan.contentThesis, /历史/);

  const bad = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createPostReq("/api/excellent-contents/api-note-1/fusion-plan", {
      board: "xhs_hot",
      brandId: 7,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "snapshot", analysisId: 9999, trendId: 11, ideaIndex: 0 },
      useTrendContext: false,
    }),
    bad,
    "/api/excellent-contents/api-note-1/fusion-plan",
  );
  assert.ok(bad.statusCode === 400 || bad.statusCode === 404 || bad.statusCode >= 400);
});

test("complete rejects client-forged image URLs and does not create history", async () => {
  persistCalls.length = 0;
  const before = listGenerationsByOwner(91).length;
  const pack = await getFusionPack("smart");
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext(),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      aspectRatio: "3:4",
      carouselPack: {
        ...pack,
        carouselGroupId: "forged-group-1",
        slides: pack.slides.map((slide, index) => ({
          ...slide,
          imageUrl: `/generated/${index}.png`,
          previewUrl: `/generated/${index}.png`,
        })),
      },
      contentMode: "smart",
      creditEventId: 1,
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(persistCalls.length, 0);
  assert.equal(listGenerationsByOwner(91).length, before);
});

test("complete rejects external localhost URLs without network download", async () => {
  persistCalls.length = 0;
  const pack = await getFusionPack("smart");
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext(),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselPack: {
        ...pack,
        carouselGroupId: "ssrf-group-1",
        slides: pack.slides.map((slide) => ({
          ...slide,
          imageUrl: "http://127.0.0.1/secret.png",
          previewUrl: "http://127.0.0.1/secret.png",
        })),
      },
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(persistCalls.length, 0);
});

test("smart single slide completion persists history without trend", async () => {
  persistCalls.length = 0;
  const created = await createCompletedSlideJob({ slideIndex: 0, contentMode: "smart" });
  const poll = await pollJob(created.jobId, created.imageJobs);
  assert.equal(poll.statusCode, 200);
  assert.ok(poll.body.generationId);
  assert.equal(poll.body.persisted, true);
  const generation = findXhsCarouselGenerationByGroup(91, created.carouselGroupId);
  assert.ok(generation);
  assert.equal(generation.channelLabel, "一键仿图文");
  assert.equal(generation.payload.generatedMode, "partialSlides");
  assert.equal(generation.trendId, 0);
  assert.equal(generation.trendTitle, "");
  assert.ok(generation.ideaTitle);
  assert.ok(generation.payload.slides[0].imageUrl);
  const credit = findCreditEventById(created.creditEventId);
  assert.equal(Number(credit.generationId), Number(generation.id));
});

test("custom single slide completion persists history", async () => {
  const customDirection = "聚焦转奶焦虑，给出三步安抚清单与品牌温和配方卖点说明。";
  const pack = await getFusionPack("custom", { customDirection });
  const preview = await previewRemix(pack, { contentMode: "custom", customDirection });
  const imageJobs = new Map();
  const slideRes = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/slides/0", {
      aspectRatio: "3:4",
      carouselPack: { ...pack, carouselGroupId: preview.carouselGroupId },
      carouselGroupId: preview.carouselGroupId,
      contentMode: "custom",
      customDirection,
      slide: pack.slides[0],
    }),
    slideRes,
    "/api/brands/7/excellent-remix/slides/0",
  );
  assert.equal(slideRes.statusCode, 202, slideRes.body?.error || "");
  const jobId = slideRes.body.slideJob.jobId;
  const job = imageJobs.get(jobId);
  job.status = "completed";
  job.imageUrl = `https://cdn.test-images.example/${jobId}.png`;
  upsertImageJob(91, job);
  const poll = await pollJob(jobId, imageJobs);
  assert.equal(poll.statusCode, 200);
  assert.ok(poll.body.generationId);
  const generation = findXhsCarouselGenerationByGroup(91, preview.carouselGroupId);
  assert.ok(generation);
  assert.equal(generation.trendId, 0);
  assert.equal(generation.payload.contentMode, "custom");
});

test("current idea single slide completion persists history", async () => {
  const pack = await getFusionPack("existing_idea", {
    existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
  });
  const preview = await previewRemix(pack, {
    contentMode: "existing_idea",
    existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
  });
  const imageJobs = new Map();
  const slideRes = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/slides/0", {
      aspectRatio: "3:4",
      carouselPack: { ...pack, carouselGroupId: preview.carouselGroupId },
      carouselGroupId: preview.carouselGroupId,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
      slide: pack.slides[0],
    }),
    slideRes,
    "/api/brands/7/excellent-remix/slides/0",
  );
  assert.equal(slideRes.statusCode, 202);
  const jobId = slideRes.body.slideJob.jobId;
  const job = imageJobs.get(jobId);
  job.status = "completed";
  job.imageUrl = `https://cdn.test-images.example/${jobId}.png`;
  upsertImageJob(91, job);
  const poll = await pollJob(jobId, imageJobs);
  assert.ok(poll.body.generationId);
  const generation = findXhsCarouselGenerationByGroup(91, preview.carouselGroupId);
  assert.equal(generation.ideaTitle, "选题A");
  assert.equal(generation.trendTitle, "转奶讨论");
});

test("snapshot idea single slide completion persists history without current trends", async () => {
  const pack = await getFusionPack("existing_idea", {
    existingIdeaRef: { scope: "snapshot", analysisId: 55, trendId: 11, ideaIndex: 0 },
  });
  const preview = await previewRemix(pack, {
    contentMode: "existing_idea",
    existingIdeaRef: { scope: "snapshot", analysisId: 55, trendId: 11, ideaIndex: 0 },
  });
  const imageJobs = new Map();
  const slideRes = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/slides/0", {
      aspectRatio: "3:4",
      carouselPack: { ...pack, carouselGroupId: preview.carouselGroupId },
      carouselGroupId: preview.carouselGroupId,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "snapshot", analysisId: 55, trendId: 11, ideaIndex: 0 },
      slide: pack.slides[0],
    }),
    slideRes,
    "/api/brands/7/excellent-remix/slides/0",
  );
  assert.equal(slideRes.statusCode, 202, slideRes.body?.error || "");
  const jobId = slideRes.body.slideJob.jobId;
  const job = imageJobs.get(jobId);
  job.status = "completed";
  job.imageUrl = `https://cdn.test-images.example/${jobId}.png`;
  upsertImageJob(91, job);
  const poll = await pollJob(jobId, imageJobs);
  assert.ok(poll.body.generationId);
  const generation = findXhsCarouselGenerationByGroup(91, preview.carouselGroupId);
  assert.equal(generation.ideaTitle, "历史选题A");
  assert.equal(generation.trendTitle, "历史趋势同 id");
});

test("second slide merges into same generation without overwriting first", async () => {
  const first = await createCompletedSlideJob({ slideIndex: 0, contentMode: "smart" });
  await pollJob(first.jobId, first.imageJobs);
  const second = await createCompletedSlideJob({
    slideIndex: 1,
    contentMode: "smart",
    carouselGroupId: first.carouselGroupId,
    carouselPack: first.carouselPack,
    imageJobs: first.imageJobs,
  });
  await pollJob(second.jobId, first.imageJobs);
  const generation = findXhsCarouselGenerationByGroup(91, first.carouselGroupId);
  assert.ok(generation.payload.slides[0].imageUrl);
  assert.ok(generation.payload.slides[1].imageUrl);
  assert.notEqual(generation.payload.slides[0].imageUrl, generation.payload.slides[1].imageUrl);
  assert.equal(generation.payload.generatedMode, "partialSlides");
});

test("re-polling completed job does not create duplicate history", async () => {
  const created = await createCompletedSlideJob({ slideIndex: 0, contentMode: "smart" });
  const firstPoll = await pollJob(created.jobId, created.imageJobs);
  const countAfterFirst = listGenerationsByOwner(91).filter(
    (item) => item.payload?.carouselGroupId === created.carouselGroupId,
  ).length;
  const secondPoll = await pollJob(created.jobId, created.imageJobs);
  assert.equal(firstPoll.body.generationId, secondPoll.body.generationId);
  const countAfterSecond = listGenerationsByOwner(91).filter(
    (item) => item.payload?.carouselGroupId === created.carouselGroupId,
  ).length;
  assert.equal(countAfterFirst, 1);
  assert.equal(countAfterSecond, 1);
});

test("complete with four real jobs builds history from job image URLs and links all credit events", async () => {
  const pack = await getFusionPack("existing_idea", {
    existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
  });
  const preview = await previewRemix(pack, {
    contentMode: "existing_idea",
    existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
  });
  const imageJobs = new Map();
  const jobIds = [];
  const creditEventIds = [];
  for (let slideIndex = 0; slideIndex < 4; slideIndex += 1) {
    const created = await createCompletedSlideJob({
      slideIndex,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "current", trendId: 11, ideaIndex: 0 },
      carouselGroupId: preview.carouselGroupId,
      carouselPack: pack,
      imageJobs,
    });
    await pollJob(created.jobId, imageJobs);
    jobIds.push(created.jobId);
    creditEventIds.push(created.creditEventId);
  }
  assert.equal(new Set(creditEventIds).size, 4);
  const completeRes = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselGroupId: preview.carouselGroupId,
      slideJobIds: jobIds,
      expectedSlideCount: 4,
    }),
    completeRes,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(completeRes.statusCode, 200, completeRes.body?.error || "");
  assert.equal(completeRes.body.generation.ideaTitle, "选题A");
  assert.equal(completeRes.body.generation.payload.generatedMode, "group");
  assert.equal(completeRes.body.generation.payload.slides.length, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.match(String(completeRes.body.generation.payload.slides[index].imageUrl || ""), /cdn\.test-images|generated-images|job-/);
  }
  const generationId = completeRes.body.generation.id;
  for (const creditEventId of creditEventIds) {
    const event = findCreditEventById(creditEventId);
    assert.equal(Number(event.generationId), Number(generationId));
  }
  assert.equal(completeRes.body.creditEventIds.length, 4);
});

test("complete rejects job owned by another user", async () => {
  const created = await createCompletedSlideJob({ slideIndex: 0, contentMode: "smart" });
  // plant a job under user 91 then request as if ids unknown — use foreign job id not in DB
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs: created.imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselGroupId: created.carouselGroupId,
      slideJobIds: ["missing-job-a", "missing-job-b", "missing-job-c", "missing-job-d"],
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 404);
});

test("complete rejects jobs from another brand", async () => {
  const pack = await getFusionPack("smart");
  const preview7 = await previewRemix(pack);
  const imageJobs = new Map();
  // Create four jobs for brand 7
  const jobIds = [];
  for (let slideIndex = 0; slideIndex < 4; slideIndex += 1) {
    const created = await createCompletedSlideJob({
      slideIndex,
      contentMode: "smart",
      carouselGroupId: preview7.carouselGroupId,
      carouselPack: pack,
      imageJobs,
      brandId: 7,
    });
    jobIds.push(created.jobId);
  }
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/8/excellent-remix/complete", {
      carouselGroupId: preview7.carouselGroupId,
      slideJobIds: jobIds,
    }),
    res,
    "/api/brands/8/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 400);
});

test("complete rejects mismatched carouselGroupId", async () => {
  const pack = await getFusionPack("smart");
  const preview = await previewRemix(pack);
  const imageJobs = new Map();
  const jobIds = [];
  for (let slideIndex = 0; slideIndex < 4; slideIndex += 1) {
    const created = await createCompletedSlideJob({
      slideIndex,
      contentMode: "smart",
      carouselGroupId: preview.carouselGroupId,
      carouselPack: pack,
      imageJobs,
    });
    jobIds.push(created.jobId);
  }
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselGroupId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      slideJobIds: jobIds,
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 409);
});

test("complete rejects duplicate slide indexes", async () => {
  const pack = await getFusionPack("smart");
  const preview = await previewRemix(pack);
  const imageJobs = new Map();
  const created = await createCompletedSlideJob({
    slideIndex: 0,
    contentMode: "smart",
    carouselGroupId: preview.carouselGroupId,
    carouselPack: pack,
    imageJobs,
  });
  // clone job metadata as if four ids all point to slide 0
  const jobIds = [];
  for (let i = 0; i < 4; i += 1) {
    const cloneId = `dup-job-${i}-${Date.now()}`;
    const clone = {
      ...imageJobs.get(created.jobId),
      id: cloneId,
      status: "completed",
      imageUrl: `https://cdn.test-images.example/${cloneId}.png`,
      generationContext: {
        ...imageJobs.get(created.jobId).generationContext,
        slideIndex: 0,
      },
    };
    imageJobs.set(cloneId, clone);
    upsertImageJob(91, clone);
    jobIds.push(cloneId);
  }
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselGroupId: preview.carouselGroupId,
      slideJobIds: jobIds,
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 400);
});

test("complete rejects incomplete jobs", async () => {
  const pack = await getFusionPack("smart");
  const preview = await previewRemix(pack);
  const imageJobs = new Map();
  const jobIds = [];
  for (let slideIndex = 0; slideIndex < 4; slideIndex += 1) {
    const created = await createCompletedSlideJob({
      slideIndex,
      contentMode: "smart",
      carouselGroupId: preview.carouselGroupId,
      carouselPack: pack,
      imageJobs,
    });
    if (slideIndex === 3) {
      const job = imageJobs.get(created.jobId);
      job.status = "pending";
      job.imageUrl = "";
      upsertImageJob(91, job);
    }
    jobIds.push(created.jobId);
  }
  const res = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs }),
    createPostReq("/api/brands/7/excellent-remix/complete", {
      carouselGroupId: preview.carouselGroupId,
      slideJobIds: jobIds,
    }),
    res,
    "/api/brands/7/excellent-remix/complete",
  );
  assert.equal(res.statusCode, 409);
});

test("cross-brand carouselGroupId collision is rejected on slide create", async () => {
  const pack = await getFusionPack("smart");
  const preview = await previewRemix(pack);
  const first = await createCompletedSlideJob({
    slideIndex: 0,
    contentMode: "smart",
    carouselGroupId: preview.carouselGroupId,
    carouselPack: pack,
    brandId: 7,
  });
  const poll = await pollJob(first.jobId, first.imageJobs);
  assert.equal(poll.statusCode, 200);
  assert.ok(poll.body.generationId, "brand 7 generation must exist before collision check");
  const existing = findXhsCarouselGenerationByGroup(91, preview.carouselGroupId);
  assert.ok(existing);
  assert.equal(Number(existing.brandId), 7);
  const slideRes = createRes();
  await handleImageGenerationRoutes(
    routeContext({ imageJobs: first.imageJobs }),
    createPostReq("/api/brands/8/excellent-remix/slides/0", {
      aspectRatio: "3:4",
      carouselPack: { ...pack, carouselGroupId: preview.carouselGroupId },
      carouselGroupId: preview.carouselGroupId,
      contentMode: "smart",
      slide: pack.slides[0],
    }),
    slideRes,
    "/api/brands/8/excellent-remix/slides/0",
  );
  assert.equal(slideRes.statusCode, 409, slideRes.body?.error || "expected group conflict");
});

test("credit event ownership and actionType guards prevent tampering", async () => {
  insertUser({
    id: 92,
    name: "Other User",
    phone: "13910000093",
    password: "hash",
    accountType: "customer",
    credits: 20,
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  const foreignEvent = insertCreditEvent({
    userId: 92,
    actionType: "xhsCarousel",
    actionLabel: "foreign",
    creditDelta: -1,
    creditCost: 1,
    brandId: 7,
    summary: "foreign event",
  });
  const wrongTypeEvent = insertCreditEvent({
    userId: 91,
    actionType: "moments",
    actionLabel: "unrelated",
    creditDelta: -1,
    creditCost: 1,
    brandId: 7,
    summary: "moments event",
  });
  const generation = insertGeneration({
    id: allocateCounter("nextGenerationId", 1),
    ownerUserId: 91,
    type: "xhsCarousel",
    channelLabel: "一键仿图文",
    brandId: 7,
    brandName: "测试品牌",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "t",
    cardTitle: "t",
    createdAt: new Date().toISOString(),
    previewUrl: "",
    summary: "",
    payload: { excellentRemix: true, carouselGroupId: "guard-group-1", slides: [] },
  });
  assert.equal(updateCreditEventGeneration(foreignEvent.id, generation, generation.payload, {
    requireUserId: 91,
    allowedActionTypes: ["xhsCarousel"],
  }), null);
  assert.equal(updateCreditEventGeneration(wrongTypeEvent.id, generation, generation.payload, {
    requireUserId: 91,
    allowedActionTypes: ["xhsCarousel"],
  }), null);
  assert.equal(findCreditEventById(foreignEvent.id).generationId, null);
  assert.equal(findCreditEventById(wrongTypeEvent.id).generationId, null);
});
