const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, upsertBrandFull } = require("../../src/server/db/repositories/brand-repository");
const { createApiHandler } = require("../../src/server/api");
const { DEFAULT_APP_CONFIG } = require("../../src/server/config");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

const TEST_USER = {
  id: 201,
  name: "Style Tester",
  phone: "13900000201",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-08-20T00:00:00.000Z",
};

insertUser(TEST_USER);
insertSession({ token: "style-test-token", userId: TEST_USER.id, createdAt: new Date().toISOString() });

const BRAND = insertBrand({
  id: 21,
  ownerUserId: TEST_USER.id,
  name: "风格测试品牌",
  industry: "美妆个护",
  profileType: "brand",
  audience: "油皮人群",
  description: "美妆品牌",
  product: "控油水乳",
  goal: "品牌认知",
});

upsertBrandFull({
  ...BRAND,
  trends: [
    {
      key: "traffic",
      title: "流量趋势",
      description: "热点",
      items: [
        {
          id: 601,
          stableKey: "trend-601",
          rank: 1,
          score: 90,
          reason: "高热度",
          title: "夏日清爽护肤",
          category: "美妆",
          summary: "夏日控油补水指南",
          ideas: [
            {
              title: "夏日油皮控油水乳搭配",
              summary: "控油保湿双管齐下",
              angle: "极简护肤",
              brandFit: "清爽水乳",
              audience: "油皮人群",
              hook: "告别大油田",
              tags: ["控油", "护肤"],
              contentAssets: {
                moments: { title: "朋友圈", caption: "朋友圈文案", visualDirection: "清爽自然视觉" },
                xhsCarousel: {
                  title: "小红书",
                  publishTitle: "发布标题",
                  publishCaption: "发布文案",
                  caption: "文案",
                  slides: [1, 2, 3, 4].map((index) => ({
                    pageLabel: `第 ${index} 张`,
                    title: `页标题 ${index}`,
                    copy: `第 ${index} 页文案`,
                    visualDirection: `第 ${index} 页视觉方向`,
                    prompt: `第 ${index} 页提示词`,
                  })),
                },
                wechatLongImage: {
                  title: "公众号",
                  publishTitle: "长图标题",
                  intro: "导语",
                  outline: ["大纲一", "大纲二", "大纲三"],
                  positioning: "定位",
                  cta: "行动",
                  visualDirection: "视觉方向",
                },
              },
            },
          ],
        },
      ],
    },
  ],
});

function createMockServer(handler) {
  return http.createServer(async (req, res) => {
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
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const sampleDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("POST moments image parses and forwards styleReferenceImages alongside productImages", async (t) => {
  let createdJobArgs = null;
  const fakeAi = {
    imageJobs: { get: () => null, set: () => {} },
    createImageJob: async (args) => {
      createdJobArgs = args;
      return { id: "job-moments-1", ownerUserId: 201, status: "pending", createdAt: Date.now(), metadata: {} };
    },
    resolveImageJob: async (job) => job,
    buildImageJobResponse: (job) => ({ jobId: job.id, status: "pending" }),
  };

  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: fakeAi });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: "/api/brands/21/trends/601/ideas/0/image",
      headers: { Cookie: "redbase_session=style-test-token" },
    },
    {
      aspectRatio: "3:4",
      productImages: [{ name: "产品图.png", dataUrl: sampleDataUrl }],
      styleReferenceImages: [{ name: "风格图.png", dataUrl: sampleDataUrl }],
      useBrandLogo: false,
    },
  );

  assert.equal(res.status, 202);
  assert.ok(createdJobArgs);
  assert.equal(createdJobArgs.productImages.length, 1);
  assert.equal(createdJobArgs.styleReferenceImages.length, 1);
  assert.equal(createdJobArgs.productImages[0].name, "产品图.png");
  assert.equal(createdJobArgs.styleReferenceImages[0].name, "风格图.png");
});

test("POST wechat long image forwards styleReferenceImages alongside productImages", async (t) => {
  let createdJobArgs = null;
  const fakeAi = {
    imageJobs: { get: () => null, set: () => {} },
    createImageJob: async (args) => {
      createdJobArgs = args;
      return { id: "job-wechat-1", ownerUserId: 201, status: "pending", createdAt: Date.now(), metadata: {} };
    },
    resolveImageJob: async (job) => job,
    buildImageJobResponse: (job) => ({ jobId: job.id, status: "pending" }),
  };

  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: fakeAi });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: "/api/brands/21/trends/601/ideas/0/wechat-long-image",
      headers: { Cookie: "redbase_session=style-test-token" },
    },
    {
      aspectRatio: "9:21",
      wechatTemplate: "tutorial",
      productImages: [{ name: "产品图.png", dataUrl: sampleDataUrl }],
      styleReferenceImages: [{ name: "风格图.png", dataUrl: sampleDataUrl }],
      useBrandLogo: false,
    },
  );

  if (res.status !== 200) {
    console.error("wechat error body:", res.body);
  }
  assert.equal(res.status, 200);
  assert.ok(createdJobArgs);
  assert.equal(createdJobArgs.productImages.length, 1);
  assert.equal(createdJobArgs.styleReferenceImages.length, 1);
});

test("POST xhs-carousel slide forwards styleReferenceImages", async (t) => {
  let createdJobArgs = null;
  const fakeAi = {
    imageJobs: { get: () => null, set: () => {} },
    createImageJob: async (args) => {
      createdJobArgs = args;
      return { id: "job-xhs-1", ownerUserId: 201, status: "pending", createdAt: Date.now(), metadata: {} };
    },
    resolveImageJob: async (job) => job,
    buildImageJobResponse: (job) => ({ jobId: job.id, status: "pending" }),
  };

  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: fakeAi });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: "/api/brands/21/trends/601/ideas/0/xhs-carousel/slides/0",
      headers: { Cookie: "redbase_session=style-test-token" },
    },
    {
      aspectRatio: "3:4",
      slide: { prompt: "封面图提示词", pageLabel: "第 1 张" },
      carouselPack: { title: "组图", slides: [{ prompt: "封面图提示词", pageLabel: "第 1 张" }] },
      productImages: [{ name: "产品图.png", dataUrl: sampleDataUrl }],
      styleReferenceImages: [{ name: "风格图.png", dataUrl: sampleDataUrl }],
      useBrandLogo: false,
    },
  );

  assert.equal(res.status, 202);
  assert.ok(createdJobArgs);
  assert.equal(createdJobArgs.productImages.length, 1);
  assert.equal(createdJobArgs.styleReferenceImages.length, 1);
});

test("rejects more than 1 style reference image", async (t) => {
  const fakeAi = {
    imageJobs: { get: () => null, set: () => {} },
    createImageJob: async () => ({ id: "job-1", ownerUserId: 201, status: "pending", createdAt: Date.now(), metadata: {} }),
  };

  const handler = createApiHandler({ appConfig: DEFAULT_APP_CONFIG, store: {}, ai: fakeAi });
  const server = createMockServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await makeRequest(
    server,
    {
      method: "POST",
      path: "/api/brands/21/trends/601/ideas/0/image",
      headers: { Cookie: "redbase_session=style-test-token" },
    },
    {
      aspectRatio: "3:4",
      styleReferenceImages: [
        { name: "风格图1.png", dataUrl: sampleDataUrl },
        { name: "风格图2.png", dataUrl: sampleDataUrl },
      ],
      useBrandLogo: false,
    },
  );

  assert.equal(res.status, 400);
  assert.match(res.body.error, /风格参考图最多选择 1 张/);
});
