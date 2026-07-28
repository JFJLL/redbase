const { normalizeTags } = require("../utils");
const {
  findUnsupportedHardClaimTexts,
  isUnsupportedBrandClaimText,
} = require("./trend-guardrails");

// Local delivery-guarantee toolkit: classifies validation issues, strips unsafe
// copy in place, and builds complete degraded cards from evidence slots or Pgy
// notes so a bucket can always return exactly 10 items with warnings instead of
// failing the whole batch.

// Safety issues must be fixed locally (strip/replace) before returning.
const SAFETY_ISSUE_REASONS = new Set([
  "unsafe-medicine-guidance",
  "unsupported-brand-claim",
  "unsupported-hard-claim",
  "past-year-copy",
  "volatile-price-copy",
  "inline-evidence-reference",
  "internal-evidence-jargon",
]);

// Structural issues are filled deterministically when the model repair did not
// resolve them.
const STRUCTURE_ISSUE_REASONS = new Set([
  "missing-trend-field",
  "missing-opportunity-field",
  "insufficient-reason-detail",
  "missing-trend-tags",
  "idea-count",
  "missing-idea-field",
  "missing-idea-tags",
  "invalid-score",
  "missing-evidence-ids",
  "invalid-evidence-id",
]);

// Batch-level issues that cannot be attributed to one card.
const BATCH_ISSUE_REASONS = new Set(["bucket-count", "bucket-key", "trend-count", "repair-count", "missing-search-evidence"]);

function classifyTrendIssues(issues) {
  const classified = { safety: [], structural: [], batch: [], warningOnly: [] };
  for (const issue of issues || []) {
    const reason = String(issue?.reason || "");
    if (BATCH_ISSUE_REASONS.has(reason)) classified.batch.push(issue);
    else if (SAFETY_ISSUE_REASONS.has(reason)) classified.safety.push(issue);
    else if (STRUCTURE_ISSUE_REASONS.has(reason)) classified.structural.push(issue);
    else classified.warningOnly.push(issue);
  }
  return classified;
}

function getFieldByPath(target, path) {
  const segments = String(path || "").split(".").filter(Boolean);
  let current = target;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment];
  }
  return current;
}

