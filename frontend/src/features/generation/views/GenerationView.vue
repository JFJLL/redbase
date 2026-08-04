<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import ProductImagePanel from "../components/ProductImagePanel.vue";
import {
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
  type StyleReferenceImage,
} from "../ideaCreativeSettings";
import {
  IMAGE_ASPECT_RATIOS,
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  SMART_ASPECT_RATIO_DEFAULTS,
  WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY,
  WECHAT_TEMPLATE_OPTIONS,
  XHS_CREATIVE_STYLE_OPTIONS,
  buildIdeaStylePrompt,
  completeXhsCarousel,
  createXhsCarouselGroupId,
  enrichXhsCarouselSlides,
  fetchBrandDetail,
  findTrendInBrand,
  hasXhsCarouselSlideImage,
  pollImageJob,
  previewXhsCarousel,
  refreshGenerationHistory,
  resolveAspectRatio,
  safeImageSrc,
  submitImageEdit,
  submitMomentsImage,
  submitStyleImage,
  submitWechatLongImage,
  submitXhsCarouselSlide,
  type BrandDetail,
  type CarouselPack,
  type IdeaDetail,
  type ImageConceptResult,
  type ProductImageInput,
  type ProductImageView,
  type TrendDetail,
  type WechatPack,
} from "../api";
import type { SessionUser } from "@/shared/types/api";

// 生图任务：选题驱动的四类生图（朋友圈图/公众号长图/小红书组图/风格化图）。
// 有 route query（brandId/trendId/ideaIndex/action）时加载品牌详情并暴露四类生成动作；
// 无上下文时显示产品化任务概览，引导去内容选题页（图3 裸表单已下线）。
// 所有请求走 @/shared/api/client，signal 由 useAbortScope 提供，
// 卸载/退出登录时轮询自动停止。
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const ASPECT_RATIO_OPTIONS = ["smart", ...IMAGE_ASPECT_RATIOS];

function parsePositiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseIndex(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return null;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

const queryBrandId = computed(() => parsePositiveInt(route.query.brandId));
const queryTrendId = computed(() => parsePositiveInt(route.query.trendId));
const queryIdeaIndex = computed(() => parseIndex(route.query.ideaIndex));
const queryAction = computed<"moments" | "wechat" | "xhsCarousel" | "styleImage" | null>(() => {
  const raw = Array.isArray(route.query.action) ? route.query.action[0] : route.query.action;
  return raw === "moments" || raw === "wechat" || raw === "xhsCarousel" || raw === "styleImage" ? raw : null;
});
const hasIdeaContext = computed(
  () => queryBrandId.value !== null && queryTrendId.value !== null && queryIdeaIndex.value !== null,
);

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

function applyUser(user: SessionUser | undefined): void {
  if (user) auth.user = user;
}

// —— Brand context loading ——
const brand = ref<BrandDetail | null>(null);
const trend = ref<TrendDetail | null>(null);
const idea = ref<IdeaDetail | null>(null);
const contextLoading = ref(false);
const contextError = ref("");
const startedActionKey = ref("");

const brandHasLogo = computed(() => Boolean(brand.value?.logo));
const logoLabel = computed(() => (brand.value?.profileType === "personal" ? "个人头像" : "品牌 Logo"));

async function loadBrandContext() {
  if (!hasIdeaContext.value) return;
  contextLoading.value = true;
  contextError.value = "";
  brand.value = null;
  trend.value = null;
  idea.value = null;
  try {
    const result = await fetchBrandDetail(queryBrandId.value as number, scope.signalFor("brand-detail"));
    brand.value = result.brand;
    trend.value = findTrendInBrand(result.brand, queryTrendId.value as number);
    idea.value = trend.value?.ideas?.[queryIdeaIndex.value as number] ?? null;
    if (!trend.value) {
      contextError.value = "未找到对应的趋势，请返回内容选题页重新选择。";
    } else if (!idea.value) {
      contextError.value = "未找到对应的选题，请返回内容选题页重新选择。";
    }
    // 从内容选题页的一键按钮进入：就绪门控 + 一次性票据，自动启动至多一次。
    await maybeAutoStartGeneration();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    contextError.value = `加载品牌详情失败：${(error as Error).message}`;
  } finally {
    contextLoading.value = false;
  }
}

onMounted(loadBrandContext);

// —— 一键生成：一次性票据 + 自动启动就绪门控 ——
// 自动启动前必须等齐：品牌/趋势/选题就绪、该选题创作设置已恢复、产品图库已加载。
const ideaSettingsRestored = ref(false);
const productImagesLoaded = ref(false);
const productImagesError = ref("");
const productImagesReloadToken = ref(0);

/**
 * 消费一次性票据：任何生成 POST 之前，先把 URL 上的 action 移除（保留
 * brandId/trendId/ideaIndex 及其余 query）。此后刷新、重挂载、后退再前进，
 * URL 已无 action，不会再次自动提交。
 */
async function consumeActionTicket(): Promise<boolean> {
  const query = { ...route.query };
  delete query.action;
  try {
    await router.replace({ query });
    return true;
  } catch (error) {
    // replace 未能原子完成：停止自动启动并显示可恢复错误，绝不带着 action 重复 POST。
    contextError.value = `自动启动失败，请手动点击生成：${(error as Error).message}`;
    return false;
  }
}

/** 自动启动门控；不满足就绪条件时静默等待，就绪状态变化后由 watch 复查。 */
async function maybeAutoStartGeneration(): Promise<void> {
  const action = queryAction.value;
  if (!action) return;
  const actionKey = `${queryBrandId.value}:${queryTrendId.value}:${queryIdeaIndex.value}:${action}`;
  if (actionKey === startedActionKey.value) return;
  // 图库门控：用户开启产品图时必须图库已加载且无错误（失败时 product-images-error
  // 区块展示可恢复错误，绝不静默以空数组自动生成）；明确关闭产品图时不等待图库，
  // 空 productImages 是合法语义（手动/重试入口由共享防线统一约束）。
  if (useProductImages.value) {
    if (productImagesError.value) return;
    if (!productImagesLoaded.value) return;
  }
  if (!brand.value || !trend.value || !idea.value || !ideaSettingsRestored.value) return;
  // 纵深防御：先落 startedActionKey 再消费票据；即便 replace 抛错或本次生成失败，
  // 也不会再次自动提交（失败由用户点「重试」手动恢复）。
  startedActionKey.value = actionKey;
  await startGenerationAction(action);
}

// 图库加载完成/失败、创作设置恢复等就绪状态变化时复查自动启动条件。
watch([productImagesLoaded, productImagesError, ideaSettingsRestored], () => {
  void maybeAutoStartGeneration();
});

// —— Shared generation controls（按 品牌ID:趋势ID:选题序号 键位独立记忆，旧版按选题记忆语义） ——
const aspectRatioSelection = ref("smart");
const wechatTemplate = ref("auto");
const xhsStylePreset = ref("auto");
const useBrandLogo = ref(false);
const useProductImages = ref(true);

const selectedProductIds = ref<number[]>([]);
const loadedProductImages = ref<ProductImageView[]>([]);
const styleReference = ref<StyleReferenceImage | null>(null);

const ideaSettingsKey = computed(() =>
  getIdeaSettingsKey(queryBrandId.value, queryTrendId.value, queryIdeaIndex.value),
);

/** 进入选题时恢复该选题自己的创作设置（getIdea*Selection 语义）。 */
function restoreIdeaSettings(): void {
  const settings = getIdeaCreativeSettings(ideaSettingsKey.value);
  aspectRatioSelection.value = settings.aspectRatioSelection;
  xhsStylePreset.value = settings.visualStylePreset;
  wechatTemplate.value = settings.wechatTemplate;
  useBrandLogo.value = settings.useBrandLogo;
  useProductImages.value = settings.useProductImages;
  selectedProductIds.value = [...settings.selectedProductIds];
  styleReference.value = settings.styleReference;
  ideaSettingsRestored.value = true;
}

restoreIdeaSettings();

// 切换选题：重载上下文并恢复目标选题自己的设置，不得串值。
watch(ideaSettingsKey, () => {
  restoreIdeaSettings();
  void loadBrandContext();
});

// 设置变化即写回当前选题键位（会话内生效）。
watch(
  [
    aspectRatioSelection,
    xhsStylePreset,
    wechatTemplate,
    useBrandLogo,
    useProductImages,
    selectedProductIds,
    styleReference,
  ],
  () => {
    saveIdeaCreativeSettings(ideaSettingsKey.value, {
      aspectRatioSelection: aspectRatioSelection.value,
      visualStylePreset: xhsStylePreset.value,
      wechatTemplate: wechatTemplate.value,
      useBrandLogo: useBrandLogo.value,
      useProductImages: useProductImages.value,
      selectedProductIds: selectedProductIds.value,
      styleReference: styleReference.value,
    });
  },
  { deep: true },
);

// getSelectedProductImages semantics: library images submit as { id, name }.
const selectedProductImageInputs = computed<ProductImageInput[]>(() =>
  useProductImages.value
    ? loadedProductImages.value
        .filter((image) => selectedProductIds.value.includes(image.id))
        .map((image) => ({ id: image.id, name: image.originalName }))
    : [],
);

function onProductImagesLoaded(images: ProductImageView[]) {
  loadedProductImages.value = images;
  productImagesLoaded.value = true;
  productImagesError.value = "";
}

function onProductImagesLoadError(message: string) {
  productImagesLoaded.value = false;
  productImagesError.value = message || "产品素材加载失败";
}

function retryProductImagesLoad(): void {
  productImagesReloadToken.value += 1;
}

/** 产品图库防线：开启产品图且图库未加载完成/加载失败时，任何生成入口（自动/手动/重试）都不允许发 POST。 */
const productLibraryBlocked = computed(
  () => useProductImages.value && (!productImagesLoaded.value || !!productImagesError.value),
);

const resolvedUseBrandLogo = computed(() => useBrandLogo.value && brandHasLogo.value);

// —— Generation status/result state ——
type GenKind = "moments" | "wechat" | "xhsCarousel" | "styleImage" | "";
type GenPhase = "idle" | "running" | "done" | "error";
const genPhase = ref<GenPhase>("idle");
const genKind = ref<GenKind>("");
const genStatus = ref("");
const genError = ref("");
const momentsResult = ref<ImageConceptResult | null>(null);
const wechatResult = ref<WechatPack | null>(null);
const styleResult = ref<ImageConceptResult | null>(null);

const busy = computed(() => genPhase.value === "running");

async function startGenerationAction(action: "moments" | "wechat" | "xhsCarousel" | "styleImage"): Promise<void> {
  // 产品图库防线：先于票据消费拦截。开启产品图但图库未就绪/失败时，不消费 action 票据、不发 POST。
  // 图库失败时 product-images-error 区块已展示错误与「重新加载产品图」；仅加载中则补一条明确提示。
  if (productLibraryBlocked.value) {
    if (!productImagesError.value) {
      productImagesError.value = "产品素材尚未加载完成，请等待加载或点击「重新加载产品图」后再生成。";
    }
    return;
  }
  // 一次性票据在共享入口消费：自动启动、手动点击、失败重试都不得带着 action 发 POST。
  // replace 失败即停止本次生成并显示可恢复错误，绝不带着 action 重复提交。
  const consumed = await consumeActionTicket();
  if (!consumed) return;
  if (action === "moments") {
    await generateMomentsImage();
  } else if (action === "wechat") {
    await generateWechatLongImage();
  } else if (action === "xhsCarousel") {
    await generateXhsCarousel();
  } else {
    await generateStyleImage();
  }
}

/** 失败后的错误恢复：重跑同一类生图任务。 */
async function retryGeneration(): Promise<void> {
  if (busy.value || !genKind.value) return;
  await startGenerationAction(genKind.value as "moments" | "wechat" | "xhsCarousel" | "styleImage");
}

function startGeneration(kind: GenKind, status: string) {
  genKind.value = kind;
  genPhase.value = "running";
  genStatus.value = status;
  genError.value = "";
  momentsResult.value = null;
  wechatResult.value = null;
  styleResult.value = null;
}

function currentContext(): { brandId: number; trendId: number; ideaIndex: number } | null {
  if (!hasIdeaContext.value || !trend.value || !idea.value) return null;
  return {
    brandId: queryBrandId.value as number,
    trendId: queryTrendId.value as number,
    ideaIndex: queryIdeaIndex.value as number,
  };
}

async function afterGenerationSuccess() {
  // refreshGenerationHistoryAfterGeneration + updateCurrentUser(job.user) equivalents.
  const signal = scope.signalFor("post-generation");
  try {
    await refreshGenerationHistory(signal);
  } catch (error) {
    if (isAbortError(error)) return;
  }
  await auth.refreshUser();
}

// —— a) AI 朋友圈图 ——
async function generateMomentsImage() {
  const context = currentContext();
  if (busy.value || !context) return;
  const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "moments");
  const signal = scope.signalFor("moments");
  startGeneration("moments", "任务已进入队列，正在排队生成朋友圈图...");
  try {
    const submitResult = await submitMomentsImage(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      { productImages: selectedProductImageInputs.value, useBrandLogo: resolvedUseBrandLogo.value, aspectRatio },
      signal,
    );
    applyUser(submitResult.user);
    if (!submitResult.jobId) throw new Error("图片任务创建失败");
    const concept = await pollImageJob(submitResult.jobId, { signal, onUser: applyUser });
    momentsResult.value = concept;
    genPhase.value = "done";
    genStatus.value = "朋友圈图已生成并写入历史生成。";
    await afterGenerationSuccess();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    genPhase.value = "error";
    genStatus.value = "";
    genError.value = `生图服务暂时不可用：${(error as Error).message}`;
  }
}

