const { bindRouteScope } = require("./route-scope");

async function handleImageGenerationRoutes(context, req, res, pathname) {
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

  const imageMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/image$/);
  if (req.method === "POST" && imageMatch) {
    const requestStartedAt = Date.now();
    console.log("[image-job] api image route entered", {
      brandId: Number(imageMatch[1]),
      trendId: Number(imageMatch[2]),
      ideaIndex: Number(imageMatch[3]),
    });

    const storeState = await readStore();
    console.log("[image-job] store loaded", {
      elapsedMs: Date.now() - requestStartedAt,
      brandCount: Array.isArray(storeState.brands) ? storeState.brands.length : 0,
    });

    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    console.log("[image-job] user authenticated", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
    });

    const brand = storeState.brands.find((item) => item.id === Number(imageMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(imageMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(imageMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    const payload = await collectBody(req);
    console.log("[image-job] request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      hasProductImage: Array.isArray(payload.productImages) ? payload.productImages.length > 0 : Boolean(payload.productImage),
    });

    const productImages = await resolveProductImageInputs(storeState, user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    if (!hasEnoughCredits(user, CREDIT_COSTS.momentsImage, res)) return true;
    console.log("[image-job] credits checked", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      currentCredits: user.credits,
    });

    const job = await createImageJob({ brand, trend, idea, productImages, logoImage });
    console.log("[image-job] api created job", {
      jobId: job.id,
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(imageMatch[3]),
    });
    spendCredits(user, CREDIT_COSTS.momentsImage);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "momentsImage",
      actionLabel: "朋友圈图生成",
      creditDelta: -CREDIT_COSTS.momentsImage,
      creditCost: CREDIT_COSTS.momentsImage,
      brand,
      trend,
      idea,
      channelLabel: "朋友圈图",
      summary: idea.title,
      payload: {
        referenceImageUsed: productImages.length > 0,
        referenceImageCount: productImages.length,
        logoUsed: Boolean(logoImage),
      },
    });
    console.log("[image-job] credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: user.credits,
    });
    job.generationContext = {
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(imageMatch[3]),
      creditEventId: creditEvent.id,
    };
    upsertImageJobRecord(storeState, user.id, job);
    await writeStore(storeState);
    json(res, 202, { ...buildImageJobResponse(job), user: sanitizeUser(user) });
    return true;
  }

  const imageJobMatch = pathname.match(/^\/api\/image-jobs\/([a-f0-9]+)$/);
  if (req.method === "GET" && imageJobMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const job = imageJobs.get(imageJobMatch[1]) || findOwnedImageJob(storeState, user, imageJobMatch[1]);
    if (!job) {
      badRequest(res, "图片任务不存在或已过期，请重新发起生图。");
      return true;
    }
    imageJobs.set(job.id, job);

    console.log("[image-job] api polling job", {
      jobId: job.id,
      userId: user.id,
      currentStatus: job.status,
      providerMode: job.providerMode || "",
      ageMs: Date.now() - job.createdAt,
      hasResultUrl: Boolean(job.providerResultUrl),
      generationContext: job.generationContext || null,
    });
    let resolved;
    try {
      resolved = await resolveImageJob(job);
    } catch (error) {
      resolved = {
        ...job,
        status: "failed",
        error: formatImageServiceError(error),
      };
      imageJobs.set(job.id, resolved);
    }
    upsertImageJobRecord(storeState, user.id, resolved);
    if (resolved.status === "completed" && resolved.generationContext && !resolved.generationId) {
      if (resolved.generationContext.type === "imageEdit") {
        const editEntry = await appendImageEditToGeneration(storeState, user.id, resolved);
        if (editEntry) {
          attachImageEditToCreditEvent(storeState, resolved.generationContext.creditEventId, editEntry, resolved.generationContext.sourceGenerationId);
          resolved.generationId = resolved.generationContext.sourceGenerationId;
          if (editEntry.imageUrl) {
            resolved.imageUrl = editEntry.imageUrl;
          }
          upsertImageJobRecord(storeState, user.id, resolved);
        }
      } else {
        const brand = storeState.brands.find(
          (item) => item.id === resolved.generationContext.brandId && item.ownerUserId === user.id,
        );
        const trend = findTrendItem(brand, resolved.generationContext.trendId);
        const idea = trend?.ideas?.[resolved.generationContext.ideaIndex];
        if (brand && trend && idea && resolved.generationContext.type !== "xhsCarouselSlide") {
          const type = resolved.generationContext.type || "moments";
          const channelLabel = resolved.generationContext.channelLabel || "朋友圈图";
          const payload = type === "wechat" ? buildGeneratedAssetPayload(resolved) : buildMomentsGenerationPayload(resolved);
          const generation = createGenerationRecord(storeState, user.id, brand, trend, idea, type, channelLabel, payload);
          await persistGenerationImages(generation);
          attachGenerationToCreditEvent(storeState, resolved.generationContext.creditEventId, generation, payload);
          resolved.generationId = generation.id;
          if (generation.previewUrl) {
            resolved.imageUrl = generation.previewUrl;
          }
          upsertImageJobRecord(storeState, user.id, resolved);
        }
      }
    }
    await writeStore(storeState);
    json(res, 200, buildImageJobResponse(resolved));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/image-edits") {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const payload = await collectBody(req);
    const sourceImageUrl = String(payload.imageUrl || "").trim();
    const editPrompt = String(payload.prompt || "").trim();
    const sourceSlideIndex = payload.slideIndex === "" || payload.slideIndex == null ? null : Number(payload.slideIndex);
    if (!editPrompt) {
      badRequest(res, "请填写改图提示词。");
      return true;
    }
    const sourceGenerationId = Number(payload.generationId || 0);
    const sourceGeneration = sourceGenerationId ? findOwnedGeneration(storeState, user, sourceGenerationId) : null;
    if (sourceGenerationId && !sourceGeneration) {
      badRequest(res, "当前历史图片不存在或你没有访问权限。");
      return true;
    }
    const localSourceImage = sourceGeneration
      ? await resolveGeneratedImageInputForEdit(sourceGeneration, sourceImageUrl, String(payload.parentEditId || ""))
      : null;
    const sourceIsRemoteUrl = /^https?:\/\//i.test(sourceImageUrl);
    if (!sourceIsRemoteUrl && !localSourceImage) {
      badRequest(res, "请先选择一张已生成的图片再改图。");
      return true;
    }
    if (!hasEnoughCredits(user, CREDIT_COSTS.imageEdit, res)) return true;

    const job = await createImageJob({
      sourceImageUrls: sourceIsRemoteUrl && !localSourceImage ? [sourceImageUrl] : [],
      sourceImages: localSourceImage ? [localSourceImage] : [],
      aspectRatio: String(payload.aspectRatio || appConfig.imageProvider.aspectRatio || "").trim() || undefined,
      metadata: {
        title: String(payload.title || "改图结果").slice(0, 120),
        visualDirection: "基于已生成图片继续改图",
        style: "image edit",
        composition: "保留原图主体和构图基础，只按追加提示词修改需要调整的部分",
        prompt: editPrompt,
        editPrompt,
        originalImageUrl: sourceImageUrl,
        sourceStoredPath: localSourceImage?.storedPath || "",
      },
    });
    spendCredits(user, CREDIT_COSTS.imageEdit);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "imageEdit",
      actionLabel: "追加提示词改图",
      creditDelta: -CREDIT_COSTS.imageEdit,
      creditCost: CREDIT_COSTS.imageEdit,
      channelLabel: "改图",
      summary: editPrompt.slice(0, 80),
      payload: {
        sourceImageUrl,
        aspectRatio: payload.aspectRatio || "",
        sourceGenerationId: sourceGeneration?.id ?? null,
        parentEditId: payload.parentEditId || "",
        sourceSlideIndex: Number.isInteger(sourceSlideIndex) ? sourceSlideIndex : null,
      },
    });
    job.generationContext = {
      type: "imageEdit",
      channelLabel: "改图",
      userId: user.id,
      creditEventId: creditEvent.id,
      sourceGenerationId: sourceGeneration?.id ?? null,
      parentEditId: String(payload.parentEditId || ""),
      sourceImageUrl,
      editPrompt,
      title: String(payload.title || "改图结果").slice(0, 120),
      aspectRatio: String(payload.aspectRatio || ""),
      sourceSlideIndex: Number.isInteger(sourceSlideIndex) ? sourceSlideIndex : null,
    };
    upsertImageJobRecord(storeState, user.id, job);
    await writeStore(storeState);
    json(res, 202, { ...buildImageJobResponse(job), user: sanitizeUser(user) });
    return true;
  }

  const wechatLongImageMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/wechat-long-image$/);
  if (req.method === "POST" && wechatLongImageMatch) {
    const requestStartedAt = Date.now();
    console.log("[image-job] api wechat route entered", {
      brandId: Number(wechatLongImageMatch[1]),
      trendId: Number(wechatLongImageMatch[2]),
      ideaIndex: Number(wechatLongImageMatch[3]),
    });
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const brand = storeState.brands.find((item) => item.id === Number(wechatLongImageMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(wechatLongImageMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(wechatLongImageMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    const payload = await collectBody(req);
    const productImages = await resolveProductImageInputs(storeState, user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    console.log("[image-job] wechat request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
    });
    if (!hasEnoughCredits(user, CREDIT_COSTS.wechatImage, res)) return true;
    const wechatPack = buildWechatLongImagePack({ brand, trend, idea });
    console.log("[image-job] creating wechat image job", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(wechatLongImageMatch[3]),
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
      title: wechatPack.publishTitle || idea.title,
    });
    const job = await createImageJob({
      brand,
      trend,
      idea,
      productImages,
      logoImage,
      aspectRatio: "9:16",
      metadata: {
        ...wechatPack,
        aspectRatio: "9:16",
        visualDirection: wechatPack.positioning,
        style: "wechat article long image",
        composition: "9:16 竖版长图，顶部标题区，中段信息摘要区，底部轻CTA区，适合微信公众号阅读",
      },
    });
    job.generationContext = {
      type: "wechat",
      channelLabel: "公众号长图",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(wechatLongImageMatch[3]),
    };
    console.log("[image-job] api created wechat job", {
      elapsedMs: Date.now() - requestStartedAt,
      jobId: job.id,
      userId: user.id,
    });
    spendCredits(user, CREDIT_COSTS.wechatImage);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "wechatImage",
      actionLabel: "公众号长图生成",
      creditDelta: -CREDIT_COSTS.wechatImage,
      creditCost: CREDIT_COSTS.wechatImage,
      brand,
      trend,
      idea,
      channelLabel: "公众号长图",
      summary: wechatPack.publishTitle || idea.title,
      payload: {
        referenceImageUsed: productImages.length > 0,
        referenceImageCount: productImages.length,
        logoUsed: Boolean(logoImage),
        aspectRatio: "9:16",
      },
    });
    job.generationContext.creditEventId = creditEvent.id;
    upsertImageJobRecord(storeState, user.id, job);
    console.log("[image-job] wechat credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: user.credits,
      creditEventId: creditEvent.id,
    });
    await writeStore(storeState);
    json(res, 200, {
      wechatPack,
      jobId: job.id,
      user: sanitizeUser(user),
    });
    return true;
  }

  const xhsCarouselPreviewMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/preview$/);
  if (req.method === "POST" && xhsCarouselPreviewMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const brand = storeState.brands.find((item) => item.id === Number(xhsCarouselPreviewMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(xhsCarouselPreviewMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(xhsCarouselPreviewMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    json(res, 200, {
      carouselPack: buildXhsCarouselPack({ brand, trend, idea }),
      user: sanitizeUser(user),
    });
    return true;
  }

  const xhsCarouselMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel$/);
  if (req.method === "POST" && xhsCarouselMatch) {
    const requestStartedAt = Date.now();
    console.log("[image-job] api carousel route entered", {
      brandId: Number(xhsCarouselMatch[1]),
      trendId: Number(xhsCarouselMatch[2]),
      ideaIndex: Number(xhsCarouselMatch[3]),
    });
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const brand = storeState.brands.find((item) => item.id === Number(xhsCarouselMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(xhsCarouselMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(xhsCarouselMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    const payload = await collectBody(req);
    const productImages = await resolveProductImageInputs(storeState, user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    console.log("[image-job] carousel request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
    });
    if (!hasEnoughCredits(user, CREDIT_COSTS.xhsCarousel, res)) return true;
    const carouselPack = buildXhsCarouselPack({ brand, trend, idea });
    const slideJobRecords = await Promise.all(
      carouselPack.slides.map(async (slide, slideIndex) => {
        console.log("[image-job] creating carousel slide job", {
          elapsedMs: Date.now() - requestStartedAt,
          userId: user.id,
          brandId: brand.id,
          trendId: trend.id,
          ideaIndex: Number(xhsCarouselMatch[3]),
          slideIndex,
          pageLabel: slide.pageLabel,
          hasProductImage: productImages.length > 0,
          productImageCount: productImages.length,
        });
        const job = await createImageJob({
          brand,
          trend,
          idea,
          productImages,
          logoImage,
          metadata: {
            title: `${carouselPack.title} ${slide.pageLabel}`,
            visualDirection: slide.title,
            style: "xiaohongshu carousel cover page",
            composition: `小红书组图${slideIndex + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性`,
            prompt: slide.prompt,
            slideIndex,
            pageLabel: slide.pageLabel,
            copy: slide.copy,
          },
        });
        job.generationContext = {
          type: "xhsCarouselSlide",
          userId: user.id,
          brandId: brand.id,
          trendId: trend.id,
          ideaIndex: Number(xhsCarouselMatch[3]),
          slideIndex,
        };
        console.log("[image-job] api created carousel slide job", {
          elapsedMs: Date.now() - requestStartedAt,
          jobId: job.id,
          userId: user.id,
          slideIndex,
        });
        return { slideIndex, job };
      }),
    );
    const slideJobs = slideJobRecords.map(({ slideIndex, job }) => ({
      slideIndex,
      jobId: job.id,
    }));
    for (const { job } of slideJobRecords) {
      upsertImageJobRecord(storeState, user.id, job);
    }
    spendCredits(user, CREDIT_COSTS.xhsCarousel);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "xhsCarousel",
      actionLabel: "小红书组图生成",
      creditDelta: -CREDIT_COSTS.xhsCarousel,
      creditCost: CREDIT_COSTS.xhsCarousel,
      brand,
      trend,
      idea,
      channelLabel: "小红书组图",
      summary: carouselPack.publishTitle || idea.title,
      payload: {
        slideJobs,
        referenceImageUsed: productImages.length > 0,
        referenceImageCount: productImages.length,
        logoUsed: Boolean(logoImage),
      },
    });
    console.log("[image-job] carousel credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: user.credits,
      creditEventId: creditEvent.id,
      slideJobCount: slideJobs.length,
    });
    for (const slideJob of slideJobs) {
      const job = imageJobs.get(slideJob.jobId);
      if (job?.generationContext) {
        job.generationContext.creditEventId = creditEvent.id;
        upsertImageJobRecord(storeState, user.id, job);
      }
    }
    await writeStore(storeState);
    json(res, 200, {
      carouselPack,
      slideJobs,
      creditEventId: creditEvent.id,
      user: sanitizeUser(user),
    });
    return true;
  }

  const xhsCarouselSlideMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/slides\/(\d+)$/);
  if (req.method === "POST" && xhsCarouselSlideMatch) {
    const requestStartedAt = Date.now();
    const slideIndex = Number(xhsCarouselSlideMatch[4]);
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex > 3) {
      badRequest(res, "小红书组图页码无效。");
      return true;
    }

    const brand = storeState.brands.find((item) => item.id === Number(xhsCarouselSlideMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(xhsCarouselSlideMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const ideaIndex = Number(xhsCarouselSlideMatch[3]);
    const idea = trend.ideas[ideaIndex];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    const payload = await collectBody(req);
    const defaultPack = buildXhsCarouselPack({ brand, trend, idea });
    const incomingPack = payload.carouselPack && typeof payload.carouselPack === "object" ? payload.carouselPack : {};
    const incomingSlides = Array.isArray(incomingPack.slides) ? incomingPack.slides : [];
    const slide = normalizeXhsCarouselSlideForJob(payload.slide || incomingSlides[slideIndex], defaultPack.slides[slideIndex], slideIndex);
    if (!slide.prompt) {
      badRequest(res, "请先填写当前页的生图 Prompt。");
      return true;
    }

    const productImages = await resolveProductImageInputs(storeState, user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    if (!hasEnoughCredits(user, CREDIT_COSTS.xhsCarouselSlide, res)) return true;

    console.log("[image-job] creating carousel single slide job", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      slideIndex,
      pageLabel: slide.pageLabel,
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
    });
    const job = await createImageJob({
      brand,
      trend,
      idea,
      productImages,
      logoImage,
      metadata: {
        title: `${incomingPack.title || defaultPack.title} ${slide.pageLabel}`,
        visualDirection: slide.visualDirection,
        style: slide.style,
        composition: slide.composition,
        prompt: slide.prompt,
        slideIndex,
        pageLabel: slide.pageLabel,
        copy: slide.copy,
      },
    });
    job.generationContext = {
      type: "xhsCarouselSlide",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      slideIndex,
    };
    spendCredits(user, CREDIT_COSTS.xhsCarouselSlide);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "xhsCarousel",
      actionLabel: "小红书组图单张生成",
      creditDelta: -CREDIT_COSTS.xhsCarouselSlide,
      creditCost: CREDIT_COSTS.xhsCarouselSlide,
      brand,
      trend,
      idea,
      channelLabel: "小红书组图",
      summary: `${slide.pageLabel} · ${slide.title}`,
      payload: {
        slideIndex,
        pageLabel: slide.pageLabel,
        referenceImageUsed: productImages.length > 0,
        referenceImageCount: productImages.length,
        logoUsed: Boolean(logoImage),
      },
    });
    job.generationContext.creditEventId = creditEvent.id;
    upsertImageJobRecord(storeState, user.id, job);
    await writeStore(storeState);
    json(res, 202, {
      slideJob: {
        slideIndex,
        jobId: job.id,
      },
      creditEventId: creditEvent.id,
      user: sanitizeUser(user),
    });
    return true;
  }

  const xhsCarouselCompleteMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/complete$/);
  if (req.method === "POST" && xhsCarouselCompleteMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;

    const brand = storeState.brands.find((item) => item.id === Number(xhsCarouselCompleteMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(xhsCarouselCompleteMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(xhsCarouselCompleteMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }

    const payload = await collectBody(req);
    const carouselPack = payload.carouselPack || {};
    const slides = Array.isArray(carouselPack.slides) ? carouselPack.slides : [];
    if (slides.length !== 4 || slides.some((slide) => !String(slide.imageUrl || slide.previewUrl || "").startsWith("http"))) {
      badRequest(res, "小红书组图必须等待 4 张真实图片全部生成完成后才能写入历史。");
      return true;
    }

    const existingGeneration = findGenerationForCreditEvent(storeState, Number(payload.creditEventId), user.id);
    if (existingGeneration) {
      json(res, 200, {
        generation: sanitizeGeneration(existingGeneration, appConfig),
        creditEventId: Number(payload.creditEventId) || null,
        user: sanitizeUser(user),
      });
      return true;
    }

    const generation = createGenerationRecord(storeState, user.id, brand, trend, idea, "xhsCarousel", "小红书组图", carouselPack);
    await persistGenerationImages(generation);
    const creditEvent =
      attachGenerationToCreditEvent(storeState, Number(payload.creditEventId), generation, carouselPack) ||
      attachGenerationToLatestMatchingCreditEvent(storeState, {
        user,
        actionType: "xhsCarousel",
        brand,
        trend,
        idea,
        generation,
        generationPayload: carouselPack,
      });
    await writeStore(storeState);
    json(res, 200, {
      generation: sanitizeGeneration(generation, appConfig),
      creditEventId: creditEvent?.id || null,
      user: sanitizeUser(user),
    });
    return true;
  }

  const styleImageMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/style-image$/);
  if (req.method === "POST" && styleImageMatch) {
    const storeState = await readStore();
    const user = requireAuth(storeState, req, res);
    if (!user) return true;
    const brand = storeState.brands.find((item) => item.id === Number(styleImageMatch[1]) && item.ownerUserId === user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(styleImageMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const idea = trend.ideas[Number(styleImageMatch[3])];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }
    const payload = await collectBody(req);
    const stylePrompt = String(payload.stylePrompt || payload.prompt || "").trim();
    if (!stylePrompt) {
      badRequest(res, "请先填写风格化图提示词。");
      return true;
    }
    const styleReferenceImages = await resolveProductImageInputs(storeState, user, payload.styleReferenceImages || payload.styleReferenceImage, {
      maxCount: 1,
      maxTotalBytes: MAX_PRODUCT_IMAGE_BYTES,
      label: "风格参考图",
    });
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    if (!hasEnoughCredits(user, CREDIT_COSTS.styleImage, res)) return true;
    const metadata = {
      title: String(payload.title || "风格化图片").slice(0, 120),
      visualDirection: "按独立提示词生成风格化图片",
      style: "stylized poster",
      composition: "根据提示词生成适合公众号封面、节日祝福海报或运营视觉的完整画面",
      prompt: `${stylePrompt}\n\n生成一张完整的风格化运营图片，可用于公众号封面、节日祝福海报或品牌日常内容视觉。画面需要完整、干净、有设计感，避免杂乱文字。`,
      stylePrompt,
    };
    let job;
    try {
      job = await createImageJob({
        brand,
        trend,
        idea,
        metadata,
        logoImage,
        styleReferenceImages,
      });
    } catch (error) {
      json(res, 502, { error: formatImageServiceError(error) });
      return true;
    }
    spendCredits(user, CREDIT_COSTS.styleImage);
    const creditEvent = recordCreditEvent(storeState, {
      user,
      actionType: "styleImage",
      actionLabel: "风格化图生成",
      creditDelta: -CREDIT_COSTS.styleImage,
      creditCost: CREDIT_COSTS.styleImage,
      brand,
      trend,
      idea,
      channelLabel: "风格化图",
      summary: stylePrompt.slice(0, 80),
      payload: {
        styleReferenceImageUsed: styleReferenceImages.length > 0,
        styleReferenceImageCount: styleReferenceImages.length,
        logoUsed: Boolean(logoImage),
      },
    });
    job.generationContext = {
      type: "styleImage",
      channelLabel: "风格化图",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(styleImageMatch[3]),
      creditEventId: creditEvent.id,
    };
    upsertImageJobRecord(storeState, user.id, job);
    await writeStore(storeState);
    json(res, 202, { ...buildImageJobResponse(job), user: sanitizeUser(user) });
    return true;
  }

  return false;
}

module.exports = {
  handleImageGenerationRoutes,
};
