/**
 * Image prompt engine — deterministic, commercial-grade image prompts.
 *
 * Replaces free-form AI prompt text with a fixed five-layer structure so
 * generated images stay on-brand, lifestyle-native, and stable across runs.
 *
 * Layers:
 *   1. Visual goal
 *   2. Brand tone
 *   3. Scene
 *   4. Composition
 *   5. Negative constraints
 *
 * No model call, no DB access. Same inputs always yield the same prompt.
 */

const CONTENT_TYPES = Object.freeze(["product_seed", "cover", "poster", "detail_page"]);

const DEFAULT_CONTENT_TYPE = "product_seed";

/** Shared brand-tone anchors for commercial brand content (not ecommerce). */
const BRAND_TONE_CORE = Object.freeze(["高级", "自然", "年轻", "可信"]);

/** Shared scene rules that kill studio/ad look. */
const SCENE_CORE = Object.freeze([
  "真实生活场景",
  "非棚拍",
  "非广告硬广",
  "自然光或生活室内光",
]);

/** Shared negative constraints for all templates. */
const NEGATIVE_CORE = Object.freeze([
  "廉价电商图",
  "白底抠图商品主图",
  "夸张促销文字",
  "大面积中英文硬广标语",
  "塑料质感",
  "过度修图",
  "假笑模特棚拍",
  "水印与二维码",
  "杂乱货架堆砌",
]);

/**
 * Per-contentType template fragments.
 * Templates must diverge enough that the same product + different contentType
 * produces clearly different final prompts (and thus images).
 */
const TEMPLATES = Object.freeze({
  product_seed: Object.freeze({
    label: "种草图",
    visualGoal: "小红书真实种草图片，像用户随手拍的生活分享，自然露出产品",
    sceneFocus: "日常使用中的真实生活瞬间，产品被自然使用或放在生活场景里",
    composition: Object.freeze({
      subject: "产品作为画面故事的一部分，与人物手部/桌面/场景道具自然互动，不居中硬摆",
      light: "柔和自然光或窗边散射光，保留轻微生活阴影",
      whitespace: "适度呼吸感留白，避免信息堆满",
      angle: "略俯视或平视的生活视角，像手机随手记录",
    }),
    extraNegatives: Object.freeze(["像淘宝主图的居中摆拍", "强卖点气泡贴纸"]),
  }),
  cover: Object.freeze({
    label: "封面图",
    visualGoal: "社交媒体封面主视觉，第一眼有记忆点，适合做笔记/内容封面",
    sceneFocus: "高识别度的品牌生活封面场景，主体清晰、氛围统一，像精选内容封面而非货架陈列",
    composition: Object.freeze({
      subject: "单一强主体占据视觉中心，产品或品牌元素一眼可读",
      light: "干净明亮的主光，边缘可有轻微氛围光",
      whitespace: "上半或一侧预留封面标题安全区留白，避免贴边裁切",
      angle: "正侧或微仰的封面视角，构图更完整、更有冲击力",
    }),
    extraNegatives: Object.freeze(["细碎多主体抢戏", "文字区被杂物占满"]),
  }),
  poster: Object.freeze({
    label: "海报",
    visualGoal: "品牌运营海报视觉，完整、干净、有设计感，可用于活动或节日传播",
    sceneFocus: "有品牌调性的场景化海报背景，克制设计感，不是廉价促销海报",
    composition: Object.freeze({
      subject: "产品/品牌符号作为海报主视觉，层级清楚，可配合少量中文信息位",
      light: "统一的品牌光影，对比适中，色调干净",
      whitespace: "海报式分区留白：主视觉区 + 轻信息区，版式稳定",
      angle: "端正、完整的海报构图，适合全幅展示",
    }),
    extraNegatives: Object.freeze(["花哨特效字体爆炸", "红黄促销条幅感", "过多装饰元素"]),
  }),
  detail_page: Object.freeze({
    label: "详情页",
    visualGoal: "产品详情页主视觉/卖点图，清晰展示产品质感与使用价值",
    sceneFocus: "能看清材质、工艺与使用关系的生活化细节场景，强调可信质感而非棚拍广告",
    composition: Object.freeze({
      subject: "产品为主体，细节清晰可见，可带一处真实使用上下文",
      light: "均匀柔光突出材质纹理，避免死白闪光",
      whitespace: "一侧或底部预留卖点说明安全区，主体不贴边",
      angle: "偏近景或 45 度细节视角，便于看清产品结构",
    }),
    extraNegatives: Object.freeze(["信息图表堆满画面", "说明书截图式拼贴", "夸大功效示意图"]),
  }),
});

