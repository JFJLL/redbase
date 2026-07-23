import { IMAGE_JOB_MAX_WAIT_MS, IMAGE_JOB_POLL_INTERVAL_MS } from "./config.js";

let onUnauthorized = () => {};
let getRequestContext = () => null;
let isRequestContextCurrent = () => true;

export function configureApiClient(options = {}) {
  onUnauthorized = typeof options.onUnauthorized === "function" ? options.onUnauthorized : () => {};
  getRequestContext = typeof options.getRequestContext === "function" ? options.getRequestContext : () => null;
  isRequestContextCurrent =
    typeof options.isRequestContextCurrent === "function" ? options.isRequestContextCurrent : () => true;
}

export async function request(url, options = {}) {
  return requestWithContext(url, options, getRequestContext());
}

async function requestWithContext(url, options, requestContext) {
  assertCurrentRequestContext(requestContext);
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
  assertCurrentRequestContext(requestContext);
  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized();
      assertCurrentRequestContext(requestContext);
    }
    const error = new Error(payload.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function assertCurrentRequestContext(requestContext) {
  if (isRequestContextCurrent(requestContext)) return;
  const error = new Error("请求已因登录状态变化而取消");
  error.code = "STALE_SESSION_REQUEST";
  throw error;
}

export function isStaleSessionRequest(error) {
  return error?.code === "STALE_SESSION_REQUEST";
}

export async function pollImageJob(jobId, maxWaitMs = IMAGE_JOB_MAX_WAIT_MS, delayMs = IMAGE_JOB_POLL_INTERVAL_MS) {
  const startedAt = Date.now();
  const requestContext = getRequestContext();
  while (Date.now() - startedAt < maxWaitMs) {
    const result = await requestWithContext(`/api/image-jobs/${jobId}`, {}, requestContext);
    if (result.status === "completed") {
      return {
        ...(result.imageConcept || {}),
        generationId: result.generationId || null,
        persisted: Boolean(result.persisted || result.generationId),
        jobId: result.jobId || jobId,
      };
    }
    if (result.status === "failed") {
      throw new Error(result.error || "图片生成失败");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`图片生成时间超过 ${Math.round(maxWaitMs / 60000)} 分钟，请稍后再试。`);
}