// —— b) AI 公众号长图 ——
const wechatConfirm = ref<{ aspectRatio: string; resolve: (value: string | null) => void } | null>(null);
const wechatDisableWarning = ref(false);

// confirmWechatAspectRatio semantics (app.js 3207): 9:21 或已勾选不再提醒时直接通过。
function confirmWechatAspectRatio(aspectRatio: string): Promise<string | null> {
  const disabled = (() => {
    try {
      return localStorage.getItem(WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY) === "true";
    } catch {
      return false;
    }
  })();
  if (aspectRatio === "9:21" || disabled) return Promise.resolve(aspectRatio);
  return new Promise((resolve) => {
    wechatDisableWarning.value = false;
    wechatConfirm.value = { aspectRatio, resolve };
  });
}

function resolveWechatConfirm(value: string | null) {
  const pending = wechatConfirm.value;
  wechatConfirm.value = null;
  if (!pending) return;
  if (value !== null && wechatDisableWarning.value) {
    try {
      localStorage.setItem(WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY, "true");
    } catch {
      /* ignore storage errors */
    }
  }
  if (value === "9:21") aspectRatioSelection.value = "9:21";
  pending.resolve(value);
}

async function generateWechatLongImage() {
  const context = currentContext();
  if (busy.value || !context) return;
  const aspectRatio = await confirmWechatAspectRatio(resolveAspectRatio(aspectRatioSelection.value, "wechat"));
  if (!aspectRatio) return;
  const signal = scope.signalFor("wechat");
  startGeneration("wechat", "任务已进入队列，正在排队生成公众号长图...");
  try {
    const submitResult = await submitWechatLongImage(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      {
        productImages: selectedProductImageInputs.value,
        useBrandLogo: resolvedUseBrandLogo.value,
        wechatTemplate: wechatTemplate.value,
        aspectRatio,
      },
      signal,
    );
    applyUser(submitResult.user);
    const pack: WechatPack = { ...(submitResult.wechatPack || {}) };
    if (!submitResult.jobId) throw new Error("公众号长图任务创建失败");
    const concept = await pollImageJob(submitResult.jobId, { signal, onUser: applyUser });
    pack.imageUrl = concept.imageUrl || concept.previewUrl;
    pack.previewUrl = concept.imageUrl || concept.previewUrl;
    wechatResult.value = pack;
    genPhase.value = "done";
    genStatus.value = "公众号长图已生成并写入历史生成。";
    await afterGenerationSuccess();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    genPhase.value = "error";
    genStatus.value = "";
    genError.value = `生图服务暂时不可用：${(error as Error).message}`;
  }
}

// —— c) 小红书组图（preview → slides/:i → complete） ——
const carousel = reactive<{ pack: CarouselPack | null; creditEventId: number | null }>({ pack: null, creditEventId: null });

async function generateXhsCarousel() {
  const context = currentContext();
  if (busy.value || !context) return;
  const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "xhsCarousel");
  const signal = scope.signalFor("xhs-carousel");
  startGeneration("xhsCarousel", "任务已进入队列，正在准备小红书组图方案...");
  carousel.pack = null;
  carousel.creditEventId = null;
  carouselCompleted.value = false;
  try {
    const previewResult = await previewXhsCarousel(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      { aspectRatio, visualStylePreset: xhsStylePreset.value },
      signal,
    );
    applyUser(previewResult.user);
    const previewPack = previewResult.carouselPack;
    if (!previewPack || !Array.isArray(previewPack.slides)) {
      throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
    }
    carousel.pack = {
      ...previewPack,
      aspectRatio,
      carouselGroupId:
        previewPack.carouselGroupId ||
        createXhsCarouselGroupId(context.brandId, context.trendId, context.ideaIndex),
      slides: enrichXhsCarouselSlides({ ...previewPack, aspectRatio }),
    };
    genPhase.value = "done";
    genStatus.value = "组图方案已就绪，可单张或一键生成 4 张图。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    genPhase.value = "error";
    genStatus.value = "";
    genError.value = `生成失败：${(error as Error).message}`;
  }
}

