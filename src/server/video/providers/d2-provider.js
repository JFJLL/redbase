const { getVideoModelConfig } = require("../video-model-registry");
const { requestProviderJson } = require("../video-provider-http");

const DEFAULT_OUTPUT_HOSTS = ["runninghub.ai", "runninghub.cn"];
const VIDEO_OUTPUT_TYPES = new Set(["mp4", "webm", "mov", "m4v", "video/mp4", "video/webm", "video/quicktime"]);
const IMAGE_OUTPUT_TYPES = new Set(["png", "jpg", "jpeg", "webp", "gif", "image/png", "image/jpeg", "image/webp", "image/gif"]);

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function pickTaskId(payload) {
  return String(payload?.taskId || payload?.task_id || payload?.data?.taskId || payload?.data?.task_id || payload?.id || payload?.data?.id || "").trim();
}

function pickCandidateUrl(value) {
  if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  if (!value || typeof value !== "object") return "";
  return String(
    value.url || value.videoUrl || value.video_url || value.video || value.outputUrl || value.output_url ||
    value.downloadUrl || value.download_url || value.fileUrl || value.file_url || "",
  ).trim();
}

function outputTypeOf(value, url = "") {
  const explicit = String(value?.outputType || value?.output_type || value?.mimeType || value?.mime_type || "").trim().toLowerCase();
  if (explicit && (VIDEO_OUTPUT_TYPES.has(explicit) || IMAGE_OUTPUT_TYPES.has(explicit) || explicit.startsWith("video/") || explicit.startsWith("image/"))) return explicit;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".mp4") ? "mp4" : pathname.endsWith(".webm") ? "webm" : pathname.endsWith(".mov") ? "mov" :
      [".png", ".jpg", ".jpeg", ".webp", ".gif"].find((extension) => pathname.endsWith(extension))?.slice(1) || "";
  } catch (_error) {
    return "";
  }
}

function classifyCandidate(value) {
  const url = pickCandidateUrl(value);
  const outputType = outputTypeOf(value, url);
  return {
    value,
    url,
    outputType,
    isVideo: VIDEO_OUTPUT_TYPES.has(outputType) || outputType.startsWith("video/"),
    isImage: IMAGE_OUTPUT_TYPES.has(outputType) || outputType.startsWith("image/"),
  };
}

function collectResultCandidates(payload) {
  const source = payload?.results ?? payload?.data?.results ?? payload?.data ?? payload;
  if (Array.isArray(source)) return source.map(classifyCandidate);
  if (source && typeof source === "object") {
    return [source, ...(Array.isArray(source.outputs) ? source.outputs : [])].map(classifyCandidate);
  }
  return [];
}

