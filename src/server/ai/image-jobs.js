const { randomId, assertConfigured, withRetries } = require("../utils");
const { fetchJson } = require("./text-provider");
const { fetchRemoteImageBytes } = require("../assets/image-store");
const {
  buildImagePrompt,
  resolveImagePromptContext,
  shouldSkipStructuredPrompt,
} = require("./image-prompt-builder");
const {
  TASKS: EVALUATION_TASKS,
  PROMPT_VERSIONS,
  recordAiRun,
} = require("./evaluation");
const {
  createJob,
  getJob,
  updateJob,
  listPendingJobs,
  markFailed,
} = require("../db/repositories/image-job-runtime-repository");
const { recordImageTaskAttempt } = require("../analytics/ai-attempt-recorder");

const IMAGE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_JOB_HTTP_TIMEOUT_MS = 5 * 60 * 1000;
const IMAGE_JOB_TIMEOUT_ERROR = "timeout";
const IMAGE_PROVIDER_MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
const IMAGE_PROVIDER_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const KEYSTONE_DEFAULT_MODEL = "gpt-image-2";
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

let recoveryAttempted = false;

/**
 * Replace free-form AI prompts with the fixed commercial image-prompt engine.
 * Image edits keep the user prompt as-is.
 */
function applyStructuredImagePrompt(metadata, { brand, trend, idea } = {}) {
  const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (shouldSkipStructuredPrompt(base)) {
    return base;
  }
  const context = resolveImagePromptContext({
    brand,
    product: base.product,
    idea,
    metadata: base,
    trend,
    contentType: base.contentType,
    platform: base.platform,
    objective: base.objective,
  });
  const prompt = buildImagePrompt({
    ...context,
    remixBrief: base.remixBrief,
    metadata: base,
  });
  return {
    ...base,
    contentType: context.contentType,
    platform: context.platform,
    objective: context.objective,
    product: context.product,
    prompt,
    promptEngine: "image-prompt-builder",
  };
}

function buildImageConceptMetadata({ brand, trend, idea }) {
  throw new Error("朋友圈图文案必须先由 AI 内容服务根据品牌档案生成。");
}

function extractWavespeedOutput(payload) {
  const outputs = payload?.data?.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  if (typeof first === "string") return first;
  return first?.image || first?.url || first?.image_url || null;
}

function getImageProviderName(provider) {
  return String(provider?.provider || "keystone").trim().toLowerCase() === "wavespeed" ? "wavespeed" : "keystone";
}

function normalizeImageReference(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (/^https?:\/\//i.test(text) || /^data:image\//i.test(text)) return text;
  return "";
}

function normalizeKeystoneBase64(value, mimeType = "image/png") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^data:image\//i.test(text)) return text;
  const normalizedMimeType = SUPPORTED_IMAGE_MIME_TYPES.has(String(mimeType || "").toLowerCase())
    ? String(mimeType).toLowerCase()
    : "image/png";
  return `data:${normalizedMimeType};base64,${text}`;
}

function extractKeystoneOutput(payload) {
  const data = payload?.data;
  const entries = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const first = entries.find((item) => item && typeof item === "object") || {};
  const direct = normalizeImageReference(first.url || first.image_url || first.imageUrl || first.image);
  if (direct) return direct;
  const topLevelDirect = normalizeImageReference(payload?.url || payload?.image_url || payload?.imageUrl);
  if (topLevelDirect) return topLevelDirect;
  return normalizeKeystoneBase64(
    first.b64_json || first.b64Json || payload?.b64_json || payload?.b64Json,
    first.mime_type || first.mimeType || payload?.mime_type || payload?.mimeType,
  );
}

function normalizeKeystoneError(payload) {
  const value = payload?.error?.message || payload?.error || payload?.message || "";
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return truncateLogValue(value, 1000);
  return String(value);
}

function normalizeKeystoneSize(aspectRatio, resolution) {
  const configured = String(resolution || "").trim().toLowerCase();
  if (["1024x1024", "1024x1536", "1536x1024", "auto"].includes(configured) && configured !== "auto") {
    return configured;
  }

  const match = String(aspectRatio || "").trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return "1024x1536";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "1024x1536";
  if (Math.abs(width - height) / Math.max(width, height) < 0.05) return "1024x1024";
  return width > height ? "1536x1024" : "1024x1536";
}

function normalizeKeystoneQuality(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high", "auto"].includes(normalized) ? normalized : "auto";
}

function normalizeImageCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(10, Math.floor(count)));
}

function buildKeystoneImageRequest(provider, { prompt, aspectRatio }) {
  const body = {
    model: String(provider?.model || KEYSTONE_DEFAULT_MODEL).trim() || KEYSTONE_DEFAULT_MODEL,
    prompt: String(prompt || ""),
    size: normalizeKeystoneSize(aspectRatio, provider?.resolution),
    n: normalizeImageCount(provider?.imageCount),
  };
  if (provider?.sendQuality !== false) {
    body.quality = normalizeKeystoneQuality(provider?.quality);
  }
  return body;
}

