const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { insertProductImage } = require("../../src/server/db/repositories/product-image-repository");
const { createApiHandler } = require("../../src/server/api");
const { createAiServices } = require("../../src/server/ai");
const { DEFAULT_APP_CONFIG } = require("../../src/server/config");
const { signAssetUrl } = require("../../src/server/assets/signed-urls");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({ id: 951, name: "Route Tester", phone: "13900000951", password: "hash", credits: 100, createdAt: new Date().toISOString() });
insertUser({ id: 952, name: "Other Route Tester", phone: "13900000952", password: "hash", credits: 100, createdAt: new Date().toISOString() });
insertSession({ token: "route-video-session", userId: 951, createdAt: new Date().toISOString() });
insertSession({ token: "route-video-other-session", userId: 952, createdAt: new Date().toISOString() });

const brand = insertBrand({
  id: 91,
  ownerUserId: 951,
  name: "Route Brand",
  industry: "食品饮料",
  audience: "测试用户",
  description: "测试品牌",
  product: "测试产品",
  goal: "测试目标",
  profileType: "brand",
});
upsertBrandFull({
  ...brand,
  trends: [{
    key: "test",
    title: "测试趋势",
    description: "测试",
    items: [{
      id: 991,
      stableKey: "route-trend-991",
      rank: 1,
      score: 80,
      reason: "测试原因",
      category: "生活方式",
      title: "测试选题",
      summary: "测试摘要",
      ideas: [{
        title: "测试视频选题",
        summary: "测试创意",
        angle: "测试角度",
        brandFit: "测试结合",
        audience: "测试人群",
        hook: "测试钩子",
        tags: ["测试"],
      }],
    }],
  }],
});
insertProductImage({ id: 9911, ownerUserId: 951, brandId: brand.id, originalName: "product.png", storedPath: "uploads/product-images/951/product.png", mimeType: "image/png", sizeBytes: 4, sha256: "route-test-sha256", createdAt: new Date().toISOString() });

function makeProject(id = 7001) {
  return {
    id,
    generationId: id + 100,
    brandId: brand.id,
    trendId: 991,
    ideaIndex: 0,
    model: "g2",
    mode: "image",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    status: "queued",
    referenceAssetIds: [9911],
    visualBible: { subject: "产品" },
    script: { title: "测试", clips: [] },
    estimatedCredits: 2,
    chargedCredits: 2,
    refundedCredits: 0,
    finalVideoUrl: "",
    clips: [],
  };
}

function makeService() {
  let project = makeProject();
  let createdInput = null;
  let activeArgs = null;
  let retryArgs = null;
  return {
    getCapabilities: () => [{ id: "d2", displayName: "D2", maxReferenceImages: 9 }, { id: "g2", displayName: "G2", maxReferenceImages: 5 }],
    estimateCost: (input) => ({ model: input.model || "d2", resolution: input.resolution || "720p", totalDurationSec: Number(input.totalDurationSec || 10), clipDurations: [10], credits: 2 }),
    listActiveProjects: (...args) => { activeArgs = args; return [project]; },
    createProject: (input) => {
      createdInput = input;
      return { project, user: { id: 951, credits: 98 }, generation: { id: project.generationId } };
    },
    getProject: (id, ownerUserId) => Number(id) === project.id && (!ownerUserId || Number(ownerUserId) === 951) ? project : null,
    startProject: () => { project = { ...project, status: "running" }; return project; },
    retryClip: (...args) => { retryArgs = args; return project; },
    retryAssembly: () => ({ ...project, status: "completed" }),
    serveAsset: async (_id, _owner, _kind, _index, res) => { res.writeHead(200, { "Content-Type": "video/mp4" }); res.end("video"); return true; },
    getCreatedInput: () => createdInput,
    getActiveArgs: () => activeArgs,
    getRetryArgs: () => retryArgs,
  };
}

function createMockServer(handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handled = await handler(req, res, url.pathname);
    if (!handled && !res.writableEnded) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    }
  });
}

function request(server, options, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    const payload = body == null ? "" : JSON.stringify(body);
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: options.path, method: options.method || "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("video project routes expose capabilities, enforce ownership, and map selected references", async (t) => {
  const service = makeService();
  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: createAiServices(DEFAULT_APP_CONFIG), videoProjectService: service });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const capabilities = await request(server, { path: "/api/video-models/capabilities" });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.models.map((model) => model.id), ["d2", "g2"]);

  const created = await request(server, {
    method: "POST",
    path: "/api/brands/91/trends/991/ideas/0/video-project",
    headers: { Cookie: "redbase_session=route-video-session" },
  }, {
    requestId: "route-project-1",
    videoScriptGenerationId: 8801,
    model: "g2",
    mode: "image",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    referenceAssetIds: [9911, 999999],
    visualBible: { subject: "产品" },
    script: { title: "测试", clips: [] },
  });
  assert.equal(created.status, 200);
  assert.equal(service.getCreatedInput().videoScriptGenerationId, 8801);
  assert.equal("script" in service.getCreatedInput(), false);
  assert.equal("visualBible" in service.getCreatedInput(), false);
  assert.equal("referenceAssetIds" in service.getCreatedInput(), false);
  assert.equal(service.getCreatedInput().ownerUserId, 951);

  const active = await request(server, {
    path: "/api/video-projects/active?brandId=91&trendId=991&ideaIndex=0",
    headers: { Cookie: "redbase_session=route-video-session" },
  });
  assert.equal(active.status, 200);
  assert.deepEqual(service.getActiveArgs(), [951, { brandId: "91", trendId: "991", ideaIndex: "0" }]);

  const regenerated = await request(server, {
    method: "POST",
    path: "/api/video-projects/7001/clips/1/retry",
    headers: { Cookie: "redbase_session=route-video-session" },
  }, { requestId: "route-regenerate-1", prompt: "改为缓慢推进的产品特写" });
  assert.equal(regenerated.status, 200);
  assert.deepEqual(service.getRetryArgs(), [7001, 951, 1, "route-regenerate-1", "改为缓慢推进的产品特写"]);

  const forbidden = await request(server, { path: "/api/video-projects/7001", headers: { Cookie: "redbase_session=route-video-other-session" } });
  assert.equal(forbidden.status, 404);
});

test("video project asset route requires a valid signature", async (t) => {
  const service = makeService();
  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: createAiServices(DEFAULT_APP_CONFIG), videoProjectService: service });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const unsigned = await request(server, { path: "/api/video-projects/7001/assets/final", headers: { Cookie: "redbase_session=route-video-session" } });
  assert.equal(unsigned.status, 401);
  const signed = signAssetUrl(DEFAULT_APP_CONFIG, "/api/video-projects/7001/assets/final", { ttlMs: 60_000, stable: false });
  const served = await request(server, { path: signed });
  assert.equal(served.status, 200);
  assert.equal(served.body, "video");
});
