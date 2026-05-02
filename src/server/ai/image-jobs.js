const { randomId, assertConfigured, withRetries, normalizeChineseCopy, pickVariant } = require("../utils");
const { fetchJson } = require("./text-provider");

const IMAGE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_JOB_HTTP_TIMEOUT_MS = 5 * 60 * 1000;

function buildImageConceptMetadata({ brand, trend, idea }) {
  const seed = `${brand.name}|${trend.title}|${idea.title}|${idea.angle || ""}`;
  const captionTemplate = pickVariant(seed, [
    () => `早上的时间总是不够用，但还是想把自己照顾好一点。今天从一杯${brand.name}开始，慢慢把状态找回来。`,
    () => `忙起来以后才发现，真正让人安心的不是多做了多少事，而是那些稳定的小习惯：好好吃早餐，好好喝一杯牛奶，好好开始一天。`,
    () => `把早餐留给自己，把匆忙留在门外。${brand.name}刚好适合这样的早晨，简单一点，也认真一点。`,
    () => `今天的精致感，不靠复杂准备。坐下来喝完这一杯，再去面对满满当当的一天。`,
  ]);
  const visualTemplate = pickVariant(`${seed}|visual`, [
    () => `${brand.name}朋友圈生活方式分享图`,
    () => `围绕“${idea.title}”的朋友圈日常场景图`,
    () => `${trend.title}话题下的自然分享视觉`,
    () => `${brand.name}轻种草朋友圈配图`,
  ]);

  return {
    title: normalizeChineseCopy(`${brand.name} 朋友圈图`),
    caption: normalizeChineseCopy(captionTemplate()),
    visualDirection: normalizeChineseCopy(visualTemplate()),
    style: String(brand.industry || "").toLowerCase().includes("beauty") ? "clean lifestyle snapshot" : "natural lifestyle social post",
    composition: "朋友圈配图构图，画面像真实生活分享或轻度品牌种草，不做强海报排版，主体自然入镜，留白适中",
    prompt: normalizeChineseCopy(`为品牌${brand.name}生成一张适合微信朋友圈发布的配图，围绕“${idea.title}”这个内容选题，结合话题“${trend.title}”。画面要像真实朋友圈里的生活方式分享图，而不是小红书封面、广告海报或电商详情图。请把${idea.brandFit}融入一个${idea.audience}容易共鸣的日常场景中，整体自然、松弛、有真实感，有轻微品牌质感但不要过度营销。风格可参考${(brand.assetTags || []).join("、") || "品牌调性"}，画面干净、有生活温度，适合搭配一段朋友圈文案发布。不要堆砌大标题、夸张促销文字或复杂信息模块。参考品牌资料：${brand.knowledgeBase || "暂无额外资料"}。`),
  };
}

function extractWavespeedOutput(payload) {
  const outputs = payload?.data?.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  if (typeof first === "string") return first;
  return first?.image || first?.url || first?.image_url || null;
}

function truncateLogValue(value, maxLength = 800) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeWavespeedError(payload) {
  const value = payload?.data?.error || payload?.error || "";
  if (!value) return "";
  return typeof value === "string" ? value : truncateLogValue(value, 1000);
}

function summarizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    return truncateLogValue(value, 200);
  }
}

function summarizeWavespeedPayload(payload) {
  const data = payload?.data || {};
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  return {
    upstreamId: data.id || "",
    status: data.status || "",
    error: normalizeWavespeedError(payload),
    outputCount: outputs.length,
    hasGetResultUrl: Boolean(data.urls?.get || data.get_result_url),
    timings: data.timings || null,
    createdAt: data.created_at || data.createdAt || "",
    updatedAt: data.updated_at || data.updatedAt || "",
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
  };
}

function buildImageJobLogContext(job) {
  return {
    jobId: job.id,
    status: job.status,
    providerMode: job.providerMode,
    ageMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    remainingMs: Math.max(0, IMAGE_JOB_TIMEOUT_MS - (Date.now() - job.createdAt)),
    hasResultUrl: Boolean(job.providerResultUrl),
    resultUrl: summarizeUrl(job.providerResultUrl),
    referenceImageUsed: Boolean(job.metadata?.referenceImageUsed),
    generationContext: job.generationContext || null,
  };
}

