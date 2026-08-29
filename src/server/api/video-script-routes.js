const fsp = require("fs/promises");
const crypto = require("crypto");
const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const brandRepository = require("../db/repositories/brand-repository");
const findBrandByOwner = (...args) => brandRepository.findBrandByOwner(...args);
const {
  findGenerationByOwnerAndRequestId,
  findGenerationByOwner,
} = require("../db/repositories/generation-repository");
const {
  findVideoScriptRequest,
  beginVideoScriptRequest,
  completeVideoScriptRequest,
  failVideoScriptRequest,
  recoverStaleVideoScriptRequests,
} = require("../db/repositories/video-script-billing-repository");
const {
  findProductImageByOwner,
  touchProductImageUsed,
} = require("../db/repositories/product-image-repository");
const { generateVideoScript, generateVisualBible } = require("../ai/video-script-service");
const {
  getVideoModelConfig,
  normalizeModelId,
  normalizeTotalDuration,
  resolveVideoAspectRatio,
} = require("../video/video-model-registry");
const { sanitizeGeneration, sanitizeUser } = require("../utils");
const { CREDIT_COSTS } = require("./credits");

function requireRouteUser(req, res, helpers) {
  return requireSqlAuth(req, res, {
    getSessionToken: helpers.getSessionToken,
    buildApiUserLog: helpers.buildApiUserLog,
    unauthorized: helpers.unauthorized,
  });
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: String(match[1] || "").toLowerCase(),
    buffer: Buffer.from(match[2], "base64"),
    base64: match[2],
  };
}

