const CREDIT_ANALYTICS_METADATA_KEYS = new Set([
  "actionType",
  "projectId",
  "clipIndex",
  "refundForCreditEventId",
  "planId",
  "provider",
  "retryOperation",
]);

const FORBIDDEN_METADATA_KEYS = new Set([
  "generationpayload",
  "prompt",
  "videoscript",
  "slides",
  "imageurl",
  "videourl",
  "previewurl",
  "providerresulturl",
  "objectkey",
  "storedpath",
  "localimage",
  "asset",
  "inputassets",
  "headers",
  "token",
  "apikey",
  "cookie",
  "authorization",
]);

function normalizeMetadataKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function redactAnalyticsText(value, maxLength = 500) {
  return String(value == null ? "" : value)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9+/=]{32,}/g, "[REDACTED]")
    .slice(0, Math.max(0, Number(maxLength || 0)));
}

function sanitizeAnalyticsValue(value, depth = 0) {
  if (depth > 5 || value == null) return value == null ? null : undefined;
  if (typeof value === "string") return redactAnalyticsText(value);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeAnalyticsValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (FORBIDDEN_METADATA_KEYS.has(normalizeMetadataKey(key))) continue;
    const sanitized = sanitizeAnalyticsValue(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function parseMetadataObject(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  if (typeof payload !== "string") return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function sanitizeAnalyticsMetadata(payload) {
  return sanitizeAnalyticsValue(parseMetadataObject(payload)) || {};
}

function buildSafeCreditAnalyticsMetadata(payload) {
  const source = parseMetadataObject(payload);
  const result = {};
  for (const key of CREDIT_ANALYTICS_METADATA_KEYS) {
    const value = source[key];
    if (value == null || !["string", "number", "boolean"].includes(typeof value)) continue;
    result[key] = typeof value === "string" ? redactAnalyticsText(value, 200) : value;
  }
  return result;
}

function sanitizeAnalyticsError(error) {
  if (!error) return "";
  if (error instanceof Error) return redactAnalyticsText(error.message, 500);
  const sanitized = sanitizeAnalyticsValue(error);
  return redactAnalyticsText(typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized || {}), 500);
}

module.exports = {
  buildSafeCreditAnalyticsMetadata,
  redactAnalyticsText,
  sanitizeAnalyticsError,
  sanitizeAnalyticsMetadata,
};
