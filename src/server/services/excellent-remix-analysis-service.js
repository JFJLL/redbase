const crypto = require("crypto");
const {
  getExcellentContentBoard,
  getExcellentContentSource,
  getExcellentContentDetail,
} = require("./excellent-content-service");
const {
  findRemixAnalysisCache,
  upsertRemixAnalysisCache,
  recordRemixAnalysisCacheError,
} = require("../db/repositories/excellent-remix-analysis-cache-repository");
const { callTextModelJson } = require("../ai/text-provider");

const ANALYSIS_VERSION = "v3-content-direction-1";
const ANALYSIS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ANALYZE_IMAGES = 9;
const inFlightAnalyses = new Map();

function compactText(value, max = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stripHtml(value) {
  return compactText(String(value || "").replace(/<[^>]*>/g, " "), 500);
}

function hashSafe(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 32);
}

/**
 * Stable signature over note identity + image set without storing raw URLs in the key.
 */
function buildSourceSignature(note) {
  const noteId = compactText(note?.noteId || note?.id, 80);
  const title = compactText(note?.title, 200);
  const urls = Array.isArray(note?.imageUrls) ? note.imageUrls.filter(Boolean).slice(0, MAX_ANALYZE_IMAGES) : [];
  // Hash only URL path digests so full CDN URLs never enter the primary key.
  const urlDigest = hashSafe(
    urls.map((url) => {
      try {
        const parsed = new URL(String(url));
        return `${parsed.hostname}${parsed.pathname}`;
      } catch (_error) {
        return hashSafe([String(url).slice(0, 80)]);
      }
    }),
  );
  return hashSafe([noteId, title, String(urls.length), urlDigest]);
}

function extractTitleHookType(title) {
  const text = compactText(title, 120);
  if (!text) return { type: "generic", description: "标题信息有限，仅能给出通用封面钩子方向。", titleFormula: "场景 + 结果提示" };
  if (/[？?]/.test(text)) return { type: "question", description: "标题以提问形式制造点击动机。", titleFormula: "疑问句点出用户困惑" };
  if (/(避坑|别买|千万|误区)/.test(text)) return { type: "warning", description: "标题使用避坑/警示语气。", titleFormula: "警示词 + 具体场景" };
  if (/(清单|对照|步骤|方法|指南)/.test(text)) return { type: "list", description: "标题承诺清单或方法结构。", titleFormula: "可收藏结构词 + 主题" };
  if (/(对比|vs|VS|还是)/.test(text)) return { type: "comparison", description: "标题强调对比选择。", titleFormula: "选项A vs 选项B" };
  if (/(亲测|实测|真实|自用)/.test(text)) return { type: "proof", description: "标题强调真实体验证明。", titleFormula: "真实体验 + 结果" };
  return { type: "benefit", description: "标题偏向利益点或结果导向。", titleFormula: "人群/场景 + 结果利益" };
}

function buildSlideRolesFromImageCount(imageCount) {
  const count = Math.max(1, Math.min(Number(imageCount) || 1, MAX_ANALYZE_IMAGES));
  const templates = [
    { role: "封面钩子", contentFunction: "用标题式信息抓住第一眼注意" },
    { role: "问题场景", contentFunction: "展开用户真实困扰或误区" },
    { role: "方法拆解", contentFunction: "给出可执行的判断或步骤" },
    { role: "清单转化", contentFunction: "沉淀可收藏的行动清单" },
    { role: "补充对比", contentFunction: "补充对照或例外说明" },
    { role: "细节证明", contentFunction: "用细节增强可信度" },
    { role: "总结回顾", contentFunction: "收束观点并提示行动" },
    { role: "延伸提醒", contentFunction: "补充边界与注意事项" },
    { role: "收尾号召", contentFunction: "轻行动号召与收藏提醒" },
  ];
  return Array.from({ length: count }, (_, index) => ({
    sourceIndex: index,
    role: templates[index % templates.length].role,
    contentFunction: templates[index % templates.length].contentFunction,
  }));
}

