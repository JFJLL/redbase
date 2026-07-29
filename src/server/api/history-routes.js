const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { listBrandsByOwner, listBrandSummariesByOwner } = require("../db/repositories/brand-repository");
const {
  listGenerationsByOwner,
  searchGenerations,
  listExpiredGenerations,
  findGenerationByOwner,
  findGenerationById,
} = require("../db/repositories/generation-repository");
const { createGeneratedAssetStorage } = require("../assets/generated-asset-storage");
const { removeGenerationAssetsAndRows } = require("../assets/generation-deletion-service");

const GENERATION_HISTORY_TYPES = new Set(["moments", "wechat", "xhsCarousel", "styleImage", "imageEdit"]);
const HISTORY_GENERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function normalizeDateBoundary(value, mode) {
  const input = String(value || "").trim();
  if (!input) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return mode === "to" ? `${input}T23:59:59.999Z` : `${input}T00:00:00.000Z`;
  }
  return input;
}

function buildHistoryFilters(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const type = String(url.searchParams.get("type") || "").trim();
  const filters = {
    q: String(url.searchParams.get("q") || "").trim() || undefined,
    brandId: url.searchParams.get("brandId") || undefined,
    type: GENERATION_HISTORY_TYPES.has(type) ? type : undefined,
    from: normalizeDateBoundary(url.searchParams.get("from"), "from"),
    to: normalizeDateBoundary(url.searchParams.get("to"), "to"),
  };
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
}

function getHistoryNowMs(context) {
  const value = context?.historyRetentionNowMs;
  const timestamp = value instanceof Date ? value.getTime() : Number(value ?? Date.now());
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function getHistoryCutoffIso(nowMs = Date.now(), retentionMs = HISTORY_GENERATION_RETENTION_MS) {
  const timestamp = Number(nowMs);
  const safeNow = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(safeNow - retentionMs).toISOString();
}

function parseGenerationCreatedAtMs(value) {
  const input = String(value || "");
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "0", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fractionText.padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return Number.NaN;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) return Number.NaN;
  return Date.parse(input);
}

