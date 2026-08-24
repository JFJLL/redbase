<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useInsightsStore } from "@/features/trends/stores/insights";
import {
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  type StyleReferenceImage,
} from "../ideaCreativeSettings";
import { useIdeaVideoScript } from "../composables/useIdeaVideoScript";
import VideoScriptResult from "./VideoScriptResult.vue";
import type { ProductImageInput } from "../api";
import type { IdeaProductLibrary } from "../composables/useIdeaGeneration";

const props = defineProps<{
  ideaIndex: number;
  productLibrary?: IdeaProductLibrary;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const store = useInsightsStore();
const brand = computed(() => store.selectedBrand);
const trend = computed(() => store.selectedTrend);

const ideaKey = computed(() =>
  getIdeaSettingsKey(brand.value?.id, trend.value?.id, props.ideaIndex),
);

const settings = computed(() => getIdeaCreativeSettings(ideaKey.value));

const brandIdRef = computed(() => brand.value?.id);
const trendIdRef = computed(() => trend.value?.id);
const ideaIndexRef = computed(() => props.ideaIndex);
const aspectRatioSelectionRef = computed(() => settings.value.aspectRatioSelection || "smart");
const videoDurationRef = computed(() => settings.value.videoDuration || "auto");
const useBrandLogoRef = computed(() => Boolean(settings.value.useBrandLogo && brand.value?.logo));
const useProductImagesRef = computed(() => settings.value.useProductImages !== false);

const selectedProductImageInputs = computed<ProductImageInput[]>(() => {
  if (!useProductImagesRef.value) return [];
  const libraryImages = props.productLibrary?.images.value || [];
  const selectedIds = settings.value.selectedProductIds || [];
  return libraryImages
    .filter((img) => selectedIds.includes(img.id))
    .map((img) => ({ id: img.id, name: img.originalName }));
});

const selectedStyleReferenceInputs = computed<Array<{ name?: string; dataUrl?: string }>>(() => {
  const styleRef = settings.value.styleReference as StyleReferenceImage | null;
  if (!styleRef?.dataUrl) return [];
  return [{ name: styleRef.fileName, dataUrl: styleRef.dataUrl }];
});

const {
  loading,
  error,
  script,
  generateScript,
  retry,
  reset,
} = useIdeaVideoScript({
  brandId: brandIdRef,
  trendId: trendIdRef,
  ideaIndex: ideaIndexRef,
  aspectRatioSelection: aspectRatioSelectionRef,
  videoDuration: videoDurationRef,
  useBrandLogo: useBrandLogoRef,
  useProductImages: useProductImagesRef,
  selectedProductImageInputs,
  selectedStyleReferenceInputs,
});

onMounted(() => {
  generateScript();
});

function handleRegenerate() {
  reset();
  generateScript();
}

function handleClose() {
  emit("close");
}
</script>

<template>
  <div class="video-script-backdrop" data-test="idea-video-script-dialog" @click.self="handleClose">
    <section
      class="video-script-dialog-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="videoScriptDialogTitle"
    >
      <header class="dialog-header">
        <div class="dialog-title-group">
          <span class="dialog-badge">AI 视频脚本</span>
          <h2 id="videoScriptDialogTitle" class="dialog-title">一键生成脚本</h2>
        </div>
        <button
          type="button"
          class="dialog-close-btn"
          data-test="video-script-dialog-close"
          aria-label="关闭视频脚本弹窗"
          @click="handleClose"
        >
          ×
        </button>
      </header>

      <div class="dialog-body">
        <div v-if="loading" class="dialog-loading-state" data-test="video-script-loading">
          <div class="loading-spinner" aria-hidden="true"></div>
          <h3>正在生成 AI 视频脚本与分镜提示词...</h3>
          <p>AI 正在结合品牌定位、选题视角与参考素材，生成可直接复制给视频模型的结构化提示词。</p>
          <small class="loading-hint">仅生成文字分镜与视频生成提示词，不产生实际视频。</small>
        </div>

        <div v-else-if="error" class="dialog-error-state" data-test="video-script-error">
          <div class="error-icon" aria-hidden="true">!</div>
          <h3>视频脚本生成失败</h3>
          <p class="error-text">{{ error }}</p>
          <div class="error-actions">
            <button
              type="button"
              class="primary-btn"
              data-test="video-script-retry"
              @click="retry"
            >
              重新尝试
            </button>
            <button
              type="button"
              class="secondary-btn"
              data-test="video-script-cancel"
              @click="handleClose"
            >
              取消并关闭
            </button>
          </div>
        </div>

        <div v-else-if="script" class="dialog-result-state">
          <VideoScriptResult
            :script="script"
            :show-actions="true"
            :show-regenerate="true"
            @regenerate="handleRegenerate"
            @close="handleClose"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.video-script-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(30, 20, 22, 0.48);
  backdrop-filter: blur(3px);
  overflow-y: auto;
}

.video-script-dialog-panel {
  width: min(1180px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border-radius: var(--workspace-radius, 12px);
  border: 1px solid var(--workspace-border, #eae5e3);
  background: #fffdfc;
  color: var(--workspace-text, #222);
  box-shadow: 0 24px 64px rgba(45, 25, 30, 0.2);
  overflow: hidden;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--workspace-border, #eae5e3);
  background: var(--workspace-surface, #ffffff);
}

.dialog-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dialog-badge {
  padding: 3px 8px;
  border-radius: 4px;
  background: #f3e7e2;
  color: var(--workspace-brand-ink, #7c2d32);
  font-size: 12px;
  font-weight: 700;
}

.dialog-title {
  margin: 0;
  font-size: 1.25rem;
  color: var(--workspace-text, #222);
}

.dialog-close-btn {
  border: none;
  background: transparent;
  color: var(--workspace-text-muted, #7c7074);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.dialog-close-btn:hover {
  background: #f4edea;
  color: var(--workspace-brand, #d83b46);
}

.dialog-body {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  min-height: 240px;
}

.dialog-loading-state,
.dialog-error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  gap: 12px;
}

.loading-spinner {
  width: 42px;
  height: 42px;
  border: 3px solid #f3dedb;
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.dialog-loading-state h3 {
  margin: 8px 0 0;
  font-size: 1.15rem;
  color: var(--workspace-text, #222);
}

.dialog-loading-state p {
  margin: 0;
  color: var(--workspace-text-muted, #6d4d51);
  font-size: 14px;
  max-width: 540px;
  line-height: 1.6;
}

.loading-hint {
  color: #a87d82;
  font-size: 12.5px;
}

.error-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #fdf0ee;
  color: #b72e3a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
}

.dialog-error-state h3 {
  margin: 0;
  font-size: 1.15rem;
  color: #b72e3a;
}

.error-text {
  margin: 0;
  color: #5a4b4e;
  font-size: 14px;
  max-width: 500px;
  line-height: 1.6;
}

.error-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.primary-btn,
.secondary-btn {
  min-height: 38px;
  padding: 0 18px;
  border-radius: 6px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}

.primary-btn {
  border: none;
  background: var(--workspace-brand, #d83b46);
  color: #fff;
}

.secondary-btn {
  border: 1px solid var(--workspace-border, #eae5e3);
  background: #fff;
  color: var(--workspace-text, #333);
}
</style>
