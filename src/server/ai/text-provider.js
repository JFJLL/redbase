const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const { joinUrl, assertConfigured, parseJsonFromModelText, withRetries } = require("../utils");
const { recordTextTaskAttempt } = require("../analytics/ai-attempt-recorder");

const DEFAULT_MAX_TEXT_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
let runningHubAddressCursor = 0;

function isRunningHubHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "runninghub.ai" || normalized.endsWith(".runninghub.ai");
}

function createPinnedTextProviderLookup(address, family = net.isIP(address)) {
  return (_hostname, options, callback) => {
    const lookupOptions = typeof options === "object" && options ? options : {};
    const done = typeof options === "function" ? options : callback;
    if (lookupOptions.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };
}

function isUnsafeTextProviderAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (!normalized) return true;
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
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
    // An embedded public IPv4 address does not make the surrounding IPv6
    // transition/documentation prefix globally routable. Check the complete
    // IPv6 address first and use the embedded address only as an extra reject.
    if (embeddedIpv4 && isUnsafeTextProviderAddress(embeddedIpv4)) return true;
    const hextets = normalized.split(":");
    const firstHextet = Number.parseInt(hextets[0] || "0", 16);
    const secondHextet = Number.parseInt(hextets[1] || "0", 16);
    return (
      // Public model endpoints have no reason to resolve to transition, local,
      // documentation, or protocol-assignment space. Restricting IPv6 to the
      // routable 2000::/3 block also rejects IPv4-mapped and local NAT64 forms.
      (firstHextet & 0xe000) !== 0x2000 ||
      // IETF protocol assignments (Teredo, benchmarking, ORCHID, etc.).
      (firstHextet === 0x2001 && secondHextet <= 0x01ff) ||
      // Documentation address space.
      (firstHextet === 0x2001 && secondHextet === 0x0db8) ||
      // Deprecated 6to4 transition space.
      firstHextet === 0x2002 ||
      // Deprecated 6bone and the newer documentation prefix.
      firstHextet === 0x3ffe ||
      (firstHextet === 0x3fff && secondHextet <= 0x0fff)
    );
  }
  return true;
}

function createRunningHubDnsError(message, cause) {
  const error = new Error(message);
  error.code = "TEXT_PROVIDER_DNS_ERROR";
  if (cause) error.cause = cause;
  return error;
}

async function resolveRunningHubAddresses(target, lookupImpl = dns.promises.lookup, options = {}) {
  if (!isRunningHubHostname(target?.hostname)) return [];
  const timeoutMs = Math.max(1, Math.min(10000, Number(options.timeoutMs || 5000)));
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(createRunningHubDnsError("RunningHub DNS lookup timed out.")),
        timeoutMs,
      );
    });
    const resolved = await Promise.race([
      Promise.resolve().then(() => lookupImpl(target.hostname, { all: true, verbatim: true })),
      timeout,
    ]);
    const rawAddresses = Array.isArray(resolved) ? resolved : [resolved];
    if (!rawAddresses.length || rawAddresses.some((item) => isUnsafeTextProviderAddress(item?.address || item))) {
      throw createRunningHubDnsError("RunningHub DNS did not return exclusively public addresses.");
    }
    const addresses = [...new Map(rawAddresses
      .filter((item) => net.isIP(item?.address || item))
      .map((item) => {
        const address = String(item?.address || item);
        return [address, { address, family: Number(item?.family || net.isIP(address)) }];
      })).values()];
    if (!addresses.length) throw createRunningHubDnsError("RunningHub DNS returned no usable public address.");
    return addresses;
  } catch (error) {
    if (error?.code === "TEXT_PROVIDER_DNS_ERROR") throw error;
    throw createRunningHubDnsError("RunningHub DNS lookup failed.", error);
  } finally {
    clearTimeout(timer);
  }
}

function getTextProviderResponseLimit(options = {}) {
  const configured = Number(options.maxResponseBytes || DEFAULT_MAX_TEXT_PROVIDER_RESPONSE_BYTES);
  return Math.max(1, Math.min(
    DEFAULT_MAX_TEXT_PROVIDER_RESPONSE_BYTES,
    Number.isFinite(configured) ? configured : DEFAULT_MAX_TEXT_PROVIDER_RESPONSE_BYTES,
  ));
}

