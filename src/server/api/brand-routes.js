const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  findBrandByOwner,
  findBrandById,
  insertBrand,
  updateBrand,
  deleteBrandById,
} = require("../db/repositories/brand-repository");
const { listGenerationsByOwner, deleteGenerationRows } = require("../db/repositories/generation-repository");

async function handleBrandRoutes(context, req, res, pathname) {
  const {
    appConfig,
    readStore,
    writeStore,
    imageJobs,
    generateAiTrendSet,
    regenerateTrendIdeas,
    createImageJob,
    resolveImageJob,
    buildImageJobResponse,
    fsp,
    randomToken,
    isValidPhone,
    sanitizeUser,
    sanitizeTrend,
    sanitizeBrand,
    sanitizeGeneration,
    createBrandAssetTags,
    formatTimestamp,
    CREDIT_COSTS,
    MAX_REQUEST_BODY_BYTES,
    MAX_PRODUCT_IMAGE_BYTES,
    MAX_PRODUCT_IMAGE_SELECTION_COUNT,
    MAX_PRODUCT_IMAGE_SELECTION_BYTES,
    MAX_GENERATED_IMAGE_BYTES,
    MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS,
    PRODUCT_IMAGE_MIME_EXTENSIONS,
    hasEnoughCredits,
    spendCredits,
    recordCreditEvent,
    attachGenerationToCreditEvent,
    findGenerationForCreditEvent,
    findOwnedGeneration,
    getTrendAnalysisBrandProfileSize,
    appendImageEditToGeneration,
    attachImageEditToCreditEvent,
    attachGenerationToLatestMatchingCreditEvent,
    deleteUserCascade,
    deleteGenerationCascade,
    removeGenerationLocalFiles,
    collectGenerationStoredPaths,
    collectGenerationContentUrls,
    collectObjectValues,
    findOwnedImageJob,
    upsertImageJobRecord,
    normalizeProductImage,
    resolveProductImageInput,
    resolveProductImageInputs,
    resolveBrandLogoImage,
    saveBrandLogo,
    saveProductImage,
    parseProductImageDataUrl,
    estimateDataUrlBytes,
    formatBytes,
    sanitizeFileName,
    findOwnedProductImage,
    resolveStoredProductImagePath,
    resolveStoredAssetPath,
    removeStoredFileIfExists,
    isRemoteImageUrl,
    buildGeneratedImageUrl,
    buildGeneratedSlideImageUrl,
    buildGeneratedEditImageUrl,
    persistGenerationImages,
    persistGeneratedImageReference,
    saveGeneratedImageFromRemote,
    downloadRemoteGeneratedImage,
    inferImageMimeTypeFromUrl,
    serveStoredGeneratedImage,
    resolveGeneratedImageInputForEdit,
    selectGeneratedImageAsset,
    buildProductImageView,
    verifySignedAssetRequest,
    sortProductImages,
    collectBody,
    getSessionToken,
    shouldLogApiRequest,
    installApiRequestLogger,
    buildApiRequestLog,
    getRequestIp,
    buildApiUserLog,
    maskPhone,
    truncateLogString,
    getAuthenticatedUser,
    requireAuth,
    requireAdmin,
    isAdminUser,
    getConfiguredAdminPhones,
    findTrendItem,
    normalizeEditableText,
    cloneTrendBuckets,
    createGenerationRecord,
    isRenderableGeneration,
    buildAdminOverview,
    buildAdminBrandView,
    sanitizeCreditEvent,
    buildAdminGenerationView,
    getCreditEventCost,
    getGenerationTokenCost,
    sortByCreatedAtDesc,
    maxDate,
    buildMomentsGenerationPayload,
    buildGeneratedAssetPayload,
    getAssetPalette,
    buildWechatLongImagePack,
    buildXhsCarouselPack,
    normalizeXhsCarouselSlideForJob,
    buildSvgPreview,
    escapeXml,
    json,
    notFound,
    badRequest,
    formatImageServiceError,
    unauthorized,
    forbidden,
  } = bindRouteScope(context);

  if (req.method === "POST" && pathname === "/api/brands") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const payload = await collectBody(req);
    const required = ["name", "industry", "audience", "description", "product", "goal"];
    const missing = required.find((key) => !payload[key]);
    if (missing) {
      badRequest(res, `Missing field: ${missing}`);
      return true;
    }

    const assetTags = createBrandAssetTags(payload);
    const profileSize = getTrendAnalysisBrandProfileSize({
      ...payload,
      knowledgeBase: payload.knowledgeBase || "",
      assetTags,
    });
    if (profileSize.total > MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS) {
      badRequest(
        res,
        `当前品牌档案共 ${profileSize.total} 字，超过上限 ${MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字。请删减品牌介绍、产品/服务或品牌资料库后再创建品牌档案。`,
      );
      return true;
    }

    const brandId = allocateCounter("nextBrandId", 1);
    const brand = {
      id: brandId,
      ownerUserId: user.id,
      name: payload.name,
      industry: payload.industry,
      audience: payload.audience,
      description: payload.description,
      product: payload.product,
      goal: payload.goal,
      knowledgeBase: payload.knowledgeBase || "",
      logo: null,
      assetTags,
      analyses: [],
      trends: [],
    };
    if (payload.logoDataUrl) {
      try {
        brand.logo = await saveBrandLogo(user, brand, {
          dataUrl: payload.logoDataUrl,
          name: payload.logoName || "brand-logo",
        });
      } catch (error) {
        if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
        badRequest(res, error.message || "品牌 Logo 上传失败");
        return true;
      }
    }
    const savedBrand = insertBrand(brand);
    json(res, 201, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  const brandMatch = pathname.match(/^\/api\/brands\/(\d+)$/);
  if (req.method === "GET" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    json(res, 200, { brand: sanitizeBrand(brand, appConfig) });
    return true;
  }

  if (req.method === "PUT" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }

    const payload = await collectBody(req);
    const required = ["name", "industry", "audience", "description", "product", "goal"];
    const missing = required.find((key) => !payload[key]);
    if (missing) {
      badRequest(res, `Missing field: ${missing}`);
      return true;
    }

    const assetTags = createBrandAssetTags(payload);
    const profileSize = getTrendAnalysisBrandProfileSize({
      ...payload,
      knowledgeBase: payload.knowledgeBase || "",
      assetTags,
    });
    if (profileSize.total > MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS) {
      badRequest(
        res,
        `当前品牌档案共 ${profileSize.total} 字，超过上限 ${MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字。请删减品牌介绍、产品/服务或品牌资料库后再保存品牌档案。`,
      );
      return true;
    }

    const previousLogoPath = brand.logo?.storedPath || "";
    brand.name = payload.name;
    brand.industry = payload.industry;
    brand.audience = payload.audience;
    brand.description = payload.description;
    brand.product = payload.product;
    brand.goal = payload.goal;
    brand.knowledgeBase = payload.knowledgeBase || "";
    brand.assetTags = assetTags;

    if (payload.logoDataUrl) {
      try {
        brand.logo = await saveBrandLogo(user, brand, {
          dataUrl: payload.logoDataUrl,
          name: payload.logoName || "brand-logo",
        });
        if (previousLogoPath) {
          await removeStoredFileIfExists(resolveStoredAssetPath(previousLogoPath));
        }
      } catch (error) {
        if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
        badRequest(res, error.message || "品牌 Logo 上传失败");
        return true;
      }
    }

    const savedBrand = updateBrand(brand);
    json(res, 200, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  if (req.method === "DELETE" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    const payload = await collectBody(req);
    const deleteGenerations = Boolean(payload.deleteGenerations);
    const deletedGenerationIds = [];
    if (deleteGenerations) {
      const brandGenerations = listGenerationsByOwner(user.id).filter((generation) => generation.brandId === brand.id);
      for (const generation of brandGenerations) {
        deletedGenerationIds.push(generation.id);
        await removeGenerationLocalFiles(generation);
        deleteGenerationRows(generation.id);
      }
    }
    if (brand.logo?.storedPath) {
      await removeStoredFileIfExists(resolveStoredAssetPath(brand.logo.storedPath));
    }
    deleteBrandById(brand.id);
    json(res, 200, { ok: true, deletedGenerationIds });
    return true;
  }

  const brandLogoMatch = pathname.match(/^\/api\/brands\/(\d+)\/logo$/);
  if (req.method === "POST" && brandLogoMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandLogoMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    const payload = await collectBody(req);
    try {
      const previousLogoPath = brand.logo?.storedPath || "";
      const nextLogo = await saveBrandLogo(user, brand, {
        dataUrl: payload.logoDataUrl || payload.dataUrl,
        name: payload.logoName || payload.name || "brand-logo",
      });
      brand.logo = nextLogo;
      if (previousLogoPath) {
        await removeStoredFileIfExists(resolveStoredAssetPath(previousLogoPath));
      }
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
      badRequest(res, error.message || "品牌 Logo 上传失败");
      return true;
    }
    const savedBrand = updateBrand(brand);
    json(res, 200, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  const brandLogoFileMatch = pathname.match(/^\/api\/brands\/(\d+)\/logo\/file$/);
  if (req.method === "GET" && brandLogoFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const brand = findBrandById(Number(brandLogoFileMatch[1]));
    if (!brand?.logo) {
      notFound(res);
      return true;
    }
    try {
      const data = await fsp.readFile(resolveStoredAssetPath(brand.logo.storedPath));
      res.writeHead(200, {
        "Content-Type": brand.logo.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      });
      res.end(data);
    } catch (error) {
      notFound(res);
    }
    return true;
  }

  return false;
}

module.exports = {
  handleBrandRoutes,
};
