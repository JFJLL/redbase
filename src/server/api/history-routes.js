const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { listBrandsByOwner } = require("../db/repositories/brand-repository");
const {
  listGenerationsByOwner,
  searchGenerations,
  findGenerationByOwner,
  findGenerationById,
  deleteGenerationRows,
} = require("../db/repositories/generation-repository");

const GENERATION_HISTORY_TYPES = new Set(["moments", "wechat", "xhsCarousel", "styleImage", "imageEdit"]);

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
    const editHistory = Array.isArray(generation?.payload?.editHistory) ? generation.payload.editHistory : [];
    const edit = editHistory.find((item) => item.id === generatedEditFileMatch[2]);
    await serveStoredGeneratedImage(res, edit?.localImage);
    return true;
  }

  return false;
}

module.exports = {
  handleHistoryRoutes,
  buildHistoryFilters,
};
