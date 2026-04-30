const DEFAULT_ALLOWED_HEADERS = "Content-Type, X-Session-Token";
const DEFAULT_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

function applyCorsHeaders(req, res, appConfig) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return false;

  const allowedOrigins = getAllowedOrigins(appConfig);
  if (!isAllowedOrigin(origin, allowedOrigins)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", DEFAULT_ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || DEFAULT_ALLOWED_HEADERS);
  res.setHeader("Vary", appendVaryOrigin(res.getHeader("Vary")));
  return true;
}

function handleCorsPreflight(req, res, appConfig) {
  if (req.method !== "OPTIONS") return false;
  applyCorsHeaders(req, res, appConfig);
  res.writeHead(204);
  res.end();
  return true;
}

function getAllowedOrigins(appConfig) {
  const origins = appConfig?.cors?.origins;
  return Array.isArray(origins) ? origins.map((origin) => String(origin || "").trim()).filter(Boolean) : [];
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!allowedOrigins.length) return false;
  return allowedOrigins.includes(origin) || allowedOrigins.includes("*");
}

function appendVaryOrigin(value) {
  const current = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!current.some((item) => item.toLowerCase() === "origin")) {
    current.push("Origin");
  }
  return current.join(", ");
}

module.exports = {
  applyCorsHeaders,
  handleCorsPreflight,
};
