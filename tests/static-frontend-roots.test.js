const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  serveStatic,
  resolveStaticRoot,
  mapRequestPath,
  spaFallbackPath,
  hasHashedAssetName,
  resetStaticRootCacheForTests,
} = require("../src/server/static");

function makeTempRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-static-"));
  const distDir = path.join(base, "dist-public");
  const publicDir = path.join(base, "public");
  fs.mkdirSync(path.join(distDir, "app"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "admin"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<html>landing</html>");
  fs.writeFileSync(path.join(distDir, "app", "index.html"), "<html>app-entry</html>");
  fs.writeFileSync(path.join(distDir, "admin", "index.html"), "<html>admin-entry</html>");
  fs.writeFileSync(path.join(distDir, "assets", "chunk-abc.js"), "console.log(1);");
  fs.writeFileSync(path.join(distDir, "assets", "chunk-BAs2n8Qq.js"), "console.log(2);");
  fs.writeFileSync(path.join(distDir, "assets", "qrcode.png"), "fake-png-bytes");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html>legacy-index</html>");
  fs.writeFileSync(path.join(publicDir, "admin.html"), "<html>legacy-admin</html>");
  return { base, distDir, publicDir };
}

function makeRequest(pathname, headers = {}) {
  return { url: pathname, headers: { host: "localhost", ...headers } };
}

function makeResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(data) {
      res.body = data === undefined ? null : data;
    },
  };
  return res;
}

async function request(pathname, overrides, headers = {}) {
  const res = makeResponse();
  await serveStatic(makeRequest(pathname, headers), res, pathname, overrides);
  return res;
}

test("static roots: dist/public wins when a build exists, public is the fallback", () => {
  const { distDir, publicDir } = makeTempRoots();
  resetStaticRootCacheForTests();
  const built = resolveStaticRoot({ distDir, publicDir });
  assert.equal(built.distMode, true);
  assert.equal(built.dir, distDir);

  resetStaticRootCacheForTests();
  const missing = resolveStaticRoot({ distDir: path.join(distDir, "nope"), publicDir });
  assert.equal(missing.distMode, false);
  assert.equal(missing.dir, publicDir);
});

test("path mapping: dist mode routes entries, legacy mode keeps admin.html", () => {
  assert.equal(mapRequestPath("/", true), "/index.html");
  assert.equal(mapRequestPath("/app", true), "/app/index.html");
  assert.equal(mapRequestPath("/app/", true), "/app/index.html");
  assert.equal(mapRequestPath("/admin", true), "/admin/index.html");
  assert.equal(mapRequestPath("/app/trends", true), "/app/trends");
  assert.equal(mapRequestPath("/", false), "/index.html");
  assert.equal(mapRequestPath("/admin", false), "/admin.html");
  assert.equal(spaFallbackPath("/app/trends", true), "/app/index.html");
  assert.equal(spaFallbackPath("/admin/users", true), "/admin/index.html");
  assert.equal(spaFallbackPath("/other", true), null);
  assert.equal(spaFallbackPath("/app/trends", false), null);
});

test("dist mode serves the three entries and SPA refresh paths", async () => {
  const { distDir, publicDir } = makeTempRoots();
  const overrides = { distDir, publicDir };
  resetStaticRootCacheForTests();

  const landing = await request("/", overrides);
  assert.equal(landing.statusCode, 200);
  assert.equal(String(landing.body), "<html>landing</html>");

  const appEntry = await request("/app/", overrides);
  assert.equal(String(appEntry.body), "<html>app-entry</html>");

  const appRefresh = await request("/app/trends", overrides);
  assert.equal(appRefresh.statusCode, 200);
  assert.equal(String(appRefresh.body), "<html>app-entry</html>");
  assert.equal(appRefresh.headers["Cache-Control"], "no-cache");

  const adminRefresh = await request("/admin/anything/nested", overrides);
  assert.equal(String(adminRefresh.body), "<html>admin-entry</html>");
});

