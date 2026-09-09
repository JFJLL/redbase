const { json } = require("./http-utils");
const CREDIT_COSTS = {
  analysis: 1,
  regenerateIdeas: 1,
  momentsImage: 1,
  wechatImage: 1,
  xhsCarousel: 4,
  xhsCarouselSlide: 1,
  imageEdit: 1,
  styleImage: 1,
  videoScript: 1,
  excellentContentDirection: 1,
  excellentFusionPlan: 1,
};

const IMAGE_MODELS = Object.freeze(["image2", "image2.5"]);
const DEFAULT_IMAGE_MODEL = "image2";

const IMAGE_RESOLUTIONS = Object.freeze(["1k", "2k", "4k"]);
const DEFAULT_IMAGE_RESOLUTION = "1k";

function normalizeImageModel(rawModel) {
  const model = String(rawModel || "").trim().toLowerCase();
  if (model === "image2.5" || model === "image-2.5" || model === "gpt-image-2.5") return "image2.5";
  return "image2";
}

function normalizeImageResolution(rawResolution) {
  const res = String(rawResolution || "").trim().toLowerCase();
  if (res === "2k") return "2k";
  if (res === "4k") return "4k";
  return "1k";
}

function getImageCreditCost(actionType, rawModel = DEFAULT_IMAGE_MODEL, rawResolution = DEFAULT_IMAGE_RESOLUTION) {
  const model = normalizeImageModel(rawModel);
  const resolution = normalizeImageResolution(rawResolution);
  const extraModelCost = model === "image2.5" ? 1 : 0;
  const extraResCost = resolution === "4k" ? 2 : (resolution === "2k" ? 1 : 0);
  const totalExtraPerImage = extraModelCost + extraResCost;
  if (actionType === "xhsCarousel") {
    const base = Number(CREDIT_COSTS.xhsCarousel || 4);
    return base + (totalExtraPerImage * 4);
  }
  const base = Number(CREDIT_COSTS[actionType] || 1);
  return base + totalExtraPerImage;
}

function hasEnoughCredits(user, cost, res) {
  const current = Number(user.credits || 0);
  if (current < cost) {
    json(res, 402, { error: `积分不足，本次操作需要 ${cost} 积分，当前剩余 ${current} 积分。` });
    return false;
  }
  return true;
}

function getCreditEventCost(event) {
  const explicit = Number(event?.creditCost || 0);
  if (explicit > 0) return explicit;
  const delta = Number(event?.creditDelta || 0);
  return delta < 0 ? Math.abs(delta) : 0;
}

function getGenerationTokenCost(generation, event) {
  const eventCost = getCreditEventCost(event);
  if (eventCost > 0) return eventCost;
  if (generation.type === "xhsCarousel") return CREDIT_COSTS.xhsCarousel;
  if (generation.type === "videoScript") return CREDIT_COSTS.videoScript;
  return CREDIT_COSTS.momentsImage;
}
module.exports = {
  CREDIT_COSTS,
  IMAGE_MODELS,
  DEFAULT_IMAGE_MODEL,
  IMAGE_RESOLUTIONS,
  DEFAULT_IMAGE_RESOLUTION,
  normalizeImageModel,
  normalizeImageResolution,
  getImageCreditCost,
  hasEnoughCredits,
  getCreditEventCost,
  getGenerationTokenCost,
};