/**
 * 提交单页任务（不等待出图）。返回 jobId；已成功页/生成中直接跳过，
 * 请求体带 slide（含每页可编辑 prompt），对齐旧版 slide 请求体与后端
 * xhsCarouselSlideMatch 分支。
 */
async function submitCarouselSlideRequest(slideIndex: number): Promise<string | null> {
  const context = currentContext();
  const pack = carousel.pack;
  if (!context || !pack) return null;
  const slide = pack.slides[slideIndex];
  if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating) return null;
  const aspectRatio = pack.aspectRatio || resolveAspectRatio(aspectRatioSelection.value, "xhsCarousel");
  const signal = scope.signalFor(`xhs-slide-${slideIndex}`);
  slide.isGenerating = true;
  slide.error = "";
  try {
    const result = await submitXhsCarouselSlide(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      slideIndex,
      {
        carouselPack: pack,
        slide,
        productImages: selectedProductImageInputs.value,
        useBrandLogo: resolvedUseBrandLogo.value,
        visualStylePreset: xhsStylePreset.value,
        aspectRatio,
      },
      signal,
    );
    applyUser(result.user);
    carousel.creditEventId = result.creditEventId ?? carousel.creditEventId;
    if (!result.slideJob?.jobId) throw new Error("小红书组图任务创建失败");
    return result.slideJob.jobId;
  } catch (error) {
    if (isAbortError(error)) return null;
    if (await handleUnauthorizedError(error)) return null;
    slide.isGenerating = false;
    slide.error = `生成失败：${(error as Error).message}`;
    return null;
  }
}

/** 等待单页出图（可与其他页并发进行）。 */
async function pollCarouselSlideJob(slideIndex: number, jobId: string): Promise<void> {
  const pack = carousel.pack;
  if (!pack) return;
  const slide = pack.slides[slideIndex];
  const signal = scope.signalFor(`xhs-slide-poll-${slideIndex}`);
  try {
    const concept = await pollImageJob(jobId, { signal, onUser: applyUser });
    pack.slides[slideIndex] = {
      ...pack.slides[slideIndex],
      imageUrl: concept.imageUrl || concept.previewUrl,
      previewUrl: concept.imageUrl || concept.previewUrl,
      isGenerating: false,
      isQueued: false,
      error: "",
    };
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    slide.isGenerating = false;
    slide.error = `生成失败：${(error as Error).message}`;
  }
}

/** 单页生成 / 失败重试：hasXhsCarouselSlideImage 的成功页不会被重新生成。 */
async function generateCarouselSlide(slideIndex: number) {
  const jobId = await submitCarouselSlideRequest(slideIndex);
  if (!jobId) return;
  await pollCarouselSlideJob(slideIndex, jobId);
  await maybeCompleteCarousel();
}

/**
 * 一键生成全部：提交按页序串行（旧版安全顺序语义），
 * 但轮询并发进行——4 页不会串行等待（旧版 IMAGE_TASK 并发队列语义）。
 */
async function generateAllCarouselSlides() {
  const pack = carousel.pack;
  if (!pack) return;
  const polls: Array<Promise<void>> = [];
  for (let index = 0; index < pack.slides.length; index += 1) {
    if (hasXhsCarouselSlideImage(pack.slides[index])) continue;
    const jobId = await submitCarouselSlideRequest(index);
    if (!jobId) continue;
    polls.push(pollCarouselSlideJob(index, jobId));
  }
  await Promise.all(polls);
  await maybeCompleteCarousel();
}

/** 生成后的单页改图：复用现有 POST /api/image-edits（旧版 runEditSlide 请求体）。 */
async function editCarouselSlide(slideIndex: number) {
  const pack = carousel.pack;
  if (!pack) return;
  const slide = pack.slides[slideIndex];
  if (!slide || slide.isEditing) return;
  const prompt = String(slide.editPrompt || "").trim();
  const imageUrl = String(slide.imageUrl || slide.previewUrl || "");
  if (!prompt || !imageUrl) return;
  const signal = scope.signalFor(`xhs-slide-edit-${slideIndex}`);
  slide.isEditing = true;
  slide.error = "";
  try {
    const submitResult = await submitImageEdit(
      {
        imageUrl,
        prompt,
        title: String(slide.title || slide.pageLabel || ""),
        aspectRatio: pack.aspectRatio,
      },
      signal,
    );
    applyUser(submitResult.user);
    if (!submitResult.jobId) throw new Error("改图任务创建失败");
    const concept = await pollImageJob(submitResult.jobId, { signal, onUser: applyUser });
    pack.slides[slideIndex] = {
      ...pack.slides[slideIndex],
      imageUrl: concept.imageUrl || concept.previewUrl,
      previewUrl: concept.imageUrl || concept.previewUrl,
      isEditing: false,
      editPrompt: "",
      error: "",
    };
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    slide.isEditing = false;
    slide.error = `改图失败：${(error as Error).message}`;
  }
}

const carouselCompleted = ref(false);

async function maybeCompleteCarousel() {
  const context = currentContext();
  const pack = carousel.pack;
  if (!context || !pack || carouselCompleted.value) return;
  if (!pack.slides.every(hasXhsCarouselSlideImage)) return;
  const signal = scope.signalFor("xhs-complete");
  try {
    const result = await completeXhsCarousel(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      { carouselPack: pack, creditEventId: carousel.creditEventId },
      signal,
    );
    applyUser(result.user);
    carouselCompleted.value = true;
    genStatus.value = "小红书组图已全部生成并写入历史生成。";
    await afterGenerationSuccess();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    genError.value = `小红书组图写入历史失败：${(error as Error).message}`;
  }
}

// —— d) 风格化图（真实风格参考图，对齐旧版 app.js 2969-2996 上传语义） ——
const styleReferenceError = ref("");

