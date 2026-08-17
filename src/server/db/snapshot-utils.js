const { hashPasswordSync } = require("../auth/passwords");

function createEmptyStore() {
  return {
    nextUserId: 2,
    nextBrandId: 1,
    nextAnalysisId: 9001,
    nextTrendId: 100,
    nextGenerationId: 1,
    nextCreditEventId: 1,
    nextProductImageId: 1,
    users: [
      {
        id: 1,
        name: "Test User",
        phone: "13800000000",
        password: hashPasswordSync("123456"),
        accountType: "yimei",
        department: "其他",
        credits: 50,
        createdAt: "2026-04-25T00:00:00.000Z",
      },
    ],
    sessions: [],
    verificationCodes: {},
    brands: [],
    generations: [],
    creditEvents: [],
    productImages: [],
    imageJobs: [],
  };
}

function normalizeStore(input) {
  const defaults = createEmptyStore();
  const next = { ...defaults, ...(input || {}) };
  let changed = false;

  if (!Array.isArray(next.users) || next.users.length === 0) {
    next.users = defaults.users;
    changed = true;
  }

  next.users = next.users.map((user) => {
    const accountType = user.accountType === "yimei" ? "yimei" : "customer";
    const normalized = {
      id: Number(user.id),
      name: String(user.name || "").trim(),
      phone: String(user.phone || "").trim(),
      password: String(user.password || ""),
      accountType,
      department: accountType === "yimei" ? String(user.department || "其他") : "",
      credits: Number.isFinite(Number(user.credits)) ? Number(user.credits) : accountType === "yimei" ? 50 : 5,
      createdAt: String(user.createdAt || new Date().toISOString()),
    };

    if (
      normalized.accountType !== user.accountType ||
      normalized.department !== user.department ||
      normalized.credits !== user.credits
    ) {
      changed = true;
    }
    return normalized;
  });

  if (!Array.isArray(next.sessions)) {
    next.sessions = [];
    changed = true;
  }

  if (!next.verificationCodes || typeof next.verificationCodes !== "object") {
    next.verificationCodes = {};
    changed = true;
  }

  if (!Array.isArray(next.brands)) {
    next.brands = [];
    changed = true;
  }

  if (!Array.isArray(next.generations)) {
    next.generations = [];
    changed = true;
  }

  if (!Array.isArray(next.creditEvents)) {
    next.creditEvents = [];
    changed = true;
  }

  if (!Array.isArray(next.productImages)) {
    next.productImages = [];
    changed = true;
  }

  if (!Array.isArray(next.imageJobs)) {
    next.imageJobs = [];
    changed = true;
  }

  next.brands = next.brands.map((brand) => {
    const normalized = {
      id: Number(brand.id),
      ownerUserId: brand.ownerUserId == null ? 1 : Number(brand.ownerUserId),
      name: String(brand.name || "").trim(),
      industry: String(brand.industry || "").trim(),
      audience: String(brand.audience || "").trim(),
      description: String(brand.description || "").trim(),
      product: String(brand.product || "").trim(),
      goal: String(brand.goal || "").trim(),
      knowledgeBase: String(brand.knowledgeBase || ""),
      logo: normalizeBrandLogo(brand.logo),
      assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
      profileType: brand.profileType === "personal" ? "personal" : "brand",
      contentPillars: Array.isArray(brand.contentPillars)
        ? brand.contentPillars.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [],
      personaStyle: String(brand.personaStyle || "").trim(),
      analyses: Array.isArray(brand.analyses) ? brand.analyses : [],
      trends: normalizeTrendBuckets(brand.trends),
    };

    if (normalized.ownerUserId !== brand.ownerUserId) changed = true;
    if (
      !Array.isArray(brand.assetTags)
      || !Array.isArray(brand.contentPillars)
      || !Array.isArray(brand.analyses)
      || !Array.isArray(brand.trends)
    ) {
      changed = true;
    }

    normalized.analyses = normalized.analyses.map((analysis) => ({
      id: Number(analysis.id),
      name: String(analysis.name || "").trim(),
      timestamp: String(analysis.timestamp || ""),
      brandBrief: analysis.brandBrief && typeof analysis.brandBrief === "object" && !Array.isArray(analysis.brandBrief) ? analysis.brandBrief : {},
      trendSnapshot: normalizeTrendBuckets(analysis.trendSnapshot),
    }));

    return normalized;
  });

  next.generations = next.generations.map((item) => ({
    id: Number(item.id),
    ownerUserId: Number(item.ownerUserId),
    type: String(item.type || ""),
    channelLabel: String(item.channelLabel || ""),
    brandId: Number(item.brandId),
    brandName: String(item.brandName || ""),
    trendId: Number(item.trendId),
    trendTitle: String(item.trendTitle || ""),
    ideaTitle: String(item.ideaTitle || ""),
    cardTitle: String(item.cardTitle || ""),
    createdAt: String(item.createdAt || ""),
    previewUrl: String(item.previewUrl || ""),
    summary: String(item.summary || ""),
    payload: item.payload && typeof item.payload === "object" ? item.payload : {},
  }));

  if (next.creditEvents.length === 0 && next.generations.length > 0 && !Number.isFinite(Number(input?.nextCreditEventId))) {
    next.creditEvents = inferCreditEventsFromGenerations(next.generations);
    changed = true;
  } else {
    next.creditEvents = next.creditEvents.map((event) => ({
      id: Number(event.id),
      userId: Number(event.userId),
      actionType: String(event.actionType || ""),
      actionLabel: String(event.actionLabel || ""),
      creditDelta: Number.isFinite(Number(event.creditDelta)) ? Number(event.creditDelta) : 0,
      creditCost: Number.isFinite(Number(event.creditCost)) ? Number(event.creditCost) : 0,
      createdAt: String(event.createdAt || ""),
      adminUserId: event.adminUserId == null ? null : Number(event.adminUserId),
      adminUserName: String(event.adminUserName || ""),
      brandId: event.brandId == null ? null : Number(event.brandId),
      brandName: String(event.brandName || ""),
      trendId: event.trendId == null ? null : Number(event.trendId),
      trendTitle: String(event.trendTitle || ""),
      ideaTitle: String(event.ideaTitle || ""),
      generationId: event.generationId == null ? null : Number(event.generationId),
      channelLabel: String(event.channelLabel || ""),
      summary: String(event.summary || ""),
      payload: event.payload && typeof event.payload === "object" ? event.payload : {},
    }));
  }

  next.productImages = next.productImages.map((item) => ({
    id: Number(item.id),
    ownerUserId: Number(item.ownerUserId),
    originalName: String(item.originalName || "product-image"),
    storedPath: String(item.storedPath || ""),
    mimeType: String(item.mimeType || ""),
    sizeBytes: Number.isFinite(Number(item.sizeBytes)) ? Number(item.sizeBytes) : 0,
    sha256: String(item.sha256 || ""),
    createdAt: String(item.createdAt || ""),
    lastUsedAt: item.lastUsedAt ? String(item.lastUsedAt) : "",
    deletedAt: item.deletedAt ? String(item.deletedAt) : "",
  }));

  next.imageJobs = next.imageJobs.map((item) => ({
    id: String(item.id || ""),
    ownerUserId: Number(item.ownerUserId),
    status: String(item.status || "pending"),
    provider: String(item.provider || "keystone"),
    providerMode: String(item.providerMode || ""),
    providerResultUrl: String(item.providerResultUrl || ""),
    model: String(item.model || ""),
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
    generationContext: item.generationContext && typeof item.generationContext === "object" ? item.generationContext : null,
    imageUrl: String(item.imageUrl || ""),
    error: String(item.error || ""),
    generationId: item.generationId == null ? null : Number(item.generationId),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
    updatedAt: String(item.updatedAt || ""),
    completedAt: String(item.completedAt || ""),
  }));

  next.nextUserId = normalizeCounter(next.nextUserId, next.users.map((item) => item.id), defaults.nextUserId);
  next.nextBrandId = normalizeCounter(next.nextBrandId, next.brands.map((item) => item.id), defaults.nextBrandId);
  next.nextAnalysisId = normalizeCounter(
    next.nextAnalysisId,
    next.brands.flatMap((brand) => (brand.analyses || []).map((analysis) => analysis.id)),
    defaults.nextAnalysisId,
  );
  next.nextTrendId = normalizeCounter(
    next.nextTrendId,
    next.brands.flatMap((brand) => [
      ...flattenTrendBuckets(brand.trends).map((trend) => trend.id),
      ...(brand.analyses || []).flatMap((analysis) => flattenTrendBuckets(analysis.trendSnapshot).map((trend) => trend.id)),
    ]),
    defaults.nextTrendId,
  );
  next.nextGenerationId = normalizeCounter(
    next.nextGenerationId,
    next.generations.map((item) => item.id),
    defaults.nextGenerationId,
  );
  next.nextCreditEventId = normalizeCounter(
    next.nextCreditEventId,
    next.creditEvents.map((item) => item.id),
    defaults.nextCreditEventId,
  );
  next.nextProductImageId = normalizeCounter(
    next.nextProductImageId,
    next.productImages.map((item) => item.id),
    defaults.nextProductImageId,
  );

  return { store: next, changed };
}

