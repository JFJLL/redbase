const { bindRouteScope } = require("./route-scope");
const { findUserById, findUserBySessionToken } = require("../db/repositories/auth-repository");
const { addCredits, deleteUserCascadeRows } = require("../db/repositories/admin-repository");
const { findGenerationById, deleteGenerationRows } = require("../db/repositories/generation-repository");

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

  function requireAdminFromSql() {
    const token = getSessionToken(req);
    const user = token ? findUserBySessionToken(token) : null;
    if (!user) {
      unauthorized(res, "请先登录");
      return null;
    }
    if (!isAdminUser(user, appConfig)) {
      forbidden(res, "当前账号没有管理后台权限");
      return null;
    }
    req.__redbaseApiUser = buildApiUserLog(user);
    return user;
  }

  if (req.method === "GET" && pathname === "/api/admin/overview") {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;
    const storeState = await readStore();
    json(res, 200, buildAdminOverview(storeState, appConfig));
    return true;
  }

  const adminCreditMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/credits$/);
  if (req.method === "POST" && adminCreditMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;

    const targetUser = findUserById(Number(adminCreditMatch[1]));
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

    const updatedUser = addCredits({
      targetUserId: targetUser.id,
      amount,
      adminUser,
      note: String(payload.note || "").trim(),
    });
    const storeState = await readStore();
    json(res, 200, {
      user: sanitizeUser(updatedUser),
      overview: buildAdminOverview(storeState, appConfig),
    });
    return true;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === "DELETE" && adminUserMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;

    const targetUserId = Number(adminUserMatch[1]);
    const targetUser = findUserById(targetUserId);
    if (!targetUser) {
      notFound(res);
      return true;
    }
    if (targetUser.id === adminUser.id) {
      badRequest(res, "不能删除当前登录的管理员账号。");
      return true;
    }

    deleteUserCascadeRows(targetUser.id);
    const storeState = await readStore();
    json(res, 200, {
      ok: true,
      deletedUserId: targetUser.id,
      overview: buildAdminOverview(storeState, appConfig),
    });
    return true;
  }

  const adminGenerationMatch = pathname.match(/^\/api\/admin\/generations\/(\d+)$/);
  if (req.method === "DELETE" && adminGenerationMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;
    const generation = findGenerationById(Number(adminGenerationMatch[1]));
    if (!generation) {
      notFound(res);
      return true;
    }

    await removeGenerationLocalFiles(generation);
    deleteGenerationRows(generation.id);
    const storeState = await readStore();
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
