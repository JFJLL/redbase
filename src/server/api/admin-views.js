const { sanitizeUser } = require("../utils");
const { sanitizeGeneration, sanitizeBrand } = require("../assets/image-store");
const { getCreditEventCost, getGenerationTokenCost } = require("./credits");
function buildAdminOverview(storeState, appConfig) {
  const usersById = new Map((storeState.users || []).map((user) => [user.id, user]));
  const events = [...(storeState.creditEvents || [])].sort(sortByCreatedAtDesc);
  const generationEventsById = new Map(events.filter((event) => event.generationId != null).map((event) => [event.generationId, event]));

  let totalConsumedTokens = 0;
  let totalGrantedTokens = 0;
  const hasPrecomputedMetrics = Array.isArray(storeState.userMetrics);
  const metricsByUser = new Map(
    hasPrecomputedMetrics
      ? storeState.userMetrics.map((metrics) => [metrics.id, metrics])
      : (storeState.users || []).map((user) => [
          user.id,
          {
            ...sanitizeUser(user),
            createdAt: user.createdAt,
            currentCredits: Number(user.credits || 0),
            brandCount: 0,
            generationCount: 0,
            consumedTokens: 0,
            generationTokens: 0,
            grantedTokens: 0,
            lastActiveAt: "",
          },
        ]),
  );

  if (!hasPrecomputedMetrics) {
    for (const brand of storeState.brands || []) {
      const metrics = metricsByUser.get(brand.ownerUserId);
      if (metrics) metrics.brandCount += 1;
    }

    for (const generation of storeState.generations || []) {
      const metrics = metricsByUser.get(generation.ownerUserId);
      if (!metrics) continue;
      metrics.generationCount += 1;
      metrics.generationTokens += getGenerationTokenCost(generation, generationEventsById.get(generation.id));
      metrics.lastActiveAt = maxDate(metrics.lastActiveAt, generation.createdAt);
    }

    for (const event of events) {
      const metrics = metricsByUser.get(event.userId);
      const cost = getCreditEventCost(event);
      if (Number(event.creditDelta || 0) < 0) {
        totalConsumedTokens += cost;
        if (metrics) metrics.consumedTokens += cost;
      }
      if (Number(event.creditDelta || 0) > 0) {
        totalGrantedTokens += Number(event.creditDelta || 0);
        if (metrics) metrics.grantedTokens += Number(event.creditDelta || 0);
      }
      if (metrics) metrics.lastActiveAt = maxDate(metrics.lastActiveAt, event.createdAt);
    }
  } else {
    totalConsumedTokens = Number(storeState.statsOverride?.totalConsumedTokens || 0);
    totalGrantedTokens = Number(storeState.statsOverride?.totalGrantedTokens || 0);
  }

  const generations = [...(storeState.generations || [])]
    .sort(sortByCreatedAtDesc)
    .map((generation) => buildAdminGenerationView(generation, usersById, generationEventsById.get(generation.id), appConfig));
  const brands = Array.isArray(storeState.brandViews)
    ? storeState.brandViews
    : [...(storeState.brands || [])].sort(sortByCreatedAtDesc).map((brand) => buildAdminBrandView(brand, usersById));
  const stats = storeState.statsOverride || {
    userCount: storeState.users.length,
    brandCount: storeState.brands.length,
    generationCount: storeState.generations.length,
    totalConsumedTokens,
    totalGrantedTokens,
    currentCreditsTotal: (storeState.users || []).reduce((sum, user) => sum + Number(user.credits || 0), 0),
  };

  return {
    stats,
    users: [...metricsByUser.values()].sort((a, b) => b.consumedTokens - a.consumedTokens || b.generationCount - a.generationCount),
    brands,
    usageEvents: events.slice(0, 500).map((event) => sanitizeCreditEvent(event, usersById)),
    generations: generations.slice(0, 300),
  };
}

function buildAdminBrandView(brand, usersById) {
  const user = usersById.get(brand.ownerUserId);
  return {
    id: brand.id,
    ownerUserId: brand.ownerUserId,
    name: brand.name || "",
    industry: brand.industry || "",
    audience: brand.audience || "",
    description: brand.description || "",
    product: brand.product || "",
    goal: brand.goal || "",
    knowledgeBase: brand.knowledgeBase || "",
    assetTags: Array.isArray(brand.assetTags) ? brand.assetTags : [],
    logoName: brand.logo?.originalName || "",
    hasLogo: Boolean(brand.logo?.storedPath),
    analysisCount: Array.isArray(brand.analyses) ? brand.analyses.length : 0,
    trendCount: (brand.trends || []).reduce((sum, bucket) => sum + (Array.isArray(bucket.items) ? bucket.items.length : 0), 0),
    createdAt: brand.createdAt || "",
    user: user
      ? {
          id: user.id,
          name: user.name,
          phone: user.phone,
          accountType: user.accountType || "customer",
          department: user.department || "",
        }
      : null,
  };
}

function sanitizeCreditEvent(event, usersById) {
  const user = usersById.get(event.userId);
  return {
    id: event.id,
    userId: event.userId,
    userName: user?.name || "",
    userPhone: user?.phone || "",
    actionType: event.actionType,
    actionLabel: event.actionLabel,
    tokenDelta: Number(event.creditDelta || 0),
    tokenCost: getCreditEventCost(event),
    createdAt: event.createdAt,
    adminUserId: event.adminUserId,
    adminUserName: event.adminUserName || "",
    brandId: event.brandId,
    brandName: event.brandName || "",
    trendId: event.trendId,
    trendTitle: event.trendTitle || "",
    ideaTitle: event.ideaTitle || "",
    generationId: event.generationId,
    channelLabel: event.channelLabel || "",
    summary: event.summary || "",
    payload: event.payload || {},
  };
}

function buildAdminGenerationView(generation, usersById, event, appConfig) {
  const user = usersById.get(generation.ownerUserId);
  return {
    ...sanitizeGeneration(generation, appConfig),
    tokenCost: getGenerationTokenCost(generation, event),
    usageEventId: event?.id || null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          phone: user.phone,
          accountType: user.accountType || "customer",
          department: user.department || "",
        }
      : null,
  };
}

function sortByCreatedAtDesc(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

function maxDate(current, candidate) {
  if (!candidate) return current || "";
  if (!current) return candidate;
  return String(candidate).localeCompare(String(current)) > 0 ? candidate : current;
}

module.exports = {
  buildAdminOverview,
  buildAdminBrandView,
  sanitizeCreditEvent,
  buildAdminGenerationView,
  sortByCreatedAtDesc,
  maxDate,
};
