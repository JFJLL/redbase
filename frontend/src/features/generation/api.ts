/**
 * Image job API for the generation feature. Mirrors public/js/api-client.js
 * pollImageJob semantics plus the legacy idea-driven generation flows from
 * public/app.js (moments / wechat long image / xhs carousel / style image)
 * and the product image library endpoints (product-image-routes.js).
 */
import { apiFetch } from "@/shared/api/client";
import type { SessionUser } from "@/shared/types/api";

export const IMAGE_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
export const IMAGE_JOB_POLL_INTERVAL_MS = 5000;

// —— Legacy constants (public/app.js lines 105-129, public/js/config.js) ——
export const IMAGE_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"];
export const SMART_ASPECT_RATIO_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  moments: "3:4",
  wechat: "9:21",
  xhsCarousel: "3:4",
  styleImage: "3:4",
});
export const WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY = "redbase:wechat-aspect-ratio-warning-disabled";
export const MAX_SELECTED_PRODUCT_IMAGES = 10;
export const MAX_SELECTED_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_SINGLE_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

export interface CreativeOption {
  value: string;
  label: string;
  description: string;
}

export const XHS_CREATIVE_STYLE_OPTIONS: readonly CreativeOption[] = Object.freeze([
  { value: "auto", label: "智能匹配", description: "根据选题内容自动选择更合适的视觉路线" },
  { value: "lifestyle", label: "真实生活方式", description: "自然光、真实使用场景与轻松抓拍感" },
  { value: "editorial", label: "杂志编辑感", description: "克制高级，适合审美与品牌内容" },
  { value: "native_note", label: "原生笔记感", description: "便签、圈画和真实记录，弱化广告感" },
  { value: "knowledge", label: "专业知识卡", description: "步骤清晰，适合教程、科普与方法论" },
  { value: "checklist", label: "清单攻略型", description: "编号、清单和收藏提示，适合攻略避坑" },
  { value: "review", label: "产品测评型", description: "细节特写、对比和真实使用证据" },
  { value: "mood", label: "情绪氛围型", description: "少文字、电影感，适合故事与情绪表达" },
  { value: "collage", label: "拼贴灵感型", description: "多图拼贴、纸张肌理和灵感板气质" },
  { value: "minimal_brand", label: "极简品牌型", description: "单主体、统一品牌色与精致留白" },
]);


export const VIDEO_DURATION_OPTIONS: readonly CreativeOption[] = Object.freeze([
  { value: "auto", label: "智能推荐", description: "根据选题内容与创意复杂度自动确定时长（推荐 10s/30s）" },
  { value: "10", label: "10 秒", description: "适合单一产品动作、快速展示与短节奏开场" },
  { value: "15", label: "15 秒", description: "适合快速吸睛、单一亮点卡点与快节奏短视频" },
  { value: "30", label: "30 秒", description: "标准黄金时长，适合完整故事线与产品核心场景展开" },
  { value: "45", label: "45 秒", description: "适合多场景对比、深度干货与递进式叙事" },
  { value: "60", label: "60 秒", description: "适合沉浸式大片感、多维度种草与完整情景剧" },
]);

export const VIDEO_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;

export const WECHAT_TEMPLATE_OPTIONS: readonly CreativeOption[] = Object.freeze([
  { value: "auto", label: "智能配色", description: "根据文章主题自动匹配长图配色与结构" },
  { value: "editorial", label: "深度观点", description: "行业洞察、品牌观点与趋势解读" },
  { value: "tutorial", label: "干货教程", description: "步骤方法、操作指南和科普内容" },
  { value: "report", label: "行业报告", description: "数据卡片、趋势拆解和专业结论" },
  { value: "story", label: "品牌故事", description: "人物、时间线和品牌幕后内容" },
  { value: "product", label: "产品说明", description: "从真实痛点与场景解释产品价值" },
  { value: "minimal", label: "极简长图", description: "少字强观点，适合封面式传播" },
]);

/** getResolvedIdeaAspectRatio semantics: "smart" maps to the per-type default. */
export function resolveAspectRatio(selection: string, type: keyof typeof SMART_ASPECT_RATIO_DEFAULTS | string): string {
  const valid = selection === "smart" || IMAGE_ASPECT_RATIOS.includes(selection) ? selection : "smart";
  return valid === "smart" ? SMART_ASPECT_RATIO_DEFAULTS[type] || "3:4" : valid;
}

