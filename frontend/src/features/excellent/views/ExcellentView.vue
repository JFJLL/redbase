<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import {
  completeExcellentRemix,
  fetchBrandRemixIdeas,
  fetchBrands,
  fetchContentDirections,
  fetchContentSources,
  fetchExcellentContentDetail,
  fetchExcellentContents,
  fetchExcellentTaxonomy,
  fetchFusionPlan,
  fetchBrandProductImages,
  fetchRemixAnalysis,
  generateExcellentRemixSlide,
  previewExcellentRemix,
  refreshExcellentContents,
  claimProductImage,
  type ExcellentQueryFilters,
} from "../api";
import {
  applyExcellentListError,
  applyExcellentListResult,
  applyExcellentRefreshError,
  applyExcellentRefreshResult,
  commitExcellentDraftFilters,
  createExcellentBoardSlice,
  excellentFiltersAreDirty,
  excellentRefreshResponseMatches,
  rollbackExcellentDraftFilters,
} from "../listState";
import {
  buildDirectionsBillingAttemptKey,
  buildFusionBillingAttemptKey,
  buildFusionRequestBody,
  buildGenerationPayload,
  canGenerateFusionPlan,
  canSubmitExcellentRemix,
  createExcellentRemixState,
  directionsButtonLabel,
  filterExistingIdeas,
  fusionButtonLabel,
  markFusionStale,
  MAX_CUSTOM_DIRECTION_CHARS,
  MAX_REMIX_PRODUCT_IMAGES,
  MIN_CUSTOM_DIRECTION_CHARS,
  REMIX_CONTENT_MODES,
  REMIX_ASSET_MODES,
  resolveRemixBillingAttempt,
  shouldResetRemixBillingAttempt,
  shouldWarnNextDirectionCharge,
  toggleLearningFocus,
  type ExcellentRemixState,
} from "../remixState";
import { canGoNext, canGoPrevious, getNextImageIndex, getPreviousImageIndex } from "../imageNav";
import { excellentImageSrc, type ExcellentImageProxyParams } from "../imageProxy";
import {
  restoreBoardScrollPosition,
  saveBoardScrollPosition,
} from "../boardScroll";
import {
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  pollImageJob,
  uploadProductImage,
} from "@/features/generation/api";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import type {
  BrandSummary,
  ContentSourceOption,
  ExcellentBoard,
  ExcellentNote,
  ProductImage,
  RemixBillingInfo,
  TaxonomyNode,
} from "../types";

// 优秀内容：双板块列表（缓存读取 + 显式更新）、筛选草稿/正式两态、
// 笔记详情图片导航，以及“一键仿图文”完整流程。语义对齐 public/app.js。
const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const BOARDS: Array<{ value: ExcellentBoard; label: string }> = [
  { value: "xhs_hot", label: "小红书热门" },
  { value: "ecommerce_hot", label: "电商热门" },
];

const activeBoard = ref<ExcellentBoard>("xhs_hot");
const slices = reactive({
  xhs_hot: createExcellentBoardSlice(),
  ecommerce_hot: createExcellentBoardSlice(),
});
const contentSources = ref<ContentSourceOption[]>([]);
const taxonomyOptions = reactive<Record<ExcellentBoard, Array<{ label: string; value: string }>>>({
  xhs_hot: [],
  ecommerce_hot: [],
});
const toastMessage = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// 图片加载失败：明确错误态 + 重试，绝不伪装成破图占位。
const failedImageUrls = reactive(new Set<string>());

function isImageFailed(url: string): boolean {
  return Boolean(url) && failedImageUrls.has(url);
}

function retryImage(url: string) {
  if (!url) return;
  failedImageUrls.delete(url);
}

function onExcellentImageError(url: string) {
  if (!url) return;
  failedImageUrls.add(url);
}

// 普通用户手动更新 60 秒冷却（服务端为准，这里只做倒计时展示与防重复）；管理员不受限。
const refreshCooldownSeconds = ref(0);
let refreshCooldownTimer: ReturnType<typeof setInterval> | null = null;

function startRefreshCooldown(seconds: number) {
  if (auth.isAdmin) return;
  if (refreshCooldownTimer) {
    clearInterval(refreshCooldownTimer);
    refreshCooldownTimer = null;
  }
  refreshCooldownSeconds.value = Math.max(0, Math.round(seconds));
  if (refreshCooldownSeconds.value <= 0) return;
  refreshCooldownTimer = setInterval(() => {
    refreshCooldownSeconds.value -= 1;
    if (refreshCooldownSeconds.value <= 0 && refreshCooldownTimer) {
      clearInterval(refreshCooldownTimer);
      refreshCooldownTimer = null;
    }
  }, 1000);
}

function applyBillingToSession(billing: RemixBillingInfo | null | undefined, user?: Record<string, unknown> | null) {
  // 保留 isAdmin 等会话字段，只合并服务端回传的最新信息（含余额）。
  if (user && auth.user) {
    auth.user = { ...auth.user, ...user };
  } else if (billing && typeof billing.credits === "number" && auth.user) {
    auth.user = { ...auth.user, credits: billing.credits };
  }
}

const slice = computed(() => slices[activeBoard.value]);
const filtersDirty = computed(() => excellentFiltersAreDirty(slices[activeBoard.value], activeBoard.value));

const statusText = computed(() => {
  const current = slices[activeBoard.value];
  if (current.refreshing) return "正在更新内容…";
  if (current.refreshError) return current.refreshError;
  if (filtersDirty.value) return "筛选条件将在点击“更新内容”后生效，当前仍展示上一次保存的数据。";
  if (current.stale && current.items.length) return "当前展示上一次保存的数据，可点击更新内容。";
  if (current.status === "error" && !current.items.length) return current.error;
  return "";
});

function showToast(message: string) {
  toastMessage.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMessage.value = "";
  }, 3200);
}

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

function formalFilters(board: ExcellentBoard): ExcellentQueryFilters {
  const boardSlice = slices[board];
  return {
    board,
    contentSource: boardSlice.contentSource || "all",
    categoryPath: board === "xhs_hot" ? boardSlice.categoryPath : "",
    industryPath: board === "ecommerce_hot" ? boardSlice.industryPath : "",
  };
}

function draftFilters(board: ExcellentBoard): ExcellentQueryFilters {
  const boardSlice = slices[board];
  return {
    board,
    contentSource: boardSlice.draftContentSource || "all",
    categoryPath: board === "xhs_hot" ? boardSlice.draftCategoryPath : "",
    industryPath: board === "ecommerce_hot" ? boardSlice.draftIndustryPath : "",
  };
}

/** Cache-only read with the formal filters (never hits Pgy). */
async function loadBoard(board: ExcellentBoard) {
  const boardSlice = slices[board];
  const requestId = boardSlice.requestId + 1;
  boardSlice.requestId = requestId;
  const hadItems = boardSlice.items.length > 0;
  if (!hadItems) boardSlice.status = "loading";
  try {
    const result = await fetchExcellentContents(formalFilters(board), scope.signalFor(`list-${board}`));
    applyExcellentListResult({ slice: boardSlice, requestId, result, activeBoard: activeBoard.value, requestBoard: board });
    // 首次/切回未加载榜单：列表就绪后恢复该榜单的浏览位置。
    if (board === activeBoard.value && boardSlice.items.length) restoreBoardScroll();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    applyExcellentListError({
      slice: boardSlice,
      requestId,
      error: error as Error,
      preserveItems: true,
      hadItems,
      activeBoard: activeBoard.value,
      requestBoard: board,
    });
  }
}

