const brandRepository = require("../db/repositories/brand-repository");
const { findTrendItem } = require("../api/domain-utils");
const { callTextModelJson } = require("../ai/text-provider");
const {
  normalizeGeneratedXhsCarouselPack,
  normalizeRemixBrief,
  XHS_CAROUSEL_SLIDE_COUNT,
} = require("../ai/content-service");
const {
  analyzeExcellentNoteForRemix,
  getRemixAnalysisById,
  filterAnalysisByLearningFocus,
  compactText,
  stripHtml,
} = require("./excellent-remix-analysis-service");
const {
  getExcellentContentBoard,
  getExcellentContentDetail,
} = require("./excellent-content-service");

// Recalibrated for weighted Chinese n-gram scoring (not the old whole-sentence token ratio).
const TREND_RELEVANCE_THRESHOLD = 0.28;
const MAX_CUSTOM_DIRECTION_CHARS = 500;
const MIN_CUSTOM_DIRECTION_CHARS = 5;
const LEARNING_FOCUS_VALUES = new Set(["structure", "visual", "hook", "conversion"]);

const CN_STOPWORDS = new Set([
  "的",
  "了",
  "和",
  "与",
  "或",
  "及",
  "在",
  "是",
  "也",
  "都",
  "就",
  "被",
  "把",
  "对",
  "从",
  "到",
  "而",
  "并",
  "等",
  "着",
  "过",
  "很",
  "更",
  "最",
  "又",
  "还",
  "为",
  "以",
  "之",
  "其",
  "这",
  "那",
  "一个",
  "一种",
  "可以",
  "如何",
  "怎么",
  "什么",
  "为什么",
  "以及",
  "进行",
  "相关",
  "关于",
  "我们",
  "你们",
  "他们",
  "自己",
  "用户",
  "内容",
  "方法",
  "问题",
]);

const DOMAIN_KEYWORDS = [
  "转奶",
  "便便",
  "消化",
  "喂养",
  "母婴",
  "宝宝",
  "新手妈妈",
  "控油",
  "脱妆",
  "底妆",
  "油皮",
  "防晒",
  "护肤",
  "美妆",
  "高温",
  "夏季",
  "妆容",
  "持久",
  "奶粉",
  "过敏",
  "睡眠",
  "辅食",
];

const PAGE_ROLE_LABELS = {
  hook: "开场钩子",
  question: "问题展开",
  comparison: "对比对照",
  scene: "场景还原",
  mistake: "误区避坑",
  evidence: "证据证明",
  explanation: "原理解释",
  method: "方法路径",
  steps: "步骤拆解",
  checklist: "清单整理",
  summary: "要点总结",
  reminder: "边界提醒",
  conclusion: "结论收束",
};

function normalizeLearningFocus(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((item) => String(item || "").trim())
    .filter((item) => LEARNING_FOCUS_VALUES.has(item));
  return list.length ? [...new Set(list)].slice(0, 4) : ["structure", "hook"];
}

function normalizeContentMode(value) {
  const mode = String(value || "").trim();
  if (mode === "existing_idea" || mode === "custom" || mode === "smart") return mode;
  return "smart";
}

function brandToneSummary(brand) {
  return compactText(
    [brand?.description, brand?.goal, brand?.audience].filter(Boolean).join("；") || "清晰、可信、年轻",
    160,
  );
}

function brandProductPoint(brand) {
  return compactText(String(brand?.product || brand?.description || "产品核心价值").split(/[。；\n]/)[0], 80);
}

function pushIdeaFromTrend(results, brand, trend, idea, ideaIndex, meta = {}) {
  results.push({
    brandId: Number(brand.id),
    scope: meta.scope === "snapshot" ? "snapshot" : "current",
    analysisId: meta.analysisId == null ? null : Number(meta.analysisId) || null,
    analysisName: compactText(meta.analysisName, 80) || "",
    analysisTimestamp: compactText(meta.analysisTimestamp, 40) || "",
    trendId: Number(trend.id),
    trendTitle: compactText(trend.title, 120),
    trendSummary: compactText(trend.summary || trend.reason, 200),
    ideaIndex,
    ideaTitle: compactText(idea.title, 120),
    ideaSummary: compactText(idea.summary, 200),
    audience: compactText(idea.audience || brand.audience, 80),
    scene: compactText(idea.angle || idea.hook, 120),
    brandFit: compactText(idea.brandFit, 160),
    hook: compactText(idea.hook, 120),
    tags: Array.isArray(idea.tags) ? idea.tags.slice(0, 6) : [],
  });
}

function flattenTrendBucketsIntoIdeas(results, brand, buckets, meta = {}) {
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const items = Array.isArray(bucket?.items) ? bucket.items : Array.isArray(bucket) ? bucket : [];
    for (const trend of items) {
      if (!trend || trend.id == null) continue;
      const ideas = Array.isArray(trend?.ideas) ? trend.ideas : [];
      ideas.forEach((idea, ideaIndex) => {
        pushIdeaFromTrend(results, brand, trend, idea, ideaIndex, meta);
      });
    }
  }
}

function flattenBrandIdeas(brand) {
  if (!brand) return [];
  const results = [];
  flattenTrendBucketsIntoIdeas(results, brand, brand.trends, { scope: "current", analysisId: null });
  for (const analysis of Array.isArray(brand.analyses) ? brand.analyses : []) {
    flattenTrendBucketsIntoIdeas(results, brand, analysis.trendSnapshot, {
      scope: "snapshot",
      analysisId: Number(analysis.id) || null,
      analysisName: analysis.name || `历史分析 ${analysis.id || ""}`,
      analysisTimestamp: analysis.timestamp || analysis.createdAt || "",
    });
  }
  return results;
}

function findTrendInBuckets(buckets, trendId) {
  const id = Number(trendId);
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const items = Array.isArray(bucket?.items) ? bucket.items : Array.isArray(bucket) ? bucket : [];
    for (const trend of items) {
      if (Number(trend?.id) === id) return trend;
    }
  }
  return null;
}

