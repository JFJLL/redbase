const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { jsonrepair } = require("jsonrepair");
const { signLocalAssetUrls } = require("./assets/signed-urls");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const LOG_DIR = path.join(ROOT_DIR, "logs");

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone || ""));
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

function assertConfigured(value, label) {
  if (!String(value || "").trim()) {
    throw new Error(`${label} 未配置，请通过环境变量配置，例如 TEXT_API_KEY 或 IMAGE_API_KEY。`);
  }
}

function maskKey(value) {
  const text = String(value || "").trim();
  if (text.length <= 8) return text ? "****" : "";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 85;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeTags(tags, fallbackTags = []) {
  const source = Array.isArray(tags) ? tags : [];
  const next = source
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("#") ? item : `#${item}`));

  const merged = [...next, ...fallbackTags].filter(Boolean);
  return [...new Set(merged)].slice(0, 5);
}

function sanitizeIdea(idea, fallbackAudience, fallbackTag) {
  const contentAssets =
    idea?.contentAssets && typeof idea.contentAssets === "object" && !Array.isArray(idea.contentAssets)
      ? idea.contentAssets
      : {};
  return {
    title: String(idea?.title ?? ""),
    summary: String(idea?.summary ?? ""),
    angle: String(idea?.angle ?? ""),
    brandFit: String(idea?.brandFit ?? ""),
    audience: String(idea?.audience ?? fallbackAudience ?? ""),
    hook: String(idea?.hook ?? ""),
    tags: normalizeTags(idea?.tags, fallbackTag ? [fallbackTag] : []),
    contentAssets: sanitizePayloadForClient(contentAssets),
  };
}

function sanitizeTrendEvidence(item) {
  return {
    provider: String(item?.provider || ""),
    id: String(item?.id || ""),
    title: String(item?.title || ""),
    url: String(item?.url || ""),
    source: String(item?.source || ""),
    host: String(item?.host || ""),
    publishedAt: String(item?.publishedAt || ""),
    snippet: String(item?.snippet || ""),
    sourceType: String(item?.sourceType || ""),
    platformType: String(item?.platformType || ""),
    trustLevel: String(item?.trustLevel || ""),
    retrievedAt: String(item?.retrievedAt || ""),
    ...(item?.metrics && typeof item.metrics === "object" && !Array.isArray(item.metrics)
      ? { metrics: sanitizePayloadForClient(item.metrics) }
      : {}),
  };
}

function sanitizeTrend(trend) {
  return {
    id: trend.id,
    stableKey: trend.stableKey || "",
    rank: trend.rank,
    title: trend.title,
    category: trend.category,
    summary: trend.summary,
    score: trend.score,
    tags: normalizeTags(trend.tags),
    evidenceIds: Array.isArray(trend.evidenceIds) ? trend.evidenceIds.map((item) => String(item || "")) : [],
    evidence: Array.isArray(trend.evidence) ? trend.evidence.map((item) => sanitizeTrendEvidence(item)) : [],
    reason: trend.reason,
    ideas: Array.isArray(trend.ideas) ? trend.ideas.map((idea) => sanitizeIdea(idea)) : [],
    customPrompt: trend.customPrompt || "",
  };
}

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "systemPrompt",
  "system_prompt",
  "prompt",
  "editPrompt",
  "stylePrompt",
  "provider",
  "model",
  "providerResultUrl",
  "providerHeaders",
  "responseBody",
  "upstreamPayload",
  "sourceStoredPath",
  "source",
  "original",
  "providerResult",
  "storedPath",
  "objectKey",
  "bucket",
  "endpoint",
  "accessKeyId",
  "accessKeySecret",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "cookie",
  "localImage",
  "generatedAsset",
  "assetStorage",
].map((key) => key.toLowerCase()));

function isSensitivePayloadKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (SENSITIVE_PAYLOAD_KEYS.has(normalized)) return true;
  const compact = normalized.replace(/[-_]/g, "");
  if (["localimage", "generatedasset", "assetstorage"].includes(compact)) return true;
  if (["key", "stablekey", "bucketkey", "sourcekey", "pagerolekey"].includes(compact)) return false;
  if ([
    "secret", "apikey", "privatekey", "clientsecret", "securitytoken", "ststoken", "sessiontoken",
    "auth", "basicauth", "authheader", "sessionid", "sid", "accesscode", "passphrase", "dsn", "clientassertion",
    "idtoken", "oauthtoken", "bearertoken", "jwttoken", "accountkey", "subscriptionkey", "serviceaccountkey",
  ].includes(compact)) return true;
  return compact.endsWith("key") ||
    compact.endsWith("token") ||
    compact.includes("secret") ||
    compact.includes("connectionstring") ||
    compact.includes("accesskey") ||
    compact.includes("authorization") ||
    compact.includes("credential") ||
    compact.includes("signature") ||
    compact.includes("password") ||
    compact.includes("cookie");
}

const SAFE_CLIENT_PAYLOAD_KEYS = new Set([
  "id", "key", "stableKey", "bucketKey", "sourceKey", "type", "kind", "variant", "mode", "generatedMode", "status", "error", "persistError",
  "index", "slideIndex", "position", "order", "page", "pageNumber", "pageLabel", "pageRole", "pageRoleKey", "pageTask", "pageTitle", "pageCopy",
  "title", "subtitle", "heading", "eyebrow", "text", "content", "copy", "caption", "summary", "description", "intro", "outline", "positioning", "body", "footer", "cta", "hook",
  "publishTitle", "publishCaption", "visualDirection", "visualStyle", "visualStylePreset", "style", "composition", "layout", "scene", "background", "palette", "tone", "theme",
  "imageUrl", "previewUrl", "imageUrls", "aspectRatio", "width", "height", "mimeType", "sizeBytes", "createdAt", "updatedAt",
  "moments", "xhsCarousel", "wechatLongImage", "slides", "sections", "items", "cards", "pages", "tags", "bullets", "editHistory", "editId", "parentEditId",
  "carouselGroupId", "expectedSlideCount", "slideJobIds", "isGenerating", "isQueued", "isEditing",
  "brandId", "brandName", "trendId", "trendTitle", "ideaTitle", "analysisId", "sourceAnalysisId",
  "contentMode", "contentDirection", "contentThesis", "contentGoal", "targetAudience", "userScene", "trendUsed", "learningFocus",
  "brandPlacement", "sourceLearningApplied", "platformVisualGuidance", "originalityGuard", "remixBrief",
  "sourceNoteId", "sourceTitle", "sourceBoard", "sourceCategoryPath", "sourceIndustryPath", "sourceImageCount", "sourceReadCount", "sourceEngagementCount",
  "readCount", "likeCount", "favoriteCount", "commentCount", "shareCount", "engagementCount",
  "useBrandLogo", "productImageIds", "productImages", "name", "url", "dataUrl", "originalName", "assetType", "lastUsedAt", "duplicate",
  "requestId", "videoScript", "creativeConcept", "totalDurationSec", "globalSubjectReference", "globalStyleReference", "globalContinuity",
  "audioDirection", "music", "ambience", "voiceStyle", "clips", "startSec", "endSec", "durationSec", "purpose", "referenceAssets",
  "subjectReference", "firstFrame", "lastFrame", "subjectAction", "cameraMovement", "environmentMotion", "lightingAndStyle", "audioPrompt",
  "voiceover", "dialogue", "onScreenText", "transition", "continuity", "stylePrompt", "videoDuration",
  "projectId", "videoModel", "videoMode", "videoResolution", "videoStatus", "finalVideoUrl", "videoClips", "script", "visualBible",
  "model", "generationDurationSec", "dependsOnClipIndex", "continuityMode", "referenceAssetIds", "continuityState", "creditCost", "attempt", "retryCount", "videoUrl", "continuityFrameUrl", "estimatedCredits", "chargedCredits", "refundedCredits", "prompt",
  "styleReferenceImageUsed", "styleReferenceImageCount", "styleReferenceImageName", "referenceImageUsed", "referenceImageCount",
].map((key) => key.toLowerCase()));

