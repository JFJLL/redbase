const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { PUBLIC_DIR, DIST_PUBLIC_DIR, MIME_TYPES } = require("./config");

// The built Vue frontend lives in dist/public (three entries: /, /app/,
// /admin/). Environments without a build (local dev on the legacy frontend)
// fall back to the old public/ directory automatically.
const ROOT_CACHE_TTL_MS = 2000;
let cachedRoot = null;
let cachedRootAt = 0;

function resolveStaticRoot({ distDir = DIST_PUBLIC_DIR, publicDir = PUBLIC_DIR, now = Date.now() } = {}) {
  if (cachedRoot && now - cachedRootAt < ROOT_CACHE_TTL_MS && cachedRoot.distDir === distDir && cachedRoot.publicDir === publicDir) {
    return cachedRoot;
  }
  const distReady = fsSync.existsSync(path.join(distDir, "index.html"));
  cachedRoot = {
    dir: distReady ? distDir : publicDir,
    distMode: distReady,
    distDir,
    publicDir,
  };
  cachedRootAt = now;
  return cachedRoot;
}

// Map a URL pathname onto a file below the active static root. In dist mode,
// /app/* and /admin/* refreshes rewrite to their SPA entry HTML when the path
// is not an actual build asset. Legacy mode keeps the old /admin -> admin.html
// mapping so an unbuilt checkout behaves exactly as before.
function mapRequestPath(pathname, distMode) {
  if (pathname === "/") return "/index.html";
  if (distMode) {
    if (pathname === "/app" || pathname === "/app/") return "/app/index.html";
    if (pathname === "/admin" || pathname === "/admin/") return "/admin/index.html";
    return pathname;
  }
  if (pathname === "/admin") return "/admin.html";
  return pathname;
}

function spaFallbackPath(pathname, distMode) {
  if (!distMode) return null;
  if (pathname.startsWith("/app/") || pathname === "/app") return "/app/index.html";
  if (pathname.startsWith("/admin/") || pathname === "/admin") return "/admin/index.html";
  return null;
}

async function serveStatic(req, res, pathname, rootOverrides = undefined) {
  const { dir: rootDir, distMode } = resolveStaticRoot(rootOverrides);
  const safePath = mapRequestPath(pathname, distMode);
  const served = await tryServeFile(req, res, rootDir, safePath);
  if (served) return;

  // SPA history-mode refresh: /app/trends, /admin/xxx etc. return the entry
  // HTML; hashed asset misses stay 404 so broken references remain visible.
  const fallbackPath = spaFallbackPath(pathname, distMode);
  if (fallbackPath && !path.extname(safePath)) {
    const fallbackServed = await tryServeFile(req, res, rootDir, fallbackPath);
    if (fallbackServed) return;
  }
  notFound(res);
}

async function tryServeFile(req, res, rootDir, safePath) {
  const filePath = path.join(rootDir, safePath);
  const relativePath = path.relative(rootDir, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  try {
    let targetPath = filePath;
    let stat = await fs.stat(targetPath);
    let headerPath = safePath;
    if (stat.isDirectory()) {
      targetPath = path.join(targetPath, "index.html");
      stat = await fs.stat(targetPath);
      headerPath = "/index.html";
    }

    const headers = buildStaticHeaders(req, targetPath, stat, headerPath);
    if (isNotModified(req, headers)) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const data = await fs.readFile(targetPath);
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch (error) {
    return false;
  }
}

function buildStaticHeaders(req, filePath, stat, safePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": getCacheControl(req, safePath, ext),
    ETag: buildEtag(stat),
    "Last-Modified": stat.mtime.toUTCString(),
  };
  return headers;
}

function getCacheControl(req, safePath, ext) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const hasVersionQuery = requestUrl.searchParams.has("v");
  if (ext === ".html") return "no-cache";
  if (safePath.startsWith("/assets/") || hasVersionQuery) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function buildEtag(stat) {
  return `"${Number(stat.size).toString(16)}-${Number(stat.mtimeMs).toString(16)}"`;
}

function isNotModified(req, headers) {
  const requestEtag = req.headers["if-none-match"];
  if (requestEtag && requestEtag === headers.ETag) return true;
  const modifiedSince = Date.parse(req.headers["if-modified-since"] || "");
  const lastModified = Date.parse(headers["Last-Modified"]);
  return Number.isFinite(modifiedSince) && Number.isFinite(lastModified) && modifiedSince >= lastModified;
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function resetStaticRootCacheForTests() {
  cachedRoot = null;
  cachedRootAt = 0;
}

module.exports = {
  serveStatic,
  resolveStaticRoot,
  mapRequestPath,
  spaFallbackPath,
  resetStaticRootCacheForTests,
};
