const { bindRouteScope } = require("./route-scope");

async function handleAdminRoutes(context, req, res, pathname) {
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

  if (req.method === "GET" && pathname === "/api/admin/overview") {
    const storeState = await readStore();
    const adminUser = requireAdmin(storeState, req, res, appConfig);
    if (!adminUser) return true;
    json(res, 200, buildAdminOverview(storeState, appConfig));
    return true;
  }

  const adminCreditMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/credits$/);
  if (req.method === "POST" && adminCreditMatch) {
    const storeState = await readStore();
    const adminUser = requireAdmin(storeState, req, res, appConfig);
    if (!adminUser) return true;

    const targetUser = storeState.users.find((item) => item.id === Number(adminCreditMatch[1]));
    if (!targetUser) {
      notFound(res);
      return true;
    }

    const payload = await collectBody(req);
    const amount = Math.floor(Number(payload.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      badRequest(res, "请输入大于 0 的加额度数量");
      return true;
    }

    targetUser.credits = Number(targetUser.credits || 0) + amount;
    recordCreditEvent(storeState, {
      user: targetUser,
      actionType: "adminAddCredits",
      actionLabel: "管理员加额度",
      creditDelta: amount,
      creditCost: 0,
      adminUser,
      summary: String(payload.note || "").trim() || `管理员为用户增加 ${amount} 额度`,
      payload: {
        note: String(payload.note || "").trim(),
      },
    });
    await writeStore(storeState);
    json(res, 200, {
      user: sanitizeUser(targetUser),
      overview: buildAdminOverview(storeState, appConfig),
    });
    return true;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === "DELETE" && adminUserMatch) {
    const storeState = await readStore();
    const adminUser = requireAdmin(storeState, req, res, appConfig);
    if (!adminUser) return true;

    const targetUserId = Number(adminUserMatch[1]);
    const targetUser = storeState.users.find((item) => item.id === targetUserId);
    if (!targetUser) {
      notFound(res);
      return true;
    }
    if (targetUser.id === adminUser.id) {
      badRequest(res, "不能删除当前登录的管理员账号。");
      return true;
    }

    await deleteUserCascade(storeState, targetUser);
    await writeStore(storeState);
    json(res, 200, {
      ok: true,
      deletedUserId: targetUser.id,
      overview: buildAdminOverview(storeState, appConfig),
    });
    return true;
  }

  const adminGenerationMatch = pathname.match(/^\/api\/admin\/generations\/(\d+)$/);
  if (req.method === "DELETE" && adminGenerationMatch) {
    const storeState = await readStore();
    const adminUser = requireAdmin(storeState, req, res, appConfig);
    if (!adminUser) return true;
    const generation = (storeState.generations || []).find((item) => item.id === Number(adminGenerationMatch[1]));
    if (!generation) {
      notFound(res);
      return true;
    }

    await deleteGenerationCascade(storeState, generation, imageJobs);
    await writeStore(storeState);
    json(res, 200, {
      ok: true,
      deletedGenerationId: generation.id,
      overview: buildAdminOverview(storeState, appConfig),
    });
    return true;
  }

  return false;
}

module.exports = {
  handleAdminRoutes,
};