function calculateVideoScriptInputSignature({
  brandId,
  trendId,
  ideaIndex,
  model,
  mode,
  duration,
  aspectRatio,
  effectiveVideoReferenceIds,
  useBrandLogo,
  styleReferenceSignature,
}) {
  const canonical = {
    aspectRatio: aspectRatio === "smart" ? "smart" : resolveVideoAspectRatio(aspectRatio, "9:16"),
    brandId: Number(brandId),
    duration: String(duration || "auto"),
    effectiveVideoReferenceIds: Array.isArray(effectiveVideoReferenceIds)
      ? [...effectiveVideoReferenceIds].map(Number).sort((a, b) => a - b)
      : [],
    ideaIndex: Number(ideaIndex),
    model: String(model || "").trim().toLowerCase(),
    mode: String(mode || "text").trim().toLowerCase(),
    styleReferenceSignature: String(styleReferenceSignature || "").trim(),
    trendId: Number(trendId),
    useBrandLogo: Boolean(useBrandLogo),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function handleVideoScriptRoutes(context, req, res, pathname) {
  const { appConfig } = context;
  const {
    collectBody,
    getSessionToken,
    buildApiUserLog,
    findTrendItem,
    resolveStoredProductImagePath,
    resolveBrandLogoPath,
    json,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  const videoScriptMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/video-script$/);
  if (req.method === "POST" && videoScriptMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brandId = Number(videoScriptMatch[1]);
    const trendId = Number(videoScriptMatch[2]);
    const ideaIndex = Number(videoScriptMatch[3]);

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

    const payload = await collectBody(req);
    const requestId = String(payload.requestId || "").trim();
    if (!requestId) {
      badRequest(res, "缺少 requestId，请重试。");
      return true;
    }
    recoverStaleVideoScriptRequests();
    const requestedModel = String(payload.model || "").trim();
    const model = requestedModel ? normalizeModelId(requestedModel) : "";
    const modelConfig = model ? getVideoModelConfig(model) : null;
    const mode = String(payload.mode || "text").trim().toLowerCase();
    const requestedVideoAspectRatio = payload.aspectRatioSelection === "smart"
      ? "smart"
      : resolveVideoAspectRatio(payload.aspectRatioSelection || "9:16", "9:16");

    // 解析受控素材输入
    const resolvedImages = [];
    const resolvedVideoReferenceIds = [];

    // 1. 产品图
    const requestedVideoReferenceIds = mode === "image" && Array.isArray(payload.videoReferenceImageIds)
      ? payload.videoReferenceImageIds
      : (mode === "image" && Array.isArray(payload.referenceAssetIds) ? payload.referenceAssetIds : null);
    const productImageItems = model && mode === "image" && requestedVideoReferenceIds
      ? requestedVideoReferenceIds.map((id) => ({ id }))
      : model ? [] : payload.productImages;
    if (payload.useProductImages !== false && Array.isArray(productImageItems)) {
      const productImagesToLoad = productImageItems.slice(0, modelConfig?.maxReferenceImages || 10);
      let pIdx = 1;
      for (const item of productImagesToLoad) {
        const imageId = Number(item?.id);
        if (Number.isFinite(imageId) && imageId > 0) {
          const image = findProductImageByOwner(imageId, user.id);
          if (image) {
            try {
              const filePath = resolveStoredProductImagePath(image);
              const buffer = await fsp.readFile(filePath);
              touchProductImageUsed(image.id, new Date().toISOString());
              resolvedImages.push({
                role: "product",
                roleDescription: `以下图片是产品参考图 ${pIdx}（${image.originalName}），只用于识别产品主体、外观、包装、材质、颜色和品牌元素。`,
                mimeType: image.mimeType || "image/png",
                dataBase64: buffer.toString("base64"),
                name: image.originalName,
              });
              if (model && mode === "image") resolvedVideoReferenceIds.push(image.id);
              pIdx += 1;
            } catch (_fileError) {
              // file read error
            }
          }
        }
      }
    }

    // 2. 风格图
    if (Array.isArray(payload.styleReferenceImages) && payload.styleReferenceImages.length > 0) {
      const styleItem = payload.styleReferenceImages[0];
      if (styleItem && styleItem.dataUrl) {
        const parsed = parseDataUrl(styleItem.dataUrl);
        if (parsed && parsed.buffer.length <= 10 * 1024 * 1024) {
          resolvedImages.push({
            role: "style",
            roleDescription: "以下图片是风格参考图，只参考色调、光影、构图、材质和氛围，不复制具体主体或文字。",
            mimeType: parsed.mimeType,
            dataBase64: parsed.base64,
            name: styleItem.name || "风格参考图",
          });
        }
      }
    }

    // 3. 品牌 Logo
    if (payload.useBrandLogo && brand.logo) {
      try {
        const logoPath = resolveBrandLogoPath ? resolveBrandLogoPath(brand) : null;
        if (logoPath) {
          const buffer = await fsp.readFile(logoPath);
          resolvedImages.push({
            role: "logo",
            roleDescription: `以下图片是${brand.profileType === "personal" ? "个人头像" : "品牌 Logo"}参考，用于品牌/人物识别一致性。`,
            mimeType: brand.logo.mimeType || "image/png",
            dataBase64: buffer.toString("base64"),
            name: brand.logo.originalName || "logo.png",
          });
        }
      } catch (_logoError) {
        // logo file read error
      }
    }

    const styleSignature = Array.isArray(payload.styleReferenceImages) && payload.styleReferenceImages.length > 0
      ? String(payload.styleReferenceImages[0]?.name || "") + ":" + (payload.styleReferenceImages[0]?.dataUrl ? crypto.createHash("sha256").update(payload.styleReferenceImages[0].dataUrl).digest("hex").slice(0, 16) : "")
      : "";

    const inputSignature = calculateVideoScriptInputSignature({
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      model,
      mode,
      duration: payload.videoDuration || payload.durationSelection || "auto",
      aspectRatio: requestedVideoAspectRatio,
      effectiveVideoReferenceIds: resolvedVideoReferenceIds,
      useBrandLogo: Boolean(payload.useBrandLogo && brand.logo),
      styleReferenceSignature: styleSignature,
    });

    const existingRequest = findVideoScriptRequest(user.id, requestId);
    if (existingRequest) {
      const signatureMatch = existingRequest.inputSignature
        ? existingRequest.inputSignature === inputSignature
        : (Number(existingRequest.brandId) === brand.id && Number(existingRequest.trendId) === trend.id && Number(existingRequest.ideaIndex) === ideaIndex && (!model || existingRequest.model === model));
      if (!signatureMatch) {
        json(res, 409, { error: "请求已被使用但输入参数不一致", code: "VIDEO_IDEMPOTENCY_CONFLICT" });
        return true;
      }
      if (existingRequest.status === "completed" && existingRequest.generationId) {
        const completedGeneration = findGenerationByOwner(existingRequest.generationId, user.id);
        if (completedGeneration) {
          json(res, 200, {
            generation: sanitizeGeneration(completedGeneration, appConfig),
            videoScript: completedGeneration.payload?.videoScript || null,
            user: sanitizeUser(user),
          });
          return true;
        }
      }
      const stateMessage = existingRequest.status === "running"
        ? "相同 requestId 的视频脚本仍在处理中，请稍后重试。"
        : "相同 requestId 的视频脚本请求已结束，请使用新的 requestId 重试。";
      json(res, 400, {
        error: stateMessage,
        code: existingRequest.status === "running"
          ? "VIDEO_SCRIPT_REQUEST_RUNNING"
          : "VIDEO_SCRIPT_REQUEST_TERMINAL",
      });
      return true;
    }

    // Legacy fallback: 仅在无 video_script_requests 记录时检查历史 generation
    const legacyExisting = findGenerationByOwnerAndRequestId(user.id, requestId);
    if (legacyExisting) {
      if (legacyExisting.type !== "videoScript") {
        json(res, 409, { error: "请求已被其他生成类型使用", code: "VIDEO_IDEMPOTENCY_CONFLICT" });
        return true;
      }
      const p = legacyExisting.payload || {};
      if (p.inputSignature && p.inputSignature !== inputSignature) {
        json(res, 409, { error: "请求已被使用但输入参数不一致", code: "VIDEO_IDEMPOTENCY_CONFLICT" });
        return true;
      }
      const matches = Number(legacyExisting.brandId) === brand.id &&
        Number(legacyExisting.trendId) === trend.id &&
        Number(p.ideaIndex) === ideaIndex &&
        (!model || String(p.videoModel || "").toLowerCase() === model) &&
        (!model || String(p.videoMode || "text").toLowerCase() === mode) &&
        ((p.aspectRatioSelection === "smart" ? "smart" : resolveVideoAspectRatio(p.videoAspectRatio || p.aspectRatio, "9:16")) === requestedVideoAspectRatio);
      if (!matches) {
        json(res, 409, { error: "请求已被使用但输入参数不一致", code: "VIDEO_IDEMPOTENCY_CONFLICT" });
        return true;
      }
      json(res, 200, {
        generation: sanitizeGeneration(legacyExisting, appConfig),
        videoScript: legacyExisting.payload?.videoScript || null,
        user: sanitizeUser(user),
      });
      return true;
    }

    // 预扣积分
    const productCount = resolvedImages.filter((img) => img.role === "product").length;
    const styleCount = resolvedImages.filter((img) => img.role === "style").length;
    const logoCount = resolvedImages.filter((img) => img.role === "logo").length;

    if (model && !["text", "image"].includes(mode)) {
      badRequest(res, "当前视频生成方式不受支持。");
      return true;
    }
    if (model && mode === "image" && resolvedVideoReferenceIds.length === 0) {
      badRequest(res, "图生视频至少需要一张产品参考图。");
      return true;
    }

    const billingEvent = {
      actionType: "videoScript",
      actionLabel: "视频脚本生成",
      brandId: brand.id,
      brandName: brand.name,
      trendId: trend.id,
      trendTitle: trend.title || "",
      ideaTitle: idea.title || "",
      channelLabel: "视频脚本",
      summary: idea.title,
      payload: {
        requestId,
        referenceImageUsed: productCount > 0,
        referenceImageCount: productCount,
        styleReferenceImageUsed: styleCount > 0,
        styleReferenceImageCount: styleCount,
        logoUsed: logoCount > 0,
        aspectRatio: requestedVideoAspectRatio,
        videoDuration: payload.videoDuration || payload.durationSelection || "auto",
        videoModel: model || undefined,
        videoMode: model ? mode : undefined,
        videoReferenceImageIds: model ? resolvedVideoReferenceIds : undefined,
      },
    };
    const billing = beginVideoScriptRequest({
      userId: user.id,
      requestId,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      model,
      mode,
      creditCost: CREDIT_COSTS.videoScript,
      event: billingEvent,
      inputSignature,
    });

    if (!billing.started && billing.insufficient) {
      badRequest(res, "积分不足或扣除积分失败，请刷新页面重试。");
      return true;
    }
    if (!billing.started) {
      const isRunning = billing.request?.status === "running";
      json(res, 400, {
        error: isRunning
          ? "相同 requestId 的视频脚本仍在处理中，请稍后重试。"
          : "相同 requestId 的视频脚本请求已结束，请使用新的 requestId 重试。",
        code: isRunning ? "VIDEO_SCRIPT_REQUEST_RUNNING" : "VIDEO_SCRIPT_REQUEST_TERMINAL",
      });
      return true;
    }

    try {
      const visualBible = model && mode === "image"
        ? await generateVisualBible(appConfig, {
          brand,
          idea,
          images: resolvedImages,
          analyticsContext: {
            feature: "video_script",
            taskType: "vision_analysis",
            actorUserId: user.id,
            accountType: user.accountType || user.account_type || "",
            entityType: "video_script",
            entityId: `${requestId}:visual-bible`,
          },
        })
        : {};
      const script = await generateVideoScript(appConfig, {
        brand,
        trend,
        idea,
        aspectRatio: requestedVideoAspectRatio,
        durationSelection: payload.videoDuration || payload.durationSelection || "auto",
        images: resolvedImages,
        model,
        mode,
        visualBible,
        referenceAssetIds: resolvedVideoReferenceIds,
        analyticsContext: {
          feature: "video_script",
          taskType: "text_generation",
          actorUserId: user.id,
          accountType: user.accountType || user.account_type || "",
          entityType: "video_script",
          entityId: requestId,
        },
      });

      const generation = {
        ownerUserId: user.id,
        type: "videoScript",
        channelLabel: "视频脚本",
        brandId: brand.id,
        brandName: brand.name,
        trendId: trend.id,
        trendTitle: trend.title || "",
        ideaTitle: idea.title || "",
        cardTitle: script.title || idea.title || "AI 视频脚本",
        createdAt: new Date().toISOString(),
        previewUrl: "",
        summary: script.creativeConcept || idea.summary || "",
        payload: {
          requestId,
          inputSignature,
          ideaIndex,
          aspectRatioSelection: requestedVideoAspectRatio,
          aspectRatio: script.aspectRatio || requestedVideoAspectRatio,
          videoAspectRatio: script.aspectRatio || requestedVideoAspectRatio,
          videoDuration: script.totalDurationSec || normalizeTotalDuration(payload.videoDuration || payload.durationSelection || "auto", 30),
          videoScript: script,
          ...(model ? {
            videoModel: model,
            videoMode: mode,
            videoResolution: String(payload.resolution || "720p"),
            videoReferenceImageIds: resolvedVideoReferenceIds,
            semanticInput: {
              model,
              mode,
              totalDurationSec: script.totalDurationSec,
              aspectRatio: script.aspectRatio || requestedVideoAspectRatio,
              referenceImageIds: resolvedVideoReferenceIds,
            },
            visualBible,
          } : {}),
          referenceImageUsed: productCount > 0,
          referenceImageCount: productCount,
          styleReferenceImageUsed: styleCount > 0,
          styleReferenceImageCount: styleCount,
          logoUsed: logoCount > 0,
        },
      };

      const completed = completeVideoScriptRequest({ userId: user.id, requestId, generation });
      const created = completed.generation;
      if (!created) throw new Error("视频脚本生成记录创建失败");

      json(res, 200, {
        generation: sanitizeGeneration(created, appConfig),
        videoScript: script,
        user: sanitizeUser(completed.user || user),
      });
      return true;
    } catch (error) {
      const failed = failVideoScriptRequest({ userId: user.id, requestId, reason: error.message || "video script generation failed" });
      json(res, 400, {
        error: `视频脚本生成失败：${error.message || "模型服务异常"}，已退还积分。`,
        code: failed?.request?.status === "running" ? "VIDEO_SCRIPT_REQUEST_RUNNING" : "VIDEO_SCRIPT_REQUEST_TERMINAL",
      });
      return true;
    }
  }

  return false;
}

module.exports = {
  handleVideoScriptRoutes,
};