function createTextProviderResponseTooLargeError(url) {
  const error = new Error("Text provider response exceeded the size limit.");
  error.code = "TEXT_PROVIDER_RESPONSE_TOO_LARGE";
  error.retryable = false;
  error.url = url;
  return error;
}

async function readFetchResponseText(response, url, maxResponseBytes) {
  const declaredLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response?.body?.cancel?.().catch?.(() => {});
    throw createTextProviderResponseTooLargeError(url);
  }
  if (!response?.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxResponseBytes) throw createTextProviderResponseTooLargeError(url);
    return raw;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw createTextProviderResponseTooLargeError(url);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildTextProviderRequestOptions(target, options = {}) {
  const hostname = String(target?.hostname || "").toLowerCase();
  const isRunningHub = isRunningHubHostname(hostname);
  return {
    method: options.method || "GET",
    headers: options.headers || {},
    ...(typeof options.lookup === "function" ? { lookup: options.lookup } : {}),
    ...(target.protocol === "https:" && isRunningHub ? { maxVersion: "TLSv1.2" } : {}),
  };
}

function createRequestTimeoutError(url) {
  const error = new Error(`Request timeout: ${url}`);
  error.code = "ETIMEDOUT";
  return error;
}

function redactProviderSensitiveText(value) {
  return String(value || "")
    .replace(/\b(?:as_sk_|sk-)[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;"'}]+/gi, "$1=[redacted]")
    .replace(/\b(bearer)(?:\s+|\s*[:=]\s*)[^\s,;"'}]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|x-api-key|x-goog-api-key|token)\s*[:=]\s*[^\s,;"'}]+/gi, "$1=[redacted]");
}

function redactProviderPayload(value) {
  if (value == null) return value;
  try {
    return JSON.parse(redactProviderSensitiveText(JSON.stringify(value)));
  } catch (_error) {
    return null;
  }
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let deadlineTimer = null;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const timeoutMs = Number(options.timeoutMs || 180000);
    const maxResponseBytes = getTextProviderResponseLimit(options);
    const startedAt = Date.now();
    const request = transport.request(
      target,
      buildTextProviderRequestOptions(target, options),
      (response) => {
        responseStarted = true;
        options.onTelemetry?.({ type: "first-byte", elapsedMs: Date.now() - startedAt, statusCode: response.statusCode });
        let raw = "";
        let totalBytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (settled) return;
          totalBytes += Buffer.byteLength(chunk);
          if (totalBytes > maxResponseBytes) {
            const error = createTextProviderResponseTooLargeError(url);
            rejectOnce(error);
            response.destroy(error);
            request.destroy();
            return;
          }
          raw += chunk;
        });
        response.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            data = null;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = redactProviderSensitiveText(data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.statusCode}`);
            const httpError = new Error(message);
            httpError.statusCode = response.statusCode;
            httpError.url = url;
            httpError.rawBody = redactProviderSensitiveText(raw);
            httpError.payload = redactProviderPayload(data);
            httpError.retryable = false;
            rejectOnce(httpError);
            return;
          }

          if (data?.usage) options.onTelemetry?.({ type: "usage", usage: data.usage });
          options.onTelemetry?.({ type: "complete", elapsedMs: Date.now() - startedAt, statusCode: response.statusCode });
          resolveOnce(data);
        });
        response.on("aborted", () => {
          const error = new Error("HTTP response was aborted.");
          error.retryable = false;
          rejectOnce(error);
        });
        response.on("error", (error) => {
          error.retryable = false;
          rejectOnce(error);
        });
      },
    );

    const abortForTimeout = () => {
      const error = createRequestTimeoutError(url);
      if (responseStarted) error.retryable = false;
      rejectOnce(error);
      request.destroy();
    };
    deadlineTimer = setTimeout(abortForTimeout, timeoutMs);
    request.setTimeout(timeoutMs, abortForTimeout);

    request.on("error", rejectOnce);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function isMaxTokensFinishReason(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  return new Set(["MAXTOKENS", "MAXOUTPUTTOKENS", "MAXOUTPUT", "LENGTH"]).has(normalized);
}

function createTextModelOutputTruncatedError(finishReason) {
  const error = new Error(`Text model output was truncated before completion (${String(finishReason || "MAX_TOKENS")}).`);
  error.code = "TEXT_MODEL_MAX_TOKENS";
  error.finishReason = String(finishReason || "MAX_TOKENS");
  // Retry at the logical generation layer; partial JSON must never be treated
  // as a successful model result.
  error.retryable = true;
  error.partial = true;
  return error;
}

function assertModelOutputNotTruncated(finishReason, onTelemetry) {
  if (!finishReason) return;
  onTelemetry?.({ type: "finish-reason", finishReason: String(finishReason) });
  if (isMaxTokensFinishReason(finishReason)) {
    throw createTextModelOutputTruncatedError(finishReason);
  }
}

function extractTextFromOpenAIStream(raw, onTelemetry) {
  const parts = [];
  let completed = false;
  let finishReason = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      completed = true;
      continue;
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch (_error) {
      continue;
    }
    if (data?.error) {
      throw new Error(data.error.message || data.error || "OpenAI-compatible stream failed");
    }
    if (data?.usage && typeof onTelemetry === "function") {
      onTelemetry({ type: "usage", usage: data.usage });
    }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    const content = choice?.delta?.content;
    if (typeof content === "string") parts.push(content);
  }
  if (!completed) throw new Error("OpenAI-compatible stream ended before [DONE].");
  assertModelOutputNotTruncated(finishReason, onTelemetry);
  return parts.join("");
}

function fetchOpenAIText(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    let receivedFirstByte = false;
    let responseStarted = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const startedAt = Date.now();
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const timeoutMs = Number(options.timeoutMs || 180000);
    const maxResponseBytes = getTextProviderResponseLimit(options);
    const request = transport.request(
      target,
      buildTextProviderRequestOptions(target, { ...options, method: options.method || "POST" }),
      (response) => {
        responseStarted = true;
        let raw = "";
        let totalBytes = 0;
        response.setEncoding("utf8");
        const rejectInterruptedResponse = (sourceError) => {
          const error = sourceError instanceof Error ? sourceError : new Error("OpenAI-compatible response was interrupted.");
          if (!error.code) {
            error.code = "EOPENAI_RESPONSE_INTERRUPTED";
          }
          error.retryable = false;
          error.statusCode = response.statusCode;
          error.url = url;
          rejectOnce(error);
        };
        response.on("aborted", () => rejectInterruptedResponse(new Error("OpenAI-compatible response was aborted.")));
        response.on("error", rejectInterruptedResponse);
        response.on("data", (chunk) => {
          if (settled) return;
          if (!receivedFirstByte) {
            receivedFirstByte = true;
            options.onTelemetry?.({ type: "first-byte", elapsedMs: Date.now() - startedAt, statusCode: response.statusCode });
          }
          totalBytes += Buffer.byteLength(chunk);
          if (totalBytes > maxResponseBytes) {
            const error = createTextProviderResponseTooLargeError(url);
            rejectOnce(error);
            response.destroy(error);
            request.destroy();
            return;
          }
          raw += chunk;
        });
        response.on("end", () => {
          if (settled) return;
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (_error) {
            data = null;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = redactProviderSensitiveText(data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.statusCode}`);
            const httpError = new Error(message);
            httpError.statusCode = response.statusCode;
            httpError.url = url;
            httpError.rawBody = redactProviderSensitiveText(raw);
            httpError.payload = redactProviderPayload(data);
            httpError.retryable = false;
            rejectOnce(httpError);
            return;
          }
          try {
            const contentType = String(response.headers["content-type"] || "").toLowerCase();
            resolveOnce(
              contentType.includes("text/event-stream") || /^\s*data:/m.test(raw)
                ? extractTextFromOpenAIStream(raw, options.onTelemetry)
                : extractTextFromOpenAIResponse(data),
            );
            if (data?.usage) options.onTelemetry?.({ type: "usage", usage: data.usage });
            options.onTelemetry?.({ type: "complete", elapsedMs: Date.now() - startedAt, statusCode: response.statusCode });
          } catch (error) {
            if (error.retryable == null) error.retryable = false;
            rejectOnce(error);
          }
        });
      },
    );
    const abortForTimeout = () => {
      const error = createRequestTimeoutError(url);
      if (responseStarted) {
        error.code = "EOPENAI_RESPONSE_TIMEOUT";
        error.retryable = false;
      }
      rejectOnce(error);
      request.destroy();
    };
    deadlineTimer = setTimeout(abortForTimeout, timeoutMs);
    request.setTimeout(timeoutMs, abortForTimeout);
    request.on("error", rejectOnce);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function fetchJsonNative(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 180000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || undefined,
      signal: controller.signal,
    });
    const raw = await readFetchResponseText(response, url, getTextProviderResponseLimit(options));
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const message = redactProviderSensitiveText(data?.error?.message || data?.error || data?.message || raw || `HTTP ${response.status}`);
      const httpError = new Error(message);
      httpError.statusCode = response.status;
      httpError.url = url;
      httpError.rawBody = redactProviderSensitiveText(raw);
      httpError.payload = redactProviderPayload(data);
      httpError.retryable = false;
      throw httpError;
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTextFromOpenAIResponse(payload) {
  const choice = payload?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (!Array.isArray(choice)) return "";
  return choice
    .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
    .join("\n");
}