function pickExplicitLastFrame(payload, candidates) {
  const explicit = [
    payload?.lastFrameUrl,
    payload?.last_frame_url,
    payload?.lastFrame,
    payload?.last_frame,
    payload?.data?.lastFrameUrl,
    payload?.data?.last_frame_url,
    payload?.data?.lastFrame,
    payload?.data?.last_frame,
  ].map((value) => pickCandidateUrl(value) || String(value || "").trim()).find((value) => /^https:\/\//i.test(value));
  if (explicit) return explicit;
  const namedResult = candidates
    .filter((candidate) => /last[ _-]?frame/i.test(String(
      candidate.value?.outputType || candidate.value?.output_type || candidate.value?.type || candidate.value?.role || "",
    )))
    .map((candidate) => candidate.url)
    .find((value) => /^https:\/\//i.test(value));
  if (namedResult) return namedResult;
  return candidates
    .filter((candidate) => candidate.isImage)
    .map((candidate) => candidate.value?.lastFrameUrl || candidate.value?.last_frame_url || candidate.value?.lastFrame || candidate.value?.last_frame || "")
    .map((value) => pickCandidateUrl(value) || String(value || "").trim())
    .find((value) => /^https:\/\//i.test(value)) || "";
}

function normalizeStatus(value, hasVideoUrl = false) {
  const status = String(value || "").toLowerCase();
  if (hasVideoUrl || ["success", "succeed", "completed", "complete", "done", "finished"].includes(status)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled", "expired"].includes(status)) return "failed";
  return "running";
}

function compileD2Prompt(prompt, { referenceUrls = [], referenceLabels = [] } = {}) {
  const source = String(prompt || "").trim().replace(/@Image\s*(\d+)/gi, (_match, rawIndex) => {
    const index = Number(rawIndex);
    return index >= 1 && index <= referenceUrls.length ? `@Image ${index}` : "参考图";
  });
  if (!referenceUrls.length) return source.slice(0, 12000);
  const mapping = referenceUrls.map((_, index) => {
    const label = String(referenceLabels[index] || (index === 0 ? "产品参考图" : `参考图${index + 1}`))
      .replace(/@Image\s*\d+/gi, "参考图");
    return `@Image ${index + 1}：${label}`;
  });
  return `${source}\n\n【D2 参考图对应关系】\n${mapping.join("\n")}\n请严格保持上述 @Image 编号与实际参考图顺序一致，不引用不存在的图片编号。`.slice(0, 12000);
}

function normalizeResolution(value) {
  const raw = String(value || "720p").trim();
  if (raw.toLowerCase() === "2k") return "2K";
  if (raw.toLowerCase() === "1080p") return "1080p";
  return "720p";
}

function createD2Provider({ appConfig = {}, fetchImpl = fetch } = {}) {
  const config = getVideoModelConfig("d2");
  const providerConfig = appConfig.video?.runninghub || {};
  const baseUrl = String(providerConfig.baseUrl || "https://www.runninghub.ai/openapi/v2").replace(/\/+$/, "");
  const submitPath = String(providerConfig.submitPath || "/rhart-video/sparkvideo-2.0/multimodal-video").trim();
  const apiKey = String(providerConfig.apiKey || "").trim();
  const submitTimeoutMs = Number(appConfig.video?.submitTimeoutMs || 45000);
  const pollTimeoutMs = Number(appConfig.video?.pollTimeoutMs || 20000);
  const outputHosts = Array.isArray(providerConfig.outputHosts) && providerConfig.outputHosts.length
    ? providerConfig.outputHosts
    : DEFAULT_OUTPUT_HOSTS;

  async function request(url, options = {}, phase = "poll") {
    if (!apiKey) {
      const error = new Error("RunningHub 视频 API Key 未配置");
      error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
      throw error;
    }
    return requestProviderJson(fetchImpl, url, {
      ...options,
      phase,
      timeoutMs: phase === "submit" ? submitTimeoutMs : pollTimeoutMs,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      errorMessage: (payload, status) => payload?.message || payload?.errorMessage || `RunningHub 视频请求失败：HTTP ${status}`,
    });
  }

  return {
    id: "d2",
    provider: "runninghub",
    modelConfig: config,
    getAllowedHosts() {
      // Media output hosts are intentionally separate from the API hostname;
      // only this narrow, explicitly configured list reaches SSRF validation.
      return [...new Set(outputHosts.map((host) => String(host || "").trim()).filter(Boolean))];
    },
    async submitClip({ prompt, resolution, durationSec, aspectRatio, referenceUrls = [], referenceLabels = [], signal } = {}) {
      const boundedReferenceUrls = Array.isArray(referenceUrls) ? referenceUrls.slice(0, config.maxReferenceImages) : [];
      const boundedReferenceLabels = Array.isArray(referenceLabels) ? referenceLabels.slice(0, boundedReferenceUrls.length) : [];
      const body = {
        prompt: compileD2Prompt(prompt, { referenceUrls: boundedReferenceUrls, referenceLabels: boundedReferenceLabels }),
        resolution: normalizeResolution(resolution),
        duration: String(durationSec),
        generateAudio: true,
        ratio: String(aspectRatio || "9:16"),
        realPersonMode: true,
        conversionSlots: ["all"],
        returnLastFrame: true,
        seed: -1,
      };
      // The current multimodal contract documents no watermark field. Keep
      // RedBase's no-watermark product policy in the prompt/endpoint default,
      // but do not send an undocumented field to this endpoint.
      if (boundedReferenceUrls.length) body.imageUrls = boundedReferenceUrls;
      const payload = await request(joinUrl(baseUrl, submitPath || "/rhart-video/sparkvideo-2.0/multimodal-video"), {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      }, "submit");
      const taskId = pickTaskId(payload);
      if (!taskId) throw Object.assign(new Error("RunningHub 未返回 taskId"), { uncertainSubmission: true });
      return { taskId, payload, requestBody: body };
    },
    async getTaskStatus({ taskId, signal } = {}) {
      const payload = await request(joinUrl(baseUrl, providerConfig.pollPath || "/query"), {
        method: "POST",
        body: JSON.stringify({ taskId: String(taskId || "") }),
        signal,
      }, "poll");
      return this.normalizeResult(payload);
    },
    normalizeResult(payload) {
      const candidates = collectResultCandidates(payload);
      const videoCandidates = candidates
        .filter((candidate) => candidate.isVideo)
        .sort((left, right) => Number(right.outputType === "mp4") - Number(left.outputType === "mp4"));
      const explicitVideo = [payload?.videoUrl, payload?.video_url, payload?.data?.videoUrl, payload?.data?.video_url]
        .map((value) => pickCandidateUrl(value) || String(value || "").trim())
        .find((value) => /^https:\/\//i.test(value));
      const videoUrl = videoCandidates[0]?.url || explicitVideo || "";
      const nativeLastFrameUrl = pickExplicitLastFrame(payload, candidates);
      const status = normalizeStatus(payload?.status || payload?.data?.status || payload?.taskStatus || payload?.task_status, Boolean(videoUrl));
      if (status === "completed" && !videoUrl) return { status: "failed", error: "RunningHub 完成但没有返回可识别的视频地址", payload };
      return {
        status,
        videoUrl,
        nativeLastFrameUrl,
        error: String(payload?.errorMessage || payload?.message || payload?.error || ""),
        payload,
      };
    },
  };
}

module.exports = {
  createD2Provider,
  pickTaskId,
  normalizeStatus,
  classifyCandidate,
  compileD2Prompt,
  normalizeResolution,
};
