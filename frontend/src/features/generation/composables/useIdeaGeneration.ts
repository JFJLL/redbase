import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import {
  getIdeaCreativeSettings,
  saveIdeaCreativeSettings,
  type StyleReferenceImage,
} from "../ideaCreativeSettings";
import {
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY,
  buildIdeaStylePrompt,
  completeXhsCarousel,
  createXhsCarouselGroupId,
  enrichXhsCarouselSlides,
  hasXhsCarouselSlideImage,
  pollImageJob,
  previewXhsCarousel,
  refreshGenerationHistory,
  resolveAspectRatio,
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

export type IdeaGenerationAction = "moments" | "wechat" | "xhsCarousel" | "styleImage";

export interface IdeaGenerationContext {
  /** 品牌/趋势/选题定位（宿主提供：独立生图页来自 route query，内容选题对话框来自 store 选中态）。 */
  brandId: ComputedRef<number | null>;
  trendId: ComputedRef<number | null>;
  ideaIndex: ComputedRef<number | null>;
  /** 已加载的上下文对象（含 Logo、选题字段，用于请求体与风格化图提示词）。 */
  brand: Ref<BrandDetail | null>;
  trend: Ref<TrendDetail | null>;
  idea: Ref<IdeaDetail | null>;
  /** 创作设置键位（品牌ID:趋势ID:选题序号）。 */
  settingsKey: ComputedRef<string>;
  /** 自动启动允许开关：对话框只在打开且 query action 指向本选题时自动启动。 */
  autoStartEnabled?: ComputedRef<boolean>;
}

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

/**
 * 选题驱动的四类生图状态机（朋友圈图/公众号长图/小红书组图/风格化图）。
 * 由 GenerationView（独立兼容页）与 IdeaGenerationDialog（内容选题内）共用，
 * 保证自动/手动/失败重试走同一条「一次性 action 票据 + 素材门控 + 积分幂等」路径。
 * 所有请求走 @/shared/api/client，signal 由 useAbortScope 提供，卸载/退出登录时轮询自动停止。
 */
export function useIdeaGeneration(context: IdeaGenerationContext) {
  const route = useRoute();
  const router = useRouter();
  const auth = useAuthStore();
  const scope = useAbortScope();

  const queryBrandId = computed(() => parsePositiveInt(route.query.brandId));
  const queryTrendId = computed(() => parsePositiveInt(route.query.trendId));
  const queryIdeaIndex = computed(() => parseIndex(route.query.ideaIndex));
  const queryAction = computed<IdeaGenerationAction | null>(() => {
    const raw = Array.isArray(route.query.action) ? route.query.action[0] : route.query.action;
    return raw === "moments" || raw === "wechat" || raw === "xhsCarousel" || raw === "styleImage" ? raw : null;
  });
  const hasIdeaContext = computed(
    () => context.brandId.value !== null && context.trendId.value !== null && context.ideaIndex.value !== null,
  );
  const queryActionTargetsThisIdea = computed(
    () =>
      queryAction.value !== null &&
      queryIdeaIndex.value !== null &&
      context.ideaIndex.value !== null &&
      queryIdeaIndex.value === context.ideaIndex.value,
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

  const brandHasLogo = computed(() => Boolean(context.brand.value?.logo));
  const logoLabel = computed(() =>
    context.brand.value?.profileType === "personal" ? "个人头像" : "品牌 Logo",
  );

  const startedActionKey = ref("");

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
    if (context.autoStartEnabled && !context.autoStartEnabled.value) return;
    const action = queryAction.value;
    if (!action) return;
    if (!queryActionTargetsThisIdea.value) return;
    const actionKey = `${queryBrandId.value}:${queryTrendId.value}:${queryIdeaIndex.value}:${action}`;
    if (actionKey === startedActionKey.value) return;
    // 图库门控：用户开启产品图时必须图库已加载且无错误（失败时 product-images-error
    // 区块展示可恢复错误，绝不静默以空数组自动生成）；明确关闭产品图时不等待图库，
    // 空 productImages 是合法语义（手动/重试入口由共享防线统一约束）。
    if (useProductImages.value) {
      if (productImagesError.value) return;
      if (!productImagesLoaded.value) return;
    }
    if (!context.brand.value || !context.trend.value || !context.idea.value || !ideaSettingsRestored.value) return;
    // 纵深防御：先落 startedActionKey 再消费票据；即便 replace 抛错或本次生成失败，
    // 也不会再次自动提交（失败由用户点「重试」手动恢复）。
    startedActionKey.value = actionKey;
    await startGenerationAction(action);
  }

  // 图库加载完成/失败、创作设置恢复等就绪状态变化时复查自动启动条件。
  watch([productImagesLoaded, productImagesError, ideaSettingsRestored], () => {
    void maybeAutoStartGeneration();
  });

  // 内容选题内点击按钮后，action 票据随 router.push 异步到达 URL；
  // 到达时复查自动启动（startedActionKey 保证同键位至多启动一次）。
  watch(
    () => String(route.query.action ?? ""),
    () => {
      void maybeAutoStartGeneration();
    },
  );

  // —— Shared generation controls（按 品牌ID:趋势ID:选题序号 键位独立记忆，旧版按选题记忆语义） ——
  const aspectRatioSelection = ref("smart");
  const wechatTemplate = ref("auto");
  const xhsStylePreset = ref("auto");
  const useBrandLogo = ref(false);
  const useProductImages = ref(true);

  const selectedProductIds = ref<number[]>([]);
  const loadedProductImages = ref<ProductImageView[]>([]);
  const styleReference = ref<StyleReferenceImage | null>(null);

  /** 进入选题时恢复该选题自己的创作设置（getIdea*Selection 语义）。 */
  function restoreIdeaSettings(): void {
    const settings = getIdeaCreativeSettings(context.settingsKey.value);
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

  // 切换选题：恢复目标选题自己的设置，不得串值。
  watch(context.settingsKey, () => {
    restoreIdeaSettings();
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
      saveIdeaCreativeSettings(context.settingsKey.value, {
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
  const contextLoading = ref(false);
  const contextError = ref("");

  const busy = computed(() => genPhase.value === "running");

  async function startGenerationAction(action: IdeaGenerationAction): Promise<void> {
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
    await startGenerationAction(genKind.value as IdeaGenerationAction);
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
    if (!hasIdeaContext.value || !context.trend.value || !context.idea.value) return null;
    return {
      brandId: context.brandId.value as number,
      trendId: context.trendId.value as number,
      ideaIndex: context.ideaIndex.value as number,
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
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "moments");
    const signal = scope.signalFor("moments");
    startGeneration("moments", "任务已进入队列，正在排队生成朋友圈图...");
    try {
      const submitResult = await submitMomentsImage(
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
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
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const aspectRatio = await confirmWechatAspectRatio(resolveAspectRatio(aspectRatioSelection.value, "wechat"));
    if (!aspectRatio) return;
    const signal = scope.signalFor("wechat");
    startGeneration("wechat", "任务已进入队列，正在排队生成公众号长图...");
    try {
      const submitResult = await submitWechatLongImage(
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
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
  const carousel = ref<{ pack: CarouselPack | null; creditEventId: number | null }>({
    pack: null,
    creditEventId: null,
  });

  async function generateXhsCarousel() {
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "xhsCarousel");
    const signal = scope.signalFor("xhs-carousel");
    startGeneration("xhsCarousel", "任务已进入队列，正在准备小红书组图方案...");
    carousel.value = { pack: null, creditEventId: null };
    carouselCompleted.value = false;
    try {
      const previewResult = await previewXhsCarousel(
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
        { aspectRatio, visualStylePreset: xhsStylePreset.value },
        signal,
      );
      applyUser(previewResult.user);
      const previewPack = previewResult.carouselPack;
      if (!previewPack || !Array.isArray(previewPack.slides)) {
        throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
      }
      carousel.value = {
        pack: {
          ...previewPack,
          aspectRatio,
          carouselGroupId:
            previewPack.carouselGroupId ||
            createXhsCarouselGroupId(genContext.brandId, genContext.trendId, genContext.ideaIndex),
          slides: enrichXhsCarouselSlides({ ...previewPack, aspectRatio }),
        },
        creditEventId: null,
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
    const genContext = currentContext();
    const pack = carousel.value.pack;
    if (!genContext || !pack) return null;
    const slide = pack.slides[slideIndex];
    if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating) return null;
    const aspectRatio = pack.aspectRatio || resolveAspectRatio(aspectRatioSelection.value, "xhsCarousel");
    const signal = scope.signalFor(`xhs-slide-${slideIndex}`);
    slide.isGenerating = true;
    slide.error = "";
    try {
      const result = await submitXhsCarouselSlide(
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
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
      carousel.value.creditEventId = result.creditEventId ?? carousel.value.creditEventId;
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
    const pack = carousel.value.pack;
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
    const pack = carousel.value.pack;
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
    const pack = carousel.value.pack;
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
    const genContext = currentContext();
    const pack = carousel.value.pack;
    if (!genContext || !pack || carouselCompleted.value) return;
    if (!pack.slides.every(hasXhsCarouselSlideImage)) return;
    const signal = scope.signalFor("xhs-complete");
    try {
      const result = await completeXhsCarousel(
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
        { carouselPack: pack, creditEventId: carousel.value.creditEventId },
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
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const stylePrompt = buildIdeaStylePrompt(context.idea.value);
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
        genContext.brandId,
        genContext.trendId,
        genContext.ideaIndex,
        {
          title: context.idea.value?.title || "风格化图片",
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

  return {
    route,
    router,
    auth,
    scope,
    queryBrandId,
    queryTrendId,
    queryIdeaIndex,
    queryAction,
    hasIdeaContext,
    brandHasLogo,
    logoLabel,
    startedActionKey,
    ideaSettingsRestored,
    productImagesLoaded,
    productImagesError,
    productImagesReloadToken,
    consumeActionTicket,
    maybeAutoStartGeneration,
    aspectRatioSelection,
    wechatTemplate,
    xhsStylePreset,
    useBrandLogo,
    useProductImages,
    selectedProductIds,
    loadedProductImages,
    styleReference,
    restoreIdeaSettings,
    selectedProductImageInputs,
    onProductImagesLoaded,
    onProductImagesLoadError,
    retryProductImagesLoad,
    productLibraryBlocked,
    resolvedUseBrandLogo,
    genPhase,
    genKind,
    genStatus,
    genError,
    momentsResult,
    wechatResult,
    styleResult,
    contextLoading,
    contextError,
    busy,
    startGenerationAction,
    retryGeneration,
    startGeneration,
    currentContext,
    afterGenerationSuccess,
    wechatConfirm,
    wechatDisableWarning,
    confirmWechatAspectRatio,
    resolveWechatConfirm,
    carousel,
    generateXhsCarousel,
    submitCarouselSlideRequest,
    pollCarouselSlideJob,
    generateCarouselSlide,
    generateAllCarouselSlides,
    editCarouselSlide,
    carouselCompleted,
    maybeCompleteCarousel,
    styleReferenceError,
    handleStyleReferenceChange,
    clearStyleReference,
    generateStyleImage,
    applyUser,
    handleUnauthorizedError,
  };
}
