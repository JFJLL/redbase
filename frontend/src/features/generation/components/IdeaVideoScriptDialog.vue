<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
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
const videoAspectRatioRef = ref(settings.value.videoAspectRatio || "9:16");
const videoDurationRef = ref(settings.value.videoDuration || "auto");
const videoModelRef = ref(settings.value.videoModel || "d2");
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
const availableVideoModes = computed(() => activeVideoCapability.value?.supportedModes || ["text", "image"]);
const availableVideoRatios = computed(() => activeVideoCapability.value?.aspectRatios || [...VIDEO_ASPECT_RATIOS]);
const availableResolutions = computed(() => activeVideoCapability.value?.resolutions || ["720p"]);
const visibleVideoDurationOptions = computed(() => {
  const supported = new Set(activeVideoCapability.value?.totalDurationOptions || []);
  return VIDEO_DURATION_OPTIONS.filter((option) => option.value === "auto" || supported.has(Number(option.value)));
});

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
  queued: "排队中",
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
  const scriptRatio = currentScript.aspectRatio === "smart" ? "9:16" : currentScript.aspectRatio;
  if (!capability.aspectRatios.includes(scriptRatio)) return false;
  return (currentScript.clips || []).every((clip) => {
    const duration = Number(clip.durationSec);
    const allowed = capability.allowedClipDurations?.map(Number);
    return Number.isFinite(duration) && duration >= capability.clipDurationRules.min && duration <= capability.clipDurationRules.max && (!allowed || allowed.includes(duration));
  });
});

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
  void (async () => {
    await restoreActiveProject();
    if (!disposed) await loadVideoCapabilities();
  })();
});

watch(script, (value) => {
  if (value) generatedVideoSignature.value = currentVideoSignature.value;
});

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

function generateScriptWhenReady() {
  if (project.value) {
    projectError.value = "当前视频项目已创建，生成参数已锁定。请先关闭工作台后再创建新视频。";
    return null;
  }
  if (videoModeRef.value === "image" && !selectedVideoReferenceIds.value.length) {
    videoScriptBlockedError.value = "图生视频必须先选择或上传至少一张视频参考图，再生成脚本。";
    return null;
  }
  videoScriptBlockedError.value = "";
  return generateScript();
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
    if (TERMINAL_PROJECT_POLL_STATUSES.has(response.project.status)) return;
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
      aspectRatio: videoAspectRatioRef.value === "smart" ? "9:16" : videoAspectRatioRef.value,
      totalDurationSec: videoDurationRef.value === "auto" ? Number(script.value.totalDurationSec || 30) : Number(videoDurationRef.value),
      referenceAssetIds: selectedVideoReferenceIds.value.slice(0, maxVideoReferences.value),
    }, scope.signalFor("video-project-create"));
    applyProjectUpdate(response.project);
    mergeAuthUser(response.user);
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
  stopProjectPolling();
  emit("close");
}