function buildMetadataOnlyAnalysis(note, board) {
  const noteId = compactText(note?.noteId || note?.id, 80);
  const title = compactText(note?.title, 120);
  const imageCount = Number(note?.imageCount || note?.imageUrls?.length || 0) || 0;
  const readCount = Number(note?.metrics?.readCount || 0) || 0;
  const hook = extractTitleHookType(title);
  const slideRoles = buildSlideRolesFromImageCount(imageCount || 4);
  const boardLabel = board === "ecommerce_hot" ? "电商热门" : "小红书热门";

  return {
    noteId,
    analysisMode: "metadata_only",
    analysisVersion: ANALYSIS_VERSION,
    referenceTopic: title || "未命名参考笔记",
    hookPattern: {
      type: hook.type,
      description: hook.description,
      titleFormula: hook.titleFormula,
    },
    narrativeStructure: {
      summary: `基于标题与${imageCount || "未知"}张图片顺序的元数据推断：参考笔记按多页图文节奏展开，具体正文未由接口提供。`,
      slideRoles,
    },
    visualLanguage: {
      layout: imageCount >= 4 ? "多页竖图信息流" : "短组图或单页强化",
      textDensity: "中等偏少（由常见小红书图文节奏推断，非像素级识别）",
      imageTextRatio: "以图承载信息层级，文字短句为主（元数据推断）",
      colorMood: "未能进行完整图片理解，配色仅按平台常见真实生活感处理",
      typography: "标题优先、层级清晰（元数据推断）",
      composition: "3:4 竖版信息图节奏（由平台形态与图片数量推断）",
    },
    conversionPattern: {
      type: /清单|对照|步骤|方法/.test(title) ? "checklist" : "save_worthy_summary",
      description: /清单|对照|步骤|方法/.test(title)
        ? "标题暗示清单/步骤类可收藏结构。"
        : "以方法总结或行动提示促成收藏。",
    },
    usableLearningPoints: [
      `学习${boardLabel}高阅读笔记的标题钩子类型：${hook.type}`,
      `按参考图文页数节奏规划页面角色（当前观察到约 ${imageCount} 张图）`,
      "只迁移表达方法，不迁移原品牌与可识别版式",
    ].filter(Boolean),
    originalityConstraints: [
      "不得复制参考笔记标题原文与可识别表述",
      "不得复制原图人物、原品牌、Logo、水印与具体版式",
      "不得声称已获得接口未提供的正文",
      "参考图片仅用于方法分析，不得自动进入最终生图",
    ],
    meta: {
      sourceImageCount: imageCount,
      sourceReadCount: readCount,
      hasBodyText: Boolean(compactText(note?.content, 20)),
      multimodalUsed: false,
    },
  };
}

