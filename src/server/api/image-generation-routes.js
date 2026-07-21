const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { signLocalAssetUrls } = require("../assets/signed-urls");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  trySpendCreditsWithEvent,
  findGenerationForCreditEvent: findGenerationIdForCreditEvent,
  updateCreditEventGeneration,
  updateCreditEventEditResult,
  attachGenerationToLatestCreditEvent,
  refundCreditEventIfNeeded,
} = require("../db/repositories/admin-repository");
const { findBrandByOwner, updateCurrentTrendIdeaContentAssets } = require("../db/repositories/brand-repository");
const {
  findGenerationByOwner,
  findXhsCarouselGenerationByGroup,
  insertGeneration,
  upsertGeneration,
} = require("../db/repositories/generation-repository");
const { findProductImageByOwner, touchProductImageUsed } = require("../db/repositories/product-image-repository");
const { findImageJobByOwner, upsertImageJob } = require("../db/repositories/image-job-repository");
const {
  buildImageConceptMetadataFromIdea,
  buildXhsCarouselPackFromIdea,
  buildWechatLongImagePackFromIdea,
} = require("../ai/content-service");
const { sanitizePayloadForClient } = require("../utils");
const { resolveAspectRatio } = require("./aspect-ratios");

function requireAspectRatio(payload, type, res, badRequest) {
  const aspectRatio = resolveAspectRatio(payload?.aspectRatio, type);
  if (!aspectRatio) {
    badRequest(res, "当前生图服务暂不支持该图片比例，请选择其他比例。");
    return null;
  }
  return aspectRatio;
}

function applyAspectRatioToCarouselPack(carouselPack, aspectRatio) {
  return {
    ...carouselPack,
    aspectRatio,
    slides: (Array.isArray(carouselPack?.slides) ? carouselPack.slides : []).map((slide) => ({
      ...slide,
      aspectRatio,
      composition: String(slide?.composition || "").replace(/3:4/g, aspectRatio),
    })),
  };
}

function requireRouteUser(req, res, helpers) {
  return requireSqlAuth(req, res, {
    getSessionToken: helpers.getSessionToken,
    buildApiUserLog: helpers.buildApiUserLog,
    unauthorized: helpers.unauthorized,
  });
}

function buildSqlCreditEventInput({ actionType, actionLabel, brand, trend, idea, channelLabel, summary, payload }) {
  return {
    actionType,
    actionLabel,
    brandId: brand?.id ?? null,
    brandName: brand?.name || "",
    trendId: trend?.id ?? null,
    trendTitle: trend?.title || "",
    ideaTitle: idea?.title || "",
    channelLabel,
    summary,
    payload,
  };
}

function refundFailedImageJobCredits(user, job) {
  const context = job?.generationContext;
  if (job?.status !== "failed" || !context?.creditEventId || context.refundCreditEventId) {
    return { job, user };
  }

  const refundResult = refundCreditEventIfNeeded({
    creditEventId: context.creditEventId,
    userId: user.id,
    reason: job.error || "image job failed",
  });
  if (!refundResult.refundEvent) {
    return { job, user: refundResult.user || user };
  }

  return {
    job: {
      ...job,
      generationContext: {
        ...context,
        refundCreditEventId: refundResult.refundEvent.id,
        refundedAt: refundResult.refundEvent.createdAt,
      },
    },
    user: refundResult.user || user,
  };
}

function createSqlGenerationRecord(userId, brand, trend, idea, type, channelLabel, payload) {
  const summaryByType = {
    moments: payload.caption || payload.visualDirection || "",
    wechat: payload.publishTitle || payload.intro || "",
    xhsCarousel: payload.publishCaption || payload.caption || "",
    styleImage: payload.stylePrompt || payload.visualDirection || "",
  };
  return {
    id: allocateCounter("nextGenerationId", 1),
    ownerUserId: userId,
    type,
    channelLabel,
    brandId: brand.id,
    brandName: brand.name,
    trendId: trend.id,
    trendTitle: trend.title,
    ideaTitle: idea.title,
    cardTitle: payload.title,
    createdAt: new Date().toISOString(),
    previewUrl: payload.previewUrl || payload.imageUrl || payload.slides?.[0]?.previewUrl || "",
    summary: summaryByType[type] || "",
    payload,
  };
}

function normalizeCarouselGroupId(value) {
  return String(value || "").trim().slice(0, 80);
}

function isGeneratedCarouselSlide(slide) {
  return Boolean(String(slide?.imageUrl || slide?.previewUrl || "").trim());
}

function buildSignedImageJobResponse(appConfig, buildImageJobResponse, job) {
  return signLocalAssetUrls(buildImageJobResponse(job), appConfig);
}

function normalizeCarouselSlideIndex(slide, fallbackIndex = 0) {
  const index = Number.isInteger(slide?.sourceSlideIndex) ? slide.sourceSlideIndex : Number(slide?.slideIndex ?? fallbackIndex);
  return Number.isInteger(index) && index >= 0 && index <= 3 ? index : fallbackIndex;
}

function buildEmptyCarouselSlide(index) {
  return {
    sourceSlideIndex: index,
    pageLabel: `第 ${index + 1} 张`,
    title: "",
    copy: "",
    prompt: "",
    visualDirection: "",
    style: "",
    composition: "",
  };
}

