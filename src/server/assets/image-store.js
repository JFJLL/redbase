const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { DATA_DIR } = require("../config");
const { signAssetUrl, verifySignedAssetRequest, signLocalAssetUrls } = require("./signed-urls");
const {
  randomId,
  sanitizeGeneration: baseSanitizeGeneration,
  sanitizeBrand: baseSanitizeBrand,
  sanitizeBrandSummary: baseSanitizeBrandSummary,
} = require("../utils");
const { notFound } = require("../api/http-utils");

const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_SELECTION_COUNT = 10;
const MAX_PRODUCT_IMAGE_SELECTION_BYTES = 30 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
const PRODUCT_IMAGE_MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function removeGenerationLocalFiles(generation) {
  const storedPaths = collectGenerationStoredPaths(generation);
  for (const storedPath of storedPaths) {
    try {
      const absolutePath = resolveStoredAssetPath(storedPath);
      await removeStoredFileIfExists(absolutePath);
      await removeEmptyGeneratedImageDirs(path.dirname(absolutePath), generation?.ownerUserId);
    } catch (error) {
      console.warn("[generated-image] failed to remove generated file", {
        generationId: generation?.id,
        storedPath,
        error: error.message,
      });
    }
  }
}

function collectGenerationStoredPaths(generation) {
  const paths = new Set();
  collectObjectValues(generation?.payload, (value, key) => {
    if (key === "storedPath" && typeof value === "string" && value) {
      paths.add(value);
    }
  });
  return paths;
}

async function cleanupEmptyGeneratedImageDirs(rootDir = path.join(DATA_DIR, "uploads", "generated-images", "users")) {
  const boundary = path.resolve(rootDir);
  let deletedCount = 0;

  async function pruneDirectory(directoryPath) {
    if (!isPathInsideDirectory(directoryPath, boundary) && path.resolve(directoryPath) !== boundary) return;
    let entries = [];
    try {
      entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await pruneDirectory(path.join(directoryPath, entry.name));
      }
    }

    if (path.resolve(directoryPath) === boundary) return;
    try {
      await fsp.rmdir(directoryPath);
      deletedCount += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
      throw error;
    }
  }

  await pruneDirectory(boundary);
  return { deletedCount };
}

async function removeEmptyGeneratedImageDirs(startDir, ownerUserId) {
  const boundary = resolveGeneratedImageUserRoot(ownerUserId);
  let currentDir = path.resolve(startDir || "");
  while (isPathInsideDirectory(currentDir, boundary) && currentDir !== boundary) {
    try {
      await fsp.rmdir(currentDir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        currentDir = path.dirname(currentDir);
        continue;
      }
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
      throw error;
    }
    currentDir = path.dirname(currentDir);
  }
}

function resolveGeneratedImageUserRoot(ownerUserId) {
  const generatedRoot = path.join(DATA_DIR, "uploads", "generated-images", "users");
  const userId = Number(ownerUserId);
  return Number.isFinite(userId) && userId > 0 ? path.join(generatedRoot, String(userId)) : generatedRoot;
}

