<script setup lang="ts">
// 内容选题内生成对话框：直接承接四类生图的排队、进度、结果、失败与重试。
// 复用 useIdeaGeneration 状态机（一次性 action 票据、素材加载门控、
// 积分幂等与失败恢复），不复制请求逻辑。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ImageEditPanel from "../components/ImageEditPanel.vue";
import { getIdeaSettingsKey } from "../ideaCreativeSettings";
import {
  useIdeaGeneration,
  type IdeaGenerationAction,
  type IdeaProductLibrary,
} from "../composables/useIdeaGeneration";
import type { ImageEditTarget } from "../composables/useImageEdit";
import { useInsightsStore } from "@/features/trends/stores/insights";
import {
  IMAGE_ASPECT_RATIOS,
  hasXhsCarouselSlideImage,
  safeImageSrc,
  SMART_ASPECT_RATIO_DEFAULTS,
  type BrandDetail,
  type IdeaDetail,
  type TrendDetail,
} from "../api";

const props = defineProps<{
  ideaIndex: number;
  /** 用户点击或深链携带的生成动作；genKind 未初始化/图库加载中/失败时用于正确展示名称。 */
  action: IdeaGenerationAction;
  /** 外层内容选题页的唯一产品图库（列表 + 状态 + 重载入口），弹窗不再渲染图库。 */
  productLibrary?: IdeaProductLibrary;
}>();

const emit = defineEmits<{
  (event: "close"): void;
}>();

const store = useInsightsStore();

// 品牌/趋势/选题上下文来自洞察 store（内容选题页已 ensureBrandDetail）。
const brand = computed<BrandDetail | null>(() => (store.selectedBrand as unknown as BrandDetail) || null);
const trend = computed<TrendDetail | null>(() => (store.selectedTrend as unknown as TrendDetail) || null);
const idea = computed<IdeaDetail | null>(() => trend.value?.ideas?.[props.ideaIndex] ?? null);
const brandId = computed(() => store.selectedBrandId ?? null);
const trendId = computed(() => Number(store.selectedTrend?.id ?? 0) || null);
const ideaIndex = computed(() => props.ideaIndex);
const settingsKey = computed(() => getIdeaSettingsKey(brandId.value, trendId.value, props.ideaIndex));

const gen = useIdeaGeneration({
  brandId,
  trendId,
  ideaIndex,
  brand,
  trend,
  idea,
  settingsKey,
  productLibrary: props.productLibrary,
});

const {
  contextError,
  productImagesError,
  retryProductImagesLoad,
  busy,
  productLibraryBlocked,
  genStatus,
  genError,
  genKind,
  momentsResult,
  wechatResult,
  styleResult,
  carousel,
  wechatConfirm,
  wechatDisableWarning,
  resolveWechatConfirm,
  retryGeneration,
  generateAllCarouselSlides,
  generateCarouselSlide,
  editCarouselSlide,
  afterGenerationSuccess,
  aspectRatioSelection,
  maybeAutoStartGeneration,
} = gen;

const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

// 打开即按 URL 上的 action 自动启动（至多一次）；图库/上下文未就绪时由内部 watch 复查。
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void maybeAutoStartGeneration();
  window.addEventListener("keydown", onKeydown);
  void nextTick(() => {
    closeButton.value?.focus();
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  // 关闭后焦点恢复：回到打开对话框前聚焦的元素。
  previousFocus?.focus?.();
});

// 切选题（key 变化触发重挂载）时旧结果不残留：对话框按 v-if + key 每次全新挂载。
watch(
  () => props.ideaIndex,
  () => {
    // 组件以 key=ideaIndex 渲染，正常情况下不会走到这里；防御性兜底。
    emit("close");
  },
);

function close(): void {
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  // 公众号比例提醒打开时先取消提醒，再关闭对话框。
  if (wechatConfirm.value) {
    resolveWechatConfirm(null);
    return;
  }
  close();
}

