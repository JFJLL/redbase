const crypto = require("crypto");
const { callVisionModelJson } = require("../ai/text-provider");
const {
  findRemixAnalysisCache,
  upsertRemixAnalysisCache,
} = require("../db/repositories/excellent-remix-analysis-cache-repository");
const { createExcellentVisionStorageProvider } = require("./excellent-vision-storage-provider");

// 参考优秀内容的多模态理解：学习方法，不复制结果。
// 第一版按产品决策直接把图片 URL 传给多模态模型；失败降级 metadata_only，
// 永远不能阻断优秀内容流程。
const VISION_ANALYSIS_VERSION = "excellent-vision-v1";
// 同一优秀内容的视觉学习结果全局共享（不分用户），缓存 30 天。
const VISION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 缓存键 = noteId + imageSignature；复用现有分析缓存表时用固定命名空间占位 board 列。
const VISION_CACHE_BOARD_KEY = "vision";
const MAX_VISION_IMAGES = 4;
const VISION_FALLBACK_WARNING = "未成功读取参考图片，本次基于标题和内容结构分析";
const inFlightVisionAnalyses = new Map();
const defaultStorageProvider = createExcellentVisionStorageProvider();

function compactText(value, max = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hashSafe(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 32);
}

/**
 * 图片输入策略：最多 4 张，优先封面、第二页、第三页、第四页。
 * 只接受 http(s) URL，本阶段不做图片下载。
 */
function selectVisionImageUrls(imageUrls) {
  return (Array.isArray(imageUrls) ? imageUrls : [])
    .map((url) => String(url || "").trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, MAX_VISION_IMAGES);
}

/**
 * imageSignature：noteId + 图片集合指纹。只哈希 host+path 摘要，
 * 原始 CDN URL 不进入任何缓存键或分析结果。
 */
function buildImageSignature(noteId, imageUrls) {
  const urls = selectVisionImageUrls(imageUrls);
  const urlDigest = hashSafe(
    urls.map((url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
      } catch (_error) {
        return hashSafe([url.slice(0, 80)]);
      }
    }),
  );
  return hashSafe([compactText(noteId, 80), String(urls.length), urlDigest]);
}

function sanitizeSummaryLine(value) {
  const text = compactText(value, 120);
  if (!text) return "";
  // 面向用户的学习摘要不允许出现复制指引、URL 或技术字段。
  if (/https?:\/\//i.test(text)) return "";
  if (/复制|照搬|prompt|json|token|model/i.test(text)) return "";
  return text;
}

function normalizePages(rawPages) {
  const pages = (Array.isArray(rawPages) ? rawPages : [])
    .slice(0, 9)
    .map((item, index) => ({
      page: index + 1,
      role: compactText(item?.role, 40) || `页面${index + 1}`,
      focus: compactText(item?.focus || item?.contentFunction, 120) || "承载当前页信息重点",
    }));
  return pages;
}

/**
 * 归一化模型返回，输出面向用户的学习结果。
 * 返回 null 表示结果不可用（调用方按模型失败降级处理）。
 */
function normalizeVisionAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const learningSummary = (Array.isArray(raw.learningSummary) ? raw.learningSummary : [])
    .map(sanitizeSummaryLine)
    .filter(Boolean)
    .slice(0, 8);
  if (!learningSummary.length) return null;

  const analysis = {
    analysisMode: "multimodal",
    visualLanguage: {
      layout: compactText(raw.visualLanguage?.layout, 80) || "多页竖版信息图节奏",
      color: compactText(raw.visualLanguage?.color, 80) || "以真实生活感配色为主",
      typography: compactText(raw.visualLanguage?.typography, 80) || "标题优先、层级清晰",
      composition: compactText(raw.visualLanguage?.composition, 120) || "封面聚焦标题区，内页信息分层",
      textDensity: compactText(raw.visualLanguage?.textDensity, 80) || "图文比例均衡（图片观察）",
      imageTextRatio: compactText(raw.visualLanguage?.imageTextRatio, 80) || "以图承载信息、文字点题（图片观察）",
    },
    structure: {
      hook: {
        type: compactText(raw.structure?.hook?.type, 40) || "benefit",
        description: compactText(raw.structure?.hook?.description, 200) || "封面以结果或利益点吸引第一眼注意。",
        titleFormula: compactText(raw.structure?.hook?.titleFormula, 120) || "人群/场景 + 结果利益",
      },
      pages: normalizePages(raw.structure?.pages),
      narrativeFlow: compactText(raw.structure?.narrativeFlow, 320) || "按封面钩子—展开—收束的节奏推进。",
    },
    conversion: {
      interaction: compactText(raw.conversion?.interaction, 160) || "以轻量行动提示引导互动。",
      saveReason: compactText(raw.conversion?.saveReason, 160) || "信息可回看、可执行，促成收藏。",
    },
    learningSummary,
  };

  // 严禁泄漏图片 URL、prompt 或模型内部字段。
  const serialized = JSON.stringify(analysis);
  if (/https?:\/\//i.test(serialized) || /xiaohongshu\.com|xhscdn|sns-webpic/i.test(serialized)) {
    return null;
  }
  return analysis;
}

