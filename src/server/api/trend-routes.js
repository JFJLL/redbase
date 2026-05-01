const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { findUserById, updateUserCredits } = require("../db/repositories/auth-repository");
const { insertCreditEvent } = require("../db/repositories/admin-repository");
const {
  findBrandByOwner,
  upsertBrandFull,
  allocateAnalysisAndTrendBase,
} = require("../db/repositories/brand-repository");

async function handleTrendRoutes(context, req, res, pathname) {
  const {
    appConfig,
    generateAiTrendSet,
    regenerateTrendIdeas,
    sanitizeUser,
    sanitizeTrend,
    sanitizeBrand,
    formatTimestamp,
    CREDIT_COSTS,
    MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS,
    hasEnoughCredits,
    getTrendAnalysisBrandProfileSize,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    findTrendItem,
    normalizeEditableText,
    cloneTrendBuckets,
    json,
    notFound,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  const analysisMatch = pathname.match(/^\/api\/brands\/(\d+)\/analyses$/);
  if (req.method === "POST" && analysisMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(analysisMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }

    const profileSize = getTrendAnalysisBrandProfileSize(brand);
    if (profileSize.total > MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS) {
      badRequest(
        res,
        `当前品牌档案共 ${profileSize.total} 字，超过热点分析上限 ${MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字。请删减品牌介绍、产品/服务或品牌资料库后再开始热点分析。`,
      );
      return true;
    }

    if (!hasEnoughCredits(user, CREDIT_COSTS.analysis, res)) return true;
    const { analysisId, trendBase } = allocateAnalysisAndTrendBase();
    brand.analyses.unshift({
      id: analysisId,
      name: `${brand.name} - 热门趋势分析`,
      timestamp: formatTimestamp(),
      trendSnapshot: [],
    });
    try {
      brand.trends = await generateAiTrendSet(brand, trendBase);
    } catch (error) {
      console.warn("[trend-analysis] analysis failed for request", {
        userId: user.id,
        brandId: brand.id,
        brandName: brand.name,
        message: error?.message || "unknown error",
      });
      badRequest(res, "本次分析未能获取到可用热点，请稍后重试。");
      return true;
    }
    const nextCredits = Number(user.credits || 0) - CREDIT_COSTS.analysis;
    updateUserCredits(user.id, nextCredits);
    const updatedUser = findUserById(user.id);
    insertCreditEvent({
      userId: user.id,
      actionType: "analysis",
      actionLabel: "AI 热点分析",
      creditDelta: -CREDIT_COSTS.analysis,
      creditCost: CREDIT_COSTS.analysis,
      brandId: brand.id,
      brandName: brand.name,
      summary: `${brand.name} 热点趋势分析`,
    });
    brand.analyses[0].trendSnapshot = cloneTrendBuckets(brand.trends);
    const savedBrand = upsertBrandFull(brand);
    json(res, 200, { brand: sanitizeBrand(savedBrand, appConfig), user: sanitizeUser(updatedUser) });
    return true;
  }

  const ideaUpdateMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/(\d+)$/);
  if (req.method === "PATCH" && ideaUpdateMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(ideaUpdateMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    const trend = findTrendItem(brand, Number(ideaUpdateMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }
    const ideaIndex = Number(ideaUpdateMatch[3]);
    const idea = trend.ideas?.[ideaIndex];
    if (!idea) {
      badRequest(res, "当前选题不存在，请重新生成或刷新页面后再试。");
      return true;
    }
    const payload = await collectBody(req);
    idea.title = normalizeEditableText(payload.title, 120);
    idea.summary = normalizeEditableText(payload.summary, 500);
    idea.angle = normalizeEditableText(payload.angle, 180);
    idea.brandFit = normalizeEditableText(payload.brandFit, 220);
    idea.audience = normalizeEditableText(payload.audience, 180);
    idea.hook = normalizeEditableText(payload.hook, 220);
    upsertBrandFull(brand);
    json(res, 200, { trend: sanitizeTrend(trend), idea: sanitizeTrend(trend).ideas[ideaIndex] });
    return true;
  }

  const regenerateMatch = pathname.match(/^\/api\/brands\/(\d+)\/trends\/(\d+)\/ideas\/regenerate$/);
  if (req.method === "POST" && regenerateMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(regenerateMatch[1]), user.id);
    if (!brand) {
      badRequest(res, "当前品牌不存在或你没有访问权限，请刷新页面后重试。");
      return true;
    }
    const trend = findTrendItem(brand, Number(regenerateMatch[2]));
    if (!trend) {
      badRequest(res, "当前选题关联的趋势已失效，请重新进入该品牌的内容选题页后再试。");
      return true;
    }

    const payload = await collectBody(req);
    const customPrompt = String(payload.customPrompt || "").trim();
    if (!hasEnoughCredits(user, CREDIT_COSTS.regenerateIdeas, res)) return true;
    const next = await regenerateTrendIdeas(brand, trend, customPrompt);
    const nextCredits = Number(user.credits || 0) - CREDIT_COSTS.regenerateIdeas;
    updateUserCredits(user.id, nextCredits);
    const updatedUser = findUserById(user.id);
    insertCreditEvent({
      userId: user.id,
      actionType: "regenerateIdeas",
      actionLabel: "重新生成选题",
      creditDelta: -CREDIT_COSTS.regenerateIdeas,
      creditCost: CREDIT_COSTS.regenerateIdeas,
      brandId: brand.id,
      brandName: brand.name,
      trendId: trend.id,
      trendTitle: trend.title,
      summary: customPrompt || `${brand.name} / ${trend.title}`,
      payload: {
        customPrompt,
      },
    });
    trend.customPrompt = customPrompt;
    trend.systemPrompt = next.systemPrompt;
    trend.ideas = next.ideas;
    upsertBrandFull(brand);
    json(res, 200, {
      trend: sanitizeTrend(trend),
      user: sanitizeUser(updatedUser),
      promptInfo: {
        systemPrompt: trend.systemPrompt,
        customPrompt,
      },
    });
    return true;
  }

  return false;
}

module.exports = {
  handleTrendRoutes,
};