function retryDisabled(): boolean {
  return busy.value || productLibraryBlocked.value;
}

function actionLabel(action: IdeaGenerationAction): string {
  if (action === "moments") return "朋友圈图";
  if (action === "wechat") return "公众号长图";
  if (action === "xhsCarousel") return "小红书组图";
  return "风格化图";
}

// —— 共享改图面板：朋友圈图 / 公众号长图 / 风格化图结果继续改图 ——
const editOpenFor = ref<"moments" | "wechat" | "styleImage" | null>(null);

function resultAspectRatio(kind: "moments" | "wechat" | "styleImage", fallback?: string): string {
  if (fallback && IMAGE_ASPECT_RATIOS.includes(fallback)) return fallback;
  const selected = String(aspectRatioSelection.value || "smart");
  if (IMAGE_ASPECT_RATIOS.includes(selected)) return selected;
  return SMART_ASPECT_RATIO_DEFAULTS[kind] || "3:4";
}

const editTarget = computed<ImageEditTarget | null>(() => {
  if (editOpenFor.value === "moments" && momentsResult.value) {
    return {
      imageUrl: String(momentsResult.value.imageUrl || momentsResult.value.previewUrl || ""),
      title: String(momentsResult.value.title || ""),
      aspectRatio: resultAspectRatio("moments", String(momentsResult.value.aspectRatio || "")),
      generationId: Number(momentsResult.value.generationId || 0) || null,
    };
  }
  if (editOpenFor.value === "wechat" && wechatResult.value) {
    return {
      imageUrl: String(wechatResult.value.imageUrl || wechatResult.value.previewUrl || ""),
      title: String(wechatResult.value.title || wechatResult.value.publishTitle || ""),
      aspectRatio: resultAspectRatio("wechat", String(wechatResult.value.aspectRatio || "")),
      generationId: Number(wechatResult.value.generationId || 0) || null,
    };
  }
  if (editOpenFor.value === "styleImage" && styleResult.value) {
    return {
      imageUrl: String(styleResult.value.imageUrl || styleResult.value.previewUrl || ""),
      title: String(styleResult.value.title || "风格化图片"),
      aspectRatio: resultAspectRatio("styleImage", String(styleResult.value.aspectRatio || "")),
      generationId: Number(styleResult.value.generationId || 0) || null,
    };
  }
  return null;
});

function onEdited(): void {
  void afterGenerationSuccess();
}
</script>

