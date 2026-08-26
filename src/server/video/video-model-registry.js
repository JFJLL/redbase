const VIDEO_ASPECT_RATIOS = Object.freeze(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
const VIDEO_TOTAL_DURATION_OPTIONS = Object.freeze([10, 15, 30, 45, 60]);

const SHARED_HIDDEN_DEFAULTS = Object.freeze({
  generateAudio: true,
  watermark: false,
  realPersonMode: true,
  returnLastFrame: true,
  seed: -1,
});

const MODEL_REGISTRY = Object.freeze({
  d2: Object.freeze({
    id: "d2",
    displayName: "D2",
    provider: "runninghub",
    enabled: true,
    supportedModes: Object.freeze(["text", "image"]),
    resolutions: Object.freeze(["720p", "1080p", "2K"]),
    aspectRatios: VIDEO_ASPECT_RATIOS,
    totalDurationOptions: VIDEO_TOTAL_DURATION_OPTIONS,
    clipDurationRules: Object.freeze({ min: 4, max: 15 }),
    preferredClipDurations: Object.freeze([10, 5]),
    maxReferenceImages: 9,
    pricing: Object.freeze({ "720p": 2, "1080p": 3, "2K": 4 }),
    pricingUnit: "per_second",
    hiddenDefaults: SHARED_HIDDEN_DEFAULTS,
    providerCapabilities: Object.freeze({
      // Product V1 deliberately exposes image references only, even where the
      // upstream provider has broader multimodal capabilities.
      supportsVideoInput: false,
      supportsAudioInput: false,
      supportsNativeLastFrame: true,
    }),
  }),
  g2: Object.freeze({
    id: "g2",
    displayName: "G2",
    provider: "agnes",
    enabled: true,
    supportedModes: Object.freeze(["text", "image"]),
    resolutions: Object.freeze(["720p"]),
    aspectRatios: VIDEO_ASPECT_RATIOS,
    totalDurationOptions: VIDEO_TOTAL_DURATION_OPTIONS,
    allowedClipDurations: Object.freeze([5, 10]),
    clipDurationRules: Object.freeze({ min: 5, max: 10 }),
    preferredClipDurations: Object.freeze([10, 5]),
    maxReferenceImages: 5,
    pricing: Object.freeze({ "5": 1, "10": 2 }),
    pricingUnit: "per_clip",
    promotionLabel: "限时特惠",
    hiddenDefaults: Object.freeze({}),
    providerCapabilities: Object.freeze({
      supportsVideoInput: false,
      supportsAudioInput: false,
      supportsNativeLastFrame: false,
      modes: Object.freeze(["text", "keyframe", "reference"]),
    }),
  }),
});

function normalizeModelId(value, fallback = "d2") {
  const id = String(value || "").trim().toLowerCase();
  return MODEL_REGISTRY[id] ? id : fallback;
}

function getVideoModelConfig(value) {
  return MODEL_REGISTRY[normalizeModelId(value)] || MODEL_REGISTRY.d2;
}

function resolveVideoAspectRatio(value, fallback = "9:16") {
  const ratio = String(value || "").trim();
  return VIDEO_ASPECT_RATIOS.includes(ratio) ? ratio : fallback;
}

function normalizeResolution(model, value) {
  const config = getVideoModelConfig(model);
  const requested = String(value || "").trim();
  return config.resolutions.includes(requested) ? requested : config.resolutions[0];
}

function normalizeTotalDuration(value, fallback = 30) {
  const numeric = Number(value);
  return VIDEO_TOTAL_DURATION_OPTIONS.includes(numeric) ? numeric : fallback;
}

function segmentVideoDuration(model, value) {
  const config = getVideoModelConfig(model);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return [];
  if (numeric <= config.clipDurationRules.max) {
    if (numeric < config.clipDurationRules.min) return [];
    return [numeric];
  }

  const clips = [];
  let remaining = numeric;
  while (remaining > 0) {
    let next = Math.min(config.preferredClipDurations[0], remaining);
    const after = remaining - next;
    if (after > 0 && after < config.clipDurationRules.min) {
      next -= config.clipDurationRules.min - after;
    }
    if (next < config.clipDurationRules.min || next > config.clipDurationRules.max) return [];
    clips.push(next);
    remaining -= next;
  }

  if (config.allowedClipDurations) {
    const allowed = config.allowedClipDurations;
    if (clips.some((clip) => !allowed.includes(clip))) return [];
  }
  return clips;
}

function estimateVideoCredits({ model = "d2", resolution = "720p", totalDurationSec, clipDurations } = {}) {
  const config = getVideoModelConfig(model);
  const durations = Array.isArray(clipDurations) && clipDurations.length
    ? clipDurations.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : segmentVideoDuration(config.id, normalizeTotalDuration(totalDurationSec));
  if (!durations.length) return 0;
  if (config.pricingUnit === "per_clip") {
    return durations.reduce((sum, duration) => sum + Number(config.pricing[String(duration)] || 0), 0);
  }
  const price = Number(config.pricing[normalizeResolution(config.id, resolution)] || 0);
  return durations.reduce((sum, duration) => sum + duration * price, 0);
}

function getPublicVideoCapabilities() {
  return Object.values(MODEL_REGISTRY)
    .filter((config) => config.enabled)
    .map((config) => ({
      id: config.id,
      displayName: config.displayName,
      provider: config.provider,
      supportedModes: [...config.supportedModes],
      resolutions: [...config.resolutions],
      aspectRatios: [...config.aspectRatios],
      totalDurationOptions: [...config.totalDurationOptions],
      clipDurationRules: { ...config.clipDurationRules },
      allowedClipDurations: config.allowedClipDurations ? [...config.allowedClipDurations] : undefined,
      preferredClipDurations: [...config.preferredClipDurations],
      maxReferenceImages: config.maxReferenceImages,
      pricing: { ...config.pricing },
      pricingUnit: config.pricingUnit,
      promotionLabel: config.promotionLabel || "",
    }));
}

module.exports = {
  VIDEO_ASPECT_RATIOS,
  VIDEO_TOTAL_DURATION_OPTIONS,
  MODEL_REGISTRY,
  normalizeModelId,
  getVideoModelConfig,
  resolveVideoAspectRatio,
  normalizeResolution,
  normalizeTotalDuration,
  segmentVideoDuration,
  estimateVideoCredits,
  getPublicVideoCapabilities,
};
