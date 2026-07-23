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
  credits: 20,
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

function routeContext(appConfig = { pgy: { enabled: false }, assetSigningSecret: "test-secret" }) {
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
    imageJobs: new Map(),
    createImageJob: async () => ({ id: "job-1", metadata: {}, generationContext: {} }),
    resolveImageJob: async () => null,
    buildImageJobResponse: (job) => job,
    ensureTrendIdeaContentAssets: async () => ({}),
    MAX_PRODUCT_IMAGE_SELECTION_COUNT: 10,
    MAX_PRODUCT_IMAGE_SELECTION_BYTES: 30 * 1024 * 1024,
    normalizeProductImage: () => null,
    resolveBrandLogoImage: async () => null,
    estimateDataUrlBytes: () => 0,
    formatBytes: () => "0B",
    persistGenerationImages: async () => {},
    persistGeneratedImageReference: async () => {},
    resolveGeneratedImageInputForEdit: async () => null,
    findTrendItem: brandRepo.findBrandByOwner
      ? (brand, trendId) => {
          for (const bucket of brand.trends || []) {
            const hit = (bucket.items || []).find((item) => Number(item.id) === Number(trendId));
            if (hit) return hit;
          }
          return null;
        }
      : () => null,
    buildMomentsGenerationPayload: () => ({}),
    buildGeneratedAssetPayload: () => ({}),
    normalizeXhsCarouselSlideForJob: (slide, fallback, index) => ({
      ...(fallback || {}),
      ...(slide || {}),
      pageLabel: slide?.pageLabel || fallback?.pageLabel || `第 ${index + 1} 张`,
      prompt: slide?.prompt || fallback?.prompt || "prompt",
      title: slide?.title || fallback?.title || "t",
      copy: slide?.copy || fallback?.copy || "c",
      visualDirection: slide?.visualDirection || fallback?.visualDirection || "v",
      style: slide?.style || "s",
      composition: slide?.composition || "c",
    }),
    formatImageServiceError: (error) => error.message,
    runChargedAiWork: async ({ run, user }) => ({ value: await run(), user, creditEvent: { id: 1 } }),
  };
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

test("idea library flattens existing ideas", async () => {
  const res = createRes();
  await handleExcellentContentRoutes(
    routeContext(),
    createGetReq("/api/brands/7/excellent-remix-ideas"),
    res,
    "/api/brands/7/excellent-remix-ideas",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ideas.length, 1);
  assert.equal(res.body.ideas[0].ideaTitle, "选题A");
  assert.equal(res.body.ideas[0].trendId, 11);
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
