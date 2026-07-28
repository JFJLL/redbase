<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import ProductImagePanel from "../components/ProductImagePanel.vue";
import {
  IMAGE_ASPECT_RATIOS,
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

// —— Shared generation controls ——
const aspectRatioSelection = ref("smart");
const wechatTemplate = ref("auto");
const xhsStylePreset = ref("auto");
const useBrandLogo = ref(false);

const selectedProductIds = ref<number[]>([]);
const loadedProductImages = ref<ProductImageView[]>([]);

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

async function generateCarouselSlide(slideIndex: number) {
  const context = currentContext();
  const pack = carousel.pack;
  if (!context || !pack) return;
  const slide = pack.slides[slideIndex];
  if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating) return;
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
    const concept = await pollImageJob(result.slideJob.jobId, { signal, onUser: applyUser });
    pack.slides[slideIndex] = {
      ...pack.slides[slideIndex],
      imageUrl: concept.imageUrl || concept.previewUrl,
      previewUrl: concept.imageUrl || concept.previewUrl,
      isGenerating: false,
      isQueued: false,
      error: "",
    };
    await maybeCompleteCarousel();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    slide.isGenerating = false;
    slide.error = `生成失败：${(error as Error).message}`;
  }
}

async function generateAllCarouselSlides() {
  const pack = carousel.pack;
  if (!pack) return;
  for (let index = 0; index < pack.slides.length; index += 1) {
    if (!hasXhsCarouselSlideImage(pack.slides[index])) {
      await generateCarouselSlide(index);
    }
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

// —— d) 风格化图 ——
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
        styleReferenceImages: [],
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
              <figure v-if="safeImageSrc(slide.imageUrl || slide.previewUrl)">
                <img :src="safeImageSrc(slide.imageUrl || slide.previewUrl)" :alt="slide.pageLabel || ''" loading="lazy" decoding="async" />
              </figure>
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
</style>
