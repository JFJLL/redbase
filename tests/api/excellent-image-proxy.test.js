const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-image-proxy-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "api.sqlite");

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../../src/server/db/repositories/excellent-content-cache-repository");
const {
  handleExcellentContentRoutes,
  normalizeExcellentImageSequence,
} = require("../../src/server/api/excellent-content-routes");
const { collectBody } = require("../../src/server/api/http-utils");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 91,
  name: "Excellent Image Proxy",
  phone: "13910000093",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-07-22T00:00:00.000Z",
});
insertSession({ token: "excellent-token", userId: 91, createdAt: "2026-07-22T00:00:00.000Z" });

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function seedCache() {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "n1",
        noteId: "n1",
        title: "代理测试笔记",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://ci.xiaohongshu.com/remote/1.jpg", "https://ci.xiaohongshu.com/remote/2.jpg"],
        primaryCoverUrl: "https://ci.xiaohongshu.com/remote/1.jpg",
        metrics: { readCount: 10 },
      },
      {
        id: "n2",
        noteId: "n2",
        title: "相对地址笔记",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["/img/local.jpg"],
        primaryCoverUrl: "/img/local.jpg",
        metrics: { readCount: 5 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });
}

function createReq(url, cookie = "redbase_session=excellent-token") {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie,
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
      for (const [key, value] of Object.entries(nextHeaders || {})) {
        headers.set(key.toLowerCase(), value);
      }
    },
    setHeader(key, value) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = typeof data === "string" && (data.startsWith("{") || data.startsWith("[")) ? JSON.parse(data) : data;
    },
  };
}

function fakeUpstream({ status = 200, contentType = "image/jpeg", body = JPEG_BUFFER } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => body,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return String(body.length);
        return "";
      },
    },
    body: {
      arrayBuffer: async () => body,
      resume() {},
    },
  };
}

function buildContext(overrides = {}) {
  return {
    appConfig: { pgy: { enabled: false } },
    collectBody,
    // DNS stub: keeps the SSRF-safe resolution chain under test without real lookups.
    assertSafeRemoteImageUrl: async (imageUrl) => ({
      parsed: new URL(imageUrl),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    }),
    ...overrides,
  };
}

function proxyPath(noteId, index) {
  return `/api/excellent-contents/${noteId}/images/${index}/file`;
}

