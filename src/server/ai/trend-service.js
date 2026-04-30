const { clampScore, normalizeTags, sanitizeIdea } = require("../utils");
const { callTextModelJson } = require("./text-provider");

const TREND_BUCKET_META = [
  {
    key: "xhs",
    title: "小红书热点话题",
    description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
    promptDescription: "聚焦小红书站内高讨论、高收藏、高互动、易被笔记化的话题方向。",
  },
  {
    key: "news",
    title: "新闻热点趋势",
    description: "从近期新闻、行业动态和消费趋势中找到可被品牌内容化的机会。",
    promptDescription: "聚焦近期新闻、行业动态、消费趋势中可内容化的机会。",
  },
  {
    key: "social",
    title: "社会热点趋势",
    description: "从大众情绪、生活方式变化、社会议题和公共讨论中找到适合品牌表达的切口。",
    promptDescription: "聚焦大众情绪、生活方式变化、社会议题、节日节点和公共讨论中适合品牌表达的切口。",
  },
  {
    key: "traffic",
    title: "流量热点趋势",
    description: "从小红书站内爆款形式、标题结构、场景表达和内容套路中找到流量机会。",
    promptDescription: "聚焦小红书站内正在被大量模仿、搜索、转发或评论的内容形式、标题结构、场景表达和爆款笔记套路。",
  },
  {
    key: "track",
    title: "赛道热点趋势",
    description: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
    promptDescription: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
  },
  {
    key: "crowd",
    title: "人群热点趋势",
    description: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
    promptDescription: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
  },
];

function formatBucketKeys(bucketMeta) {
  return bucketMeta.map((bucket) => bucket.key).join("、");
}

function formatBucketTitles(bucketMeta) {
  return bucketMeta.map((bucket) => bucket.title).join("、");
}

function buildTrendAnalysisSystemPrompt(bucketMeta = TREND_BUCKET_META) {
  const bucketLines = bucketMeta.map((bucket) => `${bucket.key} 标题为${bucket.title}，${bucket.promptDescription}`);
  return [
    "你是资深小红书内容运营策略顾问，擅长品牌定位、热点适配判断与内容选题策划。",
    `你的任务是根据品牌档案，围绕小红书平台上的真实内容语境，分 ${bucketMeta.length} 个维度输出适合该品牌借势的热点趋势，并给出可执行内容选题。`,
    "所有趋势都要优先判断其在小红书上的讨论价值、内容扩散潜力、用户搜索/收藏/互动意愿和品牌适配度，不要写成泛泛的全网热点报告。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"trendBuckets":[...]}。',
    `trendBuckets 必须输出 ${bucketMeta.length} 个对象，key 分别是 ${formatBucketKeys(bucketMeta)}。`,
    ...bucketLines,
    "每个 bucket 必须包含：key, title, description, items。",
    "每个 items 必须输出 10 条 trend。",
    "每条 trend 必须包含：title, category, summary, score, tags, reason, ideas。",
    "score 必须是 0 到 100 的整数，代表热度指数。",
    "热度指数评分标准：90-100 为爆发级热点，站内讨论强、内容供给增长快、品牌借势窗口短；80-89 为高潜热点，搜索/互动趋势明显，适合快速布局；70-79 为稳定热点，有持续内容需求，适合做系列化内容；60-69 为长尾热点，适合垂直人群或细分场景；60 以下为弱热点，除非品牌强相关，否则不建议优先选择。",
    "评分时综合考虑：小红书站内讨论度、搜索意图、互动/收藏潜力、内容可复制性、目标人群相关性、品牌自然植入度和近期时效性。不要编造具体播放量、搜索量、排名或机构数据。",
    "tags 必须是 3 到 5 个以 # 开头的字符串。",
    "ideas 必须是 2 条，每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags。",
    "所有字段都用中文输出，允许品牌名保留原文。",
  ].join("\n");
}

function truncateForPrompt(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil(maxLength * 0.72);
  const tailLength = Math.max(80, maxLength - headLength - 18);
  return `${text.slice(0, headLength)}……（中间内容已压缩）……${text.slice(-tailLength)}`;
}

function compactBrandForPrompt(brand, mode = "standard") {
  const compact = mode === "minimal";
  return {
    ...brand,
    name: truncateForPrompt(brand.name, 80),
    industry: truncateForPrompt(brand.industry, 120),
    audience: truncateForPrompt(brand.audience, compact ? 180 : 320),
    description: truncateForPrompt(brand.description, compact ? 420 : 900),
    product: truncateForPrompt(brand.product, compact ? 360 : 700),
    goal: truncateForPrompt(brand.goal, compact ? 220 : 420),
    knowledgeBase: truncateForPrompt(brand.knowledgeBase, compact ? 360 : 900),
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags.slice(0, 6) : [],
  };
}

