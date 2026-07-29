const crypto = require("crypto");
const dns = require("dns").promises;
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { DATA_DIR } = require("../config");
const { createGeneratedAssetStorage } = require("./generated-asset-storage");
const { assertGenerationAssetOwnership } = require("./generation-deletion-service");
const { signAssetUrl, verifySignedAssetRequest, signLocalAssetUrls } = require("./signed-urls");
const {
  randomId,
  sanitizeGeneration: baseSanitizeGeneration,
  sanitizeBrand: baseSanitizeBrand,
  sanitizeBrandSummary: baseSanitizeBrandSummary,
  redactSensitiveUrlQuery,
} = require("../utils");
const { notFound } = require("../api/http-utils");

const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_SELECTION_COUNT = 10;
const MAX_PRODUCT_IMAGE_SELECTION_BYTES = 30 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS = 3;
const PRODUCT_IMAGE_MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

let defaultGeneratedAssetStorage = null;

function getDefaultGeneratedAssetStorage() {
  if (!defaultGeneratedAssetStorage) {
    defaultGeneratedAssetStorage = createGeneratedAssetStorage({ assetStorage: { provider: "local" } });
  }
  return defaultGeneratedAssetStorage;
}

function isBlockedImageHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .split("%")[0];
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host === "metadata" || host === "metadata.google") return true;
  if (host === "0.0.0.0") return true;
  return false;
}

function isPrivateOrReservedIp(address) {
  const normalized = String(address || "")
    .toLowerCase()
    .split("%")[0];
  if (!normalized) return true;
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (normalized.includes(":") && embeddedIpv4) return isPrivateOrReservedIp(embeddedIpv4);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const parts = normalized.split(".").map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) ||
      (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 224
    );
  }
  if (ipVersion === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (embeddedIpv4 && isPrivateOrReservedIp(embeddedIpv4)) return true;
    const hextets = normalized.split(":");
    const firstHextet = Number.parseInt(hextets[0] || "0", 16);
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, ::/128, ::1/128
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    if (firstHextet === 0) return true;
    return false;
  }
  return true;
}

async function assertSafeRemoteImageUrl(imageUrl, lookupImpl = dns.lookup) {
  let parsed;
  try {
    parsed = new URL(String(imageUrl || "").trim());
  } catch (error) {
    throw new Error("图片地址无效");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 图片地址");
  }
  if (parsed.username || parsed.password) {
    throw new Error("图片地址无效");
  }
  const hostname = parsed.hostname;
  if (isBlockedImageHostname(hostname)) {
    throw new Error("图片地址不可用");
  }
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new Error("图片地址不可用");
  }
  // Cloud metadata common IP as hostname edge case.
  if (hostname === "169.254.169.254") {
    throw new Error("图片地址不可用");
  }
  let addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : [];
  if (!net.isIP(hostname)) {
    try {
      addresses = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new Error("图片地址解析失败");
    }
    if (!addresses.length || addresses.some((item) => isPrivateOrReservedIp(item.address))) {
      throw new Error("图片地址不可用");
    }
  }
  return { parsed, addresses };
}

function createPinnedImageLookup(addresses) {
  const validated = (Array.isArray(addresses) ? addresses : []).map((item) => ({
    address: String(item?.address || ""),
    family: Number(item?.family || net.isIP(item?.address || "")),
  })).filter((item) => item.address && item.family);
  return (_hostname, options, callback) => {
    const lookupOptions = typeof options === "object" && options ? options : {};
    const done = typeof options === "function" ? options : callback;
    const requestedFamily = Number(typeof options === "number" ? options : lookupOptions.family || 0);
    const candidates = requestedFamily ? validated.filter((item) => item.family === requestedFamily) : validated;
    if (!candidates.length) {
      done(Object.assign(new Error("No validated image host address"), { code: "ENOTFOUND" }));
      return;
    }
    if (lookupOptions.all) {
      done(null, candidates);
      return;
    }
    done(null, candidates[0].address, candidates[0].family);
  };
}

function requestPinnedRemoteImage(target, options = {}) {
  const transport = target.parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target.parsed, {
      method: "GET",
      signal: options.signal,
      lookup: createPinnedImageLookup(target.addresses),
      headers: options.headers || {},
    }, (response) => {
      resolve({
        status: Number(response.statusCode || 0),
        ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
        headers: {
          get(name) {
            const value = response.headers[String(name || "").toLowerCase()];
            return Array.isArray(value) ? value[0] || "" : String(value || "");
          },
        },
        body: response,
      });
    });
    request.on("error", reject);
    request.end();
  });
}

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

async function persistGenerationImages(generation, storage = getDefaultGeneratedAssetStorage()) {
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
        storage,
      });
    }
    sanitizeGenerationPayloadUrls(generation.payload, generation.id);
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
    storage,
  });
  sanitizeGenerationPayloadUrls(generation.payload, generation.id);
  generation.previewUrl = generation.payload.previewUrl || generation.payload.imageUrl || generation.previewUrl || "";
  return generation;
}