const SAFE_IMAGE_URL_QUERY_KEYS = new Set(["width", "height", "w", "h", "format", "quality", "q", "fit", "crop", "resize", "dpr"]);

function redactSensitiveUrlQuery(value) {
  const input = String(value || "");
  const isRelative = input.startsWith("/");
  let parsed;
  try {
    parsed = new URL(input, isRelative ? "http://redbase.local" : undefined);
  } catch (error) {
    return "";
  }
  if (!isRelative && parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (!SAFE_IMAGE_URL_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  return isRelative ? `${parsed.pathname}${parsed.search}` : parsed.toString();
}

function sanitizePayloadForClient(value, parentKey = "") {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string" && /url/i.test(parentKey)) return redactSensitiveUrlQuery(item);
      return sanitizePayloadForClient(item, parentKey);
    });
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const lowerKey = String(key).toLowerCase();
        if (lowerKey === "prompt" && parentKey === "clips") return true;
        return !isSensitivePayloadKey(key) && SAFE_CLIENT_PAYLOAD_KEYS.has(lowerKey);
      })
      .map(([key, child]) => {
        if (typeof child === "string" && /url$/i.test(key)) {
          return [key, redactSensitiveUrlQuery(child)];
        }
        return [key, sanitizePayloadForClient(child, key)];
      }),
  );
}

function isTrendBucket(value) {
  return value && typeof value === "object" && Array.isArray(value.items);
}

function getDefaultTrendBucket() {
  return {
    key: "global",
    title: "全网热点指数",
    description: "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
  };
}

function normalizeTrendBuckets(trends) {
  const source = Array.isArray(trends) ? trends : [];
  if (!source.length) return [];

  if (!source.some(isTrendBucket)) {
    const bucket = getDefaultTrendBucket();
    return [
      {
        ...bucket,
        items: source.map(sanitizeTrend),
      },
    ];
  }

  return source.map((bucket, index) => {
    const fallback = index === 0 ? getDefaultTrendBucket() : {};
    return {
      key: String(bucket.key || fallback.key || `bucket-${index + 1}`),
      title: String(bucket.title || fallback.title || "热点趋势"),
      description: String(bucket.description || fallback.description || "适合当前品牌借势的热点方向。"),
      items: Array.isArray(bucket.items) ? bucket.items.map(sanitizeTrend) : [],
    };
  });
}

function flattenTrendBuckets(trends) {
  const buckets = normalizeTrendBuckets(trends);
  return buckets.flatMap((bucket) =>
    bucket.items.map((trend) => ({
      ...trend,
      bucketKey: bucket.key,
      bucketTitle: bucket.title,
      bucketDescription: bucket.description,
    })),
  );
}

function sanitizeGeneration(item, appConfig) {
  const sanitized = {
    id: item.id,
    ownerUserId: item.ownerUserId,
    type: item.type,
    channelLabel: item.channelLabel,
    brandId: item.brandId,
    brandName: item.brandName,
    trendId: item.trendId,
    trendTitle: item.trendTitle,
    ideaTitle: item.ideaTitle,
    cardTitle: item.cardTitle,
    createdAt: item.createdAt,
    previewUrl: redactSensitiveUrlQuery(item.previewUrl || ""),
    summary: item.summary || "",
    payload: sanitizePayloadForClient(item.payload || {}),
  };
  return appConfig ? signLocalAssetUrls(sanitized, appConfig) : sanitized;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    accountType: user.accountType || "customer",
    department: user.department || "",
    credits: Number(user.credits || 0),
  };
}

