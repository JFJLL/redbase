// 趋势/选题相关的 API 数据类型。字段名与后端 src/server/utils.js 的
// sanitizeBrand / sanitizeTrend / sanitizeIdea 输出保持一致。
import type { SessionUser } from "@/shared/types/api";

export interface TrendIdea {
  title: string;
  summary: string;
  angle: string;
  brandFit: string;
  audience: string;
  hook: string;
  tags: string[];
  contentAssets: IdeaContentAssets;
}

export interface IdeaContentAssets {
  moments?: { title?: string; caption?: string; [key: string]: unknown };
  xhsCarousel?: {
    title?: string;
    caption?: string;
    publishTitle?: string;
    publishCaption?: string;
    slides?: unknown[];
    [key: string]: unknown;
  };
  wechatLongImage?: { intro?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TrendEvidence {
  provider: string;
  id: string;
  title: string;
  url: string;
  source: string;
  host: string;
  publishedAt: string;
  snippet: string;
  sourceType: string;
  platformType: string;
  trustLevel: string;
  retrievedAt: string;
  metrics?: Record<string, unknown>;
}

export interface TrendItem {
  id: number;
  stableKey: string;
  rank: number;
  title: string;
  category: string;
  summary: string;
  score: number;
  tags: string[];
  evidenceIds: string[];
  evidence: TrendEvidence[];
  reason: string;
  ideas: TrendIdea[];
  customPrompt: string;
}

export interface TrendBucket {
  key: string;
  title: string;
  description: string;
  items: TrendItem[];
}

export interface BrandAnalysis {
  id: number;
  name: string;
  timestamp: string;
  brandBrief?: Record<string, unknown>;
  trendSnapshot: TrendBucket[];
}

export interface BrandLogo {
  originalName: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** 品牌/个人 IP 档案。summary 接口不含 knowledgeBase/trends/analyses，
 *  详情接口补全；_detailLoaded 用于区分（与旧版 markBrandSummary 一致）。 */
export interface InsightsBrand {
  id: number;
  ownerUserId?: number;
  name: string;
  industry: string;
  audience: string;
  description: string;
  profileType: "brand" | "personal";
  contentPillars: string[];
  personaStyle: string;
  materialCount?: number;
  logo: BrandLogo | null;
  assetTags: string[];
  knowledgeBase: string;
  trendCount?: number;
  analysisCount?: number;
  trends: TrendBucket[];
  analyses: BrandAnalysis[];
  _detailLoaded: boolean;
}

export interface XhsCategoryNode {
  label: string;
  value: string;
  children?: XhsCategoryNode[];
}

export interface XhsCategoryOption {
  label: string;
  value: string;
}

// --- API 响应 ---

export interface BrandListResponse {
  brands: InsightsBrand[];
}

export interface BrandDetailResponse {
  brand: InsightsBrand;
}

export interface XhsCategoryTreeResponse {
  items?: XhsCategoryNode[];
}

export interface TrendAnalysisResponse {
  brand: InsightsBrand;
  user: SessionUser;
  warnings: string[];
  replayed?: boolean;
}

export interface AnalysisDeleteResponse {
  ok: boolean;
  brand: InsightsBrand;
  deletedAnalysisId: number;
}

export interface RegenerateIdeasResponse {
  trend: TrendItem;
  user: SessionUser;
}

export interface IdeaUpdateResponse {
  trend: TrendItem;
  idea: TrendIdea;
}
