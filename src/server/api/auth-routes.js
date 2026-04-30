const { bindRouteScope } = require("./route-scope");

async function handleAuthRoutes(context, req, res, pathname) {
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

  if (req.method === "POST" && pathname === "/api/auth/send-code") {
    const payload = await collectBody(req);
    if (!isValidPhone(payload.phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }

    const storeState = await readStore();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    storeState.verificationCodes[payload.phone] = {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    await writeStore(storeState);
    json(res, 200, {
      message: "验证码已生成，可直接用于当前环境注册。",
      demoCode: code,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const payload = await collectBody(req);
    const { phone, name, password } = payload;
    const accountType = payload.accountType === "yimei" ? "yimei" : "customer";
    const department = accountType === "yimei" ? String(payload.department || "").trim() : "";
    if (!isValidPhone(phone)) {
      badRequest(res, "请输入正确的手机号");
      return true;
    }
    if (!name || !password || String(password).length < 6) {
      badRequest(res, "请填写昵称并设置至少 6 位密码");
      return true;
    }
    if (accountType === "yimei" && !department) {
      badRequest(res, "请选择部门");
      return true;
    }

    const storeState = await readStore();
    if (storeState.users.some((user) => user.phone === phone)) {
      badRequest(res, "该手机号已注册");
      return true;
    }

    const user = {
      id: storeState.nextUserId++,
      name,
      phone,
      password,
      accountType,
      department,
      credits: accountType === "yimei" ? 50 : 5,
      createdAt: new Date().toISOString(),
    };
    storeState.users.push(user);
    delete storeState.verificationCodes[phone];

    const token = randomToken();
    storeState.sessions.push({
      token,
      userId: user.id,
      createdAt: new Date().toISOString(),
    });

    await writeStore(storeState);
    req.__redbaseApiUser = buildApiUserLog(user);
    json(res, 201, {
      user: sanitizeUser(user),
      sessionToken: token,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const payload = await collectBody(req);
    const { phone, password } = payload;
    const storeState = await readStore();
    const user = storeState.users.find((item) => item.phone === phone && item.password === password);
    if (!user) {
      unauthorized(res, "手机号或密码错误");
      return true;
    }

    const token = randomToken();
    storeState.sessions.push({
      token,
      userId: user.id,
      createdAt: new Date().toISOString(),
    });
    await writeStore(storeState);
    req.__redbaseApiUser = buildApiUserLog(user);
    json(res, 200, {
      user: sanitizeUser(user),
      sessionToken: token,
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/session") {
    const storeState = await readStore();
    const user = getAuthenticatedUser(storeState, req);
    if (!user) {
      unauthorized(res, "登录状态已失效");
      return true;
    }
    json(res, 200, { user: { ...sanitizeUser(user), isAdmin: isAdminUser(user, appConfig) } });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const storeState = await readStore();
    const token = getSessionToken(req);
    if (token) {
      storeState.sessions = storeState.sessions.filter((session) => session.token !== token);
      await writeStore(storeState);
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleAuthRoutes,
};