function sanitizeBrand(brand) {
  return {
    id: brand.id,
    ownerUserId: brand.ownerUserId,
    name: brand.name,
    industry: brand.industry,
    audience: brand.audience,
    description: brand.description,
    product: brand.product,
    goal: brand.goal,
    knowledgeBase: brand.knowledgeBase || "",
    profileType: brand.profileType === "personal" ? "personal" : "brand",
    contentPillars: Array.isArray(brand.contentPillars) ? brand.contentPillars : [],
    personaStyle: brand.personaStyle || "",
    materialCount: Number(brand.materialCount || brand.materials?.length || 0),
    logo: brand.logo
      ? {
          originalName: brand.logo.originalName || "brand-logo",
          url: `/api/brands/${brand.id}/logo/file`,
          mimeType: brand.logo.mimeType || "",
          sizeBytes: Number(brand.logo.sizeBytes || 0),
          createdAt: brand.logo.createdAt || "",
          updatedAt: brand.logo.updatedAt || "",
        }
      : null,
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
    analyses: Array.isArray(brand.analyses)
      ? brand.analyses.map((analysis) => ({
          id: analysis.id,
          name: analysis.name,
          timestamp: analysis.timestamp,
          brandBrief: analysis.brandBrief && typeof analysis.brandBrief === "object" && !Array.isArray(analysis.brandBrief) ? analysis.brandBrief : {},
          trendSnapshot: normalizeTrendBuckets(analysis.trendSnapshot),
        }))
      : [],
    trends: normalizeTrendBuckets(brand.trends),
  };
}

function sanitizeBrandSummary(brand) {
  return {
    id: brand.id,
    ownerUserId: brand.ownerUserId,
    name: brand.name,
    industry: brand.industry,
    audience: brand.audience,
    description: brand.description,
    profileType: brand.profileType === "personal" ? "personal" : "brand",
    contentPillars: Array.isArray(brand.contentPillars) ? brand.contentPillars : [],
    personaStyle: brand.personaStyle || "",
    materialCount: Number(brand.materialCount || 0),
    logo: brand.logo
      ? {
          originalName: brand.logo.originalName || "brand-logo",
          url: `/api/brands/${brand.id}/logo/file`,
          mimeType: brand.logo.mimeType || "",
          sizeBytes: Number(brand.logo.sizeBytes || 0),
          createdAt: brand.logo.createdAt || "",
          updatedAt: brand.logo.updatedAt || "",
        }
      : null,
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
    trendCount: Number(brand.trendCount || 0),
    analysisCount: Number(brand.analysisCount || 0),
  };
}

function createBrandAssetTags(payload) {
  const tags = [];
  if (payload.industry) tags.push(String(payload.industry).trim());
  if (payload.profileType === "personal") {
    tags.push("个人IP");
    if (Array.isArray(payload.contentPillars)) {
      tags.push(...payload.contentPillars.slice(0, 2));
    }
    if (payload.personaStyle) tags.push("个人表达");
    tags.push("内容运营");
    return [...new Set(tags.filter(Boolean))].slice(0, 5);
  }
  if (String(payload.goal || "").includes("品牌")) tags.push("品牌认知");
  if (String(payload.goal || "").includes("销量") || String(payload.goal || "").includes("转化")) tags.push("种草转化");
  if (payload.product) tags.push("产品卖点");
  if (payload.knowledgeBase) tags.push("品牌资料库");
  tags.push("内容运营");
  return [...new Set(tags.filter(Boolean))].slice(0, 5);
}

function parseJsonFromModelText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("模型返回为空。");
  }

  const candidates = [trimmed];
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()).filter(Boolean);
  candidates.push(...fencedMatches);

  const balancedJson = extractBalancedJson(trimmed);
  if (balancedJson) candidates.push(balancedJson);

  let lastError = null;
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const looseCandidate = repairLooseJson(candidate);
    const repairedCandidates = [candidate, looseCandidate];
    for (const value of [candidate, looseCandidate]) {
      try {
        repairedCandidates.push(jsonrepair(value));
      } catch (error) {
        lastError = error;
      }
    }
    for (const next of [...new Set(repairedCandidates.filter(Boolean))]) {
      try {
        return JSON.parse(next);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw new Error(lastError?.message ? `模型返回不是有效 JSON：${lastError.message}` : "模型返回不是有效 JSON。");
}

function extractBalancedJson(text) {
  const source = String(text || "");
  const startCandidates = [source.indexOf("{"), source.indexOf("[")].filter((index) => index >= 0);
  if (!startCandidates.length) return "";
  const start = Math.min(...startCandidates);
  const stack = [];
  let inString = false;
  let escapeNext = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.length && stack[stack.length - 1] === char) {
        stack.pop();
        if (!stack.length) return source.slice(start, index + 1);
      }
    }
  }

  const firstBrace = source.indexOf("{", start);
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return source.slice(firstBrace, lastBrace + 1);
  }
  return "";
}

