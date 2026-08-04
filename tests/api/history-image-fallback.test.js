const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-history-image-fallback-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "api.sqlite");

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { upsertGeneration } = require("../../src/server/db/repositories/generation-repository");
const { handleHistoryRoutes } = require("../../src/server/api/history-routes");
const {
  serveStoredGeneratedImage,
  fetchRemoteImageBytes,
  isPgyCookieDomain,
} = require("../../src/server/assets/image-store");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "History Fallback Tester",
  phone: "13910000006",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-07-01T00:00:00.000Z",
});
insertSession({ token: "route-token", userId: 1, createdAt: "2026-07-01T00:00:00.000Z" });

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

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
      this.body = data;
    },
  };
}

function missingFileStorage() {
  return {
    readBuffer: async () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    },
  };
}

function fallbackFetchStub(expectedUrl, buffer = PNG_BUFFER) {
  return async (url, options = {}) => {
    assert.equal(url, expectedUrl);
    assert.equal(String(options.headers?.Referer || "").includes("pgy.xiaohongshu.com"), true);
    return { buffer, mimeType: "image/png" };
  };
}

test("serveStoredGeneratedImage falls back to originalUrl when local file is missing", async () => {
  const res = createRes();
  await serveStoredGeneratedImage(
    res,
    {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_50_slide_1_gone.png",
      mimeType: "image/png",
      originalUrl: "https://rh-hk-images.example.com/output/a.png",
    },
    missingFileStorage(),
    null,
    { fetchRemoteImage: fallbackFetchStub("https://rh-hk-images.example.com/output/a.png") },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("Content-Type"), "image/png");
  assert.equal(res.getHeader("Cache-Control"), "private, max-age=300");
  assert.deepEqual(res.body, PNG_BUFFER);
});

test("serveStoredGeneratedImage falls back when no local asset exists but originalUrl is remote", async () => {
  const res = createRes();
  await serveStoredGeneratedImage(
    res,
    {
      mimeType: "image/png",
      originalUrl: "https://rh-hk-images.example.com/output/b.png",
    },
    missingFileStorage(),
    null,
    { fetchRemoteImage: fallbackFetchStub("https://rh-hk-images.example.com/output/b.png") },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("Content-Type"), "image/png");
  assert.equal(res.getHeader("Cache-Control"), "private, max-age=300");
  assert.deepEqual(res.body, PNG_BUFFER);
});

function fakeSafeImageTarget(imageUrl) {
  return { parsed: new URL(imageUrl), addresses: [{ address: "93.184.216.34", family: 4 }] };
}

function fakeImageResponse({ status, location = "", contentType = "image/png", body = PNG_BUFFER } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => body,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "location") return location;
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

test("isPgyCookieDomain only allows exact XHS/Pgy apex hosts and subdomains", () => {
  for (const allowed of [
    "xiaohongshu.com",
    "xhscdn.com",
    "ci.xiaohongshu.com",
    "pgy.xiaohongshu.com",
    "edith.xiaohongshu.com",
    "sns-img-qc.xhscdn.com",
    "CI.XIAOHONGSHU.COM",
    "ci.xiaohongshu.com.",
  ]) {
    assert.equal(isPgyCookieDomain(allowed), true, allowed);
  }
  for (const denied of [
    "myqcloud.com",
    "bucket.myqcloud.com",
    "evil.example",
    "notxiaohongshu.com",
    "xiaohongshu.com.evil.example",
    "example.com",
    "",
  ]) {
    assert.equal(isPgyCookieDomain(denied), false, denied);
  }
});