// —— Brand detail (GET /api/brands/:id, brand-routes.js sanitizeBrand) ——

export interface IdeaDetail {
  title: string;
  summary: string;
  angle: string;
  brandFit: string;
  audience: string;
  hook: string;
  tags: string[];
  contentAssets?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TrendDetail {
  id: number;
  title: string;
  category?: string;
  summary?: string;
  ideas: IdeaDetail[];
  [key: string]: unknown;
}

export interface TrendBucket {
  key: string;
  title: string;
  description: string;
  items: TrendDetail[];
}

export interface BrandLogoView {
  originalName: string;
  url: string;
  [key: string]: unknown;
}

export interface BrandDetail {
  id: number;
  name: string;
  profileType: "brand" | "personal";
  logo: BrandLogoView | null;
  trends: TrendBucket[];
  [key: string]: unknown;
}

export function fetchBrandDetail(brandId: number, signal?: AbortSignal): Promise<{ brand: BrandDetail }> {
  return apiFetch(`/api/brands/${brandId}`, { signal });
}

/** getSelectedTrend semantics: trends are buckets; find the trend across all buckets. */
export function findTrendInBrand(brand: BrandDetail | null, trendId: number): TrendDetail | null {
  if (!brand) return null;
  for (const bucket of brand.trends || []) {
    const found = (bucket.items || []).find((item) => Number(item.id) === trendId);
    if (found) return found;
  }
  return null;
}

// —— Product image library (product-image-routes.js) ——

export interface ProductImageView {
  id: number;
  originalName: string;
  url: string;
  mimeType?: string;
  sizeBytes: number;
  createdAt?: string;
  lastUsedAt?: string;
  brandId?: number;
  assetType?: string;
}

/** productImages request-body entry, matching getSelectedProductImages output. */
export interface ProductImageInput {
  id?: number;
  name?: string;
  dataUrl?: string;
}

export function fetchProductImages(signal?: AbortSignal): Promise<{ images: ProductImageView[] }> {
  return apiFetch("/api/product-images", { signal });
}

export function uploadProductImage(
  body: { name: string; dataUrl: string; brandId?: number },
  signal?: AbortSignal,
): Promise<{ image: ProductImageView; duplicate?: boolean }> {
  return apiFetch("/api/product-images", { method: "POST", body, signal });
}

export function deleteProductImage(imageId: number, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return apiFetch(`/api/product-images/${imageId}`, { method: "DELETE", signal });
}

// —— Idea-driven generation requests (image-generation-routes.js) ——

export interface IdeaImageJobSubmitResult {
  jobId?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

export interface MomentsImageRequest {
  productImages: ProductImageInput[];
  useBrandLogo: boolean;
  aspectRatio: string;
}

/** POST /api/brands/:brandId/trends/:trendId/ideas/:ideaIndex/image (app.js 4004). */
export function submitMomentsImage(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: MomentsImageRequest,
  signal?: AbortSignal,
): Promise<IdeaImageJobSubmitResult> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/image`, { method: "POST", body, signal });
}

export interface WechatLongImageRequest extends MomentsImageRequest {
  wechatTemplate: string;
}

export interface WechatPack {
  title?: string;
  publishTitle?: string;
  intro?: string;
  outline?: string[];
  positioning?: string;
  cta?: string;
  aspectRatio?: string;
  imageUrl?: string;
  previewUrl?: string;
  [key: string]: unknown;
}

export interface WechatLongImageSubmitResult extends IdeaImageJobSubmitResult {
  wechatPack?: WechatPack;
}

/** POST .../wechat-long-image (app.js 4084). */
export function submitWechatLongImage(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: WechatLongImageRequest,
  signal?: AbortSignal,
): Promise<WechatLongImageSubmitResult> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/wechat-long-image`, {
    method: "POST",
    body,
    signal,
  });
}

// —— XHS carousel three-phase flow (app.js 4287-4460) ——