function normalizeBrandLogo(input) {
  if (!input || typeof input !== "object") return null;
  const storedPath = String(input.storedPath || "");
  if (!storedPath) return null;
  return {
    originalName: String(input.originalName || "brand-logo"),
    storedPath,
    mimeType: String(input.mimeType || ""),
    sizeBytes: Number.isFinite(Number(input.sizeBytes)) ? Number(input.sizeBytes) : 0,
    sha256: String(input.sha256 || ""),
    createdAt: String(input.createdAt || ""),
    updatedAt: String(input.updatedAt || input.createdAt || ""),
  };
}

function inferCreditEventsFromGenerations(generations) {
  let nextId = 1;
  return generations.map((item) => {
    const creditCost = inferGenerationCreditCost(item.type);
    return {
      id: nextId++,
      userId: Number(item.ownerUserId),
      actionType: "generation",
      actionLabel: item.channelLabel || "内容生成",
      creditDelta: -creditCost,
      creditCost,
      createdAt: String(item.createdAt || ""),
      adminUserId: null,
      adminUserName: "",
      brandId: Number(item.brandId),
      brandName: String(item.brandName || ""),
      trendId: Number(item.trendId),
      trendTitle: String(item.trendTitle || ""),
      ideaTitle: String(item.ideaTitle || ""),
      generationId: Number(item.id),
      channelLabel: String(item.channelLabel || ""),
      summary: String(item.summary || item.cardTitle || ""),
      payload: { inferred: true, source: "generation-history" },
    };
  });
}

