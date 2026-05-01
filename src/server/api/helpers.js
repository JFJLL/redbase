const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { DATA_DIR } = require("../config");
const { getCookieSessionToken } = require("../auth/cookies");
const { signAssetUrl, verifySignedAssetRequest, signLocalAssetUrls } = require("../assets/signed-urls");
const {
  randomId,
  sanitizeUser,
  sanitizeTrend,
  sanitizeGeneration: baseSanitizeGeneration,
  normalizeChineseCopy,
  pickVariant,
  sanitizeBrand: baseSanitizeBrand,
} = require("../utils");

const CREDIT_COSTS = {
  analysis: 1,
  regenerateIdeas: 1,
  momentsImage: 1,
  wechatImage: 1,
  xhsCarousel: 4,
  xhsCarouselSlide: 1,
  imageEdit: 1,
  styleImage: 1,
};

const MAX_REQUEST_BODY_BYTES = 45 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_SELECTION_COUNT = 10;
const MAX_PRODUCT_IMAGE_SELECTION_BYTES = 30 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS = 5000;
const PRODUCT_IMAGE_MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function hasEnoughCredits(user, cost, res) {
  const current = Number(user.credits || 0);
  if (current < cost) {
    json(res, 402, { error: `积分不足，本次操作需要 ${cost} 积分，当前剩余 ${current} 积分。` });
    return false;
  }
  return true;
}

function spendCredits(user, cost) {
  user.credits = Number(user.credits || 0) - cost;
}

function recordCreditEvent(storeState, options) {
  storeState.creditEvents = Array.isArray(storeState.creditEvents) ? storeState.creditEvents : [];
  const event = {
    id: Number(storeState.nextCreditEventId || 1),
    userId: options.user.id,
    actionType: options.actionType,
    actionLabel: options.actionLabel,
    creditDelta: Number(options.creditDelta || 0),
    creditCost: Number(options.creditCost || 0),
    createdAt: new Date().toISOString(),
    adminUserId: options.adminUser?.id ?? null,
    adminUserName: options.adminUser?.name || "",
    brandId: options.brand?.id ?? null,
    brandName: options.brand?.name || "",
    trendId: options.trend?.id ?? null,
    trendTitle: options.trend?.title || "",
    ideaTitle: options.idea?.title || "",
    generationId: options.generationId ?? null,
    channelLabel: options.channelLabel || "",
    summary: options.summary || "",
    payload: options.payload || {},
  };
  storeState.nextCreditEventId = event.id + 1;
  storeState.creditEvents.unshift(event);
  return event;
}

function attachGenerationToCreditEvent(storeState, creditEventId, generation, generationPayload) {
  const numericId = Number(creditEventId);
  if (!Number.isFinite(numericId)) return null;
  const event = (storeState.creditEvents || []).find((item) => item.id === numericId);
  if (!event) return null;
  event.generationId = generation.id;
  event.channelLabel = generation.channelLabel || event.channelLabel;
  event.summary = generation.summary || generation.cardTitle || event.summary;
  event.payload = {
    ...(event.payload || {}),
    generationPayload: generationPayload || generation.payload || {},
  };
  return event;
}

function findGenerationForCreditEvent(storeState, creditEventId, userId) {
  const numericId = Number(creditEventId);
  if (!Number.isFinite(numericId)) return null;
  const event = (storeState.creditEvents || []).find((item) => item.id === numericId && item.userId === userId);
  if (!event?.generationId) return null;
  return (storeState.generations || []).find((item) => item.id === event.generationId && item.ownerUserId === userId) || null;
}

