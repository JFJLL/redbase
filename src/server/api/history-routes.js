const { bindRouteScope } = require("./route-scope");

async function handleHistoryRoutes(context, req, res, pathname) {
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

  if (req.method === "GET" && pathname === "/api/brands") {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    json(res, 200, {
      brands: storeState.brands.filter((brand) => brand.ownerUserId === user.id).map((brand) => sanitizeBrand(brand, appConfig)),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    json(res, 200, {
      generations: (storeState.generations || [])
        .filter((item) => item.ownerUserId === user.id)
        .filter(isRenderableGeneration)
        .map((generation) => sanitizeGeneration(generation, appConfig)),
    });
    return true;
  }

  const historyGenerationMatch = pathname.match(/^\/api\/history\/(\d+)$/);
  if (req.method === "DELETE" && historyGenerationMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    const generation = findOwnedGeneration(storeState, user, Number(historyGenerationMatch[1]));
    if (!generation) {
      notFound(res);
      return true;
    }

    await deleteGenerationCascade(storeState, generation, imageJobs);
    await writeStore(storeState);
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
    const storeState = await readStore();
    const generation = (storeState.generations || []).find((item) => item.id === Number(generatedImageFileMatch[1]));
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
    const storeState = await readStore();
    const generation = (storeState.generations || []).find((item) => item.id === Number(generatedSlideFileMatch[1]));
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
    const storeState = await readStore();
    const generation = (storeState.generations || []).find((item) => item.id === Number(generatedEditFileMatch[1]));
    const editHistory = Array.isArray(generation?.payload?.editHistory) ? generation.payload.editHistory : [];
    const edit = editHistory.find((item) => item.id === generatedEditFileMatch[2]);
    await serveStoredGeneratedImage(res, edit?.localImage);
    return true;
  }

  return false;
}

module.exports = {
  handleHistoryRoutes,
};