onUnmounted(() => {
  disposed = true;
  stopProjectPolling();
});
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
              <small v-if="activeVideoCapability?.promotionLabel" class="model-promotion">{{ activeVideoCapability.promotionLabel }}</small>
              <span class="model-switch" role="radiogroup" aria-label="视频模型">
                <button
                  v-for="model in videoModelOptions"
                  :key="model.id"
                  type="button"
                  :class="{ active: videoModelRef === model.id }"
                  :data-test="`video-model-${model.id}`"
                  :disabled="Boolean(project)"
                  @click.stop="videoModelRef = model.id"
                >
                  {{ model.displayName }}
                </button>
              </span>
            </label>
            <label class="studio-field">
              <span>生成方式</span>
              <select v-model="videoModeRef" data-test="video-mode-select" :disabled="Boolean(project)">
                <option v-for="mode in availableVideoModes" :key="mode" :value="mode">
                  {{ mode === 'image' ? '图生视频' : '文生视频' }}
                </option>
              </select>
            </label>
            <label class="studio-field">
              <span>总时长</span>
              <select v-model="videoDurationRef" data-test="video-duration-select" :disabled="Boolean(project)">
                <option v-for="option in visibleVideoDurationOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="studio-field">
              <span>画幅</span>
              <select v-model="videoAspectRatioRef" data-test="video-aspect-select" :disabled="Boolean(project)">
                <option value="smart">智能竖屏（9:16）</option>
                <option v-for="ratio in availableVideoRatios" :key="ratio" :value="ratio">{{ ratio }}</option>
              </select>
            </label>
            <label class="studio-field">
              <span>清晰度</span>
              <select v-model="videoResolutionRef" data-test="video-resolution-select" :disabled="Boolean(project)">
                <option v-for="resolution in availableResolutions" :key="resolution" :value="resolution">{{ resolution }}</option>
              </select>
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
          <p v-if="controlsDirty" class="stale-settings-warning" data-test="video-script-settings-stale">参数已变更，脚本尚未同步；请重新生成脚本后再生成真实视频。</p>
          <p v-else-if="script && !generation?.id" class="stale-settings-warning" data-test="video-script-generation-required">这份历史脚本缺少服务端脚本记录，请重新生成后再创建真实视频。</p>
        </section>

        <section v-if="!script && !loading && !error && !videoScriptBlockedError" class="script-preparation-action" data-test="video-script-preparation">
          <div>
            <span class="control-eyebrow">脚本与分镜</span>
            <h3>确认视频准备后，再生成付费脚本</h3>
            <p>脚本会根据当前模型、生成方式、时长、画幅和参考图生成。</p>
          </div>
          <button
            type="button"
            class="primary-btn"
            data-test="video-script-generate"
            :disabled="videoModeRef === 'image' && !selectedVideoReferenceIds.length"
            @click="generateScriptWhenReady"
          >
            生成视频脚本 · 1积分
          </button>
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
              @click="handleRetry"
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

        <div v-else-if="videoScriptBlockedError && !script" class="dialog-error-state" data-test="video-script-reference-required">
          <div class="error-icon" aria-hidden="true">!</div>
          <h3>先准备视频参考图</h3>
          <p class="error-text">{{ videoScriptBlockedError }}</p>
          <button type="button" class="primary-btn" data-test="video-script-generate-after-reference" :disabled="videoModeRef === 'image' && !selectedVideoReferenceIds.length" @click="generateScriptWhenReady">
            生成视频脚本 · 1积分
          </button>
        </div>

        <div v-else-if="script" class="dialog-result-state">
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
              :disabled="projectLoading || controlsDirty || !scriptCompatible || !generation?.id || Boolean(project)"
              @click="generateRealVideo"
            >
              {{ projectLoading ? "提交中..." : `生成真实视频 · ${estimatedCredits}积分` }}
            </button>
          </section>
          <p v-if="projectError" class="project-error" data-test="video-project-error">{{ projectError }}</p>
          <section v-if="project" class="video-project-status" data-test="video-project-status">
            <div class="status-line">
              <strong>{{ projectStatusLabel }}</strong>
              <span>{{ project.model.toUpperCase() }} · {{ project.totalDurationSec }} 秒 · 已扣 {{ project.chargedCredits }} 积分</span>
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
              <article v-for="clip in project.clips" :key="clip.id" :class="['clip-progress', `clip-${clip.status}`]">
                <div class="clip-progress-heading">
                  <strong>镜头 {{ clip.index }}</strong>
                  <span>{{ clip.status === 'completed' ? '完成' : clip.status === 'running' ? '生成中' : clip.status === 'processing_result' ? '正在处理生成结果' : clip.status === 'result_processing_failed' ? '生成结果暂未保存成功' : clip.status === 'submitting' ? '提交中' : clip.status === 'failed' ? '失败' : clip.status === 'uncertain_submission' ? '待确认' : clip.status === 'waiting_configuration' ? '等待生成通道' : clip.status === 'waiting_dependency' ? '等待上一镜头' : clip.status === 'cancelled' ? '已取消' : '排队' }}</span>
                </div>
                <video v-if="clip.videoUrl" class="clip-video-player" controls playsinline :src="clip.videoUrl"></video>
                <small v-if="clip.error" class="clip-error">失败原因：{{ clip.error }}</small>
                <div class="clip-actions">
                  <a v-if="clip.videoUrl" class="clip-download" :href="clip.videoUrl" download>下载本段</a>
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

.model-promotion {
  color: #a45f28;
  font-size: 11px;
  font-weight: 600;
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

.clip-progress {
  display: grid;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid #eaded8;
  border-radius: 8px;
  background: #f5efeb;
  color: #806e70;
  font-size: 11px;
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