function formatExcellentUpdatedLabel(updatedAt: string): string {
  if (!updatedAt) return "";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 旧版 formatCompactMetric：阅读/点赞/收藏/评论的紧凑展示。 */
function formatCompactMetric(value: unknown): string {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1)}万`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

function boardLabel(board: ExcellentBoard): string {
  return board === "ecommerce_hot" ? "电商热门" : "小红书热门";
}

/** Explicit refresh with the draft filters snapshot (the only Pgy path). */
async function refreshBoard(board: ExcellentBoard) {
  const boardSlice = slices[board];
  if (boardSlice.refreshing || refreshCooldownSeconds.value > 0) return;
  const requestFilters = draftFilters(board);
  const requestId = boardSlice.requestId + 1;
  boardSlice.requestId = requestId;
  boardSlice.refreshing = true;
  boardSlice.refreshError = "";
  try {
    const result = await refreshExcellentContents(requestFilters, scope.signalFor(`refresh-${board}`));
    if (!excellentRefreshResponseMatches(result, requestFilters)) {
      throw new Error("优秀内容响应与请求条件不一致，请重试。");
    }
    commitExcellentDraftFilters(boardSlice, board, requestFilters);
    applyExcellentRefreshResult({
      slice: boardSlice,
      requestId,
      result,
      activeBoard: activeBoard.value,
      requestBoard: board,
    });
    const label = formatExcellentUpdatedLabel(result?.updatedAt || boardSlice.updatedAt);
    if (label) showToast(`已更新至 ${label}`);
    // 普通用户进入 60 秒冷却；管理员在 startRefreshCooldown 内部豁免。
    startRefreshCooldown(60);
  } catch (error) {
    if (isAbortError(error)) {
      boardSlice.refreshing = false;
      return;
    }
    if (await handleUnauthorizedError(error)) return;
    if (error instanceof ApiError && error.status === 429) {
      const retryAfter = Number((error.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds || 60);
      startRefreshCooldown(retryAfter);
    }
    rollbackExcellentDraftFilters(boardSlice, board);
    applyExcellentRefreshError({
      slice: boardSlice,
      requestId,
      error: error as Error,
      activeBoard: activeBoard.value,
      requestBoard: board,
    });
    showToast((error as Error).message);
  }
}

function switchBoard(board: ExcellentBoard) {
  if (activeBoard.value === board) return;
  saveBoardScrollPosition(activeBoard.value, window.scrollY || 0);
  activeBoard.value = board;
  // 切回已加载榜单时恢复各自浏览位置；未加载榜单在 loadBoard 完成后恢复。
  if (slices[board].items.length) restoreBoardScroll();
  if (slices[board].status === "idle") loadBoard(board);
  if (!taxonomyOptions[board].length) loadTaxonomy(board);
}

let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScrollSave(): void {
  if (scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    saveBoardScrollPosition(activeBoard.value, window.scrollY || 0);
  }, 160);
}

function restoreBoardScroll(): void {
  const position = restoreBoardScrollPosition(activeBoard.value);
  if (position > 0) {
    window.requestAnimationFrame(() => {
      window.scrollTo(0, position);
    });
  }
}

function flattenTaxonomy(nodes: TaxonomyNode[] | undefined, depth = 0, out: Array<{ label: string; value: string }> = []) {
  for (const node of nodes || []) {
    if (!node) continue;
    const label = `${"　".repeat(depth)}${node.label || node.value || ""}`;
    if (node.value) out.push({ label, value: node.value });
    if (node.children?.length) flattenTaxonomy(node.children, depth + 1, out);
  }
  return out;
}

async function loadTaxonomy(board: ExcellentBoard) {
  try {
    const result = await fetchExcellentTaxonomy(board, scope.signalFor(`taxonomy-${board}`));
    taxonomyOptions[board] = flattenTaxonomy(result.tree?.items);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    // 类目树加载失败不阻断列表；下拉保持“全部”。
  }
}

async function loadContentSources() {
  try {
    const result = await fetchContentSources(scope.signalFor("content-sources"));
    contentSources.value = result.contentSources || [];
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
  }
}

// ------- 详情弹窗（图片导航） -------
const detail = reactive({
  open: false,
  loading: false,
  error: "",
  item: null as ExcellentNote | null,
  activeImageIndex: 0,
  requestId: 0,
});

const detailImages = computed(() => (Array.isArray(detail.item?.imageUrls) ? detail.item.imageUrls.filter(Boolean) : []));
const detailSourceLabel = computed(() => {
  const value = String(detail.item?.contentSource || "all");
  const found = contentSources.value.find((source) => String(source.value) === value);
  return found?.label || (value === "all" ? "全部" : value);
});

function noteKey(item: ExcellentNote): string {
  return String(item.noteId || item.id || "");
}

function excellentProxyParams(item: ExcellentNote): ExcellentImageProxyParams {
  return {
    noteId: noteKey(item),
    ...formalFilters(activeBoard.value),
  };
}

function coverSrc(item: ExcellentNote): string {
  const raw = String(item.coverUrl || (item.imageUrls || [])[0] || "");
  return excellentImageSrc(raw, 0, excellentProxyParams(item));
}

function detailSrcAt(index: number): string {
  const raw = detailImages.value[index] || "";
  if (!detail.item) return raw;
  return excellentImageSrc(raw, index, excellentProxyParams(detail.item));
}

async function openDetail(item: ExcellentNote) {
  const board = activeBoard.value;
  const requestId = detail.requestId + 1;
  detail.requestId = requestId;
  detail.open = true;
  detail.loading = true;
  detail.error = "";
  detail.item = { ...item };
  detail.activeImageIndex = 0;
  try {
    const result = await fetchExcellentContentDetail(noteKey(item), formalFilters(board), scope.signalFor("detail"));
    if (requestId !== detail.requestId) return;
    if (result?.item) {
      const listUrls = Array.isArray(detail.item?.imageUrls) ? detail.item.imageUrls.filter(Boolean) : [];
      const resultUrls = Array.isArray(result.item.imageUrls) ? result.item.imageUrls.filter(Boolean) : [];
      // Keep list images when incomplete; never fabricate extra covers.
      const imageUrls = resultUrls.length ? resultUrls : listUrls;
      detail.item = {
        ...detail.item,
        ...result.item,
        metrics: { ...(detail.item?.metrics || {}), ...(result.item.metrics || {}) },
        imageUrls,
      };
      detail.error = "";
    }
  } catch (error) {
    if (isAbortError(error) || requestId !== detail.requestId) return;
    if (await handleUnauthorizedError(error)) return;
    detail.error = "详情暂时无法加载";
  } finally {
    if (requestId === detail.requestId) detail.loading = false;
  }
}

function closeDetail() {
  detail.open = false;
  detail.item = null;
  detail.requestId += 1;
}

function detailPrev() {
  detail.activeImageIndex = getPreviousImageIndex(detail.activeImageIndex, detailImages.value.length);
}

function detailNext() {
  detail.activeImageIndex = getNextImageIndex(detail.activeImageIndex, detailImages.value.length);
}

function onDetailKeydown(event: KeyboardEvent) {
  if (!detail.open) return;
  if (event.key === "ArrowLeft") detailPrev();
  if (event.key === "ArrowRight") detailNext();
}

// ------- 一键仿图文（remix） -------
const remixOpen = ref(false);
const remix = ref<ExcellentRemixState | null>(null);
const brands = ref<BrandSummary[]>([]);
const loadingBrand = ref(false);
// —— 素材使用方式（旧版第 6 区：品牌 Logo + 产品实拍图）——
const remixProductImages = ref<ProductImage[]>([]);
const remixUnassignedImages = ref<ProductImage[]>([]);
const remixProductImagesLoading = ref(false);
const remixUploading = ref(false);
const remixPickerMessage = ref("");
const remixProductPickerOpen = ref(false);
const submitPhase = ref<"idle" | "preview" | "slides" | "completing" | "done" | "error">("idle");
const submitError = ref("");
const submitSlides = ref<Array<{ title: string; status: string; imageUrl: string; error: string }>>([]);
const completeContext = ref<{ brandId: number | string; carouselGroupId: string; slideJobIds: string[] } | null>(null);

const LEARNING_FOCUS_OPTIONS = [
  { value: "structure", label: "结构框架" },
  { value: "hook", label: "开头钩子" },
  { value: "visual", label: "视觉语言" },
  { value: "conversion", label: "转化方式" },
];

const REMIX_MODE_TABS = [
  { value: REMIX_CONTENT_MODES.SMART, label: "智能方向" },
  { value: REMIX_CONTENT_MODES.EXISTING_IDEA, label: "已有选题" },
  { value: REMIX_CONTENT_MODES.CUSTOM, label: "自定义" },
];

const filteredIdeas = computed(() =>
  remix.value ? filterExistingIdeas(remix.value.existingIdeas, remix.value.existingIdeaQuery) : [],
);
const remixCanGenerateFusion = computed(() => canGenerateFusionPlan(remix.value, !loadingBrand.value));
const remixCanSubmit = computed(() => canSubmitExcellentRemix(remix.value, !loadingBrand.value));
const isPersonalSubject = computed(() => remixBrand.value?.profileType === "personal");
const remixReferenceCover = computed(() => {
  const item = remixReferenceItem.value;
  if (!item) return "";
  const raw = String(item.coverUrl || (item.imageUrls || [])[0] || "");
  if (!raw) return "";
  return excellentImageSrc(raw, 0, excellentProxyParams(item));
});

// AI 学习结果：只展示面向用户的摘要短句，不展示 JSON/prompt/技术字段。
const remixLearningSummary = computed(() => {
  const summary = remix.value?.analysis?.learningSummary;
  return (Array.isArray(summary) ? summary : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, 8);
});
const learningStatusLabel = computed(() =>
  remix.value?.analysis?.analysisMode === "multimodal" ? "AI已读取参考图片" : "基于标题和结构分析",
);

async function openRemix(item: ExcellentNote) {
  const board = activeBoard.value;
  const boardSlice = slices[board];
  if (detail.open) closeDetail();
  remix.value = createExcellentRemixState({
    noteId: noteKey(item),
    board,
    contentSource: boardSlice.contentSource || "all",
    categoryPath: boardSlice.categoryPath || "",
    industryPath: boardSlice.industryPath || "",
    brandId: null,
  });
  remixOpen.value = true;
  submitPhase.value = "idle";
  submitError.value = "";
  submitSlides.value = [];
  completeContext.value = null;
  remixProductPickerOpen.value = false;
  remixProductImages.value = [];
  remixUnassignedImages.value = [];
  remixPickerMessage.value = "";
  // 参考学习分析改为惰性触发：首次点“生成内容方向”（或直接生成融合方案）时
  // 才调分析，命中 30 天缓存则直接读取，降低无意义模型消耗。品牌照常预加载。
  loadRemixBrands();
}

function closeRemix() {
  remixOpen.value = false;
  remix.value = null;
  remixProductPickerOpen.value = false;
  remixProductImages.value = [];
  remixUnassignedImages.value = [];
  remixPickerMessage.value = "";
}

/** 参考笔记卡数据：从当前榜单列表取（旧版 renderReferenceCardHtml 语义）。 */
const remixReferenceItem = computed<ExcellentNote | null>(() => {
  const state = remix.value;
  if (!state) return null;
  const boardItems = slices[state.board].items;
  return boardItems.find((item) => noteKey(item) === String(state.noteId)) || null;
});

const remixBrand = computed<BrandSummary | null>(() => {
  const state = remix.value;
  if (!state || state.brandId == null) return null;
  return brands.value.find((entry) => Number(entry.id) === Number(state.brandId)) || null;
});

const remixBrandProduct = computed(() => {
  const brand = remixBrand.value;
  if (!brand) return "";
  const raw = String(brand.product || brand.description || "");
  return raw.split(/[。；\n]/)[0].slice(0, 80);
});

const remixLogoUrl = computed(() => {
  const logo = remixBrand.value?.logo as { url?: string } | undefined;
  return String(logo?.url || "");
});

async function openRemixProductPicker() {
  const state = remix.value;
  if (!state?.brandId) return;
  remixProductPickerOpen.value = true;
  remixProductImagesLoading.value = true;
  try {
    const result = await fetchBrandProductImages(state.brandId, scope.signalFor("remix-product-images"));
    if (!remix.value || remix.value.brandId !== state.brandId) return;
    remixProductImages.value = result.images || [];
    remixUnassignedImages.value = result.unassignedImages || [];
    remixPickerMessage.value = "";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    remixProductImages.value = [];
    remixUnassignedImages.value = [];
    showToast(`产品素材加载失败：${(error as Error).message}`);
  } finally {
    remixProductImagesLoading.value = false;
  }
}

function closeRemixProductPicker() {
  remixProductPickerOpen.value = false;
}

function remixBrandRequestIsCurrent(state: ExcellentRemixState, brandId: number): boolean {
  return remix.value === state && Number(state.brandId) === Number(brandId);
}

async function reloadRemixProductPicker(brandId: number, expectedState = remix.value) {
  if (!expectedState || !remixBrandRequestIsCurrent(expectedState, brandId)) return false;
  remixProductImagesLoading.value = true;
  try {
    const result = await fetchBrandProductImages(brandId, scope.signalFor(`remix-product-images-${Date.now()}`));
    if (!remixBrandRequestIsCurrent(expectedState, brandId)) return false;
    remixProductImages.value = result.images || [];
    remixUnassignedImages.value = result.unassignedImages || [];
    remixPickerMessage.value = "";
    return true;
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    if (!remixBrandRequestIsCurrent(expectedState, brandId)) return false;
    remixPickerMessage.value = `素材刷新失败：${(error as Error).message}`;
    return false;
  } finally {
    if (remixBrandRequestIsCurrent(expectedState, brandId)) {
      remixProductImagesLoading.value = false;
    }
  }
}

async function claimRemixUnassigned(image: ProductImage) {
  const state = remix.value;
  if (!state?.brandId) return;
  const requestedBrandId = Number(state.brandId);
  try {
    const result = await claimProductImage(image.id, requestedBrandId, scope.signalFor(`claim-${image.id}`));
    if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
    if (result.image && !state.productImageIds.some((id) => Number(id) === Number(result.image.id))) {
      if (state.productImageIds.length < MAX_REMIX_PRODUCT_IMAGES) {
        state.productImageIds = [...state.productImageIds, Number(result.image.id)];
        refreshRemixAssetMode();
        markFusionStale(state);
      }
    }
    await reloadRemixProductPicker(requestedBrandId, state);
    if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
    remixPickerMessage.value = `「${result.image.name || result.image.fileName || "图片"}」已认领到当前品牌。`;
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
    remixPickerMessage.value = `认领失败：${(error as Error).message}`;
  }
}

async function handleRemixProductUpload(event: Event) {
  const state = remix.value;
  if (!state?.brandId) return;
  const requestedBrandId = Number(state.brandId);
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || remixUploading.value) return;
  const oversized = files.find((file) => file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES);
  if (oversized) {
    remixPickerMessage.value = `单张产品图最多上传 ${Math.round(MAX_SINGLE_UPLOAD_IMAGE_BYTES / 1024 / 1024)}MB。`;
    return;
  }
  remixUploading.value = true;
  remixPickerMessage.value = "";
  try {
    for (const file of files) {
      const signal = scope.signalFor(`remix-upload-${file.name}`);
      const dataUrl = await fileToDataUrl(file, signal);
      if (signal.aborted || !remixBrandRequestIsCurrent(state, requestedBrandId)) return;
      const result = await uploadProductImage({ name: file.name, dataUrl, brandId: requestedBrandId }, signal);
      if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
      if (result.image && !state.productImageIds.some((id) => Number(id) === Number(result.image.id))) {
        if (state.productImageIds.length < MAX_REMIX_PRODUCT_IMAGES) {
          state.productImageIds = [...state.productImageIds, Number(result.image.id)];
          refreshRemixAssetMode();
          markFusionStale(state);
        }
      }
    }
    await reloadRemixProductPicker(requestedBrandId, state);
    if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
    remixPickerMessage.value = "上传完成，已加入当前品牌素材库。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    if (!remixBrandRequestIsCurrent(state, requestedBrandId)) return;
    remixPickerMessage.value = `上传失败：${(error as Error).message}`;
  } finally {
    if (remixBrandRequestIsCurrent(state, requestedBrandId)) {
      remixUploading.value = false;
    }
  }
}

function refreshRemixAssetMode() {
  const state = remix.value;
  if (!state) return;
  const logoOn = Boolean(state.useBrandLogo);
  const productOn = state.productImageIds.length > 0;
  state.assetMode =
    logoOn && productOn
      ? REMIX_ASSET_MODES.LOGO_AND_PRODUCT
      : logoOn
        ? REMIX_ASSET_MODES.LOGO
        : productOn
          ? REMIX_ASSET_MODES.PRODUCT
          : REMIX_ASSET_MODES.NONE;
}

function toggleRemixLogo(checked: boolean) {
  const state = remix.value;
  if (!state) return;
  state.useBrandLogo = checked;
  refreshRemixAssetMode();
  markFusionStale(state);
}

function toggleRemixProduct(imageId: number, checked: boolean) {
  const state = remix.value;
  if (!state) return;
  if (!checked) {
    state.productImageIds = state.productImageIds.filter((id) => Number(id) !== Number(imageId));
    refreshRemixAssetMode();
    markFusionStale(state);
    return;
  }
  if (state.productImageIds.some((id) => Number(id) === Number(imageId))) return;
  if (state.productImageIds.length >= MAX_REMIX_PRODUCT_IMAGES) {
    showToast(`产品图最多叠加 ${MAX_REMIX_PRODUCT_IMAGES} 张。`);
    return;
  }
  state.productImageIds = [...state.productImageIds, imageId];
  refreshRemixAssetMode();
  markFusionStale(state);
}

async function loadRemixAnalysis() {
  const state = remix.value;
  if (!state) return;
  state.analysisStatus = "loading";
  state.analysisError = "";
  try {
    const result = await fetchRemixAnalysis(
      state.noteId,
      {
        board: state.board,
        contentSource: state.contentSource,
        categoryPath: state.categoryPath,
        industryPath: state.industryPath,
      },
      scope.signalFor("remix-analysis"),
    );
    if (remix.value !== state) return;
    state.analysis = result.analysis || null;
    state.analysisId = String(result.analysis?.analysisId || "");
    state.analysisStatus = "ready";
  } catch (error) {
    if (isAbortError(error) || remix.value !== state) return;
    if (await handleUnauthorizedError(error)) return;
    // 分析失败降级：仍允许继续走内容方向与融合。
    state.analysisStatus = "degraded";
    state.analysisError = (error as Error).message;
  }
}

// 首次需要时才触发参考学习分析；并发入口（内容方向/融合）共享同一请求。
let remixAnalysisPromise: Promise<void> | null = null;
async function ensureRemixAnalysis() {
  const state = remix.value;
  if (!state) return;
  if (state.analysisStatus === "ready" || state.analysisStatus === "degraded") return;
  if (!remixAnalysisPromise) {
    remixAnalysisPromise = loadRemixAnalysis().finally(() => {
      remixAnalysisPromise = null;
    });
  }
  await remixAnalysisPromise;
}

async function loadRemixBrands() {
  loadingBrand.value = true;
  try {
    const result = await fetchBrands(scope.signalFor("remix-brands"));
    brands.value = result.brands || [];
    if (remix.value && !remix.value.brandId && brands.value.length) {
      remix.value.brandId = brands.value[0].id;
      loadRemixIdeas();
    }
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    showToast(`品牌详情加载失败：${(error as Error).message}`);
  } finally {
    loadingBrand.value = false;
  }
}

async function loadRemixIdeas() {
  const state = remix.value;
  if (!state?.brandId) return;
  const brandId = state.brandId;
  try {
    const result = await fetchBrandRemixIdeas(brandId, scope.signalFor("remix-ideas"));
    if (remix.value !== state || state.brandId !== brandId) return;
    state.existingIdeas = result.ideas || [];
  } catch (error) {
    if (isAbortError(error) || remix.value !== state) return;
    if (await handleUnauthorizedError(error)) return;
    showToast(`品牌详情加载失败：${(error as Error).message}`);
  }
}

function onRemixBrandChange() {
  const state = remix.value;
  if (!state) return;
  // 切换品牌：清空内容方向与素材选择，并使融合方案失效。
  state.smartDirections = [];
  state.selectedSmartDirectionId = "";
  state.existingIdeas = [];
  state.selectedExistingIdea = null;
  state.directionsStatus = "idle";
  state.directionsError = "";
  state.directionsResultInputKey = "";
  if (state.fusionStatus === "loading") state.fusionStatus = "idle";
  state.productImageIds = [];
  markFusionStale(state);
  remixProductPickerOpen.value = false;
  remixUploading.value = false;
  remixProductImagesLoading.value = false;
  remixProductImages.value = [];
  remixUnassignedImages.value = [];
  remixPickerMessage.value = "";
  loadRemixIdeas();
}

function onToggleFocus(value: string, checked: boolean) {
  const state = remix.value;
  if (!state) return;
  state.learningFocus = toggleLearningFocus(state.learningFocus, value, checked);
  state.directionsResultInputKey = "";
  if (state.directionsStatus === "loading") state.directionsStatus = "idle";
  if (state.fusionStatus === "loading") state.fusionStatus = "idle";
  markFusionStale(state);
}

function onContentInputChanged() {
  const state = remix.value;
  if (!state) return;
  if (state.fusionStatus === "loading") state.fusionStatus = "idle";
  markFusionStale(state);
}

function directionsAttemptIsCurrent(state: ExcellentRemixState, requestId: string, inputKey: string): boolean {
  const current = state.directionsBillingAttempt;
  return (
    current?.requestId === requestId &&
    current.inputKey === inputKey &&
    buildDirectionsBillingAttemptKey(state) === inputKey
  );
}

function fusionAttemptIsCurrent(state: ExcellentRemixState, requestId: string, inputKey: string): boolean {
  const current = state.fusionBillingAttempt;
  return (
    current?.requestId === requestId && current.inputKey === inputKey && buildFusionBillingAttemptKey(state) === inputKey
  );
}

function shouldResetBillingAttempt(error: unknown): boolean {
  return error instanceof ApiError && shouldResetRemixBillingAttempt(error.body?.code);
}

async function generateDirections() {
  const state = remix.value;
  if (!state?.brandId) return;
  // 已有成功方向时启动的新逻辑尝试属于“重新生成”；技术重试必须保留这个值。
  state.directionsStatus = "loading";
  state.directionsError = "";
  // 首次点击先触发参考学习分析（命中 30 天缓存则直接读取）。
  await ensureRemixAnalysis();
  if (remix.value !== state) return;
  const inputKey = buildDirectionsBillingAttemptKey(state);
  const attempt = resolveRemixBillingAttempt(
    state.directionsBillingAttempt,
    inputKey,
    state.directionsResultInputKey === inputKey,
  );
  state.directionsBillingAttempt = attempt;
  try {
    const result = await fetchContentDirections(
      state.noteId,
      {
        board: state.board,
        brandId: Number(state.brandId),
        sourceAnalysisId: state.analysisId || "",
        learningFocus: state.learningFocus,
        contentSource: state.contentSource,
        categoryPath: state.categoryPath,
        industryPath: state.industryPath,
        requestId: attempt.requestId,
        forceRegenerate: attempt.forceRegenerate,
      },
      scope.signalFor("remix-directions"),
    );
    if (remix.value !== state || !directionsAttemptIsCurrent(state, attempt.requestId, attempt.inputKey)) return;
    state.smartDirections = (result.directions as ExcellentRemixState["smartDirections"]) || [];
    state.selectedSmartDirectionId = state.smartDirections[0]?.id || "";
    state.directionsStatus = "ready";
    state.directionsBilling = (result.billing as RemixBillingInfo) || null;
    state.directionsBillingAttempt = null;
    state.directionsResultInputKey = attempt.inputKey;
    applyBillingToSession(state.directionsBilling, result.user as Record<string, unknown> | undefined);
    if (shouldWarnNextDirectionCharge(state.directionsBilling)) {
      showToast("短时间内继续生成将消耗 1 积分。");
    }
    if (result.analysisId) state.analysisId = String(result.analysisId);
    markFusionStale(state);
  } catch (error) {
    if (isAbortError(error) || remix.value !== state) return;
    if (!directionsAttemptIsCurrent(state, attempt.requestId, attempt.inputKey)) return;
    if (await handleUnauthorizedError(error)) return;
    if (shouldResetBillingAttempt(error)) state.directionsBillingAttempt = null;
    state.directionsStatus = "error";
    state.directionsError = (error as Error).message;
  }
}

async function generateFusion() {
  const state = remix.value;
  if (!state || !remixCanGenerateFusion.value) return;
  // 已有成功方案时启动的新逻辑尝试属于“重新生成”；技术重试必须保留这个值。
  state.fusionStatus = "loading";
  state.fusionError = "";
  // 自定义/已有选题模式可能未点过“生成内容方向”，融合前自动补参考学习分析。
  await ensureRemixAnalysis();
  if (remix.value !== state) return;
  const inputKey = buildFusionBillingAttemptKey(state);
  const attempt = resolveRemixBillingAttempt(
    state.fusionBillingAttempt,
    inputKey,
    state.fusionResultInputKey === inputKey,
  );
  state.fusionBillingAttempt = attempt;
  try {
    const result = await fetchFusionPlan(
      state.noteId,
      { ...buildFusionRequestBody(state), requestId: attempt.requestId, forceRegenerate: attempt.forceRegenerate },
      scope.signalFor("remix-fusion"),
    );
    if (remix.value !== state || !fusionAttemptIsCurrent(state, attempt.requestId, attempt.inputKey)) return;
    state.fusionPlan = result.fusionPlan || null;
    state.fusionStatus = "ready";
    state.fusionBilling = (result.billing as RemixBillingInfo) || null;
    state.fusionBillingAttempt = null;
    state.fusionResultInputKey = attempt.inputKey;
    applyBillingToSession(state.fusionBilling, result.user as Record<string, unknown> | undefined);
  } catch (error) {
    if (isAbortError(error) || remix.value !== state) return;
    if (!fusionAttemptIsCurrent(state, attempt.requestId, attempt.inputKey)) return;
    if (await handleUnauthorizedError(error)) return;
    if (shouldResetBillingAttempt(error)) state.fusionBillingAttempt = null;
    state.fusionStatus = "error";
    state.fusionError = (error as Error).message;
  }
}

async function runComplete(brandId: number | string, carouselGroupId: string, slideJobIds: string[]) {
  submitPhase.value = "completing";
  submitError.value = "";
  try {
    const result = await completeExcellentRemix(
      brandId,
      { carouselGroupId, slideJobIds, expectedSlideCount: 4 },
      scope.signalFor("remix-complete"),
    );
    if (result.user) auth.user = result.user;
    submitPhase.value = "done";
    showToast("已保存至历史生成");
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    // 保留上下文，允许“重新写入历史”重试（不会重复扣分）。
    completeContext.value = { brandId, carouselGroupId, slideJobIds };
    submitPhase.value = "error";
    submitError.value = (error as Error).message;
  }
}

async function retryComplete() {
  const context = completeContext.value;
  if (!context) return;
  await runComplete(context.brandId, context.carouselGroupId, context.slideJobIds);
}

async function submitRemix() {
  const state = remix.value;
  if (!state || !remixCanSubmit.value || !state.fusionPlan) {
    showToast("请先生成有效的融合方案（4 页）。");
    return;
  }
  const brandId = state.brandId as number | string;
  const brand = brands.value.find((entry) => Number(entry.id) === Number(brandId));
  const fusionPlan = state.fusionPlan;
  const genPayload = buildGenerationPayload(state, fusionPlan);
  const productImages = genPayload.productImageIds.map((id) => ({ id }));
  const signal = scope.signalFor("remix-generate");
  submitPhase.value = "preview";
  submitError.value = "";
  submitSlides.value = [];
  completeContext.value = null;
  const aspectRatio = "3:4";
  try {
    const previewResult = await previewExcellentRemix(
      brandId,
      {
        aspectRatio,
        carouselPack: fusionPlan.carouselPack,
        contentMode: genPayload.contentMode,
        existingIdeaRef: genPayload.existingIdeaRef,
      },
      signal,
    );
    if (previewResult.user) auth.user = previewResult.user;
    const previewPack = previewResult.carouselPack;
    if (!previewPack || !Array.isArray(previewPack.slides)) {
      throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
    }
    const carouselGroupId = String(previewResult.carouselGroupId || previewPack.carouselGroupId || "");
    if (!carouselGroupId) {
      throw new Error("预览未返回组图分组标识，请重试。");
    }
    const pack = { ...previewPack, aspectRatio, carouselGroupId };
    submitPhase.value = "slides";
    submitSlides.value = (pack.slides || []).map((slide) => ({
      title: String(slide.title || ""),
      status: "queued",
      imageUrl: "",
      error: "",
    }));
    const slideJobIds: string[] = [];
    // 旧版 excellent-remix-request.js 并发队列语义：提交按页序保序，
    // 但轮询并发进行——不等上一页出图才开始下一页（4 页不得完全串行）。
    const slidePolls: Array<Promise<void>> = [];
    for (let slideIndex = 0; slideIndex < (pack.slides || []).length; slideIndex += 1) {
      const slide = (pack.slides || [])[slideIndex];
      const row = submitSlides.value[slideIndex];
      row.status = "generating";
      const result = await generateExcellentRemixSlide(
        brandId,
        slideIndex,
        {
          carouselPack: pack,
          carouselGroupId,
          slide,
          productImages,
          useBrandLogo: Boolean(genPayload.useBrandLogo && brand?.logo),
          aspectRatio,
          contentMode: genPayload.contentMode,
          existingIdeaRef: genPayload.existingIdeaRef,
          ideaTitle: genPayload.ideaTitle,
          trendTitle: genPayload.trendTitle,
        },
        signal,
      );
      if (result.user) auth.user = result.user;
      if (!result.slideJob?.jobId) throw new Error("小红书组图任务创建失败");
      slideJobIds.push(result.slideJob.jobId);
      slidePolls.push(
        pollImageJob(result.slideJob.jobId, {
          signal,
          onUser: (user) => {
            auth.user = user;
          },
        }).then((imageConcept) => {
          row.status = "completed";
          row.imageUrl = String(imageConcept.imageUrl || imageConcept.previewUrl || "");
        }),
      );
    }
    await Promise.all(slidePolls);
    await runComplete(brandId, carouselGroupId, slideJobIds);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    submitPhase.value = "error";
    submitError.value = (error as Error).message;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onDetailKeydown);
  window.addEventListener("scroll", scheduleScrollSave, { passive: true });
  loadContentSources();
  loadTaxonomy(activeBoard.value);
  loadBoard(activeBoard.value);
  restoreBoardScroll();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onDetailKeydown);
  window.removeEventListener("scroll", scheduleScrollSave);
  if (scrollSaveTimer) {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
  }
  saveBoardScrollPosition(activeBoard.value, window.scrollY || 0);
  if (toastTimer) clearTimeout(toastTimer);
  if (refreshCooldownTimer) clearInterval(refreshCooldownTimer);
});
</script>

<template>
  <section class="excellent-view">
    <header class="panel-header excellent-panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon excellent-panel-icon">优</span>
          <h1 class="panel-title">优秀内容</h1>
        </div>
        <p class="panel-subtitle">近7日高阅读图文榜单，支持小红书热门与电商热门，可一键仿图文。</p>
      </div>
    </header>

    <div class="board-tabs" role="tablist">
      <button
        v-for="board in BOARDS"
        :key="board.value"
        type="button"
        role="tab"
        class="board-tab"
        :class="{ 'is-active': activeBoard === board.value }"
        :aria-selected="activeBoard === board.value"
        @click="switchBoard(board.value)"
      >
        {{ board.label }}
      </button>
    </div>

    <div class="excellent-filters">
      <label>
        <span>内容来源</span>
        <select v-model="slice.draftContentSource" data-test="filter-source">
          <option value="all">全部来源</option>
          <option v-for="source in contentSources" :key="String(source.value)" :value="source.value">
            {{ source.label || source.value }}
          </option>
        </select>
      </label>
      <label v-if="activeBoard === 'xhs_hot'">
        <span>内容类目</span>
        <select v-model="slice.draftCategoryPath" data-test="filter-category">
          <option value="">全部类目</option>
          <option v-for="option in taxonomyOptions.xhs_hot" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label v-else>
        <span>所属行业</span>
        <select v-model="slice.draftIndustryPath" data-test="filter-industry">
          <option value="">全部行业</option>
          <option v-for="option in taxonomyOptions.ecommerce_hot" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="primary-btn"
        data-test="refresh-button"
        :disabled="slice.refreshing || refreshCooldownSeconds > 0"
        @click="refreshBoard(activeBoard)"
      >
        {{
          slice.refreshing
            ? "正在更新…"
            : refreshCooldownSeconds > 0
              ? `更新中（${refreshCooldownSeconds}s）`
              : "更新内容"
        }}
      </button>
    </div>

    <p v-if="statusText" class="excellent-status" data-test="excellent-status">{{ statusText }}</p>

    <div v-if="slice.status === 'loading'" class="excellent-grid">
      <div v-for="index in 8" :key="index" class="excellent-skeleton" data-test="excellent-skeleton"></div>
    </div>

    <div v-else-if="!slice.items.length" class="excellent-empty" data-test="excellent-empty">
      <strong>{{ slice.status === "error" ? "暂时无法加载优秀内容" : "该筛选条件暂无已保存内容" }}</strong>
      <p>
        {{
          slice.status === "error"
            ? slice.error || "优秀内容加载失败"
            : "该筛选条件暂无已保存内容，请点击“更新内容”获取最新数据。"
        }}
      </p>
      <button
        type="button"
        class="primary-btn"
        :disabled="slice.refreshing || refreshCooldownSeconds > 0"
        @click="refreshBoard(activeBoard)"
      >
        {{
          slice.refreshing
            ? "正在更新…"
            : refreshCooldownSeconds > 0
              ? `更新中（${refreshCooldownSeconds}s）`
              : "更新内容"
        }}
      </button>
    </div>

    <div v-else class="excellent-grid">
      <article v-for="item in slice.items" :key="noteKey(item)" class="excellent-card" data-test="excellent-card">
        <button type="button" class="excellent-cover" @click="openDetail(item)">
          <div
            v-if="isImageFailed(coverSrc(item))"
            class="excellent-image-error"
            data-test="excellent-image-error"
          >
            <span>图片加载失败</span>
            <button
              type="button"
              class="secondary-btn"
              data-test="excellent-image-retry"
              @click.stop="retryImage(coverSrc(item))"
            >
              重试
            </button>
          </div>
          <img
            v-else-if="coverSrc(item)"
            :src="coverSrc(item)"
            :alt="item.title || ''"
            loading="lazy"
            decoding="async"
            @error="onExcellentImageError(coverSrc(item))"
          />
        </button>
        <div class="excellent-card-body">
          <h3>{{ item.title }}</h3>
          <p class="excellent-card-meta">
            <span v-if="item.authorName">{{ item.authorName }}</span>
            <span v-if="item.metrics?.readCount != null">阅读 {{ item.metrics?.readCount }}</span>
            <span v-if="item.metrics?.engagementCount != null">互动 {{ item.metrics?.engagementCount }}</span>
          </p>
          <div class="excellent-card-actions">
            <button type="button" class="secondary-btn" @click="openDetail(item)">查看详情</button>
            <button type="button" class="primary-btn" data-test="remix-button" @click="openRemix(item)">一键仿图文</button>
          </div>
        </div>
      </article>
    </div>

    <p v-if="toastMessage" class="excellent-toast" data-test="toast">{{ toastMessage }}</p>

    <!-- 笔记详情弹窗 -->
    <div v-if="detail.open" class="excellent-modal" @click.self="closeDetail()">
      <div class="excellent-modal-body excellent-detail-modal-panel" data-test="detail-modal-panel">
        <button
          type="button"
          class="secondary-btn excellent-floating-close"
          data-test="detail-close"
          @click="closeDetail()"
        >
          关闭
        </button>
        <div class="excellent-detail-layout">
          <section class="excellent-detail-gallery excellent-detail-carousel">
            <div class="excellent-carousel-stage">
              <button
                type="button"
                class="excellent-carousel-nav"
                :disabled="!canGoPrevious(detail.activeImageIndex, detailImages.length)"
                aria-label="上一张"
                @click="detailPrev()"
              >
                ‹
              </button>
              <div class="excellent-carousel-main">
                <div v-if="!detailImages.length" class="excellent-cover-fallback">暂无图片</div>
                <div
                  v-else-if="isImageFailed(detailSrcAt(detail.activeImageIndex))"
                  class="excellent-image-error detail-image-error"
                  data-test="detail-image-error"
                >
                  <span>图片加载失败</span>
                  <button
                    type="button"
                    class="secondary-btn"
                    @click="retryImage(detailSrcAt(detail.activeImageIndex))"
                  >
                    重试
                  </button>
                </div>
                <img
                  v-else
                  :src="detailSrcAt(detail.activeImageIndex)"
                  :alt="`${detail.item?.title || '笔记'} 第 ${detail.activeImageIndex + 1} 张`"
                  @error="onExcellentImageError(detailSrcAt(detail.activeImageIndex))"
                />
              </div>
              <button
                type="button"
                class="excellent-carousel-nav"
                :disabled="!canGoNext(detail.activeImageIndex, detailImages.length)"
                aria-label="下一张"
                @click="detailNext()"
              >
                ›
              </button>
            </div>
            <div class="excellent-detail-gallery-meta">
              {{ detailImages.length ? `${detail.activeImageIndex + 1} / ${detailImages.length}` : "暂无图片" }}
            </div>
            <div v-if="detailImages.length > 1" class="excellent-carousel-thumbs">
              <button
                v-for="(imageUrl, index) in detailImages"
                :key="imageUrl || index"
                type="button"
                class="excellent-carousel-thumb"
                :class="{ 'is-active': index === detail.activeImageIndex }"
                @click="detail.activeImageIndex = index"
              >
                <span v-if="isImageFailed(detailSrcAt(index))" class="detail-thumb-error">✕</span>
                <img
                  v-else
                  :src="detailSrcAt(index)"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  @error="onExcellentImageError(detailSrcAt(index))"
                />
              </button>
            </div>
            <p v-if="detail.loading" class="excellent-detail-loading">正在加载详情…</p>
            <p v-if="detail.error" class="excellent-detail-error" data-test="detail-error">{{ detail.error }}</p>
          </section>
          <aside class="excellent-detail-copy">
            <h2>{{ detail.item?.title || "未命名笔记" }}</h2>
            <div class="excellent-detail-meta">
              <div>作者：{{ detail.item?.authorName || "未知作者" }}</div>
              <div>发布时间：{{ detail.item?.publishTime || "-" }}</div>
              <div>
                {{ activeBoard === "ecommerce_hot" ? "所属行业" : "内容类目" }}：{{
                  detail.item?.industryPath ||
                  detail.item?.categoryPath ||
                  (activeBoard === "ecommerce_hot" ? "全部所属行业" : "全部内容类目")
                }}
              </div>
              <div>内容来源：{{ detailSourceLabel }}</div>
            </div>
            <div class="excellent-detail-metrics">
              <div><strong>{{ formatCompactMetric(detail.item?.metrics?.readCount) }}</strong><span>阅读</span></div>
              <div><strong>{{ formatCompactMetric(detail.item?.metrics?.likeCount) }}</strong><span>点赞</span></div>
              <div><strong>{{ formatCompactMetric(detail.item?.metrics?.favoriteCount) }}</strong><span>收藏</span></div>
              <div><strong>{{ formatCompactMetric(detail.item?.metrics?.commentCount) }}</strong><span>评论</span></div>
            </div>
            <div v-if="String(detail.item?.content || '').trim()" class="excellent-detail-body">
              {{ detail.item?.content }}
            </div>
            <div class="excellent-detail-actions">
              <a
                v-if="detail.item?.noteUrl"
                :href="String(detail.item.noteUrl)"
                target="_blank"
                rel="noopener noreferrer"
              >
                查看原笔记
              </a>
              <button
                type="button"
                class="primary-btn excellent-detail-remix"
                @click="detail.item && openRemix(detail.item)"
              >
                一键仿图文
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>

    <!-- 一键仿图文弹窗（旧版分区式工作流：1 参考笔记 → 6 素材 → 提交） -->
    <div v-if="remixOpen && remix" class="excellent-modal" @click.self="closeRemix()">
      <div class="excellent-modal-body excellent-remix-modal-panel">
        <header class="excellent-modal-header">
          <div>
            <h3>参考优秀内容生成品牌原创图文</h3>
            <p class="remix-subtitle">学习参考内容的表达方法，不复制原图、原排版与原品牌。</p>
            <p class="remix-credits" data-test="remix-credits">当前积分：{{ auth.user?.credits ?? "—" }}</p>
          </div>
          <button type="button" class="secondary-btn" @click="closeRemix()">关闭</button>
        </header>

        <div class="excellent-remix-form">
          <!-- 1. 参考笔记 -->
          <section class="excellent-remix-section" data-test="remix-reference">
            <h3>1. 参考笔记</h3>
            <div class="excellent-remix-template">
              <img
                v-if="remixReferenceCover"
                :src="remixReferenceCover"
                alt=""
                loading="lazy"
                decoding="async"
              />
              <div v-else class="excellent-cover-fallback">暂无封面</div>
              <div>
                <span>{{ boardLabel(remix.board) }}</span>
                <strong>{{ remixReferenceItem?.title || "优秀内容" }}</strong>
                <p>
                  {{ remixReferenceItem?.authorName || "未知作者" }} · 阅读
                  {{ formatCompactMetric(remixReferenceItem?.metrics?.readCount) }} ·
                  {{ Number(remixReferenceItem?.imageCount || remixReferenceItem?.imageUrls?.length || 0) }} 图
                </p>
              </div>
            </div>
            <p v-if="remix.analysisStatus === 'idle'" class="excellent-remix-status" data-test="analysis-idle">
              点击“生成内容方向”后，AI 将学习参考内容的表达方法。
            </p>
            <p v-else-if="remix.analysisStatus === 'loading'" class="excellent-remix-status is-loading">
              正在学习参考内容…
            </p>
            <p v-else-if="remix.analysisStatus === 'degraded'" class="excellent-remix-status is-degraded" data-test="analysis-error">
              {{ remix.analysisError }}
            </p>
            <p v-else-if="remix.analysis" class="excellent-remix-status is-ready" data-test="analysis-ready">
              {{ remix.analysis.referenceTopic || "参考方法已就绪" }}
            </p>
            <details v-if="remix.analysis" class="remix-learning" data-test="learning-summary">
              <summary>AI已学习（展开查看）</summary>
              <p class="remix-learning-status" data-test="learning-status">{{ learningStatusLabel }}</p>
              <p v-if="remix.analysis?.warning" class="excellent-error" data-test="learning-warning">
                {{ remix.analysis?.warning }}
              </p>
              <ul class="remix-learning-list">
                <li v-for="(point, index) in remixLearningSummary" :key="index" data-test="learning-point">
                  ✓ {{ point }}
                </li>
              </ul>
            </details>
          </section>

          <!-- 2. 选择内容主体 -->
          <section class="excellent-remix-section">
            <h3>2. 选择内容主体</h3>
            <label class="excellent-remix-brand-field">
              <span>品牌 / 个人 IP</span>
              <select v-model="remix.brandId" data-test="remix-brand" @change="onRemixBrandChange">
                <option v-for="brand in brands" :key="brand.id" :value="brand.id">
                  {{ brand.name }}{{ brand.profileType === "personal" ? " · 个人 IP" : "" }}
                </option>
              </select>
            </label>
            <span v-if="loadingBrand" class="excellent-loading">品牌加载中…</span>
            <div v-if="remixBrand" class="excellent-remix-summary-card" data-test="remix-brand-summary">
              <div><span>品牌</span><strong>{{ remixBrand.name || "" }}</strong></div>
              <div><span>产品</span><p>{{ remixBrandProduct || "未填写" }}</p></div>
              <div><span>人群</span><p>{{ String(remixBrand.audience || "未填写") }}</p></div>
              <div>
                <span>调性/目标</span>
                <p>{{ String(remixBrand.goal || remixBrand.description || "未填写").slice(0, 100) }}</p>
              </div>
            </div>
          </section>

          <!-- 3. 想重点学习什么 -->
          <section class="excellent-remix-section">
            <h3>3. 想重点学习什么</h3>
            <div class="remix-focus">
              <label v-for="option in LEARNING_FOCUS_OPTIONS" :key="option.value" class="remix-focus-item">
                <input
                  type="checkbox"
                  :checked="remix.learningFocus.includes(option.value)"
                  @change="onToggleFocus(option.value, ($event.target as HTMLInputElement).checked)"
                />
                {{ option.label }}
              </label>
            </div>
            <p class="excellent-remix-hint">学习重点控制融合阶段真正使用哪些参考方法字段。</p>
          </section>

          <!-- 4. 内容方向 -->
          <section class="excellent-remix-section">
            <h3>4. 内容方向</h3>
            <div class="excellent-mode-tabs" role="tablist" aria-label="内容方向模式">
              <label
                v-for="mode in REMIX_MODE_TABS"
                :key="mode.value"
                class="excellent-mode-tab"
                :class="{ 'is-active': remix.contentDirectionMode === mode.value }"
              >
                <input
                  v-model="remix.contentDirectionMode"
                  type="radio"
                  :value="mode.value"
                  @change="onContentInputChanged"
                />
                {{ mode.label }}
              </label>
            </div>

            <template v-if="remix.contentDirectionMode === REMIX_CONTENT_MODES.SMART">
              <div class="excellent-smart-actions">
                <button
                  type="button"
                  class="secondary-btn small-btn"
                  data-test="generate-directions"
                  :disabled="remix.directionsStatus === 'loading' || !remix.brandId"
                  @click="generateDirections"
                >
                  {{ directionsButtonLabel(remix) }}
                </button>
              </div>
              <p v-if="remix.directionsError" class="excellent-error" data-test="directions-error">
                {{ remix.directionsError }}
              </p>
              <p v-if="!remix.smartDirections.length && remix.directionsStatus !== 'loading'" class="excellent-remix-hint">
                根据参考笔记方法与内容主体档案，手动生成 3 个内容方向。
              </p>
              <div v-if="remix.smartDirections.length" class="excellent-direction-grid">
                <label
                  v-for="direction in remix.smartDirections"
                  :key="direction.id"
                  class="excellent-direction-card remix-direction"
                  :class="{ 'is-selected': remix.selectedSmartDirectionId === direction.id }"
                >
                  <input
                    v-model="remix.selectedSmartDirectionId"
                    type="radio"
                    :value="direction.id"
                    @change="onContentInputChanged"
                  />
                  <div>
                    <strong>{{ direction.title }}</strong>
                    <p v-if="direction.summary">{{ direction.summary }}</p>
                  </div>
                </label>
              </div>
            </template>

            <template v-else-if="remix.contentDirectionMode === REMIX_CONTENT_MODES.EXISTING_IDEA">
              <input v-model="remix.existingIdeaQuery" type="search" placeholder="搜索已有选题" class="remix-search" />
              <label
                v-for="idea in filteredIdeas"
                :key="`${idea.scope}-${idea.analysisId}-${idea.trendId}-${idea.ideaIndex}`"
                class="excellent-direction-card remix-direction"
                :class="{ 'is-selected': remix.selectedExistingIdea === idea }"
              >
                <input
                  type="radio"
                  name="existingIdea"
                  :checked="remix.selectedExistingIdea === idea"
                  @change="
                    remix.selectedExistingIdea = idea;
                    onContentInputChanged();
                  "
                />
                <div>
                  <strong>{{ idea.ideaTitle }}</strong>
                  <p v-if="idea.trendTitle">{{ idea.trendTitle }}</p>
                </div>
              </label>
              <p v-if="!filteredIdeas.length" class="excellent-loading">当前品牌暂无可复用的选题。</p>
            </template>

            <template v-else>
              <textarea
                v-model="remix.customDirection"
                rows="3"
                :placeholder="`输入 ${MIN_CUSTOM_DIRECTION_CHARS}-${MAX_CUSTOM_DIRECTION_CHARS} 字的内容方向`"
                data-test="custom-direction"
                @input="onContentInputChanged"
              ></textarea>
            </template>
          </section>

          <!-- 5. 融合方案 -->
          <section class="excellent-remix-section excellent-remix-fusion">
            <div class="excellent-remix-section-head">
              <h3>5. 融合方案</h3>
              <button
                type="button"
                class="primary-btn"
                data-test="generate-fusion"
                :disabled="!remixCanGenerateFusion"
                @click="generateFusion"
              >
                {{ fusionButtonLabel(remix) }}
              </button>
            </div>
            <p v-if="remix.fusionStatus === 'stale'" class="excellent-remix-status is-warn">
              输入已变化，请重新生成融合方案。
            </p>
            <p v-if="remix.fusionError" class="excellent-error" data-test="fusion-error">{{ remix.fusionError }}</p>
            <div v-if="remix.fusionPlan" class="excellent-fusion-card" data-test="fusion-card">
              <div v-if="remix.fusionPlan.contentThesis">
                <span>核心立意</span>
                <p>{{ remix.fusionPlan.contentThesis }}</p>
              </div>
              <div v-if="remix.fusionPlan.trendUsed && remix.fusionPlan.trendTitle">
                <span>结合趋势</span>
                <p>{{ remix.fusionPlan.trendTitle }}</p>
              </div>
              <ol v-if="remix.fusionPlan?.carouselPack?.slides?.length" class="remix-slides" data-test="fusion-slides">
                <li v-for="(planSlide, index) in remix.fusionPlan?.carouselPack?.slides || []" :key="index">
                  {{ planSlide.title }}
                </li>
              </ol>
            </div>
          </section>

          <!-- 6. 素材使用方式 -->
          <section class="excellent-remix-section" data-test="remix-assets">
            <h3>6. 素材使用方式（可选）</h3>
            <p class="excellent-remix-hint">默认按品牌档案与产品描述原创生成。需要时可叠加品牌 Logo 与产品实拍图。</p>
            <div v-if="isPersonalSubject" class="excellent-asset-unified">
              <div class="excellent-asset-block">
                <p class="excellent-remix-hint">
                  个人 IP 默认按档案原创生成；头像不植入画面，当前模式不叠加产品素材。
                </p>
              </div>
            </div>
            <div v-else class="excellent-asset-unified">
              <div class="excellent-asset-block" :class="{ 'is-selected': remix.useBrandLogo }">
                <div class="excellent-asset-block-head"><strong>品牌 Logo</strong></div>
                <div v-if="remixLogoUrl" class="excellent-logo-row">
                  <img class="excellent-logo-thumb" :src="remixLogoUrl" alt="品牌 Logo" />
                  <label class="excellent-logo-check">
                    <input
                      type="checkbox"
                      data-test="remix-logo"
                      :checked="remix.useBrandLogo"
                      @change="toggleRemixLogo(($event.target as HTMLInputElement).checked)"
                    />
                    <span>使用品牌 Logo</span>
                  </label>
                </div>
                <p v-else class="excellent-remix-hint">当前品牌未配置 Logo，可前往品牌档案上传。</p>
              </div>
              <div class="excellent-asset-block" :class="{ 'is-selected': remix.productImageIds.length > 0 }">
                <div class="excellent-asset-block-head">
                  <strong>产品实拍图</strong>
                  <span class="excellent-asset-count">已选 {{ remix.productImageIds.length }} / {{ MAX_REMIX_PRODUCT_IMAGES }}</span>
                </div>
                <button
                  type="button"
                  class="secondary-btn small-btn"
                  data-test="remix-open-product-picker"
                  :disabled="!remix.brandId"
                  @click="openRemixProductPicker"
                >
                  从当前品牌素材库选择
                </button>
                <p class="excellent-remix-hint">只展示当前品牌的产品素材；不会使用其他品牌图与无归属图。</p>
              </div>
            </div>
          </section>

          <p class="excellent-originality-note">
            只学习参考笔记的信息节奏、页面角色和内容方法；不会复制原文、原图人物、原品牌、原 Logo、水印或具体版式。参考笔记图片不会自动进入最终生图。
          </p>

          <section class="excellent-remix-section">
            <button type="button" class="primary-btn" data-test="remix-submit" :disabled="!remixCanSubmit" @click="submitRemix">
              生成 4 页组图
            </button>
            <p v-if="submitPhase === 'preview'" class="excellent-loading">正在准备仿图文方案...</p>
            <ul v-if="submitSlides.length" class="remix-progress">
              <li v-for="(row, index) in submitSlides" :key="index" data-test="submit-slide">
                第 {{ index + 1 }} 页 {{ row.title }} —
                {{ row.status === "completed" ? "已完成" : row.status === "generating" ? "生成中…" : "排队中" }}
              </li>
            </ul>
            <p v-if="submitPhase === 'completing'" class="excellent-loading">正在写入历史…</p>
            <p v-if="submitPhase === 'done'" class="excellent-loading" data-test="submit-done">已保存至历史生成</p>
            <p v-if="submitError" class="excellent-error" data-test="submit-error">{{ submitError }}</p>
            <button v-if="completeContext" type="button" class="secondary-btn" @click="retryComplete">重新写入历史</button>
          </section>
        </div>
      </div>

      <!-- 产品素材选择弹层（旧版 openExcellentRemixProductPicker） -->
      <div v-if="remixProductPickerOpen" class="excellent-modal" @click.self="closeRemixProductPicker()">
        <div class="excellent-modal-body remix-product-picker" data-test="remix-product-picker">
          <header class="excellent-modal-header">
            <div>
              <h3>选择产品实拍图</h3>
              <p class="remix-subtitle">
                最多叠加 {{ MAX_REMIX_PRODUCT_IMAGES }} 张（已选 {{ remix.productImageIds.length }}）；按最近使用排序。
              </p>
            </div>
            <button type="button" class="secondary-btn" @click="closeRemixProductPicker()">关闭</button>
          </header>
          <div class="remix-picker-upload">
            <label class="upload-button">
              <input
                type="file"
                accept="image/*"
                multiple
                data-test="remix-product-upload"
                :disabled="remixUploading"
                @change="handleRemixProductUpload"
              />
              <span>{{ remixUploading ? "上传中..." : "上传产品图到当前品牌" }}</span>
            </label>
          </div>
          <p v-if="remixProductImagesLoading" class="excellent-loading">正在加载产品素材...</p>
          <ul v-else-if="remixProductImages.length" class="remix-product-list" data-test="remix-brand-images">
            <li v-for="image in remixProductImages" :key="image.id" class="remix-product-item">
              <label>
                <input
                  type="checkbox"
                  :data-test="`remix-brand-image-${image.id}`"
                  :checked="remix.productImageIds.some((id) => Number(id) === Number(image.id))"
                  @change="toggleRemixProduct(Number(image.id), ($event.target as HTMLInputElement).checked)"
                />
                <img v-if="image.url" :src="image.url" :alt="String(image.name || image.fileName || '')" loading="lazy" decoding="async" />
                <span>{{ image.name || image.fileName || `产品图 ${image.id}` }}</span>
              </label>
            </li>
          </ul>
          <p v-else-if="!remixUnassignedImages.length" class="excellent-loading">
            当前品牌还没有产品素材，可点击上方“上传产品图到当前品牌”添加。
          </p>
          <div v-if="remixUnassignedImages.length" class="remix-unassigned" data-test="remix-unassigned">
            <p class="remix-subtitle">未归属素材（认领后进入当前品牌素材库）</p>
            <ul class="remix-product-list">
              <li v-for="image in remixUnassignedImages" :key="image.id" class="remix-product-item">
                <label :data-test="`remix-unassigned-image-${image.id}`">
                  <img
                    v-if="image.url"
                    :src="image.url"
                    :alt="String(image.name || image.fileName || '')"
                    loading="lazy"
                    decoding="async"
                  />
                  <span>{{ image.name || image.fileName || `图片 ${image.id}` }}</span>
                </label>
                <button
                  type="button"
                  class="secondary-btn"
                  :data-test="`claim-unassigned-${image.id}`"
                  @click="claimRemixUnassigned(image)"
                >
                  认领到当前品牌
                </button>
              </li>
            </ul>
          </div>
          <p v-if="remixPickerMessage" class="excellent-status" data-test="remix-picker-message">{{ remixPickerMessage }}</p>
          <button type="button" class="primary-btn" @click="closeRemixProductPicker()">完成</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.excellent-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-header h1 {
  margin: 0 0 4px;
  font-size: 22px;
}

.view-subtitle {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.board-tabs {
  display: flex;
  gap: 8px;
}

.board-tab {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
}

.board-tab.is-active {
  border-color: var(--color-brand);
  color: var(--color-brand);
  font-weight: 600;
}

.excellent-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}

.excellent-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.excellent-filters select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
  min-width: 160px;
}

.primary-btn {
  background: var(--color-brand);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.excellent-status {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.excellent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.excellent-skeleton {
  height: 260px;
  border-radius: var(--radius-md);
  background: linear-gradient(90deg, var(--color-bg) 25%, var(--color-surface) 50%, var(--color-bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.2s infinite;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.excellent-empty {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: 32px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}

.excellent-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.excellent-cover {
  border: none;
  padding: 0;
  background: var(--color-bg);
  cursor: pointer;
  aspect-ratio: 3 / 4;
}

.excellent-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.excellent-image-error {
  width: 100%;
  height: 100%;
  min-height: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
  background: var(--color-surface);
}

.detail-image-error {
  min-height: 220px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}

.detail-thumb-error {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  background: var(--color-bg);
}

.excellent-card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.excellent-card-body h3 {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.excellent-card-meta {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.excellent-card-actions {
  display: flex;
  gap: 8px;
}

.excellent-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  border-radius: 999px;
  padding: 8px 20px;
  font-size: 13px;
  z-index: 60;
}

.excellent-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.excellent-modal-body {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 20px;
  width: min(680px, calc(100vw - 32px));
  max-height: 90vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.excellent-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.excellent-modal-header h3 {
  margin: 0;
  font-size: 16px;
}

.excellent-error {
  color: var(--color-brand);
  font-size: 13px;
  margin: 0;
}

.excellent-loading {
  color: var(--color-text-secondary);
  font-size: 13px;
  margin: 0;
}

.detail-carousel {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
}

.detail-image {
  max-width: 100%;
  max-height: 420px;
  border-radius: var(--radius-md);
}

.detail-thumbs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.detail-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  padding: 0;
  background: none;
  cursor: pointer;
  width: 56px;
  height: 56px;
  overflow: hidden;
}

.detail-thumb.is-active {
  border-color: var(--color-brand);
}

.detail-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.detail-content {
  font-size: 13px;
  white-space: pre-wrap;
}

.remix-body {
  width: min(760px, calc(100vw - 32px));
}

.remix-section {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.remix-section h4 {
  margin: 0;
  font-size: 14px;
}

.remix-focus {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 13px;
}

.remix-modes {
  display: flex;
  gap: 16px;
  font-size: 13px;
}

.remix-direction {
  display: flex;
  gap: 8px;
  font-size: 13px;
  align-items: flex-start;
}

.remix-direction em {
  display: block;
  font-style: normal;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.remix-search,
.remix-section select,
.remix-section textarea {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
}

.remix-slides,
.remix-progress {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.remix-analysis {
  font-size: 13px;
  margin: 0;
}

.remix-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.remix-learning {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-size: 13px;
}

.remix-learning summary {
  cursor: pointer;
  font-weight: 600;
}

.remix-learning-status {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.remix-learning-list {
  margin: 6px 0 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Legacy light-workspace parity for the Vue-only excellent-content workflow. */
.excellent-view {
  gap: var(--workspace-grid-gap);
  color: var(--workspace-text);
}

.excellent-view .panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 12px;
}

.excellent-view .panel-icon-title {
  display: flex;
  align-items: center;
  gap: 14px;
}

.excellent-view .panel-icon {
  display: block;
  width: 28.8125px;
  color: var(--workspace-brand);
  font-size: 1.8rem;
  font-weight: 400;
}

.excellent-view .excellent-panel-icon {
  background: linear-gradient(135deg, #ff3f59, #ff7a4c);
  color: #fff;
}

.excellent-view .panel-title {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.excellent-view .panel-subtitle {
  margin: 10px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.view-header h1 {
  margin: 0 0 10px;
  color: var(--workspace-text);
  font-size: 2.1rem;
  line-height: 1.2;
}

.view-subtitle {
  color: var(--workspace-text-muted);
  font-size: 0.98rem;
  line-height: 1.6;
}

.board-tabs {
  gap: 8px;
}

.board-tab,
.primary-btn,
.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.9rem;
}

.board-tab,
.secondary-btn {
  border-color: var(--workspace-border);
  background: #fff;
  color: var(--workspace-text);
}

.board-tab:hover,
.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.board-tab.is-active {
  border-color: rgba(216, 68, 68, 0.32);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
}

.primary-btn {
  background: var(--workspace-brand);
  color: #fff;
}

.primary-btn:hover:not(:disabled) {
  background: var(--workspace-brand-hover);
}

.excellent-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(180px, 260px)) auto;
  gap: 12px;
  align-items: end;
  padding: 16px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.excellent-filters label {
  gap: 7px;
  color: var(--workspace-text-muted);
  font-size: 0.86rem;
  font-weight: 600;
}

.excellent-filters select,
.remix-search,
.remix-section select,
.remix-section textarea {
  min-height: 42px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  outline: none;
}

.excellent-filters select:focus,
.remix-search:focus,
.remix-section select:focus,
.remix-section textarea:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.excellent-status,
.excellent-loading,
.remix-subtitle,
.remix-learning-status {
  color: var(--workspace-text-muted);
}

.excellent-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
}

.excellent-skeleton,
.excellent-empty,
.excellent-card,
.remix-section,
.remix-learning {
  border-radius: var(--workspace-radius);
}

.excellent-skeleton {
  background: linear-gradient(90deg, #f4efed 25%, #fff 50%, #f4efed 75%);
  background-size: 200% 100%;
}

.excellent-empty,
.excellent-card {
  position: relative;
  overflow: hidden;
  border-color: var(--workspace-border);
  background: var(--workspace-surface);
  box-shadow: none;
}

.excellent-empty::before,
.excellent-card::before {
  content: "";
  position: absolute;
  z-index: 1;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.excellent-card-body {
  gap: 10px;
  padding: 14px;
}

.excellent-card-body h3 {
  color: var(--workspace-text);
  font-size: 1rem;
  line-height: 1.45;
}

.excellent-card-meta {
  flex-wrap: wrap;
  color: var(--workspace-text-muted);
}

.excellent-card-actions {
  gap: 10px;
  margin-top: auto;
}

.excellent-toast {
  border-radius: var(--workspace-radius-sm);
  background: rgba(42, 31, 34, 0.9);
}

.excellent-modal {
  padding: 28px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.excellent-modal-body {
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.excellent-modal-header {
  align-items: flex-start;
  gap: 18px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--workspace-border);
}

.excellent-modal-header h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.4;
}

.excellent-error {
  color: #b72e3a;
}

.detail-image,
.detail-thumb,
.remix-learning {
  border-radius: var(--workspace-radius-sm);
}

.detail-thumb.is-active {
  border-color: var(--workspace-brand);
}

.detail-content {
  color: #4c4244;
  font-size: 0.93rem;
  line-height: 1.75;
}

.remix-section {
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--workspace-border);
  background: #faf7f5;
}

.remix-section h4 {
  color: var(--workspace-text);
  font-size: 1rem;
}

.remix-focus,
.remix-modes,
.remix-direction,
.remix-analysis,
.remix-slides,
.remix-progress {
  font-size: 0.9rem;
}

.remix-direction {
  padding: 10px 12px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
}

.remix-direction em {
  color: var(--workspace-text-muted);
}

.remix-learning {
  border-color: var(--workspace-border);
  background: #fff;
}

.remix-focus input,
.remix-modes input,
.remix-direction input {
  accent-color: var(--workspace-brand);
}

@media (max-width: 1180px) {
  .excellent-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 1100px) {
  .excellent-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .excellent-filters .small-btn {
    width: 100%;
  }
}

@media (max-width: 760px) {
  .excellent-filters {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px;
  }

  .excellent-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* —— 旧版详情双列弹窗（styles.css 4492+） —— */
.excellent-detail-modal-panel {
  position: relative;
  width: min(1080px, 100%);
  padding: 0;
  overflow: hidden;
  gap: 0;
}

.excellent-floating-close {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 3;
  background: rgba(255, 255, 255, 0.92);
}

.excellent-detail-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  max-height: calc(100vh - 80px);
}

.excellent-detail-gallery {
  display: grid;
  gap: 12px;
  overflow-y: auto;
  padding: 22px;
  background: #f5f1ef;
}

.excellent-detail-carousel {
  background: #171214;
  color: #fff;
}

.excellent-carousel-stage {
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  gap: 8px;
  align-items: center;
  min-height: 360px;
}

.excellent-carousel-main {
  display: grid;
  place-items: center;
  min-height: 360px;
  border-radius: 14px;
  background: #221b1d;
  overflow: hidden;
}

.excellent-carousel-main img {
  display: block;
  width: 100%;
  max-height: min(68vh, 720px);
  object-fit: contain;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.excellent-carousel-nav {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
}

.excellent-carousel-nav:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}

.excellent-carousel-thumbs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.excellent-carousel-thumb {
  flex: 0 0 auto;
  width: 54px;
  height: 72px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  background: #2a2224;
  cursor: pointer;
}

.excellent-carousel-thumb.is-active {
  border-color: #ff6b7a;
}

.excellent-carousel-thumb img {
  width: 100%;
  height: 100%;
  margin: 0;
  object-fit: cover;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.excellent-detail-gallery-meta,
.excellent-detail-loading,
.excellent-detail-error {
  color: rgba(255, 255, 255, 0.78);
  font-size: 0.8rem;
}

.excellent-detail-gallery-meta {
  text-align: center;
}

.excellent-detail-error {
  color: #ffb4b4;
  margin: 0;
}

.excellent-detail-loading {
  margin: 0;
}

.excellent-cover-fallback {
  display: grid;
  min-height: 160px;
  place-items: center;
  border: 1px dashed rgba(255, 255, 255, 0.28);
  border-radius: 14px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 0.86rem;
}

.excellent-detail-copy {
  overflow-y: auto;
  padding: 40px 28px 28px;
  background: #fffdfc;
  color: var(--workspace-text);
}

.excellent-detail-copy h2 {
  margin: 0 0 10px;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.45rem;
  line-height: 1.35;
}

.excellent-detail-copy .excellent-detail-meta {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
  color: var(--workspace-text-muted);
  font-size: 0.86rem;
}

.excellent-detail-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 18px;
}

.excellent-detail-metrics div {
  display: grid;
  gap: 3px;
  padding: 12px;
  border-radius: 11px;
  background: #faf7f5;
  text-align: center;
}

.excellent-detail-metrics span {
  color: var(--workspace-text-muted);
  font-size: 0.72rem;
}

.excellent-detail-body {
  white-space: pre-wrap;
  color: #4c4244;
  font-size: 0.9rem;
  line-height: 1.65;
  max-height: 220px;
  overflow: auto;
  margin-bottom: 16px;
}

.excellent-detail-actions {
  display: grid;
  gap: 10px;
}

.excellent-detail-actions a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  border: 1px solid var(--workspace-border);
  border-radius: 11px;
  color: var(--workspace-text);
  text-decoration: none;
  font-weight: 700;
}

.excellent-detail-remix {
  width: 100%;
}

/* —— 旧版分区式仿图文弹窗（styles.css 4661+） —— */
.excellent-remix-modal-panel {
  width: min(920px, 100%);
  max-height: min(92vh, 960px);
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
}

.excellent-remix-modal-panel > .excellent-modal-header {
  flex: 0 0 auto;
}

.excellent-remix-form {
  display: grid;
  gap: 16px;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: min(68vh, 720px);
  padding: 20px;
}

.excellent-remix-section {
  padding: 14px;
  border: 1px solid var(--workspace-border);
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.02);
}

.excellent-remix-section h3 {
  margin: 0 0 12px;
  color: var(--workspace-text);
  font-size: 0.9rem;
}

.excellent-remix-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.excellent-remix-section-head h3 {
  margin: 0;
}

.excellent-remix-status {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.5;
  background: rgba(255, 255, 255, 0.04);
  color: var(--workspace-text-muted);
}

.excellent-remix-status.is-loading {
  color: #d46b35;
}

.excellent-remix-status.is-ready {
  color: #2d8b71;
}

.excellent-remix-status.is-degraded,
.excellent-remix-status.is-warn {
  color: #b07a1d;
}

.excellent-remix-summary-card,
.excellent-fusion-card {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.excellent-remix-summary-card > div,
.excellent-fusion-card > div {
  display: grid;
  gap: 4px;
}

.excellent-remix-summary-card span,
.excellent-fusion-card span {
  color: var(--workspace-text-muted);
  font-size: 0.74rem;
  font-weight: 700;
}

.excellent-remix-summary-card p,
.excellent-fusion-card p,
.excellent-remix-hint {
  margin: 0;
  color: var(--workspace-text-muted);
  font-size: 0.82rem;
  line-height: 1.55;
}

.excellent-mode-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
  padding: 4px;
  border-radius: 14px;
  border: 1px solid var(--workspace-border);
  background: rgba(255, 255, 255, 0.03);
}

.excellent-mode-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: auto;
  min-width: 0;
  gap: 0;
  margin: 0;
  padding: 10px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--workspace-text-muted);
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 700;
}

.excellent-mode-tab input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.excellent-mode-tab.is-active {
  border-color: rgba(216, 68, 68, 0.28);
  background: #fff;
  color: var(--workspace-brand-ink);
}

.excellent-smart-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.excellent-direction-grid {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.excellent-direction-card {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 12px;
  border: 1px solid var(--workspace-border);
  border-radius: 11px;
  background: #fff;
  cursor: pointer;
}

.excellent-direction-card.is-selected {
  border-color: rgba(216, 68, 68, 0.36);
  background: #fff4f2;
}

.excellent-direction-card input {
  margin-top: 3px;
  accent-color: var(--workspace-brand);
}

.excellent-direction-card strong {
  color: var(--workspace-text);
  font-size: 0.88rem;
}

.excellent-direction-card p {
  margin: 4px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.8rem;
  line-height: 1.5;
}

.excellent-remix-brand-field {
  display: grid;
  gap: 7px;
  color: var(--workspace-text-muted);
  font-size: 0.8rem;
  font-weight: 700;
}

.excellent-remix-brand-field select,
.excellent-remix-section textarea,
.remix-search {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  font: inherit;
  outline: none;
}

.excellent-remix-section textarea {
  min-height: 92px;
  padding: 11px 12px;
  resize: vertical;
  line-height: 1.65;
}

.excellent-remix-section select:focus,
.excellent-remix-section textarea:focus,
.remix-search:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.excellent-remix-template {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  padding: 12px;
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: #fff;
}

.excellent-remix-template > img {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: 10px;
  background: #f5f1ef;
}

.excellent-remix-template > div:last-child {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.excellent-remix-template span {
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-size: 0.72rem;
  font-weight: 800;
}

.excellent-remix-template strong {
  color: var(--workspace-text);
  font-size: 0.95rem;
  line-height: 1.4;
}

.excellent-remix-template p {
  margin: 0;
  color: var(--workspace-text-muted);
  font-size: 0.78rem;
  line-height: 1.5;
}

.excellent-originality-note {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgba(216, 68, 68, 0.14);
  border-radius: 10px;
  background: #fff7f5;
  color: #6d4d51;
  font-size: 0.8rem;
  line-height: 1.6;
}

.excellent-asset-unified {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.excellent-asset-block {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: #fff;
}

.excellent-asset-block.is-selected {
  border-color: rgba(216, 68, 68, 0.36);
  background: #fff4f2;
}

.excellent-asset-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.excellent-asset-block-head strong {
  color: var(--workspace-text);
  font-size: 0.86rem;
}

.excellent-asset-count {
  padding: 2px 8px;
  border-radius: 999px;
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-size: 0.72rem;
  font-weight: 800;
}

.excellent-logo-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.excellent-logo-thumb {
  width: 44px;
  height: 44px;
  object-fit: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 10px;
  background: #faf7f5;
}

.excellent-logo-check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--workspace-text);
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.excellent-logo-check input {
  accent-color: var(--workspace-brand);
}

.remix-product-picker {
  width: min(560px, 100%);
}

.remix-product-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  max-height: 48vh;
  overflow-y: auto;
}

.remix-product-item label {
  display: grid;
  grid-template-columns: 18px 64px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--workspace-border);
  border-radius: 11px;
  background: #fff;
  cursor: pointer;
}

.remix-product-item img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  background: #f5f1ef;
}

.remix-product-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--workspace-text);
  font-size: 0.82rem;
}

.remix-product-item input {
  accent-color: var(--workspace-brand);
}

@media (max-width: 900px) {
  .excellent-detail-layout {
    grid-template-columns: minmax(0, 1fr);
    max-height: none;
  }

  .excellent-detail-gallery {
    max-height: 55vh;
  }

  .excellent-detail-copy {
    max-height: 45vh;
    padding: 24px 20px;
  }
}

@media (max-width: 760px) {
  .excellent-asset-unified,
  .remix-product-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .excellent-remix-template {
    grid-template-columns: minmax(0, 1fr);
  }

  .excellent-remix-template > img {
    width: 100%;
    height: auto;
    max-height: 220px;
    object-fit: cover;
  }

  .excellent-carousel-stage {
    grid-template-columns: 36px minmax(0, 1fr) 36px;
    min-height: 280px;
  }

  .excellent-carousel-main {
    min-height: 280px;
  }
}
</style>
