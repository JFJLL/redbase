<script setup lang="ts">
// 内容选题页。迁移自旧前端 public/index.html data-tab-panel="ideas" 与
// public/app.js 的 renderIdeas / renderIdeaContent / renderIdeaContentAssets /
// bindIdeaPromptActions / data-idea-edit-form 提交逻辑。
// 对照图4：选题上下文卡（绿点 + 标签组）、自定义补充提示词卡、桌面双列选题卡，
// 每卡带品牌 Logo 开关 / 产品图参考 / 风格图参考 / 折叠创作设置，底部三个生图按钮
// （一键朋友圈图 1积分、一键公众号长图 1积分、一键小红书组图 4积分）跳转生图任务页。
// 生图动作与按钮一律携带 brandId/trendId/ideaIndex（+action）上下文，刷新/返回不丢。
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch, isAbortError } from "@/shared/api/client";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { regenerateTrendIdeas, updateTrendIdea } from "@/features/trends/api/insightsApi";
import { useInsightsStore } from "@/features/trends/stores/insights";
import { useUnauthorizedHandler } from "@/features/trends/composables/useUnauthorizedHandler";
import type { InsightsBrand, TrendIdea } from "@/features/trends/model/types";
import {
  IMAGE_ASPECT_RATIOS,
  MAX_SELECTED_PRODUCT_IMAGES,
  MAX_SELECTED_PRODUCT_IMAGE_BYTES,
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  WECHAT_TEMPLATE_OPTIONS,
  XHS_CREATIVE_STYLE_OPTIONS,
  deleteProductImage,
  fetchProductImages,
  uploadProductImage,
  type ProductImageView,
} from "@/features/generation/api";
import {
  countProductImageReferences,
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  removeProductImageFromAllSettings,
  saveIdeaCreativeSettings,
  type IdeaCreativeSettings,
} from "@/features/generation/ideaCreativeSettings";
import IdeaGenerationDialog from "@/features/generation/components/IdeaGenerationDialog.vue";
import type { IdeaProductLibrary } from "@/features/generation/composables/useIdeaGeneration";
import { useImageJobRecovery } from "@/features/generation/composables/useImageJobRecovery";

type GenerationAction = "moments" | "wechat" | "xhsCarousel" | "styleImage";

interface IdeaDraft {
  title: string;
  summary: string;
  angle: string;
  brandFit: string;
  audience: string;
  hook: string;
}

const store = useInsightsStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const scope = useAbortScope();
const handleUnauthorized = useUnauthorizedHandler();

const brand = computed(() => store.selectedBrand);
const trend = computed(() => store.selectedTrend);
const isPersonal = computed(() => brand.value?.profileType === "personal");

const loadError = ref("");
const deepLinkError = ref("");
const customPrompt = ref("");
const promptMeta = ref("当前使用默认系统提示词生成。");
const regenerating = ref(false);
const editingDrafts = reactive<Record<number, IdeaDraft>>({});
const editErrors = reactive<Record<number, string>>({});

// —— 每选题素材与创作设置（按键位 品牌ID:趋势ID:选题序号 记忆，与生图任务页共享） ——
const libraryImages = ref<ProductImageView[]>([]);
const libraryLoading = ref(false);
const libraryLoaded = ref(false);
const libraryError = ref("");
const openLibraryFor = ref<number | null>(null);
const pendingDeleteImage = ref<ProductImageView | null>(null);
const libraryDeleting = ref(false);
const libraryMessage = ref("");
const uploadingProduct = ref<number | null>(null);
const uploadingLogo = ref(false);
const productMessages = reactive<Record<number, string>>({});
const styleErrors = reactive<Record<number, string>>({});
const logoErrors = reactive<Record<number, string>>({});
const openCreativeSettings = reactive<Record<number, boolean>>({});
// 创作设置展示版本：生成对话框/比例网格写回设置后 +1，强制摘要与选中态刷新。
const settingsVersion = ref(0);
const activeGeneration = ref<{ ideaIndex: number; action: GenerationAction } | null>(null);

const assetLabel = computed(() => (isPersonal.value ? "内容参考图" : "产品图"));
const logoLabel = computed(() => (isPersonal.value ? "个人头像" : "品牌 Logo"));

function ideaKey(index: number): string {
  return getIdeaSettingsKey(brand.value?.id, trend.value?.id, index);
}

function settingsFor(index: number): IdeaCreativeSettings {
  return getIdeaCreativeSettings(ideaKey(index));
}

