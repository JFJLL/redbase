/**
 * Types shared across the excellent-content feature.
 * Field names mirror the Node backend responses exactly.
 */

export type ExcellentBoard = "xhs_hot" | "ecommerce_hot";

export interface ExcellentNoteMetrics {
  readCount?: number;
  engagementCount?: number;
  likeCount?: number;
  favoriteCount?: number;
  commentCount?: number;
  [key: string]: unknown;
}

export interface ExcellentNote {
  noteId?: string;
  id?: string;
  title?: string;
  content?: string;
  coverUrl?: string;
  imageUrls?: string[];
  imageCount?: number;
  authorName?: string;
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
