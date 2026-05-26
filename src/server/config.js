const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = process.env.REDBASE_DB_FILE || path.join(DATA_DIR, "redbase.sqlite");
const CONFIG_FILE = path.join(ROOT, "config.local.json");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3013);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const DEFAULT_APP_CONFIG = {
  textProvider: {
    apiStyle: "google",
    model: "gemini-3.1-flash-lite-preview",
    baseUrl: "https://api.im-red-magic.cn",
    openaiBaseUrl: "",
    anthropicBaseUrl: "",
    apiKey: "",
    searchEnabled: true,
    maxOutputTokens: 65536,
  },
  imageProvider: {
    baseUrl: "https://api.wavespeed.ai/api/v3/openai/gpt-image-2/text-to-image",
    editBaseUrl: "https://api.wavespeed.ai/api/v3/openai/gpt-image-2/edit",
    uploadBaseUrl: "https://api.wavespeed.ai/api/v3/media/upload/binary",
    model: "gpt-image-2",
    apiKey: "",
    aspectRatio: "3:4",
    resolution: "2k",
    quality: "medium",
    imageCount: 1,
  },
  admin: {
    phones: [],
  },
  feishu: {
    enabled: false,
    appId: "",
    appSecret: "",
    tenantKey: "",
    tenantKeys: [],
    apps: [],
    baseUrl: "",
  },
  cors: {
    origins: [],
  },
  security: {
    assetSigningSecret: "",
  },
  pgy: {
    enabled: false,
    cookie: "",
    cookieFile: "",
    userAgent: "",
    timeoutMs: 20000,
    cacheTtlMs: 600000,
    allowSearchFallback: false,
    ossEndpoint: "",
    ossBucket: "",
    ossObjectKey: "",
    ossAccessKeyId: "",
    ossAccessKeySecret: "",
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return structuredClone(base);
  }

  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base && typeof base[key] === "object") {
      result[key] = deepMerge(base[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function parseBooleanConfig(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function loadAppConfig() {
  let localConfig = {};

  if (fs.existsSync(CONFIG_FILE)) {
    localConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }

  const merged = deepMerge(DEFAULT_APP_CONFIG, localConfig);
  const hasFeishuCredentials = Boolean(
      process.env.FEISHU_APP_ID ||
      process.env.FEISHU_APP_SECRET ||
      process.env.FEISHU_TENANT_KEY ||
      process.env.FEISHU_TENANT_KEYS ||
      merged.feishu?.appId ||
      merged.feishu?.appSecret ||
      merged.feishu?.tenantKey ||
      (Array.isArray(merged.feishu?.tenantKeys) && merged.feishu.tenantKeys.length) ||
      (Array.isArray(merged.feishu?.apps) && merged.feishu.apps.length),
  );
  const hasPgyCookieSource = Boolean(
    process.env.PGY_CONTENT_SQUARE_COOKIE ||
      process.env.PGY_CONTENT_SQUARE_COOKIE_FILE ||
      process.env.PGY_COOKIE_FILE ||
      process.env.PGY_OSS_ACCESS_KEY_ID ||
      merged.pgy?.cookie ||
      merged.pgy?.cookieFile ||
      merged.pgy?.ossAccessKeyId,
  );

  return {
    textProvider: {
      apiStyle: String(process.env.TEXT_API_STYLE || merged.textProvider.apiStyle || "google").trim(),
      model: String(process.env.TEXT_MODEL || merged.textProvider.model || "").trim(),
      baseUrl: String(process.env.TEXT_BASE_URL || merged.textProvider.baseUrl || "").trim(),
      openaiBaseUrl: String(process.env.TEXT_OPENAI_BASE_URL || merged.textProvider.openaiBaseUrl || "").trim(),
      anthropicBaseUrl: String(process.env.TEXT_ANTHROPIC_BASE_URL || merged.textProvider.anthropicBaseUrl || "").trim(),
      apiKey: String(process.env.TEXT_API_KEY || merged.textProvider.apiKey || "").trim(),
      searchEnabled: String(process.env.TEXT_SEARCH_ENABLED || merged.textProvider.searchEnabled || "true").trim() !== "false",
      maxOutputTokens: Number(process.env.TEXT_MAX_OUTPUT_TOKENS || merged.textProvider.maxOutputTokens || 65536),
    },
    imageProvider: {
      baseUrl: String(process.env.IMAGE_BASE_URL || merged.imageProvider.baseUrl || "").trim(),
      editBaseUrl: String(process.env.IMAGE_EDIT_BASE_URL || merged.imageProvider.editBaseUrl || "").trim(),
      uploadBaseUrl: String(process.env.IMAGE_UPLOAD_BASE_URL || merged.imageProvider.uploadBaseUrl || "").trim(),
      model: String(process.env.IMAGE_MODEL || merged.imageProvider.model || "").trim(),
      apiKey: String(process.env.IMAGE_API_KEY || merged.imageProvider.apiKey || "").trim(),
      aspectRatio: String(process.env.IMAGE_ASPECT_RATIO || merged.imageProvider.aspectRatio || "3:4").trim(),
      resolution: String(process.env.IMAGE_RESOLUTION || merged.imageProvider.resolution || "2k").trim(),
      quality: String(process.env.IMAGE_QUALITY || merged.imageProvider.quality || "medium").trim(),
      imageCount: Number(process.env.IMAGE_COUNT || merged.imageProvider.imageCount || 1),
    },
    admin: {
      phones: String(process.env.ADMIN_PHONES || "")
        .split(",")
        .map((phone) => phone.trim())
        .filter(Boolean)
        .concat(Array.isArray(merged.admin?.phones) ? merged.admin.phones.map((phone) => String(phone || "").trim()).filter(Boolean) : [])
        .filter((phone, index, all) => all.indexOf(phone) === index),
    },
    feishu: normalizeFeishuConfig(merged.feishu, hasFeishuCredentials),
    cors: {
      origins: String(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .concat(Array.isArray(merged.cors?.origins) ? merged.cors.origins.map((origin) => String(origin || "").trim()).filter(Boolean) : [])
        .filter((origin, index, all) => all.indexOf(origin) === index),
    },
    security: {
      assetSigningSecret: String(process.env.ASSET_SIGNING_SECRET || merged.security?.assetSigningSecret || "").trim(),
      cookieSecure: parseBooleanConfig(
        process.env.COOKIE_SECURE,
        parseBooleanConfig(merged.security?.cookieSecure, process.env.NODE_ENV === "production"),
      ),
    },
    pgy: {
      enabled: parseBooleanConfig(process.env.PGY_CONTENT_SQUARE_ENABLED, parseBooleanConfig(merged.pgy?.enabled, hasPgyCookieSource)),
      cookie: String(process.env.PGY_CONTENT_SQUARE_COOKIE || merged.pgy?.cookie || "").trim(),
      cookieFile: String(process.env.PGY_CONTENT_SQUARE_COOKIE_FILE || process.env.PGY_COOKIE_FILE || merged.pgy?.cookieFile || "").trim(),
      userAgent: String(process.env.PGY_CONTENT_SQUARE_USER_AGENT || merged.pgy?.userAgent || "").trim(),
      timeoutMs: Number(process.env.PGY_CONTENT_SQUARE_TIMEOUT_MS || merged.pgy?.timeoutMs || 20000),
      cacheTtlMs: Number(process.env.PGY_CONTENT_SQUARE_CACHE_TTL_MS || merged.pgy?.cacheTtlMs || 10 * 60 * 1000),
      allowSearchFallback: parseBooleanConfig(
        process.env.PGY_CONTENT_SQUARE_ALLOW_SEARCH_FALLBACK,
        parseBooleanConfig(merged.pgy?.allowSearchFallback, false),
      ),
      ossEndpoint: String(process.env.PGY_OSS_ENDPOINT || merged.pgy?.ossEndpoint || "").trim(),
      ossBucket: String(process.env.PGY_OSS_BUCKET || merged.pgy?.ossBucket || "").trim(),
      ossObjectKey: String(process.env.PGY_OSS_OBJECT_KEY || merged.pgy?.ossObjectKey || "").trim(),
      ossAccessKeyId: String(process.env.PGY_OSS_ACCESS_KEY_ID || merged.pgy?.ossAccessKeyId || "").trim(),
      ossAccessKeySecret: String(process.env.PGY_OSS_ACCESS_KEY_SECRET || merged.pgy?.ossAccessKeySecret || "").trim(),
    },
  };
}

function normalizeFeishuConfig(feishu, hasFeishuCredentials) {
  const appId = String(process.env.FEISHU_APP_ID || feishu?.appId || "").trim();
  const appSecret = String(process.env.FEISHU_APP_SECRET || feishu?.appSecret || "").trim();
  const tenantKey = String(process.env.FEISHU_TENANT_KEY || feishu?.tenantKey || "").trim();
  const tenantKeys = parseListConfig(
    process.env.FEISHU_TENANT_KEYS,
    feishu?.tenantKeys,
    process.env.FEISHU_TENANT_KEY || feishu?.tenantKey,
  );
  const baseUrl = String(process.env.FEISHU_BASE_URL || process.env.BASE_URL || feishu?.baseUrl || "").trim();
  const legacyApp = appId || appSecret || tenantKeys.length
    ? [{ key: "default", name: "飞书企业", appId, appSecret, tenantKeys }]
    : [];
  const apps = normalizeFeishuApps(Array.isArray(feishu?.apps) && feishu.apps.length ? feishu.apps : legacyApp);

  return {
    enabled: parseBooleanConfig(process.env.FEISHU_AUTH_ENABLED, parseBooleanConfig(feishu?.enabled, hasFeishuCredentials)),
    appId,
    appSecret,
    tenantKey,
    tenantKeys,
    apps,
    baseUrl,
  };
}

function normalizeFeishuApps(apps) {
  return apps
    .map((app, index) => {
      const key = String(app?.key || app?.name || `app-${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const tenantKeys = parseListConfig("", app?.tenantKeys, app?.tenantKey);
      return {
        key: key || `app-${index + 1}`,
        name: String(app?.name || app?.key || `飞书企业 ${index + 1}`).trim(),
        appId: String(app?.appId || "").trim(),
        appSecret: String(app?.appSecret || "").trim(),
        tenantKey: String(app?.tenantKey || "").trim(),
        tenantKeys,
      };
    })
    .filter((app, index, all) => app.key && all.findIndex((item) => item.key === app.key) === index);
}

function parseListConfig(envValue, localValue, legacyValue = "") {
  const source = envValue !== undefined && envValue !== null && envValue !== "" ? envValue : localValue;
  const values = Array.isArray(source) ? source : String(source || "").split(",");
  const normalized = values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!normalized.length && legacyValue) {
    normalized.push(String(legacyValue).trim());
  }
  return normalized.filter((value, index, all) => all.indexOf(value) === index);
}

module.exports = {
  ROOT,
  PUBLIC_DIR,
  DATA_DIR,
  DB_FILE,
  CONFIG_FILE,
  HOST,
  PORT,
  MIME_TYPES,
  DEFAULT_APP_CONFIG,
  loadAppConfig,
};
