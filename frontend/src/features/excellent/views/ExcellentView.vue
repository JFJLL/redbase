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
  fetchRemixAnalysis,
  generateExcellentRemixSlide,
  previewExcellentRemix,
  refreshExcellentContents,
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
  MIN_CUSTOM_DIRECTION_CHARS,
  REMIX_CONTENT_MODES,
  resolveRemixBillingAttempt,
  shouldWarnNextDirectionCharge,
  toggleLearningFocus,
  type ExcellentRemixState,
} from "../remixState";
import { canGoNext, canGoPrevious, getNextImageIndex, getPreviousImageIndex } from "../imageNav";
import { pollImageJob } from "@/features/generation/api";
import type {
  BrandSummary,
  ContentSourceOption,
  ExcellentBoard,
  ExcellentNote,
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
  activeBoard.value = board;
  if (slices[board].status === "idle") loadBoard(board);
  if (!taxonomyOptions[board].length) loadTaxonomy(board);
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

function noteKey(item: ExcellentNote): string {
  return String(item.noteId || item.id || "");
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

const filteredIdeas = computed(() =>
  remix.value ? filterExistingIdeas(remix.value.existingIdeas, remix.value.existingIdeaQuery) : [],
);
const remixCanGenerateFusion = computed(() => canGenerateFusionPlan(remix.value, !loadingBrand.value));
const remixCanSubmit = computed(() => canSubmitExcellentRemix(remix.value, !loadingBrand.value));

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
  // 参考学习分析改为惰性触发：首次点“生成内容方向”（或直接生成融合方案）时
  // 才调分析，命中 30 天缓存则直接读取，降低无意义模型消耗。品牌照常预加载。
  loadRemixBrands();
}

function closeRemix() {
  remixOpen.value = false;
  remix.value = null;
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

function isRequestIdConflict(error: unknown): boolean {
  return error instanceof ApiError && error.body?.code === "REQUEST_ID_CONFLICT";
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
    if (isRequestIdConflict(error)) state.directionsBillingAttempt = null;
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
    if (isRequestIdConflict(error)) state.fusionBillingAttempt = null;
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
  loadContentSources();
  loadTaxonomy(activeBoard.value);
  loadBoard(activeBoard.value);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onDetailKeydown);
  if (toastTimer) clearTimeout(toastTimer);
  if (refreshCooldownTimer) clearInterval(refreshCooldownTimer);
});
</script>

