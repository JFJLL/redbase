const { getVideoModelConfig } = require("../video-model-registry");

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
    payload?.data?.url || payload?.video_url || payload?.videoUrl || "",
  ).trim();
}

function createG2Provider({ appConfig = {}, fetchImpl = fetch } = {}) {
  const config = getVideoModelConfig("g2");
  const providerConfig = appConfig.video?.agnes || {};
  const baseUrl = String(providerConfig.baseUrl || "https://api.agnes-ai.cn").replace(/\/+$/, "");

  async function request(url, apiKey, options = {}) {
    if (!apiKey) {
      const error = new Error("Agnes 视频 API Key 未配置");
      error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(options.headers || {}) },
      });
    } catch (error) {
      error.uncertainSubmission = true;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || `Agnes 视频请求失败：HTTP ${response.status}`);
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return {
    id: "g2",
    provider: "agnes",
    modelConfig: config,
    getAllowedHosts() {
      return [new URL(baseUrl).hostname, "agnes-ai.cn", "agnes-ai.com"];
    },
    async submitClip({ apiKey, prompt, durationSec, aspectRatio, mode = "text", referenceUrls = [], firstFrameUrl = "" } = {}) {
      const body = {
        model: "agnes-video-2.5-flash",
        prompt: String(prompt || "").slice(0, 12000),
        mode: String(mode || "text"),
        seconds: String(durationSec),
        size: "720P",
        aspect_ratio: String(aspectRatio || "9:16"),
        seed: -1,
        n: 1,
      };
      if (body.mode === "reference") body.images = referenceUrls.slice(0, config.maxReferenceImages);
      if (body.mode === "keyframe") body.first_frame = String(firstFrameUrl || "");
      const payload = await request(joinUrl(baseUrl, "/v1/videos"), apiKey, { method: "POST", body: JSON.stringify(body) });
      const videoId = pickVideoId(payload);
      if (!videoId) throw Object.assign(new Error("Agnes 未返回 video_id"), { uncertainSubmission: true });
      return { taskId: videoId, payload, requestBody: body };
    },
    async getTaskStatus({ taskId, apiKey } = {}) {
      const query = new URLSearchParams({ video_id: String(taskId || ""), model_name: "agnes-video-2.5-flash" });
      const payload = await request(`${baseUrl}${providerConfig.pollPath || "/agnesapi"}?${query}`, apiKey, { method: "GET" });
      return this.normalizeResult(payload);
    },
    normalizeResult(payload) {
      const videoUrl = readMetadataUrl(payload);
      const status = normalizeStatus(payload?.status || payload?.data?.status, Boolean(videoUrl));
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