function normalizeCarouselSlides(slides) {
  const normalized = Array.from({ length: 4 }, (_, index) => buildEmptyCarouselSlide(index));
  (Array.isArray(slides) ? slides : []).forEach((slide, fallbackIndex) => {
    if (!slide || typeof slide !== "object") return;
    const index = normalizeCarouselSlideIndex(slide, fallbackIndex);
    normalized[index] = {
      ...normalized[index],
      ...slide,
      sourceSlideIndex: index,
      pageLabel: slide.pageLabel || normalized[index].pageLabel,
    };
  });
  return normalized;
}

function mergeXhsCarouselSlidePayload(existingPayload = {}, incomingPayload = {}) {
  const slides = normalizeCarouselSlides(existingPayload.slides);
  normalizeCarouselSlides(incomingPayload.slides).forEach((slide, index) => {
    if (isGeneratedCarouselSlide(slide)) {
      slides[index] = {
        ...slides[index],
        ...slide,
        sourceSlideIndex: index,
        pageLabel: slide.pageLabel || slides[index].pageLabel || `第 ${index + 1} 张`,
      };
    } else if (!slides[index]?.title && slide.title) {
      slides[index] = {
        ...slides[index],
        ...slide,
        sourceSlideIndex: index,
        pageLabel: slide.pageLabel || slides[index].pageLabel || `第 ${index + 1} 张`,
      };
    }
  });
  return {
    ...existingPayload,
    ...incomingPayload,
    generatedMode: slides.every(isGeneratedCarouselSlide) ? "group" : "partialSlides",
    carouselGroupId: normalizeCarouselGroupId(incomingPayload.carouselGroupId || existingPayload.carouselGroupId),
    slides,
  };
}

function buildSingleSlideCarouselPayload(job) {
  const metadata = job?.metadata || {};
  const context = job?.generationContext || {};
  const slideIndex = Number.isInteger(context.slideIndex) ? context.slideIndex : Number(metadata.slideIndex || 0);
  const slide = {
    sourceSlideIndex: slideIndex,
    pageLabel: metadata.pageLabel || `第 ${slideIndex + 1} 张`,
    title: metadata.visualDirection || metadata.title || "小红书组图单张",
    copy: metadata.copy || "",
    prompt: metadata.prompt || "",
    visualDirection: metadata.visualDirection || "",
    style: metadata.style || "",
    composition: metadata.composition || "",
    previewUrl: job.imageUrl || "",
    imageUrl: job.imageUrl || "",
  };
  return {
    title: context.carouselTitle || metadata.title || "小红书组图单张",
    publishTitle: context.publishTitle || metadata.title || slide.title,
    publishCaption: context.publishCaption || metadata.copy || "",
    caption: context.caption || metadata.copy || "",
    generatedMode: "partialSlides",
    carouselGroupId: normalizeCarouselGroupId(context.carouselGroupId),
    sourceSlideIndex: slideIndex,
    aspectRatio: context.aspectRatio || metadata.aspectRatio || "",
    slides: normalizeCarouselSlides([slide]),
  };
}

async function upsertSingleSlideCarouselGeneration({ userId, brand, trend, idea, job, payload, persistGenerationImages }) {
  const groupId = normalizeCarouselGroupId(payload.carouselGroupId);
  const existingGeneration = groupId ? findXhsCarouselGenerationByGroup(userId, groupId) : null;
  const mergedPayload = mergeXhsCarouselSlidePayload(existingGeneration?.payload || {}, payload);
  const generation = existingGeneration
    ? {
        ...existingGeneration,
        cardTitle: mergedPayload.title || existingGeneration.cardTitle,
        previewUrl: mergedPayload.slides.find(isGeneratedCarouselSlide)?.previewUrl || existingGeneration.previewUrl || "",
        summary: mergedPayload.publishCaption || mergedPayload.caption || existingGeneration.summary || "",
        payload: mergedPayload,
      }
    : createSqlGenerationRecord(userId, brand, trend, idea, "xhsCarousel", "小红书组图", mergedPayload);
  await persistGenerationImages(generation);
  return existingGeneration ? upsertGeneration(generation) : insertGeneration(generation);
}

function isValidCompletedCarouselPack(carouselPack) {
  const slides = Array.isArray(carouselPack?.slides) ? carouselPack.slides : [];
  return slides.length === 4 && slides.every(isGeneratedCarouselSlide);
}

function requireIdea({ brand, trendId, ideaIndex, res, badRequest, findTrendItem }) {
  const trend = findTrendItem(brand, Number(trendId));
  if (!trend) {
    badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
    return null;
  }
  const idea = trend.ideas[Number(ideaIndex)];
  if (!idea) {
    badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
    return null;
  }
  return { trend, idea };
}

