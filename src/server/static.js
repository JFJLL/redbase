const fs = require("fs/promises");
const path = require("path");
const { PUBLIC_DIR, MIME_TYPES } = require("./config");

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname === "/admin" ? "/admin.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    notFound(res);
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const nestedIndex = path.join(filePath, "index.html");
      const nestedStat = await fs.stat(nestedIndex);
      const headers = buildStaticHeaders(req, nestedIndex, nestedStat, "/index.html");
      if (isNotModified(req, headers)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      const data = await fs.readFile(nestedIndex);
      res.writeHead(200, headers);
      res.end(data);
      return;
    }

    const headers = buildStaticHeaders(req, filePath, stat, safePath);
    if (isNotModified(req, headers)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, headers);
    res.end(data);
  } catch (error) {
    notFound(res);
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

module.exports = {
  serveStatic,
};