function normalizeAnalysis(raw, note, board) {
  const fallback = buildMetadataOnlyAnalysis(note, board);
  if (!raw || typeof raw !== "object") return fallback;

  const slideRolesRaw = Array.isArray(raw.narrativeStructure?.slideRoles)
    ? raw.narrativeStructure.slideRoles
    : Array.isArray(raw.slideRoles)
      ? raw.slideRoles
      : fallback.narrativeStructure.slideRoles;

  const slideRoles = slideRolesRaw
    .slice(0, MAX_ANALYZE_IMAGES)
    .map((item, index) => ({
      sourceIndex: Number.isFinite(Number(item?.sourceIndex)) ? Number(item.sourceIndex) : index,
      role: compactText(item?.role, 40) || fallback.narrativeStructure.slideRoles[index]?.role || `页面${index + 1}`,
      contentFunction:
        compactText(item?.contentFunction, 120) ||
        fallback.narrativeStructure.slideRoles[index]?.contentFunction ||
        "承载当前页信息重点",
    }));

  if (!slideRoles.length) {
    slideRoles.push(...fallback.narrativeStructure.slideRoles);
  }

  const analysisMode =
    raw.analysisMode === "multimodal" && raw.meta?.multimodalUsed === true ? "multimodal" : "metadata_only";

  const analysis = {
    noteId: compactText(note?.noteId || note?.id || raw.noteId, 80),
    analysisMode,
    analysisVersion: ANALYSIS_VERSION,
    referenceTopic: compactText(raw.referenceTopic || note?.title, 120) || fallback.referenceTopic,
    hookPattern: {
      type: compactText(raw.hookPattern?.type, 40) || fallback.hookPattern.type,
      description: compactText(raw.hookPattern?.description, 200) || fallback.hookPattern.description,
      titleFormula: compactText(raw.hookPattern?.titleFormula, 120) || fallback.hookPattern.titleFormula,
    },
    narrativeStructure: {
      summary: compactText(raw.narrativeStructure?.summary, 320) || fallback.narrativeStructure.summary,
      slideRoles,
    },
    visualLanguage: {
      layout: compactText(raw.visualLanguage?.layout, 80) || fallback.visualLanguage.layout,
      textDensity: compactText(raw.visualLanguage?.textDensity, 80) || fallback.visualLanguage.textDensity,
      imageTextRatio: compactText(raw.visualLanguage?.imageTextRatio, 80) || fallback.visualLanguage.imageTextRatio,
      colorMood: compactText(raw.visualLanguage?.colorMood, 80) || fallback.visualLanguage.colorMood,
      typography: compactText(raw.visualLanguage?.typography, 80) || fallback.visualLanguage.typography,
      composition: compactText(raw.visualLanguage?.composition, 120) || fallback.visualLanguage.composition,
    },
    conversionPattern: {
      type: compactText(raw.conversionPattern?.type, 40) || fallback.conversionPattern.type,
      description: compactText(raw.conversionPattern?.description, 200) || fallback.conversionPattern.description,
    },
    usableLearningPoints: (Array.isArray(raw.usableLearningPoints) ? raw.usableLearningPoints : fallback.usableLearningPoints)
      .map((item) => compactText(item, 120))
      .filter(Boolean)
      .slice(0, 8),
    originalityConstraints: (
      Array.isArray(raw.originalityConstraints) ? raw.originalityConstraints : fallback.originalityConstraints
    )
      .map((item) => compactText(item, 160))
      .filter(Boolean)
      .slice(0, 8),
    meta: {
      sourceImageCount: Number(note?.imageCount || note?.imageUrls?.length || 0) || 0,
      sourceReadCount: Number(note?.metrics?.readCount || 0) || 0,
      hasBodyText: Boolean(compactText(note?.content, 20)),
      multimodalUsed: false,
    },
  };

  // Never leak image URLs into analysis payload.
  const serialized = JSON.stringify(analysis);
  if (/https?:\/\//i.test(serialized) || /xiaohongshu\.com|xhscdn|sns-webpic/i.test(serialized)) {
    return fallback;
  }
  return analysis;
}

function supportsMultimodalVision(_appConfig) {
  // Current text-provider path only accepts system/user text prompts.
  // Do not pretend multimodal vision is available.
  return false;
}

