const DEFAULT_ALLOWED_HEADERS = "Content-Type, X-Session-Token";
const DEFAULT_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

function applyCorsHeaders(req, res, appConfig) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return false;

  const corsConfig = getCorsConfig(appConfig);
  const allowedOrigin = resolveAllowedOrigin(origin, corsConfig);
  if (!allowedOrigin) return false;

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  if (corsConfig.credentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
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

function getCorsConfig(appConfig) {
  const origins = appConfig?.cors?.origins;
  return {
    origins: Array.isArray(origins) ? origins.map((origin) => String(origin || "").trim()).filter(Boolean) : [],
    credentials: appConfig?.cors?.credentials !== false,
  };
}

function resolveAllowedOrigin(origin, corsConfig) {
  if (!corsConfig.origins.length) return "";
  if (corsConfig.origins.includes(origin)) return origin;
  if (corsConfig.origins.includes("*") && !corsConfig.credentials) return "*";
  return "";
}

function validateCorsConfigForStartup(appConfig, env = process.env.NODE_ENV || "") {
  const corsConfig = getCorsConfig(appConfig);
  if (corsConfig.credentials && corsConfig.origins.includes("*")) {
    throw new Error("CORS 配置不安全：credentials=true 时不能使用 wildcard origin。请配置明确的 CORS_ORIGINS。");
  }
  if (String(env).trim() === "production" && !corsConfig.origins.length) {
    throw new Error("生产环境必须显式配置 CORS_ORIGINS 客户前端域名白名单。");
  }
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
  validateCorsConfigForStartup,
};