const PLATFORM_LABELS = Object.freeze({
  xiaohongshu: "小红书",
  xhs: "小红书",
  moments: "微信朋友圈",
  wechat: "微信公众号",
  weixin: "微信",
  douyin: "抖音",
  generic: "社交媒体",
});

function compactText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeContentType(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (CONTENT_TYPES.includes(key)) return key;
  const aliases = {
    seed: "product_seed",
    productseed: "product_seed",
    种草: "product_seed",
    种草图: "product_seed",
    封面: "cover",
    封面图: "cover",
    海报: "poster",
    详情: "detail_page",
    详情页: "detail_page",
    detail: "detail_page",
    details: "detail_page",
  };
  return aliases[key] || DEFAULT_CONTENT_TYPE;
}

function normalizePlatform(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (!key) return "generic";
  if (PLATFORM_LABELS[key]) return key;
  if (/小红书|xhs|red/.test(key)) return "xiaohongshu";
  if (/朋友圈|moments/.test(key)) return "moments";
  if (/公众号|wechat|weixin|微信/.test(key)) return "wechat";
  if (/抖音|douyin/.test(key)) return "douyin";
  return "generic";
}

function platformLabel(platform) {
  return PLATFORM_LABELS[normalizePlatform(platform)] || PLATFORM_LABELS.generic;
}

function extractBrandName(brand) {
  if (!brand || typeof brand !== "object") return "";
  return compactText(brand.name || brand.brandName, 60);
}

function extractProductName(product, brand) {
  if (typeof product === "string" && product.trim()) return compactText(product, 80);
  if (product && typeof product === "object") {
    const fromObject = product.name || product.title || product.product || product.productName;
    if (fromObject) return compactText(fromObject, 80);
  }
  if (brand && typeof brand === "object") {
    return compactText(brand.product || brand.productName, 80);
  }
  return "";
}

function extractBrandToneExtras(brand) {
  if (!brand || typeof brand !== "object") return [];
  const extras = [];
  const industry = compactText(brand.industry, 40);
  const audience = compactText(brand.audience, 40);
  const description = compactText(brand.description, 60);
  if (industry) extras.push(`行业气质：${industry}`);
  if (audience) extras.push(`面向${audience}`);
  if (description) extras.push(description);
  return extras;
}

/**
 * Infer contentType / platform / objective from existing job metadata so
 * createImageJob can adopt the engine without route-layer rewrites.
 */
function resolveImagePromptContext({ brand, product, idea, metadata, trend, contentType, platform, objective } = {}) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const resolvedContentType =
    contentType ||
    meta.contentType ||
    inferContentTypeFromMetadata(meta);
  const resolvedPlatform =
    platform ||
    meta.platform ||
    inferPlatformFromMetadata(meta);
  const resolvedObjective =
    objective ||
    meta.objective ||
    compactText(meta.title || idea?.title || brand?.goal || trend?.title, 100) ||
    "品牌内容传播";
  const resolvedProduct =
    product ||
    meta.product ||
    extractProductName(null, brand) ||
    compactText(idea?.title, 80) ||
    "品牌产品";

  return {
    brand,
    product: resolvedProduct,
    contentType: normalizeContentType(resolvedContentType),
    platform: normalizePlatform(resolvedPlatform),
    objective: compactText(resolvedObjective, 100),
  };
}

