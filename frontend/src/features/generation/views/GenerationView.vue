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

// 生图任务：独立改图（第一轮） + 选题驱动的四类生图（本轮补齐）。
// 有 route query（brandId/trendId/ideaIndex）时加载品牌详情并暴露四类生成动作，
// 无上下文时保持第一轮的独立改图表单。所有请求走 @/shared/api/client，
// signal 由 useAbortScope 提供，卸载/退出登录时轮询自动停止。
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
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    contextError.value = `加载品牌详情失败：${(error as Error).message}`;
  } finally {
    contextLoading.value = false;
  }
}

onMounted(loadBrandContext);

// —— Shared generation controls（按 品牌ID:趋势ID:选题序号 键位独立记忆，旧版按选题记忆语义） ——
const aspectRatioSelection = ref("smart");
const wechatTemplate = ref("auto");
const xhsStylePreset = ref("auto");
const useBrandLogo = ref(false);

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
  selectedProductIds.value = [...settings.selectedProductIds];
  styleReference.value = settings.styleReference;
}

restoreIdeaSettings();

// 切换选题：重载上下文并恢复目标选题自己的设置，不得串值。
watch(ideaSettingsKey, () => {
  restoreIdeaSettings();
  void loadBrandContext();
});

// 设置变化即写回当前选题键位（会话内生效）。
watch(
  [aspectRatioSelection, xhsStylePreset, wechatTemplate, useBrandLogo, selectedProductIds, styleReference],
  () => {
    saveIdeaCreativeSettings(ideaSettingsKey.value, {
      aspectRatioSelection: aspectRatioSelection.value,
      visualStylePreset: xhsStylePreset.value,
      wechatTemplate: wechatTemplate.value,
      useBrandLogo: useBrandLogo.value,
      selectedProductIds: selectedProductIds.value,
      styleReference: styleReference.value,
    });
  },
  { deep: true },
);

// getSelectedProductImages semantics: library images submit as { id, name }.
const selectedProductImageInputs = computed<ProductImageInput[]>(() =>
  loadedProductImages.value
    .filter((image) => selectedProductIds.value.includes(image.id))
    .map((image) => ({ id: image.id, name: image.originalName })),
);

function onProductImagesLoaded(images: ProductImageView[]) {
  loadedProductImages.value = images;
}

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
  startGeneration("moments", "AI 正在生成朋友圈图...");
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
  startGeneration("wechat", "AI 正在生成公众号长图方案...");
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
  startGeneration("xhsCarousel", "正在准备小红书组图方案...");
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
  startGeneration("styleImage", "AI 正在生成风格化图...");
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

// —— Standalone image edit (round 1, preserved for no-context sessions) ——
const form = reactive({
  imageUrl: "",
  prompt: "",
  title: "",
  aspectRatio: "",
});

type JobPhase = "idle" | "submitting" | "polling" | "done" | "error";
const phase = ref<JobPhase>("idle");
const statusMessage = ref("");
const errorMessage = ref("");
const jobId = ref("");
const result = ref<ImageConceptResult | null>(null);

const editBusy = computed(() => phase.value === "submitting" || phase.value === "polling");

