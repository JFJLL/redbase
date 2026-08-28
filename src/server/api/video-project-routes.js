const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const brandRepository = require("../db/repositories/brand-repository");
const { findProductImageByOwner } = require("../db/repositories/product-image-repository");
const { verifySignedAssetRequest } = require("../assets/signed-urls");
const { sanitizeUser } = require("../utils");

const findBrandByOwner = (...args) => brandRepository.findBrandByOwner(...args);

function requireRouteUser(req, res, helpers) {
  return requireSqlAuth(req, res, {
    getSessionToken: helpers.getSessionToken,
    buildApiUserLog: helpers.buildApiUserLog,
    unauthorized: helpers.unauthorized,
  });
}

function normalizeReferenceAssetIds(value, ownerUserId, max) {
  const ids = Array.isArray(value) ? value : [];
  return [...new Set(ids.map((item) => Number(typeof item === "object" ? item?.id : item)))].filter((id) => {
    return Number.isSafeInteger(id) && id > 0 && Boolean(findProductImageByOwner(id, ownerUserId));
  }).slice(0, max);
}

function respondVideoError(res, error, badRequest) {
  const notFoundCodes = new Set(["VIDEO_PROJECT_NOT_FOUND", "VIDEO_CLIP_NOT_FOUND"]);
  const conflictCodes = new Set([
    "VIDEO_IDEMPOTENCY_CONFLICT",
    "VIDEO_CLIP_RETRY_NOT_ALLOWED",
    "VIDEO_CLIP_RETRY_NOT_NEEDED",
    "VIDEO_CLIP_RETRY_RESULT_NOT_ALLOWED",
    "VIDEO_ASSEMBLY_RETRY_NOT_ALLOWED",
    "VIDEO_SCRIPT_GENERATION_REQUIRED",
    "VIDEO_SCRIPT_GENERATION_INVALID",
    "VIDEO_SCRIPT_INCOMPATIBLE",
    "VIDEO_SCRIPT_CONTEXT_MISMATCH",
  ]);
  const status = notFoundCodes.has(error?.code) ? 404 : conflictCodes.has(error?.code) ? 409 :
    ["VIDEO_ASSET_SIGNING_REQUIRED", "VIDEO_PUBLIC_BASE_URL_REQUIRED", "VIDEO_PROVIDER_NOT_CONFIGURED"].includes(error?.code) ? 503 : 400;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: error?.message || "视频项目请求失败", code: error?.code || "VIDEO_PROJECT_ERROR" }));
}