function inferContentTypeFromMetadata(meta) {
  if (meta.editPrompt) return null;
  if (meta.stylePrompt || /poster|海报|风格化/i.test(String(meta.style || ""))) return "poster";
  if (Array.isArray(meta.outline) || meta.intro || meta.positioning || (meta.publishTitle && meta.cta)) {
    return "detail_page";
  }
  const pageLabel = String(meta.pageLabel || "");
  if (meta.slideIndex === 0 || /封面|cover/i.test(pageLabel)) return "cover";
  if (Number.isInteger(meta.slideIndex)) {
    return meta.slideIndex >= 3 ? "detail_page" : "product_seed";
  }
  if (/封面/i.test(String(meta.title || ""))) return "cover";
  if (/海报|poster/i.test(String(meta.title || meta.visualDirection || ""))) return "poster";
  if (/详情|长图|卖点/i.test(String(meta.title || meta.visualDirection || meta.composition || ""))) {
    return "detail_page";
  }
  return DEFAULT_CONTENT_TYPE;
}

function inferPlatformFromMetadata(meta) {
  const blob = [meta.platform, meta.style, meta.composition, meta.title, meta.pageLabel]
    .map((part) => String(part || ""))
    .join(" ");
  if (/小红书|xhs|组图/i.test(blob)) return "xiaohongshu";
  if (/朋友圈|moments/i.test(blob)) return "moments";
  if (/公众号|长图|wechat/i.test(blob)) return "wechat";
  if (/海报|风格化|poster/i.test(blob)) return "generic";
  return "xiaohongshu";
}

/**
 * Build a complete five-layer image prompt.
 *
 * @param {{
 *   brand?: object|string,
 *   product?: string|object,
 *   contentType?: string,
 *   platform?: string,
 *   objective?: string,
 * }} input
 * @returns {string}
 */
