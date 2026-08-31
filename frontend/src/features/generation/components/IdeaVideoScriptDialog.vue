<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { trackAnalyticsEvent } from "@/shared/analytics/tracker";
import { useAuthStore } from "@/shared/stores/auth";
import { useGenerationTasksStore } from "../stores/generationTasks";
import { useHistoryStore } from "@/features/history/stores/history";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import { useInsightsStore } from "@/features/trends/stores/insights";
import {
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
  type StyleReferenceImage,
} from "../ideaCreativeSettings";
import { useIdeaVideoScript } from "../composables/useIdeaVideoScript";
import StudioSelect from "./StudioSelect.vue";
import VideoScriptResult from "./VideoScriptResult.vue";
import {
  createVideoProject,
  fetchActiveVideoProjects,
  fetchVideoModelCapabilities,
  fetchVideoProject,
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  retryVideoProjectClip,
  retryVideoProjectClipResult,
  retryVideoProjectAssembly,
  uploadProductImage,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATION_OPTIONS,
  type ProductImageInput,
  type ProductImageView,
  type VideoModelCapability,
  type VideoProject,
} from "../api";
import type { GenerationHistoryItem } from "@/features/history/api";
import type { IdeaProductLibrary } from "../composables/useIdeaGeneration";

const FALLBACK_VIDEO_CAPABILITIES: VideoModelCapability[] = [
  {
    id: "d2",
    displayName: "D2",
    provider: "fallback",
    supportedModes: ["text", "image"],
    resolutions: ["720p", "1080p", "2K"],
    aspectRatios: [...VIDEO_ASPECT_RATIOS],
    totalDurationOptions: [10, 15, 30, 45, 60],
    clipDurationRules: { min: 4, max: 15 },
    preferredClipDurations: [10, 5],
    maxReferenceImages: 9,
    pricing: { "720p": 2, "1080p": 3, "2K": 4 },
    pricingUnit: "per_second",
  },
  {
    id: "g2",
    displayName: "G2",
    provider: "fallback",
    supportedModes: ["text", "image"],
    resolutions: ["720p"],
    aspectRatios: [...VIDEO_ASPECT_RATIOS],
    totalDurationOptions: [10, 15, 30, 45, 60],
    allowedClipDurations: [5, 10],
    clipDurationRules: { min: 5, max: 10 },
    preferredClipDurations: [10, 5],
    maxReferenceImages: 5,
    pricing: { "5": 1, "10": 2 },
    pricingUnit: "per_clip",
    promotionLabel: "限时特惠",
  },
];

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
const videoAspectRatioRef = ref(settings.value.videoAspectRatio || "smart");
const videoDurationRef = ref(settings.value.videoDuration || "auto");
const videoModelRef = ref(settings.value.videoModel || "g2");
const videoModeRef = ref(settings.value.videoMode || "text");
const videoResolutionRef = ref(settings.value.videoResolution || "720p");
const useBrandLogoRef = computed(() => Boolean(settings.value.useBrandLogo && brand.value?.logo));
const initialVideoReferenceIds = Array.isArray(settings.value.videoReferenceImageIds)
  ? settings.value.videoReferenceImageIds
  : [];
const videoReferenceImageIdsRef = ref<number[]>(normalizeImageIds(initialVideoReferenceIds));
const auth = useAuthStore();
const scope = useAbortScope();
const uploadedVideoReferenceImages = ref<ProductImageView[]>([]);
const videoCapabilities = ref<VideoModelCapability[]>([]);
const capabilitiesLoading = ref(false);
const capabilitiesError = ref("");
const videoReferenceUploadLoading = ref(false);
const videoScriptBlockedError = ref(
  videoModeRef.value === "image" && !videoReferenceImageIdsRef.value.length
    ? "图生视频必须先选择或上传至少一张视频参考图，再生成脚本。"
    : "",
);
const retryingClipIndex = ref<number | null>(null);
let disposed = false;
const createRequestIdRef = ref("");
const actionRequestIds = new Map<string, string>();

const project = ref<VideoProject | null>(null);
const projectLoading = ref(false);
const projectError = ref("");
const generatedVideoSignature = ref("");
type StudioStep = 1 | 2 | 3;
const currentStep = ref<StudioStep>(1);
const studioSteps = [
  { id: 1 as const, title: "生成设置", description: "选择模型与参数" },
  { id: 2 as const, title: "脚本分镜", description: "检查画面与节奏" },
  { id: 3 as const, title: "生成视频", description: "提交并跟踪成片" },
];
let projectPollTimer: ReturnType<typeof setTimeout> | null = null;

function applyProjectUpdate(next: VideoProject | null) {
  const previousRefunded = project.value ? Number(project.value.refundedCredits || 0) : 0;
  project.value = next;
  const nextRefunded = next ? Number(next.refundedCredits || 0) : 0;
  if (nextRefunded > previousRefunded) {
    void auth.refreshUser().catch(() => {});
  }
}

function mergeAuthUser(user?: typeof auth.user) {
  if (user) auth.user = { ...auth.user, ...user };
  else void auth.refreshUser().catch(() => {});
}

function normalizeImageIds(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
    : [];
}

const availableProductImages = computed<ProductImageView[]>(() => {
  const byId = new Map<number, ProductImageView>();
  for (const image of [...(props.productLibrary?.images.value || []), ...uploadedVideoReferenceImages.value]) {
    byId.set(Number(image.id), image);
  }
  return [...byId.values()];
});

const effectiveVideoCapabilities = computed(() =>
  videoCapabilities.value.length ? videoCapabilities.value : FALLBACK_VIDEO_CAPABILITIES,
);
const activeVideoCapability = computed(() =>
  effectiveVideoCapabilities.value.find((model) => model.id === videoModelRef.value) || effectiveVideoCapabilities.value[0],
);
const videoModelOptions = computed(() => effectiveVideoCapabilities.value);
const videoModelSelectOptions = computed(() => videoModelOptions.value.map((model) => ({
  value: model.id,
  label: model.displayName,
  badge: model.promotionLabel || undefined,
})));
const availableVideoModes = computed(() => activeVideoCapability.value?.supportedModes || ["text", "image"]);
const availableVideoRatios = computed(() => activeVideoCapability.value?.aspectRatios || [...VIDEO_ASPECT_RATIOS]);
const availableResolutions = computed(() => activeVideoCapability.value?.resolutions || ["720p"]);
const visibleVideoDurationOptions = computed(() => {
  const supported = new Set(activeVideoCapability.value?.totalDurationOptions || []);
  return VIDEO_DURATION_OPTIONS.filter((option) => option.value === "auto" || supported.has(Number(option.value)));
});
const videoModeSelectOptions = computed(() => availableVideoModes.value.map((mode) => ({
  value: mode,
  label: mode === "image" ? "图生视频" : "文生视频",
})));
const videoDurationSelectOptions = computed(() => visibleVideoDurationOptions.value.map((option) => ({
  value: option.value,
  label: option.label,
})));
const videoAspectSelectOptions = computed(() => [
  { value: "smart", label: "智能推荐" },
  ...availableVideoRatios.value.map((ratio) => ({ value: ratio, label: ratio })),
]);
const videoResolutionSelectOptions = computed(() => availableResolutions.value.map((resolution) => ({
  value: resolution,
  label: resolution,
})));