async function analyzeWithOptionalModel(appConfig, note, board, { textModelImpl } = {}) {
  const base = buildMetadataOnlyAnalysis(note, board);
  if (supportsMultimodalVision(appConfig)) {
    // Reserved for future vision-capable provider wiring.
  }

  const modelImpl = textModelImpl || callTextModelJson;
  if (!appConfig?.textProvider?.apiKey || typeof modelImpl !== "function") {
    return base;
  }

  try {
    const systemPrompt = [
      "你是小红书图文方法分析助手。只根据可观察元数据分析表达方法。",
      "禁止推测作者心理、禁止声称有正文、禁止输出图片URL、禁止复制原文、禁止输出爆款原因伪结论。",
      "只输出 JSON 对象。",
    ].join("\n");
    const userPrompt = JSON.stringify(
      {
        task: "excellent_note_method_analysis",
        board,
        title: compactText(note?.title, 120),
        author: compactText(note?.author?.nickname, 40),
        imageCount: Number(note?.imageCount || note?.imageUrls?.length || 0) || 0,
        readCount: Number(note?.metrics?.readCount || 0) || 0,
        categoryPath: compactText(note?.categoryPath, 120),
        industryPath: compactText(note?.industryPath, 120),
        contentSource: compactText(note?.contentSource, 40),
        hasBodyText: Boolean(compactText(note?.content, 20)),
        note: "接口未提供完整正文时不得伪造正文分析。analysisMode 必须为 metadata_only。",
        requiredFields: [
          "referenceTopic",
          "hookPattern",
          "narrativeStructure",
          "visualLanguage",
          "conversionPattern",
          "usableLearningPoints",
          "originalityConstraints",
        ],
      },
      null,
      2,
    );
    const raw = await modelImpl(appConfig, {
      systemPrompt,
      userPrompt,
      temperature: 0.2,
      maxOutputTokens: 1200,
      maxAttempts: 2,
    });
    return normalizeAnalysis({ ...raw, analysisMode: "metadata_only" }, note, board);
  } catch (_error) {
    return base;
  }
}

function isCacheFresh(row) {
  if (!row?.analysis || typeof row.analysis !== "object") return false;
  if (!row.expiresAt) return false;
  const expires = Date.parse(row.expiresAt);
  return Number.isFinite(expires) && expires > Date.now();
}

async function analyzeExcellentNoteForRemix(appConfig, options = {}) {
  const boardDef = getExcellentContentBoard(options.board);
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }
  const sourceDef = getExcellentContentSource(options.contentSource || "all");
  if (!sourceDef) {
    const error = new Error("暂不支持该内容来源。");
    error.code = "INVALID_SOURCE";
    error.statusCode = 400;
    throw error;
  }

  const noteId = compactText(options.noteId, 80);
  if (!noteId) {
    const error = new Error("缺少笔记 ID");
    error.code = "INVALID_NOTE";
    error.statusCode = 400;
    throw error;
  }

  const detail = await getExcellentContentDetail(appConfig, {
    noteId,
    board: boardDef.value,
    contentSource: sourceDef.value,
    categoryPath: options.categoryPath || "",
    industryPath: options.industryPath || "",
  });
  const note = detail?.item;
  if (!note) {
    const error = new Error("当前优秀内容缓存中找不到该笔记，请先更新优秀内容列表。");
    error.code = "NOTE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  const sourceSignature = buildSourceSignature(note);
  const cacheKey = `${noteId}|${boardDef.value}|${sourceSignature}|${ANALYSIS_VERSION}`;
  const cached = findRemixAnalysisCache({
    noteId,
    boardKey: boardDef.value,
    sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
  });
  if (isCacheFresh(cached)) {
    return {
      ...normalizeAnalysis(cached.analysis, note, boardDef.value),
      sourceSignature,
      analysisId: cacheKey,
      fromCache: true,
      modelName: cached.modelName || "",
    };
  }

  let promise = inFlightAnalyses.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      try {
        const analysis = await analyzeWithOptionalModel(appConfig, note, boardDef.value, {
          textModelImpl: options.textModelImpl,
        });
        const now = new Date();
        upsertRemixAnalysisCache({
          noteId,
          boardKey: boardDef.value,
          sourceSignature,
          analysisVersion: ANALYSIS_VERSION,
          analysisMode: analysis.analysisMode,
          analysis,
          modelName: appConfig?.textProvider?.model || "",
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ANALYSIS_TTL_MS).toISOString(),
          lastError: "",
        });
        return {
          ...analysis,
          sourceSignature,
          analysisId: cacheKey,
          fromCache: false,
          modelName: appConfig?.textProvider?.model || "",
        };
      } catch (error) {
        try {
          recordRemixAnalysisCacheError({
            noteId,
            boardKey: boardDef.value,
            sourceSignature,
            analysisVersion: ANALYSIS_VERSION,
            lastError: compactText(error?.message, 200),
          });
        } catch (_error) {
          // keep going
        }
        // Safe degraded analysis so remix flow can continue.
        const degraded = buildMetadataOnlyAnalysis(note, boardDef.value);
        return {
          ...degraded,
          sourceSignature,
          analysisId: cacheKey,
          fromCache: false,
          degraded: true,
          modelName: "",
        };
      }
    })().finally(() => {
      inFlightAnalyses.delete(cacheKey);
    });
    inFlightAnalyses.set(cacheKey, promise);
  }
  return promise;
}