test("excellent image proxy requires login", async () => {
  seedCache();
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    buildContext(),
    createReq(proxyPath("n1", 0), ""),
    res,
    proxyPath("n1", 0),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test("excellent image proxy serves cached remote image bytes with correct content type and Pgy headers", async () => {
  seedCache();
  const requestedUrls = [];
  const context = buildContext({
    requestPinnedRemoteImage: async (target, options) => {
      requestedUrls.push(target.parsed.toString());
      assert.equal(String(options.headers.Referer || "").includes("pgy.xiaohongshu.com"), true);
      assert.equal(typeof options.headers["User-Agent"], "string");
      return fakeUpstream({ status: 200, contentType: "image/jpeg", body: JPEG_BUFFER });
    },
  });
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n1", 1)}?board=xhs_hot&contentSource=all`),
    res,
    proxyPath("n1", 1),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("Content-Type"), "image/jpeg");
  assert.equal(res.getHeader("Cache-Control"), "private, max-age=300");
  assert.deepEqual(res.body, JPEG_BUFFER);
  assert.deepEqual(requestedUrls, ["https://ci.xiaohongshu.com/remote/2.jpg"]);
});

test("excellent image proxy never accepts an arbitrary url parameter", async () => {
  seedCache();
  const requestedUrls = [];
  const context = buildContext({
    appConfig: { pgy: { enabled: true, cookie: "sess=test-only" } },
    requestPinnedRemoteImage: async (target) => {
      requestedUrls.push(target.parsed.toString());
      // The cookie follows the cached target, never the attacker-controlled param.
      assert.equal(target.parsed.toString(), "https://ci.xiaohongshu.com/remote/1.jpg");
      return fakeUpstream({});
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n1", 0)}?url=https%3A%2F%2Fevil.example%2Fx.png&board=xhs_hot`),
    res,
    proxyPath("n1", 0),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(requestedUrls, ["https://ci.xiaohongshu.com/remote/1.jpg"]);
});

test("excellent image proxy sends the Pgy cookie only to allowed XHS image domains", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "c1",
        noteId: "c1",
        title: "允许域名",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://ci.xiaohongshu.com/remote/cookie.png"],
        metrics: { readCount: 1 },
      },
      {
        id: "c2",
        noteId: "c2",
        title: "COS 域名",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://bucket.myqcloud.com/cos/cookie.png"],
        metrics: { readCount: 1 },
      },
      {
        id: "c3",
        noteId: "c3",
        title: "恶意域名",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://evil.example/x.png"],
        metrics: { readCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const seen = [];
  const context = buildContext({
    appConfig: { pgy: { enabled: true, cookie: "sess=test-only" } },
    requestPinnedRemoteImage: async (target, options) => {
      seen.push({ url: target.parsed.toString(), cookie: options.headers.Cookie || "" });
      return fakeUpstream({});
    },
  });
  for (const noteId of ["c1", "c2", "c3"]) {
    const res = createRes();
    const handled = await handleExcellentContentRoutes(
      context,
      createReq(`${proxyPath(noteId, 0)}?board=xhs_hot`),
      res,
      proxyPath(noteId, 0),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(seen, [
    { url: "https://ci.xiaohongshu.com/remote/cookie.png", cookie: "sess=test-only" },
    { url: "https://bucket.myqcloud.com/cos/cookie.png", cookie: "" },
    { url: "https://evil.example/x.png", cookie: "" },
  ]);
});

test("normalizeExcellentImageSequence merges cover fields into one stable order-preserving sequence", () => {
  assert.deepEqual(normalizeExcellentImageSequence(null), []);
  assert.deepEqual(normalizeExcellentImageSequence({}), []);
  assert.deepEqual(
    normalizeExcellentImageSequence({ coverUrl: "https://ci.xiaohongshu.com/cover.png" }),
    ["https://ci.xiaohongshu.com/cover.png"],
  );
  assert.deepEqual(
    normalizeExcellentImageSequence({ primaryCoverUrl: "https://ci.xiaohongshu.com/pc.png" }),
    ["https://ci.xiaohongshu.com/pc.png"],
  );
  assert.deepEqual(
    normalizeExcellentImageSequence({
      imageUrls: ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg"],
      coverUrls: ["https://ci.xiaohongshu.com/a.jpg"],
      coverUrl: "",
      primaryCoverUrl: "https://ci.xiaohongshu.com/a.jpg",
    }),
    ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg"],
  );
  assert.deepEqual(
    normalizeExcellentImageSequence({
      imageUrls: ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg"],
      coverUrls: ["https://ci.xiaohongshu.com/c.jpg"],
      coverUrl: "https://ci.xiaohongshu.com/c.jpg",
    }),
    ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg", "https://ci.xiaohongshu.com/c.jpg"],
  );
});

test("excellent image proxy serves cover-only and primaryCover-only records at index 0", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "cv1",
        noteId: "cv1",
        title: "仅封面",
        noteType: "image",
        board: "xhs_hot",
        coverUrl: "https://ci.xiaohongshu.com/cover-only.png",
        metrics: { readCount: 1 },
      },
      {
        id: "cv2",
        noteId: "cv2",
        title: "仅主封面",
        noteType: "image",
        board: "xhs_hot",
        primaryCoverUrl: "https://ci.xiaohongshu.com/primary-cover.png",
        metrics: { readCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const requestedUrls = [];
  const context = buildContext({
    requestPinnedRemoteImage: async (target) => {
      requestedUrls.push(target.parsed.toString());
      return fakeUpstream({});
    },
  });
  for (const noteId of ["cv1", "cv2"]) {
    const res = createRes();
    const handled = await handleExcellentContentRoutes(
      context,
      createReq(`${proxyPath(noteId, 0)}?board=xhs_hot`),
      res,
      proxyPath(noteId, 0),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(requestedUrls, [
    "https://ci.xiaohongshu.com/cover-only.png",
    "https://ci.xiaohongshu.com/primary-cover.png",
  ]);
});

test("excellent image proxy returns 404 for out-of-range index on cover-only records", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "cv3",
        noteId: "cv3",
        title: "仅封面越界",
        noteType: "image",
        board: "xhs_hot",
        coverUrl: "https://ci.xiaohongshu.com/cover-oor.png",
        metrics: { readCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const context = buildContext({
    requestPinnedRemoteImage: async () => {
      throw new Error("proxy must not fetch for an out-of-range cover index");
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("cv3", 1)}?board=xhs_hot`),
    res,
    proxyPath("cv3", 1),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "IMAGE_NOT_FOUND");
});

test("excellent rewrite and proxy agree on stable indices for duplicated covers with multiple images", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "sq1",
        noteId: "sq1",
        title: "重复封面",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg"],
        coverUrls: ["https://ci.xiaohongshu.com/a.jpg"],
        primaryCoverUrl: "https://ci.xiaohongshu.com/a.jpg",
        metrics: { readCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });

  const listRes = createRes();
  await handleExcellentContentRoutes(
    buildContext(),
    createReq("/api/excellent-contents?board=xhs_hot"),
    listRes,
    "/api/excellent-contents",
  );
  assert.equal(listRes.statusCode, 200);
  const sq1 = listRes.body.items.find((item) => item.noteId === "sq1");
  assert.deepEqual(sq1.imageUrls, [
    "/api/excellent-contents/sq1/images/0/file?board=xhs_hot&contentSource=all",
    "/api/excellent-contents/sq1/images/1/file?board=xhs_hot&contentSource=all",
  ]);
  assert.deepEqual(sq1.coverUrls, ["/api/excellent-contents/sq1/images/0/file?board=xhs_hot&contentSource=all"]);
  assert.equal(sq1.primaryCoverUrl, "/api/excellent-contents/sq1/images/0/file?board=xhs_hot&contentSource=all");

  const requestedUrls = [];
  const context = buildContext({
    requestPinnedRemoteImage: async (target) => {
      requestedUrls.push(target.parsed.toString());
      return fakeUpstream({});
    },
  });
  for (const index of [0, 1]) {
    const res = createRes();
    const handled = await handleExcellentContentRoutes(
      context,
      createReq(`${proxyPath("sq1", index)}?board=xhs_hot`),
      res,
      proxyPath("sq1", index),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(requestedUrls, ["https://ci.xiaohongshu.com/a.jpg", "https://ci.xiaohongshu.com/b.jpg"]);
});

test("excellent list rewrite maps cover-only records to index 0 proxy paths", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "cv4",
        noteId: "cv4",
        title: "仅封面重写",
        noteType: "image",
        board: "xhs_hot",
        coverUrl: "https://ci.xiaohongshu.com/cover-rewrite.png",
        metrics: { readCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    buildContext(),
    createReq("/api/excellent-contents?board=xhs_hot"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(res.statusCode, 200);
  const cv4 = res.body.items.find((item) => item.noteId === "cv4");
  assert.equal(cv4.coverUrl, "/api/excellent-contents/cv4/images/0/file?board=xhs_hot&contentSource=all");
});

test("excellent image proxy rejects unknown noteId", async () => {
  seedCache();
  const context = buildContext({
    requestPinnedRemoteImage: async () => {
      throw new Error("proxy must not fetch for an unknown note");
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("nope", 0)}?board=xhs_hot`),
    res,
    proxyPath("nope", 0),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "IMAGE_NOT_FOUND");
});

test("excellent image proxy rejects out-of-range image index", async () => {
  seedCache();
  const context = buildContext({
    requestPinnedRemoteImage: async () => {
      throw new Error("proxy must not fetch for an out-of-range index");
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n1", 9)}?board=xhs_hot`),
    res,
    proxyPath("n1", 9),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "IMAGE_NOT_FOUND");
});

test("excellent image proxy rejects relative URLs (not proxyable)", async () => {
  seedCache();
  const context = buildContext({
    requestPinnedRemoteImage: async () => {
      throw new Error("proxy must not fetch a relative URL");
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n2", 0)}?board=xhs_hot`),
    res,
    proxyPath("n2", 0),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "IMAGE_URL_NOT_PROXYABLE");
});

test("excellent image proxy returns explicit 5xx JSON when upstream fails", async () => {
  seedCache();
  const context = buildContext({
    requestPinnedRemoteImage: async () => fakeUpstream({ status: 403, contentType: "text/plain", body: Buffer.from("forbidden") }),
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n1", 0)}?board=xhs_hot`),
    res,
    proxyPath("n1", 0),
  );
  assert.equal(res.statusCode, 502);
  const body = res.body;
  assert.equal(body.code, "REMOTE_IMAGE_UNAVAILABLE");
  assert.equal(body.upstreamStatus, 403);
  assert.equal(typeof body.error, "string");
});

test("excellent image proxy returns explicit 5xx JSON when upstream body is not an image", async () => {
  seedCache();
  const context = buildContext({
    requestPinnedRemoteImage: async () => fakeUpstream({ status: 200, contentType: "text/plain", body: Buffer.from("not an image") }),
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("n1", 0)}?board=xhs_hot`),
    res,
    proxyPath("n1", 0),
  );
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "REMOTE_IMAGE_NOT_IMAGE");
});

test("excellent list and detail rewrite remote image URLs to same-origin proxy paths and keep relative URLs", async () => {
  seedCache();
  const listRes = createRes();
  await handleExcellentContentRoutes(
    buildContext(),
    createReq("/api/excellent-contents?board=xhs_hot"),
    listRes,
    "/api/excellent-contents",
  );
  assert.equal(listRes.statusCode, 200);
  const n1 = listRes.body.items.find((item) => item.noteId === "n1");
  assert.deepEqual(n1.imageUrls, [
    "/api/excellent-contents/n1/images/0/file?board=xhs_hot&contentSource=all",
    "/api/excellent-contents/n1/images/1/file?board=xhs_hot&contentSource=all",
  ]);
  assert.equal(n1.primaryCoverUrl, "/api/excellent-contents/n1/images/0/file?board=xhs_hot&contentSource=all");
  const n2 = listRes.body.items.find((item) => item.noteId === "n2");
  assert.deepEqual(n2.imageUrls, ["/img/local.jpg"]);
  assert.equal(n2.primaryCoverUrl, "/img/local.jpg");

  const detailRes = createRes();
  await handleExcellentContentRoutes(
    buildContext(),
    createReq("/api/excellent-contents/n1/detail?board=xhs_hot"),
    detailRes,
    "/api/excellent-contents/n1/detail",
  );
  assert.equal(detailRes.statusCode, 200);
  assert.deepEqual(detailRes.body.item.imageUrls, [
    "/api/excellent-contents/n1/images/0/file?board=xhs_hot&contentSource=all",
    "/api/excellent-contents/n1/images/1/file?board=xhs_hot&contentSource=all",
  ]);
});

test("excellent image proxy resolves notes from taxonomy/contentSource scoped caches", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot:buyer",
    categoryPath: "",
    items: [
      {
        id: "buyer-1",
        noteId: "buyer-1",
        title: "买手笔记",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://ci.xiaohongshu.com/remote/buyer.png"],
        metrics: { readCount: 3 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const context = buildContext({
    requestPinnedRemoteImage: async (target) => {
      assert.equal(target.parsed.toString(), "https://ci.xiaohongshu.com/remote/buyer.png");
      return fakeUpstream({ status: 200, contentType: "image/png", body: PNG_BUFFER });
    },
  });
  const res = createRes();
  await handleExcellentContentRoutes(
    context,
    createReq(`${proxyPath("buyer-1", 0)}?board=xhs_hot&contentSource=buyer`),
    res,
    proxyPath("buyer-1", 0),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("Content-Type"), "image/png");
  assert.deepEqual(res.body, PNG_BUFFER);
});