const selectedVideoReferenceImages = computed(() => {
  if (videoModeRef.value !== "image") return [];
  const selectedIds = new Set(videoReferenceImageIdsRef.value);
  return availableProductImages.value.filter((image) => selectedIds.has(Number(image.id)));
});
const maxVideoReferences = computed(() => Number(activeVideoCapability.value?.maxReferenceImages || 0));
const effectiveVideoReferenceIds = computed(() =>
  videoModeRef.value === "image" ? videoReferenceImageIdsRef.value.slice(0, maxVideoReferences.value) : [],
);
const selectedVideoReferenceIds = effectiveVideoReferenceIds;
const selectedProductImageInputs = computed<ProductImageInput[]>(() =>
  selectedVideoReferenceImages.value.map((image) => ({ id: image.id, name: image.originalName })),
);
// The numeric IDs are the authoritative image selection. The library may
// still be loading when the user clicks Generate, so do not turn a valid
// image-mode selection into `useProductImages: false` merely because its
// preview objects have not arrived yet.
const useVideoProductImagesRef = computed(() => effectiveVideoReferenceIds.value.length > 0);

function segmentVideoDuration(capability: VideoModelCapability, total: number): number[] {
  const min = Number(capability.clipDurationRules?.min || 1);
  const max = Number(capability.clipDurationRules?.max || min);
  const allowed = capability.allowedClipDurations?.map(Number);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (total <= max) {
    if (total < min || (allowed && !allowed.includes(total))) return [];
    return [total];
  }
  const clips: number[] = [];
  let remaining = total;
  const preferred = Number(capability.preferredClipDurations?.[0] || max);
  while (remaining > 0) {
    let next = Math.min(preferred, remaining);
    const after = remaining - next;
    if (after > 0 && after < min) next -= min - after;
    if (next < min || next > max || (allowed && !allowed.includes(next))) return [];
    clips.push(next);
    remaining -= next;
  }
  return clips;
}

const estimatedCredits = computed(() => {
  const capability = activeVideoCapability.value;
  if (!capability) return 0;
  const total = videoDurationRef.value === "auto" ? Number(script.value?.totalDurationSec || 30) : Number(videoDurationRef.value);
  const clips = segmentVideoDuration(capability, total);
  if (!clips.length) return 0;
  if (capability.pricingUnit === "per_clip") {
    return clips.reduce((sum, duration) => sum + Number(capability.pricing[String(duration)] || 0), 0);
  }
  const price = Number(capability.pricing[String(videoResolutionRef.value)] || 0);
  return clips.reduce((sum, duration) => sum + duration * price, 0);
});

const projectStatusLabel = computed(() => ({
  queued: "生成中",
  running: "生成中",
  processing_result: "正在处理生成结果",
  result_processing_failed: "生成结果暂未保存成功",
  project_data_failed: "视频项目素材不可用",
  partial_failed: "部分失败，可重试",
  uncertain: "待确认，需操作",
  waiting_configuration: "等待生成通道配置",
  assembling: "正在拼接成片",
  assembly_failed: "片段已完成，成片拼接失败",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
}[project.value?.status || ""] || "已提交"));

const isProjectGenerating = computed(() => {
  const s = String(project.value?.status || "").toLowerCase();
  return ["queued", "running", "processing_result", "assembling", "preparing", "submitting"].includes(s);
});

function isClipActivelyGenerating(status: unknown): boolean {
  return ["running", "submitting", "processing_result", "preparing"].includes(String(status || ""));
}

function isClipWaiting(status: unknown): boolean {
  return ["waiting_dependency", "waiting_configuration", "queued"].includes(String(status || ""));
}

function clipStatusLabel(status: unknown): string {
  const s = String(status || "");
  const map: Record<string, string> = {
    completed: "完成",
    running: "生成中",
    processing_result: "正在处理生成结果",
    result_processing_failed: "生成结果暂未保存成功",
    submitting: "提交中",
    failed: "失败",
    uncertain_submission: "待确认",
    waiting_configuration: "等待生成通道",
    waiting_dependency: "等待上一镜头",
    cancelled: "已取消",
    queued: "排队",
  };
  return map[s] || "生成中";
}

const TERMINAL_PROJECT_POLL_STATUSES = new Set([
  "completed",
  "failed",
  "partial_failed",
  "cancelled",
  "assembly_failed",
  "uncertain",
  "result_processing_failed",
  "project_data_failed",
]);
const currentVideoSignature = computed(() => [
  videoModelRef.value,
  videoModeRef.value,
  videoDurationRef.value,
  videoAspectRatioRef.value,
  selectedVideoReferenceIds.value.join(","),
].join("|"));
const controlsDirty = computed(() => Boolean(script.value && generatedVideoSignature.value && generatedVideoSignature.value !== currentVideoSignature.value));

const selectedStyleReferenceInputs = computed<Array<{ name?: string; dataUrl?: string }>>(() => {
  const styleRef = settings.value.styleReference as StyleReferenceImage | null;
  if (!styleRef?.dataUrl) return [];
  return [{ name: styleRef.fileName, dataUrl: styleRef.dataUrl }];
});

const {
  loading,
  error,
  script,
  generation,
  generateScript,
  restoreScript,
  reset,
} = useIdeaVideoScript({
  brandId: brandIdRef,
  trendId: trendIdRef,
  ideaIndex: ideaIndexRef,
  aspectRatioSelection: videoAspectRatioRef,
  videoDuration: videoDurationRef,
  useBrandLogo: useBrandLogoRef,
  useProductImages: useVideoProductImagesRef,
  selectedProductImageInputs,
  selectedStyleReferenceInputs,
  videoModel: videoModelRef,
  videoMode: videoModeRef,
  videoResolution: videoResolutionRef,
  videoReferenceImageIds: selectedVideoReferenceIds,
});

const scriptCompatible = computed(() => {
  const capability = activeVideoCapability.value;
  const currentScript = script.value;
  if (!capability || !currentScript) return true;
  const scriptRatio = currentScript.aspectRatio;
  const totalDuration = Number(currentScript.totalDurationSec);
  const selectedDuration = videoDurationRef.value === "auto" ? totalDuration : Number(videoDurationRef.value);
  const expectedDurations = segmentVideoDuration(capability, selectedDuration);
  const clips = currentScript.clips || [];
  if (!capability.aspectRatios.includes(scriptRatio)) return false;
  if (videoAspectRatioRef.value !== "smart" && scriptRatio !== videoAspectRatioRef.value) return false;
  if (!Number.isFinite(totalDuration) || totalDuration !== selectedDuration || !expectedDurations.length) return false;
  if (clips.length !== expectedDurations.length) return false;
  let expectedStart = 0;
  return clips.every((clip, index) => {
    const duration = Number(clip.durationSec);
    const start = Number(clip.startSec);
    const end = Number(clip.endSec);
    const valid = duration === expectedDurations[index] && start === expectedStart && end === expectedStart + duration;
    expectedStart = end;
    return valid;
  }) && expectedStart === selectedDuration;
});

