const { clampScore, normalizeTags } = require("../utils");
const {
  collectTrendClaimTexts,
  hasUnsupportedHardClaim,
  hasUnsupportedHardClaimText,
  isUnsupportedBrandClaimText,
} = require("./trend-guardrails");

const TARGET_TREND_COUNT = 10;
const FORBIDDEN_FRESHNESS_LABELS = /(?:旧话题复燃|长尾稳定|品牌可用但非热点)/g;
const GENERIC_TITLE_MATCH_TOKENS = new Set([
  "政策", "讨论", "观察", "解读", "行业", "热点", "趋势", "内容", "用户", "场景", "方向", "话题", "关注", "升温",
  "小红书", "微博", "知乎", "抖音", "快手", "公众号", "微信公众号", "哔哩哔哩", "中国经济网", "新华网", "新华社",
  "人民网", "人民日报", "新浪", "搜狐", "网易", "腾讯", "百家号", "今日头条",
]);
const SOURCE_ALIAS_RULES = [
  { patterns: ["xiaohongshu", "xhs"], aliases: ["小红书", "红书"] },
  { patterns: ["weibo"], aliases: ["微博"] },
  { patterns: ["zhihu"], aliases: ["知乎"] },
  { patterns: ["bilibili"], aliases: ["哔哩哔哩", "b站"] },
  { patterns: ["douyin"], aliases: ["抖音"] },
  { patterns: ["kuaishou"], aliases: ["快手"] },
  { patterns: ["weixin", "mp.weixin"], aliases: ["微信", "公众号", "微信公众号"] },
  { patterns: ["ce.cn"], aliases: ["中国经济网", "经济网"] },
  { patterns: ["xinhuanet"], aliases: ["新华网", "新华社"] },
  { patterns: ["people.com"], aliases: ["人民网", "人民日报"] },
  { patterns: ["sina"], aliases: ["新浪"] },
  { patterns: ["sohu"], aliases: ["搜狐"] },
  { patterns: ["163.com"], aliases: ["网易"] },
  { patterns: ["qq.com", "tencent"], aliases: ["腾讯"] },
  { patterns: ["toutiao"], aliases: ["头条", "今日头条"] },
  { patterns: ["baijiahao", "baidu"], aliases: ["百度", "百家号"] },
];

const ROUTE_VARIANTS = [
  { label: "真实场景切入", audience: "正在比较解决方案的用户", scene: "具体使用场景", format: "场景记录" },
  { label: "反差问题开场", audience: "被常见误区困扰的用户", scene: "选择前的犹豫时刻", format: "反差问答" },
  { label: "步骤清单收藏", audience: "需要快速执行建议的用户", scene: "准备行动的当下", format: "步骤清单" },
  { label: "前后决策对照", audience: "正在权衡不同选择的用户", scene: "购买或使用决策", format: "对照卡片" },
  { label: "用户问题拆解", audience: "初次接触该话题的用户", scene: "搜索答案的时刻", format: "问题拆解" },
  { label: "体验过程记录", audience: "重视真实体验的用户", scene: "连续使用或观察过程", format: "体验日记" },
  { label: "避坑边界提醒", audience: "担心选错或用错的用户", scene: "做决定前的核对阶段", format: "避坑提示" },
  { label: "评论观点回应", audience: "参与相关讨论的用户", scene: "表达观点与交流经验", format: "观点回应" },
  { label: "视觉信息重组", audience: "偏好快速浏览的用户", scene: "碎片时间获取信息", format: "视觉卡片" },
  { label: "人群细分观察", audience: "有明确生活情境的细分用户", scene: "日常需求出现的时刻", format: "人群观察" },
];

const IDEA_ROUTES = {
  xhs: ["热点证据解读", "用户场景转化"],
  traffic: ["爆款形式复用", "互动话题反差"],
  news: ["信息解释提醒", "生活应用清单"],
  social: ["情绪共鸣表达", "具体场景行动"],
  track: ["品类决策科普", "痛点对比避坑"],
  crowd: ["身份共鸣洞察", "具体场景解决"],
};

