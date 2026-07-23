const { normalizeChineseCopy } = require("../utils");

const XHS_CAROUSEL_SLIDE_COUNT = 4;

function getText(source, key, maxLength) {
  return normalizeChineseCopy(String(source?.[key] || "").trim()).slice(0, maxLength);
}

function getRequiredText(source, key, label, maxLength) {
  const text = getText(source, key, maxLength);
  if (!text) {
    throw new Error(`AI 内容生成结果缺少 ${label}。`);
  }
  return text;
}

function compactJoin(parts) {
  return parts.map((part) => normalizeChineseCopy(part)).filter(Boolean).join("；");
}

function buildMomentsPrompt({ title, caption, visualDirection, style, composition }) {
  return compactJoin([
    `生成朋友圈配图，主题是“${title}”`,
    caption ? `发布文案围绕：${caption}` : "",
    visualDirection ? `视觉方向：${visualDirection}` : "",
    style ? `风格：${style}` : "",
    composition ? `构图：${composition}` : "",
    "画面真实、干净、有品牌相关性，避免硬广海报感",
  ]);
}

function buildXhsSlidePrompt({ packTitle, publishTitle, slide }) {
  return compactJoin([
    `生成小红书 4 页组图中的${slide.pageLabel || "当前页"}`,
    packTitle ? `组图主题：${packTitle}` : "",
    publishTitle ? `发布标题：${publishTitle}` : "",
    slide.title ? `本页标题：${slide.title}` : "",
    slide.copy ? `本页画面文案：${slide.copy}` : "",
    slide.visualDirection ? `视觉方向：${slide.visualDirection}` : "",
    slide.style ? `风格：${slide.style}` : "",
    slide.composition ? `构图：${slide.composition}` : "",
    "竖版 3:4，信息层级清楚，适合小红书滑动阅读，避免英文文字和广告海报感",
  ]);
}

function buildWechatLongImagePrompt({ publishTitle, intro, outline, visualDirection, style, composition }) {
  return compactJoin([
    `生成公众号长图，标题是“${publishTitle}”`,
    intro ? `导语：${intro}` : "",
    Array.isArray(outline) && outline.length ? `内容结构：${outline.join(" / ")}` : "",
    visualDirection ? `视觉方向：${visualDirection}` : "",
    style ? `风格：${style}` : "",
    composition ? `构图：${composition}` : "",
    "9:16 竖版长图，中文信息层级清楚，文字密度适中，避免夸大承诺和硬广感",
  ]);
}

function normalizeGeneratedXhsCarouselPack(raw) {
  const source = raw?.carouselPack && typeof raw.carouselPack === "object" ? raw.carouselPack : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const rawSlides = Array.isArray(source.slides) ? source.slides : [];
  if (rawSlides.length !== XHS_CAROUSEL_SLIDE_COUNT) {
    throw new Error(`AI 内容生成结果必须包含 ${XHS_CAROUSEL_SLIDE_COUNT} 页组图。`);
  }
  const publishCaption = getRequiredText(source, "publishCaption", "发布文案", 900);
  const pack = {
    title: getRequiredText(source, "title", "组图方案标题", 120),
    publishTitle: getRequiredText(source, "publishTitle", "发布标题", 120),
    publishCaption,
    caption: getText(source, "caption", 500) || publishCaption,
    aspectRatio: getText(source, "aspectRatio", 16) || "3:4",
    slides: rawSlides.map((slide, index) => {
      const remixBrief = normalizeRemixBrief(slide?.remixBrief || source.remixBrief);
      const sourceLearningApplied = Array.isArray(slide?.sourceLearningApplied)
        ? slide.sourceLearningApplied
            .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 80))
            .filter(Boolean)
            .slice(0, 6)
        : [];
      const normalizedSlide = {
        pageLabel: getText(slide, "pageLabel", 24) || `第 ${index + 1} 张`,
        pageRole: getText(slide, "pageRole", 80),
        title: getRequiredText(slide, "title", `第 ${index + 1} 页标题`, 120),
        copy: getRequiredText(slide, "copy", `第 ${index + 1} 页文案`, 500),
        contentGoal: getText(slide, "contentGoal", 200),
        visualDirection: getRequiredText(slide, "visualDirection", `第 ${index + 1} 页视觉方向`, 300),
        style: getText(slide, "style", 160) || "小红书组图封面页，清晰、真实、适合收藏",
        composition: getText(slide, "composition", 500) || "竖版信息图，标题清楚，留白充足，画面有连续组图统一性。",
        prompt: getText(slide, "prompt", 1800),
        aspectRatio: getText(slide, "aspectRatio", 16) || getText(source, "aspectRatio", 16) || "3:4",
        sourceLearningApplied,
        previewUrl: "",
      };
      if (remixBrief) {
        normalizedSlide.remixBrief = remixBrief;
      }
      return normalizedSlide;
    }),
  };
  const packRemixBrief = normalizeRemixBrief(source.remixBrief);
  if (packRemixBrief) {
    pack.remixBrief = packRemixBrief;
  }
  const sourceTemplate = normalizeSourceTemplate(source.sourceTemplate);
  if (sourceTemplate) {
    pack.sourceTemplate = sourceTemplate;
  }
  pack.slides = pack.slides.map((slide) => ({
    ...slide,
    prompt: slide.prompt || buildXhsSlidePrompt({ packTitle: pack.title, publishTitle: pack.publishTitle, slide }),
  }));
  return pack;
}

