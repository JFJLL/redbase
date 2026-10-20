// 趋势维度常量，1:1 迁移自旧前端 public/js/config.js。
// 顺序与 key 必须与后端 TREND_BUCKET_META 及旧版展示保持一致。

export interface TrendBucketMeta {
  key: string;
  title: string;
  description: string;
}

export const DEFAULT_TREND_BUCKETS: TrendBucketMeta[] = [
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

/** 旧数据里的历史 bucket key 映射（global→xhs、industry→track）。 */
export const LEGACY_TREND_BUCKET_KEYS: Record<string, string> = {
  global: "xhs",
  industry: "track",
};

/** 个人 IP 档案下各维度的描述文案（旧版 PERSONAL_TREND_BUCKET_DESCRIPTIONS）。 */
export const PERSONAL_TREND_BUCKET_DESCRIPTIONS: Record<string, string> = {
  xhs: "从小红书站内高讨论、高收藏、高互动内容里筛选适合个人 IP 真诚参与的话题方向。",
  traffic: "从可核验的标题结构、叙事节奏、场景表达和互动设计中找到个人内容的传播机会。",
  news: "从近期新闻、行业动态和职业趋势中找到适合个人经验与观点切入的内容机会。",
  social: "从大众情绪、生活方式变化和公共讨论中找到适合个人经历与观点表达的切口。",
  track: "聚焦个人 IP 所在领域、同类创作者和受众决策链路里的专业内容机会。",
  crowd: "聚焦目标读者正在经历的身份变化、真实场景、困惑与内容需求。",
};

/** 服务端 409（同一请求生成中）后自动重试的轮询间隔。 */
export const TREND_ANALYSIS_POLL_INTERVAL_MS = 5000;
