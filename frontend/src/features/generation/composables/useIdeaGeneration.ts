import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useHistoryStore } from "@/features/history/stores/history";
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
  hasXhsCarouselSlideImage,
  refreshGenerationHistory,
  resolveAspectRatio,
  type BrandDetail,
  type CarouselPack,
  type IdeaDetail,
  type ImageConceptResult,
  type ProductImageInput,
  type ProductImageView,
  type TrendDetail,
  type WechatPack,
} from "../api";
import { useGenerationTasksStore } from "../stores/generationTasks";
import { runImageEdit } from "./useImageEdit";
import type { SessionUser } from "@/shared/types/api";

export type IdeaGenerationAction = "moments" | "wechat" | "xhsCarousel" | "styleImage";

export interface IdeaProductLibrary {
  images: Ref<ProductImageView[]>;
  loading: Ref<boolean>;
  loaded: Ref<boolean>;
  error: Ref<string>;
  reload: () => void;
}

export interface IdeaGenerationContext {
  brandId: ComputedRef<number | null>;
  trendId: ComputedRef<number | null>;
  ideaIndex: ComputedRef<number | null>;
  brand: Ref<BrandDetail | null>;
  trend: Ref<TrendDetail | null>;
  idea: Ref<IdeaDetail | null>;
  settingsKey: ComputedRef<string>;
  autoStartEnabled?: ComputedRef<boolean>;
  productLibrary?: IdeaProductLibrary;
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

export function useIdeaGeneration(context: IdeaGenerationContext) {
  const route = useRoute();
  const router = useRouter();
  const auth = useAuthStore();
  const historyStore = useHistoryStore();
  const tasksStore = useGenerationTasksStore();
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
  const deepLinkError = ref("");

  function invalidateDeepLinkTicket(): void {
    deepLinkError.value =
      "该生成链接已失效、无权访问或上下文不匹配，未执行任何扣费操作。请回到内容选题页重新选择后再生成。";
    const query = { ...route.query };
    delete query.action;
    void router.replace({ query }).catch(() => {});
  }

  function validateDeepLinkForAction(
    _action: IdeaGenerationAction,
  ): "valid" | "invalid" | "pending" {
    if (queryBrandId.value === null || queryTrendId.value === null || queryIdeaIndex.value === null) {
      return "invalid";
    }
    const brand = context.brand.value;
    const trend = context.trend.value;
    const idea = context.idea.value;
    if (!brand || !trend || !idea) return "pending";
    if (Number(brand.id) !== queryBrandId.value) return "invalid";
    if (Number(trend.id) !== queryTrendId.value) return "invalid";
    if (queryIdeaIndex.value !== context.ideaIndex.value) return "invalid";
    return "valid";
  }

  const ideaSettingsRestored = ref(false);
  const internalProductImagesLoaded = ref(false);
  const internalProductImagesError = ref("");
  const internalProductImagesReloadToken = ref(0);
  const externalLibrary = context.productLibrary || null;
  const productImagesLoaded = externalLibrary ? externalLibrary.loaded : internalProductImagesLoaded;
  const productImagesError = externalLibrary ? externalLibrary.error : internalProductImagesError;
  const productImagesReloadToken = internalProductImagesReloadToken;

  async function consumeActionTicket(): Promise<boolean> {
    deepLinkError.value = "";
    const query = { ...route.query };
    delete query.action;
    try {
      await router.replace({ query });
      return true;
    } catch (error) {
      contextError.value = `自动启动失败，请手动点击生成：${(error as Error).message}`;
      return false;
    }
  }

  async function maybeAutoStartGeneration(): Promise<void> {
    if (context.autoStartEnabled && !context.autoStartEnabled.value) return;
    const action = queryAction.value;
    if (!action) return;
    const verdict = validateDeepLinkForAction(action);
    if (verdict === "invalid") {
      invalidateDeepLinkTicket();
      return;
    }
    if (verdict === "pending") return;
    deepLinkError.value = "";
    if (!queryActionTargetsThisIdea.value) return;
    const actionKey = `${queryBrandId.value}:${queryTrendId.value}:${queryIdeaIndex.value}:${action}`;
    if (actionKey === startedActionKey.value) return;
    if (useProductImages.value) {
      if (productImagesError.value) return;
      if (!productImagesLoaded.value) return;
    }
    if (!context.brand.value || !context.trend.value || !context.idea.value || !ideaSettingsRestored.value) return;
    startedActionKey.value = actionKey;
    await startGenerationAction(action);
  }

  watch([productImagesLoaded, productImagesError, ideaSettingsRestored], () => {
    void maybeAutoStartGeneration();
  });

  watch(
    () => String(route.query.action ?? ""),
    () => {
      void maybeAutoStartGeneration();
    },
  );

  const aspectRatioSelection = ref("smart");
  const wechatTemplate = ref("auto");
  const xhsStylePreset = ref("auto");
  const useBrandLogo = ref(false);
  const useProductImages = ref(true);

  const selectedProductIds = ref<number[]>([]);
  const loadedProductImages = externalLibrary
    ? externalLibrary.images
    : ref<ProductImageView[]>([]);
  const styleReference = ref<StyleReferenceImage | null>(null);

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

  watch(context.settingsKey, () => {
    restoreIdeaSettings();
  });

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

  const selectedProductImageInputs = computed<ProductImageInput[]>(() =>
    useProductImages.value
      ? loadedProductImages.value
          .filter((image) => selectedProductIds.value.includes(image.id))
          .map((image) => ({ id: image.id, name: image.originalName }))
      : [],
  );

  const selectedStyleReferenceInputs = computed<Array<{ name?: string; dataUrl?: string }>>(() => {
    return styleReference.value
      ? [{ name: styleReference.value.fileName, dataUrl: styleReference.value.dataUrl }]
      : [];
  });

  function onProductImagesLoaded(images: ProductImageView[]) {
    if (externalLibrary) return;
    loadedProductImages.value = images;
    internalProductImagesLoaded.value = true;
    internalProductImagesError.value = "";
  }

  function onProductImagesLoadError(message: string) {
    if (externalLibrary) return;
    internalProductImagesLoaded.value = false;
    internalProductImagesError.value = message || "产品素材加载失败";
  }

  function retryProductImagesLoad(): void {
    if (externalLibrary) {
      externalLibrary.reload();
      return;
    }
    internalProductImagesReloadToken.value += 1;
  }

  const productLibraryBlocked = computed(
    () => useProductImages.value && (!productImagesLoaded.value || !!productImagesError.value),
  );

  const resolvedUseBrandLogo = computed(() => useBrandLogo.value && brandHasLogo.value);

  // —— Generation status/result state ——
  type GenKind = "moments" | "wechat" | "xhsCarousel" | "styleImage" | "";
  type GenPhase = "idle" | "running" | "done" | "error";
  const localPhase = ref<GenPhase>("idle");
  const genKind = ref<GenKind>("");
  const localStatus = ref("");
  const localError = ref("");
  const localMomentsResult = ref<ImageConceptResult | null>(null);
  const localWechatResult = ref<WechatPack | null>(null);
  const localStyleResult = ref<ImageConceptResult | null>(null);
  const localCarousel = ref<{ pack: CarouselPack | null; creditEventId: number | null; generationId: number | null }>({
    pack: null,
    creditEventId: null,
    generationId: null,
  });
  const contextLoading = ref(false);
  const contextError = ref("");

  const activeGlobalTask = computed(() => {
    const kind = genKind.value || queryAction.value;
    if (!kind || context.brandId.value == null || context.trendId.value == null || context.ideaIndex.value == null) {
      return undefined;
    }
    return tasksStore.findTask(
      kind as any,
      Number(context.brandId.value),
      Number(context.trendId.value),
      Number(context.ideaIndex.value),
    );
  });

  const genPhase = computed<GenPhase>(() => {
    const task = activeGlobalTask.value;
    if (!task) return localPhase.value;
    if (task.status === "submitting" || task.status === "polling") return "running";
    if (task.status === "completed") return "done";
    if (task.status === "failed") return "error";
    return localPhase.value;
  });

  const genStatus = computed<string>(() => {
    const task = activeGlobalTask.value;
    if (!task) return localStatus.value;
    if (task.status === "submitting" || task.status === "polling") {
      if (task.type === "moments") return "任务已进入队列，正在排队生成朋友圈图...";
      if (task.type === "wechat") return "任务已进入队列，正在排队生成公众号长图...";
      if (task.type === "styleImage") return "任务已进入队列，正在排队生成风格化图...";
      if (task.type === "xhsCarousel") return "组图方案已就绪，可单张或一键生成 4 张图。";
    }
    if (task.status === "completed") {
      if (task.type === "moments") return "朋友圈图已生成并写入历史生成。";
      if (task.type === "wechat") return "公众号长图已生成并写入历史生成。";
      if (task.type === "styleImage") return "风格化图已生成并写入历史生成。";
      if (task.type === "xhsCarousel") return "小红书组图已全部生成并写入历史生成。";
    }
    return localStatus.value;
  });

  const genError = computed<string>(() => {
    const task = activeGlobalTask.value;
    if (task?.status === "failed" && task.error) return task.error;
    return localError.value;
  });

  const momentsResult = computed<ImageConceptResult | null>(() => {
    const task = activeGlobalTask.value;
    if (task?.type === "moments" && task.status === "completed") {
      return {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        caption: task.copy?.caption,
        visualDirection: task.copy?.visualDirection,
        generationId: task.generationId ?? null,
      };
    }
    return localMomentsResult.value;
  });

  const wechatResult = computed<WechatPack | null>(() => {
    const task = activeGlobalTask.value;
    if (task?.type === "wechat" && task.status === "completed") {
      return {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        publishTitle: task.copy?.publishTitle || task.cardTitle,
        intro: task.copy?.intro,
        outline: task.copy?.outline,
        generationId: task.generationId ?? null,
      };
    }
    return localWechatResult.value;
  });

  const styleResult = computed<ImageConceptResult | null>(() => {
    const task = activeGlobalTask.value;
    if (task?.type === "styleImage" && task.status === "completed") {
      return {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        generationId: task.generationId ?? null,
      };
    }
    return localStyleResult.value;
  });

  const carousel = computed(() => {
    const task = activeGlobalTask.value;
    if (task?.type === "xhsCarousel" && task.carouselPack && task.slides) {
      for (let i = 0; i < task.slides.length; i++) {
        const s = task.slides[i] as any;
        s.isGenerating = s.status === "submitting" || s.status === "polling";
      }
      return {
        pack: { ...task.carouselPack, slides: task.slides as any },
        creditEventId: task.creditEventId ?? null,
        generationId: task.generationId ?? null,
      };
    }
    return localCarousel.value;
  });

  const busy = computed(
    () =>
      localPhase.value === "running" ||
      (activeGlobalTask.value !== undefined &&
        (activeGlobalTask.value.status === "submitting" || activeGlobalTask.value.status === "polling")),
  );

  async function startGenerationAction(action: IdeaGenerationAction): Promise<void> {
    if (productLibraryBlocked.value) {
      if (!productImagesError.value) {
        productImagesError.value = "产品素材尚未加载完成，请等待加载或点击「重新加载产品图」后再生成。";
      }
      return;
    }
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

  async function retryGeneration(): Promise<void> {
    if (busy.value || !genKind.value) return;
    await startGenerationAction(genKind.value as IdeaGenerationAction);
  }

  function startGeneration(kind: GenKind, status: string) {
    genKind.value = kind;
    localPhase.value = "running";
    localStatus.value = status;
    localError.value = "";
    localMomentsResult.value = null;
    localWechatResult.value = null;
    localStyleResult.value = null;
  }

  function currentContext(): { brand: BrandDetail; trend: TrendDetail; idea: IdeaDetail; ideaIndex: number } | null {
    if (!hasIdeaContext.value || !context.brand.value || !context.trend.value || !context.idea.value) return null;
    return {
      brand: context.brand.value,
      trend: context.trend.value,
      idea: context.idea.value,
      ideaIndex: context.ideaIndex.value as number,
    };
  }

  async function afterGenerationSuccess() {
    const signal = scope.signalFor("post-generation");
    try {
      await refreshGenerationHistory(signal);
      await historyStore.refresh({ signal });
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
    genKind.value = "moments";
    startGeneration("moments", "任务已进入队列，正在排队生成朋友圈图...");
    try {
      const task = await tasksStore.startMomentsTask({
        brand: genContext.brand,
        trend: genContext.trend,
        idea: genContext.idea,
        ideaIndex: genContext.ideaIndex,
        aspectRatio,
        productImages: selectedProductImageInputs.value,
        useBrandLogo: resolvedUseBrandLogo.value,
      });
      localMomentsResult.value = {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        caption: task.copy?.caption,
        visualDirection: task.copy?.visualDirection,
        generationId: task.generationId ?? null,
      };
      localPhase.value = "done";
    } catch (error) {
      if (isAbortError(error)) return;
      if (await handleUnauthorizedError(error)) return;
      localPhase.value = "error";
      localStatus.value = "";
      localError.value = `生图服务暂时不可用：${(error as Error).message}`;
    }
  }

  // —— b) AI 公众号长图 ——
  const wechatConfirm = ref<{ aspectRatio: string; resolve: (value: string | null) => void } | null>(null);
  const wechatDisableWarning = ref(false);

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
    genKind.value = "wechat";
    startGeneration("wechat", "任务已进入队列，正在排队生成公众号长图...");
    try {
      const task = await tasksStore.startWechatTask({
        brand: genContext.brand,
        trend: genContext.trend,
        idea: genContext.idea,
        ideaIndex: genContext.ideaIndex,
        aspectRatio,
        productImages: selectedProductImageInputs.value,
        useBrandLogo: resolvedUseBrandLogo.value,
        wechatTemplate: wechatTemplate.value,
      });
      localWechatResult.value = {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        publishTitle: task.copy?.publishTitle || task.cardTitle,
        intro: task.copy?.intro,
        outline: task.copy?.outline,
        generationId: task.generationId ?? null,
      };
      localPhase.value = "done";
    } catch (error) {
      if (isAbortError(error)) return;
      if (await handleUnauthorizedError(error)) return;
      localPhase.value = "error";
      localStatus.value = "";
      localError.value = `生图服务暂时不可用：${(error as Error).message}`;
    }
  }

  // —— c) 小红书组图 ——
  async function generateXhsCarousel() {
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "xhsCarousel");
    const signal = scope.signalFor("xhs-carousel");
    startGeneration("xhsCarousel", "任务已进入队列，正在准备小红书组图方案...");
    localCarousel.value = { pack: null, creditEventId: null, generationId: null };
    carouselCompleted.value = false;
    try {
      const task = await tasksStore.prepareXhsCarouselTask({
        brand: genContext.brand,
        trend: genContext.trend,
        idea: genContext.idea,
        ideaIndex: genContext.ideaIndex,
        aspectRatio,
        visualStylePreset: xhsStylePreset.value,
        signal,
      });
      if (task.carouselPack) {
        localCarousel.value = {
          pack: task.carouselPack,
          creditEventId: task.creditEventId ?? null,
          generationId: task.generationId ?? null,
        };
      }
      localPhase.value = "done";
      localStatus.value = "组图方案已就绪，可单张或一键生成 4 张图。";
    } catch (error) {
      if (isAbortError(error)) return;
      if (await handleUnauthorizedError(error)) return;
      localPhase.value = "error";
      localStatus.value = "";
      localError.value = `生成失败：${(error as Error).message}`;
    }
  }

  async function generateCarouselSlide(slideIndex: number) {
    const genContext = currentContext();
    const pack = carousel.value.pack;
    if (!genContext || !pack) return;
    const task = tasksStore.findTask("xhsCarousel", genContext.brand.id, genContext.trend.id, genContext.ideaIndex);
    if (!task) return;
    const slide = pack.slides[slideIndex];
    if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating) return;
    try {
      await tasksStore.generateCarouselSlide(task.id, slideIndex, {
        productImages: selectedProductImageInputs.value,
        useBrandLogo: resolvedUseBrandLogo.value,
        visualStylePreset: xhsStylePreset.value,
      });
    } catch (error) {
      if (isAbortError(error)) return;
    }
  }