async function handleStyleReferenceChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    styleReferenceError.value = "风格参考图最多上传 10MB，请压缩图片后重新上传。";
    return;
  }
  // 读取走可中止工具：账号切换（notifyAuthReset）时 FileReader.abort()，不落库。
  const signal = scope.signalFor("style-reference-read");
  try {
    const dataUrl = await fileToDataUrl(file, signal);
    if (signal.aborted) return;
    styleReference.value = { fileName: file.name, dataUrl, sizeBytes: file.size };
    styleReferenceError.value = "";
  } catch (error) {
    if (isAbortError(error)) return;
    styleReferenceError.value = `风格参考图读取失败：${(error as Error).message}`;
  }
}

// data-clear-style-reference 语义：清除当前选题的风格参考图。
function clearStyleReference(): void {
  styleReference.value = null;
  styleReferenceError.value = "";
}

async function generateStyleImage() {
  const context = currentContext();
  if (busy.value || !context) return;
  const stylePrompt = buildIdeaStylePrompt(idea.value);
  if (!stylePrompt) {
    genPhase.value = "error";
    genKind.value = "styleImage";
    genStatus.value = "";
    genError.value = "请先在内容选题页补充内容摘要、切入角度等字段后再生成风格化图。";
    return;
  }
  const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "styleImage");
  const signal = scope.signalFor("style-image");
  startGeneration("styleImage", "任务已进入队列，正在排队生成风格化图...");
  try {
    const submitResult = await submitStyleImage(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      {
        title: idea.value?.title || "风格化图片",
        stylePrompt,
        useBrandLogo: resolvedUseBrandLogo.value,
        aspectRatio,
        // 旧版语义：有参考图则以 {name, dataUrl} 提交，绝不固定为空数组。
        styleReferenceImages: styleReference.value
          ? [{ name: styleReference.value.fileName, dataUrl: styleReference.value.dataUrl }]
          : [],
      },
      signal,
    );
    applyUser(submitResult.user);
    if (!submitResult.jobId) throw new Error("风格化图任务创建失败");
    const concept = await pollImageJob(submitResult.jobId, { signal, onUser: applyUser });
    styleResult.value = concept;
    genPhase.value = "done";
    genStatus.value = "风格化图已生成并写入历史生成。";
    await afterGenerationSuccess();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    genPhase.value = "error";
    genStatus.value = "";
    genError.value = `生图服务暂时不可用：${(error as Error).message}`;
  }
}

// —— 无选题上下文：产品化空状态，引导去内容选题页（图3 裸表单已下线） ——
function goToIdeas(): void {
  void router.push({ name: "ideas" });
}
</script>

