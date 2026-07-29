const crypto = require("crypto");

const MAX_GENERATED_ASSET_BYTES = 60 * 1024 * 1024;
const GENERATED_IMAGE_MIME_EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});

function validateGeneratedAssetInput(input = {}) {
  const ownerUserId = Number(input.ownerUserId);
  const generationId = Number(input.generationId);
  const variant = String(input.variant || "").trim();
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error("Invalid generated asset owner");
  if (!Number.isSafeInteger(generationId) || generationId <= 0) throw new Error("Invalid generated asset generation");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(variant)) throw new Error("Invalid generated asset variant");
  if (!Buffer.isBuffer(input.buffer)) throw new Error("Generated asset must be a Buffer");
  if (!GENERATED_IMAGE_MIME_EXTENSIONS[mimeType]) throw new Error("Unsupported generated asset MIME type");
  if (input.buffer.length > MAX_GENERATED_ASSET_BYTES) {
    const error = new Error("Generated asset exceeds the 60MB limit");
    error.code = "PAYLOAD_TOO_LARGE";
    throw error;
  }
  if (!doesImageBufferMatchMimeType(input.buffer, mimeType)) {
    throw new Error("Generated asset content does not match its MIME type");
  }
  return { ownerUserId, generationId, variant, mimeType, buffer: input.buffer };
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

function buildGeneratedAssetFileName(generationId, variant, mimeType, randomId = crypto.randomBytes(8).toString("hex")) {
  const extension = GENERATED_IMAGE_MIME_EXTENSIONS[mimeType];
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
  MAX_GENERATED_ASSET_BYTES,
  GENERATED_IMAGE_MIME_EXTENSIONS,
  doesImageBufferMatchMimeType,
  validateGeneratedAssetInput,
  buildGeneratedAssetFileName,
  inferGeneratedAssetProvider,
  isOssNotFoundError,
  isOssObjectNotFoundError,
};
