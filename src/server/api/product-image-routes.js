const { bindRouteScope } = require("./route-scope");

async function handleProductImageRoutes(context, req, res, pathname) {
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

  if (req.method === "GET" && pathname === "/api/product-images") {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    json(res, 200, {
      images: (storeState.productImages || [])
        .filter((image) => image.ownerUserId === user.id && !image.deletedAt)
        .sort(sortProductImages)
        .map((image) => buildProductImageView(image, appConfig)),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/product-images") {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    const payload = await collectBody(req);
    let saved;
    try {
      saved = await saveProductImage(storeState, user, payload);
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
      badRequest(res, error.message || "产品图上传失败");
      return true;
    }
    await writeStore(storeState);
    json(res, 201, { image: buildProductImageView(saved.image, appConfig), duplicate: saved.duplicate });
    return true;
  }

  const productImageFileMatch = pathname.match(/^\/api\/product-images\/(\d+)\/file$/);
  if (req.method === "GET" && productImageFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const storeState = await readStore();
    const image = (storeState.productImages || []).find((item) => item.id === Number(productImageFileMatch[1]) && !item.deletedAt) || null;
    if (!image) {
      notFound(res);
      return true;
    }
    try {
      const data = await fsp.readFile(resolveStoredProductImagePath(image));
      res.writeHead(200, {
        "Content-Type": image.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      });
      res.end(data);
    } catch (error) {
      notFound(res);
    }
    return true;
  }

  const productImageMatch = pathname.match(/^\/api\/product-images\/(\d+)$/);
  if (req.method === "DELETE" && productImageMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    const image = findOwnedProductImage(storeState, user, Number(productImageMatch[1]));
    if (!image) {
      notFound(res);
      return true;
    }
    try {
      await fsp.unlink(resolveStoredProductImagePath(image));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[product-image] failed to remove file", { imageId: image.id, error: error.message });
      }
    }
    image.deletedAt = new Date().toISOString();
    await writeStore(storeState);
    json(res, 200, { ok: true, image: buildProductImageView(image, appConfig) });
    return true;
  }

  return false;
}

module.exports = {
  handleProductImageRoutes,
};