export interface CarouselSlide {
  title?: string;
  pageLabel?: string;
  visualDirection?: string;
  style?: string;
  composition?: string;
  prompt?: string;
  copy?: string;
  imageUrl?: string;
  previewUrl?: string;
  isGenerating?: boolean;
  isQueued?: boolean;
  error?: string;
  /** 生成后的单页改图输入（旧版 slide edit textarea 状态）。 */
  editPrompt?: string;
  isEditing?: boolean;
  [key: string]: unknown;
}

export interface CarouselPack {
  title?: string;
  publishTitle?: string;
  publishCaption?: string;
  caption?: string;
  aspectRatio?: string;
  carouselGroupId?: string;
  slides: CarouselSlide[];
  [key: string]: unknown;
}

export function previewXhsCarousel(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: { aspectRatio: string; visualStylePreset: string; carouselPack?: CarouselPack },
  signal?: AbortSignal,
): Promise<{ carouselPack?: CarouselPack; user?: SessionUser }> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/xhs-carousel/preview`, {
    method: "POST",
    body,
    signal,
  });
}

export interface XhsCarouselSlideRequest {
  carouselPack: CarouselPack;
  slide: CarouselSlide;
  productImages: ProductImageInput[];
  useBrandLogo: boolean;
  visualStylePreset: string;
  aspectRatio: string;
}

export interface XhsCarouselSlideSubmitResult {
  slideJob?: { slideIndex: number; jobId: string };
  creditEventId?: number | null;
  user?: SessionUser;
  [key: string]: unknown;
}

export function submitXhsCarouselSlide(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  slideIndex: number,
  body: XhsCarouselSlideRequest,
  signal?: AbortSignal,
): Promise<XhsCarouselSlideSubmitResult> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/xhs-carousel/slides/${slideIndex}`, {
    method: "POST",
    body,
    signal,
  });
}

export function completeXhsCarousel(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: { carouselPack: CarouselPack; creditEventId: number | null },
  signal?: AbortSignal,
): Promise<{ generation?: Record<string, unknown>; creditEventId?: number | null; user?: SessionUser }> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/xhs-carousel/complete`, {
    method: "POST",
    body,
    signal,
  });
}

/** enrichXhsCarouselSlides (app.js 4150): default per-slide labels and copy. */
export function enrichXhsCarouselSlides(pack: CarouselPack): CarouselSlide[] {
  const slides = Array.isArray(pack?.slides) ? pack.slides.slice(0, 4) : [];
  return slides.map((slide, index) => ({
    ...slide,
    pageLabel: slide.pageLabel || `第 ${index + 1} 张`,
    visualDirection: slide.visualDirection || slide.title || `第 ${index + 1} 张视觉方向`,
    style: slide.style || "小红书组图封面页，清晰、真实、适合收藏",
    composition:
      slide.composition || `小红书组图${index + 1}/4，比例${pack.aspectRatio || "3:4"}，标题清晰，画面有连续组图统一性。`,
    prompt: slide.prompt || "",
    isGenerating: false,
    error: "",
  }));
}

export function createXhsCarouselGroupId(brandId: number, trendId: number, ideaIndex: number): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `xhs-${brandId}-${trendId}-${ideaIndex}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Signed URLs come from the backend as-is; only obvious protocols pass through. */
export function safeImageSrc(value: unknown): string {
  const src = String(value || "");
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) return src;
  return "";
}

export function hasXhsCarouselSlideImage(slide: CarouselSlide | null | undefined): boolean {
  return Boolean(safeImageSrc(slide?.imageUrl || slide?.previewUrl));
}

// —— Style image (app.js 6362-6400) ——

export interface StyleImageRequest {
  title: string;
  stylePrompt: string;
  useBrandLogo: boolean;
  aspectRatio: string;
  styleReferenceImages: Array<{ name?: string; dataUrl?: string }>;
}