test("serveStoredGeneratedImage sends the Pgy cookie only for allowed history originalUrls", async () => {
  const seen = [];
  const sharedOptions = {
    appConfig: { pgy: { cookie: "sess=test-only" } },
    fetchRemoteImage: async (url, options = {}) => {
      seen.push({ url, cookie: options.headers?.Cookie || "" });
      return { buffer: PNG_BUFFER, mimeType: "image/png" };
    },
  };

  const xhsRes = createRes();
  await serveStoredGeneratedImage(
    xhsRes,
    {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_61_xhs_gone.png",
      mimeType: "image/png",
      originalUrl: "https://ci.xiaohongshu.com/history/61.png",
    },
    missingFileStorage(),
    null,
    sharedOptions,
  );
  assert.equal(xhsRes.statusCode, 200);

  const cosRes = createRes();
  await serveStoredGeneratedImage(
    cosRes,
    {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_60_cos_gone.png",
      mimeType: "image/png",
      originalUrl: "https://bucket.myqcloud.com/history/60.png",
    },
    missingFileStorage(),
    null,
    sharedOptions,
  );
  assert.equal(cosRes.statusCode, 200);
  assert.equal(cosRes.getHeader("Cache-Control"), "private, max-age=300");

  assert.deepEqual(seen, [
    { url: "https://ci.xiaohongshu.com/history/61.png", cookie: "sess=test-only" },
    { url: "https://bucket.myqcloud.com/history/60.png", cookie: "" },
  ]);
});

