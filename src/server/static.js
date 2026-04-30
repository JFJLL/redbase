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
      const data = await fs.readFile(nestedIndex);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch (error) {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
}

module.exports = {
  serveStatic,
};
