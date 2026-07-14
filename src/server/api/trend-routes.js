const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { trySpendCreditsWithEvent, refundCreditEventIfNeeded } = require("../db/repositories/admin-repository");
const {
  findBrandByOwner,
  upsertBrandFull,
  allocateAnalysisAndTrendBase,
} = require("../db/repositories/brand-repository");
const {
  PGY_MAX_CATEGORY_PATH_LENGTH,
  fetchPgyCategoryTree,
  getPgyPublicErrorMessage,
  isPgyCategoryPathInTree,
  normalizePgyCategoryPath,
} = require("../integrations/pgy-content-square");
const { TREND_BUCKET_META, normalizeTrendBucketKey } = require("../ai/trend-service");

function resolveTrendBucketForRequest(value) {
  const key = normalizeTrendBucketKey(value || "xhs");
  return TREND_BUCKET_META.find((bucket) => bucket.key === key) || TREND_BUCKET_META[0];
}

function mergeGeneratedTrendBucket(existingBuckets, generatedBuckets) {
  const generatedKeys = new Set((generatedBuckets || []).map((bucket) => normalizeTrendBucketKey(bucket.key)));
  return [
    ...(existingBuckets || []).filter((bucket) => !generatedKeys.has(normalizeTrendBucketKey(bucket.key))),
    ...(generatedBuckets || []),
  ];
}

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

  if (req.method === "GET" && pathname === "/api/trends/xhs/categories") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    try {
      const categoryTree = await fetchPgyCategoryTree(appConfig);
      json(res, 200, categoryTree);
    } catch (error) {
      console.warn("[trend-analysis] failed to load pgy categories", {
        userId: user.id,
        code: error?.code || "UNKNOWN",
        message: error?.code ? getPgyPublicErrorMessage(error) : String(error?.message || "unknown error"),
      });
      badRequest(res, getPgyPublicErrorMessage(error));
    }
    return true;
  }

  const analysisMatch = pathname.match(/^\/api\/brands\/(\d+)\/analyses$/);
  const analysisDeleteMatch = pathname.match(/^\/api\/brands\/(\d+)\/analyses\/(\d+)$/);
  if (req.method === "DELETE" && analysisDeleteMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const brand = findBrandByOwner(Number(analysisDeleteMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }

    const analysisId = Number(analysisDeleteMatch[2]);
    const beforeCount = Array.isArray(brand.analyses) ? brand.analyses.length : 0;
    brand.analyses = (brand.analyses || []).filter((analysis) => Number(analysis.id) !== analysisId);
    if (brand.analyses.length === beforeCount) {
      notFound(res);
      return true;
    }

    const savedBrand = upsertBrandFull(brand);
    json(res, 200, {
      ok: true,
      brand: sanitizeBrand(savedBrand, appConfig),
      deletedAnalysisId: analysisId,
    });
    return true;
  }

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

    const payload = await collectBody(req);
    const selectedBucket = resolveTrendBucketForRequest(payload.bucketKey || payload.trendBucketKey || payload.bucket);
    const rawXhsCategoryPath = selectedBucket.key === "xhs" ? String(payload.xhsCategoryPath || "").trim() : "";
    if (rawXhsCategoryPath.length > PGY_MAX_CATEGORY_PATH_LENGTH) {
      badRequest(res, "小红书内容类目路径过长，请重新选择类目后再试。");
      return true;
    }
    const xhsCategoryPath = normalizePgyCategoryPath(rawXhsCategoryPath);
    if (xhsCategoryPath) {
      try {
        const categoryTree = await fetchPgyCategoryTree(appConfig);
        if (!isPgyCategoryPathInTree(xhsCategoryPath, categoryTree)) {
          badRequest(res, "当前小红书内容类目不可用，请刷新类目后重新选择。");
          return true;
        }
      } catch (error) {
        console.warn("[trend-analysis] failed to validate pgy category", {
          userId: user.id,
          brandId: brand.id,
          code: error?.code || "UNKNOWN",
          message: error?.code ? getPgyPublicErrorMessage(error) : String(error?.message || "unknown error"),
        });
        badRequest(res, getPgyPublicErrorMessage(error));
        return true;
      }
    }
    const spendResult = trySpendCreditsWithEvent({
      userId: user.id,
      amount: CREDIT_COSTS.analysis,
      event: {
        actionType: "analysis",
        actionLabel: "AI 热点分析",
        brandId: brand.id,
        brandName: brand.name,
        summary: `${brand.name} ${selectedBucket.title}`,
      },
    });
    if (!spendResult.spent) {
      const current = Number(spendResult.user?.credits || 0);
      json(res, 402, { error: `积分不足，本次操作需要 ${CREDIT_COSTS.analysis} 积分，当前剩余 ${current} 积分。` });
      return true;
    }
    const { analysisId, trendBase } = allocateAnalysisAndTrendBase();
    brand.analyses.unshift({
      id: analysisId,
      name: `${brand.name} - ${selectedBucket.title}`,
      timestamp: formatTimestamp(),
      trendSnapshot: [],
    });
    let analysisWarnings = [];
    let generatedTrends = [];
    try {
      generatedTrends = await generateAiTrendSet(brand, trendBase, {
        bucketKey: selectedBucket.key,
        xhsCategoryPath,
      });
      analysisWarnings = Array.isArray(generatedTrends.analysisWarnings) ? generatedTrends.analysisWarnings : [];
      brand.trends = mergeGeneratedTrendBucket(brand.trends, generatedTrends);
    } catch (error) {
      refundCreditEventIfNeeded({
        creditEventId: spendResult.creditEvent.id,
        userId: user.id,
        reason: error?.message || "trend analysis failed",
      });
      console.warn("[trend-analysis] analysis failed for request", {
        userId: user.id,
        brandId: brand.id,
        brandName: brand.name,
        bucketKey: selectedBucket.key,
        code: error?.code || "UNKNOWN",
        message: error?.code ? getPgyPublicErrorMessage(error) : error?.message || "unknown error",
      });
      badRequest(res, error?.code ? getPgyPublicErrorMessage(error) : error?.message || "本次分析未能获取到可用热点，请稍后重试。");
      return true;
    }
    brand.analyses[0].trendSnapshot = cloneTrendBuckets(generatedTrends);
    const savedBrand = upsertBrandFull(brand);
    json(res, 200, {
      brand: sanitizeBrand(savedBrand, appConfig),
      user: sanitizeUser(spendResult.user),
      warnings: analysisWarnings,
    });
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
    const spendResult = trySpendCreditsWithEvent({
      userId: user.id,
      amount: CREDIT_COSTS.regenerateIdeas,
      event: {
        actionType: "regenerateIdeas",
        actionLabel: "重新生成选题",
        brandId: brand.id,
        brandName: brand.name,
        trendId: trend.id,
        trendTitle: trend.title,
        summary: customPrompt || `${brand.name} / ${trend.title}`,
        payload: { customPrompt },
      },
    });
    if (!spendResult.spent) {
      const current = Number(spendResult.user?.credits || 0);
      json(res, 402, { error: `积分不足，本次操作需要 ${CREDIT_COSTS.regenerateIdeas} 积分，当前剩余 ${current} 积分。` });
      return true;
    }
    let next;
    try {
      next = await regenerateTrendIdeas(brand, trend, customPrompt);
    } catch (error) {
      refundCreditEventIfNeeded({
        creditEventId: spendResult.creditEvent.id,
        userId: user.id,
        reason: error?.message || "regenerate ideas failed",
      });
      badRequest(res, error?.message || "重新生成选题失败，请稍后重试。");
      return true;
    }
    trend.customPrompt = customPrompt;
    trend.ideas = next.ideas;
    upsertBrandFull(brand);
    json(res, 200, {
      trend: sanitizeTrend(trend),
      user: sanitizeUser(spendResult.user),
    });
    return true;
  }

  return false;
}

module.exports = {
  handleTrendRoutes,
};
