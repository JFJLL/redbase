const ANALYTICS_FEATURES = {
  TREND_ANALYSIS: "trend_analysis",
  EXCELLENT_DIRECTION: "excellent_direction",
  EXCELLENT_FUSION: "excellent_fusion",
  MOMENTS: "moments",
  WECHAT_LONG_IMAGE: "wechat_long_image",
  XHS_CAROUSEL: "xhs_carousel",
  STYLE_IMAGE: "style_image",
  IMAGE_EDIT: "image_edit",
  VIDEO_SCRIPT: "video_script",
  VIDEO_PROJECT: "video_project",
};

const ANALYTICS_FEATURE_NAMES = [
  "trend_analysis",
  "excellent_direction",
  "excellent_fusion",
  "moments",
  "wechat_long_image",
  "xhs_carousel",
  "style_image",
  "image_edit",
  "video_script",
  "video_project",
];

const ANALYTICS_FEATURE_LABELS = {
  trend_analysis: "趋势分析",
  excellent_direction: "优秀内容方向",
  excellent_fusion: "优秀内容融合",
  moments: "朋友圈",
  wechat_long_image: "公众号长图",
  xhs_carousel: "小红书组图",
  style_image: "风格图",
  image_edit: "图片编辑",
  video_script: "视频脚本",
  video_project: "AI 视频",
};

const RAW_FEATURE_TO_ANALYTICS_FEATURE = {
  moments: "moments",
  momentsImage: "moments",
  wechat: "wechat_long_image",
  wechatImage: "wechat_long_image",
  xhsCarousel: "xhs_carousel",
  xhsCarouselSlide: "xhs_carousel",
  styleImage: "style_image",
  imageEdit: "image_edit",
  videoScript: "video_script",
  videoProject: "video_project",
  videoProjectRetry: "video_project",
  trendAnalysis: "trend_analysis",
  excellentDirection: "excellent_direction",
  excellentFusion: "excellent_fusion",
};

function normalizeAnalyticsFeature(value, fallback = "other") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (ANALYTICS_FEATURE_NAMES.includes(raw)) return raw;
  return RAW_FEATURE_TO_ANALYTICS_FEATURE[raw] || fallback;
}

const CLIENT_EVENT_WHITELIST = new Set([
  "video_studio_opened",
  "video_step_viewed",
  "recharge_page_viewed",
  "final_asset_downloaded",
]);

const ATTEMPT_KINDS = new Set([
  "initial",
  "auto_retry",
  "manual_retry",
  "result_retry",
  "assembly_initial",
  "assembly_retry",
  "historical_summary",
]);

const ERROR_STAGES = new Set([
  "validation",
  "billing",
  "submission",
  "provider",
  "poll",
  "download",
  "persist",
  "frame_extract",
  "assembly",
  "configuration",
  "cancelled",
  "unknown",
]);

function getReleaseSha() {
  return String(process.env.REDBASE_RELEASE_SHA || "").trim();
}

module.exports = {
  ANALYTICS_FEATURES,
  ANALYTICS_FEATURE_NAMES,
  ANALYTICS_FEATURE_LABELS,
  normalizeAnalyticsFeature,
  CLIENT_EVENT_WHITELIST,
  ATTEMPT_KINDS,
  ERROR_STAGES,
  getReleaseSha,
};
