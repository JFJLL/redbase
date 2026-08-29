/**
 * Market signal extraction stage:
 * Evidence Normalize -> Signal Extraction -> Trend / Opportunity Generation
 *
 * Deterministic extraction keeps this stage testable, cheap, and free of
 * another model round-trip before opportunity generation.
 *
 * When a model-backed extractor is introduced, every call must go through the
 * shared AI call budget (budget.consume() before callTextModelJson).
 */

const {
  DEFAULT_BUDGETS,
  createAiCallBudget,
  isAiCallBudgetExceededError,
  buildBudgetExceededPartial,
} = require("./ai-call-budget");

const EMPTY_PLATITUDE_PATTERNS = [
  /消费升级/i,
  /年轻人关注健康/i,
  /品质生活/i,
  /用户越来越重视/i,
  /关注健康生活/i,
  /追求更好的生活/i,
  /消费观念转变/i,
  /新时代消费者/i,
];

const CHANGE_PATTERNS = [
  { pattern: /从(.{2,12})(?:转向|变为|变成|迁移到|切换到)(.{2,12})/i, format: (m) => `从${m[1]}转向${m[2]}` },
  { pattern: /(.{2,10})(?:增长|上升|走高|升温|回暖|崛起|兴起|爆发)/i, format: (m) => `${m[1]}上升` },
  { pattern: /(.{2,10})(?:下降|走低|降温|回落|退潮|减少)/i, format: (m) => `${m[1]}下降` },
  { pattern: /(.{2,12})(?:替代|取代|分流|抢占)(.{0,10})/i, format: (m) => `${m[1]}出现替代/分流` },
  { pattern: /(?:用户|消费者|家长|宝妈|年轻人).{0,8}(?:开始|更|正在|转向|偏好)(.{2,16})/i, format: (m) => `用户行为转向${m[1]}` },
  { pattern: /(?:讨论|搜索|内容|笔记|话题).{0,6}(?:集中在|围绕|聚焦)(.{2,16})/i, format: (m) => `讨论聚焦${m[1]}` },
  { pattern: /(?:痛点|焦虑|困扰|纠结|吐槽).{0,4}(.{2,16})/i, format: (m) => `痛点信号：${m[1]}` },
  { pattern: /(?:对比|避坑|测评|清单|攻略|核验|求真).{0,8}/i, format: (m) => `内容形态变化：${String(m[0]).slice(0, 24)}` },
];

const NEED_PATTERNS = [
  { pattern: /(?:需要|急需|求|想要|希望|怎么选|如何选|怎么挑)(.{2,20})/i, format: (m) => `需要${m[1]}` },
  { pattern: /(?:不知道|不清楚|搞不懂|分不清)(.{2,20})/i, format: (m) => `决策困惑：${m[1]}` },
  { pattern: /(?:怕|担心|焦虑|害怕)(.{2,18})/i, format: (m) => `风险焦虑：${m[1]}` },
  { pattern: /(?:吐槽|抱怨|踩坑|翻车)(.{2,18})/i, format: (m) => `负面反馈：${m[1]}` },
  { pattern: /(?:推荐|种草|入手|回购).{0,8}(.{2,16})/i, format: (m) => `购买决策需求：${m[1]}` },
];

const CONSUMER_LANGUAGE_PATTERNS = [
  /[\u201c"『「]([^\u201d"』」]{4,40})[\u201d"』」]/,
  /(?:有没有人|家人们|姐妹们|求问|求助|真心话|真实体验|亲测)([^。！？\n]{4,36})/,
  /(?:太难了|真的香|踩坑了|别买|别冲|避雷|闭眼入|后悔)([^。！？\n]{0,24})/,
];

const STOP_KEYWORDS = new Set([
  "内容", "趋势", "用户", "品牌", "相关", "热点", "场景", "方向", "话题", "讨论",
  "观察", "建议", "分析", "小红书", "微博", "知乎", "网页", "来源", "媒体", "行业",
  "近期", "值得", "关注", "推荐", "指南", "清单", "方法", "问题", "选择", "体验",
  "中国", "市场", "报告", "研究", "发布", "最新", "如何", "怎么", "什么", "为什么",
]);

function cleanText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[|｜]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isEmptyPlatitude(value) {
  const text = cleanText(value, 200);
  if (!text) return true;
  return EMPTY_PLATITUDE_PATTERNS.some((pattern) => pattern.test(text));
}