function isPathInsideDirectory(filePath, directoryPath) {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function collectGenerationContentUrls(generation) {
  const urls = new Set();
  collectObjectValues(generation?.payload, (value, key) => {
    if ((key === "imageUrl" || key === "previewUrl" || key === "originalImageUrl" || key === "sourceImageUrl" || key === "originalUrl") && typeof value === "string" && value) {
      urls.add(value);
    }
  });
  if (generation?.previewUrl) urls.add(generation.previewUrl);
  return urls;
}

function collectObjectValues(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectValues(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(child, key);
    collectObjectValues(child, visit);
  }
}

function normalizeProductImage(input) {
  if (!input || typeof input !== "object") return null;
  const dataUrl = String(input.dataUrl || "");
  if (!dataUrl.startsWith("data:image/")) return null;
  return {
    id: input.id == null ? null : Number(input.id),
    name: String(input.name || "product-image").slice(0, 120),
    dataUrl,
    sizeBytes: estimateDataUrlBytes(dataUrl),
  };
}

async function resolveBrandLogoImage(brand) {
  if (!brand?.logo?.storedPath) return null;
  const buffer = await fsp.readFile(resolveStoredAssetPath(brand.logo.storedPath));
  return {
    name: brand.logo.originalName || `${brand.name || "brand"}-logo`,
    dataUrl: `data:${brand.logo.mimeType};base64,${buffer.toString("base64")}`,
  };
}

async function saveBrandLogo(user, brand, payload) {
  const parsed = parseProductImageDataUrl(payload?.dataUrl);
  if (parsed.buffer.length > MAX_PRODUCT_IMAGE_BYTES) {
    const maxMb = Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024);
    throw Object.assign(new Error(`品牌 Logo 过大，请上传 ${maxMb}MB 以内的图片。`), { code: "PAYLOAD_TOO_LARGE" });
  }

  const sha256 = crypto.createHash("sha256").update(parsed.buffer).digest("hex");
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = PRODUCT_IMAGE_MIME_EXTENSIONS[parsed.mimeType];
  const fileName = `logo_${brand.id}_${randomId().slice(0, 12)}.${ext}`;
  const storedPath = path.join("uploads", "brand-logos", "users", String(user.id), year, month, fileName);
  const absolutePath = path.join(DATA_DIR, storedPath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, parsed.buffer);

  return {
    originalName: sanitizeFileName(payload?.name || "brand-logo"),
    storedPath,
    mimeType: parsed.mimeType,
    sizeBytes: parsed.buffer.length,
    sha256,
    createdAt: brand.logo?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function parseProductImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("请上传有效的产品图片。");
  }
  const mimeType = String(match[1] || "").toLowerCase();
  if (!PRODUCT_IMAGE_MIME_EXTENSIONS[mimeType]) {
    throw new Error("产品图仅支持 PNG、JPG、WEBP 或 GIF 格式。");
  }
  return {
    mimeType,
    buffer: Buffer.from(match[2], "base64"),
  };
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round((value / 1024 / 1024) * 10) / 10}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function sanitizeFileName(value) {
  const name = String(value || "product-image").replace(/[\\/:*?"<>|]/g, "_").trim();
  return (name || "product-image").slice(0, 120);
}

function resolveStoredProductImagePath(image) {
  return resolveStoredAssetPath(image.storedPath || "");
}

function resolveStoredAssetPath(storedPath) {
  const filePath = path.join(DATA_DIR, storedPath || "");
  const relativePath = path.relative(DATA_DIR, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid stored asset path");
  }
  return filePath;
}

async function removeStoredFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isRemoteImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function buildGeneratedImageUrl(generationId) {
  return `/api/generated-images/${generationId}/file`;
}

function buildGeneratedSlideImageUrl(generationId, slideIndex) {
  return `/api/generated-images/${generationId}/slides/${slideIndex}/file`;
}

function buildGeneratedEditImageUrl(generationId, editId) {
  return `/api/generated-images/${generationId}/edits/${editId}/file`;
}

async function persistGenerationImages(generation) {
  if (!generation?.id) return generation;
  generation.payload = generation.payload && typeof generation.payload === "object" ? generation.payload : {};
  const slides = Array.isArray(generation.payload.slides) ? generation.payload.slides : [];
  if (slides.length) {
    for (let index = 0; index < slides.length; index += 1) {
      const slide = slides[index];
      await persistGeneratedImageReference({
        ownerUserId: generation.ownerUserId,
        generationId: generation.id,
        target: slide,
        remoteUrl: slide?.imageUrl || slide?.previewUrl || "",
        variant: `slide_${index + 1}`,
        localUrl: buildGeneratedSlideImageUrl(generation.id, index),
      });
    }
    generation.previewUrl = slides.find((slide) => slide?.previewUrl)?.previewUrl || generation.previewUrl || "";
    return generation;
  }

  await persistGeneratedImageReference({
    ownerUserId: generation.ownerUserId,
    generationId: generation.id,
    target: generation.payload,
    remoteUrl: generation.payload.imageUrl || generation.payload.previewUrl || generation.previewUrl || "",
    variant: "main",
    localUrl: buildGeneratedImageUrl(generation.id),
  });
  generation.previewUrl = generation.payload.previewUrl || generation.payload.imageUrl || generation.previewUrl || "";
  return generation;
}

async function persistGeneratedImageReference({ ownerUserId, generationId, target, remoteUrl, variant, localUrl }) {
  if (!target || target.localImage?.storedPath) {
    if (target?.localImage?.storedPath && localUrl) {
      target.imageUrl = localUrl;
      target.previewUrl = localUrl;
    }
    return target?.localImage || null;
  }
  const sourceUrl = String(remoteUrl || "").trim();
  if (!isRemoteImageUrl(sourceUrl)) return null;

  let asset = null;
  try {
    asset = await saveGeneratedImageFromRemote(ownerUserId, generationId, sourceUrl, variant);
  } catch (error) {
    console.warn("[generated-image] failed to persist generated image", {
      ownerUserId,
      generationId,
      variant,
      imageUrl: sourceUrl,
      error: error.message,
    });
    target.persistError = error.message || "图片本地保存失败";
    return null;
  }

  target.originalImageUrl = sourceUrl;
  target.localImage = asset;
  target.imageUrl = localUrl;
  target.previewUrl = localUrl;
  return asset;
}

async function saveGeneratedImageFromRemote(ownerUserId, generationId, imageUrl, variant) {
  const downloaded = await downloadRemoteGeneratedImage(imageUrl);
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = PRODUCT_IMAGE_MIME_EXTENSIONS[downloaded.mimeType] || "png";
  const safeVariant = String(variant || "image").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const fileName = `gi_${generationId}_${safeVariant}_${randomId().slice(0, 12)}.${ext}`;
  const storedPath = path.join("uploads", "generated-images", "users", String(ownerUserId), year, month, fileName);
  const absolutePath = path.join(DATA_DIR, storedPath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, downloaded.buffer);
  return {
    storedPath,
    mimeType: downloaded.mimeType,
    sizeBytes: downloaded.buffer.length,
    originalUrl: imageUrl,
    createdAt: now.toISOString(),
  };
}

async function downloadRemoteGeneratedImage(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(imageUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "RedBase/1.0 image-persist",
      },
    });
    if (!response.ok) {
      throw new Error(`图片下载失败：HTTP ${response.status}`);
    }
    const headerMimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mimeType = PRODUCT_IMAGE_MIME_EXTENSIONS[headerMimeType] ? headerMimeType : inferImageMimeTypeFromUrl(imageUrl);
    if (!PRODUCT_IMAGE_MIME_EXTENSIONS[mimeType]) {
      throw new Error(`图片格式不支持：${headerMimeType || "unknown"}`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error(`生成图片超过本地保存上限：${formatBytes(contentLength)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error(`生成图片超过本地保存上限：${formatBytes(buffer.length)}`);
    }
    return { buffer, mimeType };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("生成图片下载超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function inferImageMimeTypeFromUrl(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase();
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".gif")) return "image/gif";
  } catch (error) {
    // Fall through to png.
  }
  return "image/png";
}

async function serveStoredGeneratedImage(res, asset) {
  if (!asset?.storedPath) {
    notFound(res);
    return;
  }
  try {
    const data = await fsp.readFile(resolveStoredAssetPath(asset.storedPath));
    res.writeHead(200, {
      "Content-Type": asset.mimeType || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
    });
    res.end(data);
  } catch (error) {
    notFound(res);
  }
}

async function resolveGeneratedImageInputForEdit(generation, sourceImageUrl, parentEditId) {
  const asset = selectGeneratedImageAsset(generation, sourceImageUrl, parentEditId);
  if (!asset?.storedPath) return null;
  try {
    const buffer = await fsp.readFile(resolveStoredAssetPath(asset.storedPath));
    return {
      name: sanitizeFileName(path.basename(asset.storedPath)),
      dataUrl: `data:${asset.mimeType || "image/png"};base64,${buffer.toString("base64")}`,
      storedPath: asset.storedPath,
    };
  } catch (error) {
    console.warn("[generated-image] failed to read local image for edit", {
      generationId: generation?.id,
      storedPath: asset.storedPath,
      error: error.message,
    });
    return null;
  }
}

function selectGeneratedImageAsset(generation, sourceImageUrl, parentEditId) {
  const payload = generation?.payload || {};
  const url = String(sourceImageUrl || "");
  const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
  const editIdFromUrl = url.match(/\/api\/generated-images\/\d+\/edits\/([a-f0-9]+)\/file/)?.[1];
  const requestedEditId = String(parentEditId || editIdFromUrl || "");
  if (requestedEditId) {
    const edit = editHistory.find((entry) => entry.id === requestedEditId);
    if (edit?.localImage) return edit.localImage;
  }

  const slideIndexFromUrl = url.match(/\/api\/generated-images\/\d+\/slides\/(\d+)\/file/)?.[1];
  if (slideIndexFromUrl != null) {
    const slides = Array.isArray(payload.slides) ? payload.slides : [];
    const slide = slides[Number(slideIndexFromUrl)];
    if (slide?.localImage) return slide.localImage;
  }

  return payload.localImage || null;
}

function sanitizeGeneration(generation, appConfig) {
  const sanitized = baseSanitizeGeneration(generation);
  return signLocalAssetUrls(sanitized, appConfig);
}

function sanitizeBrand(brand, appConfig) {
  const sanitized = baseSanitizeBrand(brand);
  if (sanitized.logo?.url) {
    sanitized.logo = {
      ...sanitized.logo,
      url: signAssetUrl(appConfig, sanitized.logo.url),
    };
  }
  return sanitized;
}

function sanitizeBrandSummary(brand, appConfig) {
  const sanitized = baseSanitizeBrandSummary(brand);
  if (sanitized.logo?.url) {
    sanitized.logo = {
      ...sanitized.logo,
      url: signAssetUrl(appConfig, sanitized.logo.url),
    };
  }
  return sanitized;
}

function buildProductImageView(image, appConfig) {
  return {
    id: image.id,
    originalName: image.originalName,
    url: signAssetUrl(appConfig, `/api/product-images/${image.id}/file`),
    mimeType: image.mimeType,
    sizeBytes: Number(image.sizeBytes || 0),
    createdAt: image.createdAt,
    lastUsedAt: image.lastUsedAt || "",
    brandId: Number(image.brandId || 0) || 0,
    assetType: String(image.assetType || "unassigned"),
  };
}

function sortProductImages(a, b) {
  return String(b.lastUsedAt || b.createdAt || "").localeCompare(String(a.lastUsedAt || a.createdAt || "")) || b.id - a.id;
}

module.exports = {
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGE_SELECTION_COUNT,
  MAX_PRODUCT_IMAGE_SELECTION_BYTES,
  MAX_GENERATED_IMAGE_BYTES,
  PRODUCT_IMAGE_MIME_EXTENSIONS,
  removeGenerationLocalFiles,
  collectGenerationStoredPaths,
  cleanupEmptyGeneratedImageDirs,
  collectGenerationContentUrls,
  collectObjectValues,
  normalizeProductImage,
  resolveBrandLogoImage,
  saveBrandLogo,
  parseProductImageDataUrl,
  estimateDataUrlBytes,
  formatBytes,
  sanitizeFileName,
  resolveStoredProductImagePath,
  resolveStoredAssetPath,
  removeStoredFileIfExists,
  isRemoteImageUrl,
  buildGeneratedImageUrl,
  buildGeneratedSlideImageUrl,
  buildGeneratedEditImageUrl,
  persistGenerationImages,
  persistGeneratedImageReference,
  saveGeneratedImageFromRemote,
  downloadRemoteGeneratedImage,
  inferImageMimeTypeFromUrl,
  serveStoredGeneratedImage,
  resolveGeneratedImageInputForEdit,
  selectGeneratedImageAsset,
  sanitizeGeneration,
  sanitizeBrand,
  sanitizeBrandSummary,
  buildProductImageView,
  verifySignedAssetRequest,
  sortProductImages,
};
