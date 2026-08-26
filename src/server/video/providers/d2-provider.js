const { getVideoModelConfig } = require("../video-model-registry");

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function pickTaskId(payload) {
  return String(payload?.taskId || payload?.task_id || payload?.data?.taskId || payload?.data?.task_id || payload?.id || payload?.data?.id || "").trim();
}

function pickUrl(value) {
  if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  if (!value || typeof value !== "object") return "";
  return String(value.videoUrl || value.video_url || value.url || value.video || value.outputUrl || value.output_url || value.downloadUrl || value.download_url || value.fileUrl || "").trim();
}

function collectResultCandidates(payload) {
  const results = [];
  const source = payload?.results ?? payload?.data?.results ?? payload?.data ?? payload;
  if (Array.isArray(source)) results.push(...source);
  else if (source && typeof source === "object") results.push(source, ...(Array.isArray(source.outputs) ? source.outputs : []));
  return results;
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (["success", "succeed", "completed", "complete", "done", "finished"].includes(status)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "running";
}

function createD2Provider({ appConfig = {}, fetchImpl = fetch } = {}) {
  const config = getVideoModelConfig("d2");
  const providerConfig = appConfig.video?.runninghub || {};
  const baseUrl = String(providerConfig.baseUrl || "https://www.runninghub.ai/openapi/v2").replace(/\/+$/, "");
  const apiKey = String(providerConfig.apiKey || "").trim();

  async function request(url, options = {}) {
    if (!apiKey) {
      const error = new Error("RunningHub 视频 API Key 未配置");
      error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      error.uncertainSubmission = true;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.errorMessage || `RunningHub 视频请求失败：HTTP ${response.status}`);
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return {
    id: "d2",
    provider: "runninghub",
    modelConfig: config,
    getAllowedHosts() {
      return [new URL(baseUrl).hostname, "runninghub.ai", "runninghub.cn"];
    },
    async submitClip({ prompt, resolution, durationSec, aspectRatio, referenceUrls = [] } = {}) {
      const body = {
        prompt: String(prompt || "").slice(0, 12000),
        resolution: String(resolution || "720p"),
        duration: String(durationSec),
        generateAudio: true,
        watermark: false,
        ratio: String(aspectRatio || "9:16"),
        realPersonMode: true,
        conversionSlots: ["all"],
        returnLastFrame: true,
        seed: -1,
      };
      if (Array.isArray(referenceUrls) && referenceUrls.length) body.imageUrls = referenceUrls.slice(0, config.maxReferenceImages);
      const payload = await request(joinUrl(baseUrl, "/rhart-video/sparkvideo-2.0/multimodal-video"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      const taskId = pickTaskId(payload);
      if (!taskId) throw Object.assign(new Error("RunningHub 未返回 taskId"), { uncertainSubmission: true });
      return { taskId, payload, requestBody: body };
    },
    async getTaskStatus({ taskId } = {}) {
      const payload = await request(joinUrl(baseUrl, providerConfig.pollPath || "/query"), {
        method: "POST",
        body: JSON.stringify({ taskId: String(taskId || "") }),
      });
      return this.normalizeResult(payload);
    },
    normalizeResult(payload) {
      const candidates = collectResultCandidates(payload);
      const videoUrl = candidates.map(pickUrl).find(Boolean) || pickUrl(payload?.videoUrl || payload?.data?.videoUrl);
      const nativeLastFrameUrl = String(
        payload?.lastFrameUrl || payload?.last_frame_url || payload?.last_frame || payload?.data?.lastFrameUrl || payload?.data?.last_frame_url || payload?.data?.last_frame ||
        candidates.map((item) => item?.lastFrameUrl || item?.last_frame || item?.lastFrame).find(Boolean) || "",
      ).trim();
      const status = videoUrl
        ? "completed"
        : normalizeStatus(payload?.status || payload?.data?.status || payload?.taskStatus);
      if (status === "completed" && !videoUrl) return { status: "failed", error: "RunningHub 完成但没有返回视频地址", payload };
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
};