function extractTextFromAnthropicResponse(payload) {
  const content = payload?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item?.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function extractTextFromGoogleResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((item) => item?.text || "").filter(Boolean).join("\n");
}

function buildRetryOptions(options) {
  const configuredMaxAttempts = options.maxAttempts ?? options.retries;
  return {
    retries: Number.isFinite(Number(configuredMaxAttempts)) ? Math.max(1, Number(configuredMaxAttempts)) : 3,
    delayMs: Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 1200,
  };
}

async function callTextModelJson(appConfig, {
  systemPrompt,
  userPrompt,
  useSearch = false,
  temperature = 0.7,
  timeoutMs,
  retries,
  maxAttempts,
  delayMs,
  maxOutputTokens,
  maxResponseBytes,
  stream = false,
  onTelemetry,
  budget = null,
  analyticsContext = {},
}) {
  const provider = appConfig.textProvider;
  assertConfigured(provider.apiKey, "文本模型 API Key");
  const modelTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7;
  const outputTokenLimit = Number.isFinite(Number(maxOutputTokens))
    ? Number(maxOutputTokens)
    : Number.isFinite(Number(provider.maxOutputTokens))
      ? Number(provider.maxOutputTokens)
      : null;
  const totalTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : null;
  const requestDeadlineAt = totalTimeoutMs ? Date.now() + totalTimeoutMs : null;
  const getAttemptRequestOptions = () => {
    const remainingMs = requestDeadlineAt ? requestDeadlineAt - Date.now() : null;
    if (remainingMs != null && remainingMs <= 0) {
      const error = new Error("Text provider request deadline exceeded.");
      error.code = "ETIMEDOUT";
      error.retryable = false;
      throw error;
    }
    return {
      timeoutMs: remainingMs == null ? undefined : Math.max(1, remainingMs),
      maxResponseBytes: Number.isFinite(Number(maxResponseBytes)) ? Number(maxResponseBytes) : undefined,
    };
  };
  // Cap transport attempts by remaining AI call budget so retries cannot exceed the shared limit.
  const budgetRemaining = budget && typeof budget.remaining === "function"
    ? budget.remaining()
    : null;
  if (budget && budgetRemaining != null && budgetRemaining <= 0) {
    if (typeof budget.consume === "function") {
      // consume() throws the canonical non-retryable budget error.
      budget.consume();
    }
    const error = new Error("AI call budget exceeded");
    error.code = "TREND_AI_CALL_BUDGET_EXCEEDED";
    error.retryable = false;
    error.partial = true;
    error.reason = "AI call budget exceeded";
    throw error;
  }
  const configuredAttempts = Number.isFinite(Number(maxAttempts))
    ? Number(maxAttempts)
    : (Number.isFinite(Number(retries)) ? Number(retries) : 3);
  const retryOptions = buildRetryOptions({
    retries,
    maxAttempts: budgetRemaining == null
      ? maxAttempts
      : Math.min(configuredAttempts, Math.max(1, budgetRemaining)),
    delayMs,
  });
  const runWithRetries = (task) => withRetries(async (attempt) => {
    // Every physical model HTTP attempt must consume one unit of the shared budget.
    if (budget && typeof budget.consume === "function") {
      budget.consume();
    }
    const attemptStartedAt = Date.now();
    let attemptUsage = null;
    let attemptFirstByteMs = null;
    const interceptTelemetry = (event) => {
      if (event?.type === "first-byte") attemptFirstByteMs = event.elapsedMs;
      if (event?.type === "usage") attemptUsage = event.usage;
      onTelemetry?.(event);
    };
    onTelemetry?.({ type: "attempt", attempt });
    try {
      const result = await task(attempt, interceptTelemetry);
      try {
        recordTextTaskAttempt({
          feature: analyticsContext.feature || "other",
          taskType: analyticsContext.taskType || "text_generation",
          entityType: analyticsContext.entityType || "",
          entityId: analyticsContext.entityId || "",
          provider: provider.provider || provider.apiStyle || "text_provider",
          model: provider.model || "",
          attemptKind: attempt === 1 ? "initial" : "auto_retry",
          attemptNo: attempt,
          status: "completed",
          startedAt: new Date(attemptStartedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - attemptStartedAt,
          firstByteMs: attemptFirstByteMs,
          inputTokens: attemptUsage?.prompt_tokens ?? attemptUsage?.input_tokens ?? null,
          outputTokens: attemptUsage?.completion_tokens ?? attemptUsage?.output_tokens ?? null,
          totalTokens: attemptUsage?.total_tokens ?? null,
          actorUserId: analyticsContext.actorUserId ?? null,
          accountType: analyticsContext.accountType || "",
        });
      } catch (_) {}
      return result;
    } catch (err) {
      try {
        const isTimeout = err.code === "ETIMEDOUT" || String(err.message || "").includes("timeout");
        recordTextTaskAttempt({
          feature: analyticsContext.feature || "other",
          taskType: analyticsContext.taskType || "text_generation",
          entityType: analyticsContext.entityType || "",
          entityId: analyticsContext.entityId || "",
          provider: provider.provider || provider.apiStyle || "text_provider",
          model: provider.model || "",
          attemptKind: attempt === 1 ? "initial" : "auto_retry",
          attemptNo: attempt,
          status: "failed",
          errorStage: isTimeout ? "provider" : "submission",
          errorCode: String(err.code || "MODEL_ERROR"),
          errorMessage: String(err.message || "").slice(0, 500),
          startedAt: new Date(attemptStartedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - attemptStartedAt,
          firstByteMs: attemptFirstByteMs,
          inputTokens: attemptUsage?.prompt_tokens ?? attemptUsage?.input_tokens ?? null,
          outputTokens: attemptUsage?.completion_tokens ?? attemptUsage?.output_tokens ?? null,
          totalTokens: attemptUsage?.total_tokens ?? null,
          actorUserId: analyticsContext.actorUserId ?? null,
          accountType: analyticsContext.accountType || "",
        });
      } catch (_) {}
      throw err;
    }
  }, retryOptions);

  if (provider.apiStyle === "google") {
    const data = await runWithRetries(
      () =>
        fetchJsonNative(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            ...(useSearch && provider.searchEnabled ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: {
              temperature: modelTemperature,
              ...(outputTokenLimit ? { maxOutputTokens: outputTokenLimit } : {}),
            },
          }),
          ...getAttemptRequestOptions(),
        }),
    );
    assertModelOutputNotTruncated(data?.candidates?.[0]?.finishReason, onTelemetry);
    return parseJsonFromModelText(extractTextFromGoogleResponse(data));
  }

  if (provider.apiStyle === "anthropic") {
    const data = await runWithRetries(
      () =>
        fetchJson(joinUrl(provider.anthropicBaseUrl, "/messages"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: provider.model,
            system: systemPrompt,
            max_tokens: outputTokenLimit || 4096,
            temperature: modelTemperature,
            messages: [{ role: "user", content: userPrompt }],
          }),
          ...getAttemptRequestOptions(),
        }),
    );
    assertModelOutputNotTruncated(data?.stop_reason, onTelemetry);
    return parseJsonFromModelText(extractTextFromAnthropicResponse(data));
  }

  const requestBody = JSON.stringify({
    model: provider.model,
    temperature: modelTemperature,
    response_format: { type: "json_object" },
    ...(outputTokenLimit ? { max_tokens: outputTokenLimit } : {}),
    ...(stream ? { stream: true } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const openAIUrl = joinUrl(provider.openaiBaseUrl, "/chat/completions");
  const openAITarget = new URL(openAIUrl);
  const dnsTimeoutMs = requestDeadlineAt
    ? Math.max(1, Math.min(5000, requestDeadlineAt - Date.now()))
    : 5000;
  const runningHubAddresses = await resolveRunningHubAddresses(
    openAITarget,
    dns.promises.lookup,
    { timeoutMs: dnsTimeoutMs },
  );
  const addressStartIndex = runningHubAddresses.length
    ? runningHubAddressCursor++ % runningHubAddresses.length
    : 0;
  const getAttemptNetworkOptions = (attempt) => {
    if (!runningHubAddresses.length) return {};
    const selected = runningHubAddresses[(addressStartIndex + Math.max(0, Number(attempt || 1) - 1)) % runningHubAddresses.length];
    onTelemetry?.({ type: "route", attempt, address: selected.address, family: selected.family });
    return { lookup: createPinnedTextProviderLookup(selected.address, selected.family) };
  };
  if (stream) {
    const text = await runWithRetries(
      (attempt, telemetry) =>
        fetchOpenAIText(openAIUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: requestBody,
          onTelemetry: telemetry || onTelemetry,
          ...getAttemptNetworkOptions(attempt),
          ...getAttemptRequestOptions(),
        }),
    );
    return parseJsonFromModelText(text);
  }

  const data = await runWithRetries(
    (attempt, telemetry) =>
      fetchJson(openAIUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: requestBody,
        onTelemetry: telemetry || onTelemetry,
        ...getAttemptNetworkOptions(attempt),
        ...getAttemptRequestOptions(),
      }),
  );
  assertModelOutputNotTruncated(data?.choices?.[0]?.finish_reason, onTelemetry);
  return parseJsonFromModelText(extractTextFromOpenAIResponse(data));
}