function compactText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function titleTokenSet(value) {
  const tokens = new Set(getMatchTokens(value));
  tokens.compactTitle = compactText(value);
  return tokens;
}

function isNearDuplicateTitle(value, seenTokenSets) {
  const current = titleTokenSet(value);
  const compact = compactText(value);
  return seenTokenSets.some((previous) => {
    const previousCompact = previous.compactTitle || "";
    if (compact.length >= 4 && previousCompact.length >= 4 && (compact.includes(previousCompact) || previousCompact.includes(compact))) {
      return true;
    }
    if (current.size < 2 || previous.size < 2) return false;
    const intersection = [...current].filter((token) => previous.has(token)).length;
    const union = new Set([...current, ...previous]).size;
    return union > 0 && intersection / union >= 0.72;
  });
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function replaceForbiddenLabels(value) {
  return String(value || "").replace(FORBIDDEN_FRESHNESS_LABELS, "近期内容观察");
}

function evidenceText(item) {
  return [item?.title, item?.snippet, item?.source, item?.host].map((value) => String(value || "")).join(" ");
}

function getMatchTokens(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set((text.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) || []).flatMap((token) => {
    if (!/[\u3400-\u9fff]/.test(token) || token.length <= 2) return [token];
    return [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))];
  }));
  return [...tokens].filter((token) => !["内容", "趋势", "用户", "品牌", "相关", "热点", "场景"].includes(token));
}

function getTrendBodyMatchText(trend) {
  return [
    trend?.summary,
    trend?.reason,
    ...(trend?.tags || []),
    ...(trend?.ideas || []).flatMap((idea) => [idea?.title, idea?.summary, idea?.angle, idea?.audience]),
  ].join(" ");
}

function hasStrongTitleEvidenceMatch(titleTokens, evidenceTokens) {
  const matches = [...titleTokens].filter((token) => !GENERIC_TITLE_MATCH_TOKENS.has(token) && evidenceTokens.has(token));
  return matches.length >= 2 || matches.some((token) => token.length >= 3);
}

function getSourceIdentityTokens(item) {
  const identity = [item?.source, item?.host, item?.platformType].join(" ").toLowerCase();
  const aliases = SOURCE_ALIAS_RULES
    .filter((rule) => rule.patterns.some((pattern) => identity.includes(pattern)))
    .flatMap((rule) => rule.aliases);
  return new Set(getMatchTokens(`${identity} ${aliases.join(" ")}`));
}

function matchEvidenceIds(trend, evidence, brand) {
  if (!evidence.length) return [];
  const validIds = new Set(evidence.map((item) => String(item.id || "").toUpperCase()).filter(Boolean));
  const brandTokens = new Set(getMatchTokens(brand?.name || ""));
  const bodyTokens = new Set(getMatchTokens(getTrendBodyMatchText(trend)).filter((token) => !brandTokens.has(token)));
  const titleTokens = new Set(getMatchTokens(trend?.title || "").filter((token) => !brandTokens.has(token)));
  const ranked = evidence
    .map((item, index) => {
      const evidenceTokens = new Set(getMatchTokens(evidenceText(item)).filter((token) => !brandTokens.has(token)));
      const sourceTokens = getSourceIdentityTokens(item);
      const evidenceTopicTokens = new Set(
        getMatchTokens([item?.title, item?.snippet].join(" "))
          .filter((token) => !brandTokens.has(token) && !sourceTokens.has(token)),
      );
      return {
        id: String(item.id || "").toUpperCase(),
        index,
        overlap: [...evidenceTopicTokens].filter((token) => bodyTokens.has(token)).length,
        strongTitleMatch: hasStrongTitleEvidenceMatch(titleTokens, evidenceTopicTokens),
      };
    })
    .filter((item) => item.id)
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index);
  const overlapById = new Map(ranked.map((item) => [item.id, item.overlap]));
  const retained = (trend.evidenceIds || [])
    .map((id) => String(id || "").toUpperCase())
    .filter((id, index, all) => {
      const match = ranked.find((item) => item.id === id);
      return validIds.has(id) && all.indexOf(id) === index && Number(overlapById.get(id) || 0) >= 2 && match?.strongTitleMatch === true;
    })
    .slice(0, 3);
  if (retained.length) return retained;
  const positive = ranked.filter((item) => item.overlap >= 2 && item.strongTitleMatch).slice(0, 3).map((item) => item.id);
  return positive;
}