function findOwnedGeneration(storeState, user, generationId) {
  const numericId = Number(generationId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  return (storeState.generations || []).find((item) => item.id === numericId && item.ownerUserId === user.id) || null;
}

function getTrendAnalysisBrandProfileSize(brand) {
  const fields = [
    brand?.name,
    brand?.industry,
    brand?.audience,
    brand?.description,
    brand?.product,
    brand?.goal,
    brand?.knowledgeBase,
    ...(Array.isArray(brand?.assetTags) ? brand.assetTags : []),
  ];
  return {
    total: fields.reduce((sum, value) => sum + String(value || "").trim().length, 0),
  };
}

async function appendImageEditToGeneration(storeState, userId, job) {
  const generationId = Number(job?.generationContext?.sourceGenerationId || 0);
  if (!Number.isFinite(generationId) || generationId <= 0) return null;
  const generation = (storeState.generations || []).find((item) => item.id === generationId && item.ownerUserId === userId);
  if (!generation) return null;

  generation.payload = generation.payload && typeof generation.payload === "object" ? generation.payload : {};
  generation.payload.editHistory = Array.isArray(generation.payload.editHistory) ? generation.payload.editHistory : [];
  const existing = generation.payload.editHistory.find((item) => item.id === job.id);
  if (existing) return existing;

  const editEntry = {
    id: job.id,
    parentEditId: job.generationContext.parentEditId || "",
    prompt: job.generationContext.editPrompt || job.metadata?.editPrompt || job.metadata?.prompt || "",
    sourceImageUrl: job.generationContext.sourceImageUrl || job.metadata?.originalImageUrl || "",
    sourceSlideIndex: Number.isInteger(job.generationContext.sourceSlideIndex) ? job.generationContext.sourceSlideIndex : null,
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    title: job.generationContext.title || job.metadata?.title || "改图结果",
    aspectRatio: job.generationContext.aspectRatio || job.metadata?.aspectRatio || "",
    model: job.model || "",
    provider: job.provider || "",
    createdAt: new Date(Number(job.createdAt || Date.now())).toISOString(),
    completedAt: job.completedAt || new Date().toISOString(),
  };
  await persistGeneratedImageReference({
    ownerUserId: generation.ownerUserId,
    generationId: generation.id,
    target: editEntry,
    remoteUrl: job.imageUrl || "",
    variant: `edit_${job.id}`,
    localUrl: buildGeneratedEditImageUrl(generation.id, job.id),
  });
  generation.payload.editHistory.unshift(editEntry);
  return editEntry;
}

function attachImageEditToCreditEvent(storeState, creditEventId, editEntry, sourceGenerationId) {
  const numericId = Number(creditEventId);
  if (!Number.isFinite(numericId)) return null;
  const event = (storeState.creditEvents || []).find((item) => item.id === numericId);
  if (!event) return null;
  event.generationId = Number(sourceGenerationId) || event.generationId;
  event.payload = {
    ...(event.payload || {}),
    editResult: editEntry,
  };
  return event;
}

function attachGenerationToLatestMatchingCreditEvent(storeState, options) {
  const event = (storeState.creditEvents || []).find(
    (item) =>
      item.userId === options.user.id &&
      item.actionType === options.actionType &&
      item.generationId == null &&
      item.brandId === options.brand.id &&
      item.trendId === options.trend.id &&
      (!item.ideaTitle || item.ideaTitle === options.idea.title),
  );
  if (!event) return null;
  return attachGenerationToCreditEvent(storeState, event.id, options.generation, options.generationPayload);
}

async function deleteUserCascade(storeState, targetUser) {
  const userId = targetUser.id;
  const userBrands = (storeState.brands || []).filter((brand) => brand.ownerUserId === userId);
  for (const brand of userBrands) {
    if (brand.logo?.storedPath) {
      await removeStoredFileIfExists(resolveStoredAssetPath(brand.logo.storedPath));
    }
  }
  for (const generation of (storeState.generations || []).filter((item) => item.ownerUserId === userId)) {
    await removeGenerationLocalFiles(generation);
  }
  const productImages = (storeState.productImages || []).filter((image) => image.ownerUserId === userId);
  for (const image of productImages) {
    try {
      await fsp.unlink(resolveStoredProductImagePath(image));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[admin] failed to remove user product image", { userId, imageId: image.id, error: error.message });
      }
    }
  }

  storeState.users = (storeState.users || []).filter((user) => user.id !== userId);
  storeState.sessions = (storeState.sessions || []).filter((session) => session.userId !== userId);
  storeState.brands = (storeState.brands || []).filter((brand) => brand.ownerUserId !== userId);
  storeState.generations = (storeState.generations || []).filter((generation) => generation.ownerUserId !== userId);
  storeState.creditEvents = (storeState.creditEvents || []).filter((event) => event.userId !== userId);
  storeState.productImages = (storeState.productImages || []).filter((image) => image.ownerUserId !== userId);
  storeState.imageJobs = (storeState.imageJobs || []).filter((job) => job.ownerUserId !== userId);
  if (targetUser.phone && storeState.verificationCodes) {
    delete storeState.verificationCodes[targetUser.phone];
  }
}

async function deleteGenerationCascade(storeState, generation, liveImageJobs) {
  const generationId = Number(generation?.id || 0);
  if (!Number.isFinite(generationId) || generationId <= 0) return;
  await removeGenerationLocalFiles(generation);
  const contentUrls = collectGenerationContentUrls(generation);

  storeState.generations = (storeState.generations || []).filter((item) => item.id !== generationId);
  storeState.imageJobs = (storeState.imageJobs || []).filter((job) => {
    const shouldDelete =
      Number(job.generationId) === generationId ||
      Number(job.generationContext?.sourceGenerationId) === generationId ||
      contentUrls.has(String(job.imageUrl || ""));
    if (shouldDelete && job.id && liveImageJobs?.delete) {
      liveImageJobs.delete(job.id);
    }
    return !shouldDelete;
  });

  for (const event of storeState.creditEvents || []) {
    if (Number(event.generationId) !== generationId) continue;
    event.generationId = null;
    event.payload = {
      deletedGenerationId: generationId,
      deletedAt: new Date().toISOString(),
    };
  }
}

