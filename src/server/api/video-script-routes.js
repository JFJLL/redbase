const fsp = require("fs/promises");
const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  trySpendCreditsWithEvent,
  updateCreditEventGeneration,
  refundCreditEventIfNeeded,
} = require("../db/repositories/admin-repository");
const brandRepository = require("../db/repositories/brand-repository");
const findBrandByOwner = (...args) => brandRepository.findBrandByOwner(...args);
const {
  findGenerationByOwnerAndRequestId,
  insertGeneration,
} = require("../db/repositories/generation-repository");
const {
  findProductImageByOwner,
  touchProductImageUsed,
} = require("../db/repositories/product-image-repository");
const { generateVideoScript, generateVisualBible } = require("../ai/video-script-service");
const { getVideoModelConfig, normalizeModelId } = require("../video/video-model-registry");
const { sanitizeGeneration, sanitizeUser } = require("../utils");
const { CREDIT_COSTS, hasEnoughCredits } = require("./credits");

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
    const requestId = String(payload.requestId || "").trim() || `vs-${user.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestedModel = String(payload.model || "").trim();
    const model = requestedModel ? normalizeModelId(requestedModel) : "";
    const modelConfig = model ? getVideoModelConfig(model) : null;
    const mode = String(payload.mode || "text").trim().toLowerCase();

    // 幂等防线：相同用户、相同 requestId 返回已有 generation
    const existing = findGenerationByOwnerAndRequestId(user.id, requestId);
    if (existing) {
      json(res, 200, {
        generation: sanitizeGeneration(existing, appConfig),
        videoScript: existing.payload?.videoScript || null,
        user: sanitizeUser(user),
      });
      return true;
    }

    if (!hasEnoughCredits(user, CREDIT_COSTS.videoScript, res)) {
      return true;
    }

    // 解析受控素材输入
    const resolvedImages = [];
    const resolvedVideoReferenceIds = [];

    // 1. 产品图
    const requestedVideoReferenceIds = Array.isArray(payload.videoReferenceImageIds)
      ? payload.videoReferenceImageIds
      : (Array.isArray(payload.referenceAssetIds) ? payload.referenceAssetIds : null);
    const productImageItems = model && requestedVideoReferenceIds
      ? requestedVideoReferenceIds.map((id) => ({ id }))
      : payload.productImages;
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
            if (model) resolvedVideoReferenceIds.push(image.id);
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

    const charged = trySpendCreditsWithEvent({
      userId: user.id,
      amount: CREDIT_COSTS.videoScript,
      event: {
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
          aspectRatio: payload.aspectRatioSelection || "9:16",
          videoDuration: payload.videoDuration || payload.durationSelection || "auto",
          videoModel: model || undefined,
          videoMode: model ? mode : undefined,
          videoReferenceImageIds: model ? resolvedVideoReferenceIds : undefined,
        },
      },
    });

    if (!charged || !charged.spent) {
      badRequest(res, "积分不足或扣除积分失败，请刷新页面重试。");
      return true;
    }

    try {
      const visualBible = model && mode === "image"
        ? await generateVisualBible(appConfig, { brand, idea, images: resolvedImages })
        : {};
      const script = await generateVideoScript(appConfig, {
        brand,
        trend,
        idea,
        aspectRatio: payload.aspectRatioSelection || "9:16",
        durationSelection: payload.videoDuration || payload.durationSelection || "auto",
        images: resolvedImages,
        model,
        mode,
        visualBible,
        referenceAssetIds: resolvedVideoReferenceIds,
      });

      const generation = {
        id: allocateCounter("nextGenerationId", 1),
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
          aspectRatio: script.aspectRatio || payload.aspectRatioSelection || "9:16",
          videoScript: script,
          ...(model ? { videoModel: model, videoMode: mode, visualBible } : {}),
          referenceImageUsed: productCount > 0,
          referenceImageCount: productCount,
          styleReferenceImageUsed: styleCount > 0,
          styleReferenceImageCount: styleCount,
          logoUsed: logoCount > 0,
        },
      };

      const created = insertGeneration(generation);
      updateCreditEventGeneration(charged.creditEvent.id, created, created.payload);

      json(res, 200, {
        generation: sanitizeGeneration(created, appConfig),
        videoScript: script,
        user: sanitizeUser(charged.user),
      });
      return true;
    } catch (error) {
      if (charged?.creditEvent?.id) {
        refundCreditEventIfNeeded({
          creditEventId: charged.creditEvent.id,
          userId: user.id,
          reason: error.message || "video script generation failed",
        });
      }
      badRequest(res, `视频脚本生成失败：${error.message || "模型服务异常"}，已退还积分。`);
      return true;
    }
  }

  return false;
}

module.exports = {
  handleVideoScriptRoutes,
};