function needsRiskRewrite(value, brand) {
  const text = String(value || "");
  if (!text) return false;
  if (isUnsupportedBrandClaimText(text, brand)) return true;
  return hasUnsupportedHardClaimText(text);
}

function hasResidualTrendRisk(trend, brand) {
  return hasUnsupportedHardClaim(trend)
    || collectTrendClaimTexts(trend).some((text) => isUnsupportedBrandClaimText(text, brand));
}

function safeSubject(trend, variant) {
  const title = replaceForbiddenLabels(trend?.title || "");
  const startingPoint = hasUnsupportedHardClaimText(title) ? trend?.category || variant.label : title || trend?.category || variant.label;
  const source = replaceForbiddenLabels(startingPoint)
    .replace(/(?:治|治疗|治愈|预防|缓解|改善|减轻|消除|控制|见效|起效|疗效|有效率|剂量|用量|服用|用药|医疗级|医用级|权威认证|官方认证|国家认证|儿童专用|婴幼儿专用|孕妇专用|零风险|绝对安全)/gi, "")
    .replace(/\s+/g, "")
    .slice(0, 24);
  return source && !hasUnsupportedHardClaimText(source) ? source : variant.label;
}

function rewriteTrendRiskFields(trend, brand, variant) {
  const product = String(brand?.product || brand?.industry || "产品或服务").trim();
  const audience = String(brand?.audience || variant.audience).trim();
  const subject = safeSubject(trend, variant);
  let repaired = 0;
  const assignIfRisky = (object, field, replacement, safeFallback = replacement) => {
    if (!needsRiskRewrite(object?.[field], brand)) return;
    object[field] = needsRiskRewrite(replacement, brand) ? safeFallback : replacement;
    repaired += 1;
  };

  assignIfRisky(trend, "title", `${subject}的${variant.label}`, `${variant.label}：${variant.scene}`);
  assignIfRisky(
    trend,
    "summary",
    `近期相关内容更关注${audience}在${variant.scene}中的真实问题，适合从经验分享和信息梳理角度继续观察。`,
    `近期相关内容更关注用户在${variant.scene}中的真实问题，适合从经验分享和信息梳理角度继续观察。`,
  );
  assignIfRisky(
    trend,
    "reason",
    `该方向与${brand.name}的${product}及${audience}使用场景相关，具体信息以品牌档案和可核验来源为准。`,
    `该方向可从真实使用场景进入内容，具体信息以品牌档案和可核验来源为准。`,
  );
  for (const [ideaIndex, idea] of (trend.ideas || []).entries()) {
    const route = (IDEA_ROUTES[trend.bucketKey] || ["实用信息", "场景表达"])[ideaIndex] || "场景表达";
    assignIfRisky(idea, "title", `${subject}怎么用${route}讲清楚`, `${variant.label}怎么用${route}讲清楚`);
    assignIfRisky(
      idea,
      "summary",
      `围绕${audience}在${variant.scene}中的关注点，整理可核验信息与真实体验，不延伸未经品牌档案支持的结论。`,
      `围绕用户在${variant.scene}中的关注点，整理可核验信息与真实体验，不延伸未经支持的结论。`,
    );
    assignIfRisky(idea, "angle", `以${variant.format}呈现用户问题、判断过程和可执行动作。`);
    assignIfRisky(
      idea,
      "brandFit",
      `${brand.name}可从${product}的真实使用场景自然进入内容，不补充档案未提供的功效、认证或适用人群承诺。`,
      `${brand.name}可从真实使用场景自然进入内容，不补充档案未提供的功效、认证或适用人群承诺。`,
    );
    assignIfRisky(idea, "hook", `先看${variant.scene}里真正影响选择的是什么。`);
  }
  return repaired;
}