function buildTrendAnalysisUserPrompt(brand, options = {}, bucketMeta = TREND_BUCKET_META) {
  const promptBrand = options.minimal ? compactBrandForPrompt(brand, "minimal") : brand;
  const strictLines = options.strict
    ? [
        `重要：必须返回 trendBuckets，且 ${formatBucketKeys(bucketMeta)} ${bucketMeta.length} 个 bucket 的 items 都不能为空。`,
        "如果搜索结果不足，请基于可验证的趋势方向表达，不要编造具体机构、日期或数据。",
        "只返回 JSON 对象，不要解释失败原因，不要输出自然语言说明。",
      ]
    : [];
  return [
    `请基于以下品牌信息，围绕小红书平台的热点话题与内容机会，按 ${bucketMeta.length} 个维度生成热点趋势与选题。`,
    "",
    `品牌名称：${promptBrand.name}`,
    `行业：${promptBrand.industry}`,
    `目标受众：${promptBrand.audience}`,
    `品牌介绍：${promptBrand.description}`,
    `产品/服务：${promptBrand.product}`,
    `运营目标：${promptBrand.goal}`,
    `品牌资料库：${promptBrand.knowledgeBase || "暂无补充资料"}`,
    `品牌资产标签：${(promptBrand.assetTags || []).join("、") || "暂无"}`,
    "",
    "要求：",
    `1. 每个维度都输出 10 条趋势，共 ${bucketMeta.length * 10} 条。`,
    `2. ${bucketMeta.length} 个维度依次为：${formatBucketTitles(bucketMeta)}。`,
    "3. 趋势名称要像真实小红书内容方向，而不是宏观行业报告标题。",
    "4. 每条趋势都要解释为什么适合该品牌，尤其说明它和品牌、人群、内容场景之间的自然连接。",
    "5. score 要严格按热度指数评分标准给出，不要所有趋势都给高分；优先把 80 分以上留给真正具备快速借势价值的趋势。",
    "6. 选题要能直接给运营同学使用，标题、角度、钩子都要有小红书笔记感，避免空泛文案。",
    "7. 如果涉及新闻、社会议题或近期热点，请表达为可验证的趋势或议题方向，不要编造具体机构、日期、排名或数据。",
    ...strictLines,
  ].join("\n");
}

function buildIdeaRegenerationSystemPrompt() {
  return [
    "你是一名小红书内容策划专家，擅长把品牌资产与热点趋势组合成可执行选题。",
    "请只输出 JSON，不要输出 Markdown，不要补充解释。",
    'JSON 顶层结构必须是：{"ideas":[...]}。',
    "ideas 必须输出 2 条。",
    "每条 idea 必须包含：title, summary, angle, brandFit, audience, hook, tags。",
    "tags 必须是 3 到 5 个以 # 开头的字符串。",
    "所有字段用中文输出。",
  ].join("\n");
}

function buildIdeaRegenerationUserPrompt(brand, trend, customPrompt) {
  const lines = [
    "请围绕下面这条热点，为品牌重新生成 2 条更适合的小红书内容选题。",
    "",
    `品牌名称：${brand.name}`,
    `行业：${brand.industry}`,
    `目标受众：${brand.audience}`,
    `品牌介绍：${brand.description}`,
    `产品/服务：${brand.product}`,
    `运营目标：${brand.goal}`,
    `品牌资料库：${brand.knowledgeBase || "暂无补充资料"}`,
    `品牌资产标签：${(brand.assetTags || []).join("、") || "暂无"}`,
    "",
    `热点标题：${trend.title}`,
    `热点分类：${trend.category}`,
    `热点摘要：${trend.summary}`,
    `热点适配原因：${trend.reason}`,
  ];
  lines.push(customPrompt ? `补充要求：${customPrompt}` : "补充要求：无，请给出默认版本。");
  lines.push("请保持品牌相关性和小红书内容感，不要输出过度营销化的空话。");
  return lines.join("\n");
}