async function handleVideoProjectRoutes(context, req, res, pathname) {
  const service = context.videoProjectService;
  if (!service) return false;
  const {
    appConfig,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    findTrendItem,
    json,
    badRequest,
    unauthorized,
    notFound,
  } = bindRouteScope(context);

  if (req.method === "GET" && pathname === "/api/video-models/capabilities") {
    json(res, 200, { models: service.getCapabilities() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/video-projects/estimate") {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    try {
      const payload = await collectBody(req);
      json(res, 200, service.estimateCost(payload));
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/video-projects/active") {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const query = new URL(req.url, "http://redbase.local").searchParams;
    json(res, 200, {
      projects: service.listActiveProjects(user.id, {
        brandId: query.get("brandId") || undefined,
        trendId: query.get("trendId") || undefined,
        ideaIndex: query.get("ideaIndex") || undefined,
      }),
    });
    return true;
  }

  const nestedProjectMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/video-project$/);
  if (req.method === "POST" && nestedProjectMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brandId = Number(nestedProjectMatch[1]);
    const trendId = Number(nestedProjectMatch[2]);
    const ideaIndex = Number(nestedProjectMatch[3]);
    const brand = findBrandByOwner(brandId, user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, trendId);
    if (!trend) {
      badRequest(res, "当前趋势不存在，请刷新页面后重试。");
      return true;
    }
    const idea = Array.isArray(trend.ideas) ? trend.ideas[ideaIndex] : null;
    if (!idea) {
      badRequest(res, "当前选题不存在，请刷新页面后重试。");
      return true;
    }
    try {
      const payload = await collectBody(req);
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) {
        badRequest(res, "缺少 requestId，请重试。");
        return true;
      }
      const model = String(payload.model || "d2").toLowerCase();
      const capabilities = service.getCapabilities().find((item) => item.id === model);
      if (!capabilities) {
        badRequest(res, "当前视频模型不可用。");
        return true;
      }
      const videoScriptGenerationId = Number(payload.videoScriptGenerationId || 0);
      if (!Number.isSafeInteger(videoScriptGenerationId) || videoScriptGenerationId <= 0) {
        respondVideoError(res, Object.assign(new Error("请先生成当前视频模型对应的视频脚本。"), { code: "VIDEO_SCRIPT_GENERATION_REQUIRED" }), badRequest);
        return true;
      }
      const projectResult = await service.createProject({
        ownerUserId: user.id,
        requestId,
        brand,
        trend,
        idea,
        brandId: brand.id,
        trendId: trend.id,
        ideaIndex,
        model,
        mode: payload.mode,
        resolution: payload.resolution,
        aspectRatio: payload.aspectRatio,
        totalDurationSec: payload.totalDurationSec,
        videoScriptGenerationId,
      });
      json(res, 200, { ...projectResult, user: sanitizeUser(projectResult.user || user) });
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  const projectMatch = pathname.match(/^\/api\/video-projects\/(\d+)$/);
  if (req.method === "GET" && projectMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const project = service.getProject(Number(projectMatch[1]), user.id);
    if (!project) {
      notFound(res);
      return true;
    }
    json(res, 200, { project });
    return true;
  }

  const startMatch = pathname.match(/^\/api\/video-projects\/(\d+)\/start$/);
  if (req.method === "POST" && startMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    try {
      json(res, 200, { project: service.startProject(Number(startMatch[1]), user.id) });
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  const retryMatch = pathname.match(/^\/api\/video-projects\/(\d+)\/clips\/(\d+)\/retry$/);
  if (req.method === "POST" && retryMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    try {
      const payload = await collectBody(req);
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) {
        badRequest(res, "缺少 requestId，请重试。");
        return true;
      }
      const result = await service.retryClip(
        Number(retryMatch[1]),
        user.id,
        Number(retryMatch[2]),
        requestId,
        String(payload.prompt || "").trim(),
      );
      json(res, 200, {
        project: result?.project || result,
        user: sanitizeUser(result?.user || user),
      });
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  const retryResultMatch = pathname.match(/^\/api\/video-projects\/(\d+)\/clips\/(\d+)\/retry-result$/);
  if (req.method === "POST" && retryResultMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    try {
      const payload = await collectBody(req);
      const requestId = String(payload?.requestId || "").trim();
      const result = await service.retryClipResult(Number(retryResultMatch[1]), user.id, Number(retryResultMatch[2]), requestId);
      json(res, 200, {
        project: result?.project || result,
        user: sanitizeUser(result?.user || user),
      });
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  const assemblyRetryMatch = pathname.match(/^\/api\/video-projects\/(\d+)\/retry-assembly$/);
  if (req.method === "POST" && assemblyRetryMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    try {
      const payload = await collectBody(req);
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) {
        badRequest(res, "缺少 requestId，请重试。");
        return true;
      }
      json(res, 200, { project: await service.retryAssembly(Number(assemblyRetryMatch[1]), user.id, requestId) });
    } catch (error) {
      respondVideoError(res, error, badRequest);
    }
    return true;
  }

  const assetMatch = pathname.match(/^\/api\/video-projects\/(\d+)\/assets\/(final|final-poster|input|clip|poster|continuity-frame)(?:\/(\d+))?$/);
  if (req.method === "GET" && assetMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "视频链接已失效，请刷新页面后重试");
      return true;
    }
    // The HMAC-signed URL is the bearer credential here. Provider callbacks
    // cannot carry a RedBase session cookie when fetching continuity frames.
    const served = await service.serveAsset(Number(assetMatch[1]), null, assetMatch[2], assetMatch[3], res, req);
    if (!served && !res.writableEnded) notFound(res);
    return true;
  }

  return false;
}

module.exports = {
  handleVideoProjectRoutes,
  normalizeReferenceAssetIds,
};