async function handleImageGenerationRoutes(context, req, res, pathname) {
  const {
    appConfig,
    imageJobs,
    createImageJob,
    resolveImageJob,
    buildImageJobResponse,
    ensureTrendIdeaContentAssets,
    fsp,
    sanitizeUser,
    sanitizeGeneration,
    CREDIT_COSTS,
    MAX_PRODUCT_IMAGE_BYTES,
    MAX_PRODUCT_IMAGE_SELECTION_COUNT,
    MAX_PRODUCT_IMAGE_SELECTION_BYTES,
    normalizeProductImage,
    resolveBrandLogoImage,
    estimateDataUrlBytes,
    formatBytes,
    resolveStoredProductImagePath,
    buildGeneratedEditImageUrl,
    persistGenerationImages,
    persistGeneratedImageReference,
    resolveGeneratedImageInputForEdit,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    findTrendItem,
    buildMomentsGenerationPayload,
    buildGeneratedAssetPayload,
    normalizeXhsCarouselSlideForJob,
    json,
    notFound,
    badRequest,
    formatImageServiceError,
    unauthorized,
  } = bindRouteScope(context);

  async function resolveProductImageInputSql(user, input) {
    const imageId = Number(input?.id || input?.productImageId || 0);
    if (Number.isFinite(imageId) && imageId > 0) {
      const image = findProductImageByOwner(imageId, user.id);
      if (!image) return null;
      const buffer = await fsp.readFile(resolveStoredProductImagePath(image));
      touchProductImageUsed(image.id, new Date().toISOString());
      return {
        id: image.id,
        name: image.originalName,
        dataUrl: `data:${image.mimeType};base64,${buffer.toString("base64")}`,
        sizeBytes: Number(image.sizeBytes || buffer.length),
      };
    }
    return normalizeProductImage(input);
  }

  async function resolveProductImageInputsSql(user, input, options = {}) {
    const rawImages = Array.isArray(input) ? input : input ? [input] : [];
    const maxCount = Number(options.maxCount || MAX_PRODUCT_IMAGE_SELECTION_COUNT);
    const maxTotalBytes = Number(options.maxTotalBytes || MAX_PRODUCT_IMAGE_SELECTION_BYTES);
    const label = String(options.label || "产品参考图");
    if (rawImages.length > maxCount) {
      throw Object.assign(new Error(`${label}最多选择 ${maxCount} 张。请删除已有图片后重新上传或选择。`), {
        code: "IMAGE_LIMIT_EXCEEDED",
      });
    }
    const resolved = [];
    let totalBytes = 0;
    for (const rawImage of rawImages) {
      const image = await resolveProductImageInputSql(user, rawImage);
      if (!image) continue;
      totalBytes += Number(image.sizeBytes || estimateDataUrlBytes(image.dataUrl) || 0);
      if (totalBytes > maxTotalBytes) {
        throw Object.assign(
          new Error(`${label}总大小最多 ${formatBytes(maxTotalBytes)}。请压缩图片或删除已有图片后重新上传。`),
          { code: "IMAGE_LIMIT_EXCEEDED" },
        );
      }
      resolved.push(image);
    }
    return resolved;
  }

  async function appendImageEditToGenerationSql(userId, job) {
    const generationId = Number(job?.generationContext?.sourceGenerationId || 0);
    if (!Number.isFinite(generationId) || generationId <= 0) return null;
    const generation = findGenerationByOwner(generationId, userId);
    if (!generation) return null;

    generation.payload = generation.payload && typeof generation.payload === "object" ? generation.payload : {};
    generation.payload.editHistory = Array.isArray(generation.payload.editHistory) ? generation.payload.editHistory : [];
    const existing = generation.payload.editHistory.find((item) => item.id === job.id);
    if (existing) return existing;

    const editEntry = {
      id: job.id,
      parentEditId: job.generationContext.parentEditId || "",
      sourceImageUrl: job.generationContext.sourceImageUrl || job.metadata?.originalImageUrl || "",
      sourceSlideIndex: Number.isInteger(job.generationContext.sourceSlideIndex) ? job.generationContext.sourceSlideIndex : null,
      imageUrl: job.imageUrl || "",
      previewUrl: job.imageUrl || "",
      title: job.generationContext.title || job.metadata?.title || "改图结果",
      aspectRatio: job.generationContext.aspectRatio || job.metadata?.aspectRatio || "",
      createdAt: new Date(Number(job.createdAt || Date.now())).toISOString(),
      completedAt: job.completedAt || new Date().toISOString(),
    };
    await persistGeneratedImageReference({
      ownerUserId: generation.ownerUserId,
      generationId: generation.id,
      target: editEntry,
      remoteUrl: job.imageUrl || "",
      variant: `edit_${job.id}`,
      localUrl: buildGeneratedEditImageUrl(generation.id, job.id),
    });
    generation.payload.editHistory.unshift(editEntry);
    upsertGeneration(generation);
    return editEntry;
  }

  function contentAssetsUnavailable(res, error) {
    badRequest(res, error?.message || "当前选题缺少趋势分析时生成的内容资产，请先重新生成趋势分析。");
  }

  function writeInsufficientCredits(res, user, cost) {
    const current = Number(user?.credits || 0);
    json(res, 402, { error: `积分不足，本次操作需要 ${cost} 积分，当前剩余 ${current} 积分。` });
  }

  async function runChargedAiWork({ user, cost, event, run }) {
    const spendResult = trySpendCreditsWithEvent({
      userId: user.id,
      amount: cost,
      event,
    });
    if (!spendResult.spent) {
      writeInsufficientCredits(res, spendResult.user || user, cost);
      return null;
    }

    try {
      const value = await run();
      return { value, spendResult, creditEvent: spendResult.creditEvent, user: spendResult.user || user };
    } catch (error) {
      refundCreditEventIfNeeded({
        creditEventId: spendResult.creditEvent.id,
        userId: user.id,
        reason: error?.message || "AI work failed",
      });
      json(res, 502, { error: formatImageServiceError(error) });
      return null;
    }
  }

  async function ensureIdeaAssetsForImage(brand, trend, ideaIndex) {
    if (!ensureTrendIdeaContentAssets) return trend.ideas[Number(ideaIndex)];
    const result = await ensureTrendIdeaContentAssets(brand, trend, Number(ideaIndex));
    if (result.filled) {
      const persisted = updateCurrentTrendIdeaContentAssets(
        brand.id,
        brand.ownerUserId,
        trend.id,
        Number(ideaIndex),
        result.idea.contentAssets,
      );
      if (!persisted) {
        throw new Error("当前选题内容资产保存失败，请刷新趋势后重试。");
      }
    }
    return result.idea;
  }

  const imageMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/image$/);
  if (req.method === "POST" && imageMatch) {
    const requestStartedAt = Date.now();
    console.log("[image-job] api image route entered", {
      brandId: Number(imageMatch[1]),
      trendId: Number(imageMatch[2]),
      ideaIndex: Number(imageMatch[3]),
    });

    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    console.log("[image-job] user authenticated", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
    });

    const brand = findBrandByOwner(Number(imageMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: imageMatch[2], ideaIndex: imageMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;

    const payload = await collectBody(req);
    const aspectRatio = requireAspectRatio(payload, "moments", res, badRequest);
    if (!aspectRatio) return true;
    console.log("[image-job] request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      hasProductImage: Array.isArray(payload.productImages) ? payload.productImages.length > 0 : Boolean(payload.productImage),
    });

    const productImages = await resolveProductImageInputsSql(user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    let metadata;
    try {
      metadata = buildImageConceptMetadataFromIdea(idea);
    } catch (error) {
      try {
        metadata = buildImageConceptMetadataFromIdea(await ensureIdeaAssetsForImage(brand, trend, Number(imageMatch[3])));
      } catch (fillError) {
        contentAssetsUnavailable(res, fillError);
        return true;
      }
    }
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.momentsImage,
      event: buildSqlCreditEventInput({
        actionType: "momentsImage",
        actionLabel: "朋友圈图生成",
        brand,
        trend,
        idea,
        channelLabel: "朋友圈图",
        summary: idea.title,
        payload: {
          referenceImageUsed: productImages.length > 0,
          referenceImageCount: productImages.length,
          logoUsed: Boolean(logoImage),
          aspectRatio,
        },
      }),
      run: () => createImageJob({ ownerUserId: user.id, brand, trend, idea, productImages, logoImage, aspectRatio, metadata: { ...metadata, aspectRatio } }),
    });
    if (!charged) return true;
    const job = charged.value;
    console.log("[image-job] api created job", {
      jobId: job.id,
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(imageMatch[3]),
    });
    console.log("[image-job] credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: charged.user.credits,
    });
    job.generationContext = {
      type: "moments",
      channelLabel: "朋友圈图",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(imageMatch[3]),
      creditEventId: charged.creditEvent.id,
      aspectRatio,
    };
    upsertImageJob(user.id, job);
    json(res, 202, { ...buildSignedImageJobResponse(appConfig, buildImageJobResponse, job), user: sanitizeUser(charged.user) });
    return true;
  }

  const imageJobMatch = pathname.match(/^\/api\/image-jobs\/([a-f0-9]+)$/);
  if (req.method === "GET" && imageJobMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const memoryJob = imageJobs.get(imageJobMatch[1]);
    let job = null;
    if (memoryJob?.ownerUserId === user.id || memoryJob?.generationContext?.userId === user.id) {
      job = memoryJob;
    } else {
      job = findImageJobByOwner(imageJobMatch[1], user.id);
    }
    if (!job) {
      notFound(res);
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
    const refundResult = refundFailedImageJobCredits(user, resolved);
    resolved = refundResult.job;
    const responseUser = refundResult.user;
    upsertImageJob(user.id, resolved);
    if (resolved.status === "completed" && resolved.generationContext && !resolved.generationId) {
      if (resolved.generationContext.type === "imageEdit") {
        const editEntry = await appendImageEditToGenerationSql(user.id, resolved);
        if (editEntry) {
          updateCreditEventEditResult(resolved.generationContext.creditEventId, editEntry, resolved.generationContext.sourceGenerationId);
          resolved.generationId = resolved.generationContext.sourceGenerationId;
          if (editEntry.imageUrl) {
            resolved.imageUrl = editEntry.imageUrl;
          }
          upsertImageJob(user.id, resolved);
        }
      } else {
        const brand = findBrandByOwner(resolved.generationContext.brandId, user.id);
        const trend = findTrendItem(brand, resolved.generationContext.trendId);
        const idea = trend?.ideas?.[resolved.generationContext.ideaIndex];
        if (brand && trend && idea && (resolved.generationContext.type !== "xhsCarouselSlide" || resolved.generationContext.singleSlideOnly)) {
          const isSingleCarouselSlide = resolved.generationContext.type === "xhsCarouselSlide" && resolved.generationContext.singleSlideOnly;
          const type = isSingleCarouselSlide ? "xhsCarousel" : resolved.generationContext.type || "moments";
          const channelLabel = isSingleCarouselSlide ? "小红书组图" : resolved.generationContext.channelLabel || "朋友圈图";
          const payload = isSingleCarouselSlide
            ? buildSingleSlideCarouselPayload(resolved)
            : type === "wechat"
              ? buildGeneratedAssetPayload(resolved)
              : buildMomentsGenerationPayload(resolved);
          const generation = isSingleCarouselSlide
            ? await upsertSingleSlideCarouselGeneration({ userId: user.id, brand, trend, idea, job: resolved, payload, persistGenerationImages })
            : createSqlGenerationRecord(user.id, brand, trend, idea, type, channelLabel, payload);
          if (!isSingleCarouselSlide) {
            await persistGenerationImages(generation);
            insertGeneration(generation);
          }
          updateCreditEventGeneration(resolved.generationContext.creditEventId, generation, generation.payload || payload);
          resolved.generationId = generation.id;
          const currentSlideIndex = Number.isInteger(payload.sourceSlideIndex) ? payload.sourceSlideIndex : 0;
          const currentSlide = isSingleCarouselSlide ? generation.payload?.slides?.[currentSlideIndex] : null;
          const currentImageUrl = currentSlide?.imageUrl || currentSlide?.previewUrl || generation.previewUrl;
          if (currentImageUrl) {
            resolved.imageUrl = currentImageUrl;
          }
          upsertImageJob(user.id, resolved);
        }
      }
    }
    const response = buildSignedImageJobResponse(appConfig, buildImageJobResponse, resolved);
    if (resolved.status === "failed" && responseUser?.id === user.id) {
      response.user = sanitizeUser(responseUser);
    }
    json(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/image-edits") {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const payload = await collectBody(req);
    const editAspectRatio = requireAspectRatio(payload, "moments", res, badRequest);
    if (!editAspectRatio) return true;
    const sourceImageUrl = String(payload.imageUrl || "").trim();
    const editPrompt = String(payload.prompt || "").trim();
    const sourceSlideIndex = payload.slideIndex === "" || payload.slideIndex == null ? null : Number(payload.slideIndex);
    if (!editPrompt) {
      badRequest(res, "请填写改图提示词。");
      return true;
    }
    const sourceGenerationId = Number(payload.generationId || 0);
    const sourceGeneration = sourceGenerationId ? findGenerationByOwner(sourceGenerationId, user.id) : null;
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
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.imageEdit,
      event: buildSqlCreditEventInput({
        actionType: "imageEdit",
        actionLabel: "追加提示词改图",
        channelLabel: "改图",
        summary: editPrompt.slice(0, 80),
        payload: {
          sourceImageUrl,
          aspectRatio: editAspectRatio,
          sourceGenerationId: sourceGeneration?.id ?? null,
          parentEditId: payload.parentEditId || "",
          sourceSlideIndex: Number.isInteger(sourceSlideIndex) ? sourceSlideIndex : null,
        },
      }),
      run: () =>
        createImageJob({
          ownerUserId: user.id,
          sourceImageUrls: sourceIsRemoteUrl && !localSourceImage ? [sourceImageUrl] : [],
          sourceImages: localSourceImage ? [localSourceImage] : [],
          aspectRatio: editAspectRatio,
          metadata: {
            title: String(payload.title || "改图结果").slice(0, 120),
            visualDirection: "基于已生成图片继续改图",
            style: "image edit",
            composition: "保留原图主体和构图基础，只按追加提示词修改需要调整的部分",
            prompt: editPrompt,
            editPrompt,
            originalImageUrl: sourceImageUrl,
            aspectRatio: editAspectRatio,
            sourceStoredPath: localSourceImage?.storedPath || "",
          },
        }),
    });
    if (!charged) return true;
    const job = charged.value;
    job.generationContext = {
      type: "imageEdit",
      channelLabel: "改图",
      userId: user.id,
      creditEventId: charged.creditEvent.id,
      sourceGenerationId: sourceGeneration?.id ?? null,
      parentEditId: String(payload.parentEditId || ""),
      sourceImageUrl,
      editPrompt,
      title: String(payload.title || "改图结果").slice(0, 120),
      aspectRatio: editAspectRatio,
      sourceSlideIndex: Number.isInteger(sourceSlideIndex) ? sourceSlideIndex : null,
    };
    upsertImageJob(user.id, job);
    json(res, 202, { ...buildSignedImageJobResponse(appConfig, buildImageJobResponse, job), user: sanitizeUser(charged.user) });
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
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(wechatLongImageMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: wechatLongImageMatch[2], ideaIndex: wechatLongImageMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;

    const payload = await collectBody(req);
    const aspectRatio = requireAspectRatio(payload, "wechat", res, badRequest);
    if (!aspectRatio) return true;
    const productImages = await resolveProductImageInputsSql(user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    console.log("[image-job] wechat request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
    });
    let wechatPack;
    try {
      wechatPack = buildWechatLongImagePackFromIdea(idea);
    } catch (error) {
      try {
        wechatPack = buildWechatLongImagePackFromIdea(await ensureIdeaAssetsForImage(brand, trend, Number(wechatLongImageMatch[3])));
      } catch (fillError) {
        contentAssetsUnavailable(res, fillError);
        return true;
      }
    }
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
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.wechatImage,
      event: buildSqlCreditEventInput({
        actionType: "wechatImage",
        actionLabel: "公众号长图生成",
        brand,
        trend,
        idea,
        channelLabel: "公众号长图",
        summary: wechatPack.publishTitle || idea.title,
        payload: {
          referenceImageUsed: productImages.length > 0,
          referenceImageCount: productImages.length,
          logoUsed: Boolean(logoImage),
          aspectRatio,
        },
      }),
      run: () =>
        createImageJob({
          ownerUserId: user.id,
          brand,
          trend,
          idea,
          productImages,
          logoImage,
          aspectRatio,
          metadata: {
            ...wechatPack,
            aspectRatio,
            visualDirection: wechatPack.visualDirection,
            style: wechatPack.style,
            composition: wechatPack.composition,
          },
        }),
    });
    if (!charged) return true;
    const job = charged.value;
    job.generationContext = {
      type: "wechat",
      channelLabel: "公众号长图",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(wechatLongImageMatch[3]),
      creditEventId: charged.creditEvent.id,
      aspectRatio,
    };
    console.log("[image-job] api created wechat job", {
      elapsedMs: Date.now() - requestStartedAt,
      jobId: job.id,
      userId: user.id,
    });
    upsertImageJob(user.id, job);
    console.log("[image-job] wechat credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: charged.user.credits,
      creditEventId: charged.creditEvent.id,
    });
    json(res, 200, {
      wechatPack: sanitizePayloadForClient(wechatPack),
      jobId: job.id,
      user: sanitizeUser(charged.user),
    });
    return true;
  }

  const xhsCarouselPreviewMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/preview$/);
  if (req.method === "POST" && xhsCarouselPreviewMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(xhsCarouselPreviewMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: xhsCarouselPreviewMatch[2], ideaIndex: xhsCarouselPreviewMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;
    const payload = await collectBody(req);
    const aspectRatio = requireAspectRatio(payload, "xhsCarousel", res, badRequest);
    if (!aspectRatio) return true;

    let carouselPack;
    try {
      carouselPack = buildXhsCarouselPackFromIdea(idea);
    } catch (error) {
      try {
        carouselPack = buildXhsCarouselPackFromIdea(await ensureIdeaAssetsForImage(brand, trend, Number(xhsCarouselPreviewMatch[3])));
      } catch (fillError) {
        contentAssetsUnavailable(res, fillError);
        return true;
      }
    }
    carouselPack = applyAspectRatioToCarouselPack(carouselPack, aspectRatio);
    json(res, 200, {
      carouselPack: sanitizePayloadForClient(carouselPack),
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
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(xhsCarouselMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: xhsCarouselMatch[2], ideaIndex: xhsCarouselMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;

    const payload = await collectBody(req);
    const aspectRatio = requireAspectRatio(payload, "xhsCarousel", res, badRequest);
    if (!aspectRatio) return true;
    const productImages = await resolveProductImageInputsSql(user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    console.log("[image-job] carousel request body collected", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      hasProductImage: productImages.length > 0,
      productImageCount: productImages.length,
    });
    let carouselPack;
    try {
      carouselPack = buildXhsCarouselPackFromIdea(idea);
    } catch (error) {
      try {
        carouselPack = buildXhsCarouselPackFromIdea(await ensureIdeaAssetsForImage(brand, trend, Number(xhsCarouselMatch[3])));
      } catch (fillError) {
        contentAssetsUnavailable(res, fillError);
        return true;
      }
    }
    carouselPack = applyAspectRatioToCarouselPack(carouselPack, aspectRatio);
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.xhsCarousel,
      event: buildSqlCreditEventInput({
        actionType: "xhsCarousel",
        actionLabel: "小红书组图生成",
        brand,
        trend,
        idea,
        channelLabel: "小红书组图",
        summary: carouselPack.publishTitle || idea.title,
        payload: {
          referenceImageUsed: productImages.length > 0,
          referenceImageCount: productImages.length,
          logoUsed: Boolean(logoImage),
          aspectRatio,
        },
      }),
      run: () =>
        Promise.all(
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
              ownerUserId: user.id,
              brand,
              trend,
              idea,
              productImages,
              logoImage,
              aspectRatio,
              metadata: {
                title: `${carouselPack.title} ${slide.pageLabel}`,
                visualDirection: slide.title,
                style: slide.style || "小红书组图封面页，清晰、真实、适合收藏",
                composition: `小红书组图${slideIndex + 1}/4，比例${aspectRatio}，标题清晰，画面有连续组图统一性`,
                aspectRatio,
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
              aspectRatio,
            };
            console.log("[image-job] api created carousel slide job", {
              elapsedMs: Date.now() - requestStartedAt,
              jobId: job.id,
              userId: user.id,
              slideIndex,
            });
            return { slideIndex, job };
          }),
        ),
    });
    if (!charged) return true;
    const slideJobRecords = charged.value;
    const slideJobs = slideJobRecords.map(({ slideIndex, job }) => ({
      slideIndex,
      jobId: job.id,
    }));
    for (const { job } of slideJobRecords) {
      upsertImageJob(user.id, job);
    }
    console.log("[image-job] carousel credits spent", {
      elapsedMs: Date.now() - requestStartedAt,
      userId: user.id,
      remainingCredits: charged.user.credits,
      creditEventId: charged.creditEvent.id,
      slideJobCount: slideJobs.length,
    });
    for (const slideJob of slideJobs) {
      const job = imageJobs.get(slideJob.jobId);
      if (job?.generationContext) {
        job.generationContext.creditEventId = charged.creditEvent.id;
        upsertImageJob(user.id, job);
      }
    }
    json(res, 200, {
      carouselPack: sanitizePayloadForClient(carouselPack),
      slideJobs,
      creditEventId: charged.creditEvent.id,
      user: sanitizeUser(charged.user),
    });
    return true;
  }

  const xhsCarouselSlideMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/slides\/(\d+)$/);
  if (req.method === "POST" && xhsCarouselSlideMatch) {
    const requestStartedAt = Date.now();
    const slideIndex = Number(xhsCarouselSlideMatch[4]);
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex > 3) {
      badRequest(res, "小红书组图页码无效。");
      return true;
    }

    const brand = findBrandByOwner(Number(xhsCarouselSlideMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const ideaIndex = Number(xhsCarouselSlideMatch[3]);
    const selected = requireIdea({ brand, trendId: xhsCarouselSlideMatch[2], ideaIndex, res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;

    const payload = await collectBody(req);
    const incomingPack = payload.carouselPack && typeof payload.carouselPack === "object" ? payload.carouselPack : {};
    const aspectRatio = requireAspectRatio({ aspectRatio: payload.aspectRatio || incomingPack.aspectRatio }, "xhsCarousel", res, badRequest);
    if (!aspectRatio) return true;
    const incomingSlides = Array.isArray(incomingPack.slides) ? incomingPack.slides : [];
    let defaultPack = null;
    if (!incomingSlides[slideIndex]?.prompt && !payload.slide?.prompt) {
      try {
        defaultPack = buildXhsCarouselPackFromIdea(idea);
      } catch (error) {
        try {
          defaultPack = buildXhsCarouselPackFromIdea(await ensureIdeaAssetsForImage(brand, trend, ideaIndex));
        } catch (fillError) {
          contentAssetsUnavailable(res, fillError);
          return true;
        }
      }
    }
    defaultPack = applyAspectRatioToCarouselPack(
      defaultPack || { title: "", publishTitle: "", publishCaption: "", caption: "", slides: [] },
      aspectRatio,
    );
    const slide = normalizeXhsCarouselSlideForJob(payload.slide || incomingSlides[slideIndex], defaultPack.slides[slideIndex], slideIndex);
    if (!slide.prompt) {
      badRequest(res, "当前页缺少服务端生图提示词，请重新生成组图方案后再试。");
      return true;
    }

    const productImages = await resolveProductImageInputsSql(user, payload.productImages || payload.productImage);
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;

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
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.xhsCarouselSlide,
      event: buildSqlCreditEventInput({
        actionType: "xhsCarousel",
        actionLabel: "小红书组图单张生成",
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
          aspectRatio,
        },
      }),
      run: () =>
        createImageJob({
          ownerUserId: user.id,
          brand,
          trend,
          idea,
          productImages,
          logoImage,
          aspectRatio,
          metadata: {
            title: `${incomingPack.title || defaultPack.title} ${slide.pageLabel}`,
            visualDirection: slide.visualDirection,
            style: slide.style,
            composition: slide.composition,
            prompt: slide.prompt,
            slideIndex,
            pageLabel: slide.pageLabel,
            copy: slide.copy,
            aspectRatio,
          },
        }),
    });
    if (!charged) return true;
    const job = charged.value;
    job.generationContext = {
      type: "xhsCarouselSlide",
      singleSlideOnly: true,
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      slideIndex,
      carouselTitle: incomingPack.title || defaultPack.title || "",
      publishTitle: incomingPack.publishTitle || defaultPack.publishTitle || "",
      publishCaption: incomingPack.publishCaption || defaultPack.publishCaption || "",
      caption: incomingPack.caption || defaultPack.caption || "",
      carouselGroupId: normalizeCarouselGroupId(incomingPack.carouselGroupId),
      creditEventId: charged.creditEvent.id,
      aspectRatio,
    };
    upsertImageJob(user.id, job);
    json(res, 202, {
      slideJob: {
        slideIndex,
        jobId: job.id,
      },
      creditEventId: charged.creditEvent.id,
      user: sanitizeUser(charged.user),
    });
    return true;
  }

  const xhsCarouselCompleteMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/xhs-carousel\/complete$/);
  if (req.method === "POST" && xhsCarouselCompleteMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(xhsCarouselCompleteMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: xhsCarouselCompleteMatch[2], ideaIndex: xhsCarouselCompleteMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;

    const payload = await collectBody(req);
    let carouselPack = payload.carouselPack || {};
    const aspectRatio = requireAspectRatio(carouselPack, "xhsCarousel", res, badRequest);
    if (!aspectRatio) return true;
    carouselPack = applyAspectRatioToCarouselPack(carouselPack, aspectRatio);
    if (!isValidCompletedCarouselPack(carouselPack)) {
      badRequest(res, "小红书组图必须等待 4 张真实图片全部生成完成后才能写入历史。");
      return true;
    }

    const existingGenerationId = findGenerationIdForCreditEvent(Number(payload.creditEventId), user.id);
    const existingGeneration =
      (existingGenerationId ? findGenerationByOwner(existingGenerationId, user.id) : null) ||
      findXhsCarouselGenerationByGroup(user.id, carouselPack.carouselGroupId);
    if (existingGeneration) {
      const nextPayload = mergeXhsCarouselSlidePayload(existingGeneration.payload || {}, {
        ...carouselPack,
        generatedMode: "group",
        carouselGroupId: normalizeCarouselGroupId(carouselPack.carouselGroupId || existingGeneration.payload?.carouselGroupId),
      });
      const nextGeneration = {
        ...existingGeneration,
        cardTitle: nextPayload.title || existingGeneration.cardTitle,
        previewUrl: nextPayload.slides.find(isGeneratedCarouselSlide)?.previewUrl || existingGeneration.previewUrl || "",
        summary: nextPayload.publishCaption || nextPayload.caption || existingGeneration.summary || "",
        payload: nextPayload,
      };
      await persistGenerationImages(nextGeneration);
      const savedGeneration = upsertGeneration(nextGeneration);
      updateCreditEventGeneration(Number(payload.creditEventId), savedGeneration, savedGeneration.payload);
      json(res, 200, {
        generation: sanitizeGeneration(savedGeneration, appConfig),
        creditEventId: Number(payload.creditEventId) || null,
        user: sanitizeUser(user),
      });
      return true;
    }

    const generation = createSqlGenerationRecord(user.id, brand, trend, idea, "xhsCarousel", "小红书组图", carouselPack);
    await persistGenerationImages(generation);
    insertGeneration(generation);
    const creditEvent =
      updateCreditEventGeneration(Number(payload.creditEventId), generation, carouselPack) ||
      attachGenerationToLatestCreditEvent({
        user,
        actionType: "xhsCarousel",
        brand,
        trend,
        idea,
        generation,
        generationPayload: carouselPack,
      });
    json(res, 200, {
      generation: sanitizeGeneration(generation, appConfig),
      creditEventId: creditEvent?.id || null,
      user: sanitizeUser(user),
    });
    return true;
  }

  const styleImageMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)\/style-image$/);
  if (req.method === "POST" && styleImageMatch) {
    const user = requireRouteUser(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(styleImageMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const selected = requireIdea({ brand, trendId: styleImageMatch[2], ideaIndex: styleImageMatch[3], res, badRequest, findTrendItem });
    if (!selected) return true;
    const { trend, idea } = selected;
    const payload = await collectBody(req);
    const aspectRatio = requireAspectRatio(payload, "styleImage", res, badRequest);
    if (!aspectRatio) return true;
    const stylePrompt = String(payload.stylePrompt || payload.prompt || "").trim();
    if (!stylePrompt) {
      badRequest(res, "请先填写风格化图提示词。");
      return true;
    }
    const styleReferenceImages = await resolveProductImageInputsSql(user, payload.styleReferenceImages || payload.styleReferenceImage, {
      maxCount: 1,
      maxTotalBytes: MAX_PRODUCT_IMAGE_BYTES,
      label: "风格参考图",
    });
    const logoImage = payload.useBrandLogo ? await resolveBrandLogoImage(brand) : null;
    const metadata = {
      title: String(payload.title || "风格化图片").slice(0, 120),
      visualDirection: "按独立提示词生成风格化图片",
      style: "stylized poster",
      composition: "根据提示词生成适合公众号封面、节日祝福海报或运营视觉的完整画面",
      prompt: `${stylePrompt}\n\n生成一张完整的风格化运营图片，可用于公众号封面、节日祝福海报或品牌日常内容视觉。画面需要完整、干净、有设计感，避免杂乱文字。`,
      stylePrompt,
      aspectRatio,
    };
    const charged = await runChargedAiWork({
      user,
      cost: CREDIT_COSTS.styleImage,
      event: buildSqlCreditEventInput({
        actionType: "styleImage",
        actionLabel: "风格化图生成",
        brand,
        trend,
        idea,
        channelLabel: "风格化图",
        summary: stylePrompt.slice(0, 80),
        payload: {
          styleReferenceImageUsed: styleReferenceImages.length > 0,
          styleReferenceImageCount: styleReferenceImages.length,
          logoUsed: Boolean(logoImage),
          aspectRatio,
        },
      }),
      run: () =>
        createImageJob({
          ownerUserId: user.id,
          brand,
          trend,
          idea,
          metadata,
          logoImage,
          styleReferenceImages,
          aspectRatio,
        }),
    });
    if (!charged) return true;
    const job = charged.value;
    job.generationContext = {
      type: "styleImage",
      channelLabel: "风格化图",
      userId: user.id,
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex: Number(styleImageMatch[3]),
      creditEventId: charged.creditEvent.id,
      aspectRatio,
    };
    upsertImageJob(user.id, job);
    json(res, 202, { ...buildSignedImageJobResponse(appConfig, buildImageJobResponse, job), user: sanitizeUser(charged.user) });
    return true;
  }

  return false;
}

module.exports = {
  isGeneratedCarouselSlide,
  mergeXhsCarouselSlidePayload,
  handleImageGenerationRoutes,
};
