const { getVideoModelConfig } = require("../video-model-registry");
const { requestProviderJson } = require("../video-provider-http");

const DEFAULT_OUTPUT_HOSTS = ["platform-outputs.agnes-ai.space", "cos-platform-outputs.agnes-ai.cn"];

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function pickVideoId(payload) {
  return String(payload?.video_id || payload?.videoId || payload?.data?.video_id || payload?.data?.videoId || payload?.id || "").trim();
}

function normalizeStatus(value, hasVideoUrl = false) {
  const status = String(value || "").toLowerCase();
  if (hasVideoUrl || ["success", "succeeded", "completed", "complete", "done", "finished"].includes(status)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "running";
}

function readMetadataUrl(payload) {
  return String(
    payload?.metadata?.url || payload?.data?.metadata?.url || payload?.metadata?.video_url ||
    payload?.url || payload?.video_url || payload?.videoUrl || payload?.output_url ||
    payload?.data?.url || payload?.data?.video_url || payload?.data?.videoUrl || payload?.data?.output_url || "",
  ).trim();
}

function createG2Provider({ appConfig = {}, fetchImpl = fetch } = {}) {
  const config = getVideoModelConfig("g2");
  const providerConfig = appConfig.video?.agnes || {};
  const baseUrl = String(providerConfig.baseUrl || "https://api.agnes-ai.cn").replace(/\/+$/, "");
  const outputHosts = [
    ...DEFAULT_OUTPUT_HOSTS,
    ...(Array.isArray(providerConfig.outputHosts) ? providerConfig.outputHosts : []),
  ];
  const submitTimeoutMs = Number(appConfig.video?.submitTimeoutMs || 45000);
  const pollTimeoutMs = Number(appConfig.video?.pollTimeoutMs || 20000);

  async function request(url, apiKey, options = {}) {
    if (!apiKey) {
      const error = new Error("Agnes 视频 API Key 未配置");
      error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
      throw error;
    }
    return requestProviderJson(fetchImpl, url, {
      ...options,
      phase: options.phase || "poll",
      timeoutMs: options.phase === "submit" ? submitTimeoutMs : pollTimeoutMs,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(options.headers || {}) },
      errorMessage: (payload, status) => payload?.error?.message || payload?.message || `Agnes 视频请求失败：HTTP ${status}`,
    });
  }

  return {
    id: "g2",
    provider: "agnes",
    modelConfig: config,
    getAllowedHosts() {
      // The API host is not implicitly an output host. Keep the download
      // allowlist narrow and independently configurable.
      return [...new Set(outputHosts.map((host) => String(host || "").trim()).filter(Boolean))];
    },
    async submitClip({ apiKey, prompt, durationSec, aspectRatio, mode = "text", referenceUrls = [], firstFrameUrl = "", signal } = {}) {
      const body = {
        model: "agnes-video-2.5-flash",
        prompt: String(prompt || "").slice(0, 12000),
        mode: String(mode || "text"),
        seconds: String(durationSec),
        size: "720P",
        aspect_ratio: String(aspectRatio || "9:16"),
        seed: 0,
        n: 1,
      };
      if (body.mode === "reference") body.images = referenceUrls.slice(0, config.maxReferenceImages);
      if (body.mode === "keyframe") body.first_frame = String(firstFrameUrl || "");
      const payload = await request(joinUrl(baseUrl, "/v1/videos"), apiKey, { method: "POST", body: JSON.stringify(body), signal, phase: "submit" });
      const videoId = pickVideoId(payload);
      if (!videoId) throw Object.assign(new Error("Agnes 未返回 video_id"), { uncertainSubmission: true });
      return { taskId: videoId, payload, requestBody: body };
    },
    async getTaskStatus({ taskId, apiKey, signal } = {}) {
      const query = new URLSearchParams({ video_id: String(taskId || ""), model_name: "agnes-video-2.5-flash" });
      const payload = await request(`${baseUrl}${providerConfig.pollPath || "/agnesapi"}?${query}`, apiKey, { method: "GET", signal, phase: "poll" });
      return this.normalizeResult(payload);
    },
    normalizeResult(payload) {
      const videoUrl = readMetadataUrl(payload);
      const status = normalizeStatus(payload?.status || payload?.data?.status || payload?.state || payload?.data?.state, Boolean(videoUrl));
      return {
        status,
        videoUrl,
        nativeLastFrameUrl: "",
        error: String(payload?.error?.message || payload?.error || payload?.message || ""),
        payload,
      };
    },
  };
}

module.exports = {
  createG2Provider,
  pickVideoId,
  readMetadataUrl,
};