function inferGenerationCreditCost(type) {
  return type === "xhsCarousel" ? 4 : 1;
}

function isTrendBucket(value) {
  return value && typeof value === "object" && Array.isArray(value.items);
}

function normalizeTrendBuckets(trends) {
  const source = Array.isArray(trends) ? trends : [];
  if (!source.length) return [];

  if (!source.some(isTrendBucket)) {
    return [
      {
        key: "global",
        title: "全网热点指数",
        description: "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
        items: source,
      },
    ];
  }

  return source.map((bucket, index) => ({
    key: String(bucket.key || (index === 0 ? "global" : `bucket-${index + 1}`)),
    title: String(bucket.title || (index === 0 ? "全网热点指数" : "热点趋势")),
    description: String(bucket.description || "适合当前品牌借势的热点方向。"),
    items: Array.isArray(bucket.items) ? bucket.items : [],
  }));
}

function flattenTrendBuckets(trends) {
  return normalizeTrendBuckets(trends).flatMap((bucket) =>
    bucket.items.map((trend) => ({
      ...trend,
      bucketKey: bucket.key,
      bucketTitle: bucket.title,
      bucketDescription: bucket.description,
    })),
  );
}

function groupTrendRows(rows, target) {
  for (const trend of rows) {
    const key = trend.bucketKey || "global";
    let bucket = target.find((item) => item.key === key);
    if (!bucket) {
      bucket = {
        key,
        title: trend.bucketTitle || "全网热点指数",
        description: trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
        items: [],
      };
      target.push(bucket);
    }
    bucket.items.push({
      id: trend.id,
      stableKey: trend.stableKey || "",
      rank: trend.rank,
      title: trend.title,
      category: trend.category,
      summary: trend.summary,
      score: trend.score,
      tags: trend.tags,
      evidenceIds: Array.isArray(trend.evidenceIds) ? trend.evidenceIds : [],
      evidence: Array.isArray(trend.evidence) ? trend.evidence : [],
      reason: trend.reason,
      customPrompt: trend.customPrompt,
      ideas: trend.ideas,
    });
  }
}

function normalizeCounter(candidate, ids, fallback) {
  const maxId = ids.map((id) => Number(id)).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), fallback - 1);
  const minimumNext = Math.max(maxId + 1, fallback);
  if (Number.isFinite(Number(candidate))) {
    return Math.max(Number(candidate), minimumNext);
  }
  return minimumNext;
}

function safeParseArray(text) {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function safeParseObject(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

module.exports = {
  createEmptyStore,
  normalizeStore,
  normalizeBrandLogo,
  inferCreditEventsFromGenerations,
  inferGenerationCreditCost,
  isTrendBucket,
  normalizeTrendBuckets,
  flattenTrendBuckets,
  groupTrendRows,
  normalizeCounter,
  safeParseArray,
  safeParseObject,
};