function buildImagePrompt(input = {}) {
  const contentType = normalizeContentType(input.contentType);
  const template = TEMPLATES[contentType];
  const platform = normalizePlatform(input.platform);
  const brandName =
    typeof input.brand === "string" ? compactText(input.brand, 60) : extractBrandName(input.brand);
  const productName = extractProductName(input.product, typeof input.brand === "object" ? input.brand : null);
  const objective = compactText(input.objective, 100) || "品牌内容传播";
  const toneExtras =
    typeof input.brand === "object" ? extractBrandToneExtras(input.brand) : [];

  const layer1 = [
    `【视觉目标】`,
    template.visualGoal,
    `模板：${template.label}（${contentType}）`,
    `平台：${platformLabel(platform)}`,
    `传播目标：${objective}`,
    brandName ? `品牌：${brandName}` : "",
    productName ? `产品：${productName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const layer2 = [
    `【品牌调性】`,
    BRAND_TONE_CORE.join("、"),
    brandName ? `呈现「${brandName}」的品牌感，不像白牌电商` : "呈现清晰品牌感，不像白牌电商",
    ...toneExtras,
  ].join("\n");

  const layer3 = [
    `【场景】`,
    ...SCENE_CORE,
    template.sceneFocus,
  ].join("\n");

  const composition = template.composition;
  const layer4 = [
    `【构图】`,
    `主体：${composition.subject}`,
    `光线：${composition.light}`,
    `留白：${composition.whitespace}`,
    `视角：${composition.angle}`,
  ].join("\n");

  const negatives = [...NEGATIVE_CORE, ...(template.extraNegatives || [])];
  const layer5 = [`【负面约束】`, `不要：${negatives.join("、")}`].join("\n");

  const basePrompt = [layer1, layer2, layer3, layer4, layer5].join("\n\n");
  const remixLayer = buildRemixBriefLayer(input.remixBrief || input.metadata?.remixBrief);
  return remixLayer ? `${basePrompt}\n\n${remixLayer}` : basePrompt;
}

/**
 * Append controlled remix context only when a sanitized remixBrief is present.
 * Never includes sourceUrl, cookies, or free-form secrets.
 */
function buildRemixBriefLayer(rawBrief) {
  if (!rawBrief || typeof rawBrief !== "object" || Array.isArray(rawBrief)) return "";
  const sourceTitle = compactText(rawBrief.sourceTitle, 80);
  const pageTask = compactText(rawBrief.pageTask, 160);
  const pageTitle = compactText(rawBrief.pageTitle, 80);
  const pageCopy = compactText(rawBrief.pageCopy, 200);
  const sourceBoard = compactText(rawBrief.sourceBoard, 40);
  const boardLabel =
    sourceBoard === "ecommerce_hot" ? "电商热门" : sourceBoard === "xhs_hot" ? "小红书热门" : "";
  const taxonomyPath =
    compactText(rawBrief.sourceCategoryPath, 120) || compactText(rawBrief.sourceIndustryPath, 120);
  const readCount = Number(rawBrief.sourceReadCount);
  const readLabel =
    Number.isFinite(readCount) && readCount > 0 ? `阅读量约 ${Math.floor(readCount)}` : "";
  const learningFocus = Array.isArray(rawBrief.learningFocus)
    ? rawBrief.learningFocus.map((item) => compactText(item, 40)).filter(Boolean).slice(0, 6)
    : [];
  const sourceLearningApplied = Array.isArray(rawBrief.sourceLearningApplied)
    ? rawBrief.sourceLearningApplied.map((item) => compactText(item, 60)).filter(Boolean).slice(0, 4)
    : [];
  const contentMode = compactText(rawBrief.contentMode, 40);
  const contentDirection = compactText(rawBrief.contentDirection, 160);
  const targetAudience = compactText(rawBrief.targetAudience, 60);
  const userScene = compactText(rawBrief.userScene, 100);
  const pageRole = compactText(rawBrief.pageRole, 60);
  const contentGoal = compactText(rawBrief.contentGoal, 140);
  const trendUsed = Boolean(rawBrief.trendUsed);
  const trendTitle = trendUsed ? compactText(rawBrief.trendTitle, 80) : "";
  const originalityGuard =
    compactText(rawBrief.originalityGuard, 320) ||
    "只学习参考笔记的信息节奏、页面角色和内容方法；不得复制原文、原图人物、原品牌、原Logo、水印、具体版式和可识别视觉资产；生成全新的原创内容与画面。";
  // Controlled remix layer only — never sourceUrl, image URLs, cookies, or free-form secrets.
  const lines = [
    "【优秀内容仿写上下文】",
    sourceTitle ? `参考案例标题：${sourceTitle}` : "",
    boardLabel ? `来源板块：${boardLabel}` : "",
    taxonomyPath ? `类目或行业：${taxonomyPath}` : "",
    readLabel ? readLabel : "",
    contentMode ? `内容方向模式：${contentMode}` : "",
    contentDirection ? `本次内容方向：${contentDirection}` : "",
    targetAudience ? `目标人群：${targetAudience}` : "",
    userScene ? `用户场景：${userScene}` : "",
    trendTitle ? `可选趋势语境：${trendTitle}（仅增强时效，不改内容主体）` : "",
    pageRole ? `本页角色：${pageRole}` : "",
    contentGoal ? `本页内容目标：${contentGoal}` : "",
    pageTask ? `本页页面任务：${pageTask}` : "",
    pageTitle ? `本页标题重点：${pageTitle}` : "",
    pageCopy ? `本页文案重点：${pageCopy}` : "",
    sourceLearningApplied.length ? `本页应用的参考方法：${sourceLearningApplied.join("；")}` : "",
    (() => {
      const platformVisualGuidance = compactText(rawBrief.platformVisualGuidance, 200);
      return platformVisualGuidance
        ? `平台通用视觉建议（非参考笔记图片识别）：${platformVisualGuidance}`
        : "";
    })(),
    learningFocus.length ? `学习重点：${learningFocus.join("、")}` : "",
    `原创保护：${originalityGuard}`,
  ].filter(Boolean);
  if (lines.length <= 2) return "";
  return lines.join("\n");
}

/**
 * Whether this metadata should keep the caller prompt as-is (e.g. user edit).
 */
function shouldSkipStructuredPrompt(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  if (metadata.skipStructuredPrompt === true) return true;
  if (metadata.editPrompt) return true;
  return false;
}

module.exports = {
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  TEMPLATES,
  BRAND_TONE_CORE,
  SCENE_CORE,
  NEGATIVE_CORE,
  buildImagePrompt,
  buildRemixBriefLayer,
  resolveImagePromptContext,
  shouldSkipStructuredPrompt,
  normalizeContentType,
  normalizePlatform,
  inferContentTypeFromMetadata,
  inferPlatformFromMetadata,
};