function getSystemIdeaPrompt(brand, trend) {
  return [
    "你是一名小红书内容策划专家。",
    `品牌名称：${brand.name}`,
    `行业：${brand.industry}`,
    `目标受众：${brand.audience}`,
    `产品/服务：${brand.product}`,
    `运营目标：${brand.goal}`,
    `品牌资料库：${brand.knowledgeBase || "暂无额外资料库"}`,
    `品牌资产标签：${(brand.assetTags || []).join("、")}`,
    `热点标题：${trend.title}`,
    `热点分类：${trend.category}`,
    `热点适配原因：${trend.reason}`,
    "请生成适合该品牌的小红书内容选题，输出标题、内容摘要、切入角度、品牌结合方式、面向人群、开头钩子和推荐标签。",
  ].join("\n");
}

function normalizeTrendSet(rawTrends, brand, baseId) {
  const source = Array.isArray(rawTrends) ? rawTrends : rawTrends && typeof rawTrends === "object" ? Object.values(rawTrends) : [];
  return source
    .map(normalizeRawTrend)
    .filter((trend) => trend.title || trend.summary || trend.reason)
    .slice(0, 10)
    .map((trend, index) => ({
    id: baseId + index + 1,
    rank: index + 1,
    title: String(trend?.title || `趋势方向 ${index + 1}`),
    category: String(trend?.category || "内容趋势"),
    summary: String(trend?.summary || "暂无趋势摘要"),
    score: clampScore(trend?.score),
    tags: normalizeTags(trend?.tags, [`#${brand.name}`]),
    reason: String(trend?.reason || "暂无适配原因"),
    ideas: Array.isArray(trend?.ideas) && trend.ideas.length
      ? trend.ideas.slice(0, 2).map((idea) => sanitizeIdea(normalizeRawIdea(idea), brand.audience, `#${brand.name}`))
      : [],
    customPrompt: "",
    systemPrompt: "",
  }));
}

function normalizeRawTrend(trend) {
  if (typeof trend === "string") {
    return { title: trend };
  }
  if (!trend || typeof trend !== "object") return {};
  return {
    ...trend,
    title: trend.title || trend.name || trend.topic || trend.keyword || "",
    category: trend.category || trend.type || trend.bucket || trend.dimension || trend.scene || trend.tag || "",
    summary: trend.summary || trend.description || trend.desc || trend.insight || trend.content || trend.overview || trend.explanation || "",
    score: trend.score ?? trend.heat ?? trend.heatScore ?? trend.index ?? trend.popularity ?? trend.hotScore ?? trend.hotIndex,
    tags: trend.tags || trend.tagList || trend.hashtags || [],
    reason: trend.reason || trend.fitReason || trend.brandReason || trend.why || trend.rationale || trend.brandFitReason || trend.suitability || "",
    ideas: trend.ideas || trend.contentIdeas || trend.topics || trend.topicIdeas || trend.suggestions || trend.ideaList || trend.angles || [],
  };
}

function normalizeRawIdea(idea) {
  if (typeof idea === "string") {
    return { title: idea };
  }
  if (!idea || typeof idea !== "object") return {};
  return {
    ...idea,
    title: idea.title || idea.name || idea.topic || "",
    summary: idea.summary || idea.description || idea.desc || idea.content || "",
    angle: idea.angle || idea.perspective || idea.direction || "",
    brandFit: idea.brandFit || idea.fit || idea.brandIntegration || "",
    audience: idea.audience || idea.targetAudience || idea.people || "",
    hook: idea.hook || idea.opening || idea.lead || "",
    tags: idea.tags || idea.tagList || idea.hashtags || [],
  };
}