function createIdeaSkeleton(source, context, ideaIndex) {
  const { brand, bucket, trend, variant } = context;
  const routes = IDEA_ROUTES[bucket.key] || ["理性实用路线", "场景共鸣路线"];
  const route = routes[ideaIndex] || routes[0];
  const subject = safeSubject(trend, variant);
  const product = String(brand?.product || brand?.industry || "产品或服务").trim();
  const base = source && typeof source === "object" ? source : {};
  return {
    title: replaceForbiddenLabels(base.title || `${subject}：用${route}做一条可执行内容`),
    summary: replaceForbiddenLabels(base.summary || `围绕${variant.audience}在${variant.scene}中的真实关注点，用${route}整理信息、体验和行动建议，让内容有明确价值。`),
    angle: replaceForbiddenLabels(base.angle || `采用${variant.format}，从${route}切入并落到具体问题与行动。`),
    brandFit: replaceForbiddenLabels(base.brandFit || `${brand.name}可通过${product}的真实使用场景自然进入，不增加品牌档案未提供的卖点。`),
    audience: replaceForbiddenLabels(base.audience || variant.audience),
    hook: replaceForbiddenLabels(base.hook || (ideaIndex === 0 ? `为什么${variant.scene}里的这个问题最近更值得关注？` : `换一个${route}视角，这件事可以讲得更具体。`)),
    tags: normalizeTags(base.tags, [`#${brand.name}`, `#${bucket.title.replace(/趋势|热点/g, "")}`, `#${route}`]),
    contentAssets: {},
  };
}

function repairIdeas(trend, context) {
  const source = Array.isArray(trend.ideas) ? trend.ideas.slice(0, 2) : [];
  const ideas = [createIdeaSkeleton(source[0], context, 0), createIdeaSkeleton(source[1], context, 1)];
  if (compactText(ideas[0].title) === compactText(ideas[1].title) || compactText(ideas[0].angle) === compactText(ideas[1].angle)) {
    ideas[1] = createIdeaSkeleton({}, context, 1);
  }
  return ideas;
}

function rebuildTrendAsSafeObservation(trend, { brand, bucket, variant, index, evidenceSubject }) {
  const subject = String(evidenceSubject || "").trim() || bucket.title;
  trend.stableKey = `${bucket.key}-safe-${index + 1}-${stableHash(`${subject}-${variant.label}-${index}`)}`;
  trend.title = `${subject}：${variant.label}`;
  trend.category = bucket.title;
  trend.summary = `基于现有搜索信号，可围绕“${subject}”观察用户在${variant.scene}中的讨论，并用${variant.format}验证内容反馈。`;
  trend.tags = normalizeTags([], [`#${brand.name}`, `#${bucket.title.replace(/趋势|热点/g, "")}`, `#${variant.format}`]);
  trend.reason = "该方向只保留可核验的讨论背景与内容表达建议，不延伸未经来源或品牌档案支持的结论。";
  trend.ideas = [
    createIdeaSkeleton({}, { brand, bucket, trend, variant }, 0),
    createIdeaSkeleton({}, { brand, bucket, trend, variant }, 1),
  ];
  return 1;
}

function getSafeEvidenceSubject(trend, evidence, brand, fallback) {
  const evidenceById = new Map(evidence.map((item) => [String(item?.id || "").toUpperCase(), item]));
  const item = (trend.evidenceIds || []).map((id) => evidenceById.get(String(id || "").toUpperCase())).find(Boolean);
  const candidate = replaceForbiddenLabels(String(item?.title || "").trim()).slice(0, 28);
  return candidate && !needsRiskRewrite(candidate, brand) ? candidate : fallback;
}

function trendQuality(trend) {
  const textFields = [trend.title, trend.summary, trend.reason].filter((value) => String(value || "").trim()).length;
  const ideaFields = (trend.ideas || []).reduce(
    (sum, idea) => sum + [idea.title, idea.summary, idea.angle, idea.brandFit, idea.audience, idea.hook].filter((value) => String(value || "").trim()).length,
    0,
  );
  return clampScore(trend.score) * 10 + textFields * 5 + ideaFields + (trend.evidenceIds || []).length * 3;
}