<template>
  <section class="generation-view">
    <header class="view-header">
      <h1>生图任务</h1>
      <p class="view-subtitle">
        从内容选题进入可生成朋友圈图、公众号长图、小红书组图和风格化图；生成结果会自动写入历史生成。
      </p>
    </header>

    <!-- 选题上下文：四类生图 -->
    <template v-if="hasIdeaContext">
      <p v-if="contextLoading" class="job-status" data-test="context-loading">正在加载品牌详情...</p>
      <p v-if="contextError" class="job-error" data-test="context-error">{{ contextError }}</p>
      <div v-if="productImagesError" class="job-error" data-test="product-images-error">
        <span>{{ productImagesError }}</span>
        <button
          type="button"
          class="secondary-btn"
          data-test="retry-product-images"
          @click="retryProductImagesLoad"
        >
          重新加载产品图
        </button>
      </div>

      <div v-if="brand && trend && idea" class="idea-context" data-test="idea-context">
        <div class="context-summary">
          <span class="context-brand">{{ brand.name }}</span>
          <span class="context-sep">×</span>
          <span class="context-trend">{{ trend.title }}</span>
          <span class="context-sep">×</span>
          <span class="context-idea">{{ idea.title }}</span>
        </div>
        <dl class="context-idea-fields" data-test="context-idea-fields">
          <div v-if="idea.summary"><dt>内容摘要</dt><dd>{{ idea.summary }}</dd></div>
          <div v-if="idea.angle"><dt>切入角度</dt><dd>{{ idea.angle }}</dd></div>
          <div v-if="idea.brandFit"><dt>品牌结合方式</dt><dd>{{ idea.brandFit }}</dd></div>
          <div v-if="idea.audience"><dt>面向人群</dt><dd>{{ idea.audience }}</dd></div>
          <div v-if="idea.hook"><dt>开头钩子</dt><dd>{{ idea.hook }}</dd></div>
        </dl>

        <div class="generation-controls">
          <label class="form-field">
            <span>图片比例</span>
            <select v-model="aspectRatioSelection" name="aspectRatio" data-test="aspect-ratio-select">
              <option v-for="ratio in ASPECT_RATIO_OPTIONS" :key="ratio" :value="ratio">
                {{ ratio === "smart" ? `智能（朋友圈/组图/风格 ${SMART_ASPECT_RATIO_DEFAULTS.moments}，公众号 ${SMART_ASPECT_RATIO_DEFAULTS.wechat}）` : ratio }}
              </option>
            </select>
          </label>
          <label class="form-field">
            <span>小红书视觉路线</span>
            <select v-model="xhsStylePreset" name="xhsStyle" data-test="xhs-style-select">
              <option v-for="option in XHS_CREATIVE_STYLE_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="form-field">
            <span>公众号长图模板</span>
            <select v-model="wechatTemplate" name="wechatTemplate" data-test="wechat-template-select">
              <option v-for="option in WECHAT_TEMPLATE_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="logo-toggle">
            <input
              v-model="useBrandLogo"
              type="checkbox"
              name="useBrandLogo"
              data-test="use-brand-logo"
              :disabled="!brandHasLogo"
            />
            <span>{{ brandHasLogo ? `使用${logoLabel}作为视觉参考` : `未上传${logoLabel}` }}</span>
          </label>
          <div class="style-reference-field" data-test="style-reference-field">
            <label class="upload-button">
              <input
                type="file"
                accept="image/*"
                data-test="style-reference-input"
                @change="handleStyleReferenceChange"
              />
              <span>{{ styleReference ? "更换风格参考图" : "上传风格参考图" }}</span>
            </label>
            <span v-if="styleReference" class="style-reference-name" data-test="style-reference-name">
              {{ styleReference.fileName }}
            </span>
            <button
              v-if="styleReference"
              type="button"
              class="secondary-btn"
              data-test="style-reference-clear"
              @click="clearStyleReference"
            >
              清除
            </button>
            <span v-if="styleReferenceError" class="job-error" data-test="style-reference-error">{{ styleReferenceError }}</span>
          </div>
        </div>

        <ProductImagePanel
          v-model:selected-ids="selectedProductIds"
          :reload-token="productImagesReloadToken"
          @images-loaded="onProductImagesLoaded"
          @images-load-error="onProductImagesLoadError"
        />

        <div class="generation-actions">
          <button type="button" class="primary-btn" data-test="generate-moments" :disabled="busy || productLibraryBlocked" @click="startGenerationAction('moments')">
            AI 朋友圈图
          </button>
          <button type="button" class="primary-btn" data-test="generate-wechat" :disabled="busy || productLibraryBlocked" @click="startGenerationAction('wechat')">
            AI 公众号长图
          </button>
          <button type="button" class="primary-btn" data-test="generate-xhs" :disabled="busy || productLibraryBlocked" @click="startGenerationAction('xhsCarousel')">
            小红书组图
          </button>
          <button type="button" class="primary-btn" data-test="generate-style" :disabled="busy || productLibraryBlocked" @click="startGenerationAction('styleImage')">
            风格化图
          </button>
        </div>

        <p v-if="genStatus" class="job-status" data-test="gen-status">{{ genStatus }}</p>
        <p v-if="genError" class="job-error" data-test="gen-error">{{ genError }}</p>
        <div v-if="genError && genKind" class="generation-retry">
          <button type="button" class="secondary-btn" data-test="gen-retry" :disabled="busy || productLibraryBlocked" @click="retryGeneration">
            重试
          </button>
        </div>

        <!-- 朋友圈图结果 -->
        <div v-if="genKind === 'moments' && momentsResult" class="gen-result" data-test="moments-result">
          <h3>{{ momentsResult.title }}</h3>
          <p><strong>朋友圈文案：</strong>{{ momentsResult.caption || "" }}</p>
          <figure v-if="safeImageSrc(momentsResult.imageUrl || momentsResult.previewUrl)">
            <img :src="safeImageSrc(momentsResult.imageUrl || momentsResult.previewUrl)" :alt="String(momentsResult.title || '')" loading="lazy" decoding="async" />
          </figure>
          <div class="meta-item"><span>视觉方向</span><div>{{ momentsResult.visualDirection }}</div></div>
          <div class="meta-item"><span>风格</span><div>{{ momentsResult.style }}</div></div>
          <div class="meta-item"><span>构图建议</span><div>{{ momentsResult.composition }}</div></div>
        </div>

        <!-- 公众号长图结果 -->
        <div v-if="genKind === 'wechat' && wechatResult" class="gen-result" data-test="wechat-result">
          <h3>{{ wechatResult.title }}</h3>
          <p><strong>发布标题：</strong>{{ wechatResult.publishTitle }}</p>
          <p v-if="wechatResult.intro"><strong>文章导语：</strong>{{ wechatResult.intro }}</p>
          <ol v-if="wechatResult.outline?.length">
            <li v-for="(item, index) in wechatResult.outline" :key="index">{{ item }}</li>
          </ol>
          <figure v-if="safeImageSrc(wechatResult.imageUrl || wechatResult.previewUrl)">
            <img :src="safeImageSrc(wechatResult.imageUrl || wechatResult.previewUrl)" :alt="String(wechatResult.title || '')" loading="lazy" decoding="async" />
          </figure>
        </div>

        <!-- 风格化图结果 -->
        <div v-if="genKind === 'styleImage' && styleResult" class="gen-result" data-test="style-result">
          <h3>{{ styleResult.title || "风格化图片" }}</h3>
          <figure v-if="safeImageSrc(styleResult.imageUrl || styleResult.previewUrl)">
            <img :src="safeImageSrc(styleResult.imageUrl || styleResult.previewUrl)" :alt="String(styleResult.title || '风格化图片')" loading="lazy" decoding="async" />
          </figure>
        </div>

        <!-- 小红书组图 -->
        <div v-if="genKind === 'xhsCarousel' && carousel.pack" class="gen-result" data-test="xhs-result">
          <div class="carousel-head">
            <h3>{{ carousel.pack.title || "小红书组图" }}</h3>
            <button type="button" class="secondary-btn" data-test="generate-xhs-all" :disabled="busy" @click="generateAllCarouselSlides">
              一键生成全部
            </button>
          </div>
          <ul class="carousel-slides">
            <li v-for="(slide, index) in carousel.pack.slides" :key="index" class="carousel-slide" :data-test="`xhs-slide-${index}`">
              <div class="slide-head">
                <strong>{{ slide.pageLabel }}</strong>
                <button
                  v-if="!hasXhsCarouselSlideImage(slide)"
                  type="button"
                  class="secondary-btn"
                  :data-test="`generate-xhs-slide-${index}`"
                  :disabled="slide.isGenerating"
                  @click="generateCarouselSlide(index)"
                >
                  {{ slide.isGenerating ? "生成中..." : "生成本页" }}
                </button>
              </div>
              <p class="slide-direction">{{ slide.visualDirection }}</p>
              <label v-if="!hasXhsCarouselSlideImage(slide)" class="form-field">
                <span>本页提示词（可编辑，随生成请求提交）</span>
                <textarea
                  v-model="slide.prompt"
                  rows="2"
                  :data-test="`xhs-slide-prompt-${index}`"
                  placeholder="补充或修改本页画面提示词"
                ></textarea>
              </label>
              <figure v-if="safeImageSrc(slide.imageUrl || slide.previewUrl)">
                <img :src="safeImageSrc(slide.imageUrl || slide.previewUrl)" :alt="slide.pageLabel || ''" loading="lazy" decoding="async" />
              </figure>
              <div v-if="hasXhsCarouselSlideImage(slide)" class="slide-edit">
                <label class="form-field">
                  <span>继续改图提示词</span>
                  <textarea
                    v-model="slide.editPrompt"
                    rows="2"
                    :data-test="`xhs-slide-edit-prompt-${index}`"
                    placeholder="描述希望修改的内容"
                  ></textarea>
                </label>
                <button
                  type="button"
                  class="secondary-btn"
                  :data-test="`edit-xhs-slide-${index}`"
                  :disabled="slide.isEditing"
                  @click="editCarouselSlide(index)"
                >
                  {{ slide.isEditing ? "改图中..." : "改这一页" }}
                </button>
              </div>
              <p v-if="slide.error" class="job-error">{{ slide.error }}</p>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <!-- 无选题上下文：产品化任务概览，引导选择选题 -->
    <template v-else>
      <section class="no-context-overview" data-test="no-context-overview">
        <p class="context-hint" data-test="no-context-hint">
          从内容选题页选择选题后可生成朋友圈图/公众号长图/小红书组图/风格化图。
        </p>
        <div class="no-context-card">
          <h2>从内容选题开始</h2>
          <p class="no-context-copy">
            先在「内容选题」页为品牌或个人 IP 选择选题并配置产品图、Logo 与风格参考图，再回到这里一键生成。
          </p>
          <ul class="capability-list">
            <li><strong>朋友圈图</strong><span>1 积分/次</span><small>朋友圈分享主图与配套文案</small></li>
            <li><strong>公众号长图</strong><span>1 积分/次</span><small>发布标题、导语、结构与长图</small></li>
            <li><strong>小红书组图</strong><span>4 积分/次</span><small>4 张组图方案与单页改图</small></li>
            <li><strong>风格化图</strong><span>1 积分/次</span><small>以选题内容为提示的风格化图片</small></li>
          </ul>
          <button type="button" class="primary-btn" data-test="no-context-go-ideas" @click="goToIdeas">
            去内容选题页选择选题
          </button>
        </div>
      </section>
    </template>

    <!-- 公众号长图比例提醒 -->
    <div v-if="wechatConfirm" class="wechat-warning-backdrop" data-test="wechat-warning">
      <section class="wechat-warning-dialog" role="dialog" aria-modal="true">
        <h2>当前选择的是 {{ wechatConfirm.aspectRatio }}</h2>
        <p>公众号长图推荐使用 9:21。继续使用 {{ wechatConfirm.aspectRatio }} 可能影响长图的阅读体验和版式完整性。</p>
        <label class="wechat-warning-check"><input v-model="wechatDisableWarning" type="checkbox" /> <span>不再提醒</span></label>
        <div class="wechat-warning-actions">
          <button type="button" class="secondary-btn" data-test="wechat-warning-cancel" @click="resolveWechatConfirm(null)">取消</button>
          <button type="button" class="secondary-btn" data-test="wechat-warning-use-default" @click="resolveWechatConfirm('9:21')">改用 9:21</button>
          <button type="button" class="primary-btn" data-test="wechat-warning-continue" @click="resolveWechatConfirm(wechatConfirm.aspectRatio)">
            继续使用 {{ wechatConfirm.aspectRatio }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.generation-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
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

.idea-context {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.context-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 15px;
  font-weight: 600;
}

.context-sep {
  color: var(--color-text-secondary);
}

.context-idea-summary {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.generation-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.form-field input,
.form-field textarea,
.form-field select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 14px;
  font-family: inherit;
}

.logo-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.style-reference-field {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.style-reference-field .upload-button {
  position: relative;
  overflow: hidden;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  cursor: pointer;
}

.style-reference-field .upload-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.style-reference-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.slide-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.generation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.primary-btn {
  align-self: flex-start;
  background: var(--color-brand);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  padding: 10px 20px;
  font-size: 14px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: none;
  border-radius: var(--radius-md);
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}

.job-status,
.context-hint {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.job-error {
  color: var(--color-brand);
  font-size: 13px;
}

.gen-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.gen-result img {
  max-width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.meta-item {
  font-size: 13px;
}

.meta-item span {
  color: var(--color-text-secondary);
  margin-right: 6px;
}

.carousel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.carousel-slides {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.carousel-slide {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.slide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.slide-direction {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.wechat-warning-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.wechat-warning-dialog {
  background: var(--color-surface, #fff);
  border-radius: var(--radius-md);
  padding: 20px;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wechat-warning-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.wechat-warning-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* Legacy workspace visual parity: scoped final layer, business behavior unchanged. */
.generation-view {
  display: grid;
  max-width: none;
  gap: var(--workspace-grid-gap);
  color: var(--workspace-text);
}

.view-header {
  margin-bottom: 8px;
}

.view-header h1 {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 2.1rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.2;
}

.view-subtitle {
  max-width: 820px;
  margin: 10px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.65;
}

.idea-context,
.gen-result,
.context-hint {
  position: relative;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: var(--workspace-shadow-card);
}

.idea-context,
.gen-result {
  padding: 20px;
}

.idea-context::before,
.gen-result::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.idea-context {
  display: grid;
  gap: 18px;
}

.context-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--workspace-text);
  font-size: 1rem;
  font-weight: 800;
}

.context-brand,
.context-trend,
.context-idea {
  padding: 6px 10px;
  border-radius: var(--workspace-radius-pill);
  background: #f8eeeb;
  color: var(--workspace-brand-ink);
  font-size: 0.82rem;
}

.context-sep {
  color: var(--workspace-text-faint);
}

.context-idea-summary {
  margin: -6px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.9rem;
  line-height: 1.7;
}

.context-idea-fields {
  display: grid;
  gap: 0;
  margin: 0;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
  overflow: hidden;
}

.context-idea-fields > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--workspace-border);
}

.context-idea-fields > div:last-child {
  border-bottom: 0;
}

.context-idea-fields dt {
  color: var(--workspace-brand-ink);
  font-size: 0.8rem;
  font-weight: 800;
}

.context-idea-fields dd {
  margin: 0;
  color: var(--workspace-text-body);
  font-size: 0.86rem;
  line-height: 1.7;
}

.generation-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
}

.form-field {
  display: grid;
  min-width: 0;
  gap: 7px;
  color: var(--workspace-text-body);
  font-size: 0.82rem;
  font-weight: 800;
}

.form-field input,
.form-field textarea,
.form-field select {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--workspace-border-strong);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text);
  font: inherit;
  font-weight: 500;
  outline: none;
}

.form-field textarea {
  min-height: 92px;
  padding: 11px 12px;
  resize: vertical;
  line-height: 1.65;
}

.form-field input:focus,
.form-field textarea:focus,
.form-field select:focus {
  border-color: rgba(229, 72, 77, 0.48);
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.08);
}

.logo-toggle,
.style-reference-field {
  min-height: 42px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text-body);
  font-size: 0.82rem;
  font-weight: 700;
}

