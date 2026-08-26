<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useInsightsStore } from "@/features/trends/stores/insights";
import {
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
  type StyleReferenceImage,
} from "../ideaCreativeSettings";
import { useIdeaVideoScript } from "../composables/useIdeaVideoScript";
import VideoScriptResult from "./VideoScriptResult.vue";
import {
  createVideoProject,
  fetchVideoProject,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATION_OPTIONS,
  type ProductImageInput,
  type VideoProject,
} from "../api";
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
const aspectRatioSelectionRef = ref(settings.value.aspectRatioSelection || "smart");
const videoDurationRef = ref(settings.value.videoDuration || "auto");
const videoModelRef = ref(settings.value.videoModel || "d2");
const videoModeRef = ref(settings.value.videoMode || "text");
const videoResolutionRef = ref(settings.value.videoResolution || "720p");
const useBrandLogoRef = computed(() => Boolean(settings.value.useBrandLogo && brand.value?.logo));
const useProductImagesRef = computed(() => settings.value.useProductImages !== false);

const project = ref<VideoProject | null>(null);
const projectLoading = ref(false);
const projectError = ref("");
const generatedVideoSignature = ref("");
let projectPollTimer: ReturnType<typeof setTimeout> | null = null;

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

const selectedVideoReferenceIds = computed(() => selectedProductImageInputs.value.map((image) => Number(image.id)).filter(Boolean));
const maxVideoReferences = computed(() => (videoModelRef.value === "g2" ? 5 : 9));
const visibleVideoDurationOptions = computed(() => VIDEO_DURATION_OPTIONS.filter((option) => ["auto", "10", "15", "30", "45", "60"].includes(option.value)));
const availableResolutions = computed(() => videoModelRef.value === "g2" ? ["720p"] : ["720p", "1080p", "2K"]);
const estimatedCredits = computed(() => {
  const total = videoDurationRef.value === "auto" ? Number(script.value?.totalDurationSec || 30) : Number(videoDurationRef.value);
  if (videoModelRef.value === "g2") {
    let remaining = total;
    let credits = 0;
    while (remaining > 0) {
      const duration = Math.min(10, remaining);
      credits += duration <= 5 ? 1 : 2;
      remaining -= duration;
    }
    return credits;
  }
  return total * ({ "720p": 2, "1080p": 3, "2K": 4 } as Record<string, number>)[videoResolutionRef.value];
});
const projectStatusLabel = computed(() => ({
  queued: "排队中",
  running: "生成中",
  partial_failed: "部分失败，可重试",
  completed: "已完成",
  failed: "生成失败",
}[project.value?.status || ""] || "已提交"));
const currentVideoSignature = computed(() => [
  videoModelRef.value,
  videoModeRef.value,
  videoResolutionRef.value,
  videoDurationRef.value,
  aspectRatioSelectionRef.value,
  selectedVideoReferenceIds.value.join(","),
].join("|"));
const controlsDirty = computed(() => Boolean(script.value && generatedVideoSignature.value && generatedVideoSignature.value !== currentVideoSignature.value));

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
  videoModel: videoModelRef,
  videoMode: videoModeRef,
  videoResolution: videoResolutionRef,
  videoReferenceImageIds: selectedVideoReferenceIds,
});

onMounted(() => {
  generateScript();
});

watch(script, (value) => {
  if (value) generatedVideoSignature.value = currentVideoSignature.value;
});

watch(videoModelRef, (model) => {
  if (model === "g2") videoResolutionRef.value = "720p";
  project.value = null;
});
watch([videoModeRef, videoResolutionRef, videoDurationRef, aspectRatioSelectionRef], () => {
  saveIdeaCreativeSettings(ideaKey.value, {
    ...settings.value,
    aspectRatioSelection: aspectRatioSelectionRef.value,
    videoDuration: videoDurationRef.value,
    videoModel: videoModelRef.value,
    videoMode: videoModeRef.value,
    videoResolution: videoResolutionRef.value,
  });
  project.value = null;
});

function projectRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `vp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stopProjectPolling() {
  if (projectPollTimer) clearTimeout(projectPollTimer);
  projectPollTimer = null;
}

async function pollProject(projectId: number) {
  try {
    const response = await fetchVideoProject(projectId);
    project.value = response.project;
    if (["completed", "failed", "partial_failed", "cancelled"].includes(response.project.status)) return;
    projectPollTimer = setTimeout(() => pollProject(projectId), 2500);
  } catch (error) {
    projectError.value = (error as Error).message || "暂时无法刷新视频状态。";
  }
}

async function generateRealVideo() {
  if (!script.value || !brand.value?.id || !trend.value?.id) return;
  if (controlsDirty.value) {
    projectError.value = "视频参数已变更，请先点击“重新生成”让脚本与当前参数同步。";
    return;
  }
  if (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length) {
    projectError.value = "图生视频需要先在内容设置中选择产品参考图。";
    return;
  }
  projectLoading.value = true;
  projectError.value = "";
  stopProjectPolling();
  try {
    const response = await createVideoProject(Number(brand.value.id), Number(trend.value.id), props.ideaIndex, {
      requestId: projectRequestId(),
      model: videoModelRef.value,
      mode: videoModeRef.value,
      resolution: videoResolutionRef.value,
      aspectRatio: aspectRatioSelectionRef.value === "smart" ? "9:16" : aspectRatioSelectionRef.value,
      totalDurationSec: videoDurationRef.value === "auto" ? Number(script.value.totalDurationSec || 30) : Number(videoDurationRef.value),
      referenceAssetIds: selectedVideoReferenceIds.value.slice(0, maxVideoReferences.value),
      visualBible: script.value.visualBible || {},
      script: script.value,
    });
    project.value = response.project;
    if (project.value.status !== "completed") await pollProject(project.value.id);
  } catch (error) {
    projectError.value = (error as Error).message || "真实视频生成提交失败，请重试。";
  } finally {
    projectLoading.value = false;
  }
}

function handleRegenerate() {
  reset();
  generateScript();
}

function handleClose() {
  stopProjectPolling();
  emit("close");
}

onUnmounted(stopProjectPolling);
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
        <section class="video-studio-controls" data-test="video-studio-controls">
          <div class="studio-controls-heading">
            <div>
              <span class="control-eyebrow">AI 视频工作台</span>
              <h3>先定生成规则，再生成真实视频</h3>
            </div>
            <span class="estimate-pill">预计 {{ estimatedCredits }} 积分</span>
          </div>
          <div class="studio-control-grid">
            <label class="studio-field model-field">
              <span>视频模型</span>
              <span class="model-switch" role="radiogroup" aria-label="视频模型">
                <button type="button" :class="{ active: videoModelRef === 'd2' }" data-test="video-model-d2" @click="videoModelRef = 'd2'">D2</button>
                <button type="button" :class="{ active: videoModelRef === 'g2' }" data-test="video-model-g2" @click="videoModelRef = 'g2'">G2</button>
              </span>
            </label>
            <label class="studio-field">
              <span>生成方式</span>
              <select v-model="videoModeRef" data-test="video-mode-select">
                <option value="text">文生视频</option>
                <option value="image">图生视频</option>
              </select>
            </label>
            <label class="studio-field">
              <span>总时长</span>
              <select v-model="videoDurationRef" data-test="video-duration-select">
                <option v-for="option in visibleVideoDurationOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="studio-field">
              <span>画幅</span>
              <select v-model="aspectRatioSelectionRef" data-test="video-aspect-select">
                <option value="smart">智能竖屏（9:16）</option>
                <option v-for="ratio in VIDEO_ASPECT_RATIOS" :key="ratio" :value="ratio">{{ ratio }}</option>
              </select>
            </label>
            <label class="studio-field">
              <span>清晰度</span>
              <select v-model="videoResolutionRef" data-test="video-resolution-select">
                <option v-for="resolution in availableResolutions" :key="resolution" :value="resolution">{{ resolution }}</option>
              </select>
            </label>
          </div>
              <p class="reference-summary">
            {{ videoModeRef === 'image' ? `图生视频将使用 ${Math.min(selectedVideoReferenceIds.length, maxVideoReferences)} / ${maxVideoReferences} 张产品参考图，并先生成视觉理解 Bible。` : '文生视频将使用脚本中的主体、镜头和连续性约束。' }}
          </p>
          <p v-if="controlsDirty" class="stale-settings-warning" data-test="video-script-settings-stale">参数已变更，脚本尚未同步；请重新生成脚本后再生成真实视频。</p>
        </section>

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
          <section class="real-video-panel" data-test="real-video-panel">
            <div class="real-video-copy">
              <span class="control-eyebrow">下一步</span>
              <h3>生成真实视频</h3>
              <p>脚本已准备好。系统会按 {{ videoModelRef.toUpperCase() }} 的镜头规则排队生成，并自动保存到历史记录。</p>
              <p v-if="script.visualBible && Object.values(script.visualBible).some(Boolean)" class="bible-summary">视觉理解 Bible 已写入脚本，用于跨镜头保持主体、材质、色彩与光线一致。</p>
            </div>
            <button
              type="button"
              class="primary-btn generate-video-btn"
              data-test="generate-real-video"
              :disabled="projectLoading || controlsDirty"
              @click="generateRealVideo"
            >
              {{ projectLoading ? "提交中..." : "生成真实视频" }}
            </button>
          </section>
          <p v-if="projectError" class="project-error" data-test="video-project-error">{{ projectError }}</p>
          <section v-if="project" class="video-project-status" data-test="video-project-status">
            <div class="status-line">
              <strong>{{ projectStatusLabel }}</strong>
              <span>{{ project.model.toUpperCase() }} · {{ project.totalDurationSec }} 秒 · 已扣 {{ project.chargedCredits }} 积分</span>
            </div>
            <video v-if="project.finalVideoUrl" class="final-video-player" controls playsinline :src="project.finalVideoUrl"></video>
            <div v-else class="clip-progress-list">
              <span v-for="clip in project.clips" :key="clip.id" :class="['clip-progress', `clip-${clip.status}`]">
                镜头 {{ clip.index }}：{{ clip.status === 'completed' ? '完成' : clip.status === 'running' ? '生成中' : clip.status === 'failed' ? '失败' : '排队' }}
              </span>
            </div>
          </section>
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

.video-studio-controls {
  margin-bottom: 18px;
  padding: 16px 18px;
  border: 1px solid #eadfd8;
  border-radius: 12px;
  background: linear-gradient(135deg, #fffaf5, #fff);
}

.studio-controls-heading,
.status-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.studio-controls-heading h3,
.real-video-copy h3 {
  margin: 3px 0 0;
  color: var(--workspace-text, #31292b);
  font-size: 15px;
}

.control-eyebrow {
  color: var(--workspace-brand, #b6494e);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.estimate-pill {
  padding: 6px 10px;
  border-radius: 999px;
  background: #f7e6d8;
  color: #8a4e2d;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.studio-control-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.studio-field {
  display: grid;
  gap: 6px;
  color: #6d5e60;
  font-size: 12px;
  font-weight: 700;
}

.studio-field select {
  min-height: 36px;
  padding: 0 9px;
  border: 1px solid #e2d7d1;
  border-radius: 7px;
  background: #fff;
  color: #362d2f;
  font-size: 12px;
}

.model-field {
  grid-column: span 1;
}

.model-switch {
  display: flex;
  min-height: 36px;
  padding: 3px;
  border: 1px solid #e2d7d1;
  border-radius: 7px;
  background: #fff;
}

.model-switch button {
  flex: 1;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #7c7074;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.model-switch button.active {
  background: #7c2d32;
  color: white;
}

.reference-summary {
  margin: 12px 0 0;
  color: #806e70;
  font-size: 12px;
  line-height: 1.5;
}

.stale-settings-warning {
  margin: 8px 0 0;
  color: #a45f28;
  font-size: 12px;
  line-height: 1.5;
}

.real-video-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  padding: 16px 18px;
  border: 1px solid #e5d8d3;
  border-radius: 12px;
  background: #fffaf8;
}

.real-video-copy p {
  margin: 6px 0 0;
  color: #6d5e60;
  font-size: 12.5px;
  line-height: 1.5;
}

.real-video-copy .bible-summary {
  color: #8a4e2d;
}

.generate-video-btn {
  flex: 0 0 auto;
  min-height: 42px;
  padding: 0 20px;
}

.project-error {
  margin: 10px 0 0;
  color: #b72e3a;
  font-size: 13px;
}

.video-project-status {
  margin-top: 12px;
  padding: 13px 15px;
  border: 1px solid #e5d8d3;
  border-radius: 10px;
  background: #fff;
}

.status-line {
  color: #806e70;
  font-size: 12px;
}

.status-line strong {
  color: #7c2d32;
}

.clip-progress-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.clip-progress {
  padding: 5px 8px;
  border-radius: 999px;
  background: #f5efeb;
  color: #806e70;
  font-size: 11px;
}

.clip-completed {
  background: #eaf6ee;
  color: #2c7547;
}

.clip-failed {
  background: #fff0ed;
  color: #b72e3a;
}

.final-video-player {
  display: block;
  width: min(100%, 520px);
  max-height: 460px;
  margin: 12px auto 0;
  border-radius: 9px;
  background: #1f1b1b;
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

@media (max-width: 840px) {
  .studio-control-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .real-video-panel {
    align-items: flex-start;
    flex-direction: column;
  }
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