function setFieldByPath(target, path, value) {
  const segments = String(path || "").split(".").filter(Boolean);
  if (!segments.length) return;
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (current?.[segment] == null || typeof current[segment] !== "object") return;
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

// Removes the sentence that carries an unsupported/unsafe claim. When the
// whole field would disappear, the caller replaces it with neutral copy.
function stripClaimFromText(text, claim) {
  const source = String(text || "");
  const normalizedClaim = String(claim || "").trim();
  if (!source) return "";
  const sentences = source.split(/(?<=[。；;！？!?\n])/);
  const kept = sentences.filter((sentence) => !(normalizedClaim && sentence.includes(normalizedClaim)));
  if (normalizedClaim && kept.length !== sentences.length) return kept.join("").trim();
  if (normalizedClaim && source.includes(normalizedClaim)) {
    return source.split(normalizedClaim).join("").replace(/\s+/g, " ").trim();
  }
  // Claim text was truncated upstream; drop sentences with any hard claim.
  return sentences.filter((sentence) => !findUnsupportedHardClaimTexts(sentence).length).join("").trim();
}

function buildNeutralFieldText(field, topic, brand) {
  const anchor = String(topic || "近期用户讨论").slice(0, 40);
  const brandName = String(brand?.name || "品牌");
  const byField = {
    title: `${anchor}的内容机会（待验证）`,
    category: "待验证方向",
    summary: `围绕「${anchor}」的近期讨论样本，${brandName}可以先以观察和轻内容形式进入，验证用户反馈后再加码。`,
    reason: `该方向来自「${anchor}」这一具体来源话题，先以小规模内容验证用户是否关心，再决定是否投入更多创作资源，属于低风险的待验证内容机会。`,
    market_change: `「${anchor}」相关讨论在来源样本中出现，内容形式值得观察。`,
    consumer_shift: `用户围绕「${anchor}」表达了具体问题或场景需求。`,
    why_now: `来源样本近期出现「${anchor}」相关内容，适合尽快小步验证。`,
    brand_opportunity: `${brandName}可以围绕「${anchor}」输出观察型内容，自然带出品牌视角。`,
    content_direction: `先做一篇围绕「${anchor}」的观察或清单类笔记，收集评论反馈。`,
  };
  return byField[field] || `围绕「${anchor}」的待验证内容方向。`;
}

function buildFallbackIdea(topic, brand, variant = 0) {
  const anchor = String(topic || "近期用户讨论").slice(0, 24);
  const brandName = String(brand?.name || "品牌");
  const audience = String(brand?.audience || "目标用户").slice(0, 20);
  const primary = variant === 0;
  return {
    title: primary ? `${anchor}观察清单` : `${anchor}场景问答整理`,
    summary: primary
      ? `整理来源中围绕「${anchor}」出现的真实说法和场景，做成可保存的观察清单。`
      : `把「${anchor}」相关的用户提问按场景归类，逐条给出可核验的信息边界。`,
    angle: primary ? "从来源话题的原始表达切入，逐条整理。" : "从具体使用场景的疑问切入，问答式展开。",
    brandFit: primary
      ? `${brandName}以内容整理者身份出现，只呈现观察不做功效或强度承诺。`
      : `${brandName}以问题整理者身份出现，引导讨论而不替用户下结论。`,
    audience: `关注「${anchor}」的${audience}`,
    hook: primary ? `关于${anchor}，大家最常提到的是这几件事` : `${anchor}里被问得最多的问题，先说清楚边界`,
    tags: [`#${anchor.slice(0, 10) || "话题观察"}`, "#内容观察", primary ? "#清单整理" : "#场景问答"],
    contentAssets: {},
    customPrompt: "",
    systemPrompt: "",
  };
}

function buildFallbackTrendCard({ slot, evidence, brand, index = 0, baseId = 0 }) {
  const topic = String(slot?.topic || evidence?.title || "近期用户讨论").slice(0, 40);
  const brandName = String(brand?.name || "品牌");
  const evidenceIds = Array.isArray(slot?.evidenceIds) && slot.evidenceIds.length
    ? slot.evidenceIds
    : evidence?.id ? [String(evidence.id)] : [];
  const score = 55 - (index % 10);
  return {
    id: baseId + index + 1,
    stableKey: `fallback-slot-${String(index + 1).padStart(2, "0")}`,
    rank: index + 1,
    title: `${topic}（待验证方向 ${index + 1}）`,
    category: "待验证方向",
    market_change: buildNeutralFieldText("market_change", topic, brand),
    consumer_shift: buildNeutralFieldText("consumer_shift", topic, brand),
    why_now: buildNeutralFieldText("why_now", topic, brand),
    brand_opportunity: String(slot?.brandLink || buildNeutralFieldText("brand_opportunity", topic, brand)),
    content_direction: buildNeutralFieldText("content_direction", topic, brand),
    confidence_score: score,
    summary: buildNeutralFieldText("summary", topic, brand),
    score,
    novelty_score: null,
    brand_fit_score: null,
    actionability_score: null,
    tags: normalizeTags([`#${topic.slice(0, 10) || "话题观察"}`, "#待验证", "#内容机会"]),
    reason: buildNeutralFieldText("reason", topic, brand),
    evidenceIds,
    ideas: [buildFallbackIdea(topic, brand, 0), buildFallbackIdea(topic, brand, 1)],
    customPrompt: "",
    systemPrompt: "",
    degraded: true,
  };
}

// XHS degraded card built from the matching Pgy note (order preserved so
// evidence snapshots still line up by trendIndex).
function buildPgyFallbackTrendCard({ note, brand, index = 0, baseId = 0 }) {
  const topic = String(note?.title || "站内热门内容").replace(/\s+/g, " ").slice(0, 40);
  const summarySeed = String(note?.summary || "").replace(/\s+/g, " ").slice(0, 80);
  const brandName = String(brand?.name || "品牌");
  const score = 55 - (index % 10);
  return {
    id: baseId + index + 1,
    stableKey: `pgy-note-${Number(note?.exposureRank || index + 1)}`,
    rank: index + 1,
    title: `${topic}（站内热门补齐）`,
    category: "小红书热点话题",
    market_change: `站内热门笔记「${topic}」显示该话题正在被创作和讨论。`,
    consumer_shift: summarySeed
      ? `笔记内容显示用户关注：${summarySeed}`
      : `用户通过该笔记表达了对「${topic}」的具体关注。`,
    why_now: "该笔记来自近 3 日曝光榜，适合尽快跟进验证。",
    brand_opportunity: `${brandName}可以借该话题的内容形式输出自己的版本，自然融入品牌场景。`,
    content_direction: `参考该笔记的结构做一篇品牌视角的同话题笔记，观察互动反馈。`,
    confidence_score: score,
    summary: `本条由 Pgy 热门笔记直接补齐：围绕「${topic}」的站内热门内容，${brandName}可以先用轻内容验证。`,
    score,
    novelty_score: null,
    brand_fit_score: null,
    actionability_score: null,
    tags: normalizeTags([`#${topic.slice(0, 10) || "站内热点"}`, "#小红书热点", "#待验证"]),
    reason: `该方向直接来自 Pgy 近 3 日曝光榜的热门笔记「${topic}」，站内已有真实创作与互动样本，适合作为低风险的跟进选题先行验证。`,
    evidenceIds: [],
    ideas: [buildFallbackIdea(topic, brand, 0), buildFallbackIdea(topic, brand, 1)],
    customPrompt: "",
    systemPrompt: "",
    degraded: true,
  };
}

// Strips unsafe claims and fills structural holes on one card. Returns the
// repaired card plus which issue reasons were locally resolved.
function sanitizeTrendCardLocally(trend, issues, { brand, topic } = {}) {
  const card = structuredClone(trend);
  const resolved = [];
  for (const issue of issues || []) {
    const reason = String(issue?.reason || "");
    if (SAFETY_ISSUE_REASONS.has(reason)) {
      const path = String(issue.field || "");
      const currentText = path ? String(getFieldByPath(card, path) || "") : "";
      if (path && currentText) {
        const stripped = stripClaimFromText(currentText, issue.claim);
        const fieldName = path.split(".").at(-1);
        const minLength = fieldName === "title" ? 6 : 12;
        const replacement = stripped.length >= minLength && !isUnsupportedBrandClaimText(stripped, brand)
          ? stripped
          : buildNeutralFieldText(fieldName, topic || card.title, brand);
        setFieldByPath(card, path, replacement);
      }
      resolved.push(issue);
      continue;
    }
    if (!STRUCTURE_ISSUE_REASONS.has(reason)) continue;
    if (reason === "idea-count") {
      const ideas = Array.isArray(card.ideas) ? card.ideas.slice(0, 2) : [];
      while (ideas.length < 2) ideas.push(buildFallbackIdea(topic || card.title, brand, ideas.length));
      card.ideas = ideas;
    } else if (reason === "missing-trend-tags") {
      card.tags = normalizeTags([...(card.tags || []), `#${String(topic || card.title || "话题观察").slice(0, 10)}`, "#内容机会", "#待验证"]);
    } else if (reason === "missing-idea-tags" && Number.isInteger(issue.ideaIndex) && card.ideas?.[issue.ideaIndex]) {
      const idea = card.ideas[issue.ideaIndex];
      idea.tags = normalizeTags([...(idea.tags || []), `#${String(topic || card.title || "话题观察").slice(0, 10)}`, "#内容观察", "#场景整理"]);
    } else if (reason === "missing-idea-field" && Number.isInteger(issue.ideaIndex) && card.ideas?.[issue.ideaIndex]) {
      const fallbackIdea = buildFallbackIdea(topic || card.title, brand, issue.ideaIndex);
      const idea = card.ideas[issue.ideaIndex];
      if (issue.field && !String(idea[issue.field] || "").trim()) idea[issue.field] = fallbackIdea[issue.field];
    } else if (reason === "invalid-score") {
      card.score = 55;
      if (!Number.isInteger(card.confidence_score)) card.confidence_score = 55;
    } else if (["missing-evidence-ids", "invalid-evidence-id"].includes(reason)) {
      // Evidence linkage is restored by the caller, which knows the slot map.
      resolved.push(issue);
      continue;
    } else if (issue.field) {
      const currentText = String(getFieldByPath(card, issue.field) || "");
      const fieldName = String(issue.field).split(".").at(-1);
      if (!currentText.trim() || reason === "insufficient-reason-detail") {
        setFieldByPath(card, issue.field, buildNeutralFieldText(fieldName, topic || card.title, brand));
      }
    }
    resolved.push(issue);
  }
  card.degraded = true;
  return { card, resolved };
}

function buildDegradedItemWarning(bucketKey, trendIndex, reasonCodes) {
  return {
    code: "TREND_ITEM_DEGRADED",
    bucketKey,
    trendIndex,
    reasons: [...new Set(reasonCodes)],
    message: `第 ${trendIndex + 1} 条为待验证/降级内容（${[...new Set(reasonCodes)].join("、")}）。`,
  };
}

module.exports = {
  SAFETY_ISSUE_REASONS,
  STRUCTURE_ISSUE_REASONS,
  BATCH_ISSUE_REASONS,
  classifyTrendIssues,
  stripClaimFromText,
  getFieldByPath,
  setFieldByPath,
  buildNeutralFieldText,
  buildFallbackIdea,
  buildFallbackTrendCard,
  buildPgyFallbackTrendCard,
  sanitizeTrendCardLocally,
  buildDegradedItemWarning,
};