function isGenerationExpired(generation, nowMs = Date.now(), retentionMs = HISTORY_GENERATION_RETENTION_MS) {
  const createdAtMs = parseGenerationCreatedAtMs(generation?.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return createdAtMs + retentionMs <= nowMs;
}

function getGeneratedAssetStorage(context = {}) {
  return context.generatedAssetStorage || createGeneratedAssetStorage(context.appConfig || {});
}

async function expireGenerationIfNeeded(generation, options = {}) {
  if (!generation || !isGenerationExpired(generation, options.nowMs, options.retentionMs)) return false;
  await (options.removeGenerationAssetsAndRows || removeGenerationAssetsAndRows)(generation, {
    storage: options.storage,
    deletedAt: new Date(Number(options.nowMs ?? Date.now())).toISOString(),
    deleteReason: "history_retention_expired",
  });
  return true;
}

async function cleanupExpiredGenerationHistory(options = {}) {
  const configuredRetentionMs = Number(options.retentionMs);
  const retentionMs = Number.isFinite(configuredRetentionMs) && configuredRetentionMs > 0
    ? configuredRetentionMs
    : HISTORY_GENERATION_RETENTION_MS;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (typeof options.storage?.cleanupDeletionStaging === "function") {
    await options.storage.cleanupDeletionStaging({ isReferenced: options.isAssetReferenced, nowMs });
  }
  const cutoffIso = getHistoryCutoffIso(nowMs, retentionMs);
  const expiredGenerations = listExpiredGenerations(cutoffIso)
    .filter((generation) => isGenerationExpired(generation, nowMs, retentionMs));
  const deletedGenerationIds = [];
  const failedGenerationIds = [];
  for (const generation of expiredGenerations) {
    try {
      await (options.removeGenerationAssetsAndRows || removeGenerationAssetsAndRows)(generation, {
        storage: options.storage,
        deletedAt: new Date(nowMs).toISOString(),
        deleteReason: "history_retention_expired",
      });
      deletedGenerationIds.push(generation.id);
    } catch (error) {
      failedGenerationIds.push(generation.id);
      const logger = options.logger || console;
      logger.warn("[history-expiry] failed to remove expired generation", {
        generationId: generation.id,
        errorCode: String(error?.code || "ASSET_DELETE_FAILED"),
        status: Number(error?.status || error?.statusCode || 0) || undefined,
      });
    }
  }
  if (typeof options.cleanupEmptyGeneratedImageDirs === "function") {
    await options.cleanupEmptyGeneratedImageDirs();
  }
  return {
    cutoffIso,
    deletedCount: deletedGenerationIds.length,
    deletedGenerationIds,
    failedGenerationIds,
  };
}

function createGenerationHistoryCleanupRunner(baseOptions = {}) {
  let running = null;
  return function runGenerationHistoryCleanup(options = {}) {
    if (running) return running;
    const cleanupPromise = Promise.resolve(cleanupExpiredGenerationHistory({ ...baseOptions, ...options }));
    const trackedPromise = cleanupPromise.finally(() => {
      if (running === trackedPromise) running = null;
    });
    running = trackedPromise;
    return trackedPromise;
  };
}

function startGenerationHistoryCleanupScheduler(options = {}) {
  const runCleanup = options.runCleanup || createGenerationHistoryCleanupRunner(options.cleanupOptions);
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const logger = options.logger || console;
  const timer = setIntervalFn(() => {
    Promise.resolve(runCleanup({ nowMs: typeof options.nowMs === "function" ? options.nowMs() : Date.now() }))
      .catch((error) => logger.warn("[history-expiry] scheduled cleanup failed", {
        errorCode: String(error?.code || "HISTORY_CLEANUP_FAILED"),
      }));
  }, Number(options.intervalMs || HISTORY_CLEANUP_INTERVAL_MS));
  if (typeof timer?.unref === "function") timer.unref();
  return {
    timer,
    stop() {
      clearIntervalFn(timer);
    },
  };
}

async function handleHistoryRoutes(context, req, res, pathname) {
  const {
    appConfig,
    sanitizeBrand,
    sanitizeBrandSummary,
    sanitizeGeneration,
    cleanupEmptyGeneratedImageDirs,
    serveStoredGeneratedImage,
    verifySignedAssetRequest,
    getSessionToken,
    buildApiUserLog,
    isRenderableGeneration,
    json,
    notFound,
    unauthorized,
  } = bindRouteScope(context);
  const storage = getGeneratedAssetStorage(context);
  const runHistoryCleanup = context.historyCleanupRunner || ((options) => cleanupExpiredGenerationHistory(options));

  async function expireGenerationForRead(generation) {
    if (!isGenerationExpired(generation, getHistoryNowMs(context), HISTORY_GENERATION_RETENTION_MS)) return false;
    try {
      await expireGenerationIfNeeded(generation, {
        nowMs: getHistoryNowMs(context),
        storage,
        removeGenerationAssetsAndRows: context.removeGenerationAssetsAndRows,
      });
    } catch (error) {
      console.warn("[history-expiry] failed while reading expired generation", {
        generationId: generation?.id,
        errorCode: String(error?.code || "ASSET_DELETE_FAILED"),
        status: Number(error?.status || error?.statusCode || 0) || undefined,
      });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/brands") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const summaryOnly = ["1", "true"].includes(String(url.searchParams.get("summary") || "").toLowerCase());
    json(res, 200, {
      brands: summaryOnly
        ? listBrandSummariesByOwner(user.id).map((brand) => sanitizeBrandSummary(brand, appConfig))
        : listBrandsByOwner(user.id).map((brand) => sanitizeBrand(brand, appConfig)),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    await runHistoryCleanup({
      nowMs: getHistoryNowMs(context),
      storage,
      removeGenerationAssetsAndRows: context.removeGenerationAssetsAndRows,
      cleanupEmptyGeneratedImageDirs,
    });
    const filters = buildHistoryFilters(req);
    const generations = Object.keys(filters).length
      ? searchGenerations(user.id, filters)
      : listGenerationsByOwner(user.id);
    json(res, 200, {
      generations: generations
        .filter((generation) => !isGenerationExpired(generation, getHistoryNowMs(context), HISTORY_GENERATION_RETENTION_MS))
        .filter(isRenderableGeneration)
        .map((generation) => sanitizeGeneration(generation, appConfig)),
    });
    return true;
  }

  const historyGenerationMatch = pathname.match(/^\/api\/history\/(\d+)$/);
  if (req.method === "DELETE" && historyGenerationMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const generation = findGenerationByOwner(Number(historyGenerationMatch[1]), user.id);
    if (!generation) {
      json(res, 200, {
        ok: true,
        alreadyDeleted: true,
        deletedGenerationId: Number(historyGenerationMatch[1]),
      });
      return true;
    }

    try {
      const result = await (context.removeGenerationAssetsAndRows || removeGenerationAssetsAndRows)(generation, {
        storage,
        deletedAt: new Date(getHistoryNowMs(context)).toISOString(),
        deleteReason: "user_history_delete",
      });
      json(res, 200, result);
    } catch (error) {
      console.warn("[history-delete] failed to delete generation", {
        generationId: generation.id,
        errorCode: String(error?.code || "ASSET_DELETE_FAILED"),
        status: Number(error?.status || error?.statusCode || 0) || undefined,
      });
      json(res, 503, { error: "历史删除暂时失败，请稍后重试" });
    }
    return true;
  }

  const generatedImageFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/file$/);
  if (req.method === "GET" && generatedImageFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedImageFileMatch[1]));
    if (await expireGenerationForRead(generation)) {
      notFound(res);
      return true;
    }
    const asset = generation?.payload?.localImage;
    await serveStoredGeneratedImage(res, asset, generation);
    return true;
  }

  const generatedSlideFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/slides\/(\d+)\/file$/);
  if (req.method === "GET" && generatedSlideFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedSlideFileMatch[1]));
    if (await expireGenerationForRead(generation)) {
      notFound(res);
      return true;
    }
    const slides = Array.isArray(generation?.payload?.slides) ? generation.payload.slides : [];
    const slide = slides[Number(generatedSlideFileMatch[2])];
    await serveStoredGeneratedImage(res, slide?.localImage, generation);
    return true;
  }

  const generatedEditFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/edits\/([a-f0-9]+)\/file$/);
  if (req.method === "GET" && generatedEditFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedEditFileMatch[1]));
    if (await expireGenerationForRead(generation)) {
      notFound(res);
      return true;
    }
    const editHistory = Array.isArray(generation?.payload?.editHistory) ? generation.payload.editHistory : [];
    const edit = editHistory.find((item) => item.id === generatedEditFileMatch[2]);
    await serveStoredGeneratedImage(res, edit?.localImage, generation);
    return true;
  }

  return false;
}

module.exports = {
  HISTORY_GENERATION_RETENTION_MS,
  HISTORY_CLEANUP_INTERVAL_MS,
  cleanupExpiredGenerationHistory,
  createGenerationHistoryCleanupRunner,
  startGenerationHistoryCleanupScheduler,
  expireGenerationIfNeeded,
  isGenerationExpired,
  parseGenerationCreatedAtMs,
  handleHistoryRoutes,
  buildHistoryFilters,
};