function canEnterStep(step: StudioStep): boolean {
  if (step === 1) return true;
  if (step === 2) return Boolean(script.value || loading.value || error.value || videoScriptBlockedError.value);
  return Boolean(script.value && !controlsDirty.value && scriptCompatible.value);
}

function goToStep(step: StudioStep) {
  if (canEnterStep(step)) currentStep.value = step;
}

function goPreviousStep() {
  if (currentStep.value > 1) currentStep.value = (currentStep.value - 1) as StudioStep;
}

const primaryStepLabel = computed(() => {
  if (currentStep.value === 1) {
    if (loading.value) return "脚本生成中…";
    if (script.value && !controlsDirty.value) return "查看脚本，下一步";
    return script.value ? "重新生成脚本并继续 · 1积分" : "生成脚本并进入下一步 · 1积分";
  }
  if (currentStep.value === 2) {
    if (loading.value) return "脚本生成中…";
    if (error.value) return "重新尝试生成脚本 · 1积分";
    if (script.value && (controlsDirty.value || !scriptCompatible.value)) return "重新生成脚本并继续 · 1积分";
    return script.value ? "确认脚本，下一步" : "返回生成设置";
  }
  if (projectLoading.value) return "提交中…";
  if (project.value) return "视频已提交";
  return `生成真实视频 · ${estimatedCredits.value}积分`;
});

const primaryStepDisabled = computed(() => {
  if (currentStep.value === 1) {
    return loading.value || Boolean(project.value) || (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length);
  }
  if (currentStep.value === 2) return loading.value || (!script.value && !error.value);
  return projectLoading.value || Boolean(project.value) || !script.value || controlsDirty.value || !scriptCompatible.value || !generation.value?.id;
});

const primaryStepTestId = computed(() => {
  if (currentStep.value === 1) {
    return videoScriptBlockedError.value ? "video-script-generate-after-reference" : "video-script-generate";
  }
  if (currentStep.value === 2) return error.value ? "video-script-retry" : "video-step-next";
  return "generate-real-video";
});

async function handlePrimaryStepAction() {
  if (primaryStepDisabled.value) return;
  if (currentStep.value === 1) {
    if (script.value && !controlsDirty.value) currentStep.value = 2;
    else if (script.value) handleRegenerate();
    else await generateScriptWhenReady();
    return;
  }
  if (currentStep.value === 2) {
    if (error.value) await handleRetry();
    else if (script.value && (controlsDirty.value || !scriptCompatible.value)) handleRegenerate();
    else if (script.value) currentStep.value = 3;
    else currentStep.value = 1;
    return;
  }
  await generateRealVideo();
}

function applyVideoCapabilityDefaults() {
  if (project.value) return;
  const capability = activeVideoCapability.value;
  if (!capability) return;
  if (!capability.supportedModes.includes(videoModeRef.value)) {
    videoModeRef.value = capability.supportedModes[0] || "text";
  }
  if (!capability.resolutions.includes(videoResolutionRef.value)) {
    videoResolutionRef.value = capability.resolutions[0] || "720p";
  }
  if (videoAspectRatioRef.value !== "smart" && !capability.aspectRatios.includes(videoAspectRatioRef.value)) {
    videoAspectRatioRef.value = capability.aspectRatios.includes("9:16") ? "9:16" : (capability.aspectRatios[0] || "9:16");
  }
  if (videoDurationRef.value !== "auto" && !capability.totalDurationOptions.includes(Number(videoDurationRef.value))) {
    videoDurationRef.value = "auto";
  }
  videoReferenceImageIdsRef.value = normalizeImageIds(videoReferenceImageIdsRef.value).slice(0, capability.maxReferenceImages);
}

async function loadVideoCapabilities() {
  capabilitiesLoading.value = true;
  capabilitiesError.value = "";
  try {
    const response = await fetchVideoModelCapabilities(scope.signalFor("video-capabilities"));
    const models = Array.isArray(response.models) ? response.models.filter((model) => model && model.id) : [];
    if (models.length) {
      videoCapabilities.value = models;
      if (!project.value && !models.some((model) => model.id === videoModelRef.value)) videoModelRef.value = models[0].id;
    } else {
      capabilitiesError.value = "暂时无法读取视频模型能力，已使用安全默认值。";
    }
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      auth.handleUnauthorized();
      return;
    }
    capabilitiesError.value = "暂时无法读取视频模型能力，已使用安全默认值。";
  } finally {
    capabilitiesLoading.value = false;
  }
  applyVideoCapabilityDefaults();
}

onMounted(() => {
  trackAnalyticsEvent("video_studio_opened", { page: "video_studio" });
  void (async () => {
    await restoreActiveProject();
    if (!disposed) await loadVideoCapabilities();
  })();
});

watch(currentStep, (step) => {
  trackAnalyticsEvent("video_step_viewed", { step: String(step) }, { dedupeKey: `video_step:${step}` });
}, { immediate: true });

watch(videoModelRef, () => {
  applyVideoCapabilityDefaults();
});
watch([videoModeRef, videoResolutionRef, videoDurationRef, videoAspectRatioRef, videoReferenceImageIdsRef, selectedVideoReferenceIds], () => {
  saveIdeaCreativeSettings(ideaKey.value, {
    ...settings.value,
    videoDuration: videoDurationRef.value,
    videoModel: videoModelRef.value,
    videoMode: videoModeRef.value,
    videoResolution: videoResolutionRef.value,
    videoAspectRatio: videoAspectRatioRef.value,
    videoReferenceImageIds: [...videoReferenceImageIdsRef.value],
  });
  if (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length) {
    videoScriptBlockedError.value = "图生视频必须先选择或上传至少一张视频参考图，再生成脚本。";
  } else {
    videoScriptBlockedError.value = "";
  }
}, { deep: true });

