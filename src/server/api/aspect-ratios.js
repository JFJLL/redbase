const SUPPORTED_ASPECT_RATIOS = Object.freeze([
  "1:1",
  "1:2",
  "2:1",
  "1:3",
  "3:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "21:9",
  "9:21",
  "16:9",
]);

const SUPPORTED_ASPECT_RATIO_SET = new Set(SUPPORTED_ASPECT_RATIOS);

const DEFAULT_ASPECT_RATIOS = Object.freeze({
  moments: "3:4",
  wechat: "9:21",
  xhsCarousel: "3:4",
  xhsCarouselSlide: "3:4",
  styleImage: "3:4",
});

function isSupportedAspectRatio(value) {
  return SUPPORTED_ASPECT_RATIO_SET.has(String(value || "").trim());
}

function getDefaultAspectRatio(type) {
  return DEFAULT_ASPECT_RATIOS[String(type || "").trim()] || "3:4";
}

function resolveAspectRatio(value, type) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "smart") return getDefaultAspectRatio(type);
  return isSupportedAspectRatio(normalized) ? normalized : null;
}

module.exports = {
  SUPPORTED_ASPECT_RATIOS,
  getDefaultAspectRatio,
  isSupportedAspectRatio,
  resolveAspectRatio,
};