export function submitStyleImage(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: StyleImageRequest,
  signal?: AbortSignal,
): Promise<IdeaImageJobSubmitResult> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/style-image`, { method: "POST", body, signal });
}

/** buildIdeaStylePrompt (app.js 3269): label the idea fields for the prompt. */
export function buildIdeaStylePrompt(idea: IdeaDetail | null | undefined): string {
  const parts: Array<[string, unknown]> = [
    ["选题标题", idea?.title],
    ["内容摘要", idea?.summary],
    ["切入角度", idea?.angle],
    ["品牌结合方式", idea?.brandFit],
    ["面向人群", idea?.audience],
    ["开头钩子", idea?.hook],
  ];
  return parts
    .map(([label, value]) => {
      const text = String(value || "").trim();
      return text ? `${label}：${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** refreshGenerationHistoryAfterGeneration semantics: unfiltered GET /api/history. */
export function refreshGenerationHistory(signal?: AbortSignal): Promise<{ generations: unknown[] }> {
  return apiFetch("/api/history", { signal });
}

// —— Image edit + job polling (round 1, unchanged) ——

export interface ImageJobStatusResult {
  status?: string;
  imageConcept?: Record<string, unknown> | null;
  generationId?: number | null;
  persisted?: boolean;
  error?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

export interface ImageConceptResult extends Record<string, unknown> {
  imageUrl?: string;
  previewUrl?: string;
  generationId?: number | null;
  persisted?: boolean;
  jobId?: string;
}

export interface ImageEditRequest {
  imageUrl: string;
  prompt: string;
  title?: string;
  aspectRatio?: string;
  generationId?: number | null;
  parentEditId?: string | number | null;
  slideIndex?: number | null;
}

export interface ImageEditSubmitResult {
  jobId?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

/** POST /api/image-edits — returns 202 with the queued jobId. */
export function submitImageEdit(body: ImageEditRequest, signal?: AbortSignal): Promise<ImageEditSubmitResult> {
  return apiFetch("/api/image-edits", { method: "POST", body, signal });
}

export function fetchImageJob(jobId: string, signal?: AbortSignal): Promise<ImageJobStatusResult> {
  return apiFetch(`/api/image-jobs/${encodeURIComponent(jobId)}`, { signal });
}

/** 服务端当前用户未完成任务的最小恢复快照（不包含 provider token/URL）。 */
export interface RecoverableImageJob {
  jobId: string;
  status: string;
  type: string;
  error?: string;
  createdAt?: number;
  generationId?: number | null;
  brandId?: number;
  trendId?: number;
  ideaIndex?: number | null;
  slideIndex?: number | null;
  carouselGroupId?: string;
  carouselTitle?: string;
  publishTitle?: string;
  publishCaption?: string;
  caption?: string;
  aspectRatio?: string;
  creditEventId?: number | null;
  singleSlideOnly?: boolean;
  excellentRemix?: boolean;
  contentMode?: string;
  existingIdeaRef?: unknown;
  sourceGenerationId?: number | null;
  parentEditId?: string;
  sourceSlideIndex?: number | null;
  imageUrl?: string;
  slide?: {
    title?: string;
    pageLabel?: string;
    copy?: string;
    prompt?: string;
    visualDirection?: string;
    style?: string;
    composition?: string;
    slideIndex?: number;
    imageUrl?: string;
    previewUrl?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function fetchActiveImageJobs(signal?: AbortSignal): Promise<{ jobs: RecoverableImageJob[] }> {
  return apiFetch("/api/image-jobs/active", { signal });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollImageJobOptions {
  maxWaitMs?: number;
  delayMs?: number;
  signal?: AbortSignal;
  onUser?: (user: SessionUser) => void;
}

/**
 * Poll an image job until completed/failed/timeout. Aborting the signal stops
 * the loop immediately (both the fetch and the wait between attempts).
 */
export async function pollImageJob(jobId: string, options: PollImageJobOptions = {}): Promise<ImageConceptResult> {
  const maxWaitMs = options.maxWaitMs ?? IMAGE_JOB_MAX_WAIT_MS;
  const delayMs = options.delayMs ?? IMAGE_JOB_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    const result = await fetchImageJob(jobId, options.signal);
    if (result.user && options.onUser) options.onUser(result.user);
    if (result.status === "completed") {
      return {
        ...(result.imageConcept || {}),
        generationId: result.generationId ?? null,
        persisted: Boolean(result.persisted),
        jobId,
      };
    }
    if (result.status === "failed") {
      throw new Error(result.error || "图片生成失败");
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error(`图片生成时间超过 ${Math.round(maxWaitMs / 60000)} 分钟，请稍后再试。`);
    }
    await sleep(delayMs, options.signal);
  }
}



// —— AI Video Script Generation ——

export interface VideoScriptClip {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  purpose: string;
  referenceAssets?: Array<{ kind?: string; label?: string; description?: string }>;
  subjectReference: string;
  firstFrame: string;
  lastFrame: string;
  scene: string;
  subjectAction: string;
  cameraMovement: string;
  environmentMotion: string;
  lightingAndStyle: string;
  audioPrompt: string;
  voiceover?: string;
  dialogue?: string;
  onScreenText?: string;
  transition?: string;
  continuity?: string;
  generationDurationSec?: number;
  dependsOnClipIndex?: number | null;
  continuityMode?: string;
  referenceAssetIds?: number[];
  prompt: string;
}

export interface VideoScriptAudioDirection {
  music: string;
  ambience: string;
  voiceStyle: string;
}

export interface VideoScript {
  title: string;
  creativeConcept: string;
  totalDurationSec: number;
  aspectRatio: string;
  globalSubjectReference: string;
  globalStyleReference: string;
  globalContinuity: string;
  audioDirection: VideoScriptAudioDirection;
  clips: VideoScriptClip[];
  model?: "d2" | "g2" | string;
  mode?: "text" | "image" | string;
  resolution?: string;
  visualBible?: VisualBible;
}

export interface VisualBible {
  subject?: string;
  appearance?: string;
  materials?: string;
  colors?: string;
  logoAndText?: string;
  environment?: string;
  lighting?: string;
  camera?: string;
  continuity?: string;
  exclusions?: string;
  [key: string]: unknown;
}

export interface VideoModelCapability {
  id: "d2" | "g2" | string;
  displayName: string;
  provider: string;
  supportedModes: string[];
  resolutions: string[];
  aspectRatios: string[];
  totalDurationOptions: number[];
  clipDurationRules: { min: number; max: number };
  allowedClipDurations?: number[];
  preferredClipDurations: number[];
  maxReferenceImages: number;
  pricing: Record<string, number>;
  pricingUnit: string;
  promotionLabel?: string;
}

export interface VideoProjectClip {
  id: number;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  status: string;
  dependsOnClipIndex?: number | null;
  prompt: string;
  continuityMode: string;
  referenceAssetIds: number[];
  continuityState?: Record<string, unknown>;
  videoUrl?: string;
  posterUrl?: string;
  continuityFrameUrl?: string;
  creditCost: number;
  attempt: number;
  retryCount: number;
  submissionAttempt?: number;
  lastSuccessfulPollAt?: string;
  resultProcessingFailureCount?: number;
  lastResultProcessingError?: string;
  lastResultProcessingAt?: string;
  error?: string;
  [key: string]: unknown;
}

export interface VideoProject {
  id: number;
  generationId: number;
  scriptGenerationId?: number | null;
  brandId: number;
  trendId: number;
  ideaIndex: number;
  model: string;
  mode: string;
  resolution: string;
  aspectRatio: string;
  totalDurationSec: number;
  status: string;
  referenceAssetIds: number[];
  visualBible: VisualBible;
  script: VideoScript;
  estimatedCredits: number;
  chargedCredits: number;
  refundedCredits: number;
  inputAssets?: Array<{
    position: number;
    sourceImageId: number;
    originalName?: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
  finalVideoUrl?: string;
  finalPosterUrl?: string;
  assemblyAttempt?: number;
  clips: VideoProjectClip[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoScriptRequest {
  requestId: string;
  aspectRatioSelection?: string;
  videoDuration?: string;
  useBrandLogo?: boolean;
  useProductImages?: boolean;
  productImages?: ProductImageInput[];
  styleReferenceImages?: Array<{ name?: string; dataUrl?: string }>;
  model?: "d2" | "g2" | string;
  mode?: "text" | "image" | string;
  resolution?: string;
  videoReferenceImageIds?: number[];
  referenceAssetIds?: number[];
  visualBible?: VisualBible;
}

export interface VideoScriptSubmitResult {
  generation?: Record<string, unknown>;
  videoScript?: VideoScript;
  user?: SessionUser;
  [key: string]: unknown;
}

export function submitVideoScript(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: VideoScriptRequest,
  signal?: AbortSignal,
): Promise<VideoScriptSubmitResult> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/video-script`, {
    method: "POST",
    body,
    signal,
  });
}

export interface VideoProjectRequest {
  requestId: string;
  videoScriptGenerationId: number;
  model: "d2" | "g2" | string;
  mode: "text" | "image" | string;
  resolution: string;
  aspectRatio: string;
  totalDurationSec: number;
  referenceAssetIds: number[];
  /** Kept optional for compatibility with old callers; server ignores it. */
  visualBible?: VisualBible;
  /** Kept optional for compatibility with old callers; server ignores it. */
  script?: VideoScript;
}

export function fetchVideoModelCapabilities(signal?: AbortSignal): Promise<{ models: VideoModelCapability[] }> {
  return apiFetch("/api/video-models/capabilities", { signal });
}

export function estimateVideoProject(
  body: Pick<VideoProjectRequest, "model" | "resolution" | "totalDurationSec">,
  signal?: AbortSignal,
): Promise<{ model: string; resolution: string; totalDurationSec: number; clipDurations: number[]; credits: number }> {
  return apiFetch("/api/video-projects/estimate", { method: "POST", body, signal });
}

export function createVideoProject(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  body: VideoProjectRequest,
  signal?: AbortSignal,
): Promise<{ project: VideoProject; user?: SessionUser; generation?: Record<string, unknown> }> {
  return apiFetch(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}/video-project`, {
    method: "POST",
    body,
    signal,
  });
}

export function fetchVideoProject(projectId: number, signal?: AbortSignal): Promise<{ project: VideoProject }> {
  return apiFetch(`/api/video-projects/${projectId}`, { signal });
}

export function fetchActiveVideoProjects(
  filtersOrSignal?: { brandId?: number; trendId?: number; ideaIndex?: number } | AbortSignal,
  signal?: AbortSignal,
): Promise<{ projects: VideoProject[] }> {
  const filters = filtersOrSignal && typeof (filtersOrSignal as AbortSignal).aborted === "boolean"
    ? undefined
    : filtersOrSignal as { brandId?: number; trendId?: number; ideaIndex?: number } | undefined;
  const requestSignal = filtersOrSignal && typeof (filtersOrSignal as AbortSignal).aborted === "boolean"
    ? filtersOrSignal as AbortSignal
    : signal;
  const params = new URLSearchParams();
  if (filters?.brandId != null) params.set("brandId", String(filters.brandId));
  if (filters?.trendId != null) params.set("trendId", String(filters.trendId));
  if (filters?.ideaIndex != null) params.set("ideaIndex", String(filters.ideaIndex));
  return apiFetch(`/api/video-projects/active${params.toString() ? `?${params}` : ""}`, { signal: requestSignal });
}

export function startVideoProject(projectId: number, signal?: AbortSignal): Promise<{ project: VideoProject }> {
  return apiFetch(`/api/video-projects/${projectId}/start`, { method: "POST", body: {}, signal });
}

export function retryVideoProjectClip(
  projectId: number,
  clipIndex: number,
  requestId: string,
  signal?: AbortSignal,
): Promise<{ project: VideoProject; user?: SessionUser }> {
  return apiFetch(`/api/video-projects/${projectId}/clips/${clipIndex}/retry`, {
    method: "POST",
    body: { requestId },
    signal,
  });
}

export function regenerateVideoProjectClip(
  projectId: number,
  clipIndex: number,
  requestId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ project: VideoProject; user?: SessionUser }> {
  return apiFetch(`/api/video-projects/${projectId}/clips/${clipIndex}/retry`, {
    method: "POST",
    body: { requestId, prompt },
    signal,
  });
}

export function retryVideoProjectClipResult(
  projectId: number,
  clipIndex: number,
  requestId: string,
  signal?: AbortSignal,
): Promise<{ project: VideoProject; user?: SessionUser }> {
  return apiFetch(`/api/video-projects/${projectId}/clips/${clipIndex}/retry-result`, {
    method: "POST",
    body: { requestId },
    signal,
  });
}

export function retryVideoProjectAssembly(
  projectId: number,
  requestId: string,
  signal?: AbortSignal,
): Promise<{ project: VideoProject }> {
  return apiFetch(`/api/video-projects/${projectId}/retry-assembly`, {
    method: "POST",
    body: { requestId },
    signal,
  });
}