.style-reference-field .upload-button {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  padding: 0 13px;
  border: 1px solid var(--workspace-brand-border);
  border-radius: var(--workspace-radius-sm);
  background: var(--workspace-surface);
  color: var(--workspace-brand-ink);
  font-weight: 800;
}

.style-reference-name {
  max-width: 220px;
  color: var(--workspace-text-muted);
}

.generation-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.primary-btn,
.secondary-btn {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border-radius: var(--workspace-radius-sm);
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 800;
  cursor: pointer;
}

.primary-btn {
  align-self: auto;
  border: 1px solid var(--workspace-brand);
  background: var(--workspace-brand);
  color: #fff;
}

.primary-btn:hover:not(:disabled) {
  border-color: var(--workspace-brand-hover);
  background: var(--workspace-brand-hover);
}

.secondary-btn {
  border: 1px solid var(--workspace-brand-border);
  background: var(--workspace-surface);
  color: var(--workspace-text-body);
}

.primary-btn:disabled,
.secondary-btn:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.job-status,
.context-hint,
.job-error {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--workspace-radius);
  font-size: 0.84rem;
  line-height: 1.6;
}

.job-status,
.context-hint {
  border: 1px solid var(--workspace-border);
  background: rgba(255, 255, 255, 0.72);
  color: var(--workspace-text-muted);
}

