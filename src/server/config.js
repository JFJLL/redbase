const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ENV_FILE = path.join(ROOT, ".env");
loadProjectEnvFile(PROJECT_ENV_FILE);
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_PUBLIC_DIR = path.join(ROOT, "dist", "public");
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
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const DEFAULT_APP_CONFIG = {
  textProvider: {
    apiStyle: "openai",
    model: "deepseek/deepseek-v4-flash",
    rerankModel: "",
    baseUrl: "",
    openaiBaseUrl: "https://llm.runninghub.ai/v1",
    anthropicBaseUrl: "",
    apiKey: "",
    useImageProviderApiKey: false,
    searchEnabled: false,
    maxOutputTokens: 65536,
  },
  searchProvider: {
    enabled: false,
    type: "anysearch",
    baseUrl: "https://api.anysearch.com/mcp",
    apiKey: "",
    apiKeys: [],
    apiKeyFile: "",
    apiKeyFiles: [],
    domain: "general",
    subDomain: "general.general",
    socialEnabled: true,
    socialDomain: "social_media",
    socialSubDomain: "social_media.social_media",
    maxResultsPerQuery: 6,
    maxEvidence: 8,
    maxSocialEvidence: 2,
    minReliableEvidence: 2,
    maxSnippetChars: 520,
    timeoutMs: 30000,
    retries: 3,
    retryDelayMs: 350,
    dailyQueryLimit: 950,
    dailyUsageFile: "data/anysearch-usage.json",
    urlCheckEnabled: true,
    urlCheckTimeoutMs: 3500,
    cacheTtlMs: 600000,
    maxCacheEntries: 100,
  },
  imageProvider: {
    provider: "wavespeed",
    baseUrl: "https://api.wavespeed.ai/api/v3/openai/gpt-image-2/text-to-image",
    editBaseUrl: "https://api.wavespeed.ai/api/v3/openai/gpt-image-2/edit",
    uploadBaseUrl: "https://api.wavespeed.ai/api/v3/media/upload/binary",
    queryBaseUrl: "",
    model: "gpt-image-2",
    apiKey: "",
    aspectRatio: "3:4",
    resolution: "2k",
    quality: "medium",
    imageCount: 1,
    sendTextResolution: true,
    sendQuality: true,
  },
  assetStorage: {
    provider: "local",
    aliyunOss: {
      endpoint: "",
      bucket: "",
      prefix: "",
      accessKeyId: "",
      accessKeySecret: "",
    },
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
    credentials: true,
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

function readEnvOverride(env, name, fallback) {
  return Object.prototype.hasOwnProperty.call(env || {}, name) ? String(env[name] ?? "").trim() : String(fallback || "").trim();
}

function normalizeOssPrefix(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function resolveAssetStorageConfig(localConfig = {}, env = process.env, options = {}) {
  const defaults = DEFAULT_APP_CONFIG.assetStorage.aliyunOss;
  const configured = localConfig?.assetStorage?.aliyunOss || {};
  const aliyunOss = {
    endpoint: readEnvOverride(env, "ALIYUN_OSS_ENDPOINT", configured.endpoint ?? defaults.endpoint),
    bucket: readEnvOverride(env, "ALIYUN_OSS_BUCKET", configured.bucket ?? defaults.bucket),
    prefix: normalizeOssPrefix(readEnvOverride(env, "ALIYUN_OSS_PREFIX", configured.prefix ?? defaults.prefix)),
    accessKeyId: readEnvOverride(env, "ALIYUN_OSS_ACCESS_KEY_ID", configured.accessKeyId ?? defaults.accessKeyId),
    accessKeySecret: readEnvOverride(env, "ALIYUN_OSS_ACCESS_KEY_SECRET", configured.accessKeySecret ?? defaults.accessKeySecret),
  };
  const invalid = [];
  try {
    const endpoint = new URL(aliyunOss.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
      invalid.push("ALIYUN_OSS_ENDPOINT");
    }
  } catch (error) {
    invalid.push("ALIYUN_OSS_ENDPOINT");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(aliyunOss.bucket)) invalid.push("ALIYUN_OSS_BUCKET");
  const prefixSegments = aliyunOss.prefix.split("/");
  if (
    !aliyunOss.prefix ||
    aliyunOss.prefix.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(aliyunOss.prefix) ||
    prefixSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) invalid.push("ALIYUN_OSS_PREFIX");

  const missing = [];
  if (!aliyunOss.endpoint) missing.push("ALIYUN_OSS_ENDPOINT");
  if (!aliyunOss.bucket) missing.push("ALIYUN_OSS_BUCKET");
  if (!aliyunOss.prefix) missing.push("ALIYUN_OSS_PREFIX");
  if (!aliyunOss.accessKeyId) missing.push("ALIYUN_OSS_ACCESS_KEY_ID");
  if (!aliyunOss.accessKeySecret) missing.push("ALIYUN_OSS_ACCESS_KEY_SECRET");

  const explicitEnvironment = [
    "ALIYUN_OSS_ENDPOINT",
    "ALIYUN_OSS_BUCKET",
    "ALIYUN_OSS_PREFIX",
    "ALIYUN_OSS_ACCESS_KEY_ID",
    "ALIYUN_OSS_ACCESS_KEY_SECRET",
  ].some((name) => Object.prototype.hasOwnProperty.call(env || {}, name));
  const explicitlyConfigured = explicitEnvironment || Boolean(localConfig?.assetStorage);
  const issues = [...new Set([...missing, ...invalid])];
  if (explicitlyConfigured && issues.length && options.warn !== false) {
    const logger = options.logger || console;
    logger.warn(`[asset-storage] aliyun_oss disabled; missing or invalid configuration: ${issues.join(", ")}`);
  }

  return {
    provider: issues.length ? "local" : "aliyun_oss",
    aliyunOss,
    configurationIssues: issues,
  };
}

function loadProjectEnvFile(filePath = PROJECT_ENV_FILE) {
  const resolvedPath = path.resolve(String(filePath || PROJECT_ENV_FILE));
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return false;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(resolvedPath);
    return true;
  }
  const raw = fs.readFileSync(resolvedPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separatorIndex = trimmed.indexOf("=");
    const name = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name] !== undefined) continue;
    process.env[name] = trimmed.slice(separatorIndex + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return true;
}

function readEnvValueFile(filePath, keyName) {
  const configuredPath = String(filePath || "").trim();
  if (!configuredPath) return "";
  const resolvedPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(ROOT, configuredPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return "";
  const raw = fs.readFileSync(resolvedPath, "utf8").trim();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separatorIndex = trimmed.indexOf("=");
    const name = trimmed.slice(0, separatorIndex).trim();
    if (name !== keyName) continue;
    return trimmed.slice(separatorIndex + 1).trim().replace(/^["']+|["']+$/g, "");
  }
  return lines.length === 1 && !raw.includes("=") ? raw : "";
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
  const imageProviderName = String(process.env.IMAGE_PROVIDER || merged.imageProvider.provider || "wavespeed").trim().toLowerCase();
  const imageProviderApiKey = String(process.env.IMAGE_API_KEY || merged.imageProvider.apiKey || "").trim();
  const useImageProviderApiKey = parseBooleanConfig(
    process.env.TEXT_USE_IMAGE_PROVIDER_API_KEY,
    parseBooleanConfig(merged.textProvider?.useImageProviderApiKey, false),
  );
  const anySearchApiKeyFile = String(process.env.ANYSEARCH_API_KEY_FILE || merged.searchProvider?.apiKeyFile || "").trim();
  const anySearchApiKeyFiles = parseListConfig(
    process.env.ANYSEARCH_API_KEY_FILES,
    merged.searchProvider?.apiKeyFiles,
  );
  const anySearchApiKeys = [
    String(process.env.ANYSEARCH_API_KEY || "").trim(),
    ...parseListConfig(process.env.ANYSEARCH_API_KEYS, merged.searchProvider?.apiKeys),
    String(merged.searchProvider?.apiKey || "").trim(),
    readEnvValueFile(anySearchApiKeyFile, "ANYSEARCH_API_KEY"),
    ...anySearchApiKeyFiles.map((filePath) => readEnvValueFile(filePath, "ANYSEARCH_API_KEY")),
  ]
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  const anySearchApiKey = anySearchApiKeys[0] || "";

  return {
    assetStorage: resolveAssetStorageConfig(localConfig),
    textProvider: {
      apiStyle: String(process.env.TEXT_API_STYLE || merged.textProvider.apiStyle || "google").trim(),
      model: String(process.env.TEXT_MODEL || merged.textProvider.model || "").trim(),
      // Optional low-cost reranker model for trend evidence slotting; falls back
      // to the main text model when unset.
      rerankModel: String(process.env.TREND_RERANK_MODEL || merged.textProvider.rerankModel || "").trim(),
      baseUrl: String(process.env.TEXT_BASE_URL || merged.textProvider.baseUrl || "").trim(),
      openaiBaseUrl: String(process.env.TEXT_OPENAI_BASE_URL || merged.textProvider.openaiBaseUrl || "").trim(),
      anthropicBaseUrl: String(process.env.TEXT_ANTHROPIC_BASE_URL || merged.textProvider.anthropicBaseUrl || "").trim(),
      apiKey: String(
        process.env.TEXT_API_KEY ||
          (useImageProviderApiKey ? imageProviderApiKey : merged.textProvider.apiKey) ||
          "",
      ).trim(),
      useImageProviderApiKey,
      searchEnabled: parseBooleanConfig(
        process.env.TEXT_SEARCH_ENABLED,
        parseBooleanConfig(merged.textProvider.searchEnabled, false),
      ),
      maxOutputTokens: Number(process.env.TEXT_MAX_OUTPUT_TOKENS || merged.textProvider.maxOutputTokens || 65536),
    },
    searchProvider: {
      enabled: parseBooleanConfig(process.env.ANYSEARCH_ENABLED, parseBooleanConfig(merged.searchProvider?.enabled, false)),
      type: "anysearch",
      baseUrl: String(process.env.ANYSEARCH_BASE_URL || merged.searchProvider?.baseUrl || "https://api.anysearch.com/mcp").trim(),
      apiKey: anySearchApiKey,
      apiKeys: anySearchApiKeys,
      apiKeyFile: anySearchApiKeyFile,
      apiKeyFiles: anySearchApiKeyFiles,
      domain: String(process.env.ANYSEARCH_DOMAIN || merged.searchProvider?.domain || "general").trim(),
      subDomain: String(process.env.ANYSEARCH_SUB_DOMAIN || merged.searchProvider?.subDomain || "general.general").trim(),
      socialEnabled: parseBooleanConfig(
        process.env.ANYSEARCH_SOCIAL_ENABLED,
        parseBooleanConfig(merged.searchProvider?.socialEnabled, true),
      ),
      socialDomain: String(process.env.ANYSEARCH_SOCIAL_DOMAIN || merged.searchProvider?.socialDomain || "social_media").trim(),
      socialSubDomain: String(
        process.env.ANYSEARCH_SOCIAL_SUB_DOMAIN || merged.searchProvider?.socialSubDomain || "social_media.social_media",
      ).trim(),
      maxResultsPerQuery: Number(
        process.env.ANYSEARCH_MAX_RESULTS_PER_QUERY || merged.searchProvider?.maxResultsPerQuery || 6,
      ),
      maxEvidence: Number(process.env.ANYSEARCH_MAX_EVIDENCE || merged.searchProvider?.maxEvidence || 8),
      maxSocialEvidence: Number(
        process.env.ANYSEARCH_MAX_SOCIAL_EVIDENCE || merged.searchProvider?.maxSocialEvidence || 2,
      ),
      minReliableEvidence: Number(
        process.env.ANYSEARCH_MIN_RELIABLE_EVIDENCE || merged.searchProvider?.minReliableEvidence || 2,
      ),
      maxSnippetChars: Number(process.env.ANYSEARCH_MAX_SNIPPET_CHARS || merged.searchProvider?.maxSnippetChars || 520),
      timeoutMs: Number(process.env.ANYSEARCH_TIMEOUT_MS || merged.searchProvider?.timeoutMs || 30000),
      // AnySearch currently resolves to four CDN edges and one edge can be
      // unreachable from mainland direct-connect servers. Keep enough retries
      // to visit every resolved edge even when an older config file says 1/2.
      retries: Math.max(3, Number(process.env.ANYSEARCH_RETRIES || merged.searchProvider?.retries || 3)),
      retryDelayMs: Number(process.env.ANYSEARCH_RETRY_DELAY_MS || merged.searchProvider?.retryDelayMs || 350),
      dailyQueryLimit: Number(
        process.env.ANYSEARCH_DAILY_QUERY_LIMIT || merged.searchProvider?.dailyQueryLimit || 950,
      ),
      dailyUsageFile: String(
        process.env.ANYSEARCH_DAILY_USAGE_FILE || merged.searchProvider?.dailyUsageFile || "data/anysearch-usage.json",
      ).trim(),
      urlCheckEnabled: parseBooleanConfig(
        process.env.ANYSEARCH_URL_CHECK_ENABLED,
        parseBooleanConfig(merged.searchProvider?.urlCheckEnabled, true),
      ),
      urlCheckTimeoutMs: Number(
        process.env.ANYSEARCH_URL_CHECK_TIMEOUT_MS || merged.searchProvider?.urlCheckTimeoutMs || 3500,
      ),
      cacheTtlMs: Number(process.env.ANYSEARCH_CACHE_TTL_MS || merged.searchProvider?.cacheTtlMs || 600000),
      maxCacheEntries: Number(
        process.env.ANYSEARCH_MAX_CACHE_ENTRIES || merged.searchProvider?.maxCacheEntries || 100,
      ),
    },
    imageProvider: {
      provider: imageProviderName,
      baseUrl: String(process.env.IMAGE_BASE_URL || merged.imageProvider.baseUrl || "").trim(),
      editBaseUrl: String(process.env.IMAGE_EDIT_BASE_URL || merged.imageProvider.editBaseUrl || "").trim(),
      uploadBaseUrl: String(process.env.IMAGE_UPLOAD_BASE_URL || merged.imageProvider.uploadBaseUrl || "").trim(),
      queryBaseUrl: String(process.env.IMAGE_QUERY_BASE_URL || merged.imageProvider.queryBaseUrl || "").trim(),
      model: String(process.env.IMAGE_MODEL || (imageProviderName === "wavespeed" ? merged.imageProvider.model : "")).trim(),
      apiKey: imageProviderApiKey,
      aspectRatio: String(process.env.IMAGE_ASPECT_RATIO || merged.imageProvider.aspectRatio || "3:4").trim(),
      resolution: String(process.env.IMAGE_RESOLUTION || merged.imageProvider.resolution || "2k").trim(),
      quality: String(process.env.IMAGE_QUALITY || merged.imageProvider.quality || "medium").trim(),
      imageCount: Number(process.env.IMAGE_COUNT || merged.imageProvider.imageCount || 1),
      sendTextResolution: parseBooleanConfig(
        process.env.IMAGE_SEND_TEXT_RESOLUTION,
        parseBooleanConfig(merged.imageProvider.sendTextResolution, true),
      ),
      sendQuality: parseBooleanConfig(process.env.IMAGE_SEND_QUALITY, parseBooleanConfig(merged.imageProvider.sendQuality, true)),
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
      credentials: parseBooleanConfig(process.env.CORS_CREDENTIALS, parseBooleanConfig(merged.cors?.credentials, true)),
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
  DIST_PUBLIC_DIR,
  DATA_DIR,
  DB_FILE,
  CONFIG_FILE,
  HOST,
  PORT,
  MIME_TYPES,
  DEFAULT_APP_CONFIG,
  loadProjectEnvFile,
  readEnvValueFile,
  normalizeOssPrefix,
  resolveAssetStorageConfig,
  loadAppConfig,
};
