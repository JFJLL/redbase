/**
 * Types shared across the excellent-content feature.
 * Field names mirror the Node backend responses exactly.
 */

export type ExcellentBoard = "xhs_hot" | "ecommerce_hot" | "xingtu";

export interface ExcellentNoteMetrics {
  readCount?: number;
  engagementCount?: number;
  likeCount?: number;
  favoriteCount?: number;
    commentCount?: number;
  viewCount?: number;
  shareCount?: number;
  finishRate?: number;
  interactRate?: number;
  [key: string]: unknown;

}

export interface ExcellentNote {
    noteId?: string;
  itemId?: string;
  id?: string;

  title?: string;
  content?: string;
  coverUrl?: string;
  imageUrls?: string[];
  imageCount?: number;
    authorName?: string;
  author?: { nickname?: string; followerCount?: number; [key: string]: unknown };
  category?: string;
  duration?: number;
  videoId?: string;
  playerUrl?: string;
  videoUrl?: string;
  officialContentMarketUrl?: string;
  transcriptUrl?: string;
  noteType?: "image" | "video" | string;
  rank?: number;
  contentSource?: string;

  categoryPath?: string;
  industryPath?: string;
  metrics?: ExcellentNoteMetrics;
  [key: string]: unknown;
}

export interface ExcellentListResult {
  board?: string;
  contentSource?: string;
  categoryPath?: string;
  industryPath?: string;
  items?: ExcellentNote[];
  updatedAt?: string;
  stale?: boolean;
  hasCache?: boolean;
  needsUpdate?: boolean;
  [key: string]: unknown;
}

export interface XingtuTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface XingtuTranscriptResult {
  itemId?: string;
  available?: boolean;
  segments?: XingtuTranscriptSegment[];
  sourceUrl?: string;
  fetchedAt?: string;
  [key: string]: unknown;
}

export interface XingtuLearningAnalysis {
  available?: boolean;
  title?: string;
  summary?: string;
  disclaimer?: string;
  structure?: Array<{ label?: string; range?: string; text?: string }>;
  learningPoints?: string[];
  originalGuidance?: string[];
  [key: string]: unknown;
}

export interface XingtuLearnResult {
  itemId?: string;
  transcript?: { available?: boolean; segmentCount?: number; sourceUrl?: string; fetchedAt?: string };
  analysis?: XingtuLearningAnalysis;
}

export interface ExcellentDetailResult {

  item?: ExcellentNote;
  complete?: boolean;
  [key: string]: unknown;
}

export interface ContentSourceOption {
  value?: string;
  label?: string;
  [key: string]: unknown;
}

export interface TaxonomyNode {
  label?: string;
  value?: string;
  children?: TaxonomyNode[];
}

export interface TaxonomyResult {
  board?: string;
  taxonomyType?: string;
  tree?: { items?: TaxonomyNode[] };
}

export interface RemixAnalysis {
  analysisId?: string;
  analysisMode?: string;
  referenceTopic?: string;
  /** 面向用户的学习摘要（不含 JSON/prompt/技术字段）。 */
  learningSummary?: string[];
  /** 多模态降级时的诚实提示，例如“未成功读取参考图片…”。 */
  warning?: string;
  meta?: { multimodalUsed?: boolean; [key: string]: unknown };
  visualLanguage?: { source?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SmartDirection {
  id: string;
  title?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface ExistingIdea {
  scope?: string;
  analysisId?: number | string | null;
  trendId?: number | string;
  ideaIndex?: number;
  ideaTitle?: string;
  ideaSummary?: string;
  trendTitle?: string;
  audience?: string;
  scene?: string;
  brandFit?: string;
  analysisName?: string;
  [key: string]: unknown;
}

export interface CarouselSlide {
  title?: string;
  imageUrl?: string;
  previewUrl?: string;
  isGenerating?: boolean;
  isQueued?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface CarouselPack {
  publishTitle?: string;
  carouselGroupId?: string;
  aspectRatio?: string;
  slides?: CarouselSlide[];
  [key: string]: unknown;
}

export interface FusionPlan {
  carouselPack?: CarouselPack;
  contentThesis?: string;
  trendUsed?: boolean;
  trendTitle?: string;
  [key: string]: unknown;
}

/** 服务端返回的计费摘要：前端只展示，不参与免费次数判定。 */
export interface RemixBillingInfo {
  requestId?: string;
  cacheHit?: boolean;
  replayed?: boolean;
  charged?: boolean;
  creditCost?: number;
  credits?: number;
  windowCount?: number;
  freeLimit?: number;
  windowMs?: number;
  nextChargeable?: boolean;
  [key: string]: unknown;
}

export interface BrandSummary {
  id: number | string;
  name?: string;
  logo?: unknown;
  [key: string]: unknown;
}

export interface ProductImage {
  id: number;
  fileName?: string;
  name?: string;
  brandId?: number | null;
  url?: string;
  [key: string]: unknown;
}
