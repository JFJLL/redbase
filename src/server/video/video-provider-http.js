function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) return () => {};
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return () => {};
  }
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

async function requestProviderJson(fetchImpl, url, options = {}) {
  const phase = options.phase === "submit" ? "submit" : "poll";
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 30000));
  const {
    phase: _phase,
    timeoutMs: _timeoutMs,
    signal: parentSignal,
    errorMessage,
    ...requestOptions
  } = options;
  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  let timedOut = false;
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(new Error(`Provider ${phase} 请求超时`), { code: "VIDEO_PROVIDER_TIMEOUT", phase }));
    }, timeoutMs);
  });

  let response;
  let payload;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, {
        ...requestOptions,
        signal: controller.signal,
      })),
      timeoutPromise,
    ]);
    payload = await Promise.race([
      Promise.resolve().then(() => response.json()).catch(() => ({})),
      timeoutPromise,
    ]);
  } catch (error) {
    const nextError = error instanceof Error ? error : new Error(String(error || "Provider request failed"));
    if (timedOut) {
      nextError.code = "VIDEO_PROVIDER_TIMEOUT";
      nextError.phase = phase;
      nextError.uncertainSubmission = phase === "submit";
    } else if (phase === "submit" && !parentSignal?.aborted) {
      nextError.uncertainSubmission = true;
      nextError.phase = phase;
    }
    throw nextError;
  } finally {
    clearTimeout(timeout);
    unlink();
  }

  if (!response.ok) {
    const error = new Error(errorMessage?.(payload, response.status) || `Provider 视频请求失败：HTTP ${response.status}`);
    error.statusCode = response.status;
    error.payload = payload;
    error.phase = phase;
    throw error;
  }
  return payload;
}

module.exports = {
  requestProviderJson,
};
