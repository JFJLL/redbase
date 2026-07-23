const brandRepository = require("../db/repositories/brand-repository");
const { findTrendItem } = require("../api/domain-utils");
const { callTextModelJson } = require("../ai/text-provider");
const {
  normalizeGeneratedXhsCarouselPack,
  normalizeRemixBrief,
  XHS_CAROUSEL_SLIDE_COUNT,
} = require("../ai/content-service");
const {
  ANALYSIS_VERSION,
  analyzeExcellentNoteForRemix,
  getRemixAnalysisById,
  filterAnalysisByLearningFocus,
  compactText,
  stripHtml,
  buildMetadataOnlyAnalysis,
} = require("./excellent-remix-analysis-service");
const {
  getExcellentContentBoard,
  getExcellentContentDetail,
} = require("./excellent-content-service");

const TREND_RELEVANCE_THRESHOLD = 0.6;
const MAX_CUSTOM_DIRECTION_CHARS = 500;
const MIN_CUSTOM_DIRECTION_CHARS = 5;
const LEARNING_FOCUS_VALUES = new Set(["structure", "visual", "hook", "conversion"]);

function normalizeLearningFocus(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((item) => String(item || "").trim())
    .filter((item) => LEARNING_FOCUS_VALUES.has(item));
  return list.length ? [...new Set(list)].slice(0, 4) : ["structure", "visual"];
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

function flattenBrandIdeas(brand) {
  if (!brand) return [];
  const results = [];
  const buckets = Array.isArray(brand.trends) ? brand.trends : [];
  for (const bucket of buckets) {
    const items = Array.isArray(bucket?.items) ? bucket.items : [];
    for (const trend of items) {
      const ideas = Array.isArray(trend?.ideas) ? trend.ideas : [];
      ideas.forEach((idea, ideaIndex) => {
        results.push({
          brandId: Number(brand.id),
          analysisId: Number(trend.analysisId || 0) || null,
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
      });
    }
  }
  return results;
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
  const trend = findTrendItem(brand, trendId);
  const idea = trend?.ideas?.[ideaIndex];
  if (!trend || !idea) {
    const error = new Error("所选选题不存在或无权访问。");
    error.code = "IDEA_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  return { trend, idea, trendId, ideaIndex };
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

async function generateContentDirections(appConfig, { userId, noteId, board, brandId, sourceAnalysisId, learningFocus, textModelImpl } = {}) {
  const brand = brandRepository.findBrandByOwner(Number(brandId), Number(userId));
  if (!brand) {
    const error = new Error("当前品牌不存在或你没有访问权限。");
    error.code = "BRAND_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  let analysis = sourceAnalysisId ? getRemixAnalysisById(sourceAnalysisId, noteId, board) : null;
  if (!analysis) {
    analysis = await analyzeExcellentNoteForRemix(appConfig, {
      noteId,
      board,
      contentSource: "all",
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
      // Ensure required modes exist and fill missing with deterministic.
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

function tokenizeForRelevance(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 40);
}

function scoreTrendRelevance(trend, directionText, brand) {
  const haystack = tokenizeForRelevance(
    [trend?.title, trend?.summary, trend?.reason, trend?.category, ...(trend?.tags || [])].join(" "),
  );
  const needles = tokenizeForRelevance(
    [directionText, brand?.name, brand?.product, brand?.audience, brand?.industry].join(" "),
  );
  if (!haystack.length || !needles.length) return 0;
  const hayset = new Set(haystack);
  let hits = 0;
  for (const token of needles) {
    if (hayset.has(token)) hits += 1;
  }
  const ratio = hits / Math.max(4, Math.min(needles.length, 12));
  // Light boost if trend tags overlap audience keywords.
  const audienceHit = tokenizeForRelevance(brand?.audience).some((token) => hayset.has(token));
  return Math.min(1, Number((ratio + (audienceHit ? 0.12 : 0)).toFixed(3)));
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
        // Relevance gate again at fusion time.
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
    trendUsed,
    trendRole,
    trendTitle,
    trendSummary,
  };
}

function mapSlideRolesToFourPages(analysis, learning) {
  const sourceRoles = Array.isArray(analysis?.narrativeStructure?.slideRoles)
    ? analysis.narrativeStructure.slideRoles
    : [];
  const useStructure = learning.focus.includes("structure") && sourceRoles.length > 0;
  if (!useStructure) {
    // Still dynamic-ish defaults but not the forbidden hard-coded product copy sequence as sole path.
    return [
      { pageRole: "开场钩子", contentGoal: "建立点击理由" },
      { pageRole: "问题展开", contentGoal: "讲清用户困扰" },
      { pageRole: "方法路径", contentGoal: "给出可执行判断" },
      { pageRole: "收束行动", contentGoal: "沉淀可收藏要点" },
    ];
  }

  // Preserve narrative rhythm from reference, remapped into exactly 4 pages.
  if (sourceRoles.length === 1) {
    const role = sourceRoles[0];
    return [
      { pageRole: role.role || "开场", contentGoal: role.contentFunction || "建立主题" },
      { pageRole: "展开", contentGoal: "把问题拆成可理解的场景" },
      { pageRole: "方法", contentGoal: "给出品牌可承接的路径" },
      { pageRole: "收束", contentGoal: "形成可收藏清单" },
    ];
  }
  if (sourceRoles.length === 2) {
    return [
      { pageRole: sourceRoles[0].role, contentGoal: sourceRoles[0].contentFunction },
      { pageRole: `${sourceRoles[0].role}深化`, contentGoal: "把开场信息落到具体场景" },
      { pageRole: sourceRoles[1].role, contentGoal: sourceRoles[1].contentFunction },
      { pageRole: "收束清单", contentGoal: "整理可收藏行动点" },
    ];
  }
  if (sourceRoles.length === 3) {
    return [
      { pageRole: sourceRoles[0].role, contentGoal: sourceRoles[0].contentFunction },
      { pageRole: sourceRoles[1].role, contentGoal: sourceRoles[1].contentFunction },
      { pageRole: sourceRoles[2].role, contentGoal: sourceRoles[2].contentFunction },
      { pageRole: "收藏收束", contentGoal: "把前三页收敛成行动清单" },
    ];
  }
  // 4+ pages: sample first, mid-early, mid-late, last to keep rhythm.
  const indexes = [0, Math.floor((sourceRoles.length - 1) / 3), Math.floor(((sourceRoles.length - 1) * 2) / 3), sourceRoles.length - 1];
  return indexes.map((index) => ({
    pageRole: sourceRoles[index].role || `页面${index + 1}`,
    contentGoal: sourceRoles[index].contentFunction || "承载当前页信息",
  }));
}

function buildSlideLearningApplied(learning, pageIndex) {
  const applied = [];
  for (const item of learning.applied) {
    if (item.type === "structure") {
      applied.push(`结构：${compactText(item.slideRoles?.[pageIndex]?.role || item.description, 40)}`);
    } else if (item.type === "visual") {
      applied.push(`视觉：${compactText(item.visualLanguage?.layout || item.description, 40)}`);
    } else if (item.type === "hook" && pageIndex === 0) {
      applied.push(`钩子：${compactText(item.hookPattern?.type || item.description, 40)}`);
    } else if (item.type === "conversion" && pageIndex === 3) {
      applied.push(`转化：${compactText(item.conversionPattern?.type || item.description, 40)}`);
    }
  }
  return applied.slice(0, 4);
}

function buildDeterministicFusionPlan({
  brand,
  note,
  analysis,
  learning,
  contentBundle,
}) {
  const pagePlans = mapSlideRolesToFourPages(analysis, learning);
  const originalityGuard =
    "只学习参考笔记的信息节奏、页面角色和内容方法；不得复制原文、原图人物、原品牌、原Logo、水印、具体版式和可识别视觉资产；生成服务当前品牌与当前内容方向的原创内容。";
  const productPoint = brandProductPoint(brand);
  const visual = learning.focus.includes("visual") ? analysis.visualLanguage : null;
  const hook = learning.focus.includes("hook") ? analysis.hookPattern : null;
  const conversion = learning.focus.includes("conversion") ? analysis.conversionPattern : null;

  const slides = pagePlans.map((page, index) => {
    const sourceLearningApplied = buildSlideLearningApplied(learning, index);
    let title = "";
    let copy = "";
    if (index === 0) {
      title = compactText(
        hook?.titleFormula
          ? `${contentBundle.ideaTitle}`.slice(0, 24)
          : contentBundle.ideaTitle || contentBundle.contentThesis,
        30,
      );
      copy = compactText(
        contentBundle.trendUsed
          ? `最近很多人在关注${contentBundle.trendTitle}；这篇先把「${contentBundle.contentThesis}」讲清楚。`
          : `如果你也卡在「${contentBundle.userScene || contentBundle.contentThesis}」，先看这 4 页。`,
        150,
      );
    } else if (index === 1) {
      title = compactText(page.pageRole || "真实困扰", 30);
      copy = compactText(
        `${contentBundle.targetAudience}在${contentBundle.userScene || "日常场景"}里，常遇到：${contentBundle.contentThesis}`,
        150,
      );
    } else if (index === 2) {
      title = compactText(`${brand.name}可以这样拆`, 30);
      copy = compactText(contentBundle.brandIntegration || productPoint, 150);
    } else {
      title = compactText(conversion?.type === "checklist" ? "收藏这份行动清单" : "先记下这几步", 30);
      copy = compactText(
        `适合${contentBundle.targetAudience}：按自己的场景调整，优先记住与${productPoint}相关的判断点。`,
        150,
      );
    }

    const visualDirection = compactText(
      [
        `围绕${brand.name}与「${contentBundle.ideaTitle || contentBundle.contentThesis}」做原创表达`,
        page.pageRole ? `本页角色：${page.pageRole}` : "",
        visual?.layout ? `版式倾向：${visual.layout}` : "",
        visual?.colorMood ? `氛围：${visual.colorMood}` : "",
      ]
        .filter(Boolean)
        .join("；"),
      200,
    );
    const composition = compactText(
      [
        `${page.contentGoal}`,
        "3:4 竖图，一页只讲一个重点",
        visual?.composition || "标题克制，产品自然出现",
        visual?.textDensity ? `文字密度：${visual.textDensity}` : "",
      ]
        .filter(Boolean)
        .join("；"),
      300,
    );

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
      pageRole: page.pageRole,
      pageTask: page.contentGoal,
      pageTitle: title,
      pageCopy: copy,
      contentGoal: page.contentGoal,
      sourceLearningApplied,
      originalityGuard,
    });

    return {
      pageLabel: `第 ${index + 1} 张`,
      pageRole: page.pageRole,
      title,
      copy,
      contentGoal: page.contentGoal,
      visualDirection,
      style: "小红书图文编辑感，少量短文字、强层级、真实生活气质。",
      composition,
      sourceLearningApplied,
      remixBrief,
      aspectRatio: "3:4",
      prompt: "",
    };
  });

  const publishTitle = compactText(contentBundle.ideaTitle || contentBundle.contentThesis, 40);
  const publishCaption = compactText(
    [
      contentBundle.contentThesis,
      contentBundle.trendUsed ? `结合当下「${contentBundle.trendTitle}」讨论语境。` : "",
      "拆成 4 张图：先讲清楚问题，再给方法，最后留下可收藏要点。",
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

  return {
    fusionSummary: compactText(
      `用参考笔记的「${learning.applied.map((item) => item.type).join("、") || "结构"}」方法，讲述「${contentBundle.contentThesis}」，服务${brand.name}。`,
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
    referenceLearningApplied: learning.applied.map((item) => ({
      type: item.type,
      description: compactText(item.description, 160),
    })),
    brandIntegration: contentBundle.brandIntegration,
    originalityGuard,
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

  // Prefer deterministic fusion for stability; optional model refinement can be added later.
  // Avoid failing closed when text AI is unavailable.
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

module.exports = {
  TREND_RELEVANCE_THRESHOLD,
  MAX_CUSTOM_DIRECTION_CHARS,
  MIN_CUSTOM_DIRECTION_CHARS,
  normalizeLearningFocus,
  normalizeContentMode,
  flattenBrandIdeas,
  resolveExistingIdea,
  buildDeterministicDirections,
  directionsAreDistinct,
  generateContentDirections,
  recommendTrendsForRemix,
  scoreTrendRelevance,
  mapSlideRolesToFourPages,
  buildExcellentRemixFusionPlan,
  brandProductPoint,
  brandToneSummary,
};