<template>
  <section class="excellent-view">
    <header class="view-header">
      <h1>优秀内容</h1>
      <p class="view-subtitle">学习平台优秀图文，支持按来源与类目筛选，可一键仿图文生成品牌组图。</p>
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
          <img
            v-if="item.coverUrl || (item.imageUrls || [])[0]"
            :src="String(item.coverUrl || (item.imageUrls || [])[0])"
            :alt="item.title || ''"
            loading="lazy"
            decoding="async"
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
      <div class="excellent-modal-body">
        <header class="excellent-modal-header">
          <h3>{{ detail.item?.title || "优秀内容详情" }}</h3>
          <button type="button" class="secondary-btn" @click="closeDetail()">关闭</button>
        </header>
        <p v-if="detail.error" class="excellent-error" data-test="detail-error">{{ detail.error }}</p>
        <div v-if="detailImages.length" class="detail-carousel">
          <button
            type="button"
            class="secondary-btn"
            :disabled="!canGoPrevious(detail.activeImageIndex, detailImages.length)"
            @click="detailPrev()"
          >
            ←
          </button>
          <img :src="detailImages[detail.activeImageIndex]" alt="笔记图片" class="detail-image" />
          <button
            type="button"
            class="secondary-btn"
            :disabled="!canGoNext(detail.activeImageIndex, detailImages.length)"
            @click="detailNext()"
          >
            →
          </button>
        </div>
        <div v-if="detailImages.length > 1" class="detail-thumbs">
          <button
            v-for="(url, index) in detailImages"
            :key="index"
            type="button"
            class="detail-thumb"
            :class="{ 'is-active': index === detail.activeImageIndex }"
            @click="detail.activeImageIndex = index"
          >
            <img :src="url" alt="" loading="lazy" decoding="async" />
          </button>
        </div>
        <p v-if="detail.loading" class="excellent-loading">正在加载详情…</p>
        <p v-if="detail.item?.content" class="detail-content">{{ detail.item?.content }}</p>
        <button type="button" class="primary-btn" @click="detail.item && openRemix(detail.item)">一键仿图文</button>
      </div>
    </div>

    <!-- 一键仿图文弹窗（按钮名不变；弹窗与说明改为参考学习定位） -->
    <div v-if="remixOpen && remix" class="excellent-modal" @click.self="closeRemix()">
      <div class="excellent-modal-body remix-body">
        <header class="excellent-modal-header">
          <div>
            <h3>参考优秀内容生成品牌原创图文</h3>
            <p class="remix-subtitle">学习参考内容的表达方法，不复制原图、原排版与原品牌。</p>
            <p class="remix-credits" data-test="remix-credits">当前积分：{{ auth.user?.credits ?? "—" }}</p>
          </div>
          <button type="button" class="secondary-btn" @click="closeRemix()">关闭</button>
        </header>

        <section class="remix-section">
          <h4>参考方法分析</h4>
          <p v-if="remix.analysisStatus === 'idle'" class="excellent-loading" data-test="analysis-idle">
            点击“生成内容方向”后，AI 将学习参考内容的表达方法。
          </p>
          <p v-else-if="remix.analysisStatus === 'loading'" class="excellent-loading">正在学习参考内容…</p>
          <p v-else-if="remix.analysisStatus === 'degraded'" class="excellent-error" data-test="analysis-error">
            {{ remix.analysisError }}
          </p>
          <p v-else-if="remix.analysis" class="remix-analysis" data-test="analysis-ready">
            {{ remix.analysis.referenceTopic || "参考方法已就绪" }}
          </p>
          <!-- AI 学习结果：默认折叠，只展示面向用户的摘要短句。 -->
          <details v-if="remix.analysis" class="remix-learning" data-test="learning-summary">
            <summary>AI已学习（展开查看）</summary>
            <p class="remix-learning-status" data-test="learning-status">{{ learningStatusLabel }}</p>
            <p v-if="remix.analysis?.warning" class="excellent-error" data-test="learning-warning">
              {{ remix.analysis?.warning }}
            </p>
            <ul class="remix-learning-list">
              <li v-for="(point, index) in remixLearningSummary" :key="index" data-test="learning-point">✓ {{ point }}</li>
            </ul>
          </details>
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
        </section>

        <section class="remix-section">
          <h4>品牌</h4>
          <select v-model="remix.brandId" data-test="remix-brand" @change="onRemixBrandChange">
            <option v-for="brand in brands" :key="brand.id" :value="brand.id">{{ brand.name }}</option>
          </select>
          <span v-if="loadingBrand" class="excellent-loading">品牌加载中…</span>
        </section>

        <section class="remix-section">
          <h4>内容方向</h4>
          <div class="remix-modes">
            <label>
              <input
                v-model="remix.contentDirectionMode"
                type="radio"
                :value="REMIX_CONTENT_MODES.SMART"
                @change="onContentInputChanged"
              />
              智能方向
            </label>
            <label>
              <input
                v-model="remix.contentDirectionMode"
                type="radio"
                :value="REMIX_CONTENT_MODES.EXISTING_IDEA"
                @change="onContentInputChanged"
              />
              已有选题
            </label>
            <label>
              <input
                v-model="remix.contentDirectionMode"
                type="radio"
                :value="REMIX_CONTENT_MODES.CUSTOM"
                @change="onContentInputChanged"
              />
              自定义
            </label>
          </div>

          <template v-if="remix.contentDirectionMode === REMIX_CONTENT_MODES.SMART">
            <button
              type="button"
              class="secondary-btn"
              data-test="generate-directions"
              :disabled="remix.directionsStatus === 'loading' || !remix.brandId"
              @click="generateDirections"
            >
              {{ directionsButtonLabel(remix) }}
            </button>
            <p v-if="remix.directionsError" class="excellent-error" data-test="directions-error">{{ remix.directionsError }}</p>
            <label v-for="direction in remix.smartDirections" :key="direction.id" class="remix-direction">
              <input
                v-model="remix.selectedSmartDirectionId"
                type="radio"
                :value="direction.id"
                @change="onContentInputChanged"
              />
              <span>
                <strong>{{ direction.title }}</strong>
                <em v-if="direction.summary">{{ direction.summary }}</em>
              </span>
            </label>
          </template>

          <template v-else-if="remix.contentDirectionMode === REMIX_CONTENT_MODES.EXISTING_IDEA">
            <input
              v-model="remix.existingIdeaQuery"
              type="search"
              placeholder="搜索已有选题"
              class="remix-search"
            />
            <label v-for="idea in filteredIdeas" :key="`${idea.scope}-${idea.analysisId}-${idea.trendId}-${idea.ideaIndex}`" class="remix-direction">
              <input
                type="radio"
                name="existingIdea"
                :checked="remix.selectedExistingIdea === idea"
                @change="
                  remix.selectedExistingIdea = idea;
                  onContentInputChanged();
                "
              />
              <span>
                <strong>{{ idea.ideaTitle }}</strong>
                <em v-if="idea.trendTitle">{{ idea.trendTitle }}</em>
              </span>
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

        <section class="remix-section">
          <h4>融合方案</h4>
          <button
            type="button"
            class="primary-btn"
            data-test="generate-fusion"
            :disabled="!remixCanGenerateFusion"
            @click="generateFusion"
          >
            {{ fusionButtonLabel(remix) }}
          </button>
          <p v-if="remix.fusionStatus === 'stale'" class="excellent-loading">输入已变化，请重新生成融合方案。</p>
          <p v-if="remix.fusionError" class="excellent-error" data-test="fusion-error">{{ remix.fusionError }}</p>
          <ol v-if="remix.fusionPlan?.carouselPack?.slides?.length" class="remix-slides" data-test="fusion-slides">
            <li v-for="(planSlide, index) in remix.fusionPlan?.carouselPack?.slides || []" :key="index">
              {{ planSlide.title }}
            </li>
          </ol>
        </section>

        <section class="remix-section">
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
</style>