test("dist mode: missing hashed assets stay 404 instead of returning HTML", async () => {
  const { distDir, publicDir } = makeTempRoots();
  const overrides = { distDir, publicDir };
  resetStaticRootCacheForTests();

  const asset = await request("/assets/chunk-BAs2n8Qq.js", overrides);
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["Cache-Control"], "public, max-age=31536000, immutable");

  const missingAsset = await request("/app/assets/gone-xyz.js", overrides);
  assert.equal(missingAsset.statusCode, 404);

  const outside = await request("/../server.js", overrides);
  assert.equal(outside.statusCode, 404);
});

test("cache policy: only Vite content-hashed filenames get immutable", () => {
  // Real Vite output: name-<8+ base64url chars> mixing case/digits.
  assert.equal(hasHashedAssetName("/assets/chunk-BAs2n8Qq.js"), true);
  assert.equal(hasHashedAssetName("/assets/index-C3xY_9zW.css"), true);
  assert.equal(hasHashedAssetName("/assets/landing-D1qT7fKm2A.webp"), true);
  // Vite default hashes may contain "-" (exactly 8 base64url chars).
  assert.equal(hasHashedAssetName("/assets/AdminDashboardView-DTvmMv-j.js"), true);
  assert.equal(hasHashedAssetName("/assets/landing-BhREy-ry.js"), true);
  // Fixed-name legacy assets must never match, even with long word suffixes.
  assert.equal(hasHashedAssetName("/assets/qrcode.png"), false);
  assert.equal(hasHashedAssetName("/assets/redbase-logo.png"), false);
  assert.equal(hasHashedAssetName("/assets/favicon-32.png"), false);
  assert.equal(hasHashedAssetName("/assets/landing-output-longform.webp"), false);
  assert.equal(hasHashedAssetName("/assets/home-idea-generation.png"), false);
  assert.equal(hasHashedAssetName("/assets/landing-excellent-source-01.webp"), false);
  assert.equal(hasHashedAssetName("/assets/banner-20260701.png"), false);
  assert.equal(hasHashedAssetName("/assets/chunk-abc.js"), false);
  assert.equal(hasHashedAssetName("/index.html"), false);
});

test("cache policy: fixed-name assets revalidate (no immutable) and support 304", async () => {
  const { distDir, publicDir } = makeTempRoots();
  const overrides = { distDir, publicDir };
  resetStaticRootCacheForTests();

  // Unhashed name inside /assets/ must NOT be immutable anymore.
  const qrcode = await request("/assets/qrcode.png", overrides);
  assert.equal(qrcode.statusCode, 200);
  assert.equal(qrcode.headers["Cache-Control"], "no-cache");
  assert.ok(qrcode.headers.ETag, "fixed-name asset keeps an ETag for revalidation");
  assert.ok(qrcode.headers["Last-Modified"], "fixed-name asset keeps Last-Modified");

  // Conditional revalidation answers 304 without a body.
  const revalidated = await request("/assets/qrcode.png", overrides, { "if-none-match": qrcode.headers.ETag });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, null);

  // A ?v= query no longer grants immutable to an unhashed file.
  const versionedRes = makeResponse();
  await serveStatic(makeRequest("/assets/qrcode.png?v=3"), versionedRes, "/assets/qrcode.png", overrides);
  assert.equal(versionedRes.statusCode, 200);
  assert.equal(versionedRes.headers["Cache-Control"], "no-cache");

  // Short/unhashed chunk-style names revalidate too.
  const unhashedChunk = await request("/assets/chunk-abc.js", overrides);
  assert.equal(unhashedChunk.statusCode, 200);
  assert.equal(unhashedChunk.headers["Cache-Control"], "no-cache");

  // HTML stays no-cache.
  const landing = await request("/", overrides);
  assert.equal(landing.headers["Cache-Control"], "no-cache");
});

test("legacy mode without a build keeps the original behavior", async () => {
  const { distDir, publicDir } = makeTempRoots();
  const overrides = { distDir: path.join(distDir, "missing"), publicDir };
  resetStaticRootCacheForTests();

  const index = await request("/", overrides);
  assert.equal(String(index.body), "<html>legacy-index</html>");

  const admin = await request("/admin", overrides);
  assert.equal(String(admin.body), "<html>legacy-admin</html>");

  const spa = await request("/app/trends", overrides);
  assert.equal(spa.statusCode, 404);
});
