const crypto = require("crypto");

const PROCESS_ASSET_SIGNING_SECRET = crypto.randomBytes(32).toString("base64url");
const DEFAULT_ASSET_URL_TTL_MS = 10 * 60 * 1000;

function getAssetSigningSecret(appConfig) {
  return String(appConfig?.security?.assetSigningSecret || PROCESS_ASSET_SIGNING_SECRET);
}

function isSignableAssetUrl(value) {
  const text = String(value || "");
  const legacyAsset = (
    text.startsWith("/api/product-images/") ||
    text.startsWith("/api/brands/") ||
    text.startsWith("/api/generated-images/")
  ) && text.includes("/file");
  const videoAsset = text.startsWith("/api/video-projects/") && text.includes("/assets/");
  return legacyAsset || videoAsset;
}

function canonicalizeAssetUrl(url) {
  const parsed = new URL(String(url || ""), "http://redbase.local");
  parsed.searchParams.delete("assetExpires");
  parsed.searchParams.delete("assetSignature");
  const entries = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(entries).toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

function signCanonicalValue(appConfig, canonicalValue, expiresAt) {
  return crypto
    .createHmac("sha256", getAssetSigningSecret(appConfig))
    .update(`${canonicalValue}:${expiresAt}`)
    .digest("base64url");
}

function getStableAssetExpiry(options = {}) {
  const ttlMs = Number(options.ttlMs ?? DEFAULT_ASSET_URL_TTL_MS);
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || options.stable === false) {
    return nowMs + ttlMs;
  }
  return Math.floor(nowMs / ttlMs) * ttlMs + ttlMs * 2;
}

function signAssetUrl(appConfig, value, options = {}) {
  const text = String(value || "");
  if (!isSignableAssetUrl(text)) return text;
  const expiresAt = getStableAssetExpiry(options);
  const canonicalValue = canonicalizeAssetUrl(text);
  const signature = signCanonicalValue(appConfig, canonicalValue, expiresAt);
  const parsed = new URL(text, "http://redbase.local");
  parsed.searchParams.set("assetExpires", String(expiresAt));
  parsed.searchParams.set("assetSignature", signature);
  return `${parsed.pathname}${parsed.search}`;
}

function verifySignedAssetRequest(appConfig, req) {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const expiresAt = Number(parsed.searchParams.get("assetExpires") || 0);
    const signature = String(parsed.searchParams.get("assetSignature") || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) return false;
    const canonicalValue = canonicalizeAssetUrl(`${parsed.pathname}${parsed.search}`);
    const expected = signCanonicalValue(appConfig, canonicalValue, expiresAt);
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch (error) {
    return false;
  }
}

function signLocalAssetUrls(value, appConfig) {
  if (typeof value === "string") return signAssetUrl(appConfig, value);
  if (Array.isArray(value)) return value.map((item) => signLocalAssetUrls(item, appConfig));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, signLocalAssetUrls(child, appConfig)]));
}

module.exports = {
  signAssetUrl,
  verifySignedAssetRequest,
  signLocalAssetUrls,
  getStableAssetExpiry,
};