function resolveExistingIdea(brand, existingIdeaRef = {}) {
  const trendId = Number(existingIdeaRef?.trendId);
  const ideaIndex = Number(existingIdeaRef?.ideaIndex);
  if (!Number.isFinite(trendId) || !Number.isInteger(ideaIndex) || ideaIndex < 0) {
    const error = new Error("请选择有效的已有选题。");
    error.code = "INVALID_IDEA_REF";
    error.statusCode = 400;
    throw error;
  }

  const scope = existingIdeaRef?.scope === "snapshot" ? "snapshot" : "current";
  let trend = null;
  let analysisId = null;
  let analysisName = "";
  let analysisTimestamp = "";

  if (scope === "snapshot") {
    analysisId = Number(existingIdeaRef?.analysisId);
    if (!Number.isFinite(analysisId) || analysisId <= 0) {
      const error = new Error("历史选题缺少有效的 analysisId。");
      error.code = "INVALID_IDEA_REF";
      error.statusCode = 400;
      throw error;
    }
    const analysis = (Array.isArray(brand?.analyses) ? brand.analyses : []).find(
      (item) => Number(item?.id) === analysisId,
    );
    if (!analysis) {
      const error = new Error("所选历史分析不存在或无权访问。");
      error.code = "IDEA_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    trend = findTrendInBuckets(analysis.trendSnapshot, trendId);
    analysisName = compactText(analysis.name, 80);
    analysisTimestamp = compactText(analysis.timestamp || analysis.createdAt, 40);
  } else {
    // Prefer current trends; never silently fall through to another brand's data.
    trend = findTrendItem(brand, trendId) || findTrendInBuckets(brand?.trends, trendId);
    // If client mistakenly sent snapshot ids without scope, do not invent a match from snapshots
    // when the same trendId exists only in history — require explicit scope.
    if (!trend && existingIdeaRef?.analysisId != null && Number(existingIdeaRef.analysisId) > 0) {
      const error = new Error("当前选题引用无效，请重新选择。");
      error.code = "INVALID_IDEA_REF";
      error.statusCode = 400;
      throw error;
    }
  }

  const idea = trend?.ideas?.[ideaIndex];
  if (!trend || !idea) {
    const error = new Error("所选选题不存在或无权访问。");
    error.code = "IDEA_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  return {
    scope,
    analysisId,
    analysisName,
    analysisTimestamp,
    trend,
    idea,
    trendId,
    ideaIndex,
  };
}

function buildDeterministicDirections(brand, analysis) {
  const product = brandProductPoint(brand);
  const audience = compactText(brand.audience, 60) || "目标用户";
  const topic = compactText(analysis?.referenceTopic, 40) || "参考主题";
  const structureHint = compactText(analysis?.narrativeStructure?.slideRoles?.[0]?.role, 20) || "信息结构";

  return [
    {
      id: "theme_transfer",
      transferMode: "theme_transfer",
      title: `${audience}也会遇到的${topic.slice(0, 12)}问题`,
      oneSentence: `把参考笔记的主题迁移到${brand.name}能自然参与的用户问题。`,
      targetAudience: audience,
      scene: `当用户在日常生活中关注「${topic.slice(0, 16)}」相关选择时`,
      userProblem: `想判断什么做法更适合自己，又怕踩坑`,
      contentThesis: `用更贴近${brand.name}使用场景的视角，讲清楚如何做出更稳妥的选择`,
      brandIntegration: `在方法页自然带出${product}，强调可感知的体验差异，不编造功效`,
      whyMatchesReference: "沿用参考笔记主题的用户关注点，但换成当前品牌可服务的问题",
      originalityBoundary: "不复制参考标题与原品牌表述，只迁移问题域",
    },
    {
      id: "structure_transfer",
      transferMode: "structure_transfer",
      title: `${brand.name}用户指南：用${structureHint}讲清选择逻辑`,
      oneSentence: `不沿用原主题，只借用参考笔记的页面结构与表达节奏。`,
      targetAudience: audience,
      scene: `${audience}需要快速建立判断框架的时刻`,
      userProblem: "信息太多，缺少清晰对照与行动顺序",
      contentThesis: `用参考笔记的叙事节奏，重构一套服务${brand.name}的判断框架`,
      brandIntegration: `品牌出现在方法与收束页，用${product}承接可执行建议`,
      whyMatchesReference: "学习结构与节奏，不搬运原主题",
      originalityBoundary: "禁止复用原笔记具体案例、人物与可识别版式",
    },
    {
      id: "brand_problem_transfer",
      transferMode: "brand_problem_transfer",
      title: `${audience}最常卡住的一步，${brand.name}怎么拆开讲`,
      oneSentence: `从品牌真实人群与产品问题出发，借用参考方法重构内容。`,
      targetAudience: audience,
      scene: compactText(brand.description, 80) || "日常使用与决策场景",
      userProblem: compactText(brand.goal, 80) || "希望更省心、更确定地完成选择",
      contentThesis: `围绕${product}对应的真实困扰，给出可收藏的解决路径`,
      brandIntegration: `全篇服务${brand.name}用户，产品卖点以事实与体验表达进入`,
      whyMatchesReference: "借用方法骨架，内容主体来自品牌问题",
      originalityBoundary: "不夸大功效，不引用未经品牌档案支持的承诺",
    },
  ].map((item) => normalizeDirection(item));
}

function normalizeDirection(raw, fallbackId = "theme_transfer") {
  const transferMode = ["theme_transfer", "structure_transfer", "brand_problem_transfer"].includes(raw?.transferMode)
    ? raw.transferMode
    : fallbackId;
  return {
    id: compactText(raw?.id || transferMode, 40) || transferMode,
    transferMode,
    title: compactText(raw?.title, 80),
    oneSentence: compactText(raw?.oneSentence, 160),
    targetAudience: compactText(raw?.targetAudience, 80),
    scene: compactText(raw?.scene, 120),
    userProblem: compactText(raw?.userProblem, 120),
    contentThesis: compactText(raw?.contentThesis, 200),
    brandIntegration: compactText(raw?.brandIntegration, 200),
    whyMatchesReference: compactText(raw?.whyMatchesReference, 160),
    originalityBoundary: compactText(raw?.originalityBoundary, 160),
  };
}

function directionsAreDistinct(directions) {
  if (!Array.isArray(directions) || directions.length !== 3) return false;
  const modes = new Set(directions.map((item) => item.transferMode));
  if (modes.size !== 3) return false;
  const titles = directions.map((item) => item.title);
  if (new Set(titles).size < 3) return false;
  const theses = directions.map((item) => item.contentThesis);
  if (new Set(theses).size < 3) return false;
  return directions.every((item) => item.title && item.contentThesis && item.targetAudience);
}

async function generateContentDirections(
  appConfig,
  {
    userId,
    noteId,
    board,
    brandId,
    sourceAnalysisId,
    learningFocus,
    contentSource,
    categoryPath,
    industryPath,
    textModelImpl,
    analyzeImpl,
  } = {},
) {
  const brand = brandRepository.findBrandByOwner(Number(brandId), Number(userId));
  if (!brand) {
    const error = new Error("当前品牌不存在或你没有访问权限。");
    error.code = "BRAND_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  const safeContentSource = compactText(contentSource, 40) || "all";
  const safeCategoryPath = compactText(categoryPath, 180);
  const safeIndustryPath = compactText(industryPath, 180);
  const analyze = typeof analyzeImpl === "function" ? analyzeImpl : analyzeExcellentNoteForRemix;

  let analysis = sourceAnalysisId ? getRemixAnalysisById(sourceAnalysisId, noteId, board) : null;
  if (!analysis) {
    // Re-analyze with the real request taxonomy context — never hard-code contentSource: "all".
    analysis = await analyze(appConfig, {
      noteId,
      board,
      contentSource: safeContentSource,
      categoryPath: safeCategoryPath,
      industryPath: safeIndustryPath,
      textModelImpl,
    });
  }

  const focus = normalizeLearningFocus(learningFocus);
  const deterministic = buildDeterministicDirections(brand, analysis);
  const modelImpl = textModelImpl || callTextModelJson;

  if (appConfig?.textProvider?.apiKey && typeof modelImpl === "function") {
    try {
      const raw = await modelImpl(appConfig, {
        systemPrompt:
          "你为品牌生成3个明显不同的小红书内容方向。不得复制参考标题，不得使用原品牌，不得编造功效。只输出JSON：{directions: [...3 items]}。transferMode必须分别是 theme_transfer、structure_transfer、brand_problem_transfer。",
        userPrompt: JSON.stringify(
          {
            brand: {
              name: brand.name,
              product: compactText(brand.product, 160),
              audience: compactText(brand.audience, 80),
              description: compactText(brand.description, 160),
              goal: compactText(brand.goal, 120),
            },
            referenceMethod: {
              topic: analysis.referenceTopic,
              hookType: analysis.hookPattern?.type,
              structureSummary: analysis.narrativeStructure?.summary,
              conversionType: analysis.conversionPattern?.type,
            },
            taxonomy: {
              contentSource: safeContentSource,
              categoryPath: safeCategoryPath,
              industryPath: safeIndustryPath,
            },
            learningFocus: focus,
          },
          null,
          2,
        ),
        temperature: 0.5,
        maxOutputTokens: 1600,
        maxAttempts: 2,
      });
      const directions = (Array.isArray(raw?.directions) ? raw.directions : [])
        .map((item, index) =>
          normalizeDirection(item, deterministic[index]?.transferMode || "theme_transfer"),
        )
        .slice(0, 3);
      const byMode = new Map(directions.map((item) => [item.transferMode, item]));
      const merged = deterministic.map((fallback) => byMode.get(fallback.transferMode) || fallback);
      if (directionsAreDistinct(merged)) {
        return { directions: merged, analysisId: analysis.analysisId, brandId: brand.id };
      }
    } catch (_error) {
      // fall through
    }
  }

  return { directions: deterministic, analysisId: analysis.analysisId, brandId: brand.id };
}

/**
 * Tokenize for Chinese/English relevance scoring.
 * Returns weighted tokens with source labels when source is provided.
 */
function tokenizeForRelevance(text, source = "summary") {
  const raw = String(text || "").toLowerCase();
  if (!raw.trim()) return [];
  const tokens = [];
  const seen = new Map();

  function add(token, weight, tokenSource = source) {
    const value = String(token || "").trim();
    if (!value || value.length < 2) return;
    if (CN_STOPWORDS.has(value)) return;
    if (/^[\d.]+$/.test(value) && value.length < 3) return;
    const key = `${tokenSource}:${value}`;
    const prev = seen.get(key);
    if (prev) {
      prev.weight = Math.max(prev.weight, weight);
      return;
    }
    const entry = { token: value, weight, source: tokenSource };
    seen.set(key, entry);
    tokens.push(entry);
  }

  // English / numbers
  const latin = raw.match(/[a-z0-9]{2,}/g) || [];
  for (const part of latin) add(part, 1.0, source);

  // Chinese continuous segments → bigrams + trigrams
  const cnSegments = raw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const segment of cnSegments) {
    if (segment.length === 2) {
      add(segment, 1.1, source);
      continue;
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      add(segment.slice(i, i + 2), 1.0, source);
    }
    for (let i = 0; i < segment.length - 2; i += 1) {
      add(segment.slice(i, i + 3), 1.25, source);
    }
  }

  // Domain dictionary hits on full text
  for (const keyword of DOMAIN_KEYWORDS) {
    if (raw.includes(keyword.toLowerCase())) {
      add(keyword.toLowerCase(), 1.4, source);
    }
  }

  return tokens.slice(0, 120);
}

function scoreTrendRelevance(trend, directionText, brand) {
  const titleTokens = tokenizeForRelevance(trend?.title, "title");
  const tagTokens = tokenizeForRelevance((Array.isArray(trend?.tags) ? trend.tags : []).join(" "), "tag");
  const summaryTokens = tokenizeForRelevance(
    [trend?.summary, trend?.reason, trend?.category].filter(Boolean).join(" "),
    "summary",
  );
  const directionTokens = tokenizeForRelevance(directionText, "direction");
  const audienceTokens = tokenizeForRelevance(
    [brand?.audience, brand?.industry].filter(Boolean).join(" "),
    "audience",
  );

  if (!directionTokens.length) return 0;

  const haystack = new Map();
  for (const entry of [...titleTokens, ...tagTokens, ...summaryTokens]) {
    const weightBoost = entry.source === "title" ? 1.35 : entry.source === "tag" ? 1.15 : 1.0;
    const prev = haystack.get(entry.token) || 0;
    haystack.set(entry.token, Math.max(prev, entry.weight * weightBoost));
  }

  let weightedHits = 0;
  let weightTotal = 0;
  for (const entry of directionTokens) {
    weightTotal += entry.weight;
    const hit = haystack.get(entry.token);
    if (hit) weightedHits += entry.weight * Math.min(1.4, hit);
  }

  // Light audience / industry boost only — brand name must not dominate.
  const audienceHay = new Set(tokenizeForRelevance([trend?.title, ...(trend?.tags || [])].join(" "), "title").map((t) => t.token));
  let audienceBoost = 0;
  for (const entry of audienceTokens) {
    if (audienceHay.has(entry.token)) audienceBoost = 0.08;
  }
  // Explicitly ignore pure brand-name matches as primary signal.
  const brandName = compactText(brand?.name, 40).toLowerCase();
  if (brandName && String(trend?.title || "").toLowerCase().includes(brandName) && weightedHits < 0.5) {
    audienceBoost = Math.min(audienceBoost, 0.03);
  }

  if (weightTotal <= 0) return 0;
  const ratio = weightedHits / Math.max(weightTotal, 3.5);
  return Math.min(1, Number((ratio + audienceBoost).toFixed(3)));
}

function listBrandTrendsFlat(brand) {
  const results = [];
  for (const bucket of Array.isArray(brand?.trends) ? brand.trends : []) {
    for (const trend of Array.isArray(bucket?.items) ? bucket.items : []) {
      results.push(trend);
    }
  }
  return results;
}

async function recommendTrendsForRemix({
  userId,
  brandId,
  contentMode,
  direction = null,
  existingIdeaRef = null,
  customDirection = "",
  sourceAnalysisId = "",
  noteId = "",
  board = "xhs_hot",
} = {}) {
  const brand = brandRepository.findBrandByOwner(Number(brandId), Number(userId));
  if (!brand) {
    const error = new Error("当前品牌不存在或你没有访问权限。");
    error.code = "BRAND_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  const mode = normalizeContentMode(contentMode);
  let directionText = "";
  if (mode === "smart" && direction) {
    directionText = [direction.title, direction.contentThesis, direction.userProblem, direction.scene].join(" ");
  } else if (mode === "custom") {
    directionText = stripHtml(customDirection).slice(0, MAX_CUSTOM_DIRECTION_CHARS);
  } else if (mode === "existing_idea") {
    const resolved = resolveExistingIdea(brand, existingIdeaRef || {});
    directionText = [resolved.idea.title, resolved.idea.summary, resolved.idea.angle, resolved.idea.brandFit].join(" ");
  }

  const analysis = sourceAnalysisId ? getRemixAnalysisById(sourceAnalysisId, noteId, board) : null;
  if (analysis?.referenceTopic) {
    directionText = `${directionText} ${analysis.referenceTopic}`;
  }

  const recommendations = listBrandTrendsFlat(brand)
    .map((trend) => {
      const relevanceScore = scoreTrendRelevance(trend, directionText, brand);
      return {
        trendId: Number(trend.id),
        title: compactText(trend.title, 120),
        summary: compactText(trend.summary || trend.reason, 200),
        relevanceScore,
        matchReason:
          relevanceScore >= TREND_RELEVANCE_THRESHOLD
            ? `与当前内容方向在关键词和人群上有自然重叠（相关度 ${relevanceScore.toFixed(2)}）`
            : "相关性不足",
        usageBoundary: "仅可增强发布时间语境与标题切口，不得改写内容主体",
      };
    })
    .filter((item) => item.relevanceScore >= TREND_RELEVANCE_THRESHOLD)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || a.trendId - b.trendId)
    .slice(0, 3);

  return {
    recommendations,
    recommendation: recommendations.length ? "use_trend" : "no_trend",
    threshold: TREND_RELEVANCE_THRESHOLD,
    message: recommendations.length
      ? ""
      : "当前没有适合自然结合的趋势，建议不关联趋势。",
  };
}

function resolveContentDirectionBundle({ brand, contentMode, smartDirection, existingIdeaRef, customDirection, useTrendContext, trendId }) {
  const mode = normalizeContentMode(contentMode);
  let contentThesis = "";
  let targetAudience = compactText(brand.audience, 80) || "目标用户";
  let userScene = "";
  let brandIntegration = "";
  let ideaRole = "本次未使用已有选题，内容主体来自当前内容方向";
  let ideaTitle = "";
  let resolvedTrend = null;
  let resolvedIdea = null;
  let resolvedIdeaIndex = null;
  let resolvedIdeaScope = null;
  let resolvedAnalysisId = null;

  if (mode === "smart") {
    const direction = normalizeDirection(smartDirection || {});
    if (!direction.title || !direction.contentThesis) {
      const error = new Error("请先选择一个智能生成的内容方向。");
      error.code = "DIRECTION_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    contentThesis = direction.contentThesis;
    targetAudience = direction.targetAudience || targetAudience;
    userScene = direction.scene;
    brandIntegration = direction.brandIntegration;
    ideaTitle = direction.title;
    ideaRole = `智能内容方向（${direction.transferMode}）决定讲什么`;
  } else if (mode === "existing_idea") {
    const resolved = resolveExistingIdea(brand, existingIdeaRef || {});
    resolvedTrend = resolved.trend;
    resolvedIdea = resolved.idea;
    resolvedIdeaIndex = resolved.ideaIndex;
    resolvedIdeaScope = resolved.scope;
    resolvedAnalysisId = resolved.analysisId;
    contentThesis = compactText(resolved.idea.summary || resolved.idea.angle || resolved.idea.title, 200);
    targetAudience = compactText(resolved.idea.audience || brand.audience, 80) || targetAudience;
    userScene = compactText(resolved.idea.angle || resolved.idea.hook, 120);
    brandIntegration = compactText(resolved.idea.brandFit || brandProductPoint(brand), 200);
    ideaTitle = compactText(resolved.idea.title, 120);
    ideaRole = "已有选题决定具体讲什么；父级趋势默认不自动进入，除非开启趋势语境";
  } else {
    const custom = stripHtml(customDirection);
    if (custom.length < MIN_CUSTOM_DIRECTION_CHARS) {
      const error = new Error(`请至少用 ${MIN_CUSTOM_DIRECTION_CHARS} 个字描述这次想讲什么。`);
      error.code = "CUSTOM_DIRECTION_TOO_SHORT";
      error.statusCode = 400;
      throw error;
    }
    if (custom.length > MAX_CUSTOM_DIRECTION_CHARS) {
      const error = new Error(`内容方向最多 ${MAX_CUSTOM_DIRECTION_CHARS} 字。`);
      error.code = "CUSTOM_DIRECTION_TOO_LONG";
      error.statusCode = 400;
      throw error;
    }
    contentThesis = custom.slice(0, 200);
    userScene = custom.slice(0, 120);
    brandIntegration = `在方法与收束页自然植入${brand.name}的${brandProductPoint(brand)}`;
    ideaTitle = compactText(custom, 40) || `${brand.name}原创图文`;
    ideaRole = "用户自述内容方向决定讲什么";
  }

  let trendUsed = false;
  let trendRole = "未启用趋势语境";
  let trendTitle = "";
  let trendSummary = "";

  if (useTrendContext) {
    const chosenTrendId = Number(trendId);
    if (Number.isFinite(chosenTrendId) && chosenTrendId > 0) {
      const trend = findTrendItem(brand, chosenTrendId);
      if (trend) {
        const score = scoreTrendRelevance(
          trend,
          [contentThesis, targetAudience, userScene, ideaTitle].join(" "),
          brand,
        );
        if (score >= TREND_RELEVANCE_THRESHOLD) {
          trendUsed = true;
          resolvedTrend = trend;
          trendTitle = compactText(trend.title, 120);
          trendSummary = compactText(trend.summary || trend.reason, 200);
          trendRole = "趋势仅提供当下讨论背景与标题切口，不改变内容主体";
        } else {
          trendRole = "所选趋势相关性不足，已自动忽略";
        }
      } else {
        trendRole = "所选趋势不存在，已忽略";
      }
    } else {
      trendRole = "已开启趋势语境但未选择有效趋势";
    }
  }

  return {
    mode,
    contentThesis,
    targetAudience,
    userScene,
    brandIntegration,
    ideaRole,
    ideaTitle,
    resolvedTrend,
    resolvedIdea,
    resolvedIdeaIndex,
    resolvedIdeaScope,
    resolvedAnalysisId,
    trendUsed,
    trendRole,
    trendTitle,
    trendSummary,
  };
}

function normalizeSourcePageRole(role, contentFunction = "") {
  const rawRole = String(role || "").trim().toLowerCase();
  if (PAGE_ROLE_LABELS[rawRole]) return rawRole;
  const text = `${role || ""} ${contentFunction || ""}`.toLowerCase();
  if (/(对比|横评|对照|vs|pk|comparison)/.test(text)) return "comparison";
  if (/(证据|实测|亲测|证明|数据|前后|evidence)/.test(text)) return "evidence";
  if (/(误区|避坑|踩坑|别买|千万别|mistake)/.test(text)) return "mistake";
  if (/(问题|疑问|困扰|卡点|question)/.test(text)) return "question";
  if (/(场景|日常|情境|时刻|scene)/.test(text)) return "scene";
  if (/(解释|原因|为什么|原理|机制|explanation)/.test(text)) return "explanation";
  // Prefer method when both 方法/步骤 appear; pure 步骤 maps to steps.
  if (/(方法|怎么做|路径|拆解|method)/.test(text)) return "method";
  if (/(步骤|流程|顺序|第.步|steps)/.test(text)) return "steps";
  if (/(清单|checklist|对照表|收藏点)/.test(text)) return "checklist";
  if (/(结论|收束|行动|号召|conclusion)/.test(text)) return "conclusion";
  if (/(总结|回顾|要点|归纳|summary)/.test(text)) return "summary";
  if (/(提醒|注意|边界|例外|reminder)/.test(text)) return "reminder";
  if (/(钩子|封面|开场|吸引|第一眼|hook)/.test(text)) return "hook";
  return "explanation";
}

function sampleSourceRolesToFour(sourceRoles, learning) {
  if (!sourceRoles.length) return [];
  if (sourceRoles.length === 1) {
    // Never clone the same role four times — expand into a coherent arc.
    const only = sourceRoles[0];
    const firstRole = normalizeSourcePageRole(only.role, only.contentFunction);
    const defaults = defaultSafeFourRoles(learning);
    return [
      { role: only.role || defaults[0].pageRole, contentFunction: only.contentFunction || defaults[0].contentFunction, pageRole: firstRole },
      defaults[1],
      defaults[2],
      defaults[3],
    ];
  }
  if (sourceRoles.length === 2) {
    return [
      sourceRoles[0],
      { role: sourceRoles[0].role, contentFunction: "把开场信息落到具体场景" },
      sourceRoles[1],
      { role: "结论", contentFunction: "收束观点并给出下一步", pageRole: "conclusion" },
    ];
  }
  if (sourceRoles.length === 3) {
    return [
      sourceRoles[0],
      sourceRoles[1],
      sourceRoles[2],
      { role: "结论", contentFunction: "收束前三页判断", pageRole: "conclusion" },
    ];
  }
  const last = sourceRoles.length - 1;
  const indexes = [0, Math.floor(last / 3), Math.floor((last * 2) / 3), last];
  // Ensure unique indexes when length is small multiples.
  const unique = [...new Set(indexes)];
  while (unique.length < 4) {
    unique.push(Math.min(last, unique[unique.length - 1] + 1));
  }
  return unique.slice(0, 4).map((index) => sourceRoles[index]);
}

function defaultSafeFourRoles(learning) {
  const useConversion = learning?.focus?.includes("conversion");
  return [
    { pageRole: "hook", contentFunction: "建立点击理由与主题切口" },
    { pageRole: "question", contentFunction: "展开用户真实困扰" },
    { pageRole: "method", contentFunction: "给出可执行判断路径" },
    {
      pageRole: useConversion ? "checklist" : "conclusion",
      contentFunction: useConversion ? "沉淀可收藏行动点" : "收束观点并给出下一步",
    },
  ];
}

function inferBrandPlacement(pageRole, pageIndex, totalPages) {
  if (pageRole === "hook" || pageRole === "question" || pageRole === "mistake" || pageRole === "scene") {
    return "none";
  }
  if (pageRole === "method" || pageRole === "steps" || pageRole === "evidence" || pageRole === "explanation") {
    return "soft";
  }
  if (pageRole === "checklist" || pageRole === "conclusion" || pageRole === "summary" || pageRole === "reminder") {
    return pageIndex === totalPages - 1 ? "explicit" : "soft";
  }
  return pageIndex === 2 ? "soft" : "none";
}

/**
 * Build a dynamic 4-page fusion blueprint from reference slide roles.
 * Never decides page function solely by hard-coded page index templates.
 */
function buildFourPageFusionBlueprint({
  sourceAnalysis,
  learningFocus,
  contentDirection,
  brand,
  trendContext,
} = {}) {
  const learning = {
    focus: normalizeLearningFocus(learningFocus),
  };
  const sourceRoles = Array.isArray(sourceAnalysis?.narrativeStructure?.slideRoles)
    ? sourceAnalysis.narrativeStructure.slideRoles
    : [];
  const useStructure = learning.focus.includes("structure") && sourceRoles.length > 0;
  const sampled = useStructure ? sampleSourceRolesToFour(sourceRoles, learning) : defaultSafeFourRoles(learning);

  const pages = sampled.slice(0, 4).map((source, index) => {
    const pageRole =
      source.pageRole && PAGE_ROLE_LABELS[source.pageRole]
        ? source.pageRole
        : normalizeSourcePageRole(source.role || source.pageRole, source.contentFunction);
    const contentFunction =
      compactText(source.contentFunction, 120) ||
      PAGE_ROLE_LABELS[pageRole] ||
      "承载当前页信息重点";
    const brandPlacement = inferBrandPlacement(pageRole, index, 4);
    const hookConstraint =
      index === 0 && learning.focus.includes("hook")
        ? compactText(sourceAnalysis?.hookPattern?.titleFormula || sourceAnalysis?.hookPattern?.type, 80)
        : "";
    const conversionConstraint =
      learning.focus.includes("conversion") && (pageRole === "checklist" || pageRole === "conclusion" || index === 3)
        ? compactText(sourceAnalysis?.conversionPattern?.type || sourceAnalysis?.conversionPattern?.description, 80)
        : "";
    return {
      pageRole,
      sourceRole: compactText(source.role || source.pageRole || PAGE_ROLE_LABELS[pageRole], 40),
      contentFunction,
      requiredInformation: compactText(
        [
          contentDirection?.contentThesis || contentDirection?.ideaTitle || "",
          brandPlacement !== "none" ? brandProductPoint(brand) : "",
          trendContext?.trendUsed ? trendContext.trendTitle : "",
        ]
          .filter(Boolean)
          .join("；"),
        160,
      ),
      titleStrategy: buildTitleStrategy(pageRole, {
        hookFormula: sourceAnalysis?.hookPattern?.titleFormula,
        contentDirection,
        brand,
        index,
      }),
      copyStrategy: buildCopyStrategy(pageRole, { contentDirection, brand, brandPlacement }),
      brandPlacement,
      hookConstraint,
      conversionConstraint,
      visualConstraint: compactText(
        learning.focus.includes("visual") ? "保持竖图信息层级，不复制参考版式" : "原创竖图表达",
        80,
      ),
    };
  });

  while (pages.length < 4) {
    pages.push({
      pageRole: "conclusion",
      sourceRole: "结论",
      contentFunction: "收束观点",
      requiredInformation: compactText(contentDirection?.contentThesis, 120),
      titleStrategy: "结论收束",
      copyStrategy: "总结可执行下一步",
      brandPlacement: "soft",
      hookConstraint: "",
      conversionConstraint: "",
      visualConstraint: "原创竖图表达",
    });
  }

  return { pages: pages.slice(0, 4) };
}

function buildTitleStrategy(pageRole, { hookFormula, contentDirection, brand, index }) {
  if (index === 0 && hookFormula) {
    return `封面按钩子公式「${hookFormula}」组织标题，主题：${compactText(contentDirection?.ideaTitle || contentDirection?.contentThesis, 24)}`;
  }
  const roleLabel = PAGE_ROLE_LABELS[pageRole] || pageRole;
  switch (pageRole) {
    case "comparison":
      return `对比式标题：突出选择差异，不写死品牌口号`;
    case "evidence":
      return `证据式标题：强调可观察信号或结果`;
    case "mistake":
      return `误区式标题：指出常见踩坑点`;
    case "question":
      return `问题式标题：点出${compactText(contentDirection?.targetAudience || "用户", 12)}的卡点`;
    case "method":
    case "steps":
      return `方法式标题：给出可执行路径`;
    case "checklist":
      return `清单式标题：便于收藏`;
    case "conclusion":
    case "summary":
      return `收束式标题：沉淀判断`;
    case "reminder":
      return `提醒式标题：补充边界`;
    case "hook":
      return hookFormula ? `钩子公式：${hookFormula}` : "封面钩子标题";
    default:
      return `${roleLabel}标题策略（${brand?.name || "品牌"}语境）`;
  }
}

function buildCopyStrategy(pageRole, { contentDirection, brand, brandPlacement }) {
  const thesis = compactText(contentDirection?.contentThesis, 60);
  const audience = compactText(contentDirection?.targetAudience, 20) || "用户";
  const brandBit =
    brandPlacement === "none"
      ? "本页不出现品牌"
      : brandPlacement === "soft"
        ? `自然承接${brand?.name || "品牌"}事实`
        : `明确展示${brand?.name || "品牌"}产品价值`;
  switch (pageRole) {
    case "comparison":
      return `用对照维度讲清差异；主体：${thesis}；${brandBit}`;
    case "evidence":
      return `用可观察证据支撑判断；主体：${thesis}；${brandBit}`;
    case "mistake":
      return `指出${audience}常见误区与代价；${brandBit}`;
    case "question":
      return `展开${audience}真实困扰与场景；${brandBit}`;
    case "method":
    case "steps":
      return `给出分步方法；${brandBit}`;
    case "checklist":
      return `整理可收藏要点；${brandBit}`;
    case "conclusion":
    case "summary":
      return `收束结论与下一步；${brandBit}`;
    case "reminder":
      return `补充边界与注意事项；${brandBit}`;
    case "hook":
      return `建立点击理由，点题「${thesis}」；${brandBit}`;
    default:
      return `围绕「${thesis}」展开；${brandBit}`;
  }
}

/** @deprecated use buildFourPageFusionBlueprint; kept as thin adapter for older callers/tests */
function mapSlideRolesToFourPages(analysis, learning) {
  const blueprint = buildFourPageFusionBlueprint({
    sourceAnalysis: analysis,
    learningFocus: learning?.focus,
    contentDirection: {},
    brand: {},
    trendContext: {},
  });
  return blueprint.pages.map((page) => ({
    pageRole: PAGE_ROLE_LABELS[page.pageRole] || page.sourceRole || page.pageRole,
    contentGoal: page.contentFunction,
    pageRoleKey: page.pageRole,
    brandPlacement: page.brandPlacement,
  }));
}

function buildSlideLearningApplied(learning, pageIndex, pageRole) {
  const applied = [];
  for (const item of learning.applied || []) {
    if (item.type === "structure") {
      applied.push(`结构：${compactText(item.slideRoles?.[pageIndex]?.role || PAGE_ROLE_LABELS[pageRole] || item.description, 40)}`);
    } else if (item.type === "visual") {
      applied.push(`参考视觉：${compactText(item.visualLanguage?.layout || item.description, 40)}`);
    } else if (item.type === "hook" && (pageIndex === 0 || pageRole === "hook")) {
      applied.push(`钩子：${compactText(item.hookPattern?.type || item.description, 40)}`);
    } else if (
      item.type === "conversion" &&
      (pageRole === "checklist" || pageRole === "conclusion" || pageRole === "summary" || pageIndex === 3)
    ) {
      applied.push(`转化：${compactText(item.conversionPattern?.type || item.description, 40)}`);
    }
  }
  return applied.slice(0, 4);
}

function buildPageTitleAndCopy({ page, index, brand, contentBundle, hook, conversion, learning }) {
  const productPoint = brandProductPoint(brand);
  const role = page.pageRole;
  const roleLabel = PAGE_ROLE_LABELS[role] || page.sourceRole || role;
  let title = "";
  let copy = "";

  if (index === 0 && learning.focus.includes("hook") && hook?.titleFormula) {
    // Hook formula must change cover title strategy (not just store metadata).
    const thesisShort = compactText(contentBundle.ideaTitle || contentBundle.contentThesis, 18);
    if (/疑问|困惑|\?|？/.test(hook.titleFormula)) {
      title = compactText(`${thesisShort}，你卡在哪一步？`, 30);
    } else if (/对比|vs|选项/.test(hook.titleFormula)) {
      title = compactText(`${thesisShort}：先比再选`, 30);
    } else if (/清单|结构|步骤/.test(hook.titleFormula)) {
      title = compactText(`${thesisShort}对照清单`, 30);
    } else if (/警示|避坑|误区/.test(hook.titleFormula)) {
      title = compactText(`${thesisShort}避坑提醒`, 30);
    } else if (/真实|体验|结果/.test(hook.titleFormula)) {
      title = compactText(`${thesisShort}：先看真实变化`, 30);
    } else {
      title = compactText(`${thesisShort}｜${hook.titleFormula}`.slice(0, 28), 30);
    }
    copy = compactText(
      contentBundle.trendUsed
        ? `最近讨论「${contentBundle.trendTitle}」时，很多人会先被这句话拦住：${contentBundle.contentThesis}`
        : `如果你也卡在「${contentBundle.userScene || contentBundle.contentThesis}」，先按这 4 页看完。`,
      150,
    );
    return { title, copy };
  }

  switch (role) {
    case "comparison":
      title = compactText(page.sourceRole || "先比清楚再选", 30);
      copy = compactText(
        `把「${contentBundle.contentThesis}」拆成可对照的维度，方便${contentBundle.targetAudience}快速判断差异。`,
        150,
      );
      break;
    case "evidence":
      title = compactText(page.sourceRole || "可观察的证据", 30);
      copy = compactText(
        `与其凭感觉，不如看这些信号：围绕「${contentBundle.contentThesis}」给出可核对的观察点。`,
        150,
      );
      break;
    case "mistake":
      title = compactText(page.sourceRole || "这些误区先避开", 30);
      copy = compactText(
        `${contentBundle.targetAudience}最容易踩的坑，往往不是不会做，而是方向错了：${contentBundle.userScene || contentBundle.contentThesis}`,
        150,
      );
      break;
    case "question":
      title = compactText(page.sourceRole || "真实困扰", 30);
      copy = compactText(
        `${contentBundle.targetAudience}在${contentBundle.userScene || "日常场景"}里，常被「${contentBundle.contentThesis}」卡住。`,
        150,
      );
      break;
    case "scene":
      title = compactText(page.sourceRole || "先回到场景", 30);
      copy = compactText(`把问题放回具体场景：${contentBundle.userScene || contentBundle.contentThesis}`, 150);
      break;
    case "explanation":
      title = compactText(page.sourceRole || "先把原理讲清", 30);
      copy = compactText(`用更易懂的方式解释「${contentBundle.contentThesis}」背后的判断逻辑。`, 150);
      break;
    case "method":
    case "steps":
      title = compactText(page.sourceRole || "可以这样做", 30);
      copy = compactText(
        page.brandPlacement === "none"
          ? `按可执行顺序处理「${contentBundle.contentThesis}」。`
          : `${contentBundle.brandIntegration || `用${productPoint}承接方法`}，一步步落地。`,
        150,
      );
      break;
    case "checklist":
      title = compactText(
        conversion?.type === "checklist" || learning.focus.includes("conversion")
          ? "收藏这份行动清单"
          : page.sourceRole || "先记下这几条",
        30,
      );
      copy = compactText(
        `适合${contentBundle.targetAudience}的要点清单：围绕「${contentBundle.contentThesis}」保留可执行条目。`,
        150,
      );
      break;
    case "summary":
      title = compactText(page.sourceRole || "先记住这些要点", 30);
      copy = compactText(`把前面的判断收成几条：${contentBundle.contentThesis}`, 150);
      break;
    case "reminder":
      title = compactText(page.sourceRole || "边界提醒", 30);
      copy = compactText(`不是所有情况都一样：结合自身场景调整，优先记住与「${contentBundle.contentThesis}」相关的边界。`, 150);
      break;
    case "conclusion":
      title = compactText(page.sourceRole || "先得出这个结论", 30);
      copy = compactText(
        page.brandPlacement === "explicit"
          ? `结论：围绕「${contentBundle.contentThesis}」，${contentBundle.brandIntegration || productPoint}可作为稳妥选项之一。`
          : `结论先放这里：${contentBundle.contentThesis}`,
        150,
      );
      break;
    case "hook":
    default:
      title = compactText(contentBundle.ideaTitle || roleLabel, 30);
      copy = compactText(
        contentBundle.trendUsed
          ? `最近很多人在关注${contentBundle.trendTitle}；这篇先把「${contentBundle.contentThesis}」讲清楚。`
          : `如果你也卡在「${contentBundle.userScene || contentBundle.contentThesis}」，先看这 4 页。`,
        150,
      );
      break;
  }

  // Soft/explicit brand placement is driven by blueprint, never hard-coded to page 3.
  if (page.brandPlacement === "soft" && role !== "method" && role !== "steps" && !copy.includes(brand.name)) {
    copy = compactText(`${copy}（可自然承接${brand.name}的${productPoint}）`, 150);
  }
  if (page.brandPlacement === "explicit" && !copy.includes(brand.name)) {
    copy = compactText(`${copy} ${brand.name}：${productPoint}`, 150);
  }

  return { title, copy };
}

function buildDeterministicFusionPlan({
  brand,
  note,
  analysis,
  learning,
  contentBundle,
}) {
  const blueprint = buildFourPageFusionBlueprint({
    sourceAnalysis: analysis,
    learningFocus: learning.focus,
    contentDirection: contentBundle,
    brand,
    trendContext: {
      trendUsed: contentBundle.trendUsed,
      trendTitle: contentBundle.trendTitle,
    },
  });
  const originalityGuard =
    "只学习参考笔记的信息节奏、页面角色和内容方法；不得复制原文、原图人物、原品牌、原Logo、水印、具体版式和可识别视觉资产；生成服务当前品牌与当前内容方向的原创内容。";
  const productPoint = brandProductPoint(brand);
  const referenceVisual = (learning.applied || []).find((item) => item.type === "visual")?.visualLanguage || null;
  const platformVisual = learning.platformVisualGuidance?.visualLanguage || null;
  const visualForPrompt = referenceVisual || platformVisual;
  const hook = learning.focus.includes("hook") ? analysis.hookPattern : null;
  const conversion = learning.focus.includes("conversion") ? analysis.conversionPattern : null;

  const slides = blueprint.pages.map((page, index) => {
    const sourceLearningApplied = buildSlideLearningApplied(learning, index, page.pageRole);
    const { title, copy } = buildPageTitleAndCopy({
      page,
      index,
      brand,
      contentBundle,
      hook,
      conversion,
      learning,
    });

    const visualDirection = compactText(
      [
        `围绕${brand.name}与「${contentBundle.ideaTitle || contentBundle.contentThesis}」做原创表达`,
        `本页角色：${PAGE_ROLE_LABELS[page.pageRole] || page.pageRole}`,
        referenceVisual?.layout ? `参考视觉布局倾向：${referenceVisual.layout}` : "",
        !referenceVisual && platformVisual?.layout
          ? `平台通用视觉建议：${platformVisual.layout}（非参考笔记识别结果）`
          : "",
        visualForPrompt?.colorMood && referenceVisual
          ? `氛围：${visualForPrompt.colorMood}`
          : !referenceVisual && platformVisual?.colorMood
            ? `平台通用氛围建议：${platformVisual.colorMood}`
            : "",
      ]
        .filter(Boolean)
        .join("；"),
      200,
    );
    const composition = compactText(
      [
        page.contentFunction,
        "3:4 竖图，一页只讲一个重点",
        referenceVisual?.composition || platformVisual?.composition || "标题克制，产品自然出现",
        visualForPrompt?.textDensity
          ? `${referenceVisual ? "文字密度" : "平台通用文字密度建议"}：${visualForPrompt.textDensity}`
          : "",
      ]
        .filter(Boolean)
        .join("；"),
      300,
    );

    const platformVisualGuidance = learning.platformVisualGuidance
      ? compactText(learning.platformVisualGuidance.description, 200)
      : "";

    const remixBrief = normalizeRemixBrief({
      sourceType: "excellent_content",
      sourceNoteId: String(note.noteId || note.id || ""),
      sourceTitle: compactText(note.title, 120),
      sourceBoard: note.board || note.sourceKey || "xhs_hot",
      sourceCategoryPath: note.categoryPath || "",
      sourceIndustryPath: note.industryPath || "",
      sourceImageCount: Number(note.imageCount || note.imageUrls?.length || 0),
      sourceReadCount: Number(note.metrics?.readCount || 0),
      sourceEngagementCount: Number(note.metrics?.engagementCount || 0),
      contentMode: contentBundle.mode,
      contentDirection: contentBundle.contentThesis,
      targetAudience: contentBundle.targetAudience,
      userScene: contentBundle.userScene,
      trendUsed: contentBundle.trendUsed,
      trendTitle: contentBundle.trendTitle,
      learningFocus: learning.focus,
      pageRole: PAGE_ROLE_LABELS[page.pageRole] || page.pageRole,
      pageTask: page.contentFunction,
      pageTitle: title,
      pageCopy: copy,
      contentGoal: page.contentFunction,
      sourceLearningApplied,
      platformVisualGuidance,
      originalityGuard,
    });

    return {
      pageLabel: `第 ${index + 1} 张`,
      pageRole: PAGE_ROLE_LABELS[page.pageRole] || page.sourceRole || page.pageRole,
      pageRoleKey: page.pageRole,
      brandPlacement: page.brandPlacement,
      title,
      copy,
      contentGoal: page.contentFunction,
      visualDirection,
      style: "小红书图文编辑感，少量短文字、强层级、真实生活气质。",
      composition,
      sourceLearningApplied,
      platformVisualGuidance,
      remixBrief,
      aspectRatio: "3:4",
      prompt: "",
    };
  });

  const publishTitle = compactText(contentBundle.ideaTitle || contentBundle.contentThesis, 40);
  const roleOutline = slides.map((slide) => slide.pageRole).join(" → ");
  const publishCaption = compactText(
    [
      contentBundle.contentThesis,
      contentBundle.trendUsed ? `结合当下「${contentBundle.trendTitle}」讨论语境。` : "",
      `四页结构：${roleOutline}。`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    500,
  );

  const packRemixBrief = normalizeRemixBrief({
    sourceType: "excellent_content",
    sourceNoteId: String(note.noteId || note.id || ""),
    sourceTitle: compactText(note.title, 120),
    sourceBoard: note.board || note.sourceKey || "xhs_hot",
    sourceCategoryPath: note.categoryPath || "",
    sourceIndustryPath: note.industryPath || "",
    sourceImageCount: Number(note.imageCount || note.imageUrls?.length || 0),
    sourceReadCount: Number(note.metrics?.readCount || 0),
    contentMode: contentBundle.mode,
    contentDirection: contentBundle.contentThesis,
    targetAudience: contentBundle.targetAudience,
    userScene: contentBundle.userScene,
    trendUsed: contentBundle.trendUsed,
    trendTitle: contentBundle.trendTitle,
    learningFocus: learning.focus,
    platformVisualGuidance: learning.platformVisualGuidance
      ? compactText(learning.platformVisualGuidance.description, 200)
      : "",
    originalityGuard,
  });

  const carouselPack = normalizeGeneratedXhsCarouselPack({
    title: publishTitle,
    publishTitle,
    publishCaption,
    caption: publishCaption,
    aspectRatio: "3:4",
    sourceTemplate: {
      noteId: String(note.noteId || note.id || ""),
      title: note.title || "",
      sourceUrl: note.noteUrl || "",
      source: note.board || note.sourceKey || "xhs_hot",
      board: note.board || note.sourceKey || "xhs_hot",
      contentSource: note.contentSource || "all",
    },
    remixBrief: packRemixBrief,
    slides,
  });

  const referenceLearningApplied = (learning.applied || []).map((item) => ({
    type: item.type,
    description: compactText(item.description, 160),
  }));

  return {
    fusionSummary: compactText(
      `用参考笔记的「${referenceLearningApplied.map((item) => item.type).join("、") || "结构"}」方法，讲述「${contentBundle.contentThesis}」，服务${brand.name}。`,
      240,
    ),
    contentMode: contentBundle.mode,
    contentThesis: contentBundle.contentThesis,
    targetAudience: contentBundle.targetAudience,
    userScene: contentBundle.userScene,
    sourceRole: "参考笔记只决定怎么讲：钩子、结构、视觉节奏与转化方式",
    brandRole: `品牌提供产品事实、语气与目标人群：${brand.name}`,
    ideaRole: contentBundle.ideaRole,
    trendRole: contentBundle.trendRole,
    trendUsed: contentBundle.trendUsed,
    trendTitle: contentBundle.trendTitle,
    trendSummary: contentBundle.trendSummary,
    referenceLearningApplied,
    platformVisualGuidance: learning.platformVisualGuidance
      ? {
          source: learning.platformVisualGuidance.source || "platform_default",
          confidence: learning.platformVisualGuidance.confidence || "low",
          description: compactText(learning.platformVisualGuidance.description, 200),
        }
      : null,
    brandIntegration: contentBundle.brandIntegration,
    originalityGuard,
    fusionBlueprint: blueprint,
    carouselPack,
  };
}

async function buildExcellentRemixFusionPlan(appConfig, options = {}) {
  const userId = Number(options.userId);
  const brandId = Number(options.brandId);
  const brand = brandRepository.findBrandByOwner(brandId, userId);
  if (!brand) {
    const error = new Error("当前品牌不存在或你没有访问权限。");
    error.code = "BRAND_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  const boardDef = getExcellentContentBoard(options.board || "xhs_hot");
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }

  const noteId = compactText(options.noteId, 80);
  const detail = await getExcellentContentDetail(appConfig, {
    noteId,
    board: boardDef.value,
    contentSource: options.contentSource || "all",
    categoryPath: options.categoryPath || "",
    industryPath: options.industryPath || "",
  });
  const note = detail?.item;
  if (!note) {
    const error = new Error("当前优秀内容缓存中找不到该笔记。");
    error.code = "NOTE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  note.board = boardDef.value;

  let analysis = options.sourceAnalysisId
    ? getRemixAnalysisById(options.sourceAnalysisId, noteId, boardDef.value)
    : null;
  if (!analysis) {
    analysis = await analyzeExcellentNoteForRemix(appConfig, {
      noteId,
      board: boardDef.value,
      contentSource: options.contentSource || "all",
      categoryPath: options.categoryPath || "",
      industryPath: options.industryPath || "",
      textModelImpl: options.textModelImpl,
    });
  }

  const learningFocus = normalizeLearningFocus(options.learningFocus);
  const learning = filterAnalysisByLearningFocus(analysis, learningFocus);
  const contentBundle = resolveContentDirectionBundle({
    brand,
    contentMode: options.contentMode,
    smartDirection: options.smartDirection,
    existingIdeaRef: options.existingIdeaRef,
    customDirection: options.customDirection,
    useTrendContext: Boolean(options.useTrendContext),
    trendId: options.trendId,
  });

  const plan = buildDeterministicFusionPlan({
    brand,
    note,
    analysis,
    learning,
    contentBundle,
  });

  if (!plan.carouselPack?.slides || plan.carouselPack.slides.length !== XHS_CAROUSEL_SLIDE_COUNT) {
    const error = new Error("融合方案必须包含 4 页组图。");
    error.code = "INVALID_FUSION_PLAN";
    error.statusCode = 500;
    throw error;
  }

  return {
    ...plan,
    analysisId: analysis.analysisId,
    analysisMode: analysis.analysisMode,
    brandId: brand.id,
    noteId,
    board: boardDef.value,
  };
}

/**
 * Server-side history attribution. Never trusts client trendTitle/ideaTitle.
 */
function resolveExcellentRemixHistoryAttribution(brand, payload = {}) {
  const contentMode = normalizeContentMode(payload.contentMode);
  if (contentMode === "existing_idea") {
    const resolved = resolveExistingIdea(brand, payload.existingIdeaRef || {});
    return {
      contentMode,
      trendId: Number(resolved.trendId) || 0,
      trendTitle: compactText(resolved.trend.title, 120),
      ideaTitle: compactText(resolved.idea.title, 120),
      existingIdeaRef: {
        scope: resolved.scope,
        analysisId: resolved.analysisId,
        trendId: resolved.trendId,
        ideaIndex: resolved.ideaIndex,
      },
      trend: { id: Number(resolved.trendId) || 0, title: compactText(resolved.trend.title, 120) },
      idea: { title: compactText(resolved.idea.title, 120) },
    };
  }

  const packTitle = compactText(
    payload.carouselPack?.publishTitle || payload.carouselPack?.title || "",
    120,
  );
  const ideaTitle =
    packTitle ||
    compactText(payload.fusionPlan?.contentThesis, 80) ||
    `${compactText(brand?.name, 20) || "品牌"}优秀内容仿图文`;

  return {
    contentMode,
    trendId: 0,
    trendTitle: "",
    ideaTitle: compactText(ideaTitle, 120),
    existingIdeaRef: null,
    trend: { id: 0, title: "" },
    idea: { title: compactText(ideaTitle, 120) },
  };
}

module.exports = {
  TREND_RELEVANCE_THRESHOLD,
  MAX_CUSTOM_DIRECTION_CHARS,
  MIN_CUSTOM_DIRECTION_CHARS,
  PAGE_ROLE_LABELS,
  normalizeLearningFocus,
  normalizeContentMode,
  flattenBrandIdeas,
  resolveExistingIdea,
  buildDeterministicDirections,
  directionsAreDistinct,
  generateContentDirections,
  recommendTrendsForRemix,
  scoreTrendRelevance,
  tokenizeForRelevance,
  normalizeSourcePageRole,
  buildFourPageFusionBlueprint,
  mapSlideRolesToFourPages,
  buildExcellentRemixFusionPlan,
  resolveExcellentRemixHistoryAttribution,
  brandProductPoint,
  brandToneSummary,
};
