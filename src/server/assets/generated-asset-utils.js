const crypto = require("crypto");

const DEFAULT_GENERATED_IMAGE_ASSET_BYTES = 60 * 1024 * 1024;
const DEFAULT_VIDEO_CLIP_ASSET_BYTES = 256 * 1024 * 1024;
const DEFAULT_VIDEO_FINAL_ASSET_BYTES = 1024 * 1024 * 1024;
// Kept as a compatibility alias for callers that only handle images. Video
// paths must use the explicit clip/final limits below.
const MAX_GENERATED_ASSET_BYTES = DEFAULT_GENERATED_IMAGE_ASSET_BYTES;
const GENERATED_IMAGE_MIME_EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});
const GENERATED_VIDEO_MIME_EXTENSIONS = Object.freeze({
  "video/mp4": "mp4",
});

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveGeneratedAssetMaxBytes(input = {}, limits = {}) {
  const explicit = Number(input.maxBytes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  const storedPath = String(input.storedPath || input.objectKey || input.filePath || "").trim().toLowerCase();
  const imagePath = /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/.test(storedPath);
  if (mimeType.startsWith("image/") || imagePath) {
    return positiveLimit(limits.imageMaxBytes, DEFAULT_GENERATED_IMAGE_ASSET_BYTES);
  }
  if (String(input.variant || "").trim() === "final") {
    return positiveLimit(limits.videoFinalMaxBytes, DEFAULT_VIDEO_FINAL_ASSET_BYTES);
  }
  return positiveLimit(limits.videoClipMaxBytes, DEFAULT_VIDEO_CLIP_ASSET_BYTES);
}

function validateGeneratedAssetMetadata(input = {}, limits = {}) {
  const ownerUserId = Number(input.ownerUserId);
  const generationId = Number(input.generationId);
  const variant = String(input.variant || "").trim();
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error("Invalid generated asset owner");
  if (!Number.isSafeInteger(generationId) || generationId <= 0) throw new Error("Invalid generated asset generation");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(variant)) throw new Error("Invalid generated asset variant");
  if (!GENERATED_IMAGE_MIME_EXTENSIONS[mimeType] && !GENERATED_VIDEO_MIME_EXTENSIONS[mimeType]) throw new Error("Unsupported generated asset MIME type");
  return {
    ownerUserId,
    generationId,
    variant,
    mimeType,
    maxBytes: resolveGeneratedAssetMaxBytes({ ...input, mimeType, variant }, limits),
  };
}

function formatAssetLimit(maxBytes) {
  const megabytes = Number(maxBytes) / (1024 * 1024);
  if (Number.isInteger(megabytes)) return `${megabytes}MB`;
  return `${Math.round(megabytes * 10) / 10}MB`;
}

function createAssetTooLargeError(maxBytes) {
  const error = new Error(`Generated asset exceeds the ${formatAssetLimit(maxBytes)} limit`);
  error.code = "PAYLOAD_TOO_LARGE";
  error.maxBytes = maxBytes;
  return error;
}

function validateGeneratedAssetInput(input = {}, limits = {}) {
  const metadata = validateGeneratedAssetMetadata(input, limits);
  if (!Buffer.isBuffer(input.buffer)) throw new Error("Generated asset must be a Buffer");
  if (input.buffer.length > metadata.maxBytes) {
    const error = createAssetTooLargeError(metadata.maxBytes);
    error.code = "PAYLOAD_TOO_LARGE";
    throw error;
  }
  if (!doesImageBufferMatchMimeType(input.buffer, metadata.mimeType) && !doesVideoBufferMatchMimeType(input.buffer, metadata.mimeType)) {
    throw new Error("Generated asset content does not match its MIME type");
  }
  return { ...metadata, buffer: input.buffer };
}

function doesImageBufferMatchMimeType(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function doesVideoBufferMatchMimeType(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || mimeType !== "video/mp4" || buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

function buildGeneratedAssetFileName(generationId, variant, mimeType, randomId = crypto.randomBytes(8).toString("hex")) {
  const extension = GENERATED_IMAGE_MIME_EXTENSIONS[mimeType] || GENERATED_VIDEO_MIME_EXTENSIONS[mimeType];
  return `gi_${generationId}_${variant}_${randomId}.${extension}`;
}

function inferGeneratedAssetProvider(asset) {
  if (asset?.provider === "aliyun_oss" || asset?.objectKey) return "aliyun_oss";
  return "local";
}

function isOssNotFoundError(error) {
  return [404, "404"].includes(error?.status) ||
    [404, "404"].includes(error?.statusCode) ||
    ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error?.code || error?.name || ""));
}

function isOssObjectNotFoundError(error) {
  return ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error?.code || error?.name || ""));
}

module.exports = {
  DEFAULT_GENERATED_IMAGE_ASSET_BYTES,
  DEFAULT_VIDEO_CLIP_ASSET_BYTES,
  DEFAULT_VIDEO_FINAL_ASSET_BYTES,
  MAX_GENERATED_ASSET_BYTES,
  GENERATED_IMAGE_MIME_EXTENSIONS,
  GENERATED_VIDEO_MIME_EXTENSIONS,
  doesImageBufferMatchMimeType,
  doesVideoBufferMatchMimeType,
  resolveGeneratedAssetMaxBytes,
  validateGeneratedAssetMetadata,
  validateGeneratedAssetInput,
  createAssetTooLargeError,
  formatAssetLimit,
  buildGeneratedAssetFileName,
  inferGeneratedAssetProvider,
  isOssNotFoundError,
  isOssObjectNotFoundError,
};