/**
 * Multimodal JSON call: sends reference image URLs as OpenAI-style image_url
 * content parts alongside the text prompt. Only the OpenAI-compatible
 * chat/completions style supports this; other styles fail fast so callers can
 * degrade to metadata-only analysis without blocking their flow.
 */
const SUPPORTED_VISION_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;

function normalizeVisionInputs({ images = [], imageUrls = [] }) {
  const normalized = [];
  const rawList = [
    ...(Array.isArray(images) ? images : images ? [images] : []),
    ...(Array.isArray(imageUrls) ? imageUrls : imageUrls ? [imageUrls] : []).map((url) =>
      typeof url === "string" ? { url } : url,
    ),
  ];

  for (const item of rawList) {
    if (!item) continue;
    let mimeType = String(item.mimeType || "").toLowerCase();
    let dataBase64 = String(item.dataBase64 || item.data || "").trim();
    let url = String(item.url || "").trim();

    if (!dataBase64 && item.dataUrl) {
      const match = String(item.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1].toLowerCase();
        dataBase64 = match[2].trim();
      }
    } else if (!dataBase64 && url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1].toLowerCase();
        dataBase64 = match[2].trim();
      }
    }

    if (mimeType === "image/jpg") mimeType = "image/jpeg";

    if (dataBase64) {
      if (!mimeType) mimeType = "image/jpeg";
      if (!SUPPORTED_VISION_MIME_TYPES.has(mimeType)) {
        const error = new Error(`不支持的图片格式: ${mimeType}`);
        error.code = "VISION_UNSUPPORTED_MIME";
        error.retryable = false;
        throw error;
      }
      const byteLength = Buffer.from(dataBase64, "base64").length;
      if (byteLength > MAX_VISION_IMAGE_BYTES) {
        const error = new Error("图片大小超过 10MB 限制，请压缩后重试。");
        error.code = "VISION_IMAGE_TOO_LARGE";
        error.retryable = false;
        throw error;
      }
    } else if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    normalized.push({
      role: item.role || "product",
      roleDescription: item.roleDescription || item.label || "",
      mimeType: mimeType || "image/jpeg",
      dataBase64,
      url,
      name: item.name || "",
    });
  }
  return normalized;
}