<template>
  <div class="idea-generation-backdrop" data-test="idea-generation-dialog" @click.self="close">
    <section class="idea-generation-panel" role="dialog" aria-modal="true" aria-labelledby="ideaGenerationTitle">
      <header class="idea-generation-head">
        <div>
          <div class="idea-generation-kicker">内容选题生成</div>
          <h2 id="ideaGenerationTitle">{{ idea?.title || "生图任务" }}</h2>
          <p class="idea-generation-context" data-test="idea-generation-context">
            {{ brand?.name || "品牌" }} × {{ trend?.title || "趋势" }} ·
            <span class="idea-generation-action" data-test="idea-generation-action">{{ actionLabel(props.action) }}</span>
          </p>
        </div>
        <button
          ref="closeButton"
          type="button"
          class="secondary-btn"
          data-test="idea-generation-close"
          @click="close"
        >
          关闭
        </button>
      </header>

      <p v-if="contextError" class="job-error" data-test="context-error">{{ contextError }}</p>

      <div v-if="productImagesError" class="job-error" data-test="product-images-error">
        <span>{{ productImagesError }}</span>
        <button type="button" class="secondary-btn" data-test="retry-product-images" @click="retryProductImagesLoad">
          重新加载产品图
        </button>
      </div>

      <p v-if="genStatus" class="job-status" data-test="gen-status">{{ genStatus }}</p>
      <p v-if="genError" class="job-error" data-test="gen-error">{{ genError }}</p>
      <div v-if="genError && genKind" class="idea-generation-retry">
        <button type="button" class="primary-btn" data-test="gen-retry" :disabled="retryDisabled()" @click="retryGeneration">
          重试
        </button>
      </div>

      <!-- 朋友圈图结果 -->
      <div v-if="genKind === 'moments' && momentsResult" class="gen-result" data-test="moments-result">
        <h3>{{ momentsResult.title }}</h3>
        <p><strong>朋友圈文案：</strong>{{ momentsResult.caption || "" }}</p>
        <figure v-if="safeImageSrc(momentsResult.imageUrl || momentsResult.previewUrl)">
          <img
            :src="safeImageSrc(momentsResult.imageUrl || momentsResult.previewUrl)"
            :alt="String(momentsResult.title || '')"
            loading="lazy"
            decoding="async"
          />
        </figure>
        <div class="meta-item"><span>视觉方向</span><div>{{ momentsResult.visualDirection }}</div></div>
        <div class="meta-item"><span>风格</span><div>{{ momentsResult.style }}</div></div>
        <div class="meta-item"><span>构图建议</span><div>{{ momentsResult.composition }}</div></div>
        <button
          type="button"
          class="secondary-btn"
          data-test="edit-moments-result"
          @click="editOpenFor = editOpenFor === 'moments' ? null : 'moments'"
        >
          {{ editOpenFor === "moments" ? "收起改图" : "继续改图" }}
        </button>
        <ImageEditPanel v-if="editOpenFor === 'moments'" :target="editTarget" @edited="onEdited" />
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
          <img
            :src="safeImageSrc(wechatResult.imageUrl || wechatResult.previewUrl)"
            :alt="String(wechatResult.title || '')"
            loading="lazy"
            decoding="async"
          />
        </figure>
        <button
          type="button"
          class="secondary-btn"
          data-test="edit-wechat-result"
          @click="editOpenFor = editOpenFor === 'wechat' ? null : 'wechat'"
        >
          {{ editOpenFor === "wechat" ? "收起改图" : "继续改图" }}
        </button>
        <ImageEditPanel v-if="editOpenFor === 'wechat'" :target="editTarget" @edited="onEdited" />
      </div>

      <!-- 风格化图结果 -->
      <div v-if="genKind === 'styleImage' && styleResult" class="gen-result" data-test="style-result">
        <h3>{{ styleResult.title || "风格化图片" }}</h3>
        <figure v-if="safeImageSrc(styleResult.imageUrl || styleResult.previewUrl)">
          <img
            :src="safeImageSrc(styleResult.imageUrl || styleResult.previewUrl)"
            :alt="String(styleResult.title || '风格化图片')"
            loading="lazy"
            decoding="async"
          />
        </figure>
        <button
          type="button"
          class="secondary-btn"
          data-test="edit-style-result"
          @click="editOpenFor = editOpenFor === 'styleImage' ? null : 'styleImage'"
        >
          {{ editOpenFor === "styleImage" ? "收起改图" : "继续改图" }}
        </button>
        <ImageEditPanel v-if="editOpenFor === 'styleImage'" :target="editTarget" @edited="onEdited" />
      </div>

      <!-- 小红书组图 -->
      <div v-if="genKind === 'xhsCarousel' && carousel.pack" class="gen-result" data-test="xhs-result">
        <div class="carousel-head">
          <h3>{{ carousel.pack.title || "小红书组图" }}</h3>
          <button
            type="button"
            class="secondary-btn"
            data-test="generate-xhs-all"
            :disabled="busy"
            @click="generateAllCarouselSlides"
          >
            一键生成全部
          </button>
        </div>
        <ul class="carousel-slides">
          <li
            v-for="(slide, index) in carousel.pack.slides"
            :key="index"
            class="carousel-slide"
            :data-test="`xhs-slide-${index}`"
          >
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
              <img
                :src="safeImageSrc(slide.imageUrl || slide.previewUrl)"
                :alt="slide.pageLabel || ''"
                loading="lazy"
                decoding="async"
              />
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
    </section>
  </div>

  <!-- 公众号长图比例提醒 -->
  <div v-if="wechatConfirm" class="wechat-warning-backdrop" data-test="wechat-warning">
    <section class="wechat-warning-dialog" role="dialog" aria-modal="true">
      <h2>当前选择的是 {{ wechatConfirm.aspectRatio }}</h2>
      <p>公众号长图推荐使用 9:21。继续使用 {{ wechatConfirm.aspectRatio }} 可能影响长图的阅读体验和版式完整性。</p>
      <label class="wechat-warning-check">
        <input v-model="wechatDisableWarning" type="checkbox" />
        <span>不再提醒</span>
      </label>
      <div class="wechat-warning-actions">
        <button type="button" class="secondary-btn" data-test="wechat-warning-cancel" @click="resolveWechatConfirm(null)">取消</button>
        <button type="button" class="secondary-btn" data-test="wechat-warning-use-default" @click="resolveWechatConfirm('9:21')">改用 9:21</button>
        <button type="button" class="primary-btn" data-test="wechat-warning-continue" @click="resolveWechatConfirm(wechatConfirm.aspectRatio)">
          继续使用 {{ wechatConfirm.aspectRatio }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.idea-generation-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.idea-generation-panel {
  position: relative;
  width: min(760px, 100%);
  max-height: min(92vh, 960px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  overflow-x: hidden;
  overflow-y: auto;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.idea-generation-panel::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.idea-generation-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--workspace-border);
}

.idea-generation-kicker {
  color: var(--workspace-brand-ink);
  font-size: 0.78rem;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.idea-generation-head h2 {
  margin: 8px 0 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.35;
}

.idea-generation-context {
  margin: 8px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.88rem;
  line-height: 1.6;
}

.job-status,
.job-error {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--workspace-radius);
  font-size: 0.84rem;
  line-height: 1.6;
}

.job-status {
  border: 1px solid var(--workspace-border);
  background: rgba(255, 255, 255, 0.72);
  color: var(--workspace-text-muted);
}

.job-error {
  border: 1px solid rgba(180, 35, 24, 0.16);
  background: #fff1f1;
  color: #b42318;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.idea-generation-retry {
  display: flex;
  justify-content: flex-end;
}

.gen-result {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.gen-result h3 {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.15rem;
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
  max-width: min(100%, 560px);
  max-height: 560px;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.carousel-slides {
  list-style: none;
  margin: 0;
  padding: 0;
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
  margin: 0;
  color: var(--workspace-text-muted);
  font-size: 0.82rem;
  line-height: 1.65;
}

.slide-edit {
  display: grid;
  gap: 8px;
}

.form-field {
  display: grid;
  min-width: 0;
  gap: 7px;
  color: var(--workspace-text-body);
  font-size: 0.82rem;
  font-weight: 800;
}

.form-field textarea {
  width: 100%;
  min-width: 0;
  min-height: 64px;
  padding: 10px 12px;
  border: 1px solid var(--workspace-border-strong);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text);
  font: inherit;
  font-weight: 500;
  line-height: 1.65;
  resize: vertical;
  outline: none;
}

.form-field textarea:focus {
  border-color: rgba(229, 72, 77, 0.48);
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.08);
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

.wechat-warning-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgba(34, 24, 24, 0.14);
  backdrop-filter: blur(6px);
}

.wechat-warning-dialog {
  width: min(520px, 100%);
  padding: 28px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: var(--workspace-shadow-float);
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  color: var(--workspace-text-body);
}

.wechat-warning-check input {
  width: 17px;
  height: 17px;
  accent-color: var(--workspace-brand);
}

.wechat-warning-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
  padding-top: 6px;
}

@media (max-width: 760px) {
  .idea-generation-backdrop {
    padding: 12px;
    place-items: start center;
  }

  .idea-generation-panel {
    max-height: 94vh;
    padding: 18px;
  }

  .carousel-slides {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