async function persistGeneratedImageReference({
  ownerUserId,
  generationId,
  target,
  remoteUrl,
  variant,
  localUrl,
  storage = getDefaultGeneratedAssetStorage(),
  downloadImage = downloadRemoteGeneratedImage,
}) {
  if (!target) return null;
  if (target.localImage?.storedPath || target.localImage?.objectKey) {
    try {
      assertGenerationAssetOwnership(target.localImage, { id: generationId, ownerUserId });
    } catch (error) {
      delete target.localImage;
    }
  }
  if (target.localImage?.storedPath || target.localImage?.objectKey) {
    if (localUrl) {
      target.imageUrl = localUrl;
      target.previewUrl = localUrl;
    }
    return target.localImage;
  }
  const sourceUrl = String(remoteUrl || "").trim();
  if (!isRemoteImageUrl(sourceUrl)) return null;

  let asset = null;
  try {
    asset = await saveGeneratedImageFromRemote(ownerUserId, generationId, sourceUrl, variant, storage, downloadImage);
  } catch (error) {
    const persistError = storage?.provider === "aliyun_oss"
      ? "生成图片保存失败，请稍后重试"
      : error.message || "图片保存失败";
    console.warn("[generated-image] failed to persist generated image", {
      ownerUserId,
      generationId,
      variant,
      provider: storage?.provider || "local",
      errorCode: String(error?.code || "ASSET_PERSIST_FAILED"),
      status: Number(error?.status || error?.statusCode || 0) || undefined,
    });
    const safeSourceUrl = redactSensitiveUrlQuery(sourceUrl);
    removeGeneratedTargetUpstreamUrls(target);
    target.imageUrl = safeSourceUrl;
    target.previewUrl = safeSourceUrl;
    target.persistError = persistError;
    return null;
  }

  removeGeneratedTargetUpstreamUrls(target);
  target.localImage = asset;
  target.imageUrl = localUrl;
  target.previewUrl = localUrl;
  return asset;
}

async function recoverStagedBrandLogoDeletions(options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const root = options.root || path.join(dataDir, "uploads", "brand-logos");
  const isReferenced = options.isReferenced || (() => false);
  let recovered = 0;
  let removed = 0;

  async function visit(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      const markerIndex = entryPath.lastIndexOf(".deleting-");
      if (markerIndex < 0) continue;
      const originalPath = entryPath.slice(0, markerIndex);
      const storedPath = path.relative(dataDir, originalPath);
      if (isReferenced(storedPath)) {
        try {
          await fsp.rename(entryPath, originalPath);
          recovered += 1;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          await removeStoredFileIfExists(entryPath);
          removed += 1;
        }
      } else {
        await removeStoredFileIfExists(entryPath);
        removed += 1;
      }
    }
  }

  await visit(root);
  return { recovered, removed };
}

function removeGeneratedTargetUpstreamUrls(value) {
  if (Array.isArray(value)) {
    value.forEach(removeGeneratedTargetUpstreamUrls);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (/url/i.test(key) || ["source", "original", "providerResult"].includes(key)) {
      delete value[key];
      continue;
    }
    removeGeneratedTargetUpstreamUrls(value[key]);
  }
  return value;
}

function sanitizeGenerationPayloadUrls(value, generationId) {
  if (Array.isArray(value)) {
    value.forEach((item) => sanitizeGenerationPayloadUrls(item, generationId));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const ownRoutePrefix = `/api/generated-images/${Number(generationId)}/`;
  const persistenceFailed = Boolean(value.persistError);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (["source", "original", "providerResult"].includes(key)) {
      delete value[key];
      continue;
    }
    if (/url/i.test(key)) {
      if (typeof child !== "string") {
        delete value[key];
        continue;
      }
      const safeUrl = redactSensitiveUrlQuery(child);
      const isOwnGeneratedRoute = safeUrl.startsWith(ownRoutePrefix);
      const isFailedPrimaryUrl = persistenceFailed && ["imageUrl", "previewUrl"].includes(key) && isRemoteImageUrl(safeUrl);
      if (!isOwnGeneratedRoute && !isFailedPrimaryUrl) {
        delete value[key];
        continue;
      }
      value[key] = safeUrl;
      continue;
    }
    sanitizeGenerationPayloadUrls(child, generationId);
  }
  return value;
}

async function saveGeneratedImageFromRemote(
  ownerUserId,
  generationId,
  imageUrl,
  variant,
  storage = getDefaultGeneratedAssetStorage(),
  downloadImage = downloadRemoteGeneratedImage,
) {
  const downloaded = await downloadImage(imageUrl);
  return storage.save({
    ownerUserId,
    generationId,
    variant,
    buffer: downloaded.buffer,
    mimeType: downloaded.mimeType,
  });
}