function patchSettings(index: number, patch: Partial<IdeaCreativeSettings>): void {
  const key = ideaKey(index);
  saveIdeaCreativeSettings(key, { ...getIdeaCreativeSettings(key), ...patch });
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatImageName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

async function loadProductLibrary(): Promise<void> {
  libraryLoading.value = true;
  libraryLoaded.value = false;
  libraryError.value = "";
  try {
    const result = await fetchProductImages(scope.signalFor("product-library"));
    libraryImages.value = result.images || [];
    libraryLoaded.value = true;
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    libraryError.value = `产品素材加载失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    libraryLoading.value = false;
  }
}

function selectedProductImages(index: number): ProductImageView[] {
  const ids = settingsFor(index).selectedProductIds;
  return libraryImages.value.filter((image) => ids.includes(image.id));
}

function selectedProductNames(index: number): string {
  const names = selectedProductImages(index).map((image) => image.originalName || "产品图");
  return names.join("、");
}

function selectedProductBytes(index: number): number {
  return selectedProductImages(index).reduce((total, image) => total + Number(image.sizeBytes || 0), 0);
}

function isProductSelected(index: number, imageId: number): boolean {
  return settingsFor(index).selectedProductIds.includes(imageId);
}

function toggleLibraryImage(index: number, imageId: number, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  const current = settingsFor(index);
  if (!checked) {
    patchSettings(index, { selectedProductIds: current.selectedProductIds.filter((id) => id !== imageId) });
    return;
  }
  if (current.selectedProductIds.includes(imageId)) return;
  if (current.selectedProductIds.length >= MAX_SELECTED_PRODUCT_IMAGES) {
    productMessages[index] = `产品参考图最多选择 ${MAX_SELECTED_PRODUCT_IMAGES} 张。`;
    return;
  }
  patchSettings(index, { selectedProductIds: [...current.selectedProductIds, imageId] });
}

async function handleProductUpload(index: number, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || uploadingProduct.value !== null) return;
  const oversized = files.find((file) => file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES);
  if (oversized) {
    productMessages[index] = `单张${assetLabel.value}最多上传 10MB。${oversized.name} 过大，请压缩图片后重新上传。`;
    return;
  }
  uploadingProduct.value = index;
  productMessages[index] = "";
  try {
    for (const file of files) {
      const signal = scope.signalFor(`product-upload:${index}:${file.name}`);
      const dataUrl = await fileToDataUrl(file, signal);
      if (signal.aborted) return;
      const result = await uploadProductImage({ name: file.name, dataUrl }, signal);
      if (!result.image) continue;
      libraryImages.value = [result.image, ...libraryImages.value.filter((item) => item.id !== result.image!.id)];
      const current = settingsFor(index);
      if (
        !current.selectedProductIds.includes(result.image.id) &&
        current.selectedProductIds.length < MAX_SELECTED_PRODUCT_IMAGES
      ) {
        patchSettings(index, { selectedProductIds: [...current.selectedProductIds, result.image.id] });
      }
      if (result.duplicate) productMessages[index] = "该图片已在素材库中";
    }
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    productMessages[index] = `产品图上传失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    uploadingProduct.value = null;
  }
}

function clearProductSelection(index: number): void {
  patchSettings(index, { selectedProductIds: [] });
}

function toggleUseProductImages(index: number, event: Event): void {
  patchSettings(index, { useProductImages: (event.target as HTMLInputElement).checked });
}

function toggleLogo(index: number, event: Event): void {
  patchSettings(index, { useBrandLogo: (event.target as HTMLInputElement).checked });
}

async function handleLogoUpload(index: number, event: Event): Promise<void> {
  const currentBrand = brand.value;
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !currentBrand || uploadingLogo.value) return;
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    logoErrors[index] = `${logoLabel.value}最多上传 10MB，请压缩图片后重新上传。`;
    return;
  }
  uploadingLogo.value = true;
  logoErrors[index] = "";
  try {
    const signal = scope.signalFor("logo-upload");
    const dataUrl = await fileToDataUrl(file, signal);
    if (signal.aborted) return;
    const result = await apiFetch<{ brand: InsightsBrand }>(`/api/brands/${currentBrand.id}/logo`, {
      method: "POST",
      body: { logoName: file.name, logoDataUrl: dataUrl },
      signal,
    });
    store.replaceBrand(result.brand);
    patchSettings(index, { useBrandLogo: Boolean(result.brand.logo) });
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    logoErrors[index] = `${logoLabel.value}上传失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    uploadingLogo.value = false;
  }
}

async function handleStyleUpload(index: number, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    styleErrors[index] = "风格参考图最多上传 10MB，请压缩图片后重新上传。";
    return;
  }
  try {
    const signal = scope.signalFor(`style-upload:${index}`);
    const dataUrl = await fileToDataUrl(file, signal);
    if (signal.aborted) return;
    patchSettings(index, { styleReference: { fileName: file.name, dataUrl, sizeBytes: file.size } });
    styleErrors[index] = "";
  } catch (error) {
    if (isAbortError(error)) return;
    styleErrors[index] = `风格参考图读取失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

function clearStyleReference(index: number): void {
  patchSettings(index, { styleReference: null });
}

function toggleCreativeSettings(index: number): void {
  openCreativeSettings[index] = !openCreativeSettings[index];
}

function updateCreativeSetting(
  index: number,
  field: "visualStylePreset" | "wechatTemplate" | "aspectRatioSelection",
  event: Event,
): void {
  const value = (event.target as HTMLSelectElement).value;
  patchSettings(index, { [field]: value } as Partial<IdeaCreativeSettings>);
}

function selectRatio(index: number, ratio: string): void {
  patchSettings(index, { aspectRatioSelection: ratio });
  settingsVersion.value += 1;
}

/** 旧版 app.js getAspectRatioShapeStyle：按比例绘制图形按钮的形状。 */
function aspectRatioShapeStyle(ratio: string): Record<string, string> {
  const [width, height] = String(ratio).split(":").map(Number);
  const max = 30;
  const scale = max / Math.max(width, height);
  return {
    width: `${Math.max(5, Math.round(width * scale))}px`,
    height: `${Math.max(5, Math.round(height * scale))}px`,
  };
}

function creativeSummary(index: number): string {
  void settingsVersion.value;
  const settings = settingsFor(index);
  const style =
    XHS_CREATIVE_STYLE_OPTIONS.find((option) => option.value === settings.visualStylePreset)?.label || "智能匹配";
  const template =
    WECHAT_TEMPLATE_OPTIONS.find((option) => option.value === settings.wechatTemplate)?.label || "智能配色";
  const ratio = settings.aspectRatioSelection === "smart" ? "智能比例" : settings.aspectRatioSelection;
  return `${style} · ${template} · ${ratio}`;
}

function openLibrary(index: number): void {
  openLibraryFor.value = index;
  pendingDeleteImage.value = null;
  libraryMessage.value = "";
}

function closeLibrary(): void {
  openLibraryFor.value = null;
  pendingDeleteImage.value = null;
}

function requestLibraryDelete(image: ProductImageView): void {
  if (libraryDeleting.value) return;
  pendingDeleteImage.value = image;
}

function cancelLibraryDelete(): void {
  pendingDeleteImage.value = null;
}

const libraryDeleteImpact = computed(() => {
  const image = pendingDeleteImage.value;
  return image ? countProductImageReferences(image.id) : 0;
});

/**
 * 删除确认：复用现有 DELETE /api/product-images/:id 与
 * removeProductImageFromAllSettings 清理规则（与 ProductImagePanel 同一套，
 * 不复制第二套）。取消/失败/中止都不会清理引用或列表。
 */
async function confirmLibraryDelete(): Promise<void> {
  if (libraryDeleting.value) return;
  const image = pendingDeleteImage.value;
  if (!image) return;
  pendingDeleteImage.value = null;
  libraryDeleting.value = true;
  libraryMessage.value = "";
  try {
    // 与图库加载/上传共用 scope：账号切换（notifyAuthReset）或卸载会中止 DELETE；
    // 即便旧响应在中止后到达，也绝不清理引用或列表，避免污染新上下文。
    const signal = scope.signalFor(`library-delete:${image.id}`);
    await deleteProductImage(image.id, signal);
    if (signal.aborted) return;
    const cleaned = removeProductImageFromAllSettings(image.id);
    libraryImages.value = libraryImages.value.filter((item) => item.id !== image.id);
    libraryMessage.value =
      cleaned > 0 ? `已删除，并清理 ${cleaned} 处选题中的图片引用。` : "图片已删除。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    libraryMessage.value = `删除失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    libraryDeleting.value = false;
  }
}

function parsePositiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseIdeaIndex(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return null;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

const GENERATION_ACTIONS: readonly GenerationAction[] = ["moments", "wechat", "xhsCarousel", "styleImage"];

function parseAction(value: unknown): GenerationAction | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return GENERATION_ACTIONS.includes(raw as GenerationAction) ? (raw as GenerationAction) : null;
}

// 刷新/返回不丢上下文：进入页面时按 router query 恢复选中的品牌与趋势。
onMounted(() => {
  const queryBrandId = parsePositiveInt(route.query.brandId);
  const queryTrendId = parsePositiveInt(route.query.trendId);
  if (queryBrandId && store.selectedBrandId !== queryBrandId) store.selectedBrandId = queryBrandId;
  if (queryTrendId && store.selectedTrendId !== queryTrendId) store.selectedTrendId = queryTrendId;
  void loadPage().then(() => {
    // /generation 兼容重定向（保留 brandId/trendId/ideaIndex/action）：
    // 上下文就绪后自动打开内容选题内生成对话框并启动对应动作。
    applyDeepLinkGeneration();
  });
  void loadProductLibrary();
});

function applyDeepLinkGeneration(): void {
  const action = parseAction(route.query.action);
  const ideaIndex = parseIdeaIndex(route.query.ideaIndex);
  if (!action) return;
  // 严格实体校验：query brandId/trendId 必须与真实加载的品牌/趋势一致
  // （store 会把无效 trendId 静默回退到首条趋势，这里必须拦截），ideaIndex 必须在界内。
  const queryBrandId = parsePositiveInt(route.query.brandId);
  const queryTrendId = parsePositiveInt(route.query.trendId);
  // 品牌未加载：保留一次性票据（不销毁、不打开），loadPage/brand-trend watch 复查。
  if (!brand.value) return;
  const brandValid = queryBrandId !== null && Number(brand.value.id) === queryBrandId;
  if (!brandValid) {
    deepLinkError.value =
      "该生成链接已失效、无权访问或上下文不匹配，未执行任何扣费操作。请回到内容选题页重新选择后再生成。";
    const query = { ...route.query };
    delete query.action;
    void router.replace({ query }).catch(() => {
      // replace 失败不重试自动启动；对话框与 composable 的防线仍会拦截任何 POST。
    });
    return;
  }
  // 品牌匹配但趋势未加载：继续保留票据等待复查。
  if (!trend.value) return;
  const trendValid = queryTrendId !== null && Number(trend.value.id) === queryTrendId;
  const ideaValid = ideaIndex !== null && Boolean(trend.value?.ideas?.[ideaIndex]);
  if (!trendValid || !ideaValid) {
    deepLinkError.value =
      "该生成链接已失效、无权访问或上下文不匹配，未执行任何扣费操作。请回到内容选题页重新选择后再生成。";
    const query = { ...route.query };
    delete query.action;
    void router.replace({ query }).catch(() => {
      // replace 失败不重试自动启动；对话框与 composable 的防线仍会拦截任何 POST。
    });
    return;
  }
  deepLinkError.value = "";
  activeGeneration.value = { ideaIndex, action };
}

// SPA 深链复用：用户已停留在 /ideas 时，经 router.push 进入 /generation
// （重定向回 /ideas 且 query 保留）不会重新挂载 IdeasView。必须主动同步目标
// 品牌/趋势并应用一次性 action，否则深链静默失效。
watch(
  () =>
    [
      parsePositiveInt(route.query.brandId),
      parsePositiveInt(route.query.trendId),
      parseIdeaIndex(route.query.ideaIndex),
      parseAction(route.query.action),
    ] as const,
  async ([queryBrandId, queryTrendId]) => {
    let selectionChanged = false;
    if (queryBrandId && store.selectedBrandId !== queryBrandId) {
      store.selectedBrandId = queryBrandId;
      selectionChanged = true;
    }
    if (queryTrendId && store.selectedTrendId !== queryTrendId) {
      store.selectedTrendId = queryTrendId;
      selectionChanged = true;
    }
    if (selectionChanged && store.selectedBrandId) {
      try {
        await store.ensureBrandDetail(
          store.selectedBrandId,
          scope.signalFor(`brand-detail:${store.selectedBrandId}`),
        );
      } catch (error) {
        if (isAbortError(error) || handleUnauthorized(error)) return;
        loadError.value = `加载失败：${String((error as { message?: unknown })?.message || "")}`;
        return;
      }
    }
    // 品牌/趋势就绪后复查深链（对话框打开至多一次；action 票据由对话框消费）。
    applyDeepLinkGeneration();
  },
);

// 切换品牌/趋势时重置提示词输入与草稿（旧版 renderIdeas 每次渲染同步）。
watch(
  () => `${store.selectedBrandId ?? ""}:${trend.value?.id ?? ""}`,
  () => {
    customPrompt.value = trend.value?.customPrompt || "";
    promptMeta.value = trend.value?.customPrompt
      ? `当前已叠加你的补充提示词：${trend.value.customPrompt}`
      : "当前使用默认系统提示词生成。";
    for (const key of Object.keys(editingDrafts)) delete editingDrafts[Number(key)];
    for (const key of Object.keys(editErrors)) delete editErrors[Number(key)];
    openLibraryFor.value = null;
    pendingDeleteImage.value = null;
    libraryMessage.value = "";
    for (const key of Object.keys(openCreativeSettings)) delete openCreativeSettings[Number(key)];
    for (const key of Object.keys(productMessages)) delete productMessages[Number(key)];
    for (const key of Object.keys(styleErrors)) delete styleErrors[Number(key)];
    for (const key of Object.keys(logoErrors)) delete logoErrors[Number(key)];
    // 深链兜底：品牌/趋势就绪（含被并行 loadPage 抢先/中止的场景）后复查
    // /generation 兼容重定向的一次性 action，打开对话框至多一次。
    applyDeepLinkGeneration();
  },
  { immediate: true },
);

const displayMeta = computed(() => {
  if (!brand.value) return "当前使用默认系统提示词生成。";
  if (!brand.value._detailLoaded) return "品牌详情加载完成后可继续生成内容。";
  if (!trend.value) return "当前使用默认系统提示词生成。";
  return promptMeta.value;
});

const regenerateDisabled = computed(
  () => regenerating.value || !brand.value || !brand.value._detailLoaded || !trend.value,
);

async function loadPage(): Promise<void> {
  loadError.value = "";
  try {
    // 不强制刷新：保留从趋势页「生成选题」带过来的选中品牌与趋势。
    await store.loadBrands(scope.signalFor("brands"));
    // 深链/刷新场景：loadBrands 内的 syncOwner 会在首次挂载时重置整个 store，
    // 品牌列表就绪后必须重新套用 router query 里的 brandId/trendId 上下文。
    const queryBrandId = parsePositiveInt(route.query.brandId);
    const queryTrendId = parsePositiveInt(route.query.trendId);
    if (queryBrandId) store.selectedBrandId = queryBrandId;
    if (queryTrendId) store.selectedTrendId = queryTrendId;
    if (store.selectedBrandId) {
      await store.ensureBrandDetail(store.selectedBrandId, scope.signalFor(`brand-detail:${store.selectedBrandId}`));
    }
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    loadError.value = `加载失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

// --- 自定义补充提示词 / 重新生成选题（旧版 bindIdeaPromptActions）---

async function handleRegenerate(): Promise<void> {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  if (!currentBrand || !currentTrend) {
    promptMeta.value = "请先选择品牌或个人 IP，并生成热点趋势。";
    return;
  }
  const prompt = customPrompt.value.trim();
  regenerating.value = true;
  promptMeta.value = "正在把你的补充提示词追加到系统提示词中并重新生成选题...";
  try {
    const result = await regenerateTrendIdeas(currentBrand.id, currentTrend.id, prompt, scope.signalFor("regenerate"));
    if (result.user) auth.user = result.user;
    store.replaceTrendInBrand(currentBrand.id, result.trend);
    store.selectedTrendId = result.trend.id;
    promptMeta.value = prompt
      ? `已按你的补充提示词重新生成。当前额外要求：${prompt}`
      : "已恢复为默认系统提示词生成。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    promptMeta.value = `生成失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    regenerating.value = false;
  }
}

// --- 选题编辑（旧版 data-edit-idea / data-idea-edit-form）---

function startEdit(index: number): void {
  const idea = trend.value?.ideas?.[index];
  if (!idea) return;
  editingDrafts[index] = {
    title: idea.title || "",
    summary: idea.summary || "",
    angle: idea.angle || "",
    brandFit: idea.brandFit || "",
    audience: idea.audience || "",
    hook: idea.hook || "",
  };
  delete editErrors[index];
}

function cancelEdit(index: number): void {
  delete editingDrafts[index];
  delete editErrors[index];
}

async function saveIdea(index: number): Promise<void> {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  const draft = editingDrafts[index];
  if (!currentBrand || !currentTrend || !draft) return;
  try {
    const result = await updateTrendIdea(
      currentBrand.id,
      currentTrend.id,
      index,
      { ...draft },
      scope.signalFor(`idea-edit:${index}`),
    );
    store.replaceTrendInBrand(currentBrand.id, result.trend);
    delete editingDrafts[index];
    delete editErrors[index];
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    editErrors[index] = `保存失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

// --- 内容资产预览（旧版 hasCompleteIdeaContentAssets / renderIdeaContentAssets）---

function hasCompleteIdeaContentAssets(idea: TrendIdea): boolean {
  const assets = idea?.contentAssets || {};
  const slides = assets.xhsCarousel?.slides;
  return Boolean(
    assets.moments?.caption &&
      assets.xhsCarousel?.publishTitle &&
      Array.isArray(slides) &&
      slides.length === 4 &&
      assets.wechatLongImage?.intro,
  );
}

// 内容选题内直接承接生成：打开对话框并写入一次性 action 票据（URL query）。
function openGeneration(ideaIndex: number, action: GenerationAction): void {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  if (!currentBrand || !currentTrend) return;
  activeGeneration.value = { ideaIndex, action };
  void router.push({
    name: "ideas",
    query: {
      ...route.query,
      brandId: String(currentBrand.id),
      trendId: String(currentTrend.id),
      ideaIndex: String(ideaIndex),
      action,
    },
  });
}

function closeGeneration(): void {
  activeGeneration.value = null;
  settingsVersion.value += 1;
  if (route.query.action !== undefined) {
    const query = { ...route.query };
    delete query.action;
    void router.replace({ query });
  }
  // 对话框关闭即中止其轮询：立即补扫当前用户活动任务，由全局恢复服务接管，
  // 避免任务在“生成中-关窗”间隙失去轮询（服务端状态仍是权威，不重复扣费）。
  useImageJobRecovery().rescan();
}

// 弹窗只消费外层图库（唯一素材入口）：列表 + 状态 + 重载全部来自本页。
const productLibraryProp = computed<IdeaProductLibrary>(() => ({
  images: libraryImages,
  loading: libraryLoading,
  loaded: libraryLoaded,
  error: libraryError,
  reload: loadProductLibrary,
}));
</script>

<template>
  <section class="ideas-panel">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon panel-icon-green">◌</span>
          <h1 class="panel-title">内容选题</h1>
        </div>
        <p class="panel-subtitle">结合主体档案和热点趋势，生成更匹配品牌或个人 IP 的小红书内容</p>
      </div>
    </header>

    <div v-if="loadError" class="error-banner" data-test="load-error">
      {{ loadError }}
      <button class="text-btn" type="button" @click="loadPage">重试</button>
    </div>

    <div v-if="deepLinkError" class="error-banner" role="alert" data-test="deep-link-error">
      {{ deepLinkError }}
    </div>

    <div class="idea-context-card" data-test="idea-context">
      <div v-if="!brand" class="idea-copy">先新增品牌，再开始生成内容选题。</div>
      <div v-else-if="!brand._detailLoaded" class="idea-copy">
        正在加载 {{ brand.name }} 的完整品牌详情和选题记录...
      </div>
      <div v-else-if="!trend" class="idea-copy">
        先在“趋势分析”中为 {{ brand.name }} 生成一批热点，再进入内容选题页。
      </div>
      <div v-else class="idea-context-top">
        <div>
          <div class="idea-context-heading">
            <span class="idea-status-dot" data-test="idea-status-dot" aria-label="选题已就绪"></span>
            <h3>{{ brand.name }} × {{ trend.title }}</h3>
          </div>
          <p class="idea-copy">
            {{
              isPersonal
                ? "内容选题不是只追热点，而是把个人定位、真实素材、目标读者和表达风格一起带入，生成符合本人经历与人设边界的小红书内容方向。"
                : "内容选题不是只追热点，而是把品牌资产、产品卖点、目标受众和运营目标一起带入，生成真正适合该品牌的小红书内容方向。"
            }}
          </p>
          <p class="idea-copy"><strong>热点适配原因：</strong>{{ trend.reason }}</p>
          <p class="idea-copy">
            <strong>{{ isPersonal ? "补充背景资料" : "品牌资料库" }}：</strong
            >{{ brand.knowledgeBase || `当前未补充${isPersonal ? "背景资料" : "品牌资料库"}。` }}
          </p>
          <p class="idea-copy">
            <strong>参考图片：</strong>
            {{
              isPersonal
                ? "可上传内容参考图、使用个人头像参考或添加风格参考图；系统不会把个人头像当作品牌 Logo 植入画面。"
                : "可在下方每个选题中上传产品图、选择品牌 Logo 或添加风格参考图，并勾选后用于对应生图。"
            }}
          </p>
        </div>
        <div class="idea-tag-list">
          <span class="idea-status-label" data-test="idea-status-label">内容选题已就绪</span>
          <span v-for="tag in brand.assetTags" :key="tag" class="idea-tag">{{ tag }}</span>
        </div>
      </div>
    </div>

    <div class="idea-prompt-card">
      <div class="idea-prompt-header">
        <div>
          <h3>自定义补充提示词</h3>
          <p class="idea-copy">
            在系统提示词的基础上追加你的要求，例如内容语气、强调卖点、限制风格或指定人群。
          </p>
        </div>
        <button
          class="primary-btn small-btn cost-button"
          data-test="regenerate-ideas"
          type="button"
          :disabled="regenerateDisabled"
          @click="handleRegenerate"
        >
          <template v-if="regenerating">生成中...</template>
          <template v-else>
            <span>重新生成选题</span>
            <small>1 积分</small>
          </template>
        </button>
      </div>
      <textarea
        v-model="customPrompt"
        data-test="custom-idea-prompt"
        rows="4"
        placeholder="例如：希望选题更偏高端质感，强调女性独居场景，标题更克制，不要太营销化。"
      ></textarea>
      <div class="idea-prompt-meta" data-test="idea-prompt-meta">{{ displayMeta }}</div>
    </div>

    <div class="idea-cards" data-test="idea-list">
      <template v-if="brand && brand._detailLoaded && trend">
        <article v-for="(idea, index) in trend.ideas" :key="index" class="idea-card" data-test="idea-card">
          <form v-if="editingDrafts[index]" class="idea-edit-form" @submit.prevent="saveIdea(index)">
            <label>
              <span>选题标题</span>
              <input v-model="editingDrafts[index].title" name="title" />
            </label>
            <label>
              <span>内容摘要</span>
              <textarea v-model="editingDrafts[index].summary" name="summary" rows="3"></textarea>
            </label>
            <div class="form-row">
              <label>
                <span>切入角度</span>
                <input v-model="editingDrafts[index].angle" name="angle" />
              </label>
              <label>
                <span>面向人群</span>
                <input v-model="editingDrafts[index].audience" name="audience" />
              </label>
            </div>
            <label>
              <span>品牌结合方式</span>
              <input v-model="editingDrafts[index].brandFit" name="brandFit" />
            </label>
            <label>
              <span>开头钩子</span>
              <input v-model="editingDrafts[index].hook" name="hook" />
            </label>
            <p v-if="editErrors[index]" class="idea-error" data-test="idea-edit-error">{{ editErrors[index] }}</p>
            <div class="idea-edit-actions">
              <button class="primary-btn small-btn" type="submit">确认</button>
              <button class="secondary-btn small-btn" type="button" @click="cancelEdit(index)">取消</button>
            </div>
          </form>

          <template v-else>
            <div class="idea-title-row">
              <h3>{{ idea.title }}</h3>
              <button class="text-btn" type="button" data-test="edit-idea" @click="startEdit(index)">编辑</button>
            </div>
            <div><strong>内容摘要：</strong>{{ idea.summary }}</div>
            <div><strong>切入角度：</strong>{{ idea.angle }}</div>
            <div><strong>品牌结合方式：</strong>{{ idea.brandFit }}</div>
            <div><strong>面向人群：</strong>{{ idea.audience }}</div>
            <div><strong>开头钩子：</strong>{{ idea.hook }}</div>

            <template v-if="hasCompleteIdeaContentAssets(idea)">
              <div class="idea-asset-preview">
                <div><strong>朋友圈标题：</strong>{{ idea.contentAssets.moments?.title }}</div>
                <div><strong>朋友圈文案：</strong>{{ idea.contentAssets.moments?.caption }}</div>
                <div>
                  <strong>小红书标题：</strong
                  >{{ idea.contentAssets.xhsCarousel?.publishTitle || idea.contentAssets.xhsCarousel?.title }}
                </div>
                <div>
                  <strong>小红书文案：</strong
                  >{{ idea.contentAssets.xhsCarousel?.publishCaption || idea.contentAssets.xhsCarousel?.caption }}
                </div>
              </div>
            </template>
            <div v-else class="idea-assets-incomplete" data-test="idea-assets-incomplete" role="alert">
              <p>
                该选题缺少完整内容资产（朋友圈 / 小红书 / 公众号文案），可能来自旧版骨架数据，无法直接用于生图。
                请重新生成趋势或选题后获得完整文案。
              </p>
              <button
                type="button"
                class="secondary-btn small-btn"
                :data-test="`idea-regenerate-assets-${index}`"
                :disabled="regenerating"
                @click="handleRegenerate"
              >
                {{ regenerating ? "生成中..." : "重新生成选题（1 积分）" }}
              </button>
            </div>

            <!-- 品牌 Logo 开关 -->
            <div class="idea-logo-control" :data-test="`idea-logo-control-${index}`">
              <label class="idea-logo-check">
                <input
                  type="checkbox"
                  :data-test="`idea-use-brand-logo-${index}`"
                  :checked="Boolean(brand.logo) && settingsFor(index).useBrandLogo"
                  :disabled="!brand.logo"
                  @change="toggleLogo(index, $event)"
                />
                <span>{{ isPersonal ? "使用个人头像作为视觉参考" : "使用品牌 Logo" }}</span>
              </label>
              <div class="idea-logo-meta">
                <span :data-test="`idea-logo-id-${index}`">
                  {{
                    brand.logo
                      ? formatImageName(brand.logo.originalName || logoLabel, 38)
                      : `未上传${isPersonal ? "头像" : " Logo"}`
                  }}
                </span>
                <label class="idea-inline-upload">
                  <input type="file" accept="image/*" :data-test="`idea-logo-input-${index}`" @change="handleLogoUpload(index, $event)" />
                  <span>{{ brand.logo ? `更换${isPersonal ? "头像" : " Logo"}` : `上传${isPersonal ? "头像" : " Logo"}` }}</span>
                </label>
              </div>
              <p v-if="logoErrors[index]" class="idea-control-message" :data-test="`idea-logo-error-${index}`">
                {{ logoErrors[index] }}
              </p>
            </div>

            <!-- 产品图参考 -->
            <div class="idea-product-upload" :data-test="`idea-product-upload-${index}`">
              <div class="idea-product-upload-top">
                <div class="idea-product-summary">
                  <div>
                    <div class="idea-product-upload-title">{{ assetLabel }}参考</div>
                    <div class="idea-product-file" :class="{ 'has-file': selectedProductImages(index).length > 0 }">
                      {{
                        selectedProductImages(index).length > 0
                          ? `已选择 ${selectedProductImages(index).length} 张：${formatImageName(selectedProductNames(index), 46)}`
                          : `未选择${assetLabel}`
                      }}
                    </div>
                    <div class="idea-product-file">
                      最多 {{ MAX_SELECTED_PRODUCT_IMAGES }} 张，共 {{ formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES) }}；当前
                      {{ selectedProductImages(index).length }} 张，约 {{ formatFileSize(selectedProductBytes(index)) }}
                    </div>
                  </div>
                </div>
                <div class="idea-product-button-stack">
                  <label class="idea-upload-button">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      :data-test="`idea-product-upload-input-${index}`"
                      @change="handleProductUpload(index, $event)"
                    />
                    <span>{{ uploadingProduct === index ? "上传中..." : selectedProductImages(index).length > 0 ? "继续上传" : `上传${assetLabel}` }}</span>
                  </label>
                  <button class="idea-library-button" type="button" :data-test="`idea-open-library-${index}`" @click="openLibrary(index)">
                    选择已上传图片
                  </button>
                </div>
              </div>
              <div v-if="selectedProductImages(index).length > 0" class="idea-product-selected-strip">
                <div
                  v-for="image in selectedProductImages(index)"
                  :key="image.id"
                  class="idea-product-selected-preview"
                  :title="image.originalName"
                >
                  <img :src="image.url" :alt="image.originalName" loading="lazy" decoding="async" />
                </div>
              </div>
              <div class="idea-product-actions idea-product-actions-bottom">
                <label class="idea-product-check">
                  <input
                    type="checkbox"
                    :data-test="`idea-use-product-images-${index}`"
                    :checked="settingsFor(index).useProductImages"
                    :disabled="selectedProductImages(index).length === 0"
                    @change="toggleUseProductImages(index, $event)"
                  />
                  使用这些{{ assetLabel }}生成图片
                </label>
                <button
                  v-if="selectedProductImages(index).length > 0"
                  class="idea-product-clear"
                  type="button"
                  :data-test="`idea-clear-product-${index}`"
                  @click="clearProductSelection(index)"
                >
                  清除当前选择
                </button>
              </div>
              <p v-if="productMessages[index]" class="idea-control-message" :data-test="`idea-product-message-${index}`">
                {{ productMessages[index] }}
              </p>
            </div>

            <!-- 风格图参考 -->
            <div class="idea-product-upload idea-style-upload" :data-test="`idea-style-upload-${index}`">
              <div class="idea-product-upload-top">
                <div class="idea-product-summary">
                  <div>
                    <div class="idea-product-upload-title">风格图参考</div>
                    <div class="idea-product-file" :class="{ 'has-file': Boolean(settingsFor(index).styleReference) }">
                      {{
                        settingsFor(index).styleReference
                          ? `${formatImageName(settingsFor(index).styleReference!.fileName, 46)}，约 ${formatFileSize(settingsFor(index).styleReference!.sizeBytes)}，用于一键风格化图的色调和版式参考`
                          : "未选择参考图"
                      }}
                    </div>
                    <div class="idea-product-file">只能上传 1 张，{{ formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES) }} 内</div>
                  </div>
                </div>
                <div class="idea-product-button-stack">
                  <label class="idea-upload-button">
                    <input
                      type="file"
                      accept="image/*"
                      :data-test="`idea-style-input-${index}`"
                      @change="handleStyleUpload(index, $event)"
                    />
                    <span>{{ settingsFor(index).styleReference ? "更换参考图" : "上传参考图" }}</span>
                  </label>
                </div>
              </div>
              <div v-if="settingsFor(index).styleReference" class="idea-product-selected-strip">
                <div class="idea-product-selected-preview idea-style-reference-preview">
                  <img
                    :src="settingsFor(index).styleReference!.dataUrl"
                    :alt="settingsFor(index).styleReference!.fileName"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <span class="idea-style-reference-name" :data-test="`idea-style-name-${index}`">
                  {{ settingsFor(index).styleReference!.fileName }}
                </span>
              </div>
              <div class="idea-product-actions">
                <button
                  v-if="settingsFor(index).styleReference"
                  class="idea-product-clear idea-style-clear"
                  type="button"
                  :data-test="`idea-style-clear-${index}`"
                  @click="clearStyleReference(index)"
                >
                  清除参考图
                </button>
              </div>
              <p v-if="styleErrors[index]" class="idea-control-message" :data-test="`idea-style-error-${index}`">
                {{ styleErrors[index] }}
              </p>
            </div>

            <!-- 创作设置（折叠） -->
            <section
              class="idea-creative-settings"
              :class="{ 'is-open': Boolean(openCreativeSettings[index]) }"
              :data-test="`idea-creative-settings-${index}`"
            >
              <button
                class="idea-aspect-ratio-trigger"
                type="button"
                :data-test="`idea-creative-toggle-${index}`"
                :aria-expanded="Boolean(openCreativeSettings[index])"
                @click="toggleCreativeSettings(index)"
              >
                <span class="idea-aspect-ratio-copy">
                  <strong>创作设置</strong>
                  <small>{{ creativeSummary(index) }}</small>
                </span>
                <span class="idea-aspect-ratio-value">
                  <b>{{ openCreativeSettings[index] ? "收起" : "调整" }}</b>
                  <span class="idea-aspect-ratio-chevron" aria-hidden="true"></span>
                </span>
              </button>
              <div v-if="openCreativeSettings[index]" class="idea-aspect-ratio-panel">
                <div class="idea-creative-grid">
                  <label class="idea-creative-field">
                    <span>小红书视觉路线</span>
                    <select
                      :data-test="`idea-creative-style-${index}`"
                      :value="settingsFor(index).visualStylePreset"
                      @change="updateCreativeSetting(index, 'visualStylePreset', $event)"
                    >
                      <option v-for="option in XHS_CREATIVE_STYLE_OPTIONS" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label class="idea-creative-field">
                    <span>公众号长图模板</span>
                    <select
                      :data-test="`idea-creative-template-${index}`"
                      :value="settingsFor(index).wechatTemplate"
                      @change="updateCreativeSetting(index, 'wechatTemplate', $event)"
                    >
                      <option v-for="option in WECHAT_TEMPLATE_OPTIONS" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                </div>
                <div class="idea-creative-field idea-creative-ratio-field">
                  <span>图片比例</span>
                  <div class="idea-aspect-ratio-grid">
                    <button
                      v-for="ratio in ['smart', ...IMAGE_ASPECT_RATIOS]"
                      :key="ratio"
                      type="button"
                      class="idea-aspect-ratio-option"
                      :class="{ 'is-selected': settingsFor(index).aspectRatioSelection === ratio }"
                      :data-test="`idea-ratio-${index}-${ratio}`"
                      :aria-pressed="settingsFor(index).aspectRatioSelection === ratio"
                      @click="selectRatio(index, ratio)"
                    >
                      <span class="idea-aspect-ratio-visual">
                        <span v-if="ratio === 'smart'" class="aspect-smart-mark" aria-hidden="true"><i></i><i></i></span>
                        <i v-else class="aspect-shape" :style="aspectRatioShapeStyle(ratio)" aria-hidden="true"></i>
                      </span>
                      <span>{{ ratio === "smart" ? "智能" : ratio }}</span>
                    </button>
                  </div>
                  <small class="idea-ratio-hint">
                    {{
                      settingsFor(index).aspectRatioSelection === "smart"
                        ? "按图片类型自动匹配（公众号 9:21，其余 3:4）"
                        : "四种生图使用统一比例"
                    }}
                  </small>
                </div>
              </div>
            </section>

            <div class="idea-actions">
              <button
                class="primary-btn small-btn cost-button"
                type="button"
                :data-test="`idea-generate-moments-${index}`"
                @click="openGeneration(index, 'moments')"
              >
                <span>一键朋友圈图</span>
                <small>1 积分</small>
              </button>
              <button
                class="secondary-btn small-btn cost-button"
                type="button"
                :data-test="`idea-generate-wechat-${index}`"
                @click="openGeneration(index, 'wechat')"
              >
                <span>一键公众号长图</span>
                <small>1 积分</small>
              </button>
              <button
                class="secondary-btn small-btn cost-button"
                type="button"
                :data-test="`idea-generate-xhs-${index}`"
                @click="openGeneration(index, 'xhsCarousel')"
              >
                <span>一键小红书组图</span>
                <small>4 积分</small>
              </button>
              <button
                class="secondary-btn small-btn cost-button"
                type="button"
                :data-test="`idea-generate-style-${index}`"
                @click="openGeneration(index, 'styleImage')"
              >
                <span>一键风格化图</span>
                <small>1 积分</small>
              </button>
            </div>
            <div class="idea-tag-list">
              <span v-for="tag in idea.tags" :key="tag" class="idea-tag">{{ tag }}</span>
            </div>
          </template>
        </article>
      </template>
    </div>

    <!-- 已上传产品图选择弹层（旧版 openProductImageLibrary 语义） -->
    <div
      v-if="openLibraryFor !== null"
      class="idea-library-backdrop"
      :data-test="`product-library-dialog-${openLibraryFor}`"
      @click.self="closeLibrary"
    >
      <section class="idea-library-panel" role="dialog" aria-modal="true">
        <header class="idea-library-head">
          <h3>选择已上传{{ assetLabel }}</h3>
          <button class="idea-library-close" type="button" :data-test="`idea-library-close-${openLibraryFor}`" @click="closeLibrary">
            ×
          </button>
        </header>
        <p v-if="libraryLoading" class="panel-hint">正在加载产品素材...</p>
        <p v-else-if="libraryError" class="idea-control-message">{{ libraryError }}</p>
        <ul v-else-if="libraryImages.length" class="idea-library-list">
          <li v-for="image in libraryImages" :key="image.id" class="idea-library-item">
            <label>
              <input
                type="checkbox"
                :data-test="`idea-library-check-${openLibraryFor}-${image.id}`"
                :checked="isProductSelected(openLibraryFor, image.id)"
                @change="toggleLibraryImage(openLibraryFor, image.id, $event)"
              />
              <img :src="image.url" :alt="image.originalName" loading="lazy" decoding="async" />
              <span>{{ image.originalName }}</span>
            </label>
            <button
              type="button"
              class="idea-library-delete"
              :data-test="`idea-library-delete-${openLibraryFor}-${image.id}`"
              :disabled="libraryDeleting"
              @click="requestLibraryDelete(image)"
            >
              删除
            </button>
          </li>
        </ul>
        <p v-else class="panel-hint">还没有已上传的产品图，可先在选题卡内上传。</p>
        <p v-if="libraryMessage" class="idea-control-message" data-test="library-message">{{ libraryMessage }}</p>
        <button class="primary-btn small-btn" type="button" :data-test="`idea-library-done-${openLibraryFor}`" @click="closeLibrary">
          完成
        </button>
      </section>
      <div
        v-if="pendingDeleteImage"
        class="idea-library-delete-backdrop"
        data-test="library-delete-confirm"
        @click.self="cancelLibraryDelete"
      >
        <section class="idea-library-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="libraryDeleteTitle">
          <h3 id="libraryDeleteTitle">删除{{ assetLabel }}</h3>
          <p data-test="library-delete-impact">
            {{
              libraryDeleteImpact > 0
                ? `该图片正被 ${libraryDeleteImpact} 处选题引用，删除后将同时移除这些引用。`
                : "该图片未被任何选题引用。"
            }}
          </p>
          <p>确定删除「{{ pendingDeleteImage.originalName }}」吗？此操作不可恢复。</p>
          <div class="idea-library-delete-actions">
            <button type="button" class="secondary-btn" data-test="library-delete-cancel" @click="cancelLibraryDelete">
              取消
            </button>
            <button
              type="button"
              class="danger-btn"
              data-test="library-delete-confirm-action"
              :disabled="libraryDeleting"
              @click="confirmLibraryDelete"
            >
              确认删除
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- 内容选题内生成：进度、结果、失败与重试直接在此承接 -->
    <IdeaGenerationDialog
      v-if="activeGeneration"
      :key="activeGeneration.ideaIndex"
      :idea-index="activeGeneration.ideaIndex"
      :action="activeGeneration.action"
      :product-library="productLibraryProp"
      @close="closeGeneration"
    />
  </section>
</template>

<style scoped>
.ideas-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-icon-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: rgba(52, 199, 36, 0.12);
  color: var(--color-success);
  font-weight: 700;
}

.panel-title {
  margin: 0;
  font-size: 22px;
}

.panel-subtitle {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.error-banner {
  border: 1px solid rgba(245, 74, 69, 0.4);
  background: rgba(245, 74, 69, 0.06);
  color: var(--color-danger);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.idea-context-card,
.idea-prompt-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.idea-context-top {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.idea-context-top h3 {
  margin: 0 0 8px;
  font-size: 16px;
}

.idea-copy {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.idea-prompt-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.idea-prompt-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.idea-prompt-card textarea {
  width: 100%;
  margin-top: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
  font-size: 13px;
  resize: vertical;
}

.idea-prompt-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.idea-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.idea-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.idea-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.idea-title-row h3 {
  margin: 0;
  font-size: 15px;
}

.idea-asset-preview {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.idea-asset-preview.is-incomplete {
  color: var(--color-text-secondary);
}

.idea-assets-incomplete {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(180, 35, 24, 0.18);
  border-radius: var(--radius-md);
  background: #fff1f1;
  color: #8c2b22;
  font-size: 0.86rem;
  line-height: 1.65;
}

.idea-assets-incomplete p {
  margin: 0;
}

.idea-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.idea-tag {
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: 999px;
  padding: 2px 10px;
}

.idea-edit-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.idea-edit-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.idea-edit-form input,
.idea-edit-form textarea {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px;
  font-size: 13px;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.idea-edit-actions {
  display: flex;
  gap: 8px;
}

.idea-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger);
}

.primary-btn {
  border: none;
  background: var(--color-brand);
  color: #fff;
  border-radius: var(--radius-md);
  padding: 8px 14px;
  cursor: pointer;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 13px;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.primary-btn small {
  font-size: 11px;
  opacity: 0.85;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}

.text-btn {
  border: none;
  background: none;
  color: var(--color-brand);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
}

/* Legacy light-workspace parity: all Vue editing and generation routes remain intact. */
.ideas-panel {
  gap: 0;
  color: var(--workspace-text);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.panel-icon-title {
  gap: 14px;
}

.panel-icon {
  display: block;
  width: 14.40625px;
  height: auto;
  border-radius: 0;
  background: transparent;
  color: #4c9775;
  font-size: 1.8rem;
  font-weight: 400;
}

.panel-title {
  color: var(--workspace-text);
  font-size: 2.1rem;
  font-family: var(--workspace-font-heading);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.panel-subtitle {
  margin-top: 10px;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.error-banner {
  border-radius: var(--workspace-radius-sm);
}

.idea-context-card,
.idea-prompt-card,
.idea-card {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.idea-context-card,
.idea-prompt-card,
.idea-card {
  padding: 20px;
}

.idea-context-card,
.idea-prompt-card {
  margin-bottom: 24px;
}

.idea-context-card > .idea-copy {
  margin: 0;
}

.idea-context-top {
  gap: 18px;
}

.idea-context-heading {
  display: flex;
  align-items: center;
  gap: 9px;
}

.idea-status-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #2d8b71;
  box-shadow: 0 0 0 4px rgba(45, 139, 113, 0.14);
}

.idea-status-label {
  display: inline-flex;
  align-items: center;
  color: #2d8b71;
  font-size: 0.76rem;
  font-weight: 700;
}

.idea-context-top h3,
.idea-prompt-header h3,
.idea-title-row h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.6;
}

.idea-copy {
  margin: 1em 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.idea-prompt-header {
  gap: 16px;
  margin-bottom: 16px;
}

.idea-prompt-header h3 {
  margin: 0 0 8px;
}

.idea-prompt-card textarea,
.idea-edit-form input,
.idea-edit-form textarea {
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  outline: none;
}

.idea-prompt-card textarea {
  min-height: 132px;
  margin-top: 0;
  padding: 14px;
  font-size: 0.94rem;
  line-height: 1.6;
}

.idea-prompt-card textarea:focus,
.idea-edit-form input:focus,
.idea-edit-form textarea:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.idea-prompt-meta {
  display: flex;
  align-items: center;
  margin-top: 12px;
  color: #b9b2cd;
  font-size: 0.95rem;
  line-height: 1.6;
}

.idea-cards {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
}

.idea-card {
  display: grid;
  gap: 14px;
  font-size: 0.92rem;
  line-height: 1.65;
}

.idea-card strong {
  color: #bf3641;
}

.idea-title-row {
  gap: 12px;
}

.idea-asset-preview {
  gap: 8px;
  padding: 12px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #faf7f5;
  line-height: 1.65;
}

.idea-asset-preview.is-incomplete {
  border-color: rgba(202, 130, 21, 0.22);
  background: #fff8eb;
  color: #8a6d1d;
}

.idea-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 4px;
}

.idea-actions .cost-button {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-height: 54px;
  padding: 8px 10px;
  text-align: center;
  line-height: 1.4;
}

.idea-actions .cost-button small {
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.85;
}

.idea-tag-list {
  gap: 8px;
}

.idea-tag {
  padding: 4px 10px;
  border-radius: var(--workspace-radius-sm);
  background: #f5f1ef;
  color: var(--workspace-text-muted);
}

.idea-edit-form {
  gap: 12px;
}

.idea-edit-form label {
  gap: 6px;
  color: #5f5357;
  font-size: 0.86rem;
}

.idea-edit-form input,
.idea-edit-form textarea {
  padding: 10px 11px;
  font-size: 0.92rem;
}

.idea-error {
  color: #b72e3a;
}

.primary-btn,
.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.92rem;
}

.primary-btn {
  background: var(--workspace-brand);
  color: #fff;
}

.primary-btn:hover:not(:disabled) {
  background: var(--workspace-brand-hover);
}

.secondary-btn {
  border-color: var(--workspace-border);
  background: #fff;
  color: var(--workspace-text);
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.text-btn {
  color: var(--workspace-brand-ink);
}

/* 旧版 styles.css:3055-3175 比例图形按钮网格：智能＋具体比例。 */
.idea-aspect-ratio-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 7px;
}

.idea-aspect-ratio-option {
  min-width: 0;
  min-height: 64px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 5px;
  padding: 7px 3px;
  border: 1px solid rgba(50, 37, 41, 0.09);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.72);
  color: #75666b;
  font-size: 0.76rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
}

.idea-aspect-ratio-option:hover {
  border-color: rgba(216, 59, 70, 0.28);
  background: #fff;
}

.idea-aspect-ratio-option.is-selected {
  border-color: #d83b46;
  background: #fff4f2;
  color: #a82e38;
  box-shadow: inset 0 0 0 1px rgba(216, 59, 70, 0.08);
}

.idea-aspect-ratio-visual {
  width: 34px;
  height: 32px;
  display: grid;
  place-items: center;
}

.aspect-shape {
  display: inline-block;
  box-sizing: border-box;
  border: 1.6px solid currentColor;
  border-radius: 3px;
  background: rgba(216, 59, 70, 0.04);
}

.aspect-smart-mark {
  position: relative;
  width: 30px;
  height: 28px;
  display: inline-block;
}

.aspect-smart-mark i {
  position: absolute;
  width: 16px;
  height: 20px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
}

.aspect-smart-mark i:first-child {
  left: 3px;
  top: 5px;
}

.aspect-smart-mark i:last-child {
  right: 3px;
  top: 2px;
  background: #fffaf8;
}

.idea-ratio-hint {
  color: var(--workspace-text-muted);
  font-size: 0.78rem;
  line-height: 1.5;
}

.idea-library-item {
  display: grid;
  gap: 8px;
}

.idea-library-delete {
  min-height: 32px;
  border: 1px solid rgba(183, 46, 58, 0.16);
  border-radius: var(--workspace-radius-sm, 6px);
  background: #fffafa;
  color: #b72e3a;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.idea-library-delete:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.idea-library-delete-backdrop {
  position: fixed;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  background: rgba(10, 15, 25, 0.45);
}

.idea-library-delete-modal {
  display: grid;
  gap: 10px;
  width: min(420px, calc(100vw - 32px));
  padding: 18px;
  border-radius: var(--workspace-radius, 10px);
  background: var(--workspace-surface, #fff);
  color: var(--workspace-text, #222);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
}

.idea-library-delete-modal h3 {
  margin: 0;
}

.idea-library-delete-modal p {
  margin: 0;
  color: var(--workspace-muted, #687385);
}

.idea-library-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.danger-btn {
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid var(--workspace-danger, #c0392b);
  border-radius: var(--workspace-radius-sm, 6px);
  background: var(--workspace-danger, #c0392b);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}

.danger-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 760px) {
  .idea-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .idea-aspect-ratio-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .idea-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
