const MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS = 5000;
const { sanitizeTrend } = require("../utils");
function getTrendAnalysisBrandProfileSize(brand) {
  const fields = [
    brand?.name,
    brand?.industry,
    brand?.audience,
    brand?.description,
    brand?.product,
    brand?.goal,
    brand?.knowledgeBase,
    ...(Array.isArray(brand?.assetTags) ? brand.assetTags : []),
  ];
  return {
    total: fields.reduce((sum, value) => sum + String(value || "").trim().length, 0),
  };
}

function isAdminUser(user, appConfig) {
  const configuredPhones = getConfiguredAdminPhones(appConfig);
  if (configuredPhones.length) {
    return configuredPhones.includes(String(user.phone || "").trim());
  }
  return false;
}

function getConfiguredAdminPhones(appConfig) {
  const phones = appConfig?.admin?.phones;
  if (!Array.isArray(phones)) return [];
  return phones.map((phone) => String(phone || "").trim()).filter(Boolean);
}

function findTrendItem(brand, trendId) {
  if (!brand || !Array.isArray(brand.trends)) return null;
  for (const bucket of brand.trends) {
    if (Array.isArray(bucket.items)) {
      const found = bucket.items.find((item) => item.id === trendId);
      if (found) return found;
    }
  }
  return null;
}

function normalizeEditableText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cloneTrendBuckets(trends) {
  return (Array.isArray(trends) ? trends : []).map((bucket) => ({
    key: bucket.key,
    title: bucket.title,
    description: bucket.description,
    items: Array.isArray(bucket.items) ? bucket.items.map(sanitizeTrend) : [],
  }));
}

function isRenderableGeneration(item) {
  if (item.type !== "xhsCarousel") return true;
  const slides = Array.isArray(item.payload?.slides) ? item.payload.slides : [];
  return slides.length === 4 && slides.every((slide) => Boolean(String(slide.imageUrl || slide.previewUrl || "").trim()));
}
module.exports = {
  MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS,
  getTrendAnalysisBrandProfileSize,
  isAdminUser,
  getConfiguredAdminPhones,
  findTrendItem,
  normalizeEditableText,
  cloneTrendBuckets,
  isRenderableGeneration,
};