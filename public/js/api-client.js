import { IMAGE_JOB_MAX_WAIT_MS, IMAGE_JOB_POLL_INTERVAL_MS } from "./config.js";

let onUnauthorized = () => {};

export function configureApiClient(options = {}) {
  onUnauthorized = typeof options.onUnauthorized === "function" ? options.onUnauthorized : () => {};
}

export async function request(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    headers,
    credentials: "same-origin",
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized();
    }
    const error = new Error(payload.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function pollImageJob(jobId, maxWaitMs = IMAGE_JOB_MAX_WAIT_MS, delayMs = IMAGE_JOB_POLL_INTERVAL_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const result = await request(`/api/image-jobs/${jobId}`);
    if (result.status === "completed") {
      return result.imageConcept;
    }
    if (result.status === "failed") {
      throw new Error(result.error || "图片生成失败");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`图片生成时间超过 ${Math.round(maxWaitMs / 60000)} 分钟，请稍后再试。`);
}