async function fetchWavespeedResultOnce(getUrl, headers) {
  const payload = await withRetries(() => fetchJson(getUrl, { headers, timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS }), {
    retries: 2,
    delayMs: 1500,
  });
  return {
    payload,
    imageUrl: extractWavespeedOutput(payload),
    status: payload?.data?.status || "",
    error: normalizeWavespeedError(payload),
    summary: summarizeWavespeedPayload(payload),
  };
}

async function createImageJob(
  appConfig,
  imageJobs,
  {
    brand,
    trend,
    idea,
    metadata: providedMetadata,
    productImage,
    productImages,
    logoImage,
    styleReferenceImages,
    sourceImageUrls,
    sourceImages,
    aspectRatio,
  },
) {
  const provider = appConfig.imageProvider;
  assertConfigured(provider.apiKey, "图片模型 API Key");
  const referenceImages = normalizeImageInputs(productImages || productImage);
  const logoImages = normalizeImageInputs(logoImage);
  const styleImages = normalizeImageInputs(styleReferenceImages);
  const localSourceImages = normalizeImageInputs(sourceImages);
  const sourceUrls = normalizeSourceImageUrls(sourceImageUrls);
  const useReferenceImages = referenceImages.length > 0 || logoImages.length > 0 || styleImages.length > 0;
  const metadata = withImageReferencePrompt(providedMetadata || buildImageConceptMetadata({ brand, trend, idea }), {
    productImages: referenceImages,
    logoImages,
    styleImages,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  const uploadedProductUrls = referenceImages.length ? await Promise.all(referenceImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedLogoUrls = logoImages.length ? await Promise.all(logoImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedStyleUrls = styleImages.length ? await Promise.all(styleImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedSourceUrls = localSourceImages.length ? await Promise.all(localSourceImages.map((image) => uploadProductImage(provider, image))) : [];
  const uploadedImageUrls = [...uploadedProductUrls, ...uploadedLogoUrls, ...uploadedStyleUrls];
  const editImageUrls = [...sourceUrls, ...uploadedSourceUrls, ...uploadedImageUrls];
  const useEditModel = editImageUrls.length > 0;
  const endpoint = useEditModel ? provider.editBaseUrl || provider.baseUrl : provider.baseUrl;
  const outputAspectRatio = aspectRatio || metadata.aspectRatio || provider.aspectRatio;
  const body = {
    prompt: metadata.prompt,
    aspect_ratio: outputAspectRatio,
    resolution: provider.resolution,
    quality: provider.quality,
    enable_sync_mode: false,
    enable_base64_output: false,
    ...(useEditModel ? { images: editImageUrls } : {}),
  };

  console.log("[image-job] creating upstream task", {
    brandId: brand?.id,
    trendId: trend?.id,
    ideaTitle: idea?.title || "",
    providerMode: useEditModel ? "edit" : "text-to-image",
    endpoint: summarizeUrl(endpoint),
    aspectRatio: outputAspectRatio,
    resultResolution: provider.resolution,
    resultQuality: provider.quality,
    hasReferenceImage: useReferenceImages,
    referenceImageCount: referenceImages.length,
    referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
    logoImageCount: logoImages.length,
    styleReferenceImageCount: styleImages.length,
    sourceImageCount: sourceUrls.length + localSourceImages.length,
    uploadedReferenceUrls: uploadedImageUrls.map(summarizeUrl),
    uploadedSourceUrls: uploadedSourceUrls.map(summarizeUrl),
    promptLength: String(metadata.prompt || "").length,
    promptPreview: truncateLogValue(metadata.prompt || "", 300),
    bodyImageCount: editImageUrls.length,
  });

  let initial = null;
  try {
    initial = await withRetries(
      () =>
        fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeoutMs: IMAGE_JOB_HTTP_TIMEOUT_MS,
        }),
      { retries: 3, delayMs: 2000 },
    );
  } catch (error) {
    console.error("[image-job] upstream task create failed", {
      brandId: brand?.id,
      trendId: trend?.id,
      ideaTitle: idea?.title || "",
      providerMode: useEditModel ? "edit" : "text-to-image",
      endpoint: summarizeUrl(endpoint),
      statusCode: error?.statusCode || null,
      message: error?.message || "unknown error",
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    throw error;
  }

  const resultUrl = initial?.data?.urls?.get || initial?.data?.get_result_url;
  const imageUrl = extractWavespeedOutput(initial);
  console.log("[image-job] upstream task accepted", {
    ...summarizeWavespeedPayload(initial),
    resultUrl: summarizeUrl(resultUrl),
    hasDirectImageUrl: Boolean(imageUrl),
  });
  const job = {
    id: randomId(),
    status: imageUrl ? "completed" : "pending",
    createdAt: Date.now(),
    provider: "wavespeed",
    providerMode: useEditModel ? "edit" : "text-to-image",
    providerResultUrl: resultUrl || "",
    providerHeaders: headers,
    model: provider.model,
    metadata: {
      ...metadata,
      aspectRatio: outputAspectRatio,
      sourceImageUrls: [...sourceUrls, ...uploadedSourceUrls],
      referenceImageName: referenceImages[0]?.name || "",
      referenceImageNames: referenceImages.map((image) => image.name || "").filter(Boolean),
      referenceImageUrl: uploadedImageUrls[0] || "",
      referenceImageUrls: uploadedProductUrls,
      logoImageUrls: uploadedLogoUrls,
      styleReferenceImageUrls: uploadedStyleUrls,
      referenceImageCount: referenceImages.length,
      referenceImageUsed: useReferenceImages,
      logoImageUsed: logoImages.length > 0,
      styleReferenceImageUsed: styleImages.length > 0,
    },
    imageUrl: imageUrl || "",
    error: "",
  };

  if (!job.imageUrl && !job.providerResultUrl) {
    throw new Error("图片服务未返回可轮询的任务地址。");
  }

  imageJobs.set(job.id, job);
  return job;
}

function normalizeImageInputs(input) {
  const images = Array.isArray(input) ? input : input ? [input] : [];
  return images
    .filter((image) => image?.dataUrl)
    .map((image) => ({
      ...image,
      name: String(image.name || image.fileName || "product-image.png"),
      dataUrl: String(image.dataUrl || ""),
    }))
    .slice(0, 8);
}

function normalizeSourceImageUrls(input) {
  const urls = Array.isArray(input) ? input : input ? [input] : [];
  return urls.map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).slice(0, 8);
}

async function uploadProductImage(provider, productImage) {
  if (!provider.uploadBaseUrl) {
    throw new Error("图片编辑需要先配置 IMAGE_UPLOAD_BASE_URL。");
  }

  const parsed = parseDataUrl(productImage.dataUrl);
  const fileName = productImage.name || "product-image.png";

  console.log("[image-job] uploading reference image", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    fileName,
    mimeType: parsed.mimeType,
    bytes: parsed.buffer.length,
  });

  const response = await withRetries(
    () => {
      const formData = new FormData();
      formData.append("file", new Blob([parsed.buffer], { type: parsed.mimeType }), fileName);
      return (
      fetch(provider.uploadBaseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      })
      );
    },
    { retries: 3, delayMs: 1500 },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[image-job] reference image upload failed", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      statusText: response.statusText,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error(payload?.error?.message || payload?.error || payload?.message || `产品图上传失败：HTTP ${response.status}`);
  }

  const url = payload?.data?.download_url || payload?.data?.url || payload?.download_url || payload?.url || "";
  if (!url) {
    console.error("[image-job] reference image upload missing url", {
      uploadUrl: summarizeUrl(provider.uploadBaseUrl),
      status: response.status,
      responseSummary: truncateLogValue(payload, 1500),
    });
    throw new Error("产品图上传成功但未返回可用于生图的图片 URL。");
  }
  console.log("[image-job] reference image uploaded", {
    uploadUrl: summarizeUrl(provider.uploadBaseUrl),
    imageUrl: summarizeUrl(url),
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    dataKeys: payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : [],
  });
  return url;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("产品图格式无效，请重新上传图片。");
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function withImageReferencePrompt(metadata, { productImages, logoImages, styleImages }) {
  const productCount = Array.isArray(productImages) ? productImages.length : 0;
  const logoCount = Array.isArray(logoImages) ? logoImages.length : 0;
  const styleCount = Array.isArray(styleImages) ? styleImages.length : 0;
  if (!productCount && !logoCount && !styleCount) return metadata;
  const hints = [];
  if (productCount) {
    hints.push(
      productCount === 1
        ? "请参考输入图片中的产品外观、材质、包装、颜色和品牌识别元素，把该产品自然融入画面；不要改变产品核心造型，不要生成与参考产品冲突的包装。"
        : `请参考输入的 ${productCount} 张产品图，把这些图片中的物品作为画面主体或主体组合；保留各产品的核心造型、材质、包装、颜色和品牌识别元素，不要混淆不同产品，不要生成与参考产品冲突的包装。`,
    );
  }
  if (logoCount) {
    hints.push("请把输入的品牌 Logo 作为产品/品牌标识使用，保持 Logo 文字和图形清晰、比例正确；不要把 Logo 当成独立产品主体，也不要改写 Logo。");
  }
  if (styleCount) {
    hints.push("请参考输入的风格图来借鉴色调、光影、版式、材质和整体氛围，但不要直接复制风格图里的具体物体或文字。");
  }
  return {
    ...metadata,
    prompt: `${metadata.prompt}\n\n${hints.join("\n")}`,
  };
}

async function resolveImageJob(appConfig, imageJobs, job) {
  if (job.status === "completed" || job.status === "failed") {
    return job;
  }

  try {
    const polled = await fetchWavespeedResultOnce(job.providerResultUrl, getImageJobProviderHeaders(appConfig, job));
    console.log("[image-job] polled upstream result", {
      ...buildImageJobLogContext(job),
      upstreamStatus: polled.status || "",
      hasImageUrl: Boolean(polled.imageUrl),
      upstreamError: polled.error || "",
      upstreamSummary: polled.summary,
    });
    if (polled.imageUrl) {
      job.status = "completed";
      job.imageUrl = polled.imageUrl;
      console.log("[image-job] completed", {
        ...buildImageJobLogContext(job),
        imageUrl: summarizeUrl(job.imageUrl),
      });
    } else if (polled.status === "failed" || polled.error) {
      job.status = "failed";
      job.error = polled.error || "图片生成失败";
      console.error("[image-job] upstream marked failed", {
        ...buildImageJobLogContext(job),
        error: job.error,
        upstreamSummary: polled.summary,
        upstreamPayload: truncateLogValue(polled.payload, 2000),
      });
    } else if (Date.now() - job.createdAt > IMAGE_JOB_TIMEOUT_MS) {
      job.status = "failed";
      job.error = "图片生成超时，请稍后重试。";
      console.error("[image-job] timed out", {
        ...buildImageJobLogContext(job),
        upstreamSummary: polled.summary,
      });
    } else {
      job.status = "pending";
    }
  } catch (error) {
    console.error("[image-job] polling error", {
      ...buildImageJobLogContext(job),
      message: error?.message || "unknown error",
      statusCode: error?.statusCode || null,
      responseBody: truncateLogValue(error?.rawBody || error?.payload || "", 1500),
    });
    if (Date.now() - job.createdAt > IMAGE_JOB_TIMEOUT_MS) {
      job.status = "failed";
      job.error = error.message || "图片生成失败";
    } else {
      job.status = "pending";
    }
  }

  imageJobs.set(job.id, job);
  return job;
}

function buildImageJobResponse(job) {
  return {
    jobId: job.id,
    status: job.status,
    elapsedMs: Date.now() - job.createdAt,
    timeoutMs: IMAGE_JOB_TIMEOUT_MS,
    imageConcept:
      job.status === "completed"
        ? {
            ...job.metadata,
            previewUrl: job.imageUrl,
            imageUrl: job.imageUrl,
            provider: job.provider,
            model: job.model,
          }
        : null,
    error: job.error || "",
  };
}

function getImageJobProviderHeaders(appConfig, job) {
  if (job.providerHeaders?.Authorization) return job.providerHeaders;
  assertConfigured(appConfig.imageProvider.apiKey, "图片模型 API Key");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${appConfig.imageProvider.apiKey}`,
  };
}

module.exports = {
  IMAGE_JOB_TIMEOUT_MS,
  IMAGE_JOB_HTTP_TIMEOUT_MS,
  buildImageConceptMetadata,
  createImageJob,
  resolveImageJob,
  buildImageJobResponse,
  getImageJobProviderHeaders,
};