async function downloadRemoteGeneratedImage(imageUrl) {
  let currentUrl = String(imageUrl || "").trim();
  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_IMAGE_REDIRECTS; redirectCount += 1) {
    const safeTarget = await assertSafeRemoteImageUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await requestPinnedRemoteImage(safeTarget, {
        signal: controller.signal,
        headers: {
          "User-Agent": "RedBase/1.0 image-persist",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = String(response.headers.get("location") || "").trim();
        if (!location) {
          throw new Error("图片下载重定向无效");
        }
        if (typeof response.body?.resume === "function") response.body.resume();
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`图片下载失败：HTTP ${response.status}`);
      }
      const headerMimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mimeType = PRODUCT_IMAGE_MIME_EXTENSIONS[headerMimeType] ? headerMimeType : inferImageMimeTypeFromUrl(currentUrl);
      if (!PRODUCT_IMAGE_MIME_EXTENSIONS[mimeType]) {
        throw new Error(`图片格式不支持：${headerMimeType || "unknown"}`);
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error(`生成图片超过本地保存上限：${formatBytes(contentLength)}`);
      }
      const buffer = await readGeneratedImageResponseBuffer(response, MAX_GENERATED_IMAGE_BYTES);
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
  throw new Error("图片下载重定向次数过多");
}

async function readGeneratedImageResponseBuffer(response, maxBytes = MAX_GENERATED_IMAGE_BYTES) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel("generated image exceeds size limit").catch(() => {});
          throw new Error(`生成图片超过保存上限：${formatBytes(totalBytes)}`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, totalBytes);
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let totalBytes = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value || []);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        if (typeof response.body.destroy === "function") response.body.destroy();
        throw new Error(`生成图片超过保存上限：${formatBytes(totalBytes)}`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`生成图片超过保存上限：${formatBytes(buffer.length)}`);
  return buffer;
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

async function serveStoredGeneratedImage(res, asset, storage = getDefaultGeneratedAssetStorage(), generation = null) {
  if (!asset?.storedPath && !asset?.objectKey) {
    notFound(res);
    return;
  }
  try {
    if (generation) assertGenerationAssetOwnership(asset, generation);
    if (asset.provider === "aliyun_oss" || asset.objectKey) {
      const readUrl = await storage.createReadUrl(asset, { expiresSeconds: 300 });
      res.writeHead(302, {
        Location: readUrl,
        "Cache-Control": "private, no-store",
      });
      res.end();
      return;
    }
    const data = await storage.readBuffer(asset);
    res.writeHead(200, {
      "Content-Type": asset.mimeType || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
    });
    res.end(data);
  } catch (error) {
    notFound(res);
  }
}

async function resolveGeneratedImageInputForEdit(generation, sourceImageUrl, parentEditId, storage = getDefaultGeneratedAssetStorage()) {
  const asset = selectGeneratedImageAsset(generation, sourceImageUrl, parentEditId);
  if (!asset?.storedPath && !asset?.objectKey) return null;
  try {
    assertGenerationAssetOwnership(asset, generation);
    const buffer = await storage.readBuffer(asset);
    if (buffer.length > MAX_GENERATED_IMAGE_BYTES) throw new Error("生成图片超过编辑读取上限");
    const assetName = asset.storedPath || asset.objectKey || "generated-image";
    return {
      name: sanitizeFileName(path.basename(assetName)),
      dataUrl: `data:${asset.mimeType || "image/png"};base64,${buffer.toString("base64")}`,
      storedPath: asset.storedPath || "",
      objectKey: asset.objectKey || "",
      provider: asset.provider || (asset.objectKey ? "aliyun_oss" : "local"),
    };
  } catch (error) {
    console.warn("[generated-image] failed to read image for edit", {
      generationId: generation?.id,
      provider: asset.provider || (asset.objectKey ? "aliyun_oss" : "local"),
      errorCode: String(error?.code || "ASSET_READ_FAILED"),
      status: Number(error?.status || error?.statusCode || 0) || undefined,
    });
    return null;
  }
}

function selectGeneratedImageAsset(generation, sourceImageUrl, parentEditId) {
  const payload = generation?.payload || {};
  const url = String(sourceImageUrl || "");
  const generationIdFromUrl = url.match(/\/api\/generated-images\/(\d+)\//)?.[1];
  if (generationIdFromUrl && Number(generationIdFromUrl) !== Number(generation?.id)) return null;
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
  recoverStagedBrandLogoDeletions,
  isRemoteImageUrl,
  assertSafeRemoteImageUrl,
  createPinnedImageLookup,
  requestPinnedRemoteImage,
  isPrivateOrReservedIp,
  buildGeneratedImageUrl,
  buildGeneratedSlideImageUrl,
  buildGeneratedEditImageUrl,
  persistGenerationImages,
  persistGeneratedImageReference,
  removeGeneratedTargetUpstreamUrls,
  sanitizeGenerationPayloadUrls,
  saveGeneratedImageFromRemote,
  downloadRemoteGeneratedImage,
  readGeneratedImageResponseBuffer,
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