.context-hint {
  min-height: 74px;
  display: flex;
  align-items: center;
}

.job-error {
  border: 1px solid rgba(180, 35, 24, 0.16);
  background: #fff1f1;
  color: #b42318;
}

.generation-retry {
  display: flex;
  justify-content: flex-end;
}

.no-context-overview {
  display: grid;
  gap: 14px;
}

.no-context-card {
  position: relative;
  display: grid;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: var(--workspace-shadow-card);
}

.no-context-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.no-context-card h2 {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.03em;
}

.no-context-copy {
  margin: 0;
  color: var(--workspace-text-muted);
  font-size: 0.9rem;
  line-height: 1.7;
}

.capability-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capability-list li {
  display: grid;
  gap: 4px;
  padding: 14px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
}

.capability-list strong {
  color: var(--workspace-text);
  font-size: 0.94rem;
}

.capability-list span {
  width: fit-content;
  padding: 2px 8px;
  border-radius: var(--workspace-radius-pill);
  background: #f8eeeb;
  color: var(--workspace-brand-ink);
  font-size: 0.72rem;
  font-weight: 800;
}

.capability-list small {
  color: var(--workspace-text-muted);
  font-size: 0.78rem;
  line-height: 1.55;
}

.gen-result {
  display: grid;
  gap: 14px;
}

.gen-result h3 {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.2rem;
}

.gen-result p,
.gen-result li,
.meta-item {
  color: var(--workspace-text-body);
  font-size: 0.86rem;
  line-height: 1.7;
}

.gen-result figure {
  margin: 0;
  padding: 12px;
}

.gen-result img {
  display: block;
  max-width: min(100%, 760px);
  max-height: 720px;
  margin: 0 auto;
  object-fit: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 6px;
  background: var(--workspace-surface-soft);
}

.meta-item {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
}

.meta-item span {
  color: var(--workspace-brand-ink);
  font-weight: 800;
}

.carousel-head,
.slide-head {
  gap: 14px;
}

.carousel-slides {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.carousel-slide {
  display: grid;
  min-width: 0;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
}

.slide-direction {
  color: var(--workspace-text-muted);
  font-size: 0.82rem;
  line-height: 1.65;
}

.slide-edit {
  display: grid;
  gap: 8px;
}

.wechat-warning-backdrop {
  padding: 28px;
  background: rgba(34, 24, 24, 0.14);
  backdrop-filter: blur(6px);
}

.wechat-warning-dialog {
  width: min(520px, 100%);
  max-width: none;
  padding: 28px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: var(--workspace-shadow-float);
}

.wechat-warning-dialog h2 {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.45rem;
}

.wechat-warning-dialog p {
  margin: 0;
  color: var(--workspace-text-muted);
  line-height: 1.7;
}

.wechat-warning-check {
  min-height: 40px;
  color: var(--workspace-text-body);
}

.wechat-warning-actions {
  flex-wrap: wrap;
  padding-top: 6px;
}

@media (max-width: 1100px) {
  .generation-controls,
  .generation-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .generation-controls,
  .generation-actions,
  .carousel-slides,
  .capability-list {
    grid-template-columns: 1fr;
  }

  .idea-context,
  .gen-result,
  .wechat-warning-dialog {
    padding: 18px;
  }
}
</style>
