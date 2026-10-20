export const SIDEBAR_COLLAPSED_KEY = "redbase.sidebarCollapsed";
export const PENDING_IMAGE_TASKS_KEY = "redbase.pendingImageTasks";
export const IMAGE_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
export const IMAGE_JOB_POLL_INTERVAL_MS = 5000;
export const IMAGE_TASK_MAX_CONCURRENCY = 30;
export const MAX_SELECTED_PRODUCT_IMAGES = 10;
export const MAX_SELECTED_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_SINGLE_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_BRAND_PROFILE_CHARS = 5000;

export const DEFAULT_TREND_BUCKETS = [
  {
    key: "xhs",
    title: "小红书热点话题",
    description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
  },
  {
    key: "traffic",
    title: "流量热点趋势",
    description: "从小红书站内爆款形式、标题结构、场景表达和内容套路中找到流量机会。",
  },
  {
    key: "news",
    title: "新闻热点趋势",
    description: "从近期新闻、行业动态和消费趋势中找到可被品牌内容化的机会。",
  },
  {
    key: "social",
    title: "社会热点趋势",
    description: "从大众情绪、生活方式变化、社会议题和公共讨论中找到适合品牌表达的切口。",
  },
  {
    key: "track",
    title: "赛道热点趋势",
    description: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
  },
  {
    key: "crowd",
    title: "人群热点趋势",
    description: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
  },
];

export const DEFAULT_TREND_MODE = DEFAULT_TREND_BUCKETS[0].key;
export const LEGACY_TREND_BUCKET_KEYS = {
  global: "xhs",
  industry: "track",
};