async function removeGenerationLocalFiles(generation) {
  const storedPaths = collectGenerationStoredPaths(generation);
  for (const storedPath of storedPaths) {
    try {
      await removeStoredFileIfExists(resolveStoredAssetPath(storedPath));
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

function findOwnedImageJob(storeState, user, jobId) {
  return (storeState.imageJobs || []).find((job) => job.id === jobId && job.ownerUserId === user.id) || null;
}

function upsertImageJobRecord(storeState, userId, job) {
  if (!job?.id) return null;
  storeState.imageJobs = Array.isArray(storeState.imageJobs) ? storeState.imageJobs : [];
  const nowIso = new Date().toISOString();
  const record = {
    id: job.id,
    ownerUserId: userId,
    status: job.status || "pending",
    provider: job.provider || "wavespeed",
    providerMode: job.providerMode || "",
    providerResultUrl: job.providerResultUrl || "",
    model: job.model || "",
    metadata: job.metadata && typeof job.metadata === "object" ? job.metadata : {},
    generationContext: job.generationContext && typeof job.generationContext === "object" ? job.generationContext : null,
    imageUrl: job.imageUrl || "",
    error: job.error || "",
    generationId: job.generationId ?? null,
    createdAt: Number(job.createdAt || Date.now()),
    updatedAt: nowIso,
    completedAt: job.status === "completed" ? job.completedAt || nowIso : job.completedAt || "",
  };
  const index = storeState.imageJobs.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    storeState.imageJobs[index] = record;
  } else {
    storeState.imageJobs.unshift(record);
  }
  return record;
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

async function resolveProductImageInput(storeState, user, input) {
  const imageId = Number(input?.id || input?.productImageId || 0);
  if (Number.isFinite(imageId) && imageId > 0) {
    const image = findOwnedProductImage(storeState, user, imageId);
    if (!image) return null;
    const buffer = await fsp.readFile(resolveStoredProductImagePath(image));
    image.lastUsedAt = new Date().toISOString();
    return {
      id: image.id,
      name: image.originalName,
      dataUrl: `data:${image.mimeType};base64,${buffer.toString("base64")}`,
      sizeBytes: Number(image.sizeBytes || buffer.length),
    };
  }
  return normalizeProductImage(input);
}

async function resolveProductImageInputs(storeState, user, input, options = {}) {
  const rawImages = Array.isArray(input) ? input : input ? [input] : [];
  const maxCount = Number(options.maxCount || MAX_PRODUCT_IMAGE_SELECTION_COUNT);
  const maxTotalBytes = Number(options.maxTotalBytes || MAX_PRODUCT_IMAGE_SELECTION_BYTES);
  const label = String(options.label || "产品参考图");
  if (rawImages.length > maxCount) {
    throw Object.assign(new Error(`${label}最多选择 ${maxCount} 张。请删除已有图片后重新上传或选择。`), {
      code: "IMAGE_LIMIT_EXCEEDED",
    });
  }
  const resolved = [];
  let totalBytes = 0;
  for (const rawImage of rawImages) {
    const image = await resolveProductImageInput(storeState, user, rawImage);
    if (!image) continue;
    totalBytes += Number(image.sizeBytes || estimateDataUrlBytes(image.dataUrl) || 0);
    if (totalBytes > maxTotalBytes) {
      throw Object.assign(
        new Error(`${label}总大小最多 ${formatBytes(maxTotalBytes)}。请压缩图片或删除已有图片后重新上传。`),
        { code: "IMAGE_LIMIT_EXCEEDED" },
      );
    }
    resolved.push(image);
  }
  return resolved;
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

async function saveProductImage(storeState, user, payload) {
  const parsed = parseProductImageDataUrl(payload?.dataUrl);
  if (parsed.buffer.length > MAX_PRODUCT_IMAGE_BYTES) {
    const maxMb = Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024);
    throw Object.assign(new Error(`产品图过大，请上传 ${maxMb}MB 以内的图片。`), { code: "PAYLOAD_TOO_LARGE" });
  }

  const sha256 = crypto.createHash("sha256").update(parsed.buffer).digest("hex");
  storeState.productImages = Array.isArray(storeState.productImages) ? storeState.productImages : [];
  const duplicate = storeState.productImages.find((image) => image.ownerUserId === user.id && image.sha256 === sha256 && !image.deletedAt);
  if (duplicate) {
    return { image: duplicate, duplicate: true };
  }

  const imageId = storeState.nextProductImageId++;
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = PRODUCT_IMAGE_MIME_EXTENSIONS[parsed.mimeType];
  const fileName = `pi_${imageId}_${randomId().slice(0, 12)}.${ext}`;
  const storedPath = path.join("uploads", "product-images", "users", String(user.id), year, month, fileName);
  const absolutePath = path.join(DATA_DIR, storedPath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, parsed.buffer);

  const image = {
    id: imageId,
    ownerUserId: user.id,
    originalName: sanitizeFileName(payload?.name || "product-image"),
    storedPath,
    mimeType: parsed.mimeType,
    sizeBytes: parsed.buffer.length,
    sha256,
    createdAt: now.toISOString(),
    lastUsedAt: "",
    deletedAt: "",
  };
  storeState.productImages.unshift(image);
  return { image, duplicate: false };
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

function findOwnedProductImage(storeState, user, imageId) {
  return (storeState.productImages || []).find((image) => image.id === imageId && image.ownerUserId === user.id && !image.deletedAt) || null;
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

function buildProductImageView(image, appConfig) {
  return {
    id: image.id,
    originalName: image.originalName,
    url: signAssetUrl(appConfig, `/api/product-images/${image.id}/file`),
    mimeType: image.mimeType,
    sizeBytes: Number(image.sizeBytes || 0),
    createdAt: image.createdAt,
    lastUsedAt: image.lastUsedAt || "",
  };
}

function sortProductImages(a, b) {
  return String(b.lastUsedAt || b.createdAt || "").localeCompare(String(a.lastUsedAt || a.createdAt || "")) || b.id - a.id;
}

async function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) return;

      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("请求体过大，请压缩图片或上传更小的文件。"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getSessionToken(req) {
  const cookieToken = getCookieSessionToken(req);
  if (cookieToken) return cookieToken;
  const headerToken = req.headers["x-session-token"];
  if (headerToken) return headerToken;
  return "";
}

function shouldLogApiRequest(pathname) {
  if (!String(pathname || "").startsWith("/api/")) return false;
  return pathname !== "/api/health";
}

function installApiRequestLogger(req, res, pathname) {
  if (req.__redbaseApiLoggerInstalled) return;
  req.__redbaseApiLoggerInstalled = true;
  const startedAt = Date.now();
  res.once("finish", () => {
    const statusCode = res.statusCode || 0;
    const payload = {
      method: req.method,
      path: pathname,
      statusCode,
      durationMs: Date.now() - startedAt,
      user: req.__redbaseApiUser || null,
      request: buildApiRequestLog(req),
    };
    if (statusCode >= 500) {
      console.error("[api] request completed", payload);
    } else if (statusCode >= 400) {
      console.warn("[api] request completed", payload);
    } else {
      console.log("[api] request completed", payload);
    }
  });
}

function buildApiRequestLog(req) {
  const queryKeys = [];
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    for (const key of url.searchParams.keys()) {
      if (!["token", "password", "code", "sessionToken", "assetSignature"].includes(key)) {
        queryKeys.push(key);
      }
    }
  } catch (error) {
    // Ignore malformed URLs in logging.
  }
  return {
    contentLength: req.headers["content-length"] || "",
    queryKeys: [...new Set(queryKeys)],
    ip: getRequestIp(req),
    userAgent: truncateLogString(req.headers["user-agent"] || "", 180),
  };
}

function getRequestIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket?.remoteAddress || "";
}

function buildApiUserLog(user) {
  return {
    id: user.id,
    phone: maskPhone(user.phone),
    accountType: user.accountType || "customer",
  };
}

function maskPhone(phone) {
  const text = String(phone || "");
  if (text.length < 7) return text ? "***" : "";
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function truncateLogString(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getAuthenticatedUser(storeState, req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = storeState.sessions.find((item) => item.token === token);
  if (!session) return null;
  const user = storeState.users.find((item) => item.id === session.userId) || null;
  if (user && req) {
    req.__redbaseApiUser = buildApiUserLog(user);
  }
  return user;
}

function requireAuth(storeState, req, res) {
  const user = getAuthenticatedUser(storeState, req);
  if (!user) {
    unauthorized(res, "请先登录");
    return null;
  }
  return user;
}

function requireAdmin(storeState, req, res, appConfig) {
  const user = requireAuth(storeState, req, res);
  if (!user) return null;
  if (!isAdminUser(user, appConfig)) {
    forbidden(res, "当前账号没有管理后台权限");
    return null;
  }
  return user;
}

function isAdminUser(user, appConfig) {
  const configuredPhones = getConfiguredAdminPhones(appConfig);
  if (configuredPhones.length) {
    return configuredPhones.includes(String(user.phone || "").trim());
  }
  return false;
}

function getConfiguredAdminPhones(appConfig) {
  const phones = appConfig?.admin?.phones;
  if (!Array.isArray(phones)) return [];
  return phones.map((phone) => String(phone || "").trim()).filter(Boolean);
}

function findTrendItem(brand, trendId) {
  if (!brand || !Array.isArray(brand.trends)) return null;
  for (const bucket of brand.trends) {
    if (Array.isArray(bucket.items)) {
      const found = bucket.items.find((item) => item.id === trendId);
      if (found) return found;
    }
  }
  return null;
}

function normalizeEditableText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cloneTrendBuckets(trends) {
  return (Array.isArray(trends) ? trends : []).map((bucket) => ({
    key: bucket.key,
    title: bucket.title,
    description: bucket.description,
    items: Array.isArray(bucket.items) ? bucket.items.map(sanitizeTrend) : [],
  }));
}

function createGenerationRecord(storeState, userId, brand, trend, idea, type, channelLabel, payload) {
  const summaryByType = {
    moments: payload.caption || payload.visualDirection || "",
    wechat: payload.publishTitle || payload.intro || "",
    xhsCarousel: payload.publishCaption || payload.caption || "",
    styleImage: payload.stylePrompt || payload.visualDirection || "",
  };
  const record = {
    id: storeState.nextGenerationId++,
    ownerUserId: userId,
    type,
    channelLabel,
    brandId: brand.id,
    brandName: brand.name,
    trendId: trend.id,
    trendTitle: trend.title,
    ideaTitle: idea.title,
    cardTitle: payload.title,
    createdAt: new Date().toISOString(),
    previewUrl: payload.previewUrl || payload.imageUrl || payload.slides?.[0]?.previewUrl || "",
    summary: summaryByType[type] || "",
    payload,
  };
  storeState.generations = Array.isArray(storeState.generations) ? storeState.generations : [];
  storeState.generations.unshift(record);
  return record;
}

function isRenderableGeneration(item) {
  if (item.type !== "xhsCarousel") return true;
  const slides = Array.isArray(item.payload?.slides) ? item.payload.slides : [];
  return slides.length === 4 && slides.every((slide) => Boolean(String(slide.imageUrl || slide.previewUrl || "").trim()));
}

function buildAdminOverview(storeState, appConfig) {
  const usersById = new Map((storeState.users || []).map((user) => [user.id, user]));
  const events = [...(storeState.creditEvents || [])].sort(sortByCreatedAtDesc);
  const generationEventsById = new Map(events.filter((event) => event.generationId != null).map((event) => [event.generationId, event]));

  let totalConsumedTokens = 0;
  let totalGrantedTokens = 0;
  const hasPrecomputedMetrics = Array.isArray(storeState.userMetrics);
  const metricsByUser = new Map(
    hasPrecomputedMetrics
      ? storeState.userMetrics.map((metrics) => [metrics.id, metrics])
      : (storeState.users || []).map((user) => [
          user.id,
          {
            ...sanitizeUser(user),
            createdAt: user.createdAt,
            currentCredits: Number(user.credits || 0),
            brandCount: 0,
            generationCount: 0,
            consumedTokens: 0,
            generationTokens: 0,
            grantedTokens: 0,
            lastActiveAt: "",
          },
        ]),
  );

  if (!hasPrecomputedMetrics) {
    for (const brand of storeState.brands || []) {
      const metrics = metricsByUser.get(brand.ownerUserId);
      if (metrics) metrics.brandCount += 1;
    }

    for (const generation of storeState.generations || []) {
      const metrics = metricsByUser.get(generation.ownerUserId);
      if (!metrics) continue;
      metrics.generationCount += 1;
      metrics.generationTokens += getGenerationTokenCost(generation, generationEventsById.get(generation.id));
      metrics.lastActiveAt = maxDate(metrics.lastActiveAt, generation.createdAt);
    }

    for (const event of events) {
      const metrics = metricsByUser.get(event.userId);
      const cost = getCreditEventCost(event);
      if (Number(event.creditDelta || 0) < 0) {
        totalConsumedTokens += cost;
        if (metrics) metrics.consumedTokens += cost;
      }
      if (Number(event.creditDelta || 0) > 0) {
        totalGrantedTokens += Number(event.creditDelta || 0);
        if (metrics) metrics.grantedTokens += Number(event.creditDelta || 0);
      }
      if (metrics) metrics.lastActiveAt = maxDate(metrics.lastActiveAt, event.createdAt);
    }
  } else {
    totalConsumedTokens = Number(storeState.statsOverride?.totalConsumedTokens || 0);
    totalGrantedTokens = Number(storeState.statsOverride?.totalGrantedTokens || 0);
  }

  const generations = [...(storeState.generations || [])]
    .sort(sortByCreatedAtDesc)
    .map((generation) => buildAdminGenerationView(generation, usersById, generationEventsById.get(generation.id), appConfig));
  const brands = Array.isArray(storeState.brandViews)
    ? storeState.brandViews
    : [...(storeState.brands || [])].sort(sortByCreatedAtDesc).map((brand) => buildAdminBrandView(brand, usersById));
  const stats = storeState.statsOverride || {
    userCount: storeState.users.length,
    brandCount: storeState.brands.length,
    generationCount: storeState.generations.length,
    totalConsumedTokens,
    totalGrantedTokens,
    currentCreditsTotal: (storeState.users || []).reduce((sum, user) => sum + Number(user.credits || 0), 0),
  };

  return {
    stats,
    users: [...metricsByUser.values()].sort((a, b) => b.consumedTokens - a.consumedTokens || b.generationCount - a.generationCount),
    brands,
    usageEvents: events.slice(0, 500).map((event) => sanitizeCreditEvent(event, usersById)),
    generations: generations.slice(0, 300),
  };
}

function buildAdminBrandView(brand, usersById) {
  const user = usersById.get(brand.ownerUserId);
  return {
    id: brand.id,
    ownerUserId: brand.ownerUserId,
    name: brand.name || "",
    industry: brand.industry || "",
    audience: brand.audience || "",
    description: brand.description || "",
    product: brand.product || "",
    goal: brand.goal || "",
    knowledgeBase: brand.knowledgeBase || "",
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
    logoName: brand.logo?.originalName || "",
    hasLogo: Boolean(brand.logo?.storedPath),
    analysisCount: Array.isArray(brand.analyses) ? brand.analyses.length : 0,
    trendCount: (brand.trends || []).reduce((sum, bucket) => sum + (Array.isArray(bucket.items) ? bucket.items.length : 0), 0),
    createdAt: brand.createdAt || "",
    user: user
      ? {
          id: user.id,
          name: user.name,
          phone: user.phone,
          accountType: user.accountType || "customer",
          department: user.department || "",
        }
      : null,
  };
}

function sanitizeCreditEvent(event, usersById) {
  const user = usersById.get(event.userId);
  return {
    id: event.id,
    userId: event.userId,
    userName: user?.name || "",
    userPhone: user?.phone || "",
    actionType: event.actionType,
    actionLabel: event.actionLabel,
    tokenDelta: Number(event.creditDelta || 0),
    tokenCost: getCreditEventCost(event),
    createdAt: event.createdAt,
    adminUserId: event.adminUserId,
    adminUserName: event.adminUserName || "",
    brandId: event.brandId,
    brandName: event.brandName || "",
    trendId: event.trendId,
    trendTitle: event.trendTitle || "",
    ideaTitle: event.ideaTitle || "",
    generationId: event.generationId,
    channelLabel: event.channelLabel || "",
    summary: event.summary || "",
    payload: event.payload || {},
  };
}

function buildAdminGenerationView(generation, usersById, event, appConfig) {
  const user = usersById.get(generation.ownerUserId);
  return {
    ...sanitizeGeneration(generation, appConfig),
    tokenCost: getGenerationTokenCost(generation, event),
    usageEventId: event?.id || null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          phone: user.phone,
          accountType: user.accountType || "customer",
          department: user.department || "",
        }
      : null,
  };
}

function getCreditEventCost(event) {
  const explicit = Number(event?.creditCost || 0);
  if (explicit > 0) return explicit;
  const delta = Number(event?.creditDelta || 0);
  return delta < 0 ? Math.abs(delta) : 0;
}

function getGenerationTokenCost(generation, event) {
  const eventCost = getCreditEventCost(event);
  if (eventCost > 0) return eventCost;
  return generation.type === "xhsCarousel" ? CREDIT_COSTS.xhsCarousel : CREDIT_COSTS.momentsImage;
}

function sortByCreatedAtDesc(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

function maxDate(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return String(candidate).localeCompare(String(current)) > 0 ? candidate : current;
}

function buildMomentsGenerationPayload(job) {
  return {
    ...job.metadata,
    title: job.metadata.title || "朋友圈图方案",
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
    caption: job.metadata.caption || "",
  };
}

function buildGeneratedAssetPayload(job) {
  return {
    ...job.metadata,
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
  };
}

function getAssetPalette(brand) {
  return String(brand.industry || "").toLowerCase().includes("beauty") || String(brand.industry || "").includes("美")
    ? ["#f06b93", "#ffd7e2", "#8b4f76"]
    : ["#ef4c82", "#ffb25a", "#342a62"];
}

function buildWechatLongImagePack({ brand, trend, idea }) {
  const palette = getAssetPalette(brand);
  const seed = `${brand.name}|${trend.title}|${idea.title}|wechat`;
  const titleTemplate = pickVariant(`${seed}|title`, [
    () => `${idea.title}｜公众号长图版`,
    () => `${trend.title}下的品牌内容切口`,
    () => `${brand.name}的${idea.title}长图方案`,
    () => `从${trend.title}说起：${idea.title}`,
  ]);
  const introTemplate = pickVariant(`${seed}|intro`, [
    () => `这篇长图不直接复述热点，而是从“${trend.title}”背后的用户需求切入，把${brand.name}能承接的场景、观点和行动建议讲完整。`,
    () => `如果把“${trend.title}”写成公众号内容，重点不是追赶讨论度，而是让读者看见${brand.name}和这个议题之间真实、具体的关系。`,
    () => `围绕“${idea.title}”，这张长图先建立观点，再展开用户场景，最后把${idea.brandFit}转成可阅读、可转发的品牌表达。`,
    () => `这套内容适合用更沉稳的公众号语气展开：用${trend.title}打开话题，用${brand.name}补上解决思路和审美判断。`,
  ]);
  const positioningTemplate = pickVariant(`${seed}|positioning`, [
    () => `适合作为公众号文章头图或中段总结图，用清晰标题、分层信息和留白感承接长阅读。`,
    () => `更像一张文章里的观点摘要图，负责把热点、用户场景和品牌价值压缩到一屏内。`,
    () => `适合放在公众号开头建立阅读预期，也适合作为文章结尾的收藏型信息卡。`,
    () => `长图语气偏专业克制，重点是可读性、信息秩序和品牌质感，而不是强营销海报。`,
  ]);
  const ctaTemplate = pickVariant(`${seed}|cta`, [
    () => `建议CTA：收藏这份${trend.title}内容思路，后续可继续拆解${brand.name}在该场景下的具体方案。`,
    () => `建议CTA：如果你也在关注${idea.audience}的真实需求，可以把这张长图作为选题参考保存下来。`,
    () => `建议CTA：从一个热点开始，继续观察${brand.name}如何把趋势变成更具体的内容资产。`,
    () => `建议CTA：保存这张长图，下次做${brand.industry || "品牌"}内容策划时可以直接复用结构。`,
  ]);

  return {
    title: normalizeChineseCopy(titleTemplate()),
    publishTitle: normalizeChineseCopy(pickVariant(`${seed}|publish`, [
      () => `${trend.title}之下，${brand.name}更值得被看见的内容切口`,
      () => `${idea.title}：一个适合${brand.name}展开的公众号选题`,
      () => `从${trend.title}到${brand.name}，这条内容可以这样讲`,
      () => `${brand.name}如何把${trend.title}转成可读的品牌内容`,
    ])()),
    intro: normalizeChineseCopy(introTemplate()),
    outline: [
      normalizeChineseCopy(`先解释“${trend.title}”击中了哪类用户情绪、使用场景或消费判断`),
      normalizeChineseCopy(`再说明${brand.name}和这个议题的真实关系，避免生硬贴热点`),
      normalizeChineseCopy(`把${idea.brandFit}拆成观点、场景、方法或案例，让读者能顺着读下去`),
      normalizeChineseCopy(`最后给出轻量行动建议，引导收藏、评论或继续了解${brand.name}`),
    ],
    positioning: normalizeChineseCopy(positioningTemplate()),
    cta: normalizeChineseCopy(ctaTemplate()),
    prompt: normalizeChineseCopy(`为微信公众号文章生成一张真正的竖版长图，主题围绕“${idea.title}”，热点背景是“${trend.title}”，品牌为${brand.name}。长图需要适合微信文章内嵌或朋友圈转发阅读，整体长度至少相当于 3 个手机屏幕的纵向阅读内容，不要做成单屏海报、单张封面或小红书封面。版式不要套固定模板，请根据选题内容自由组织为连续阅读的长图，可以是观点解析、故事叙述、清单总结、步骤拆解、对比说明、场景展开或案例化表达。画面需要有自然的阅读节奏：开头能抓住主题，中段有足够信息展开，结尾有总结、行动建议、轻 CTA 或品牌落点；但不要强行做成固定的“三段式/三栏/三模块”。信息层级要清楚，段落之间有呼吸感和视觉分隔，留白充足。文字不要密密麻麻，不要生成大段小字，适合用短标题、短句、编号、引用、图标化信息块或少量关键句来呈现。品牌资料：${brand.knowledgeBase || "暂无额外资料"}。需要自然体现${idea.brandFit}，整体风格沉稳、专业、清晰、有公众号内容质感，避免强广告感、促销感和复杂杂乱排版。`),
    previewUrl: "",
  };
}

function buildXhsCarouselPack({ brand, trend, idea }) {
  const palette = getAssetPalette(brand);
  const seed = `${brand.name}|${trend.title}|${idea.title}|carousel`;
  const slideCopySets = [
    [
      `先把“${trend.title}”转成一个用户会想点开的真实问题，让封面有明确点击理由。`,
      `继续展开${idea.audience}在这个议题里的具体感受、困扰或期待，少讲概念，多讲生活细节。`,
      `根据选题选择方法、对比、清单、测评或场景故事，把${idea.brandFit}讲得具体可感。`,
      `用一个收藏理由、总结观点或轻互动收口，让用户觉得这组图值得保存或转发。`,
    ],
    [
      `封面先给观点：为什么这个趋势和用户有关，而不只是行业里的一阵风。`,
      `中间页可以拆痛点、拆误区、拆步骤，也可以做前后对比，让用户看到自己的真实处境。`,
      `继续补充一个更具体的内容价值点，让${brand.name}的出现自然服务于选题，而不是突然卖点植入。`,
      `最后给出可执行的小建议、清单总结或一句轻提问，让整组图有保存价值和互动理由。`,
    ],
    [
      `开头用一句更有情绪或反差感的判断抓住注意力，避免把热点讲成报告。`,
      `中间把用户场景展开，也可以用清单、教程、测评、故事或对比来承接。`,
      `再让${brand.name}自然进入内容关系里，强调它能带来的具体体验、方法或审美判断。`,
      `结尾保留一点讨论空间，形成评论、收藏或继续阅读的理由。`,
    ],
  ];
  const slideCopies = pickVariant(`${seed}|copies`, slideCopySets);
  const slides = [
    {
      pageLabel: "第 1 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s1`, [
        () => `${trend.title}为什么和你有关`,
        () => `${idea.title}，先看这个切口`,
        () => `这个问题，很多人都忽略了`,
      ])()),
      copy: normalizeChineseCopy(slideCopies[0]),
      prompt: normalizeChineseCopy(`生成一套适合小红书发布的 4 页组图中的第1页，围绕“${idea.title}”，结合热点“${trend.title}”和品牌${brand.name}。第1页需要像真实小红书笔记封面，有明确点击理由和强钩子，但不要像广告海报或品牌PPT。可以用问题、反差、情绪共鸣、避坑提醒、清单标题或趋势判断来组织封面。画面要适合滑动阅读的开场，文字短、层级清楚，品牌露出自然，不要促销感。`),
    },
    {
      pageLabel: "第 2 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s2`, [
        () => "先把场景说具体",
        () => "真正触发共鸣的是这里",
        () => "很多人卡在这一步",
      ])()),
      copy: normalizeChineseCopy(slideCopies[1]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第2页，承接第1页继续展开“${idea.title}”。这一页不要固定成某一种模板，可以根据选题选择用户场景、痛点拆解、误区提醒、前后对比、步骤教程、测评观察或故事化表达。重点是让${idea.audience}看到自己的真实生活、消费判断或情绪状态，画面有代入感，文字简洁，信息不要堆满。`),
    },
    {
      pageLabel: "第 3 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s3`, [
        () => "把方法讲到具体处",
        () => "这里才是关键细节",
        () => "给一个可参考的做法",
      ])()),
      copy: normalizeChineseCopy(slideCopies[2]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第3页，继续展开具体价值。不要固定成品牌解决方案页，可以根据内容选择方法清单、细节放大、对比说明、体验测评、趋势解读或案例化表达。需要自然体现${brand.name}与选题的关系，重点表现${idea.brandFit}，但不要硬广，不要把画面做成促销海报。`),
    },
    {
      pageLabel: "第 4 张",
      title: normalizeChineseCopy(pickVariant(`${seed}|s4`, [
        () => "最后给你一个总结",
        () => "这页适合收藏",
        () => "可以从这里开始试试",
      ])()),
      copy: normalizeChineseCopy(slideCopies[3]),
      prompt: normalizeChineseCopy(`生成小红书 4 页组图中的第4页，作为整组内容的自然收尾。可以做收藏清单、总结观点、行动建议、轻互动提问、品牌落点或下一步建议，但不要固定成强CTA。画面要和前3页风格统一，适合用户保存、评论或转发；文字短、有重点，品牌${brand.name}自然露出，避免广告感和复杂排版。`),
    },
  ].map((slide, index) => ({
    ...slide,
    previewUrl: "",
  }));
  const captionTemplate = pickVariant(`${seed}|caption`, [
    () => `这组图不是简单追“${trend.title}”，而是把它转成一套能连续阅读的小红书笔记：有点击理由，有具体场景，也有值得收藏的内容价值。`,
    () => `围绕“${idea.title}”，这套组图可以根据内容自由选择清单、故事、对比、教程或总结结构，让${brand.name}自然进入用户真正关心的语境。`,
    () => `这套组图适合做成更真实的小红书内容：封面先抓注意力，中间把价值讲具体，最后给用户一个保存、评论或继续了解的理由。`,
    () => `如果要让${brand.name}自然进入“${trend.title}”这个话题，重点不是硬露出，而是先把用户愿意看的内容讲完整。`,
  ]);
  const publishCaptionTemplate = pickVariant(`${seed}|publish`, [
    () => `把“${trend.title}”做成小红书，不一定要套固定模板。更好的方式是先给用户一个进入理由，再用适合选题的结构把价值讲清楚。`,
    () => `这套组图适合用来讲“${idea.title}”：可以是清单、教程、对比、故事或总结，关键是让每一页都有继续滑下去的理由。`,
    () => `${brand.name}这个选题可以做得更轻一点：不急着卖产品，先把用户为什么需要、内容为什么值得看讲清楚。`,
    () => `围绕“${trend.title}”做内容，重点是把热点翻译成用户能保存、能转发、能评论的4页连续图文。`,
  ]);

  return {
    title: normalizeChineseCopy(`${idea.title}｜小红书组图方案`),
    publishTitle: normalizeChineseCopy(pickVariant(`${seed}|publishTitle`, [
      () => `${trend.title}火了以后，${brand.name}可以怎么做内容更自然`,
      () => `${idea.title}：适合${brand.name}的一套组图结构`,
      () => `从${trend.title}到收藏型笔记，可以这样拆`,
      () => `${brand.name}如何把热点做得更像自己`,
    ])()),
    publishCaption: normalizeChineseCopy(publishCaptionTemplate()),
    caption: normalizeChineseCopy(captionTemplate()),
    slides,
  };
}

function normalizeXhsCarouselSlideForJob(input, fallback, slideIndex) {
  const source = input && typeof input === "object" ? input : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const pageLabel = String(source.pageLabel || base.pageLabel || `第 ${slideIndex + 1} 张`).slice(0, 24);
  const title = normalizeChineseCopy(String(source.title || base.title || pageLabel).slice(0, 120));
  const copy = normalizeChineseCopy(String(source.copy || base.copy || "").slice(0, 500));
  const visualDirection = normalizeChineseCopy(String(source.visualDirection || base.visualDirection || title).slice(0, 300));
  const style = String(source.style || base.style || "xiaohongshu carousel cover page").slice(0, 160);
  const composition = normalizeChineseCopy(
    String(
      source.composition ||
        base.composition ||
        `小红书组图${slideIndex + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性`,
    ).slice(0, 500),
  );
  const prompt = normalizeChineseCopy(String(source.prompt || base.prompt || "").trim());
  return {
    ...base,
    ...source,
    pageLabel,
    title,
    copy,
    visualDirection,
    style,
    composition,
    prompt,
  };
}

function buildSvgPreview({ brandName, title, subtitle, palette }) {
  const safeTitle = String(title || "");
  const line1 = safeTitle.slice(0, 14);
  const line2 = safeTitle.slice(14, 28);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="840" height="1120" viewBox="0 0 840 1120">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette[0]}"/>
          <stop offset="55%" stop-color="${palette[2]}"/>
          <stop offset="100%" stop-color="#17162a"/>
        </linearGradient>
      </defs>
      <rect width="840" height="1120" rx="48" fill="url(#bg)"/>
      <circle cx="640" cy="220" r="160" fill="${palette[1]}" fill-opacity="0.16"/>
      <circle cx="220" cy="860" r="210" fill="${palette[1]}" fill-opacity="0.1"/>
      <rect x="72" y="74" width="180" height="58" rx="29" fill="rgba(255,255,255,0.12)"/>
      <text x="102" y="113" font-size="28" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(brandName)}</text>
      <text x="72" y="250" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line1)}</text>
      <text x="72" y="328" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line2)}</text>
      <text x="72" y="430" font-size="34" fill="${palette[1]}" font-family="Arial, sans-serif">${escapeXml(subtitle)}</text>
      <rect x="72" y="886" width="696" height="160" rx="36" fill="rgba(11,11,21,0.28)" stroke="rgba(255,255,255,0.1)"/>
      <text x="110" y="955" font-size="34" fill="#fff7fb" font-family="Arial, sans-serif">内容资产预览图</text>
      <text x="110" y="1008" font-size="28" fill="#ddd4ea" font-family="Arial, sans-serif">品牌资产 × 热点趋势 × 视觉表达</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function formatImageServiceError(error) {
  const message = String(error?.message || "图片服务暂时不可用");
  if (
    message.includes("fetch failed") ||
    message.includes("ENOTFOUND") ||
    message.includes("ECONNRESET") ||
    message.includes("timeout") ||
    message.includes("Client network socket disconnected")
  ) {
    return "图片服务连接失败，请稍后重试；如果连续失败，请检查服务器到 WaveSpeed 图片接口的网络连接。";
  }
  return message;
}

function unauthorized(res, message = "Unauthorized") {
  json(res, 401, { error: message });
}

function forbidden(res, message = "Forbidden") {
  json(res, 403, { error: message });
}

module.exports = {
  CREDIT_COSTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGE_SELECTION_COUNT,
  MAX_PRODUCT_IMAGE_SELECTION_BYTES,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS,
  PRODUCT_IMAGE_MIME_EXTENSIONS,
  hasEnoughCredits,
  spendCredits,
  recordCreditEvent,
  attachGenerationToCreditEvent,
  findGenerationForCreditEvent,
  findOwnedGeneration,
  getTrendAnalysisBrandProfileSize,
  appendImageEditToGeneration,
  attachImageEditToCreditEvent,
  attachGenerationToLatestMatchingCreditEvent,
  deleteUserCascade,
  deleteGenerationCascade,
  removeGenerationLocalFiles,
  collectGenerationStoredPaths,
  collectGenerationContentUrls,
  collectObjectValues,
  findOwnedImageJob,
  upsertImageJobRecord,
  normalizeProductImage,
  resolveProductImageInput,
  resolveProductImageInputs,
  resolveBrandLogoImage,
  saveBrandLogo,
  saveProductImage,
  parseProductImageDataUrl,
  estimateDataUrlBytes,
  formatBytes,
  sanitizeFileName,
  findOwnedProductImage,
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
  buildProductImageView,
  verifySignedAssetRequest,
  sortProductImages,
  collectBody,
  getSessionToken,
  shouldLogApiRequest,
  installApiRequestLogger,
  buildApiRequestLog,
  getRequestIp,
  buildApiUserLog,
  maskPhone,
  truncateLogString,
  getAuthenticatedUser,
  requireAuth,
  requireAdmin,
  isAdminUser,
  getConfiguredAdminPhones,
  findTrendItem,
  normalizeEditableText,
  cloneTrendBuckets,
  createGenerationRecord,
  isRenderableGeneration,
  buildAdminOverview,
  buildAdminBrandView,
  sanitizeCreditEvent,
  buildAdminGenerationView,
  getCreditEventCost,
  getGenerationTokenCost,
  sortByCreatedAtDesc,
  maxDate,
  buildMomentsGenerationPayload,
  buildGeneratedAssetPayload,
  getAssetPalette,
  buildWechatLongImagePack,
  buildXhsCarouselPack,
  normalizeXhsCarouselSlideForJob,
  buildSvgPreview,
  escapeXml,
  json,
  notFound,
  badRequest,
  formatImageServiceError,
  unauthorized,
  forbidden,
};