/**
 * Multimodal JSON call: supports Google generateContent format (with inlineData base64)
 * and OpenAI-compatible chat/completions format (with image_url).
 */
async function callVisionModelJson(appConfig, {
  systemPrompt,
  userPrompt,
  images = [],
  imageUrls = [],
  temperature = 0.2,
  timeoutMs,
  retries,
  maxAttempts,
  delayMs,
  maxOutputTokens,
  maxResponseBytes,
  onTelemetry,
  budget = null,
  analyticsContext = {},
}) {
  const provider = appConfig?.textProvider || {};
  assertConfigured(provider.apiKey, "文本模型 API Key");

  if (provider.apiStyle === "anthropic") {
    const error = new Error("当前文本模型接入方式暂未配置图片输入。");
    error.code = "VISION_STYLE_UNSUPPORTED";
    error.retryable = false;
    throw error;
  }

  const normalizedImages = normalizeVisionInputs({ images, imageUrls });
  if (!normalizedImages.length) {
    const error = new Error("没有可用的参考图片。");
    error.code = "VISION_NO_IMAGES";
    error.retryable = false;
    throw error;
  }

  const modelTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;
  const outputTokenLimit = Number.isFinite(Number(maxOutputTokens))
    ? Number(maxOutputTokens)
    : Number.isFinite(Number(provider.maxOutputTokens))
      ? Number(provider.maxOutputTokens)
      : null;
  const totalTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : null;
  const requestDeadlineAt = totalTimeoutMs ? Date.now() + totalTimeoutMs : null;

  const getAttemptRequestOptions = () => {
    const remainingMs = requestDeadlineAt ? requestDeadlineAt - Date.now() : null;
    if (remainingMs != null && remainingMs <= 0) {
      const error = new Error("Vision provider request deadline exceeded.");
      error.code = "ETIMEDOUT";
      error.retryable = false;
      throw error;
    }
    return {
      timeoutMs: remainingMs == null ? undefined : Math.max(1, remainingMs),
      maxResponseBytes: Number.isFinite(Number(maxResponseBytes)) ? Number(maxResponseBytes) : undefined,
    };
  };

  const configuredAttempts = Number.isFinite(Number(maxAttempts))
    ? Number(maxAttempts)
    : (Number.isFinite(Number(retries)) ? Number(retries) : 3);
  const retryOptions = buildRetryOptions({
    retries,
    maxAttempts: configuredAttempts,
    delayMs,
  });

  const runWithRetries = (task) => withRetries(async (attempt) => {
    if (budget && typeof budget.consume === "function") {
      budget.consume();
    }
    const attemptStartedAt = Date.now();
    const startedAt = new Date(attemptStartedAt).toISOString();
    onTelemetry?.({ type: "attempt", attempt });
    try {
      const result = await task(attempt);
      try {
        recordTextTaskAttempt({
          feature: analyticsContext.feature || "other",
          taskType: analyticsContext.taskType || "vision_analysis",
          entityType: analyticsContext.entityType || "",
          entityId: analyticsContext.entityId || "",
          provider: provider.provider || provider.apiStyle || "vision_provider",
          model: provider.model || "",
          attemptKind: attempt === 1 ? "initial" : "auto_retry",
          attemptNo: attempt,
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - attemptStartedAt,
          actorUserId: analyticsContext.actorUserId ?? null,
          accountType: analyticsContext.accountType || "",
        });
      } catch (_) {}
      return result;
    } catch (error) {
      try {
        recordTextTaskAttempt({
          feature: analyticsContext.feature || "other",
          taskType: analyticsContext.taskType || "vision_analysis",
          entityType: analyticsContext.entityType || "",
          entityId: analyticsContext.entityId || "",
          provider: provider.provider || provider.apiStyle || "vision_provider",
          model: provider.model || "",
          attemptKind: attempt === 1 ? "initial" : "auto_retry",
          attemptNo: attempt,
          status: "failed",
          errorStage: "provider",
          errorCode: String(error?.code || "VISION_MODEL_ERROR"),
          errorMessage: error,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - attemptStartedAt,
          actorUserId: analyticsContext.actorUserId ?? null,
          accountType: analyticsContext.accountType || "",
        });
      } catch (_) {}
      throw error;
    }
  }, retryOptions);

  if (provider.apiStyle === "google") {
    const parts = [{ text: userPrompt }];
    for (const img of normalizedImages) {
      if (img.roleDescription) {
        parts.push({ text: img.roleDescription });
      }
      if (img.dataBase64) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.dataBase64,
          },
        });
      }
    }

    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: modelTemperature,
        responseMimeType: "application/json",
        ...(outputTokenLimit ? { maxOutputTokens: outputTokenLimit } : {}),
      },
    });

    const data = await runWithRetries(
      () =>
        fetchJsonNative(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
          body: requestBody,
          ...getAttemptRequestOptions(),
        }),
    );
    assertModelOutputNotTruncated(data?.candidates?.[0]?.finishReason, onTelemetry);
    return parseJsonFromModelText(extractTextFromGoogleResponse(data));
  }

  // OpenAI-compatible style
  const userContent = [{ type: "text", text: userPrompt }];
  for (const img of normalizedImages) {
    if (img.roleDescription) {
      userContent.push({ type: "text", text: img.roleDescription });
    }
    if (img.url && /^https?:\/\//i.test(img.url)) {
      userContent.push({ type: "image_url", image_url: { url: img.url } });
    } else if (img.dataBase64) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
      });
    }
  }

  const requestBody = JSON.stringify({
    model: provider.model,
    temperature: modelTemperature,
    response_format: { type: "json_object" },
    ...(outputTokenLimit ? { max_tokens: outputTokenLimit } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const openAIUrl = joinUrl(provider.openaiBaseUrl, "/chat/completions");
  const data = await runWithRetries(
    () =>
      fetchJson(openAIUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: requestBody,
        onTelemetry,
        ...getAttemptRequestOptions(),
      }),
  );
  assertModelOutputNotTruncated(data?.choices?.[0]?.finish_reason, onTelemetry);
  return parseJsonFromModelText(extractTextFromOpenAIResponse(data));
}

function buildTextProviderEndpoint(appConfig) {
  if (appConfig.textProvider.apiStyle === "anthropic") {
    return joinUrl(appConfig.textProvider.anthropicBaseUrl, "/messages");
  }
  if (appConfig.textProvider.apiStyle === "google") {
    return joinUrl(
      appConfig.textProvider.baseUrl,
      `/v1beta/models/${encodeURIComponent(appConfig.textProvider.model)}:generateContent`,
    );
  }
  return joinUrl(appConfig.textProvider.openaiBaseUrl, "/chat/completions");
}

module.exports = {
  DEFAULT_MAX_TEXT_PROVIDER_RESPONSE_BYTES,
  fetchJson,
  fetchJsonNative,
  fetchOpenAIText,
  extractTextFromOpenAIStream,
  extractTextFromOpenAIResponse,
  extractTextFromAnthropicResponse,
  extractTextFromGoogleResponse,
  callTextModelJson,
  callVisionModelJson,
  buildTextProviderEndpoint,
  buildTextProviderRequestOptions,
  createPinnedTextProviderLookup,
  resolveRunningHubAddresses,
};