function extractKeywordCandidates(text) {
  const source = String(text || "").normalize("NFKC");
  const phrases = source.match(/[\u3400-\u9fff]{2,12}|[A-Za-z][A-Za-z0-9+\-]{2,20}/g) || [];
  const scores = new Map();
  for (const phrase of phrases) {
    const key = phrase.toLowerCase();
    if (STOP_KEYWORDS.has(key) || STOP_KEYWORDS.has(phrase)) continue;
    if (/^\d+$/.test(phrase)) continue;
    const weight = phrase.length >= 4 ? 3 : phrase.length === 3 ? 2 : 1;
    scores.set(phrase, (scores.get(phrase) || 0) + weight);
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .map(([phrase]) => phrase);
}

function firstMatch(text, patterns) {
  for (const entry of patterns) {
    const match = String(text || "").match(entry.pattern);
    if (!match) continue;
    const value = cleanText(entry.format(match), 80);
    if (value && !isEmptyPlatitude(value)) return value;
  }
  return "";
}

function extractConsumerLanguage(text) {
  for (const pattern of CONSUMER_LANGUAGE_PATTERNS) {
    const match = String(text || "").match(pattern);
    if (!match) continue;
    const phrase = cleanText(match[1] || match[0], 60);
    if (phrase && !isEmptyPlatitude(phrase)) return phrase;
  }
  return "";
}

function confidenceForEvidence(item, hasChange, hasNeed, hasLanguage) {
  let score = 35;
  if (item?.sourceType === "web" && ["high", "medium"].includes(item?.trustLevel)) score += 25;
  else if (item?.sourceType === "web") score += 12;
  else if (item?.sourceType === "social" || item?.sourceType === "platform") score += 10;
  if (item?.publishedAt) score += 8;
  if (hasChange) score += 12;
  if (hasNeed) score += 10;
  if (hasLanguage) score += 8;
  if (String(item?.title || "").length >= 12) score += 4;
  return Math.max(0, Math.min(100, score));
}

function signalFromEvidenceItem(item, brand = {}) {
  const title = cleanText(item?.title, 180);
  const snippet = cleanText(item?.snippet, 420);
  const body = `${title} ${snippet}`.trim();
  if (!body) return null;

  const brandTokens = extractKeywordCandidates(
    [brand?.name, brand?.product, brand?.industry, brand?.audience].filter(Boolean).join(" "),
  );
  const keywordPool = extractKeywordCandidates(body)
    .filter((token) => !brandTokens.some((brandToken) => (
      brandToken === token || (token.includes(brandToken) && token.length <= brandToken.length + 1)
    )));
  const keyword = keywordPool[0] || extractKeywordCandidates(title)[0] || cleanText(title, 24);
  if (!keyword) return null;

  const change = firstMatch(body, CHANGE_PATTERNS)
    || (keyword ? `围绕「${keyword}」的讨论与表达正在成为可见内容信号` : "");
  const consumerNeed = firstMatch(body, NEED_PATTERNS)
    || (keyword ? `用户希望弄清「${keyword}」相关的选择标准与避坑点` : "");
  const consumerLanguage = extractConsumerLanguage(body) || cleanText(title, 40) || keyword;
  const confidence = confidenceForEvidence(
    item,
    Boolean(firstMatch(body, CHANGE_PATTERNS)),
    Boolean(firstMatch(body, NEED_PATTERNS)),
    Boolean(extractConsumerLanguage(body)),
  );

  if (isEmptyPlatitude(change) || isEmptyPlatitude(consumerNeed)) return null;

  return {
    keyword: cleanText(keyword, 40),
    change: cleanText(change, 80),
    consumer_language: cleanText(consumerLanguage, 60),
    consumer_need: cleanText(consumerNeed, 80),
    confidence,
    evidenceId: String(item?.id || "").toUpperCase() || "",
    sourceType: String(item?.sourceType || ""),
  };
}

function dedupeSignals(signals) {
  const seen = new Set();
  return (Array.isArray(signals) ? signals : []).filter((signal) => {
    const key = [
      String(signal?.keyword || "").toLowerCase(),
      String(signal?.change || "").toLowerCase().slice(0, 24),
      String(signal?.consumer_need || "").toLowerCase().slice(0, 24),
    ].join("|");
    if (!key.replace(/\|/g, "") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Optional model-backed extraction hook. Currently unused (deterministic path
 * is preferred). Callers that enable it must share the parent AI call budget.
 *
 * @param {object} appConfig
 * @param {{ budget?: object, textModelImpl?: Function, systemPrompt?: string, userPrompt?: string, maxAiCalls?: number }} options
 */
async function extractMarketSignalsWithModel(appConfig, options = {}) {
  const { callTextModelJson } = require("./text-provider");
  const budget = options.budget
    || createAiCallBudget({
      task: "signal_extraction",
      maxCalls: options.maxAiCalls ?? DEFAULT_BUDGETS.signal_extraction,
    });
  if (budget.exhausted()) {
    return {
      ...buildBudgetExceededPartial(budget),
      signals: [],
    };
  }
  const textModelImpl = options.textModelImpl || callTextModelJson;
  const usesProviderBudget = textModelImpl === callTextModelJson;
  try {
    // Injected mocks bypass text-provider; consume one unit here. Real provider
    // consumes per physical attempt via the budget option.
    if (!usesProviderBudget) {
      budget.consume();
    }
    const result = await textModelImpl(appConfig, {
      systemPrompt: options.systemPrompt || "Extract market signals as JSON: {\"signals\":[...]}",
      userPrompt: options.userPrompt || "",
      temperature: 0.1,
       maxAttempts: Math.min(2, Math.max(1, budget.remaining())),
       budget: usesProviderBudget ? budget : undefined,
       stream: false,
       analyticsContext: {
         feature: "trend_analysis",
         taskType: "text_generation",
         actorUserId: options.actorUserId ?? options.userId ?? null,
         accountType: options.accountType || "",
         entityType: "trend_signal_extraction",
         entityId: String(options.entityId || options.analysisId || "standalone"),
       },
     });
    const signals = Array.isArray(result?.signals) ? result.signals : [];
    return { signals };
  } catch (error) {
    if (isAiCallBudgetExceededError(error)) {
      return {
        ...buildBudgetExceededPartial(budget),
        signals: [],
      };
    }
    throw error;
  }
}

/**
 * @param {{ brand?: object, evidence?: array, budget?: object }} input
 * @returns {{ signals: Array<{keyword:string,change:string,consumer_language:string,consumer_need:string,confidence:number}>, partial?: boolean, reason?: string }}
 */
function extractMarketSignals(input = {}) {
  const budget = input?.budget || null;
  // Deterministic path uses zero model calls. If a shared budget is already
  // exhausted by earlier stages, surface a partial marker instead of inventing signals.
  if (budget && typeof budget.exhausted === "function" && budget.exhausted()) {
    return {
      ...buildBudgetExceededPartial(budget),
      signals: [],
    };
  }

  const brand = input?.brand && typeof input.brand === "object" ? input.brand : {};
  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  const signals = dedupeSignals(
    evidence
      .map((item) => signalFromEvidenceItem(item, brand))
      .filter(Boolean)
      .sort((left, right) => right.confidence - left.confidence),
  ).slice(0, 12)
    .map(({ evidenceId, sourceType, ...publicSignal }) => publicSignal);

  return { signals };
}

function pgyNotesToSignalEvidence(pgyEvidence) {
  const notes = Array.isArray(pgyEvidence?.notes) ? pgyEvidence.notes : [];
  return notes.map((note, index) => ({
    id: `P${index + 1}`,
    title: note?.title || "",
    snippet: note?.summary || "",
    sourceType: "platform",
    trustLevel: "platform",
    publishedAt: "",
  }));
}

function extractMarketSignalsFromSources({
  brand,
  anySearchEvidence = null,
  pgyEvidence = null,
  budget = null,
} = {}) {
  const anySearchItems = Array.isArray(anySearchEvidence?.evidence) ? anySearchEvidence.evidence : [];
  const pgyItems = pgyNotesToSignalEvidence(pgyEvidence);
  return extractMarketSignals({
    brand,
    evidence: anySearchItems.length ? anySearchItems : pgyItems,
    budget,
  });
}

function formatMarketSignalsPromptBlock(marketSignals, maxSignals = 8) {
  const signals = Array.isArray(marketSignals?.signals) ? marketSignals.signals.slice(0, maxSignals) : [];
  if (!signals.length) {
    return [
      "市场信号层：",
      "本次未能从证据中提炼出足够具体的市场信号；趋势必须仍然锚定具体证据话题，不得用消费升级、品质生活等空话填充。",
    ].join("\n");
  }
  const lines = signals.map((signal, index) => [
    `信号${index + 1}：关键词「${signal.keyword}」`,
    `变化：${signal.change}`,
    `用户原话/表达：${signal.consumer_language}`,
    `用户需求：${signal.consumer_need}`,
    `置信度：${signal.confidence}`,
  ].join("｜"));
  return [
    "市场信号层（AnySearch/Pgy 证据 → 结构化信号；趋势机会必须基于这些信号，不得脱离信号空谈）：",
    ...lines,
    "信号使用规则：",
    "1. 每条趋势机会至少绑定 1 个上方信号关键词或其同义具体话题。",
    "2. market_change 必须写市场/内容场正在发生的具体变化，禁止空泛判断。",
    "3. consumer_shift 必须写用户为什么变，优先复用信号里的用户表达或需求。",
    "4. brand_opportunity 必须写当前品牌为何现在该抓，不能只写“适合品牌”。",
    "5. content_direction 必须写下一步可执行内容方向，而不是口号。",
  ].join("\n");
}

module.exports = {
  EMPTY_PLATITUDE_PATTERNS,
  extractMarketSignals,
  extractMarketSignalsFromSources,
  extractMarketSignalsWithModel,
  formatMarketSignalsPromptBlock,
  isEmptyPlatitude,
  pgyNotesToSignalEvidence,
};