function compactRemixText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeNonNegNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(max, Math.floor(num));
}

function normalizeExcellentBoardValue(value) {
  const board = compactRemixText(value, 40);
  if (board === "xhs_hot" || board === "ecommerce_hot") return board;
  return "";
}

function normalizeContentModeValue(value) {
  const mode = compactRemixText(value, 40);
  if (mode === "smart" || mode === "existing_idea" || mode === "custom") return mode;
  return "";
}

function normalizeRemixBrief(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const learningFocus = Array.isArray(raw.learningFocus)
    ? raw.learningFocus.map((item) => compactRemixText(item, 40)).filter(Boolean).slice(0, 8)
    : [];
  const sourceLearningApplied = Array.isArray(raw.sourceLearningApplied)
    ? raw.sourceLearningApplied.map((item) => compactRemixText(item, 80)).filter(Boolean).slice(0, 6)
    : [];
  const brief = {
    sourceType: compactRemixText(raw.sourceType, 40) || "excellent_content",
    sourceNoteId: compactRemixText(raw.sourceNoteId, 80),
    sourceTitle: compactRemixText(raw.sourceTitle, 120),
    sourceBoard: normalizeExcellentBoardValue(raw.sourceBoard),
    sourceCategoryPath: compactRemixText(raw.sourceCategoryPath, 180),
    sourceIndustryPath: compactRemixText(raw.sourceIndustryPath, 180),
    sourceImageCount: normalizeNonNegNumber(raw.sourceImageCount, 99),
    sourceReadCount: normalizeNonNegNumber(raw.sourceReadCount, 1e12),
    sourceEngagementCount: normalizeNonNegNumber(raw.sourceEngagementCount, 1e12),
    contentMode: normalizeContentModeValue(raw.contentMode),
    contentDirection: compactRemixText(raw.contentDirection, 200),
    targetAudience: compactRemixText(raw.targetAudience, 80),
    userScene: compactRemixText(raw.userScene, 120),
    trendUsed: Boolean(raw.trendUsed),
    trendTitle: compactRemixText(raw.trendTitle, 120),
    learningFocus,
    pageRole: compactRemixText(raw.pageRole, 80),
    pageTask: compactRemixText(raw.pageTask, 200),
    pageTitle: compactRemixText(raw.pageTitle, 120),
    pageCopy: compactRemixText(raw.pageCopy, 300),
    contentGoal: compactRemixText(raw.contentGoal, 200),
    sourceLearningApplied,
    originalityGuard: compactRemixText(raw.originalityGuard, 400),
  };
  // Never allow sourceUrl, cookies, tokens, image URLs, or arbitrary secrets into prompt metadata.
  delete brief.sourceUrl;
  delete brief.cookie;
  delete brief.token;
  delete brief.authorization;
  delete brief.imageUrls;
  delete brief.sourceImageUrls;
  return brief;
}

function normalizeSourceTemplate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const noteId = compactRemixText(raw.noteId || raw.sourceNoteId, 80);
  const board = normalizeExcellentBoardValue(raw.board || raw.source);
  return {
    noteId,
    title: compactRemixText(raw.title, 120),
    // sourceUrl stays in business payload only; Image Prompt Engine must not use it.
    sourceUrl: compactRemixText(raw.sourceUrl || raw.noteUrl, 300),
    source: board || compactRemixText(raw.source, 40) || "xhs_hot",
    board,
    contentSource: compactRemixText(raw.contentSource, 40),
  };
}

function normalizeGeneratedImageConceptMetadata(raw) {
  const source = raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const metadata = {
    title: getRequiredText(source, "title", "标题", 120),
    caption: getRequiredText(source, "caption", "朋友圈文案", 900),
    visualDirection: getRequiredText(source, "visualDirection", "视觉方向", 300),
    style: getText(source, "style", 160) || "真实、清晰、克制、有社交媒体质感",
    composition: getText(source, "composition", 500) || "主体明确，信息留白充足，品牌露出自然。",
    prompt: getText(source, "prompt", 1800),
  };
  metadata.prompt = metadata.prompt || buildMomentsPrompt(metadata);
  return metadata;
}

