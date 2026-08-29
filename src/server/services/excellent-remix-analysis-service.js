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
const {
  selectVisionImageUrls,
  analyzeExcellentContentVision,
  VISION_FALLBACK_WARNING,
  VISION_CACHE_TTL_MS,
} = require("./excellent-content-vision-service");

const ANALYSIS_VERSION = "v4-excellent-learning-1";
const ANALYSIS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 多模态分析的外层行与视觉缓存同周期（30 天），同一参考内容不重复调模型。
const MULTIMODAL_ANALYSIS_TTL_MS = VISION_CACHE_TTL_MS;
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
      // Honest labeling: no multimodal image understanding was performed.
      source: "platform_default",
      confidence: "low",
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
    // 面向用户的学习摘要：metadata 模式下诚实声明只基于标题与结构。
    learningSummary: [
      `标题钩子：${hook.description}`,
      `页面节奏：按约 ${imageCount || 4} 页图文逐层展开信息`,
      "转化方式：以可收藏的方法总结促成互动",
    ],
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
      source:
        analysisMode === "multimodal" && raw.meta?.multimodalUsed === true
          ? compactText(raw.visualLanguage?.source, 40) || "reference_image"
          : "platform_default",
      confidence:
        analysisMode === "multimodal" && raw.meta?.multimodalUsed === true
          ? compactText(raw.visualLanguage?.confidence, 20) || "medium"
          : "low",
    },
    conversionPattern: {
      type: compactText(raw.conversionPattern?.type, 40) || fallback.conversionPattern.type,
      description: compactText(raw.conversionPattern?.description, 200) || fallback.conversionPattern.description,
    },
    usableLearningPoints: (Array.isArray(raw.usableLearningPoints) ? raw.usableLearningPoints : fallback.usableLearningPoints)
      .map((item) => compactText(item, 120))
      .filter(Boolean)
      .slice(0, 8),
    learningSummary: (
      Array.isArray(raw.learningSummary) && raw.learningSummary.length ? raw.learningSummary : fallback.learningSummary
    )
      .map((item) => compactText(item, 120))
      .filter(Boolean)
      .slice(0, 8),
    ...(compactText(raw.warning, 160) ? { warning: compactText(raw.warning, 160) } : {}),
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
      multimodalUsed: analysisMode === "multimodal",
      ...(Number(raw.meta?.visionImageCount) > 0 ? { visionImageCount: Number(raw.meta.visionImageCount) } : {}),
    },
  };

  // Never leak image URLs into analysis payload.
  const serialized = JSON.stringify(analysis);
  if (/https?:\/\//i.test(serialized) || /xiaohongshu\.com|xhscdn|sns-webpic/i.test(serialized)) {
    return fallback;
  }
  return analysis;
}

function supportsMultimodalVision(appConfig) {
  const provider = appConfig?.textProvider || {};
  if (!String(provider.apiKey || "").trim()) return false;
  // 仅 OpenAI 兼容的 chat/completions 接受 image_url 内容块；
  // google/anthropic 接入方式走 metadata_only，不假装能看图。
  return provider.apiStyle !== "google" && provider.apiStyle !== "anthropic";
}

/**
 * 把多模态学习结果映射到现有分析结构，下游内容方向/融合方案无需感知来源差异。
 */
function buildMultimodalAnalysis(note, board, vision) {
  const fallback = buildMetadataOnlyAnalysis(note, board);
  const pages = Array.isArray(vision?.structure?.pages) ? vision.structure.pages : [];
  const slideRoles = pages.length
    ? pages.map((page, index) => ({
        sourceIndex: index,
        role: compactText(page?.role, 40) || fallback.narrativeStructure.slideRoles[index]?.role || `页面${index + 1}`,
        contentFunction:
          compactText(page?.focus, 120) ||
          fallback.narrativeStructure.slideRoles[index]?.contentFunction ||
          "承载当前页信息重点",
      }))
    : fallback.narrativeStructure.slideRoles;

  return {
    ...fallback,
    analysisMode: "multimodal",
    hookPattern: {
      type: compactText(vision?.structure?.hook?.type, 40) || fallback.hookPattern.type,
      description: compactText(vision?.structure?.hook?.description, 200) || fallback.hookPattern.description,
      titleFormula: compactText(vision?.structure?.hook?.titleFormula, 120) || fallback.hookPattern.titleFormula,
    },
    narrativeStructure: {
      summary: compactText(vision?.structure?.narrativeFlow, 320) || fallback.narrativeStructure.summary,
      slideRoles,
    },
    visualLanguage: {
      layout: compactText(vision?.visualLanguage?.layout, 80) || fallback.visualLanguage.layout,
      textDensity: compactText(vision?.visualLanguage?.textDensity, 80) || "图文比例均衡（图片观察）",
      imageTextRatio:
        compactText(vision?.visualLanguage?.imageTextRatio, 80) || "以图承载信息、文字点题（图片观察）",
      colorMood: compactText(vision?.visualLanguage?.color, 80) || fallback.visualLanguage.colorMood,
      typography: compactText(vision?.visualLanguage?.typography, 80) || fallback.visualLanguage.typography,
      composition: compactText(vision?.visualLanguage?.composition, 120) || fallback.visualLanguage.composition,
      source: "reference_image",
      confidence: "medium",
    },
    conversionPattern: {
      type: fallback.conversionPattern.type,
      description:
        compactText(
          [vision?.conversion?.saveReason, vision?.conversion?.interaction].filter(Boolean).join("；"),
          200,
        ) || fallback.conversionPattern.description,
    },
    usableLearningPoints: (Array.isArray(vision?.learningSummary) ? vision.learningSummary : [])
      .map((item) => compactText(item, 120))
      .filter(Boolean)
      .slice(0, 8)
      .concat(["只迁移表达方法，不迁移原品牌与可识别版式"])
      .slice(0, 8),
    learningSummary: (Array.isArray(vision?.learningSummary) ? vision.learningSummary : [])
      .map((item) => compactText(item, 120))
      .filter(Boolean)
      .slice(0, 8),
    meta: {
      ...fallback.meta,
      multimodalUsed: true,
      visionImageCount: selectVisionImageUrls(note?.imageUrls).length,
    },
  };
}