function normalizeImageProviderError(payload) {
  return normalizeKeystoneError(payload);
}

function redactImageProviderText(value) {
  return String(value || "")
    .replace(/\b(?:as_sk_|sk-)[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;"'}]+/gi, "$1=[redacted]")
    .replace(/\b(api[_-]?key|x-api-key|token)\s*[:=]\s*[^\s,;"'}]+/gi, "$1=[redacted]");
}

function redactImageProviderPayload(value) {
  try {
    return JSON.parse(redactImageProviderText(JSON.stringify(value)));
  } catch (_error) {
    return null;
  }
}

async function readImageProviderResponseText(response) {
  const declaredLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > IMAGE_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new Error("图片服务响应超过 80MB 限制。");
  }
  if (!response?.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > IMAGE_PROVIDER_MAX_RESPONSE_BYTES) {
      throw new Error("图片服务响应超过 80MB 限制。");
    }
    return raw;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      totalBytes += chunk.length;
      if (totalBytes > IMAGE_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("图片服务响应超过 80MB 限制。");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchImageProviderJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || IMAGE_JOB_HTTP_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });
    const raw = await readImageProviderResponseText(response);
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(normalizeImageProviderError(payload) || redactImageProviderText(raw) || `HTTP ${response.status}`);
      error.statusCode = response.status;
      error.url = url;
      error.rawBody = redactImageProviderText(raw);
      error.payload = redactImageProviderPayload(payload);
      error.retryable = false;
      throw error;
    }
    if (!payload || typeof payload !== "object") {
      const error = new Error("图片服务返回的不是 JSON 数据。");
      error.retryable = false;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Request timeout: ${url}`);
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildImageProviderRequest(provider, { prompt, aspectRatio, imageUrls = [] }) {
  if (getImageProviderName(provider) === "keystone") {
    return buildKeystoneImageRequest(provider, { prompt, aspectRatio });
  }

  return {
    prompt,
    aspect_ratio: aspectRatio,
    resolution: provider.resolution,
    quality: provider.quality,
    enable_sync_mode: false,
    enable_base64_output: false,
    ...(imageUrls.length ? { images: imageUrls } : {}),
  };
}

function parseImageProviderResult(provider, payload) {
  if (getImageProviderName(provider) === "keystone") {
    const imageUrl = extractKeystoneOutput(payload);
    const error = normalizeKeystoneError(payload);
    return {
      imageUrl,
      status: imageUrl ? "completed" : error ? "failed" : "pending",
      error,
    };
  }

  const imageUrl = extractWavespeedOutput(payload) || "";
  const status = String(payload?.data?.status || "").toLowerCase();
  const error = normalizeWavespeedError(payload);
  return {
    imageUrl,
    status: imageUrl || status === "completed" ? "completed" : status === "failed" || error ? "failed" : "pending",
    error,
  };
}

function parseImageProviderSubmission(provider, payload) {
  const parsed = parseImageProviderResult(provider, payload);
  if (getImageProviderName(provider) === "keystone") {
    return {
      taskId: "",
      resultUrl: "",
      ...parsed,
    };
  }
  return {
    taskId: String(payload?.data?.id || ""),
    resultUrl: String(payload?.data?.urls?.get || payload?.data?.get_result_url || ""),
    ...parsed,
  };
}

function validateImageProviderSubmission(provider, submission) {
  if (submission.status === "failed") {
    throw new Error(submission.error || "图片生成失败。");
  }
  if (submission.imageUrl) return submission;
  if (getImageProviderName(provider) === "keystone") {
    throw new Error("Keystone 图片服务未返回图片数据。");
  }
  if (!submission.resultUrl) {
    throw new Error("图片服务未返回可轮询的任务地址。");
  }
  return submission;
}

function truncateLogValue(value, maxLength = 800) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeWavespeedError(payload) {
  const value = payload?.data?.error || payload?.error || "";
  if (!value) return "";
  return typeof value === "string" ? value : truncateLogValue(value, 1000);
}

function summarizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return truncateLogValue(value, 200);
  }
}

function summarizeWavespeedPayload(payload) {
  const data = payload?.data || {};
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  return {
    upstreamId: data.id || "",
    status: data.status || "",
    error: normalizeWavespeedError(payload),
    outputCount: outputs.length,
    hasGetResultUrl: Boolean(data.urls?.get || data.get_result_url),
    timings: data.timings || null,
    createdAt: data.created_at || data.createdAt || "",
    updatedAt: data.updated_at || data.updatedAt || "",
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
  };
}

function buildImageJobLogContext(job) {
  return {
    jobId: job.id,
    status: job.status,
    providerMode: job.providerMode,
    ageMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    remainingMs: Math.max(0, IMAGE_JOB_TIMEOUT_MS - (Date.now() - job.createdAt)),
    hasResultUrl: Boolean(job.providerResultUrl),
    resultUrl: summarizeUrl(job.providerResultUrl),
    referenceImageUsed: Boolean(job.metadata?.referenceImageUsed),
    generationContext: job.generationContext || null,
  };
}

async function fetchImageProviderResultOnce(provider, job, headers) {
  if (getImageProviderName(provider) === "keystone") {
    return {
      payload: null,
      imageUrl: "",
      status: "failed",
      error: "Keystone 图片任务没有同步返回图片数据。",
      summary: { provider: "keystone", status: "missing-image-data" },
    };
  }

  const options = { headers, timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS };
  const payload = await withRetries(() => fetchJson(job.providerResultUrl, options), { retries: 2, delayMs: 1500 });
  const parsed = parseImageProviderResult(provider, payload);
  return {
    payload,
    ...parsed,
    summary: summarizeWavespeedPayload(payload),
  };
}

function recoverPendingImageJobs({ force = false } = {}) {
  if (recoveryAttempted && !force) {
    return { scanned: 0, timedOut: 0, active: 0 };
  }
  recoveryAttempted = true;
  let pending = [];
  try {
    pending = listPendingJobs({ limit: 500 });
  } catch (error) {
    recoveryAttempted = false;
    console.warn("[image-job] recovery deferred", {
      message: error?.message || "unknown error",
    });
    return { scanned: 0, timedOut: 0, active: 0, deferred: true };
  }

  const now = Date.now();
  let timedOut = 0;
  for (const job of pending) {
    const ageMs = now - Number(job.createdAt || 0);
    if (ageMs > IMAGE_JOB_TIMEOUT_MS) {
      markFailed(job.id, IMAGE_JOB_TIMEOUT_ERROR);
      timedOut += 1;
      console.error("[image-job] recovered timed-out job", {
        jobId: job.id,
        ageMs,
        previousStatus: job.status,
        error: IMAGE_JOB_TIMEOUT_ERROR,
      });
    }
  }
  const active = pending.length - timedOut;
  console.log("[image-job] recovery complete", {
    scanned: pending.length,
    timedOut,
    active,
  });
  return { scanned: pending.length, timedOut, active };
}

function ensureImageJobRecovery() {
  if (!recoveryAttempted) {
    recoverPendingImageJobs();
  }
}

function createImageJobStore() {
  return {
    get(jobId) {
      ensureImageJobRecovery();
      return getJob(jobId);
    },
    set(jobId, job) {
      ensureImageJobRecovery();
      if (!job || typeof job !== "object") return this;
      const payload = { ...job, id: job.id || jobId };
      if (!payload.id) return this;
      if (getJob(payload.id)) {
        updateJob(payload);
      } else {
        createJob(payload);
      }
      return this;
    },
    has(jobId) {
      ensureImageJobRecovery();
      return Boolean(getJob(jobId));
    },
    delete() {
      return true;
    },
  };
}

function isJobTimedOut(job, now = Date.now()) {
  return now - Number(job?.createdAt || 0) > IMAGE_JOB_TIMEOUT_MS;
}

function persistImageJob(job) {
  if (!job?.id) return job;
  return updateJob(job) || job;
}

async function createImageJob(
  appConfig,
  {
    ownerUserId,
    brand,
    trend,
    idea,
    metadata: providedMetadata,
    productImage,
    productImages,
    logoImage,
    styleReferenceImages,
    sourceImageUrls,
    sourceImages,
    aspectRatio,
  },
) {
  ensureImageJobRecovery();
  const provider = appConfig.imageProvider;
  assertConfigured(provider.apiKey, "图片模型 API Key");
  const referenceImages = normalizeImageInputs(productImages || productImage);
  const logoImages = normalizeImageInputs(logoImage);
  const styleImages = normalizeImageInputs(styleReferenceImages);
  const localSourceImages = normalizeImageInputs(sourceImages);
  const sourceUrls = normalizeSourceImageUrls(sourceImageUrls);
  const useReferenceImages = referenceImages.length > 0 || logoImages.length > 0 || styleImages.length > 0;
  const structuredMetadata = applyStructuredImagePrompt(providedMetadata || buildImageConceptMetadata({ brand, trend, idea }), {
    brand,
    trend,
    idea,
  });
  const metadata = withImageReferencePrompt(structuredMetadata, {
    productImages: referenceImages,
    logoImages,
    styleImages,
    profileType: brand?.profileType,
  });
  const providerName = getImageProviderName(provider);
  const isKeystone = providerName === "keystone";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  const keystoneReferenceInputs = isKeystone
    ? [
        ...sourceUrls.map((url, index) => ({ url, name: `source-${index + 1}.png` })),
        ...localSourceImages,
        ...referenceImages,
        ...logoImages,
        ...styleImages,
      ]
    : [];
  const uploadedProductUrls = !isKeystone && referenceImages.length
    ? await Promise.all(referenceImages.map((image) => uploadProductImage(provider, image)))
    : [];
  const uploadedLogoUrls = !isKeystone && logoImages.length
    ? await Promise.all(logoImages.map((image) => uploadProductImage(provider, image)))
    : [];
  const uploadedStyleUrls = !isKeystone && styleImages.length
    ? await Promise.all(styleImages.map((image) => uploadProductImage(provider, image)))
    : [];
  const uploadedSourceUrls = !isKeystone && localSourceImages.length
    ? await Promise.all(localSourceImages.map((image) => uploadProductImage(provider, image)))
    : [];
  const uploadedImageUrls = [...uploadedProductUrls, ...uploadedLogoUrls, ...uploadedStyleUrls];
  const editImageUrls = [...sourceUrls, ...uploadedSourceUrls, ...uploadedImageUrls];
  const useEditModel = isKeystone ? keystoneReferenceInputs.length > 0 : editImageUrls.length > 0;
  const endpoint = useEditModel ? provider.editBaseUrl || provider.baseUrl : provider.baseUrl;
  const outputAspectRatio = aspectRatio || metadata.aspectRatio || provider.aspectRatio;
  const keystoneReferences = isKeystone && useEditModel
    ? await resolveKeystoneReferenceImages(keystoneReferenceInputs)
    : [];
  const body = buildImageProviderRequest(provider, {
    prompt: metadata.prompt,
    aspectRatio: outputAspectRatio,
    imageUrls: useEditModel ? editImageUrls : [],
  });

  console.log("[image-job] creating upstream task", {
    brandId: brand?.id,
    trendId: trend?.id,
    ideaTitle: idea?.title || "",
    providerMode: useEditModel ? "edit" : "text-to-image",
    endpoint: summarizeUrl(endpoint),
    aspectRatio: outputAspectRatio,
    resultResolution: provider.resolution,
    resultQuality: provider.sendQuality === false ? "" : provider.quality,
    hasReferenceImage: useReferenceImages,
    referenceImageCount: referenceImages.length,
    referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
    logoImageCount: logoImages.length,
    styleReferenceImageCount: styleImages.length,
    sourceImageCount: sourceUrls.length + localSourceImages.length,
    uploadedReferenceUrls: uploadedImageUrls.map(summarizeUrl),
    uploadedSourceUrls: uploadedSourceUrls.map(summarizeUrl),
    multipartReferenceCount: keystoneReferences.length,
    promptLength: String(metadata.prompt || "").length,
    promptPreview: truncateLogValue(metadata.prompt || "", 300),
    bodyImageCount: isKeystone ? keystoneReferences.length : editImageUrls.length,
  });

  const requestStartedAt = Date.now();
  let initial = null;
  try {
    initial = await withRetries(
      () => {
        if (isKeystone && useEditModel) {
          return fetchKeystoneImageEdit(provider, endpoint, {
            prompt: metadata.prompt,
            aspectRatio: outputAspectRatio,
            references: keystoneReferences,
          });
        }
        if (isKeystone) {
          return fetchImageProviderJson(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS,
          });
        }
        return fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS,
        });
      },
      { retries: 3, delayMs: 2000 },
    );
  } catch (error) {
    console.error("[image-job] upstream task create failed", {
      brandId: brand?.id,
      trendId: trend?.id,
      ideaTitle: idea?.title || "",
      providerMode: useEditModel ? "edit" : "text-to-image",
      endpoint: summarizeUrl(endpoint),
      statusCode: error?.statusCode || null,
      message: error?.message || "unknown error",
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    try {
      recordAiRun({
        task: EVALUATION_TASKS.IMAGE_GENERATION,
        model: String(provider.model || ""),
        prompt_version: PROMPT_VERSIONS.image_generation,
        latency: Math.max(0, Date.now() - requestStartedAt),
        success: false,
        quality_score: null,
        context: buildImageEvaluationContext({
          ownerUserId,
          brand,
          metadata,
        }),
        metadata: {
          stage: "create",
          providerMode: useEditModel ? "edit" : "text-to-image",
          promptEngine: metadata.promptEngine || "",
          brandId: brand?.id ?? null,
          trendId: trend?.id ?? null,
          errorMessage: String(error?.message || "unknown error").slice(0, 300),
        },
      });
    } catch (evaluationError) {
      console.warn("[image-job] evaluation failure record failed", {
        message: evaluationError?.message || "unknown error",
      });
    }
    try {
      recordImageTaskAttempt({
        jobId: "err_" + Date.now(),
        feature: String(metadata?.contentType || "style_image"),
        provider: providerName,
        model: String(provider.model || KEYSTONE_DEFAULT_MODEL),
        attemptKind: "initial",
        attemptNo: 1,
        status: "failed",
        errorStage: "submission",
        errorCode: String(error?.code || error?.statusCode || "SUBMISSION_ERROR"),
        errorMessage: String(error?.message || "").slice(0, 500),
        startedAt: new Date(requestStartedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        actorUserId: ownerUserId,
      });
    } catch (_) {}
    throw error;
  }

  let submission;
  try {
    submission = parseImageProviderSubmission(provider, initial);
    console.log("[image-job] upstream task accepted", {
      upstreamId: submission.taskId,
      status: submission.status,
      error: submission.error,
      resultUrl: summarizeUrl(submission.resultUrl),
      hasDirectImageUrl: Boolean(submission.imageUrl),
    });
    validateImageProviderSubmission(provider, submission);
  } catch (error) {
    try {
      recordAiRun({
        task: EVALUATION_TASKS.IMAGE_GENERATION,
        model: String(provider.model || ""),
        prompt_version: PROMPT_VERSIONS.image_generation,
        latency: Math.max(0, Date.now() - requestStartedAt),
        success: false,
        quality_score: null,
        context: buildImageEvaluationContext({
          ownerUserId,
          brand,
          metadata,
        }),
        metadata: {
          stage: "validate",
          providerMode: useEditModel ? "edit" : "text-to-image",
          promptEngine: metadata.promptEngine || "",
          brandId: brand?.id ?? null,
          trendId: trend?.id ?? null,
          errorMessage: String(error?.message || "unknown error").slice(0, 300),
        },
      });
    } catch (evaluationError) {
      console.warn("[image-job] evaluation validation failure record failed", {
        message: evaluationError?.message || "unknown error",
      });
    }
    throw error;
  }

  const imageUrl = submission.imageUrl;
  const createdAt = Date.now();
  const job = {
    id: randomId(),
    ownerUserId: Number(ownerUserId || 0),
    status: imageUrl ? "completed" : "pending",
    createdAt,
    evaluationStartedAt: requestStartedAt,
    provider: providerName,
    providerMode: useEditModel ? "edit" : "text-to-image",
    providerResultUrl: submission.resultUrl,
    providerHeaders: headers,
    model: provider.model || KEYSTONE_DEFAULT_MODEL,
    metadata: {
      ...metadata,
      brandId: brand?.id ?? metadata.brandId ?? null,
      brandName: brand?.name || metadata.brandName || "",
      industry: brand?.industry || metadata.industry || "",
      providerTaskId: submission.taskId,
      aspectRatio: outputAspectRatio,
      sourceImageUrls: isKeystone ? sourceUrls : [...sourceUrls, ...uploadedSourceUrls],
      referenceImageName: referenceImages[0]?.name || "",
      referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
      referenceImageUrl: uploadedImageUrls[0] || "",
      referenceImageUrls: uploadedProductUrls,
      logoImageUrls: uploadedLogoUrls,
      styleReferenceImageUrls: uploadedStyleUrls,
      referenceImageCount: referenceImages.length,
      referenceImageUsed: useReferenceImages,
      logoImageUsed: logoImages.length > 0,
      styleReferenceImageUsed: styleImages.length > 0,
    },
    imageUrl: imageUrl || "",
    error: "",
    evaluationRunId: "",
  };

  if (job.status === "completed") {
    recordImageJobEvaluation(job, { success: true });
  }
  try {
    recordImageTaskAttempt({
      jobId: job.id,
      feature: String(metadata?.contentType || "style_image"),
      provider: providerName,
      model: String(job.model || KEYSTONE_DEFAULT_MODEL),
      attemptKind: "initial",
      attemptNo: 1,
      status: imageUrl ? "completed" : "pending",
      startedAt: new Date(requestStartedAt).toISOString(),
      completedAt: imageUrl ? new Date().toISOString() : "",
      durationMs: imageUrl ? Math.max(0, Date.now() - requestStartedAt) : 0,
      actorUserId: ownerUserId,
    });
  } catch (_) {}

  return createJob(job);
}

function buildImageEvaluationContext({ ownerUserId, brand, metadata, job } = {}) {
  const meta = metadata || job?.metadata || {};
  const generationContext = job?.generationContext || {};
  const brandId =
    brand?.id ??
    meta.brandId ??
    generationContext.brandId ??
    "";
  return {
    user_id: ownerUserId ?? job?.ownerUserId ?? generationContext.userId ?? "",
    brand_id: brandId,
    brand_name: brand?.name || meta.brandName || generationContext.brandName || "",
    industry: brand?.industry || meta.industry || generationContext.industry || "",
    generation_id: job?.generationId ?? generationContext.sourceGenerationId ?? meta.generationId ?? "",
    content_type: meta.contentType || generationContext.contentType || "",
    platform: meta.platform || generationContext.platform || "",
  };
}

function recordImageJobEvaluation(job, { success, errorMessage = "" } = {}) {
  if (!job || job.evaluationRunId) return job;
  try {
    const evaluationRun = recordAiRun({
      task: EVALUATION_TASKS.IMAGE_GENERATION,
      model: String(job.model || ""),
      prompt_version: PROMPT_VERSIONS.image_generation,
      latency: Math.max(0, Date.now() - Number(job.evaluationStartedAt || job.createdAt || Date.now())),
      success: Boolean(success),
      quality_score: null,
      context: buildImageEvaluationContext({ job }),
      metadata: {
        jobId: job.id,
        provider: job.provider || "",
        providerMode: job.providerMode || "",
        promptEngine: job.metadata?.promptEngine || "",
        brandId: job.metadata?.brandId ?? job.generationContext?.brandId ?? null,
        trendId: job.metadata?.trendId ?? job.generationContext?.trendId ?? null,
        contentType: job.metadata?.contentType || "",
        platform: job.metadata?.platform || "",
        errorMessage: String(errorMessage || job.error || "").slice(0, 300),
      },
    });
    job.evaluationRunId = evaluationRun.id;
  } catch (evaluationError) {
    console.warn("[image-job] evaluation record failed", {
      jobId: job?.id,
      message: evaluationError?.message || "unknown error",
    });
  }
  return job;
}

function normalizeImageInputs(input) {
  const images = Array.isArray(input) ? input : input ? [input] : [];
  return images
    .filter((image) => image?.dataUrl)
    .map((image) => ({
      ...image,
      name: String(image.name || image.fileName || "product-image.png"),
      dataUrl: String(image.dataUrl || ""),
    }))
    .slice(0, 8);
}

function normalizeSourceImageUrls(input) {
  const urls = Array.isArray(input) ? input : input ? [input] : [];
  return urls.map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).slice(0, 8);
}

async function uploadProductImage(provider, productImage) {
  if (!provider.uploadBaseUrl) {
    throw new Error("图片编辑需要先配置 IMAGE_UPLOAD_BASE_URL。");
  }

  const parsed = parseDataUrl(productImage.dataUrl);
  const fileName = productImage.name || "product-image.png";

  console.log("[image-job] uploading reference image", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    fileName,
    mimeType: parsed.mimeType,
    bytes: parsed.buffer.length,
  });

  const response = await withRetries(
    () => {
      const formData = new FormData();
      formData.append("file", new Blob([parsed.buffer], { type: parsed.mimeType }), fileName);
      return (
      fetch(provider.uploadBaseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      })
      );
    },
    { retries: 3, delayMs: 1500 },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[image-job] reference image upload failed", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      statusText: response.statusText,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error(payload?.error?.message || payload?.error || payload?.message || `产品图上传失败：HTTP ${response.status}`);
  }

  const url = payload?.data?.download_url || payload?.data?.url || payload?.download_url || payload?.url || "";
  if (!url) {
    console.error("[image-job] reference image upload missing url", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error("产品图上传成功但未返回可用于生图的图片 URL。");
  }
  console.log("[image-job] reference image uploaded", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    imageUrl: summarizeUrl(url),
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : [],
  });
  return url;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("产品图格式无效，请重新上传图片。");
  }
  const mimeType = String(match[1] || "").toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error("图片格式不受当前图片服务支持，请使用 PNG、JPG、WEBP 或 GIF。");
  }
  return {
    mimeType,
    buffer: Buffer.from(match[2], "base64"),
  };
}

function sanitizeImageFileName(value, fallback = "reference-image.png") {
  const name = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return (name || fallback).slice(0, 120);
}

function imageExtensionForMimeType(mimeType) {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[String(mimeType || "").toLowerCase()] || "png";
}

function imageFileNameFromUrl(url, index, mimeType) {
  try {
    const pathname = new URL(String(url || "")).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).pop();
    if (lastSegment && /\.[a-z0-9]{2,5}$/i.test(lastSegment)) {
      return sanitizeImageFileName(lastSegment, `reference-${index + 1}.${imageExtensionForMimeType(mimeType)}`);
    }
  } catch (_error) {
    // Use a deterministic safe name below.
  }
  return `reference-${index + 1}.${imageExtensionForMimeType(mimeType)}`;
}

async function resolveKeystoneReferenceImage(input, index) {
  if (input?.dataUrl) {
    const parsed = parseDataUrl(input.dataUrl);
    if (parsed.buffer.length > IMAGE_PROVIDER_REFERENCE_MAX_BYTES) {
      throw new Error("参考图超过 10MB 限制，请压缩后重试。");
    }
    return {
      ...parsed,
      fileName: sanitizeImageFileName(input.name || input.fileName, `reference-${index + 1}.${imageExtensionForMimeType(parsed.mimeType)}`),
    };
  }

  const url = String(input?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("参考图地址无效，请重新选择图片。");
  }
  const downloaded = await fetchRemoteImageBytes(url, { maxBytes: IMAGE_PROVIDER_REFERENCE_MAX_BYTES });
  return {
    buffer: downloaded.buffer,
    mimeType: downloaded.mimeType,
    fileName: imageFileNameFromUrl(url, index, downloaded.mimeType),
  };
}

async function resolveKeystoneReferenceImages(inputs) {
  return Promise.all(inputs.map((input, index) => resolveKeystoneReferenceImage(input, index)));
}

function buildKeystoneEditFormData(provider, { prompt, aspectRatio, references = [] }) {
  if (!references.length) {
    throw new Error("图片编辑至少需要一张参考图。");
  }
  const body = buildKeystoneImageRequest(provider, { prompt, aspectRatio });
  const formData = new FormData();
  formData.append("model", body.model);
  formData.append("prompt", body.prompt);
  formData.append("size", body.size);
  if (body.quality) formData.append("quality", body.quality);
  formData.append("n", String(body.n));

  const fieldName = references.length === 1 ? "image" : "image[]";
  for (const reference of references) {
    formData.append(
      fieldName,
      new Blob([reference.buffer], { type: reference.mimeType }),
      sanitizeImageFileName(reference.fileName),
    );
  }
  return formData;
}

async function fetchKeystoneImageEdit(provider, endpoint, options) {
  const formData = buildKeystoneEditFormData(provider, options);
  return fetchImageProviderJson(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: formData,
    timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS,
  });
}

function withImageReferencePrompt(metadata, { productImages, logoImages, styleImages, profileType }) {
  const productCount = Array.isArray(productImages) ? productImages.length : 0;
  const logoCount = Array.isArray(logoImages) ? logoImages.length : 0;
  const styleCount = Array.isArray(styleImages) ? styleImages.length : 0;
  if (!productCount && !logoCount && !styleCount) return metadata;
  const hints = [];
  if (productCount) {
    hints.push(
      productCount === 1
        ? "请参考输入图片中的产品外观、材质、包装、颜色和品牌识别元素，把该产品自然融入画面；不要改变产品核心造型，不要生成与参考产品冲突的包装。"
        : `请参考输入的 ${productCount} 张产品图，把这些图片中的物品作为画面主体或主体组合；保留各产品的核心造型、材质、包装、颜色和品牌识别元素，不要混淆不同产品，不要生成与参考产品冲突的包装。`,
    );
  }
  if (logoCount) {
    hints.push(
      profileType === "personal"
        ? "输入图片是个人头像参考，只用于保持人物身份与外貌特征一致；不要把头像当成 Logo、贴纸或独立商品，不要复制证件照构图。"
        : "请把输入的品牌 Logo 作为产品/品牌标识使用，保持 Logo 文字和图形清晰、比例正确；不要把 Logo 当成独立产品主体，也不要改写 Logo。",
    );
  }
  if (styleCount) {
    hints.push("请参考输入的风格图来借鉴色调、光影、版式、材质和整体氛围，但不要直接复制风格图里的具体物体或文字。");
  }
  return {
    ...metadata,
    prompt: `${metadata.prompt}\n\n${hints.join("\n")}`,
  };
}

async function resolveImageJob(appConfig, jobOrId) {
  ensureImageJobRecovery();

  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId?.id;
  let job = jobId ? getJob(jobId) : null;
  if (!job && jobOrId && typeof jobOrId === "object" && jobOrId.id) {
    job = jobOrId;
  }
  if (!job) {
    const error = new Error("图片任务不存在或已过期。");
    error.code = "IMAGE_JOB_NOT_FOUND";
    throw error;
  }

  if (job.status === "completed" || job.status === "failed") {
    return job;
  }

  if (isJobTimedOut(job)) {
    const failed = markFailed(job.id, IMAGE_JOB_TIMEOUT_ERROR);
    recordImageJobEvaluation(failed || job, { success: false, errorMessage: IMAGE_JOB_TIMEOUT_ERROR });
    console.error("[image-job] timed out", {
      ...buildImageJobLogContext(failed || job),
      error: IMAGE_JOB_TIMEOUT_ERROR,
    });
    return failed || { ...job, status: "failed", error: IMAGE_JOB_TIMEOUT_ERROR };
  }

  if (job.status !== "running") {
    job.status = "running";
    job = persistImageJob(job) || job;
  }

  try {
    const provider = { ...appConfig.imageProvider, provider: job.provider || appConfig.imageProvider.provider };
    const polled = await fetchImageProviderResultOnce(provider, job, getImageJobProviderHeaders(appConfig, job));
    console.log("[image-job] polled upstream result", {
      ...buildImageJobLogContext(job),
      upstreamStatus: polled.status || "",
      hasImageUrl: Boolean(polled.imageUrl),
      upstreamError: polled.error || "",
      upstreamSummary: polled.summary,
    });
    if (polled.status === "completed" && polled.imageUrl) {
      job.status = "completed";
      job.imageUrl = polled.imageUrl;
      job.error = "";
      console.log("[image-job] completed", {
        ...buildImageJobLogContext(job),
        imageUrl: summarizeUrl(job.imageUrl),
      });
      recordImageJobEvaluation(job, { success: true });
      try {
        recordImageTaskAttempt({
          jobId: job.id,
          feature: String(job.generationContext?.type || job.metadata?.contentType || "style_image"),
          provider: String(job.provider || "keystone"),
          model: String(job.model || KEYSTONE_DEFAULT_MODEL),
          attemptKind: "initial",
          attemptNo: 1,
          status: "completed",
          startedAt: new Date(job.createdAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - Number(job.createdAt || Date.now())),
          actorUserId: job.ownerUserId,
        });
      } catch (_) {}
    } else if (polled.status === "failed") {
      job.status = "failed";
      job.error = polled.error || "图片生成失败";
      console.error("[image-job] upstream marked failed", {
        ...buildImageJobLogContext(job),
        error: job.error,
        upstreamSummary: polled.summary,
        upstreamPayload: truncateLogValue(polled.payload, 2000),
      });
      recordImageJobEvaluation(job, { success: false, errorMessage: job.error });
      try {
        recordImageTaskAttempt({
          jobId: job.id,
          feature: String(job.generationContext?.type || job.metadata?.contentType || "style_image"),
          provider: String(job.provider || "keystone"),
          model: String(job.model || KEYSTONE_DEFAULT_MODEL),
          attemptKind: "initial",
          attemptNo: 1,
          status: "failed",
          errorStage: "provider",
          errorCode: "PROVIDER_FAILED",
          errorMessage: String(job.error || "").slice(0, 500),
          startedAt: new Date(job.createdAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - Number(job.createdAt || Date.now())),
          actorUserId: job.ownerUserId,
        });
      } catch (_) {}
    } else if (isJobTimedOut(job)) {
      job.status = "failed";
      job.error = IMAGE_JOB_TIMEOUT_ERROR;
      console.error("[image-job] timed out", {
        ...buildImageJobLogContext(job),
        upstreamSummary: polled.summary,
      });
      recordImageJobEvaluation(job, { success: false, errorMessage: job.error });
    } else {
      job.status = "pending";
    }
  } catch (error) {
    console.error("[image-job] polling error", {
      ...buildImageJobLogContext(job),
      message: error?.message || "unknown error",
      statusCode: error?.statusCode || null,
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    if (isJobTimedOut(job)) {
      job.status = "failed";
      job.error = IMAGE_JOB_TIMEOUT_ERROR;
      recordImageJobEvaluation(job, { success: false, errorMessage: job.error });
    } else {
      job.status = "pending";
    }
  }

  return persistImageJob(job) || job;
}

function buildImageJobResponse(job) {
  const metadata = job.metadata && typeof job.metadata === "object" ? job.metadata : {};
  return {
    jobId: job.id,
    status: job.status,
    elapsedMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    imageConcept:
      job.status === "completed"
        ? {
            title: metadata.title || "",
            caption: metadata.caption || "",
            publishTitle: metadata.publishTitle || "",
            publishCaption: metadata.publishCaption || "",
            intro: metadata.intro || "",
            outline: Array.isArray(metadata.outline) ? metadata.outline : [],
            positioning: metadata.positioning || "",
            cta: metadata.cta || "",
            visualDirection: metadata.visualDirection || "",
            style: metadata.style || "",
            composition: metadata.composition || "",
            copy: metadata.copy || "",
            pageLabel: metadata.pageLabel || "",
            slideIndex: metadata.slideIndex ?? null,
            aspectRatio: metadata.aspectRatio || "",
            referenceImageUsed: Boolean(metadata.referenceImageUsed),
            logoImageUsed: Boolean(metadata.logoImageUsed),
            styleReferenceImageUsed: Boolean(metadata.styleReferenceImageUsed),
            previewUrl: job.imageUrl,
            imageUrl: job.imageUrl,
          }
        : null,
    error: job.error || "",
  };
}

function getImageJobProviderHeaders(appConfig, job) {
  if (job.providerHeaders?.Authorization) return job.providerHeaders;
  assertConfigured(appConfig.imageProvider.apiKey, "图片模型 API Key");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${appConfig.imageProvider.apiKey}`,
  };
}

module.exports = {
  IMAGE_JOB_TIMEOUT_MS,
  IMAGE_JOB_HTTP_TIMEOUT_MS,
  IMAGE_JOB_TIMEOUT_ERROR,
  buildImageConceptMetadata,
  applyStructuredImagePrompt,
  createImageJob,
  resolveImageJob,
  buildImageJobResponse,
  getImageJobProviderHeaders,
  buildImageProviderRequest,
  buildKeystoneEditFormData,
  parseImageProviderSubmission,
  parseImageProviderResult,
  validateImageProviderSubmission,
  recordImageJobEvaluation,
  recoverPendingImageJobs,
  createImageJobStore,
  ensureImageJobRecovery,
};