function normalizeTrendBucketKey(value, bucketMeta = TREND_BUCKET_META) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.toLowerCase().replace(/[\s_\-\/|:：、，,]+/g, "");
  const aliasMap = new Map([
    ["global", "xhs"],
    ["xiaohongshu", "xhs"],
    ["xhs", "xhs"],
    ["redbook", "xhs"],
    ["littleredbook", "xhs"],
    ["小红书", "xhs"],
    ["小红书热点", "xhs"],
    ["小红书热点话题", "xhs"],
    ["站内热点", "xhs"],
    ["news", "news"],
    ["新闻", "news"],
    ["新闻热点", "news"],
    ["新闻热点趋势", "news"],
    ["消费趋势", "news"],
    ["新闻热点消费趋势趋势", "news"],
    ["social", "social"],
    ["society", "social"],
    ["社会", "social"],
    ["社会热点", "social"],
    ["社会热点趋势", "social"],
    ["大众情绪", "social"],
    ["社会热点大众情绪趋势", "social"],
    ["traffic", "traffic"],
    ["flow", "traffic"],
    ["流量", "traffic"],
    ["流量热点", "traffic"],
    ["流量热点趋势", "traffic"],
    ["爆款套路", "traffic"],
    ["track", "track"],
    ["industry", "track"],
    ["category", "track"],
    ["赛道", "track"],
    ["赛道热点", "track"],
    ["赛道热点趋势", "track"],
    ["品类热点", "track"],
    ["品类热点指数", "track"],
    ["crowd", "crowd"],
    ["audience", "crowd"],
    ["user", "crowd"],
    ["people", "crowd"],
    ["人群", "crowd"],
    ["人群热点", "crowd"],
    ["人群热点趋势", "crowd"],
  ]);
  if (aliasMap.has(compact)) return aliasMap.get(compact);
  const matched = bucketMeta.find((bucket) => compact === bucket.key || compact === bucket.title.toLowerCase().replace(/[\s_\-\/|:：、，,]+/g, ""));
  return matched?.key || text;
}

function getBucketItems(bucket) {
  return bucket?.items || bucket?.trends || bucket?.hotspots || bucket?.list || bucket?.data || bucket?.children || bucket?.results;
}

function normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, bucketMeta = TREND_BUCKET_META) {
  const sourceBuckets = coerceTrendBuckets(rawBuckets, bucketMeta);
  if (!sourceBuckets.length && rawTrends) {
    sourceBuckets.push({ key: bucketMeta[0]?.key || "bucket-1", items: rawTrends });
  }
  const bucketsByKey = new Map();
  sourceBuckets.forEach((bucket, index) => {
    const fallbackKey = bucketMeta[index]?.key || `bucket-${index + 1}`;
    const rawKey = bucket?.key || bucket?.type || bucket?.name || bucket?.title || bucket?.dimension || bucket?.category || fallbackKey;
    const key = normalizeTrendBucketKey(rawKey, bucketMeta);
    bucketsByKey.set(key, bucket);
    if (bucketMeta[index] && !bucketsByKey.has(bucketMeta[index].key)) {
      bucketsByKey.set(bucketMeta[index].key, bucket);
    }
  });

  return bucketMeta.map((meta, bucketIndex) => {
    const bucket = bucketsByKey.get(meta.key) || {};

    return {
      key: meta.key,
      title: meta.title,
      description: meta.description,
      items: normalizeTrendSet(getBucketItems(bucket), brand, baseId + bucketIndex * 100),
    };
  });
}

function coerceTrendBuckets(rawBuckets, bucketMeta = TREND_BUCKET_META) {
  if (Array.isArray(rawBuckets)) return rawBuckets;
  if (!rawBuckets || typeof rawBuckets !== "object") return [];
  const expectedKeys = bucketMeta.map((bucket) => bucket.key);
  const entries = Object.entries(rawBuckets);
  if (entries.some(([key]) => expectedKeys.includes(normalizeTrendBucketKey(key, bucketMeta)))) {
    return entries
      .filter(([key]) => expectedKeys.includes(normalizeTrendBucketKey(key, bucketMeta)))
      .map(([key, value]) => {
        const normalizedKey = normalizeTrendBucketKey(key, bucketMeta);
        return value && typeof value === "object" && !Array.isArray(value) ? { key: normalizedKey, ...value } : { key: normalizedKey, items: value };
      });
  }
  return entries.map(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value) ? { key, ...value } : { key, items: value },
  );
}

function unwrapTrendModelResult(result) {
  if (Array.isArray(result)) return { rawBuckets: result, rawTrends: null };
  const source =
    result?.trendBuckets ||
    result?.buckets ||
    result?.trend_buckets ||
    result?.trendBucket ||
    result?.hotspotBuckets ||
    result?.data?.trendBuckets ||
    result?.data?.buckets ||
    result?.data?.trend_buckets ||
    result?.result?.trendBuckets ||
    result?.result?.buckets ||
    result?.result?.trend_buckets;
  const rawTrends = result?.trends || result?.items || result?.hotspots || result?.list || result?.data?.trends || result?.result?.trends || null;
  return { rawBuckets: source, rawTrends };
}

function hasUsableTrendBuckets(trendBuckets, bucketMeta = TREND_BUCKET_META) {
  const requiredKeys = new Set(bucketMeta.map((bucket) => bucket.key));
  return (
    Array.isArray(trendBuckets) &&
    trendBuckets.length === bucketMeta.length &&
    trendBuckets.every(
      (bucket) =>
        requiredKeys.has(bucket.key) &&
        Array.isArray(bucket.items) &&
        bucket.items.length === 10 &&
        bucket.items.every((trend) => Array.isArray(trend.ideas) && trend.ideas.length === 2),
    )
  );
}