function buildFallbackTrend(brand, bucket, evidence, index) {
  const variant = ROUTE_VARIANTS[index % ROUTE_VARIANTS.length];
  const evidenceItem = evidence.length ? evidence[index % evidence.length] : null;
  const evidenceTitle = replaceForbiddenLabels(String(evidenceItem?.title || "").trim()).slice(0, 28);
  const subject = evidenceTitle || `${brand.industry || brand.product || brand.name}内容`;
  return {
    stableKey: `${bucket.key}-fill-${index + 1}-${stableHash(`${subject}-${variant.label}`)}`,
    title: `${subject}的${variant.label}`,
    category: bucket.title,
    summary: `从现有搜索证据与品牌场景中观察到，${variant.audience}更需要围绕${variant.scene}的${variant.format}内容；该方向适合继续验证互动反馈。`,
    score: Math.max(65, 82 - index),
    tags: normalizeTags([], [`#${brand.name}`, `#${bucket.title.replace(/趋势|热点/g, "")}`, `#${variant.format}`]),
    reason: `${brand.name}可结合${brand.product || brand.industry || "现有产品或服务"}的真实使用场景，用${variant.format}提供具体信息和行动参考。`,
    evidenceIds: evidenceItem?.id ? [String(evidenceItem.id).toUpperCase()] : [],
    ideas: [],
    customPrompt: "",
    systemPrompt: "",
    _filled: true,
  };
}

