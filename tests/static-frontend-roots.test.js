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
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html>legacy-index</html>");
  fs.writeFileSync(path.join(publicDir, "admin.html"), "<html>legacy-admin</html>");
  return { base, distDir, publicDir };
}

function makeRequest(pathname) {
  return { url: pathname, headers: { host: "localhost" } };
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

async function request(pathname, overrides) {
  const res = makeResponse();
  await serveStatic(makeRequest(pathname), res, pathname, overrides);
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

  const asset = await request("/assets/chunk-abc.js", overrides);
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["Cache-Control"], "public, max-age=31536000, immutable");

  const missingAsset = await request("/app/assets/gone-xyz.js", overrides);
  assert.equal(missingAsset.statusCode, 404);

  const outside = await request("/../server.js", overrides);
  assert.equal(outside.statusCode, 404);
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