function normalizeGeneratedWechatLongImagePack(raw) {
  const source = raw?.wechatPack && typeof raw.wechatPack === "object" ? raw.wechatPack : raw;
  if (!source || typeof source !== "object") {
    throw new Error("AI 内容生成结果不是有效对象。");
  }
  const intro = getRequiredText(source, "intro", "文章导语", 700);
  const positioning = getRequiredText(source, "positioning", "长图定位", 500);
  const cta = getRequiredText(source, "cta", "CTA", 260);
  const outline = (Array.isArray(source.outline)
    ? source.outline.map((item) => normalizeChineseCopy(String(item || "").trim()).slice(0, 220)).filter(Boolean)
    : [])
    .slice(0, 5);
  for (const fallback of [positioning, cta, intro]) {
    if (outline.length >= 3) break;
    const item = normalizeChineseCopy(fallback).slice(0, 220);
    if (item && !outline.includes(item)) outline.push(item);
  }
  if (outline.length < 3) {
    throw new Error("AI 内容生成结果必须包含 3 到 5 条公众号长图大纲。");
  }
  const pack = {
    title: getRequiredText(source, "title", "公众号长图方案标题", 120),
    publishTitle: getRequiredText(source, "publishTitle", "发布标题", 120),
    intro,
    outline,
    positioning,
    cta,
    visualDirection: getRequiredText(source, "visualDirection", "视觉方向", 300),
    style: getText(source, "style", 160) || "专业、清晰、克制、可信",
    composition: getText(source, "composition", 600) || "9:16 竖版长图，顶部标题区，中段信息摘要区，底部轻 CTA 区。",
    prompt: getText(source, "prompt", 2200),
    previewUrl: "",
  };
  pack.prompt = pack.prompt || buildWechatLongImagePrompt(pack);
  return pack;
}

function readContentAssets(source) {
  if (!source || typeof source !== "object") return {};
  const assets =
    source.contentAssets ||
    source.content_assets ||
    source.assetPack ||
    source.asset_pack ||
    source.contentPack ||
    source.content_pack ||
    {};
  return assets && typeof assets === "object" && !Array.isArray(assets) ? assets : {};
}

function normalizeIdeaContentAssets(raw) {
  const assets = readContentAssets(raw);
  const normalized = {};
  const moments = assets.moments || assets.momentsImage || assets.moments_image || assets.socialImage || assets.social_image;
  const xhsCarousel = assets.xhsCarousel || assets.xhs_carousel || assets.carousel || assets.xhs;
  const wechatLongImage =
    assets.wechatLongImage || assets.wechat_long_image || assets.wechat || assets.officialAccountLongImage || assets.official_account_long_image;

  if (moments && typeof moments === "object") {
    normalized.moments = normalizeGeneratedImageConceptMetadata(moments);
  }
  if (xhsCarousel && typeof xhsCarousel === "object") {
    normalized.xhsCarousel = normalizeGeneratedXhsCarouselPack(xhsCarousel);
  }
  if (wechatLongImage && typeof wechatLongImage === "object") {
    normalized.wechatLongImage = normalizeGeneratedWechatLongImagePack(wechatLongImage);
  }
  return normalized;
}

function hasCompleteIdeaContentAssets(idea) {
  const assets = normalizeIdeaContentAssets(idea);
  return Boolean(assets.moments && assets.xhsCarousel && assets.wechatLongImage);
}

function requireIdeaContentAssets(idea, assetKey, label) {
  const assets = normalizeIdeaContentAssets(idea);
  const asset = assets[assetKey];
  if (!asset) {
    throw new Error(`当前选题缺少趋势分析时生成的${label}内容资产，请先重新生成趋势分析或重新生成选题。`);
  }
  return asset;
}

function buildImageConceptMetadataFromIdea(idea) {
  return requireIdeaContentAssets(idea, "moments", "朋友圈图");
}

function buildXhsCarouselPackFromIdea(idea) {
  return requireIdeaContentAssets(idea, "xhsCarousel", "小红书组图");
}

function buildWechatLongImagePackFromIdea(idea) {
  return requireIdeaContentAssets(idea, "wechatLongImage", "公众号长图");
}

module.exports = {
  XHS_CAROUSEL_SLIDE_COUNT,
  normalizeGeneratedXhsCarouselPack,
  normalizeRemixBrief,
  normalizeSourceTemplate,
  normalizeGeneratedImageConceptMetadata,
  normalizeGeneratedWechatLongImagePack,
  normalizeIdeaContentAssets,
  hasCompleteIdeaContentAssets,
  buildImageConceptMetadataFromIdea,
  buildXhsCarouselPackFromIdea,
  buildWechatLongImagePackFromIdea,
};