function repairBucket(bucket, meta, brand, baseId, searchEvidence, pgyEvidence) {
  const evidence = Array.isArray(searchEvidence?.evidence) ? searchEvidence.evidence : [];
  const pgyNotes = Array.isArray(pgyEvidence?.notes) ? pgyEvidence.notes : [];
  const source = [...(bucket?.items || [])]
    .sort((left, right) => trendQuality(right) - trendQuality(left))
    .slice(0, TARGET_TREND_COUNT);
  while (source.length < TARGET_TREND_COUNT) {
    const fallbackEvidence = evidence.length
      ? evidence
      : pgyNotes.map((note, index) => ({ id: "", title: note.title || `站内热门内容 ${index + 1}`, snippet: "", sourceType: "pgy", trustLevel: "medium" }));
    source.push(buildFallbackTrend(brand, meta, fallbackEvidence, source.length));
  }

  const seenTitles = new Set();
  const seenKeys = new Set();
  const seenTitleTokenSets = [];
  const stats = { generated: bucket?.items?.length || 0, repaired: 0, filled: source.filter((item) => item._filled).length };
  const repairedItems = source.map((sourceTrend, index) => {
    const variant = ROUTE_VARIANTS[index % ROUTE_VARIANTS.length];
    const trend = {
      ...sourceTrend,
      bucketKey: meta.key,
      stableKey: String(sourceTrend.stableKey || `${meta.key}-${stableHash(`${sourceTrend.title}-${index}`)}`),
      title: replaceForbiddenLabels(sourceTrend.title || `${meta.title}方向 ${index + 1}`),
      category: replaceForbiddenLabels(sourceTrend.category || meta.title),
      summary: replaceForbiddenLabels(sourceTrend.summary || `围绕${variant.audience}在${variant.scene}中的近期内容需求，形成可继续验证的营销观察。`),
      score: clampScore(sourceTrend.score),
      tags: normalizeTags(sourceTrend.tags, [`#${brand.name}`, `#${meta.title.replace(/趋势|热点/g, "")}`, `#${variant.format}`]),
      reason: replaceForbiddenLabels(sourceTrend.reason || `${brand.name}可从${brand.product || brand.industry || "真实业务"}的使用场景自然进入。`),
      customPrompt: "",
      systemPrompt: "",
    };
    trend.evidenceIds = matchEvidenceIds(trend, evidence, brand);
    trend.ideas = repairIdeas(trend, { brand, bucket: meta, trend, variant });
    if (evidence.length && !trend.evidenceIds.length) {
      const fallbackEvidence = evidence[index % evidence.length];
      const fallbackId = String(fallbackEvidence?.id || "").toUpperCase();
      const rawEvidenceSubject = replaceForbiddenLabels(String(fallbackEvidence?.title || "").trim()).slice(0, 28);
      const evidenceSubject = rawEvidenceSubject && !hasUnsupportedHardClaimText(rawEvidenceSubject) ? rawEvidenceSubject : meta.title;
      trend.title = `${evidenceSubject}：${variant.label}`;
      trend.summary = `现有搜索信号显示“${evidenceSubject}”相关内容值得继续观察，可从${variant.scene}和${variant.format}角度验证用户反馈。`;
      trend.category = meta.title;
      trend.tags = normalizeTags([], [`#${brand.name}`, `#${meta.title.replace(/趋势|热点/g, "")}`, `#${variant.format}`]);
      trend.reason = "该方向只引用当前搜索结果中的讨论背景，并以用户场景和内容形式为分析范围。";
      trend.evidenceIds = fallbackId ? [fallbackId] : [];
      trend.ideas = [
        createIdeaSkeleton({}, { brand, bucket: meta, trend, variant }, 0),
        createIdeaSkeleton({}, { brand, bucket: meta, trend, variant }, 1),
      ];
      stats.repaired += 1;
    }
    stats.repaired += rewriteTrendRiskFields(trend, brand, variant);
    if (hasResidualTrendRisk(trend, brand)) {
      stats.repaired += rebuildTrendAsSafeObservation(trend, {
        brand,
        bucket: meta,
        variant,
        index,
        evidenceSubject: getSafeEvidenceSubject(trend, evidence, brand, meta.title),
      });
    }

    let titleKey = compactText(trend.title);
    let stableKey = compactText(trend.stableKey);
    if (!titleKey || seenTitles.has(titleKey) || isNearDuplicateTitle(trend.title, seenTitleTokenSets) || !stableKey || seenKeys.has(stableKey)) {
      trend.title = `${meta.title}：${variant.audience}的${variant.label}`;
      trend.stableKey = `${meta.key}-${stableHash(`${trend.title}-${index}`)}-${index + 1}`;
      trend.summary = `从${variant.scene}切入，以${variant.format}回应${variant.audience}的具体问题，避免与本批其他方向重复。`;
      trend.ideas = repairIdeas(trend, { brand, bucket: meta, trend, variant });
      stats.repaired += 1;
      titleKey = compactText(trend.title);
      stableKey = compactText(trend.stableKey);
    }
    if (hasResidualTrendRisk(trend, brand)) {
      stats.repaired += rebuildTrendAsSafeObservation(trend, {
        brand,
        bucket: meta,
        variant,
        index,
        evidenceSubject: getSafeEvidenceSubject(trend, evidence, brand, meta.title),
      });
      titleKey = compactText(trend.title);
      stableKey = compactText(trend.stableKey);
    }
    seenTitles.add(titleKey);
    seenKeys.add(stableKey);
    seenTitleTokenSets.push(titleTokenSet(trend.title));
    delete trend._filled;
    return trend;
  });

  repairedItems.sort((left, right) => right.score - left.score || trendQuality(right) - trendQuality(left) || left.title.localeCompare(right.title, "zh-CN"));
  repairedItems.forEach((trend, index) => {
    trend.id = baseId + index + 1;
    trend.rank = index + 1;
  });
  return {
    bucket: { key: meta.key, title: meta.title, description: meta.description, items: repairedItems },
    stats,
  };
}

function repairTrendBuckets(trendBuckets, bucketMeta, brand, baseId, options = {}) {
  const bucketsByKey = new Map((trendBuckets || []).map((bucket) => [bucket.key, bucket]));
  const stats = { generated: 0, repaired: 0, filled: 0, returned: 0 };
  const buckets = bucketMeta.map((meta, bucketIndex) => {
    const result = repairBucket(
      bucketsByKey.get(meta.key),
      meta,
      brand,
      baseId + bucketIndex * 100,
      options.anySearchEvidence,
      options.pgyEvidence,
    );
    stats.generated += result.stats.generated;
    stats.repaired += result.stats.repaired;
    stats.filled += result.stats.filled;
    stats.returned += result.bucket.items.length;
    return result.bucket;
  });
  return { buckets, stats };
}

module.exports = {
  TARGET_TREND_COUNT,
  repairTrendBuckets,
  matchEvidenceIds,
  rewriteTrendRiskFields,
};