async function generateScriptWhenReady() {
  if (project.value) {
    projectError.value = "当前视频项目已创建，生成参数已锁定。请先关闭工作台后再创建新视频。";
    return null;
  }
  if (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length) {
    videoScriptBlockedError.value = "图生视频必须先选择或上传至少一张视频参考图，再生成脚本。";
    return null;
  }
  videoScriptBlockedError.value = "";
  const requestSignature = currentVideoSignature.value;
  currentStep.value = 2;
  const generated = await generateScript();
  if (generated) generatedVideoSignature.value = requestSignature;
  return generated;
}

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `vp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createProjectRequestId() {
  if (!createRequestIdRef.value) createRequestIdRef.value = newRequestId();
  return createRequestIdRef.value;
}

function actionRequestId(action: string) {
  if (!actionRequestIds.has(action)) actionRequestIds.set(action, newRequestId());
  return actionRequestIds.get(action)!;
}

function stopProjectPolling() {
  if (projectPollTimer) clearTimeout(projectPollTimer);
  projectPollTimer = null;
}

async function restoreActiveProject() {
  if (!brand.value?.id || !trend.value?.id || disposed) return;
  try {
    const response = await fetchActiveVideoProjects({
      brandId: Number(brand.value.id),
      trendId: Number(trend.value.id),
      ideaIndex: props.ideaIndex,
    }, scope.signalFor("video-project-active"));
    const existing = response.projects?.[0];
    if (!existing || disposed) return;
    applyProjectUpdate(existing);
    currentStep.value = 3;
    videoModelRef.value = existing.model;
    videoModeRef.value = existing.mode;
    videoResolutionRef.value = existing.resolution;
    videoDurationRef.value = String(existing.totalDurationSec);
    videoAspectRatioRef.value = existing.aspectRatio;
    videoReferenceImageIdsRef.value = normalizeImageIds(existing.referenceAssetIds);
    const restoredGeneration = existing.scriptGenerationId
      ? {
          id: existing.scriptGenerationId,
          type: "videoScript",
          brandId: existing.brandId,
          ideaTitle: existing.script?.title || "",
          payload: {
            requestId: `restored-project-${existing.id}`,
            videoModel: existing.model,
            videoMode: existing.mode,
            videoDuration: existing.totalDurationSec,
            videoAspectRatio: existing.aspectRatio,
            videoReferenceImageIds: existing.referenceAssetIds,
            videoScript: existing.script,
          },
        } as GenerationHistoryItem
      : null;
    restoreScript(existing.script || null, restoredGeneration);
    generatedVideoSignature.value = currentVideoSignature.value;
    if (!TERMINAL_PROJECT_POLL_STATUSES.has(existing.status)) {
      await pollProject(existing.id);
    }
  } catch (error) {
    if (!isAbortError(error) && !isUnauthorized(error)) {
      projectError.value = (error as Error).message || "暂时无法恢复视频项目。";
    }
  }
}

async function pollProject(projectId: number) {
  try {
    const response = await fetchVideoProject(projectId, scope.signalFor("video-project-poll"));
    applyProjectUpdate(response.project);
    const tasksStore = useGenerationTasksStore();
    const historyStore = useHistoryStore();
    tasksStore.updateVideoProjectTask(projectId, {
      videoStatus: response.project.status,
      status: response.project.status === "completed" ? "completed" : response.project.status === "failed" ? "failed" : "polling",
    });
    if (TERMINAL_PROJECT_POLL_STATUSES.has(response.project.status)) {
      await historyStore.refresh().catch(() => {});
      return;
    }
    projectPollTimer = setTimeout(() => pollProject(projectId), 2500);
  } catch (error) {
    if (isAbortError(error)) return;
    projectError.value = (error as Error).message || "暂时无法刷新视频状态。";
  }
}

async function generateRealVideo() {
  if (!script.value || !brand.value?.id || !trend.value?.id) return;
  if (project.value) {
    projectError.value = "当前选题已有视频项目，请在下方继续处理，避免重复生成。";
    return;
  }
  if (!generation.value?.id) {
    projectError.value = "这份脚本没有可绑定的服务端记录，请重新生成适配当前模型的视频脚本。";
    return;
  }
  if (controlsDirty.value) {
    projectError.value = "视频参数已变更，请先点击“重新生成”让脚本与当前参数同步。";
    return;
  }
  if (!scriptCompatible.value) {
    projectError.value = "当前模型不能直接执行这份分镜，请重新生成视频脚本。";
    return;
  }
  if (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length) {
    projectError.value = "图生视频需要先在视频工作台中选择一张参考图。";
    return;
  }
  projectLoading.value = true;
  projectError.value = "";
  stopProjectPolling();
  try {
    const response = await createVideoProject(Number(brand.value.id), Number(trend.value.id), props.ideaIndex, {
      requestId: createProjectRequestId(),
      videoScriptGenerationId: Number(generation.value?.id || 0),
      model: videoModelRef.value,
      mode: videoModeRef.value,
      resolution: videoResolutionRef.value,
      aspectRatio: videoAspectRatioRef.value === "smart" ? script.value.aspectRatio : videoAspectRatioRef.value,
      totalDurationSec: videoDurationRef.value === "auto" ? Number(script.value.totalDurationSec || 30) : Number(videoDurationRef.value),
      referenceAssetIds: selectedVideoReferenceIds.value.slice(0, maxVideoReferences.value),
    }, scope.signalFor("video-project-create"));
    applyProjectUpdate(response.project);
    mergeAuthUser(response.user);
    const tasksStore = useGenerationTasksStore();
    const historyStore = useHistoryStore();
    if (response.generation?.id && response.generation?.type === "videoProject") {
      historyStore.upsertGeneration(response.generation as unknown as GenerationHistoryItem);
    }
    const ideaTitle = trend.value?.ideas?.[props.ideaIndex]?.title || script.value?.title || "";
    tasksStore.startVideoProjectTask({
      brandId: Number(brand.value.id),
      trendId: Number(trend.value.id),
      ideaIndex: props.ideaIndex,
      brandName: brand.value.name,
      trendTitle: trend.value.title,
      ideaTitle,
      cardTitle: script.value?.title || ideaTitle || "AI 视频",
      projectId: response.project.id,
      generationId: Number(response.generation?.id || response.project.generationId || 0) || undefined,
      videoStatus: response.project.status,
    });
    await historyStore.refresh().catch(() => {});
    if (response.project.status !== "completed") await pollProject(response.project.id);
  } catch (error) {
    projectError.value = (error as Error).message || "真实视频生成提交失败，请重试。";
  } finally {
    projectLoading.value = false;
  }
}

async function retryVideoClipResult(clipIndex: number) {
  if (!project.value || retryingClipIndex.value != null) return;
  retryingClipIndex.value = clipIndex;
  projectError.value = "";
  stopProjectPolling();
  try {
    const response = await retryVideoProjectClipResult(
      project.value.id,
      clipIndex,
      actionRequestId(`retry-result:${clipIndex}`),
      scope.signalFor(`video-clip-retry-result-${clipIndex}`),
    );
    applyProjectUpdate(response.project);
    mergeAuthUser(response.user);
    actionRequestIds.delete(`retry-result:${clipIndex}`);
    if (!TERMINAL_PROJECT_POLL_STATUSES.has(response.project.status)) await pollProject(response.project.id);
  } catch (error) {
    if (isAbortError(error)) return;
    projectError.value = (error as Error).message || "当前镜头重新处理失败，请稍后再试。";
  } finally {
    retryingClipIndex.value = null;
  }
}

async function retryAssembly() {
  if (!project.value || project.value.status !== "assembly_failed" || projectLoading.value) return;
  projectLoading.value = true;
  projectError.value = "";
  try {
    const response = await retryVideoProjectAssembly(project.value.id, actionRequestId("assembly"), scope.signalFor("video-assembly-retry"));
    applyProjectUpdate(response.project);
    // The request has a known response, including a failed FFmpeg attempt.
    // A later button click is a new free assembly attempt; only an unknown
    // network outcome should retain the idempotency key for replay.
    actionRequestIds.delete("assembly");
    if (!["completed", "assembly_failed"].includes(response.project.status)) await pollProject(response.project.id);
  } catch (error) {
    if (!isAbortError(error)) projectError.value = (error as Error).message || "重新拼接失败，请稍后再试。";
  } finally {
    projectLoading.value = false;
  }
}

async function retryVideoClip(clipIndex: number) {
  if (!project.value || retryingClipIndex.value != null) return;
  retryingClipIndex.value = clipIndex;
  projectError.value = "";
  stopProjectPolling();
  try {
    const response = await retryVideoProjectClip(project.value.id, clipIndex, actionRequestId(`clip:${clipIndex}`), scope.signalFor(`video-clip-retry-${clipIndex}`));
    applyProjectUpdate(response.project);
    mergeAuthUser(response.user);
    actionRequestIds.delete(`clip:${clipIndex}`);
    if (!["completed", "failed"].includes(response.project.status)) await pollProject(response.project.id);
  } catch (error) {
    if (isAbortError(error)) return;
    projectError.value = (error as Error).message || "当前镜头重试失败，请稍后再试。";
  } finally {
    retryingClipIndex.value = null;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function handleVideoReferenceToggle(imageId: number, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const id = Number(imageId);
  const current = normalizeImageIds(videoReferenceImageIdsRef.value);
  if (checked) {
    if (current.includes(id)) return;
    if (current.length >= maxVideoReferences.value) {
      projectError.value = `当前模型最多选择 ${maxVideoReferences.value} 张视频参考图。`;
      return;
    }
    videoReferenceImageIdsRef.value = [...current, id];
    return;
  }
  videoReferenceImageIdsRef.value = current.filter((candidate) => candidate !== id);
}

async function handleVideoReferenceUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || videoReferenceUploadLoading.value) return;
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    projectError.value = `单张参考图最多上传 ${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)}。`;
    return;
  }
  videoReferenceUploadLoading.value = true;
  projectError.value = "";
  try {
    const signal = scope.signalFor("video-reference-upload");
    const dataUrl = await fileToDataUrl(file, signal);
    if (signal.aborted) return;
    const result = await uploadProductImage({ name: file.name, dataUrl, brandId: brand.value?.id }, signal);
    if (!result.image) return;
    uploadedVideoReferenceImages.value = [result.image, ...uploadedVideoReferenceImages.value.filter((image) => image.id !== result.image.id)];
    if (props.productLibrary) {
      props.productLibrary.images.value = [
        result.image,
        ...props.productLibrary.images.value.filter((image) => image.id !== result.image.id),
      ];
    }
    if (videoReferenceImageIdsRef.value.length < maxVideoReferences.value) {
      videoReferenceImageIdsRef.value = [...videoReferenceImageIdsRef.value, result.image.id];
      videoScriptBlockedError.value = "";
    } else {
      projectError.value = `图片已上传，但当前模型最多选择 ${maxVideoReferences.value} 张参考图。`;
    }
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      auth.handleUnauthorized();
      return;
    }
    projectError.value = (error as Error).message || "参考图上传失败，请重试。";
  } finally {
    videoReferenceUploadLoading.value = false;
  }
}

const isClosing = ref(false);

function handleRegenerate() {
  if (project.value) {
    projectError.value = "当前视频项目已创建，生成参数已锁定。请先关闭工作台后再创建新视频。";
    return;
  }
  stopProjectPolling();
  project.value = null;
  projectError.value = "";
  createRequestIdRef.value = "";
  actionRequestIds.clear();
  reset();
  generateScriptWhenReady();
}

function handleRetry() {
  if (project.value) {
    projectError.value = "当前视频项目已创建，生成参数已锁定。请先关闭工作台后再创建新视频。";
    return;
  }
  generateScriptWhenReady();
}

function handleClose() {
  if (isClosing.value) return;
  stopProjectPolling();
  isClosing.value = true;
  const prefersReduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isTest = typeof process !== "undefined" && process.env.NODE_ENV === "test";
  if (isTest) {
    emit("close");
    return;
  }
  setTimeout(() => {
    emit("close");
  }, prefersReduced ? 150 : 280);
}

onUnmounted(() => {
  disposed = true;
  stopProjectPolling();
});
</script>

<template>
  <div class="video-script-backdrop" :class="{ 'is-closing': isClosing }" data-test="idea-video-script-dialog" @click.self="handleClose">
    <section
      class="video-script-dialog-panel"
      :class="{ 'is-closing': isClosing }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="videoScriptDialogTitle"
    >
      <header class="dialog-header">
        <div class="dialog-title-group">
          <span class="dialog-badge">AI 视频创作</span>
          <h2 id="videoScriptDialogTitle" class="dialog-title">AI 视频创作</h2>
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

      <nav class="studio-stepper" aria-label="AI 视频生成步骤" data-test="video-studio-stepper">
        <button
          v-for="step in studioSteps"
          :key="step.id"
          type="button"
          class="studio-step"
          :class="{ active: currentStep === step.id, complete: currentStep > step.id }"
          :disabled="!canEnterStep(step.id)"
          :aria-current="currentStep === step.id ? 'step' : undefined"
          :data-test="`video-step-${step.id}`"
          @click="goToStep(step.id)"
        >
          <span class="studio-step-index">{{ currentStep > step.id ? '✓' : step.id }}</span>
          <span class="studio-step-copy">
            <strong>{{ step.title }}</strong>
            <small>{{ step.description }}</small>
          </span>
        </button>
      </nav>

      <div class="dialog-body">
        <div v-show="currentStep === 1" class="studio-step-panel" data-test="video-step-settings-panel">
        <section class="video-studio-controls" data-test="video-studio-controls">
          <div class="studio-controls-heading">
            <div>
              <span class="control-eyebrow">AI 视频工作台</span>
              <h3>先定生成规则，再生成真实视频</h3>
            </div>
          </div>
          <div class="studio-control-grid">
            <label class="studio-field model-field">
              <span>视频模型</span>
              <StudioSelect
                v-model="videoModelRef"
                :options="videoModelSelectOptions"
                :disabled="Boolean(project)"
                test-id="video-model-select"
                label="视频模型"
              />
            </label>
            <label class="studio-field">
              <span>生成方式</span>
              <StudioSelect
                v-model="videoModeRef"
                :options="videoModeSelectOptions"
                :disabled="Boolean(project)"
                test-id="video-mode-select"
                label="生成方式"
              />
            </label>
            <label class="studio-field">
              <span>总时长</span>
              <StudioSelect
                v-model="videoDurationRef"
                :options="videoDurationSelectOptions"
                :disabled="Boolean(project)"
                test-id="video-duration-select"
                label="总时长"
              />
            </label>
            <label class="studio-field">
              <span>画幅</span>
              <StudioSelect
                v-model="videoAspectRatioRef"
                :options="videoAspectSelectOptions"
                :disabled="Boolean(project)"
                test-id="video-aspect-select"
                label="画幅"
              />
            </label>
            <label class="studio-field">
              <span>清晰度</span>
              <StudioSelect
                v-model="videoResolutionRef"
                :options="videoResolutionSelectOptions"
                :disabled="Boolean(project)"
                test-id="video-resolution-select"
                label="清晰度"
              />
            </label>
          </div>
          <p v-if="project" class="capability-hint" data-test="video-project-controls-locked">当前视频项目已创建，生成参数已锁定。</p>
          <p v-if="capabilitiesLoading" class="capability-hint">正在读取模型能力配置…</p>
          <p v-else-if="capabilitiesError" class="capability-hint">{{ capabilitiesError }}</p>
          <p class="reference-summary">
            {{ videoModeRef === 'image' ? `图生视频将使用 ${selectedVideoReferenceIds.length} / ${maxVideoReferences} 张视频参考图，并先生成视觉理解 Bible。` : '文生视频将使用脚本中的主体、镜头和连续性约束。' }}
          </p>
          <section v-if="videoModeRef === 'image'" class="video-reference-picker" data-test="video-reference-picker">
            <div class="reference-picker-heading">
              <div>
                <strong>视频参考图</strong>
                <span>{{ selectedVideoReferenceIds.length }} / {{ maxVideoReferences }} 张</span>
              </div>
              <small>图片输入不额外计费，只用于理解产品、人物、场景与视觉风格。</small>
            </div>
            <p class="reference-picker-copy">这里只影响本次视频创作，不会修改当前图片生成设置。</p>
            <div v-if="!availableProductImages.length && !productLibrary?.loading.value" class="reference-empty">
              暂无可选参考图，请上传一张新的产品或场景图。
            </div>
            <div v-else class="video-reference-options">
              <label v-for="image in availableProductImages" :key="image.id" class="video-reference-option">
                  <input
                    type="checkbox"
                    :checked="videoReferenceImageIdsRef.includes(image.id)"
                    :disabled="Boolean(project) || (!videoReferenceImageIdsRef.includes(image.id) && selectedVideoReferenceIds.length >= maxVideoReferences)"
                  @change="handleVideoReferenceToggle(image.id, $event)"
                />
                <img :src="image.url" :alt="image.originalName" loading="lazy" />
                <span>{{ image.originalName }}</span>
              </label>
            </div>
            <label class="video-reference-upload">
              <input type="file" accept="image/*" :disabled="Boolean(project) || videoReferenceUploadLoading" @change="handleVideoReferenceUpload" />
              {{ videoReferenceUploadLoading ? '上传中…' : '上传新的参考图' }}
            </label>
          </section>
          <p v-if="videoScriptBlockedError" class="stale-settings-warning" data-test="video-script-reference-required">
            {{ videoScriptBlockedError }}
          </p>
          <p v-if="controlsDirty" class="stale-settings-warning" data-test="video-script-settings-stale">参数已变更，脚本尚未同步；请重新生成脚本后再生成真实视频。</p>
          <p v-else-if="script && !generation?.id" class="stale-settings-warning" data-test="video-script-generation-required">这份历史脚本缺少服务端脚本记录，请重新生成后再创建真实视频。</p>
        </section>

        <section v-if="!script && !loading && !error" class="script-preparation-action" data-test="video-script-preparation">
          <div>
            <span class="control-eyebrow">脚本与分镜</span>
            <h3>确认视频准备后，再生成付费脚本</h3>
            <p>脚本会根据当前模型、生成方式、时长、画幅和参考图生成。</p>
          </div>
        </section>
        </div>

        <div v-if="currentStep === 2 && loading" class="dialog-loading-state" data-test="video-script-loading">
          <div class="loading-spinner" aria-hidden="true"></div>
          <h3>正在生成 AI 视频脚本与分镜提示词...</h3>
          <p>AI 正在结合品牌定位、选题视角与参考素材，生成可直接复制给视频模型的结构化提示词。</p>
          <small class="loading-hint">仅生成文字分镜与视频生成提示词，不产生实际视频。</small>
        </div>

        <div v-else-if="currentStep === 2 && error" class="dialog-error-state" data-test="video-script-error">
          <div class="error-icon" aria-hidden="true">!</div>
          <h3>视频脚本生成失败</h3>
          <p class="error-text">{{ error }}</p>
          <div class="error-actions">
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

        <div v-else-if="currentStep === 2 && videoScriptBlockedError && !script" class="dialog-error-state" data-test="video-script-reference-required">
          <div class="error-icon" aria-hidden="true">!</div>
          <h3>先准备视频参考图</h3>
          <p class="error-text">{{ videoScriptBlockedError }}</p>
        </div>

        <div v-else-if="currentStep === 2 && script" class="dialog-result-state" data-test="video-step-script-panel">
          <VideoScriptResult
            :script="script"
            :show-actions="true"
            :show-regenerate="!project"
            @regenerate="handleRegenerate"
            @close="handleClose"
          />
          <div class="script-compatibility" :class="{ incompatible: !scriptCompatible }" data-test="video-script-compatibility">
            <strong>{{ scriptCompatible ? '当前模型可直接生成' : '当前模型需要重新生成分镜' }}</strong>
            <span v-if="!scriptCompatible">当前分镜包含模型不支持的比例或镜头时长，请重新生成视频脚本。</span>
          </div>
        </div>
        <div v-if="currentStep === 3 && script" class="dialog-production-state" data-test="video-step-production-panel">
          <section class="real-video-panel" data-test="real-video-panel">
            <div class="real-video-copy">
              <span class="control-eyebrow">下一步</span>
              <h3>生成真实视频</h3>
              <p>脚本已准备好。系统会按 {{ videoModelRef.toUpperCase() }} 的镜头规则排队生成，并自动保存到历史记录。</p>
              <p v-if="script.visualBible && Object.values(script.visualBible).some(Boolean)" class="bible-summary">视觉理解 Bible 已写入脚本，用于跨镜头保持主体、材质、色彩与光线一致。</p>
            </div>
          </section>
          <p v-if="projectError" class="project-error" data-test="video-project-error">{{ projectError }}</p>
          <section v-if="project" class="video-project-status" data-test="video-project-status">
            <div class="status-line">
              <div class="status-badge" :class="{ 'is-generating': isProjectGenerating }">
                <span v-if="isProjectGenerating" class="status-spinner" aria-hidden="true"></span>
                <strong>{{ projectStatusLabel }}</strong>
              </div>
              <span>{{ project.model.toUpperCase() }} · {{ project.totalDurationSec }} 秒 · 已扣 {{ project.chargedCredits }} 积分</span>
            </div>
            <div v-if="isProjectGenerating" class="project-loading-bar" aria-hidden="true">
              <div class="project-loading-bar-fill"></div>
            </div>
            <p v-if="project.refundedCredits" class="refund-summary">已退款 {{ project.refundedCredits }} 积分。</p>
            <div v-if="project.status === 'assembly_failed'" class="assembly-failed-panel" data-test="assembly-failed">
              <strong>视频片段均已生成完成</strong>
              <span>最终成片拼接失败，重新拼接不扣积分。</span>
              <button
                type="button"
                class="secondary-btn"
                data-test="retry-assembly"
                :disabled="projectLoading"
                @click="retryAssembly"
              >
                {{ projectLoading ? '拼接中…' : '重新拼接成片 · 0积分' }}
              </button>
            </div>
            <video v-if="project.finalVideoUrl" class="final-video-player" controls playsinline :src="project.finalVideoUrl"></video>
            <div class="clip-progress-list">
              <article
                v-for="clip in project.clips"
                :key="clip.id"
                :class="[
                  'clip-progress',
                  `clip-${clip.status}`,
                  {
                    'is-generating': isClipActivelyGenerating(clip.status),
                    'is-waiting': isClipWaiting(clip.status),
                    'is-completed': clip.status === 'completed'
                  }
                ]"
              >
                <div class="clip-progress-heading">
                  <div class="clip-title-group">
                    <span v-if="isClipActivelyGenerating(clip.status)" class="clip-spinner" aria-hidden="true"></span>
                    <span v-else-if="clip.status === 'completed'" class="clip-done-icon" aria-hidden="true">✓</span>
                    <strong>镜头 {{ clip.index }}</strong>
                  </div>
                  <span class="clip-status-text">
                    <span v-if="isClipActivelyGenerating(clip.status)" class="clip-pulse-dot" aria-hidden="true"></span>
                    {{ clipStatusLabel(clip.status) }}
                  </span>
                </div>
                <div v-if="isClipActivelyGenerating(clip.status)" class="clip-active-shimmer" aria-hidden="true"></div>
                <video v-if="clip.videoUrl" class="clip-video-player" controls playsinline :src="clip.videoUrl"></video>
                <small
                  v-if="clip.error && ['failed', 'uncertain_submission', 'cancelled', 'result_processing_failed', 'waiting_configuration'].includes(clip.status)"
                  class="clip-error"
                >失败原因：{{ clip.error }}</small>
                <div class="clip-actions">
                  <a v-if="clip.videoUrl" class="clip-download" :href="clip.videoUrl" download @click="trackAnalyticsEvent('final_asset_downloaded', { assetType: 'video_clip' })">下载本段</a>
                  <button
                    v-if="clip.status === 'result_processing_failed'"
                    type="button"
                    class="secondary-btn clip-retry-btn"
                    data-test="retry-result-btn"
                    :disabled="retryingClipIndex === clip.index"
                    @click="retryVideoClipResult(clip.index)"
                  >
                    {{ retryingClipIndex === clip.index ? '处理中…' : '重新处理结果 · 0积分' }}
                  </button>
                  <button
                    v-else-if="['failed', 'uncertain_submission', 'cancelled'].includes(clip.status)"
                    type="button"
                    class="secondary-btn clip-retry-btn"
                    data-test="clip-retry-btn"
                    :disabled="retryingClipIndex === clip.index"
                    @click="retryVideoClip(clip.index)"
                  >
                    {{ retryingClipIndex === clip.index ? '提交中…' : '重新生成当前镜头' }}
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>

      <footer class="studio-step-navigation" data-test="video-step-navigation">
        <button
          type="button"
          class="secondary-btn"
          data-test="video-step-previous"
          :disabled="currentStep === 1"
          @click="goPreviousStep"
        >
          上一步
        </button>
        <span>第 {{ currentStep }} / {{ studioSteps.length }} 步</span>
        <button
          type="button"
          class="primary-btn"
          :data-test="primaryStepTestId"
          :disabled="primaryStepDisabled"
          @click="handlePrimaryStepAction"
        >
          {{ primaryStepLabel }}
        </button>
      </footer>
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
  opacity: 1;
  transition: opacity 280ms cubic-bezier(0.4, 0, 0.2, 1);
}

.video-script-backdrop.is-closing {
  opacity: 0;
}

.video-script-dialog-panel {
  width: min(1180px, calc(100vw - 48px));
  height: min(780px, calc(100vh - 32px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border-radius: var(--workspace-radius, 12px);
  border: 1px solid var(--workspace-border, #eae5e3);
  background: #fffdfc;
  color: var(--workspace-text, #222);
  box-shadow: 0 24px 64px rgba(45, 25, 30, 0.2);
  overflow: hidden;
  transform: translate(0, 0) scale(1);
  transform-origin: 10% 55%;
  transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1);
}

.video-script-dialog-panel.is-closing {
  transform: translate(-30vw, 2vh) scale(0.18);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .video-script-backdrop {
    transition: opacity 150ms ease !important;
  }

  .video-script-dialog-panel {
    transition: opacity 150ms ease !important;
    transform: none !important;
  }
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

.studio-stepper {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 12px 24px;
  border-bottom: 1px solid #eadfd8;
  background: #fbf7f5;
}

.studio-step {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 8px 12px;
  border: 1px solid #e7dcd8;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.72);
  color: #8c7d80;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.studio-step:hover:not(:disabled) {
  border-color: #cdaaa6;
  background: #fff;
  transform: translateY(-1px);
}

.studio-step:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.studio-step-index {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid #d8c9c5;
  border-radius: 50%;
  background: #fff;
  color: #8c7d80;
  font-size: 12px;
  font-weight: 850;
}

.studio-step.active {
  border-color: #9c4a4f;
  background: #fff;
  box-shadow: 0 5px 16px rgba(124, 45, 50, 0.09);
}

.studio-step.complete {
  border-color: #dfc3bf;
  background: #fff9f7;
}

.studio-step.active .studio-step-index {
  border-color: #7c2d32;
  background: #7c2d32;
  color: #fff;
}

.studio-step.complete .studio-step-index {
  border-color: #d9aaa4;
  background: #f4dfdb;
  color: #7c2d32;
}

.studio-step-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.studio-step-copy strong {
  color: #57484b;
  font-size: 12.5px;
}

.studio-step.active .studio-step-copy strong {
  color: #7c2d32;
}

.studio-step.complete .studio-step-copy strong {
  color: #6d4246;
}

.studio-step-copy small {
  color: #9a898c;
  font-size: 10.5px;
  white-space: nowrap;
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

.model-field {
  grid-column: span 1;
}

.capability-hint {
  margin: 10px 0 0;
  color: #a45f28;
  font-size: 11px;
}

.reference-summary {
  margin: 12px 0 0;
  color: #806e70;
  font-size: 12px;
  line-height: 1.5;
}

.video-reference-picker {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #eaded8;
  border-radius: 10px;
  background: #fff;
}

.reference-picker-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.reference-picker-heading div {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #4a3b3e;
  font-size: 12px;
}

.reference-picker-heading div span,
.reference-picker-heading small,
.reference-picker-copy,
.reference-empty {
  color: #806e70;
  font-size: 11px;
  line-height: 1.5;
}

.reference-picker-heading small {
  max-width: 440px;
  text-align: right;
}

.reference-picker-copy {
  margin: 5px 0 10px;
}

.video-reference-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}

.video-reference-option {
  position: relative;
  display: grid;
  gap: 5px;
  padding: 6px;
  border: 1px solid #eaded8;
  border-radius: 8px;
  background: #fffaf8;
  color: #5d4d50;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.3;
}

.video-reference-option:has(input:checked) {
  border-color: #7c2d32;
  box-shadow: 0 0 0 1px #7c2d32;
}

.video-reference-option input {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 1;
}

.video-reference-option img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 5px;
  background: #f4edea;
}

.video-reference-option span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-reference-upload {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  margin-top: 10px;
  padding: 0 10px;
  border: 1px dashed #cda9a0;
  border-radius: 7px;
  color: #7c2d32;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

.video-reference-upload input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.stale-settings-warning {
  margin: 8px 0 0;
  color: #a45f28;
  font-size: 12px;
  line-height: 1.5;
}

.script-preparation-action,
.assembly-failed-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 16px 0;
  padding: 16px 18px;
  border: 1px solid #e5d8d3;
  border-radius: 12px;
  background: #fffaf8;
}

.script-preparation-action h3,
.assembly-failed-panel strong {
  display: block;
  margin: 4px 0 0;
  color: var(--workspace-text, #31292b);
  font-size: 15px;
}

.script-preparation-action p,
.assembly-failed-panel span {
  display: block;
  margin: 6px 0 0;
  color: #6d5e60;
  font-size: 12px;
  line-height: 1.5;
}

.assembly-failed-panel {
  align-items: flex-start;
  flex-wrap: wrap;
  border-color: #f0c7bc;
  background: #fff5f2;
}

.assembly-failed-panel button {
  margin-left: auto;
}

.script-compatibility {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid #cfe7d5;
  border-radius: 8px;
  background: #f2fbf4;
  color: #2c7547;
  font-size: 12px;
}

.script-compatibility.incompatible {
  border-color: #f0c7bc;
  background: #fff5f2;
  color: #b34b3d;
}

.script-compatibility span {
  color: inherit;
  font-size: 11px;
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
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-badge.is-generating strong {
  color: var(--workspace-brand, #d83b46);
}

.status-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(216, 68, 68, 0.2);
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

.project-loading-bar {
  position: relative;
  width: 100%;
  height: 3px;
  margin-top: 8px;
  background: rgba(216, 68, 68, 0.1);
  border-radius: 999px;
  overflow: hidden;
}

.project-loading-bar-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--workspace-brand, #d83b46), transparent);
  border-radius: 999px;
  animation: project-shimmer 1.5s ease-in-out infinite;
}

@keyframes project-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

.clip-title-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.clip-spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 1.5px solid rgba(216, 68, 68, 0.25);
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

.clip-done-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  font-size: 9px;
  font-weight: 800;
  color: #fff;
  background: #16a34a;
  border-radius: 50%;
  line-height: 1;
}

.clip-status-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.clip-pulse-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: pulse-dot 1.2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { transform: scale(0.8); opacity: 0.5; }
  50% { transform: scale(1.3); opacity: 1; }
}

.clip-progress {
  position: relative;
  overflow: hidden;
  display: grid;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid #eaded8;
  border-radius: 8px;
  background: #f5efeb;
  color: #806e70;
  font-size: 11px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.clip-progress.is-generating {
  border-color: rgba(216, 68, 68, 0.35);
  background: #fff8f7;
  box-shadow: 0 1px 4px rgba(216, 68, 68, 0.08);
}

.clip-progress.is-generating .clip-progress-heading strong {
  color: var(--workspace-brand, #d83b46);
}

.clip-progress.is-generating .clip-status-text {
  color: var(--workspace-brand, #d83b46);
  font-weight: 600;
}

.clip-active-shimmer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--workspace-brand, #d83b46), transparent);
  animation: clip-shimmer 1.8s ease-in-out infinite;
}

@keyframes clip-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.clip-progress.is-completed {
  border-color: rgba(34, 197, 94, 0.25);
  background: #f6fbf7;
}

.clip-progress.is-completed .clip-status-text {
  color: #16a34a;
  font-weight: 600;
}

.clip-progress.is-waiting {
  opacity: 0.85;
}

.clip-progress-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.clip-progress-heading strong {
  color: #5d4d50;
}

.clip-video-player {
  display: block;
  width: min(100%, 420px);
  max-height: 260px;
  border-radius: 6px;
  background: #211d1d;
}

.clip-error {
  color: #b72e3a;
  line-height: 1.45;
}

.clip-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.clip-download {
  color: #7c2d32;
  font-size: 11px;
  font-weight: 700;
  text-decoration: none;
}

.clip-download:hover {
  text-decoration: underline;
}

.clip-retry-btn {
  min-height: 28px;
  padding: 0 9px;
  font-size: 11px;
}

.refund-summary {
  margin: 8px 0 0;
  color: #2c7547;
  font-size: 12px;
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

.studio-step-navigation {
  display: grid;
  grid-template-columns: minmax(108px, auto) 1fr minmax(108px, auto);
  align-items: center;
  gap: 12px;
  padding: 13px 24px;
  border-top: 1px solid #eadfd8;
  background: #fffdfc;
}

.studio-step-navigation > span {
  color: #8c7d80;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}

.studio-step-navigation button:last-child {
  justify-self: end;
}

@media (max-width: 840px) {
  .studio-control-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .reference-picker-heading {
    flex-direction: column;
  }

  .reference-picker-heading small {
    max-width: none;
    text-align: left;
  }

  .real-video-panel {
    align-items: flex-start;
    flex-direction: column;
  }

  .script-preparation-action {
    align-items: flex-start;
    flex-direction: column;
  }

  .script-preparation-action button,
  .assembly-failed-panel button {
    margin-left: 0;
  }

  .studio-stepper {
    padding-inline: 12px;
  }

  .studio-step-copy small {
    display: none;
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