function buildVisionPrompts({ noteId, title, imageCount, metadata }) {
  const systemPrompt = [
    "你是小红书图文方法学习助手，会看到最多4张参考笔记图片。",
    "只总结可迁移的表达方法：标题结构、信息层级、页面节奏、视觉语言、内容转化结构、用户阅读路径。",
    "禁止：复制原图文字与排版、描述可识别的品牌/人物/水印/案例、输出图片URL、输出任何提示词或模型信息、给出照搬原图的建议。",
    "learningSummary 每条都是给普通用户看的中文短句，例如“封面采用问题型标题”。",
    "只输出 JSON 对象，字段：visualLanguage{layout,color,typography,composition,textDensity,imageTextRatio}、structure{hook{type,description,titleFormula},pages[{role,focus}],narrativeFlow}、conversion{interaction,saveReason}、learningSummary[]。",
  ].join("\n");
  const userPrompt = JSON.stringify(
    {
      task: "excellent_note_visual_method_learning",
      noteId: compactText(noteId, 80),
      title: compactText(title, 120),
      imageCount: Number(imageCount) || 0,
      board: compactText(metadata?.board, 40),
      categoryPath: compactText(metadata?.categoryPath, 120),
      industryPath: compactText(metadata?.industryPath, 120),
      note: "图片按封面、第2页、第3页、第4页顺序给出。只学习方法，不复制结果。",
    },
    null,
    2,
  );
  return { systemPrompt, userPrompt };
}

function buildMetadataOnlyOutcome(imageSignature) {
  return {
    analysisMode: "metadata_only",
    warning: VISION_FALLBACK_WARNING,
    imageSignature,
    fromCache: false,
  };
}

function isVisionCacheFresh(row) {
  if (!row?.analysis || typeof row.analysis !== "object") return false;
  if (row.analysis.analysisMode !== "multimodal") return false;
  if (!row.expiresAt) return false;
  const expires = Date.parse(row.expiresAt);
  return Number.isFinite(expires) && expires > Date.now();
}

function findVisionAnalysisCache(noteId, imageSignature) {
  return findRemixAnalysisCache({
    noteId,
    boardKey: VISION_CACHE_BOARD_KEY,
    sourceSignature: imageSignature,
    analysisVersion: VISION_ANALYSIS_VERSION,
  });
}

/**
 * 多模态理解入口。输入 { noteId, imageUrls, title, metadata }。
 * 命中 30 天缓存（noteId + imageSignature，跨用户共享）时不调模型；
 * 成功返回 multimodal 学习结果；模型失败返回 metadata_only 降级结果，
 * 不抛错、不阻断优秀内容流程；降级结果不写入 30 天缓存，下次仍可重试多模态。
 */
async function analyzeExcellentContentVision(appConfig, options = {}) {
  const noteId = compactText(options.noteId, 80);
  const urls = selectVisionImageUrls(options.imageUrls);
  const imageSignature = buildImageSignature(noteId, options.imageUrls);
  if (!noteId || !urls.length) {
    return buildMetadataOnlyOutcome(imageSignature);
  }

  const cached = findVisionAnalysisCache(noteId, imageSignature);
  if (isVisionCacheFresh(cached)) {
    return { ...cached.analysis, imageSignature, fromCache: true };
  }

  const inFlightKey = `${noteId}|${imageSignature}`;
  let promise = inFlightVisionAnalyses.get(inFlightKey);
  if (!promise) {
    promise = runVisionAnalysis(appConfig, { noteId, urls, imageSignature, options }).finally(() => {
      inFlightVisionAnalyses.delete(inFlightKey);
    });
    inFlightVisionAnalyses.set(inFlightKey, promise);
  }
  return promise;
}

async function runVisionAnalysis(appConfig, { noteId, urls, imageSignature, options }) {
  const modelImpl = typeof options.visionModelImpl === "function" ? options.visionModelImpl : callVisionModelJson;
  const storageProvider = options.storageProvider || defaultStorageProvider;
  const { systemPrompt, userPrompt } = buildVisionPrompts({
    noteId,
    title: options.title,
    imageCount: urls.length,
    metadata: options.metadata || {},
  });
  try {
    // StorageProvider 预留接口：local 驱动直接透传 URL，未来 OSS 驱动在此替换。
    const imageInputs = await storageProvider.resolveImageInputs(urls);
    const raw = await modelImpl(appConfig, {
      systemPrompt,
      userPrompt,
      imageUrls: imageInputs.map((input) => input.url),
      temperature: 0.2,
      maxOutputTokens: 1400,
      maxAttempts: 2,
      timeoutMs: 60000,
    });
    const normalized = normalizeVisionAnalysis(raw);
    if (!normalized) {
      return buildMetadataOnlyOutcome(imageSignature);
    }
    const now = new Date();
    // 只缓存成功的 multimodal 结果；只存分析结果与签名，不存图片/URL。
    upsertRemixAnalysisCache({
      noteId,
      boardKey: VISION_CACHE_BOARD_KEY,
      sourceSignature: imageSignature,
      analysisVersion: VISION_ANALYSIS_VERSION,
      analysisMode: "multimodal",
      analysis: normalized,
      modelName: appConfig?.textProvider?.model || "",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + VISION_CACHE_TTL_MS).toISOString(),
      lastError: "",
    });
    return { ...normalized, imageSignature, fromCache: false };
  } catch (_error) {
    return buildMetadataOnlyOutcome(imageSignature);
  }
}

function __resetVisionAnalysisInFlightForTests() {
  inFlightVisionAnalyses.clear();
}

module.exports = {
  VISION_ANALYSIS_VERSION,
  VISION_CACHE_TTL_MS,
  VISION_CACHE_BOARD_KEY,
  MAX_VISION_IMAGES,
  VISION_FALLBACK_WARNING,
  selectVisionImageUrls,
  buildImageSignature,
  normalizeVisionAnalysis,
  findVisionAnalysisCache,
  analyzeExcellentContentVision,
  __resetVisionAnalysisInFlightForTests,
};