async function analyzeWithOptionalModel(appConfig, note, board, { textModelImpl, analyticsContext } = {}) {
  const base = buildMetadataOnlyAnalysis(note, board);

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
      analyticsContext,
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
        // 优先多模态：真实读参考图片；失败降级 metadata_only，不阻断流程。
        let visionOutcome = null;
        if (supportsMultimodalVision(appConfig) && selectVisionImageUrls(note?.imageUrls).length) {
          visionOutcome = await analyzeExcellentContentVision(appConfig, {
            noteId,
            boardKey: boardDef.value,
            imageUrls: note.imageUrls,
            title: note.title,
            metadata: {
              board: boardDef.value,
              categoryPath: note.categoryPath || "",
              industryPath: note.industryPath || "",
            },
            visionModelImpl: options.visionModelImpl,
          });
        }

        const now = new Date();
        if (visionOutcome?.analysisMode === "multimodal") {
          const analysis = normalizeAnalysis(buildMultimodalAnalysis(note, boardDef.value, visionOutcome), note, boardDef.value);
          upsertRemixAnalysisCache({
            noteId,
            boardKey: boardDef.value,
            sourceSignature,
            analysisVersion: ANALYSIS_VERSION,
            analysisMode: analysis.analysisMode,
            analysis,
            modelName: appConfig?.textProvider?.model || "",
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + MULTIMODAL_ANALYSIS_TTL_MS).toISOString(),
            lastError: "",
          });
          return {
            ...analysis,
            sourceSignature,
            analysisId: cacheKey,
            fromCache: false,
            modelName: appConfig?.textProvider?.model || "",
          };
        }

        const analysis = await analyzeWithOptionalModel(appConfig, note, boardDef.value, {
          textModelImpl: options.textModelImpl,
          analyticsContext: {
            feature: "excellent_direction",
            taskType: "text_generation",
            actorUserId: options.actorUserId ?? options.userId ?? null,
            accountType: options.accountType || "",
            entityType: "excellent_note",
            entityId: `${noteId}:analysis`,
          },
        });
        if (visionOutcome?.warning) {
          // 多模态尝试过但未成功：向用户诚实说明本次分析依据。
          analysis.warning = compactText(visionOutcome.warning, 160) || VISION_FALLBACK_WARNING;
        }
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

function isPlatformDefaultVisualLanguage(analysis) {
  if (!analysis) return true;
  if (analysis.analysisMode === "metadata_only") return true;
  if (analysis.visualLanguage?.source === "platform_default") return true;
  if (analysis.visualLanguage?.confidence === "low" && !analysis.meta?.multimodalUsed) return true;
  return !analysis.meta?.multimodalUsed;
}

function filterAnalysisByLearningFocus(analysis, learningFocus = []) {
  const focus = new Set(
    (Array.isArray(learningFocus) ? learningFocus : [])
      .map((item) => String(item || "").trim())
      .filter((item) => ["structure", "visual", "hook", "conversion"].includes(item)),
  );
  if (!focus.size) {
    focus.add("structure");
    focus.add("hook");
  }
  const applied = [];
  let platformVisualGuidance = null;
  if (focus.has("structure") && analysis?.narrativeStructure) {
    applied.push({
      type: "structure",
      description: compactText(analysis.narrativeStructure.summary, 160),
      slideRoles: analysis.narrativeStructure.slideRoles || [],
    });
  }
  if (focus.has("visual") && analysis?.visualLanguage) {
    const visualDescription = compactText(
      [
        analysis.visualLanguage.layout,
        analysis.visualLanguage.textDensity,
        analysis.visualLanguage.colorMood,
        analysis.visualLanguage.typography,
      ]
        .filter(Boolean)
        .join("；"),
      200,
    );
    if (isPlatformDefaultVisualLanguage(analysis)) {
      // Do not claim reference-image learning for platform defaults.
      platformVisualGuidance = {
        source: "platform_default",
        confidence: analysis.visualLanguage.confidence || "low",
        description: compactText(`平台通用视觉建议（未进行图片理解）：${visualDescription}`, 220),
        visualLanguage: analysis.visualLanguage,
      };
    } else {
      applied.push({
        type: "visual",
        description: visualDescription,
        visualLanguage: analysis.visualLanguage,
      });
    }
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
  return { focus: [...focus], applied, platformVisualGuidance };
}

function __resetRemixAnalysisInFlightForTests() {
  inFlightAnalyses.clear();
}

module.exports = {
  ANALYSIS_VERSION,
  ANALYSIS_TTL_MS,
  MULTIMODAL_ANALYSIS_TTL_MS,
  MAX_ANALYZE_IMAGES,
  buildSourceSignature,
  buildMetadataOnlyAnalysis,
  buildMultimodalAnalysis,
  normalizeAnalysis,
  supportsMultimodalVision,
  analyzeExcellentNoteForRemix,
  getRemixAnalysisById,
  filterAnalysisByLearningFocus,
  isPlatformDefaultVisualLanguage,
  compactText,
  stripHtml,
  __resetRemixAnalysisInFlightForTests,
};
