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
};


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
  return generation.type === "xhsCarousel" ? CREDIT_COSTS.xhsCarousel : CREDIT_COSTS.momentsImage;
}
module.exports = {
  CREDIT_COSTS,
  hasEnoughCredits,
  getCreditEventCost,
  getGenerationTokenCost,
};