test("fetchRemoteImageBytes rebuilds headers per hop and drops the Pgy cookie across domains", async () => {
  const appConfig = { pgy: { cookie: "sess=test-only" } };
  const hops = [];
  const requestImage = async (target, options) => {
    hops.push({ url: target.parsed.toString(), cookie: options.headers.Cookie || "" });
    if (hops.length === 1) {
      return fakeImageResponse({ status: 302, location: "https://bucket.myqcloud.com/redirected/a.png" });
    }
    return fakeImageResponse({ status: 200 });
  };
  const fetched = await fetchRemoteImageBytes("https://ci.xiaohongshu.com/remote/a.png", {
    appConfig,
    requestImage,
    assertSafe: async (imageUrl) => fakeSafeImageTarget(imageUrl),
    readBuffer: async (response) => Buffer.from(await response.arrayBuffer()),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.buffer, PNG_BUFFER);
  assert.deepEqual(hops, [
    { url: "https://ci.xiaohongshu.com/remote/a.png", cookie: "sess=test-only" },
    { url: "https://bucket.myqcloud.com/redirected/a.png", cookie: "" },
  ]);
});

test("fetchRemoteImageBytes keeps the Pgy cookie when redirecting between allowed XHS domains", async () => {
  const hops = [];
  const requestImage = async (target, options) => {
    hops.push({ url: target.parsed.toString(), cookie: options.headers.Cookie || "" });
    if (hops.length === 1) {
      return fakeImageResponse({ status: 302, location: "https://edith.xiaohongshu.com/remote/b.png" });
    }
    return fakeImageResponse({ status: 200 });
  };
  const fetched = await fetchRemoteImageBytes("https://ci.xiaohongshu.com/remote/a.png", {
    appConfig: { pgy: { cookie: "sess=test-only" } },
    requestImage,
    assertSafe: async (imageUrl) => fakeSafeImageTarget(imageUrl),
    readBuffer: async (response) => Buffer.from(await response.arrayBuffer()),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual(hops, [
    { url: "https://ci.xiaohongshu.com/remote/a.png", cookie: "sess=test-only" },
    { url: "https://edith.xiaohongshu.com/remote/b.png", cookie: "sess=test-only" },
  ]);
});

test("fetchRemoteImageBytes sends no cookie for COS history originalUrl", async () => {
  const hops = [];
  const requestImage = async (target, options) => {
    hops.push({ url: target.parsed.toString(), cookie: options.headers.Cookie || "" });
    return fakeImageResponse({ status: 200 });
  };
  const fetched = await fetchRemoteImageBytes("https://bucket.myqcloud.com/history/a.png", {
    appConfig: { pgy: { cookie: "sess=test-only" } },
    requestImage,
    assertSafe: async (imageUrl) => fakeSafeImageTarget(imageUrl),
    readBuffer: async (response) => Buffer.from(await response.arrayBuffer()),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual(hops, [{ url: "https://bucket.myqcloud.com/history/a.png", cookie: "" }]);
});

test("serveStoredGeneratedImage returns 404 when both local asset and originalUrl are missing", async () => {
  const res = createRes();
  await serveStoredGeneratedImage(res, { mimeType: "image/png" }, missingFileStorage());
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body.toString()).error, "Not found");
});

test("serveStoredGeneratedImage returns 404 when local read fails and originalUrl is not remote", async () => {
  const res = createRes();
  await serveStoredGeneratedImage(
    res,
    {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_50_slide_1_gone.png",
      originalUrl: "/api/generated-images/50/file",
    },
    missingFileStorage(),
    null,
    { fetchRemoteImage: async () => { throw new Error("must not fetch a relative fallback"); } },
  );
  assert.equal(res.statusCode, 404);
});

test("serveStoredGeneratedImage returns 502 JSON when remote fallback fails", async () => {
  const res = createRes();
  await serveStoredGeneratedImage(
    res,
    {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_50_slide_1_gone.png",
      originalUrl: "https://rh-hk-images.example.com/output/c.png",
    },
    missingFileStorage(),
    null,
    {
      fetchRemoteImage: async () => {
        throw Object.assign(new Error("upstream 403"), { code: "REMOTE_IMAGE_UPSTREAM_ERROR", status: 403 });
      },
    },
  );
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body.toString()).code, "REMOTE_IMAGE_UNAVAILABLE");
});

function seedGeneration(id, payload) {
  upsertGeneration({
    id,
    ownerUserId: 1,
    brandId: 10,
    brandName: "Route Brand",
    trendId: 1,
    trendTitle: "Route Trend",
    ideaTitle: "Route Idea",
    cardTitle: `生成 ${id}`,
    createdAt: "2026-07-30T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    type: "moments",
    channelLabel: "朋友圈图",
    payload,
  });
}

test("history generated-image route serves remote fallback bytes through the shared asset chain", async () => {
  seedGeneration(50, {
    localImage: {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_50_main_gone.png",
      mimeType: "image/png",
      originalUrl: "https://rh-hk-images.example.com/output/50.png",
    },
  });
  const context = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    historyRetentionNowMs: Date.now(),
    verifySignedAssetRequest: () => true,
    serveStoredGeneratedImage: (res, asset, generation) =>
      serveStoredGeneratedImage(res, asset, missingFileStorage(), generation, {
        fetchRemoteImage: fallbackFetchStub("https://rh-hk-images.example.com/output/50.png"),
      }),
  };
  const res = createRes();
  await handleHistoryRoutes(
    context,
    { method: "GET", url: "/api/generated-images/50/file", headers: { host: "localhost:3013", cookie: "redbase_session=route-token" } },
    res,
    "/api/generated-images/50/file",
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("Content-Type"), "image/png");
  assert.equal(res.getHeader("Cache-Control"), "private, max-age=300");
  assert.deepEqual(res.body, PNG_BUFFER);
});

test("history generated-image route keeps 401 for missing/expired signatures", async () => {
  seedGeneration(51, {
    localImage: {
      storedPath: "uploads/generated-images/users/1/2026/07/gi_51_main_gone.png",
      originalUrl: "https://rh-hk-images.example.com/output/51.png",
    },
  });
  const context = {
    appConfig: { security: { assetSigningSecret: "test-secret" } },
    historyRetentionNowMs: Date.now(),
  };
  const res = createRes();
  await handleHistoryRoutes(
    context,
    { method: "GET", url: "/api/generated-images/51/file", headers: { host: "localhost:3013", cookie: "redbase_session=route-token" } },
    res,
    "/api/generated-images/51/file",
  );
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body.toString()).error.includes("图片链接已失效"), true);
});