  async function generateAllCarouselSlides() {
    const genContext = currentContext();
    const pack = carousel.value.pack;
    if (!genContext || !pack) return;
    const task = tasksStore.findTask("xhsCarousel", genContext.brand.id, genContext.trend.id, genContext.ideaIndex);
    if (!task) return;
    await tasksStore.generateAllCarouselSlides(task.id, {
      productImages: selectedProductImageInputs.value,
      useBrandLogo: resolvedUseBrandLogo.value,
      visualStylePreset: xhsStylePreset.value,
    });
  }

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
    const rawSlide = slide as Record<string, unknown>;
    try {
      const concept = await runImageEdit(
        {
          imageUrl,
          title: String(slide.title || slide.pageLabel || ""),
          aspectRatio: pack.aspectRatio,
          generationId: carousel.value.generationId,
          slideIndex,
          parentEditId: typeof rawSlide.lastEditId === "string" ? rawSlide.lastEditId : null,
        },
        prompt,
        { signal, onUser: applyUser },
      );
      slide.imageUrl = concept.imageUrl || concept.previewUrl;
      slide.previewUrl = concept.imageUrl || concept.previewUrl;
      slide.isEditing = false;
      slide.editPrompt = "";
      slide.error = "";
      rawSlide.lastEditId = concept.jobId || rawSlide.lastEditId;
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
        genContext.brand.id,
        genContext.trend.id,
        genContext.ideaIndex,
        { carouselPack: pack, creditEventId: carousel.value.creditEventId },
        signal,
      );
      applyUser(result.user);
      carouselCompleted.value = true;
      localStatus.value = "小红书组图已全部生成并写入历史生成。";
      await afterGenerationSuccess();
    } catch (error) {
      if (isAbortError(error)) return;
      if (await handleUnauthorizedError(error)) return;
      localError.value = `小红书组图写入历史失败：${(error as Error).message}`;
    }
  }

  // —— d) 风格化图 ——
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

  function clearStyleReference(): void {
    styleReference.value = null;
    styleReferenceError.value = "";
  }

  async function generateStyleImage() {
    const genContext = currentContext();
    if (busy.value || !genContext) return;
    const stylePrompt = buildIdeaStylePrompt(context.idea.value);
    if (!stylePrompt) {
      localPhase.value = "error";
      genKind.value = "styleImage";
      localStatus.value = "";
      localError.value = "请先在内容选题页补充内容摘要、切入角度等字段后再生成风格化图。";
      return;
    }
    const aspectRatio = resolveAspectRatio(aspectRatioSelection.value, "styleImage");
    genKind.value = "styleImage";
    startGeneration("styleImage", "任务已进入队列，正在排队生成风格化图...");
    try {
      const task = await tasksStore.startStyleImageTask({
        brand: genContext.brand,
        trend: genContext.trend,
        idea: genContext.idea,
        ideaIndex: genContext.ideaIndex,
        aspectRatio,
        stylePrompt,
        useBrandLogo: resolvedUseBrandLogo.value,
        styleReferenceImages: styleReference.value
          ? [{ name: styleReference.value.fileName, dataUrl: styleReference.value.dataUrl }]
          : [],
      });
      localStyleResult.value = {
        imageUrl: task.imageUrl || task.previewUrl,
        previewUrl: task.imageUrl || task.previewUrl,
        title: task.cardTitle,
        generationId: task.generationId ?? null,
      };
      localPhase.value = "done";
    } catch (error) {
      if (isAbortError(error)) return;
      if (await handleUnauthorizedError(error)) return;
      localPhase.value = "error";
      localStatus.value = "";
      localError.value = `生图服务暂时不可用：${(error as Error).message}`;
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
    deepLinkError,
    validateDeepLinkForAction,
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
    selectedStyleReferenceInputs,
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