function repairLooseJson(text) {
  return String(text || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/^json\s*/i, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableNetworkError(error) {
  if (error?.retryable === false) return false;
  const message = String(error?.message || "");
  const code = String(error?.code || "").toUpperCase();
  return (
    Number(error?.statusCode) === 429 ||
    Number(error?.statusCode) >= 500 ||
    ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("ECONNRESET") ||
    message.includes("ENOTFOUND") ||
    message.includes("Connection aborted") ||
    message.includes("Connect Timeout Error") ||
    message.includes("Client network socket disconnected before secure TLS connection was established")
  );
}

async function withRetries(task, { retries = 3, delayMs = 1500 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetriableNetworkError(error)) {
        throw error;
      }
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

function formatTimestamp(date = new Date()) {
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatLogTimestamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`,
  ].join(" ");
}

function formatLogDate(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function serializeLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  return util.inspect(value, {
    depth: 8,
    colors: false,
    breakLength: 140,
    maxArrayLength: 100,
    maxStringLength: 4000,
  });
}

function appendRuntimeLog(method, line, date = new Date()) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = formatLogDate(date);
    fs.appendFile(path.join(LOG_DIR, `redbase-${day}.log`), `${line}\n`, "utf8", () => {});
    if (method === "warn" || method === "error") {
      fs.appendFile(path.join(LOG_DIR, `redbase-error-${day}.log`), `${line}\n`, "utf8", () => {});
    }
  } catch (error) {
    // Logging must never break the request path.
  }
}

function normalizeChineseCopy(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([，。！？；：、“”‘’（）《》])\s+/g, "$1")
    .replace(/\s+([，。！？；：、“”‘’（）《》])/g, "$1")
    .replace(/([（《“‘])\s+/g, "$1")
    .replace(/\s+([）》”’])/g, "$1")
    .trim();
}

function pickVariant(seed, options) {
  const text = String(seed || "");
  const score = [...text].reduce((total, char) => total + char.charCodeAt(0), 0);
  return options[score % options.length];
}

function installTimestampedConsole() {
  if (console.__redbaseTimestamped) return;

  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const now = new Date();
      const timestamp = formatLogTimestamp(now);
      const line = `[${timestamp}] [${method.toUpperCase()}] ${args.map(serializeLogArg).join(" ")}`;
      appendRuntimeLog(method, line, now);
      original(`[${timestamp}]`, ...args);
    };
  }

  process.on("uncaughtException", (error) => {
    console.error("[process] uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandledRejection", reason);
  });

  Object.defineProperty(console, "__redbaseTimestamped", {
    value: true,
    configurable: false,
    enumerable: false,
  });
}

module.exports = {
  randomId,
  randomToken,
  isValidPhone,
  joinUrl,
  assertConfigured,
  maskKey,
  clampScore,
  normalizeTags,
  sanitizeIdea,
  sanitizeTrend,
  sanitizePayloadForClient,
  redactSensitiveUrlQuery,
  normalizeTrendBuckets,
  flattenTrendBuckets,
  sanitizeGeneration,
  sanitizeUser,
  sanitizeBrand,
  sanitizeBrandSummary,
  createBrandAssetTags,
  parseJsonFromModelText,
  sleep,
  withRetries,
  formatTimestamp,
  formatLogTimestamp,
  normalizeChineseCopy,
  pickVariant,
  installTimestampedConsole,
};