async function submit() {
  if (editBusy.value) return;
  errorMessage.value = "";
  const prompt = form.prompt.trim();
  if (!prompt) {
    errorMessage.value = "请先填写改图提示词。";
    return;
  }
  const signal = scope.signalFor("image-edit");
  phase.value = "submitting";
  statusMessage.value = "改图任务已提交，正在等待结果...";
  result.value = null;
  try {
    const submitResult = await submitImageEdit(
      {
        imageUrl: form.imageUrl.trim(),
        prompt,
        title: form.title.trim(),
        aspectRatio: form.aspectRatio || undefined,
      },
      signal,
    );
    if (submitResult.user) auth.user = submitResult.user;
    if (!submitResult.jobId) throw new Error("改图任务创建失败");
    jobId.value = submitResult.jobId;
    phase.value = "polling";
    const concept = await pollImageJob(submitResult.jobId, {
      signal,
      onUser: (user) => {
        auth.user = user;
      },
    });
    result.value = concept;
    phase.value = "done";
    statusMessage.value = "改图完成，可继续追加提示词。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    phase.value = "error";
    statusMessage.value = "";
    errorMessage.value = `改图失败：${(error as Error).message}`;
  }
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

      <div v-if="brand && trend && idea" class="idea-context" data-test="idea-context">
        <div class="context-summary">
          <span class="context-brand">{{ brand.name }}</span>
          <span class="context-sep">×</span>
          <span class="context-trend">{{ trend.title }}</span>
          <span class="context-sep">×</span>
          <span class="context-idea">{{ idea.title }}</span>
        </div>
        <p v-if="idea.summary" class="context-idea-summary">{{ idea.summary }}</p>

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
          @images-loaded="onProductImagesLoaded"
        />

        <div class="generation-actions">
          <button type="button" class="primary-btn" data-test="generate-moments" :disabled="busy" @click="generateMomentsImage">
            AI 朋友圈图
          </button>
          <button type="button" class="primary-btn" data-test="generate-wechat" :disabled="busy" @click="generateWechatLongImage">
            AI 公众号长图
          </button>
          <button type="button" class="primary-btn" data-test="generate-xhs" :disabled="busy" @click="generateXhsCarousel">
            小红书组图
          </button>
          <button type="button" class="primary-btn" data-test="generate-style" :disabled="busy" @click="generateStyleImage">
            风格化图
          </button>
        </div>

        <p v-if="genStatus" class="job-status" data-test="gen-status">{{ genStatus }}</p>
        <p v-if="genError" class="job-error" data-test="gen-error">{{ genError }}</p>

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

    <!-- 无选题上下文：独立改图表单 -->
    <template v-else>
      <p class="context-hint" data-test="no-context-hint">
        从内容选题页选择选题后可生成朋友圈图/公众号长图/小红书组图/风格化图。
      </p>

      <form class="generation-form" @submit.prevent="submit">
        <label class="form-field">
          <span>原图地址</span>
          <input v-model="form.imageUrl" type="text" name="imageUrl" placeholder="/api/generated-images/... 或历史图片地址" />
        </label>
        <label class="form-field">
          <span>改图提示词</span>
          <textarea v-model="form.prompt" name="prompt" rows="3" placeholder="描述希望修改的内容"></textarea>
        </label>
        <label class="form-field">
          <span>标题（可选）</span>
          <input v-model="form.title" type="text" name="title" />
        </label>
        <label class="form-field">
          <span>宽高比（可选）</span>
          <select v-model="form.aspectRatio" name="aspectRatio">
            <option value="">默认</option>
            <option v-for="ratio in IMAGE_ASPECT_RATIOS" :key="ratio" :value="ratio">{{ ratio }}</option>
          </select>
        </label>
        <button type="submit" class="primary-btn" :disabled="editBusy">
          {{ editBusy ? "任务进行中..." : "提交改图任务" }}
        </button>
      </form>

      <p v-if="statusMessage" class="job-status" data-test="job-status">{{ statusMessage }}</p>
      <p v-if="errorMessage" class="job-error" data-test="job-error">{{ errorMessage }}</p>

      <figure v-if="result && (result.imageUrl || result.previewUrl)" class="job-result">
        <img :src="String(result.imageUrl || result.previewUrl)" alt="改图结果" loading="lazy" decoding="async" />
        <figcaption v-if="result.generationId || result.persisted">已保存至历史生成</figcaption>
      </figure>
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

.generation-form {
  display: flex;
  flex-direction: column;
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

.gen-result img,
.job-result img {
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

.job-result figcaption {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 4px;
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
.generation-form,
.gen-result,
.job-result,
.context-hint {
  position: relative;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: var(--workspace-shadow-card);
}

.idea-context,
.generation-form,
.gen-result {
  padding: 20px;
}

.idea-context::before,
.generation-form::before,
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

.gen-result figure,
.job-result {
  margin: 0;
  padding: 12px;
}

.gen-result img,
.job-result img {
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

.job-result figcaption {
  margin-top: 8px;
  color: var(--workspace-text-muted);
  font-size: 0.78rem;
  text-align: center;
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
  .carousel-slides {
    grid-template-columns: 1fr;
  }

  .idea-context,
  .generation-form,
  .gen-result,
  .wechat-warning-dialog {
    padding: 18px;
  }
}
</style>