function getRemixAnalysisById(analysisId, noteId, board) {
  const raw = String(analysisId || "");
  const parts = raw.split("|");
  if (parts.length < 4) return null;
  const [cachedNoteId, boardKey, sourceSignature, analysisVersion] = parts;
  if (noteId && compactText(noteId, 80) !== compactText(cachedNoteId, 80)) return null;
  if (board && getExcellentContentBoard(board)?.value !== boardKey) return null;
  const row = findRemixAnalysisCache({
    noteId: cachedNoteId,
    boardKey,
    sourceSignature,
    analysisVersion,
  });
  if (!isCacheFresh(row)) return null;
  return {
    ...row.analysis,
    sourceSignature,
    analysisId: raw,
    fromCache: true,
    modelName: row.modelName || "",
  };
}

function filterAnalysisByLearningFocus(analysis, learningFocus = []) {
  const focus = new Set(
    (Array.isArray(learningFocus) ? learningFocus : [])
      .map((item) => String(item || "").trim())
      .filter((item) => ["structure", "visual", "hook", "conversion"].includes(item)),
  );
  if (!focus.size) {
    focus.add("structure");
    focus.add("visual");
  }
  const applied = [];
  if (focus.has("structure") && analysis?.narrativeStructure) {
    applied.push({
      type: "structure",
      description: compactText(analysis.narrativeStructure.summary, 160),
      slideRoles: analysis.narrativeStructure.slideRoles || [],
    });
  }
  if (focus.has("visual") && analysis?.visualLanguage) {
    applied.push({
      type: "visual",
      description: compactText(
        [
          analysis.visualLanguage.layout,
          analysis.visualLanguage.textDensity,
          analysis.visualLanguage.colorMood,
          analysis.visualLanguage.typography,
        ]
          .filter(Boolean)
          .join("；"),
        200,
      ),
      visualLanguage: analysis.visualLanguage,
    });
  }
  if (focus.has("hook") && analysis?.hookPattern) {
    applied.push({
      type: "hook",
      description: compactText(analysis.hookPattern.description, 160),
      hookPattern: analysis.hookPattern,
    });
  }
  if (focus.has("conversion") && analysis?.conversionPattern) {
    applied.push({
      type: "conversion",
      description: compactText(analysis.conversionPattern.description, 160),
      conversionPattern: analysis.conversionPattern,
    });
  }
  return { focus: [...focus], applied };
}

function __resetRemixAnalysisInFlightForTests() {
  inFlightAnalyses.clear();
}

module.exports = {
  ANALYSIS_VERSION,
  ANALYSIS_TTL_MS,
  MAX_ANALYZE_IMAGES,
  buildSourceSignature,
  buildMetadataOnlyAnalysis,
  normalizeAnalysis,
  supportsMultimodalVision,
  analyzeExcellentNoteForRemix,
  getRemixAnalysisById,
  filterAnalysisByLearningFocus,
  compactText,
  stripHtml,
  __resetRemixAnalysisInFlightForTests,
};
