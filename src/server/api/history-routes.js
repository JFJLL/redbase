const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { listBrandsByOwner } = require("../db/repositories/brand-repository");
const {
  listGenerationsByOwner,
  searchGenerations,
  listExpiredGenerations,
  findGenerationByOwner,
  findGenerationById,
  deleteGenerationRows,
} = require("../db/repositories/generation-repository");

const GENERATION_HISTORY_TYPES = new Set(["moments", "wechat", "xhsCarousel", "styleImage", "imageEdit"]);
const HISTORY_GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

function isGenerationExpired(generation, nowMs = Date.now(), retentionMs = HISTORY_GENERATION_RETENTION_MS) {
  const createdAtMs = Date.parse(generation?.createdAt || "");
  if (!Number.isFinite(createdAtMs)) return false;
  return createdAtMs + retentionMs <= nowMs;
}

async function removeGenerationWithLocalFiles(generation, removeGenerationLocalFiles) {
  if (!generation?.id) return;
  if (typeof removeGenerationLocalFiles === "function") {
    await removeGenerationLocalFiles(generation);
  }
  deleteGenerationRows(generation.id);
}

async function expireGenerationIfNeeded(generation, options = {}) {
  if (!generation || !isGenerationExpired(generation, options.nowMs, options.retentionMs)) return false;
  await removeGenerationWithLocalFiles(generation, options.removeGenerationLocalFiles);
  return true;
}

async function cleanupExpiredGenerationHistory(options = {}) {
  const retentionMs = Number(options.retentionMs || HISTORY_GENERATION_RETENTION_MS);
  const cutoffIso = getHistoryCutoffIso(options.nowMs, retentionMs);
  const expiredGenerations = listExpiredGenerations(cutoffIso);
  for (const generation of expiredGenerations) {
    await removeGenerationWithLocalFiles(generation, options.removeGenerationLocalFiles);
  }
  return {
    cutoffIso,
    deletedCount: expiredGenerations.length,
    deletedGenerationIds: expiredGenerations.map((generation) => generation.id),
  };
}

async function handleHistoryRoutes(context, req, res, pathname) {
  const {
    appConfig,
    sanitizeBrand,
    sanitizeGeneration,
    removeGenerationLocalFiles,
    serveStoredGeneratedImage,
    verifySignedAssetRequest,
    getSessionToken,
    buildApiUserLog,
    isRenderableGeneration,
    json,
    notFound,
    unauthorized,
  } = bindRouteScope(context);

  if (req.method === "GET" && pathname === "/api/brands") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    json(res, 200, {
      brands: listBrandsByOwner(user.id).map((brand) => sanitizeBrand(brand, appConfig)),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    await cleanupExpiredGenerationHistory({
      nowMs: getHistoryNowMs(context),
      removeGenerationLocalFiles,
    });
    const filters = buildHistoryFilters(req);
    const generations = Object.keys(filters).length
      ? searchGenerations(user.id, filters)
      : listGenerationsByOwner(user.id);
    json(res, 200, {
      generations: generations
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
      notFound(res);
      return true;
    }

    await removeGenerationLocalFiles(generation);
    deleteGenerationRows(generation.id);
    json(res, 200, {
      ok: true,
      deletedGenerationId: generation.id,
    });
    return true;
  }

  const generatedImageFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/file$/);
  if (req.method === "GET" && generatedImageFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedImageFileMatch[1]));
    if (await expireGenerationIfNeeded(generation, { nowMs: getHistoryNowMs(context), removeGenerationLocalFiles })) {
      notFound(res);
      return true;
    }
    const asset = generation?.payload?.localImage;
    await serveStoredGeneratedImage(res, asset);
    return true;
  }

  const generatedSlideFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/slides\/(\d+)\/file$/);
  if (req.method === "GET" && generatedSlideFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedSlideFileMatch[1]));
    if (await expireGenerationIfNeeded(generation, { nowMs: getHistoryNowMs(context), removeGenerationLocalFiles })) {
      notFound(res);
      return true;
    }
    const slides = Array.isArray(generation?.payload?.slides) ? generation.payload.slides : [];
    const slide = slides[Number(generatedSlideFileMatch[2])];
    await serveStoredGeneratedImage(res, slide?.localImage);
    return true;
  }

  const generatedEditFileMatch = pathname.match(/^\/api\/generated-images\/(\d+)\/edits\/([a-f0-9]+)\/file$/);
  if (req.method === "GET" && generatedEditFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const generation = findGenerationById(Number(generatedEditFileMatch[1]));
    if (await expireGenerationIfNeeded(generation, { nowMs: getHistoryNowMs(context), removeGenerationLocalFiles })) {
      notFound(res);
      return true;
    }
    const editHistory = Array.isArray(generation?.payload?.editHistory) ? generation.payload.editHistory : [];
    const edit = editHistory.find((item) => item.id === generatedEditFileMatch[2]);
    await serveStoredGeneratedImage(res, edit?.localImage);
    return true;
  }

  return false;
}

module.exports = {
  HISTORY_GENERATION_RETENTION_MS,
  cleanupExpiredGenerationHistory,
  expireGenerationIfNeeded,
  handleHistoryRoutes,
  buildHistoryFilters,
};