async function generateAiTrendSet(appConfig, brand, baseId) {
  return generateTrendBucketGroup(appConfig, brand, baseId, TREND_BUCKET_META);
}

async function generateTrendBucketGroup(appConfig, brand, baseId, bucketMeta) {
  const searchEnabled = Boolean(appConfig.textProvider.searchEnabled);
  const attempts = [
    { useSearch: searchEnabled, strict: false, minimal: false, label: "search-loose" },
    { useSearch: searchEnabled, strict: true, minimal: false, label: "search-strict" },
    { useSearch: searchEnabled, strict: true, minimal: true, label: "search-minimal" },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const userPrompt = buildTrendAnalysisUserPrompt(brand, {
        strict: attempt.strict,
        minimal: attempt.minimal,
      }, bucketMeta);
      console.log("[trend-analysis] calling text model", {
        brandId: brand.id,
        brandName: brand.name,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        userPromptLength: userPrompt.length,
        descriptionLength: String(brand.description || "").length,
        productLength: String(brand.product || "").length,
        knowledgeBaseLength: String(brand.knowledgeBase || "").length,
      });
      const result = await callTextModelJson(appConfig, {
        systemPrompt: buildTrendAnalysisSystemPrompt(bucketMeta),
        userPrompt,
        useSearch: attempt.useSearch,
        temperature: 0.3,
      });
      const { rawBuckets, rawTrends } = unwrapTrendModelResult(result);
      const trendBuckets = normalizeTrendBuckets(rawBuckets, rawTrends, brand, baseId, bucketMeta);
      if (hasUsableTrendBuckets(trendBuckets, bucketMeta)) {
        return trendBuckets;
      }
      lastError = new Error("文本模型返回了 JSON，但没有完整的六类可用趋势 items。");
      console.warn("[trend-analysis] text model returned empty trends", {
        brandId: brand.id,
        brandName: brand.name,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        resultKeys: result && typeof result === "object" ? Object.keys(result) : [],
        bucketSizes: trendBuckets.map((bucket) => ({ key: bucket.key, count: bucket.items.length })),
      });
    } catch (error) {
      lastError = error;
      console.warn("[trend-analysis] text model attempt failed", {
        brandId: brand.id,
        brandName: brand.name,
        bucketKeys: bucketMeta.map((bucket) => bucket.key),
        attempt: attempt.label,
        useSearch: attempt.useSearch,
        message: error?.message || "unknown error",
      });
    }
  }

  console.warn("[trend-analysis] failed without fallback", {
    brandId: brand.id,
    brandName: brand.name,
    bucketKeys: bucketMeta.map((bucket) => bucket.key),
    reason: lastError?.message || "empty model result",
  });
  throw new Error("本次分析未能获取到可用热点，请稍后重试。");
}

async function regenerateTrendIdeas(appConfig, brand, trend, customPrompt) {
  const systemPrompt = getSystemIdeaPrompt(brand, trend);
  let result;
  try {
    result = await callTextModelJson(appConfig, {
      systemPrompt: `${buildIdeaRegenerationSystemPrompt()}\n\n以下是默认品牌上下文：\n${systemPrompt}`,
      userPrompt: buildIdeaRegenerationUserPrompt(brand, trend, customPrompt),
      useSearch: false,
    });
  } catch (error) {
    throw new Error(`文本模型暂时不可用：${String(error.message || "unknown error")}`);
  }

  const ideas = Array.isArray(result?.ideas) ? result.ideas : [];
  if (!ideas.length) {
    throw new Error("文本模型未返回可用选题结果。");
  }

  return {
    systemPrompt,
    ideas: ideas.slice(0, 2).map((idea) => sanitizeIdea(idea, brand.audience, `#${brand.name}`)),
  };
}

module.exports = {
  TREND_BUCKET_META,
  buildTrendAnalysisSystemPrompt,
  buildTrendAnalysisUserPrompt,
  buildIdeaRegenerationSystemPrompt,
  buildIdeaRegenerationUserPrompt,
  getSystemIdeaPrompt,
  normalizeTrendSet,
  normalizeTrendBuckets,
  generateAiTrendSet,
  regenerateTrendIdeas,
};
