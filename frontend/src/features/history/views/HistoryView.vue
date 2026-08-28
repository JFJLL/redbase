<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { useHistoryStore } from "@/features/history/stores/history";
import { useGenerationTasksStore } from "@/features/generation/stores/generationTasks";
import {
  createVideoProject,
  fetchVideoProject,
  retryVideoProjectAssembly,
  type VideoProject,
  type VideoScript,
} from "@/features/generation/api";
import ImageEditPanel from "@/features/generation/components/ImageEditPanel.vue";
import VideoScriptResult from "@/features/generation/components/VideoScriptResult.vue";
import type { ImageEditTarget } from "@/features/generation/composables/useImageEdit";
import {
  HISTORY_TYPE_LABELS,
  KNOWN_ASPECT_RATIOS,
  createEmptyGenerationHistoryFilters,
  deleteGeneration,
  getGenerationPrimaryImageUrl,
  hasExpiredAssetSignature,
  matchesGenerationHistoryFilters,
  safeImageSrc,
  type GenerationHistoryItem,
} from "../api";

// 历史生成：全局 Store 缓存 + 本地筛选 + 详情查看 + 删除。签名图片 URL 直接使用后端返回值。
const router = useRouter();
const auth = useAuthStore();
const historyStore = useHistoryStore();
const tasksStore = useGenerationTasksStore();
const scope = useAbortScope();

const filters = reactive(createEmptyGenerationHistoryFilters());
const generations = computed(() => historyStore.items);
const brands = computed(() => historyStore.brands);
const loading = computed(() => historyStore.loading && !historyStore.loaded);
const loadError = computed(() => historyStore.error);

const detailItem = ref<GenerationHistoryItem | null>(null);
const detailSlideIndex = ref<number | null>(null);
const editEntryId = ref<string | null>(null);
const retryingVideoAssembly = ref(false);
const startingVideoProject = ref(false);
const startVideoError = ref("");
const videoClipPrompts = reactive<Record<string, string>>({});
let videoProjectRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const ACTIVE_VIDEO_STATUSES = new Set(["preparing", "queued", "submitting", "running", "processing_result", "assembling"]);

// 图片加载失败：明确错误态 + 重试；签名过期只刷新一次列表拿新签名，不无限循环。
const failedImageUrls = reactive(new Set<string>());
const refreshedSignatureUrls = new Set<string>();
let signatureRefreshInFlight = false;
let signatureRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const detailImageUrl = computed(() => {
  const item = detailItem.value;
  if (!item) return "";
  if (detailSlideIndex.value != null && Array.isArray(item.payload?.slides)) {
    const slide = item.payload.slides[detailSlideIndex.value];
    const slideSrc = safeImageSrc(slide?.imageUrl || slide?.previewUrl);
    if (slideSrc) return slideSrc;
  }
  return safeImageSrc(item.previewUrl);
});

const editTarget = computed<ImageEditTarget | null>(() => {
  const item = detailItem.value;
  if (!item || item.type === "videoScript") return null;
  return {
    imageUrl: detailImageUrl.value,
    title: item.cardTitle || "历史图片",
    generationId: Number(item.id),
    aspectRatio: String(item.payload?.aspectRatio || ""),
    slideIndex: detailSlideIndex.value,
  };
});

interface EditHistoryEntry {
  id?: unknown;
  imageUrl?: string;
  previewUrl?: string;
  title?: string;
  createdAt?: string;
  completedAt?: string;
  aspectRatio?: string;
  sourceSlideIndex?: number;
}

const editHistoryEntries = computed<EditHistoryEntry[]>(() => {
  const item = detailItem.value;
  if (!item || !Array.isArray(item.payload?.editHistory)) return [];
  return item.payload.editHistory as EditHistoryEntry[];
});

/** 历史记录自己的内联改图面板目标：父链由记录自身推导，不共享主表单。 */
function editTargetForEntry(entry: EditHistoryEntry): ImageEditTarget | null {
  const item = detailItem.value;
  if (!item) return null;
  const entryId = entry.id != null ? String(entry.id) : "";
  return {
    imageUrl: String(entry.imageUrl || entry.previewUrl || ""),
    title: String(entry.title || item.cardTitle || "改图结果"),
    generationId: Number(item.id),
    aspectRatio: String(entry.aspectRatio || item.payload?.aspectRatio || ""),
    ...(entryId ? { parentEditId: entryId } : {}),
    slideIndex: Number.isInteger(entry.sourceSlideIndex) ? Number(entry.sourceSlideIndex) : detailSlideIndex.value,
  };
}

function isImageFailed(url: string): boolean {
  return Boolean(url) && failedImageUrls.has(url);
}

function retryImage(url: string) {
  if (!url) return;
  failedImageUrls.delete(url);
}

function onHistoryImageError(url: string) {
  if (!url) return;
  if (hasExpiredAssetSignature(url)) {
    if (refreshedSignatureUrls.has(url)) {
      failedImageUrls.add(url);
      return;
    }
    refreshedSignatureUrls.add(url);
    scheduleSignatureRefresh();
    return;
  }
  failedImageUrls.add(url);
}

function scheduleSignatureRefresh() {
  if (signatureRefreshInFlight) return;
  if (signatureRefreshTimer) clearTimeout(signatureRefreshTimer);
  signatureRefreshTimer = setTimeout(() => {
    signatureRefreshTimer = null;
    signatureRefreshInFlight = true;
    historyStore.refresh().finally(() => {
      signatureRefreshInFlight = false;
    });
  }, 250);
}

function slideImages(item: GenerationHistoryItem): Array<{ sourceIndex: number; src: string; title: string }> {
  return (item.payload?.slides || [])
    .slice(0, 4)
    .map((slide, sourceIndex) => ({
      sourceIndex,
      src: safeImageSrc(slide.imageUrl || slide.previewUrl),
      title: slide.title || "",
    }))
    .filter((entry) => Boolean(entry.src));
}

function previewSrc(item: GenerationHistoryItem): string {
  return safeImageSrc(item.previewUrl);
}

function placeholderSlides(item: GenerationHistoryItem) {
  const rawSlides = Array.isArray(item.payload?.slides) ? item.payload!.slides : [];
  return Array.from({ length: 4 }, (_, index) => {
    const slide = (rawSlides[index] || {}) as Record<string, unknown>;
    return {
      index,
      pageLabel: String(slide.pageLabel || `第 ${index + 1} 张`),
      title: String(slide.title || ""),
      imageUrl: typeof slide.imageUrl === "string" ? slide.imageUrl : "",
      previewUrl: typeof slide.previewUrl === "string" ? slide.previewUrl : "",
      status: typeof slide.status === "string" ? slide.status : "idle",
      error: typeof slide.error === "string" ? slide.error : "",
    };
  });
}

const placeholderItems = computed<GenerationHistoryItem[]>(() => {
  return tasksStore.placeholdersForHistory.map((task) => {
    const summaryByType: Record<string, string> = {
      moments: task.copy?.caption || task.copy?.visualDirection || "",
      wechat: task.copy?.publishTitle || task.copy?.intro || "",
      xhsCarousel: task.copy?.publishCaption || task.copy?.caption || "",
      styleImage: task.copy?.visualDirection || "",
    };
    return {
      id: `placeholder_${task.id}` as any,
      ownerUserId: auth.user?.id ? Number(auth.user.id) : 0,
      type: task.type,
      channelLabel: task.channelLabel,
      brandId: task.brandId ?? 0,
      brandName: task.brandName || "",
      trendId: task.trendId ?? 0,
      trendTitle: task.trendTitle || "",
      ideaTitle: task.ideaTitle || "",
      cardTitle: task.cardTitle || task.copy?.publishTitle || task.ideaTitle || "生图任务",
      createdAt: new Date(task.createdAt).toISOString(),
      previewUrl: task.previewUrl || task.imageUrl || "",
      summary: summaryByType[task.type] || "",
      isPlaceholder: true,
      placeholderStatus: task.status,
      placeholderError: task.error,
      payload: {
        aspectRatio: task.aspectRatio,
        caption: task.copy?.caption,
        visualDirection: task.copy?.visualDirection,
        publishTitle: task.copy?.publishTitle,
        intro: task.copy?.intro,
        publishCaption: task.copy?.publishCaption,
        outline: task.copy?.outline,
        slides: task.slides?.map((s) => ({
          sourceSlideIndex: s.index,
          pageLabel: s.pageLabel,
          title: s.title,
          copy: s.copy,
          prompt: s.prompt,
          imageUrl: s.imageUrl,
          previewUrl: s.previewUrl || s.imageUrl,
          status: s.status,
          error: s.error,
        })),
      },
    } as GenerationHistoryItem;
  });
});

const allGenerations = computed(() => [...placeholderItems.value, ...generations.value]);

const supersededScriptIds = computed(() => {
  const ids = new Set<number>();
  for (const item of allGenerations.value) {
    if (item.type === "videoProject" && item.payload?.sourceVideoScriptGenerationId) {
      const scriptId = Number(item.payload.sourceVideoScriptGenerationId);
      if (Number.isSafeInteger(scriptId) && scriptId > 0) ids.add(scriptId);
    }
  }
  return ids;
});

const visibleHistory = computed(() =>
  allGenerations.value
    .filter((item) => !(item.type === "videoScript" && supersededScriptIds.value.has(Number(item.id))))
    .filter((item) => matchesGenerationHistoryFilters(item, filters)),
);
const hasFilters = computed(() => Boolean(filters.q || filters.brandId || filters.type || filters.from || filters.to));

const TYPE_OPTIONS = [...HISTORY_TYPE_LABELS.entries()];

function aspectRatioOf(item: GenerationHistoryItem): string {
  const ratio = String(item.payload?.aspectRatio || "");
  return KNOWN_ASPECT_RATIOS.has(ratio) ? ratio : "";
}

function typeLabel(item: GenerationHistoryItem): string {
  return HISTORY_TYPE_LABELS.get(item.type) || item.type;
}

function videoScriptContext(item: GenerationHistoryItem): { brandId: number; trendId: number; ideaIndex: number } | null {
  const brandId = Number(item.brandId);
  const trendId = Number(item.trendId);
  const ideaIndex = Number(item.payload?.ideaIndex);
  if (!Number.isSafeInteger(brandId) || brandId <= 0) return null;
  if (!Number.isSafeInteger(trendId) || trendId <= 0) return null;
  if (!Number.isSafeInteger(ideaIndex) || ideaIndex < 0) return null;
  return { brandId, trendId, ideaIndex };
}

async function continueVideoFromScript(item: GenerationHistoryItem): Promise<void> {
  const context = videoScriptContext(item);
  if (!context) return;
  const videoScriptGenerationId = Number(item.id);
  if (!Number.isSafeInteger(videoScriptGenerationId) || videoScriptGenerationId <= 0) return;
  startingVideoProject.value = true;
  startVideoError.value = "";
  try {
    const response = await createVideoProject(
      context.brandId,
      context.trendId,
      context.ideaIndex,
      {
        requestId: videoRequestId(),
        videoScriptGenerationId,
        model: String(item.payload?.videoModel || "d2"),
        mode: String(item.payload?.videoMode || "text"),
        resolution: String(item.payload?.videoResolution || "720p"),
        aspectRatio: String(item.payload?.aspectRatio || asVideoScript(item)?.aspectRatio || "9:16"),
        totalDurationSec: Number(item.payload?.videoDuration || asVideoScript(item)?.totalDurationSec || 30),
        referenceAssetIds: Array.isArray(item.payload?.referenceAssetIds)
          ? (item.payload?.referenceAssetIds as unknown[]).map((entry) => Number(entry)).filter((entry) => Number.isSafeInteger(entry) && entry > 0)
          : [],
      },
      scope.signalFor(`history-video-create-${videoScriptGenerationId}`),
    );
    if (response.user) auth.user = { ...auth.user, ...response.user };
    else await auth.refreshUser().catch(() => {});
    tasksStore.startVideoProjectTask({
      brandId: context.brandId,
      trendId: context.trendId,
      ideaIndex: context.ideaIndex,
      brandName: item.brandName,
      trendTitle: item.trendTitle,
      ideaTitle: item.ideaTitle,
      cardTitle: item.cardTitle || "AI 视频",
      projectId: response.project.id,
      videoStatus: response.project.status,
    });
    startVideoError.value = "";
    await historyStore.refresh();
    closeDetail();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    startVideoError.value = (error as Error).message || "启动视频生成失败，请稍后再试。";
  } finally {
    startingVideoProject.value = false;
  }
}

function asVideoScript(item: GenerationHistoryItem | null): VideoScript | null {
  if (!item) return null;
  const payload = item.payload as Record<string, unknown> | undefined;
  if (payload?.videoScript && typeof payload.videoScript === "object") {
    return payload.videoScript as VideoScript;
  }
  if (payload?.script && typeof payload.script === "object") {
    return payload.script as VideoScript;
  }
  if (payload && Array.isArray((payload as Record<string, unknown>).clips)) {
    return payload as unknown as VideoScript;
  }
  return null;
}

function videoProjectVideoUrl(item: GenerationHistoryItem | null): string {
  return safeImageSrc(item?.payload?.finalVideoUrl || item?.previewUrl);
}

function videoProjectCardVideoUrl(item: GenerationHistoryItem | null): string {
  const firstClip = videoProjectClips(item)[0];
  return videoProjectVideoUrl(item) || safeImageSrc(String(firstClip?.videoUrl || ""));
}

function videoProjectFinalPosterUrl(item: GenerationHistoryItem | null): string {
  const firstClip = videoProjectClips(item)[0];
  return safeImageSrc(String(item?.payload?.finalPosterUrl || firstClip?.posterUrl || ""));
}

function videoProjectThumbnailUrl(item: GenerationHistoryItem | null): string {
  const firstClip = videoProjectClips(item)[0];
  return safeImageSrc(String(firstClip?.posterUrl || firstClip?.continuityFrameUrl || ""));
}

function videoProjectClips(item: GenerationHistoryItem | null): Array<Record<string, unknown>> {
  return Array.isArray(item?.payload?.videoClips) ? item.payload.videoClips : [];
}

function videoProjectStatusLabel(item: GenerationHistoryItem | null): string {
  return ({
    queued: "生成中",
    running: "生成中",
    submitting: "生成中",
    preparing: "生成中",
    processing_result: "正在处理生成结果",
    result_processing_failed: "结果处理失败",
    project_data_failed: "素材不可用",
    partial_failed: "部分失败",
    uncertain: "待确认",
    waiting_configuration: "等待生成通道配置",
    assembling: "正在拼接成片",
    assembly_failed: "片段已完成，成片拼接失败",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  } as Record<string, string>)[String(item?.payload?.videoStatus || "")] || "生成中";
}

function isVideoProjectGenerating(item: GenerationHistoryItem | null): boolean {
  if (!item || item.type !== "videoProject") return false;
  const status = String(item.payload?.videoStatus || "").toLowerCase();
  return ACTIVE_VIDEO_STATUSES.has(status) || ["queued", "running", "submitting", "preparing", "assembling", "processing_result"].includes(status);
}

function syncVideoClipPrompts(item: GenerationHistoryItem | null): void {
  for (const key of Object.keys(videoClipPrompts)) delete videoClipPrompts[key];
  for (const clip of videoProjectClips(item)) {
    videoClipPrompts[String(clip.index)] = String(clip.prompt || "");
  }
}

function updateVideoProjectDetail(item: GenerationHistoryItem, project: VideoProject): void {
  detailItem.value = {
    ...item,
    payload: {
      ...(item.payload || {}),
      projectId: project.id,
      videoModel: project.model,
      videoMode: project.mode,
      videoResolution: project.resolution,
      videoDuration: project.totalDurationSec,
      videoAspectRatio: project.aspectRatio,
      videoStatus: project.status,
      refundedCredits: project.refundedCredits,
      finalVideoUrl: project.finalVideoUrl || "",
      finalPosterUrl: project.finalPosterUrl || "",
      videoClips: project.clips,
      script: project.script,
    },
  };
  for (const clip of project.clips) {
    if (document.activeElement?.getAttribute("data-clip-prompt") !== String(clip.index)) {
      videoClipPrompts[String(clip.index)] = String(clip.prompt || "");
    }
  }
}

function stopVideoProjectRefresh(): void {
  if (videoProjectRefreshTimer) clearTimeout(videoProjectRefreshTimer);
  videoProjectRefreshTimer = null;
}

function scheduleVideoProjectRefresh(projectId: number, generationId: number, delayMs = 1800): void {
  stopVideoProjectRefresh();
  videoProjectRefreshTimer = setTimeout(async () => {
    const current = detailItem.value;
    if (!current || current.type !== "videoProject" || Number(current.id) !== generationId) return;
    try {
      const response = await fetchVideoProject(projectId, scope.signalFor(`history-video-project-${projectId}`));
      updateVideoProjectDetail(current, response.project);
      if (ACTIVE_VIDEO_STATUSES.has(response.project.status)) {
        scheduleVideoProjectRefresh(projectId, generationId);
        return;
      }
      await historyStore.refresh();
      const refreshed = historyStore.items.find((candidate) => Number(candidate.id) === generationId);
      if (refreshed) {
        updateVideoProjectDetail(refreshed, response.project);
      }
    } catch (error) {
      if (!isAbortError(error) && detailItem.value) scheduleVideoProjectRefresh(projectId, generationId, 4000);
    }
  }, delayMs);
}

function videoRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `history-video-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function retryHistoryVideoAssembly(): Promise<void> {
  const item = detailItem.value;
  const projectId = Number(item?.payload?.projectId);
  if (!item || !Number.isSafeInteger(projectId) || projectId <= 0 || retryingVideoAssembly.value) return;
  retryingVideoAssembly.value = true;
  try {
    const response = await retryVideoProjectAssembly(projectId, videoRequestId(), scope.signalFor("history-video-assembly-retry"));
    const project = response.project;
    detailItem.value = {
      ...item,
      payload: {
        ...(item.payload || {}),
        projectId: project.id,
        videoModel: project.model,
        videoMode: project.mode,
        videoResolution: project.resolution,
        videoDuration: project.totalDurationSec,
        videoAspectRatio: project.aspectRatio,
        videoStatus: project.status,
        refundedCredits: project.refundedCredits,
        finalVideoUrl: project.finalVideoUrl || "",
        finalPosterUrl: project.finalPosterUrl || "",
        videoClips: project.clips,
        script: project.script,
      },
    };
    await historyStore.refresh();
    const refreshed = historyStore.items.find((candidate) => Number(candidate.id) === Number(item.id));
    if (refreshed) detailItem.value = refreshed;
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    alert(`重新拼接失败：${(error as Error).message}`);
  } finally {
    retryingVideoAssembly.value = false;
  }
}

function formatTime(value?: string): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

function resetFilters() {
  Object.assign(filters, createEmptyGenerationHistoryFilters());
}

async function removeItem(generationId: number) {
  const item = generations.value.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  if (!confirm(`确定删除「${item.cardTitle || item.ideaTitle || "这条生成内容"}」吗？删除后将无法找回。`)) return;
  try {
    await deleteGeneration(generationId, scope.signalFor(`delete-${generationId}`));
    historyStore.removeGeneration(generationId);
    if (detailItem.value && Number(detailItem.value.id) === Number(generationId)) closeDetail();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    alert(`删除失败：${(error as Error).message}`);
  }
}

function openDetail(item: GenerationHistoryItem, slideUrl = "") {
  detailItem.value = item;
  if (item.type === "videoScript" || item.type === "videoProject") {
    detailSlideIndex.value = null;
    editEntryId.value = null;
    if (item.type === "videoProject") {
      syncVideoClipPrompts(item);
      const projectId = Number(item.payload?.projectId);
      if (Number.isSafeInteger(projectId) && projectId > 0) {
        scheduleVideoProjectRefresh(projectId, Number(item.id), 300);
      }
    }
    return;
  }
  const slides = slideImages(item);
  const requestedUrl = slideUrl || safeImageSrc(item.previewUrl);
  const selected = slides.find((slide) => slide.src === requestedUrl) || slides[0] || null;
  detailSlideIndex.value = selected?.sourceIndex ?? null;
  editEntryId.value = null;
}

function closeDetail() {
  stopVideoProjectRefresh();
  detailItem.value = null;
  detailSlideIndex.value = null;
  editEntryId.value = null;
}

function openEditFromHistory(entryId: string | null): void {
  editEntryId.value = entryId;
}

function selectSlide(sourceIndex: number): void {
  detailSlideIndex.value = sourceIndex;
  editEntryId.value = null;
}

async function onEdited(): Promise<void> {
  try {
    await auth.refreshUser();
  } catch (error) {
    if (isAbortError(error) || isUnauthorized(error)) return;
  }
  await historyStore.refresh();
}

onMounted(() => {
  tasksStore.markAllViewed();
  historyStore.ensureLoaded().catch((error) => {
    handleUnauthorizedError(error);
  });
  historyStore.loadBrands().catch(() => {});
});

onUnmounted(() => {
  if (signatureRefreshTimer) clearTimeout(signatureRefreshTimer);
  stopVideoProjectRefresh();
});
</script>

<template>
  <section class="history-view">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon">◍</span>
          <h1 class="panel-title">历史生成</h1>
        </div>
        <p class="panel-subtitle">查看所有生成过的图片、标题和文案，统一回看并复用已产出的内容资产。</p>
      </div>
    </header>

    <div class="history-retention-note" role="note">历史生成图片会保存 30 天，请及时下载。</div>

    <section class="history-filters" aria-label="历史生成筛选">
      <label class="history-filter-search">
        <span>搜索</span>
        <input
          v-model="filters.q"
          type="search"
          placeholder="搜索标题、摘要、品牌或趋势"
          data-test="history-search"
        />
      </label>
      <label>
        <span>品牌</span>
        <select v-model="filters.brandId" data-test="history-brand">
          <option value="">全部品牌</option>
          <option v-for="brand in brands" :key="brand.id" :value="String(brand.id)">{{ brand.name }}</option>
        </select>
      </label>
      <label>
        <span>类型</span>
        <select v-model="filters.type" data-test="history-type">
          <option value="">全部类型</option>
          <option v-for="[value, label] in TYPE_OPTIONS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>
        <span>开始日期</span>
        <input v-model="filters.from" type="date" />
      </label>
      <label>
        <span>结束日期</span>
        <input v-model="filters.to" type="date" />
      </label>
      <div class="history-filter-actions">
        <button type="button" class="secondary-btn small-btn" @click="resetFilters">重置</button>
        <button
          type="button"
          class="secondary-btn small-btn"
          data-test="history-refresh"
          :disabled="historyStore.loading || historyStore.refreshing"
          @click="historyStore.refresh()"
        >
          {{ historyStore.refreshing ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </section>

    <p v-if="loadError" class="history-error" data-test="history-error">{{ loadError }}</p>
    <p v-else-if="loading && !generations.length" class="history-loading">正在加载历史生成…</p>

    <div v-if="!loading && !visibleHistory.length && !loadError" class="history-empty" data-test="history-empty">
      {{
        hasFilters
          ? "没有找到符合筛选条件的历史生成记录。"
          : "你还没有任何生成记录。去内容选题页生成朋友圈图、公众号长图、小红书组图或视频脚本后，这里会自动沉淀下来。"
      }}
    </div>

    <div class="history-generate-list" data-test="history-generate-list">
      <article v-for="item in visibleHistory" :key="item.id" class="history-card" data-test="history-card">
        <div class="history-card-top">
          <div>
            <div class="history-card-meta">
              <span class="brand-tag">{{ item.channelLabel }}</span>
              <span class="brand-tag">{{ typeLabel(item) }}</span>
              <span v-if="aspectRatioOf(item)" class="brand-tag">{{ aspectRatioOf(item) }}</span>
              <span v-if="(item as any).isPlaceholder" class="brand-tag is-generating-tag" data-test="history-placeholder-tag">
                <span class="history-spinner-xs" aria-hidden="true"></span>
                {{ (item as any).placeholderStatus === "submitting" ? "准备中…" : "生图中…" }}
              </span>
              <span v-if="(item.type === 'videoScript' || item.type === 'videoProject') && (asVideoScript(item)?.totalDurationSec || item.payload?.videoDuration)" class="brand-tag">
                {{ asVideoScript(item)?.totalDurationSec || item.payload?.videoDuration }} 秒
              </span>
              <span v-if="item.type === 'videoScript' && asVideoScript(item)?.clips?.length" class="brand-tag">
                {{ asVideoScript(item)?.clips?.length }} 个片段
              </span>
              <span
                v-if="item.type === 'videoProject'"
                class="brand-tag"
                :class="{ 'is-generating-tag': isVideoProjectGenerating(item) }"
                data-test="history-video-status-tag"
              >
                <span v-if="isVideoProjectGenerating(item)" class="history-spinner-xs" aria-hidden="true"></span>
                {{ item.payload?.videoModel?.toString().toUpperCase() }} · {{ videoProjectStatusLabel(item) }}
              </span>
              <span class="history-card-time">{{ formatTime(item.createdAt) }}</span>
              <span v-if="(item.payload?.editHistory || []).length" class="brand-tag">
                已改图 {{ (item.payload?.editHistory || []).length }} 次
              </span>
            </div>
            <div v-if="(item as any).isPlaceholder && (!item.cardTitle || item.cardTitle === '生图任务')" class="skeleton-line skeleton-title" data-test="history-skeleton-title"></div>
            <h3 v-else>{{ item.cardTitle }}</h3>
            <div v-if="(item as any).isPlaceholder && !item.brandName && !item.trendTitle" class="skeleton-line skeleton-ref"></div>
            <template v-else>
              <div v-if="item.brandName || item.trendTitle" class="history-card-ref">{{ item.brandName }} · {{ item.trendTitle }}</div>
              <div v-if="item.ideaTitle" class="history-card-ref">{{ item.ideaTitle }}</div>
            </template>
          </div>
          <div class="history-card-actions">
            <button
              v-if="item.type === 'videoScript' && !(item as any).isPlaceholder"
              type="button"
              class="secondary-btn"
              data-test="history-detail"
              @click="openDetail(item)"
            >
              查看脚本
            </button>
            <button
              v-else-if="item.type === 'videoProject' && !(item as any).isPlaceholder"
              type="button"
              class="secondary-btn"
              data-test="history-detail"
              @click="openDetail(item)"
            >
              查看视频
            </button>
            <button
              v-else-if="!(item as any).isPlaceholder && getGenerationPrimaryImageUrl(item)"
              type="button"
              class="secondary-btn"
              data-test="history-detail"
              @click="openDetail(item)"
            >
              查看
            </button>
            <button v-if="!(item as any).isPlaceholder" type="button" class="secondary-btn" data-test="history-delete" @click="removeItem(item.id)">删除</button>
          </div>
        </div>

        <div v-if="item.type === 'videoScript'" class="history-copy">
          <p v-if="asVideoScript(item)?.creativeConcept">
            <strong>核心创意：</strong>{{ asVideoScript(item)?.creativeConcept }}
          </p>
          <p v-else-if="item.summary"><strong>内容摘要：</strong>{{ item.summary }}</p>
          <template v-else-if="(item as any).isPlaceholder">
            <div class="skeleton-line skeleton-copy" data-test="history-skeleton-copy"></div>
            <div class="skeleton-line skeleton-copy short"></div>
          </template>
        </div>
        <div v-else-if="item.type === 'videoProject'" class="history-copy">
          <p><strong>生成状态：</strong>{{ videoProjectStatusLabel(item) }} · {{ item.payload?.videoModel?.toString().toUpperCase() || 'D2' }}</p>
          <p v-if="item.summary"><strong>核心创意：</strong>{{ item.summary }}</p>
        </div>
        <div v-else-if="item.type === 'moments'" class="history-copy">
          <p v-if="item.payload?.caption"><strong>朋友圈文案：</strong>{{ item.payload?.caption }}</p>
          <p v-if="item.payload?.visualDirection"><strong>视觉方向：</strong>{{ item.payload?.visualDirection }}</p>
          <template v-if="(item as any).isPlaceholder && !item.payload?.caption && !item.payload?.visualDirection">
            <div class="skeleton-line skeleton-copy" data-test="history-skeleton-copy"></div>
            <div class="skeleton-line skeleton-copy short"></div>
          </template>
        </div>
        <div v-else-if="item.type === 'wechat'" class="history-copy">
          <p v-if="item.payload?.publishTitle"><strong>发布标题：</strong>{{ item.payload?.publishTitle }}</p>
          <p v-if="item.payload?.intro"><strong>文章导语：</strong>{{ item.payload?.intro }}</p>
          <template v-if="(item as any).isPlaceholder && !item.payload?.publishTitle && !item.payload?.intro">
            <div class="skeleton-line skeleton-copy" data-test="history-skeleton-copy"></div>
            <div class="skeleton-line skeleton-copy short"></div>
          </template>
        </div>
        <div v-else class="history-copy">
          <p v-if="item.payload?.publishTitle"><strong>发布标题：</strong>{{ item.payload?.publishTitle }}</p>
          <p v-if="item.payload?.publishCaption"><strong>发布文案：</strong>{{ item.payload?.publishCaption }}</p>
          <template v-if="(item as any).isPlaceholder && !item.payload?.publishTitle && !item.payload?.publishCaption">
            <div class="skeleton-line skeleton-copy" data-test="history-skeleton-copy"></div>
            <div class="skeleton-line skeleton-copy short"></div>
          </template>
        </div>

        <!-- 脚本卡片展示概要 -->
        <div
          v-if="item.type === 'videoScript'"
          class="history-script-box"
          @click="!(item as any).isPlaceholder && openDetail(item)"
        >
          <div class="script-box-inner">
            <span class="script-icon">🎬</span>
            <div class="script-info">
              <template v-if="(item as any).isPlaceholder">
                <strong>{{ item.cardTitle || '视频分镜脚本生成中…' }}</strong>
                <small>AI 正在构思分镜镜头、视觉提示词与配音文案…</small>
              </template>
              <template v-else>
                <strong>{{ asVideoScript(item)?.title || item.cardTitle }}</strong>
                <small>
                  共 {{ asVideoScript(item)?.clips?.length || 0 }} 个分镜提示词 · 时长 {{ asVideoScript(item)?.totalDurationSec || 30 }} 秒 · 比例 {{ item.payload?.aspectRatio || '9:16' }}
                </small>
              </template>
            </div>
          </div>
        </div>
        <div v-else-if="item.type === 'videoProject'" class="history-video-box" @click="openDetail(item)">
          <video
            v-if="videoProjectCardVideoUrl(item)"
            :src="videoProjectCardVideoUrl(item)"
            muted
            playsinline
            preload="metadata"
            :poster="videoProjectThumbnailUrl(item)"
            aria-label="视频首帧预览"
          ></video>
          <img v-else-if="videoProjectThumbnailUrl(item)" :src="videoProjectThumbnailUrl(item)" alt="视频首帧" loading="lazy" />
          <div v-else class="history-video-placeholder" :class="{ 'is-generating': isVideoProjectGenerating(item) }">
            <span v-if="isVideoProjectGenerating(item)" class="history-video-spinner" aria-hidden="true"></span>
            <span v-else class="script-icon">🎬</span>
            <strong>{{ videoProjectStatusLabel(item) }}</strong>
            <small>{{ videoProjectClips(item).length }} 个镜头 · 点击查看进度</small>
          </div>
        </div>

        <div v-else-if="item.type === 'xhsCarousel'" class="history-grid">
          <template v-if="(item as any).isPlaceholder">
            <div v-for="slide in placeholderSlides(item)" :key="slide.index" class="history-slide-cell">
              <img v-if="slide.imageUrl || slide.previewUrl" :src="safeImageSrc(slide.imageUrl || slide.previewUrl)" :alt="slide.title || slide.pageLabel || ''" />
              <div v-else-if="slide.status === 'submitting' || slide.status === 'polling'" class="history-placeholder-cell is-generating" data-test="history-slide-loading">
                <span class="history-spinner-sm"></span>
                <span>{{ slide.pageLabel }} · 生成中</span>
              </div>
              <div v-else-if="slide.status === 'failed'" class="history-placeholder-cell is-failed" data-test="history-slide-failed">
                <span>{{ slide.pageLabel }} · 失败</span>
              </div>
              <div v-else class="history-placeholder-cell is-idle" data-test="history-slide-idle">
                <span>{{ slide.pageLabel }} · 未生成</span>
              </div>
            </div>
          </template>
          <template v-else>
          <div v-for="(slide, index) in slideImages(item)" :key="index" class="history-slide-cell">
            <div v-if="isImageFailed(slide.src)" class="history-image-error" data-test="history-image-error">
              <span>图片加载失败</span>
              <button
                type="button"
                class="secondary-btn"
                data-test="history-image-retry"
                @click="retryImage(slide.src)"
              >
                重试
              </button>
            </div>
            <img
              v-else
              :src="slide.src"
              :alt="slide.title"
              loading="lazy"
              decoding="async"
              @click="openDetail(item, slide.src)"
              @error="onHistoryImageError(slide.src)"
            />
          </div>
          </template>
        </div>
        <div v-else-if="(item as any).isPlaceholder" class="history-placeholder-image" data-test="history-placeholder-image">
          <img v-if="previewSrc(item)" :src="previewSrc(item)" :alt="item.cardTitle || ''" />
          <template v-else>
            <span class="history-spinner"></span>
            <span>AI 正在生成图片中…</span>
          </template>
        </div>
        <button
          v-else-if="previewSrc(item)"
          type="button"
          class="history-preview"
          @click="openDetail(item)"
        >
          <div v-if="isImageFailed(previewSrc(item))" class="history-image-error" data-test="history-image-error">
            <span>图片加载失败</span>
            <button
              type="button"
              class="secondary-btn"
              data-test="history-image-retry"
              @click.stop="retryImage(previewSrc(item))"
            >
              重试
            </button>
          </div>
          <img
            v-else
            :src="previewSrc(item)"
            :alt="item.cardTitle || ''"
            loading="lazy"
            decoding="async"
            @error="onHistoryImageError(previewSrc(item))"
          />
        </button>
      </article>
    </div>

    <!-- 详情弹窗 -->
    <div v-if="detailItem" class="history-modal" @click.self="closeDetail()">
      <div class="history-modal-body" :class="{ 'is-video-script-modal': detailItem.type === 'videoScript' || detailItem.type === 'videoProject' }">
        <header class="history-modal-header">
          <h3>{{ detailItem.cardTitle || (detailItem.type === 'videoScript' ? '视频脚本' : '历史图片') }}</h3>
          <button type="button" class="secondary-btn" @click="closeDetail()">关闭</button>
        </header>

        <!-- 视频脚本详情 -->
        <template v-if="detailItem.type === 'videoScript'">
          <p v-if="startVideoError" class="history-script-empty" data-test="history-script-start-error">{{ startVideoError }}</p>
          <VideoScriptResult
            v-if="asVideoScript(detailItem)"
            :script="asVideoScript(detailItem)!"
            :show-actions="true"
            :show-regenerate="false"
            :show-start-video="videoScriptContext(detailItem) != null && !(detailItem as any).isPlaceholder"
            start-video-label="一键生成整段视频"
            :starting-video="startingVideoProject"
            :start-video-error="startVideoError"
            @close="closeDetail"
            @start-video="continueVideoFromScript(detailItem)"
          />
          <div v-else class="history-script-empty" data-test="history-script-empty">
            <p>该历史记录中未包含有效的分镜脚本数据。</p>
          </div>
        </template>

        <template v-else-if="detailItem.type === 'videoProject'">
          <div class="video-project-detail" data-test="history-video-project-detail">
            <div class="history-asset-header">
              <p class="history-card-ref"><strong>模型：</strong>{{ detailItem.payload?.videoModel?.toString().toUpperCase() || 'D2' }} · <strong>状态：</strong>{{ videoProjectStatusLabel(detailItem) }}</p>
              <p class="history-card-ref"><strong>参数：</strong>{{ detailItem.payload?.videoDuration || asVideoScript(detailItem)?.totalDurationSec || 30 }} 秒 · {{ detailItem.payload?.videoAspectRatio || detailItem.payload?.aspectRatio || '9:16' }}</p>
            </div>
            <div v-if="detailItem.payload?.videoStatus === 'assembly_failed'" class="history-assembly-failed" data-test="history-assembly-failed">
              <strong>视频片段均已生成完成</strong>
              <span>最终成片拼接失败，重新拼接不扣积分。</span>
              <button type="button" class="secondary-btn" data-test="history-retry-assembly" :disabled="retryingVideoAssembly" @click="retryHistoryVideoAssembly">
                {{ retryingVideoAssembly ? '拼接中…' : '重新拼接成片 · 0积分' }}
              </button>
            </div>
            <section class="history-final-video" data-test="history-final-video">
              <div class="history-video-section-heading">
                <div>
                  <span>最终成片</span>
                  <strong>已按镜头顺序自动合并</strong>
                </div>
                <small>{{ detailItem.payload?.videoDuration || asVideoScript(detailItem)?.totalDurationSec || 30 }} 秒</small>
              </div>
              <video
                v-if="videoProjectVideoUrl(detailItem)"
                class="history-video-player"
                controls
                playsinline
                preload="metadata"
                :src="videoProjectVideoUrl(detailItem)"
                :poster="videoProjectFinalPosterUrl(detailItem)"
              ></video>
              <div v-else class="history-video-placeholder large" :class="{ 'is-generating': isVideoProjectGenerating(detailItem) }">
                <span v-if="isVideoProjectGenerating(detailItem)" class="history-video-spinner" aria-hidden="true"></span>
                <strong>{{ videoProjectStatusLabel(detailItem) }}</strong>
                <small>所有分段完成后，系统会自动合并并在这里展示。</small>
              </div>
            </section>
            <p v-if="detailItem.payload?.videoStatus === 'partial_failed' || detailItem.payload?.videoStatus === 'failed'" class="history-video-refund">
              失败镜头的未执行积分会自动退款；本项目累计退款 {{ detailItem.payload?.refundedCredits || 0 }} 积分。
            </p>
            <div class="history-video-section-heading is-clips">
              <div>
                <span>分段镜头</span>
                <strong>查看每段进度并调整提示词</strong>
              </div>
              <small>共 {{ videoProjectClips(detailItem).length }} 段</small>
            </div>
            <p class="history-video-workflow-hint">每段视频生成完毕后会自动替换该段并重新合并最终成片。</p>
            <div v-if="!videoProjectVideoUrl(detailItem) || detailItem.payload?.videoStatus !== 'completed'" class="history-video-clips">
              <article v-for="clip in videoProjectClips(detailItem)" :key="String(clip.id || clip.index)" class="history-video-clip">
                <div class="history-video-clip-heading">
                  <strong>镜头 {{ clip.index }}</strong>
                  <span>{{ clip.status === 'completed' ? '已完成' : ['running', 'queued', 'submitting', 'preparing'].includes(String(clip.status)) ? '生成中' : clip.status === 'processing_result' ? '正在处理生成结果' : clip.status === 'result_processing_failed' ? '生成结果暂未保存成功' : clip.status === 'failed' ? '失败' : clip.status === 'uncertain_submission' ? '待确认' : clip.status === 'waiting_dependency' ? '等待上一镜头' : clip.status === 'waiting_configuration' ? '等待生成通道' : clip.status === 'cancelled' ? '已取消' : '生成中' }}</span>
                  <span>{{ clip.durationSec }} 秒</span>
                </div>
                <div class="history-video-clip-body">
                  <div class="history-video-clip-media">
                    <video
                      v-if="safeImageSrc(String(clip.videoUrl || ''))"
                      class="history-clip-player"
                      controls
                      playsinline
                      preload="metadata"
                      :src="safeImageSrc(String(clip.videoUrl || ''))"
                      :poster="safeImageSrc(String(clip.posterUrl || ''))"
                    ></video>
                    <div v-else-if="String(clip.posterUrl || '') || String(clip.continuityFrameUrl || '')" class="history-clip-poster">
                      <img
                        :src="safeImageSrc(String(clip.posterUrl || clip.continuityFrameUrl || ''))"
                        :alt="`镜头 ${clip.index} 首帧`"
                        loading="lazy"
                      />
                      <div class="history-clip-poster-overlay" data-test="history-clip-poster-overlay">
                        <span class="history-clip-spinner" aria-hidden="true"></span>
                        <strong>{{ ['queued', 'submitting', 'running', 'preparing'].includes(String(clip.status)) ? '正在生成…' : clip.status === 'processing_result' ? '正在处理生成结果…' : clip.status === 'waiting_dependency' ? '等待上一镜头' : clip.status === 'waiting_configuration' ? '等待生成通道' : clip.status === 'failed' ? '生成失败' : '准备中…' }}</strong>
                      </div>
                    </div>
                    <div v-else class="history-clip-placeholder" data-test="history-clip-placeholder">
                      <span class="history-clip-spinner" aria-hidden="true"></span>
                      <strong>{{ ['queued', 'submitting', 'running', 'preparing'].includes(String(clip.status)) ? '正在生成…' : clip.status === 'processing_result' ? '正在处理生成结果…' : clip.status === 'waiting_dependency' ? '等待上一镜头' : clip.status === 'waiting_configuration' ? '等待生成通道' : clip.status === 'failed' ? '生成失败' : '准备中…' }}</strong>
                      <small>视频生成完成后会自动出现在这里</small>
                    </div>
                  </div>
                  <div class="history-video-clip-editor">
                    <label class="history-video-prompt-editor">
                      <span>本段提示词</span>
                      <textarea
                        v-model="videoClipPrompts[String(clip.index)]"
                        :data-clip-prompt="String(clip.index)"
                        data-test="history-clip-prompt"
                        rows="8"
                        :disabled="['queued', 'submitting', 'running', 'processing_result'].includes(String(clip.status))"
                      ></textarea>
                    </label>
                    <small
                      v-if="clip.error && ['failed', 'uncertain_submission', 'cancelled', 'result_processing_failed', 'waiting_configuration'].includes(String(clip.status))"
                      class="history-video-clip-error"
                    >失败原因：{{ clip.error }}</small>
                    <div class="history-video-clip-actions">
                      <a v-if="safeImageSrc(String(clip.videoUrl || ''))" :href="safeImageSrc(String(clip.videoUrl || ''))" download>下载本段</a>
                    </div>
                  </div>
                </div>
              </article>
            </div>
            <VideoScriptResult
              v-if="asVideoScript(detailItem)"
              :script="asVideoScript(detailItem)!"
              :show-actions="false"
              :show-regenerate="false"
            />
          </div>
        </template>

        <!-- 图片类详情 -->
        <template v-else>
          <div class="history-asset-header" data-test="history-asset-header">
            <p class="history-card-ref"><strong>生成类型：</strong>{{ detailItem.channelLabel }} · {{ typeLabel(detailItem) }}</p>
            <p v-if="detailItem.ideaTitle" class="history-card-ref"><strong>来源选题：</strong>{{ detailItem.ideaTitle }}</p>
            <div v-if="detailItem.type === 'moments'" class="history-copy">
              <p v-if="detailItem.payload?.caption"><strong>朋友圈文案：</strong>{{ detailItem.payload?.caption }}</p>
              <p v-if="detailItem.payload?.visualDirection"><strong>视觉方向：</strong>{{ detailItem.payload?.visualDirection }}</p>
            </div>
            <div v-else-if="detailItem.type === 'wechat'" class="history-copy">
              <p v-if="detailItem.payload?.publishTitle"><strong>发布标题：</strong>{{ detailItem.payload?.publishTitle }}</p>
              <p v-if="detailItem.payload?.intro"><strong>文章导语：</strong>{{ detailItem.payload?.intro }}</p>
            </div>
            <div v-else class="history-copy">
              <p v-if="detailItem.payload?.publishTitle"><strong>发布标题：</strong>{{ detailItem.payload?.publishTitle }}</p>
              <p v-if="detailItem.payload?.publishCaption"><strong>发布文案：</strong>{{ detailItem.payload?.publishCaption }}</p>
            </div>
          </div>

          <div v-if="slideImages(detailItem).length > 1" class="history-slide-tabs" data-test="history-slide-tabs">
            <button
              v-for="slide in slideImages(detailItem)"
              :key="slide.sourceIndex"
              type="button"
              class="secondary-btn history-slide-tab"
              :class="{ 'is-active': detailSlideIndex === slide.sourceIndex }"
              :data-test="'history-slide-tab-' + slide.sourceIndex"
              @click="selectSlide(slide.sourceIndex)"
            >
              第 {{ slide.sourceIndex + 1 }} 张
            </button>
          </div>

          <div class="history-detail-grid" data-test="history-detail-grid">
            <div class="history-detail-preview" data-test="history-detail-preview">
              <template v-if="detailImageUrl">
                <div v-if="isImageFailed(detailImageUrl)" class="history-image-error" data-test="history-image-error">
                  <span>图片加载失败</span>
                  <button
                    type="button"
                    class="secondary-btn"
                    data-test="history-image-retry"
                    @click="retryImage(detailImageUrl)"
                  >
                    重试
                  </button>
                </div>
                <img
                  v-else
                  :src="detailImageUrl"
                  :alt="detailItem.cardTitle || '历史生成图片'"
                  @error="onHistoryImageError(detailImageUrl)"
                />
              </template>
            </div>
            <div class="history-detail-form" data-test="history-edit-open" @click="editEntryId = null">
              <h3>原图改图</h3>
              <ImageEditPanel v-if="!editEntryId" :target="editTarget" @edited="onEdited" />
              <p v-else class="history-edit-hint" data-test="history-edit-hint">
                已选择一条改图记录，正在基于该结果继续改图。
              </p>
            </div>
          </div>

          <section class="history-edit-history" data-test="history-edit-history">
            <strong>图片修改历史</strong>
            <p v-if="!editHistoryEntries.length" class="history-edit-empty">还没有改图记录。</p>
            <ul v-else class="history-edit-history-list">
              <li
                v-for="entry in editHistoryEntries"
                :key="String(entry.id || '')"
                class="history-edit-history-item"
                :class="{ 'is-active': editEntryId === String(entry.id || '') }"
                :data-test="'history-edit-history-item-' + String(entry.id || '')"
                @click="openEditFromHistory(String(entry.id || ''))"
              >
                <img
                  v-if="safeImageSrc(entry.imageUrl || entry.previewUrl)"
                  :src="safeImageSrc(entry.imageUrl || entry.previewUrl)"
                  :alt="entry.title || '改图结果'"
                  loading="lazy"
                  decoding="async"
                />
                <div class="history-edit-history-meta">
                  <div class="history-card-meta">
                    <span class="brand-tag">改图</span>
                    <span v-if="entry.sourceSlideIndex != null" class="brand-tag">
                      第 {{ Number(entry.sourceSlideIndex) + 1 }} 张
                    </span>
                    <span class="history-card-time" data-test="history-edit-history-time">
                      {{ formatTime(entry.createdAt || entry.completedAt) }}
                    </span>
                  </div>
                  <h3>{{ entry.title || "改图结果" }}</h3>
                  <ImageEditPanel
                    v-if="editEntryId === String(entry.id || '')"
                    :target="editTargetForEntry(entry)"
                    label="基于此结果继续改图"
                    @edited="onEdited"
                  />
                </div>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.history-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.history-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.history-filters input,
.history-filters select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.history-error {
  color: var(--color-brand);
  font-size: 13px;
}

.history-loading,
.history-empty {
  color: var(--color-text-secondary);
  font-size: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 20px;
  background: var(--color-surface);
}

.history-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px;
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-card-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.history-card-top h3 {
  margin: 6px 0 4px;
  font-size: 16px;
}

.history-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.brand-tag {
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 2px 8px;
  color: var(--color-text-secondary);
}

.history-card-time {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.history-card-ref {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.history-card-actions {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  flex-shrink: 0;
}

.history-copy {
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-copy p {
  margin: 0;
}

.history-script-box {
  border: 1px solid rgba(216, 68, 68, 0.14);
  border-radius: var(--radius-md, 8px);
  background: #fffbf9;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.history-script-box:hover {
  border-color: var(--workspace-brand, #d83b46);
  background: #fff5f3;
}

.history-video-box {
  min-height: 150px;
  overflow: hidden;
  border: 1px solid rgba(216, 68, 68, 0.14);
  border-radius: var(--radius-md, 8px);
  background: #211d1d;
  cursor: pointer;
}

.history-video-box video {
  display: block;
  width: 100%;
  max-height: 260px;
  object-fit: cover;
}

.history-video-box img {
  display: block;
  width: 100%;
  max-height: 260px;
  object-fit: cover;
}

.history-video-placeholder {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #fff5f0;
  text-align: center;
}

.history-video-placeholder small {
  color: #d9c8c2;
  font-size: 12px;
}

.history-video-placeholder.large {
  width: min(100%, 760px);
  min-height: 0;
  aspect-ratio: 16 / 9;
  margin: 0 auto;
  border-radius: var(--radius-md, 8px);
  background: #211d1d;
}

.history-video-player {
  display: block;
  width: min(100%, 760px);
  aspect-ratio: 16 / 9;
  max-height: none;
  margin: 0 auto;
  border-radius: var(--radius-md, 8px);
  background: #211d1d;
  object-fit: contain;
}

.history-final-video,
.video-project-detail {
  display: grid;
  gap: 14px;
}

.history-video-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.history-video-section-heading > div {
  display: grid;
  gap: 3px;
}

.history-video-section-heading span {
  color: var(--workspace-brand, var(--color-brand));
  font-size: 12px;
  font-weight: 700;
}

.history-video-section-heading strong {
  color: var(--workspace-text, var(--color-text-primary));
  font-size: 16px;
}

.history-video-section-heading small {
  color: var(--workspace-text-muted, var(--color-text-secondary));
}

.history-video-section-heading.is-clips {
  margin-top: 8px;
  padding-top: 18px;
  border-top: 1px solid var(--workspace-border, var(--color-border));
}

.history-video-workflow-hint {
  margin: -6px 0 0;
  color: var(--workspace-text-muted, var(--color-text-secondary));
  font-size: 13px;
}

.history-assembly-failed {
  display: grid;
  gap: 8px;
  margin: 12px 0;
  padding: 12px;
  border: 1px solid #ead7c8;
  border-radius: var(--radius-md, 8px);
  background: #fff8f1;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.history-assembly-failed strong {
  color: var(--color-text-primary);
}

.history-assembly-failed .secondary-btn {
  justify-self: start;
}

.history-video-clips {
  display: grid;
  gap: 7px;
}

.history-video-clip {
  display: grid;
  gap: 12px;
  padding: 14px 16px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  background: var(--workspace-surface, #fff);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.history-video-clip-heading,
.history-video-clip-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.history-video-clip-heading {
  justify-content: space-between;
}

.history-video-clip-heading strong {
  color: var(--color-text-primary);
}

.history-video-clip-body {
  display: grid;
  grid-template-columns: minmax(260px, 0.95fr) minmax(0, 1.05fr);
  align-items: stretch;
  gap: 18px;
  min-width: 0;
}

.history-video-clip-media {
  position: relative;
  overflow: hidden;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--workspace-radius-sm, var(--radius-md, 8px));
  background: #211d1d;
}

.history-clip-player {
  display: block;
  width: 100%;
  height: 100%;
  max-height: none;
  border-radius: inherit;
  background: #211d1d;
  object-fit: contain;
}

.history-clip-poster {
  position: relative;
  width: 100%;
  height: 100%;
}

.history-clip-poster img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: brightness(0.7);
}

.history-clip-poster-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  color: #fff5f0;
  text-align: center;
  background: linear-gradient(180deg, rgba(33, 29, 29, 0.18), rgba(33, 29, 29, 0.62));
}

.history-clip-poster-overlay strong {
  font-size: 14px;
}

.history-clip-placeholder {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  background: repeating-linear-gradient(135deg, #2a2424 0 12px, #211d1d 12px 24px);
  color: #fff5f0;
  text-align: center;
}

.history-clip-placeholder strong {
  font-size: 14px;
}

.history-clip-placeholder small {
  color: #d9c8c2;
  font-size: 12px;
}

.history-clip-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255, 245, 240, 0.25);
  border-top-color: #fff5f0;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.history-video-clip-editor {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
}

.history-video-clip-error {
  color: var(--color-brand);
  line-height: 1.5;
}

.history-video-prompt-editor {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 6px;
}

.history-video-prompt-editor span {
  color: var(--workspace-text, var(--color-text-primary));
  font-size: 12px;
  font-weight: 700;
}

.history-video-prompt-editor textarea {
  width: 100%;
  min-height: 176px;
  flex: 1;
  resize: vertical;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius-sm, var(--radius-md));
  padding: 10px 12px;
  background: var(--workspace-surface, #fff);
  color: var(--workspace-text, var(--color-text-primary));
  font: inherit;
  line-height: 1.6;
  outline: none;
}

.history-video-prompt-editor textarea:focus {
  border-color: var(--workspace-brand, var(--color-brand));
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.1);
}

.history-video-prompt-editor textarea:disabled {
  cursor: not-allowed;
  background: var(--workspace-surface-soft, #faf7f5);
  color: var(--workspace-text-muted, var(--color-text-secondary));
}

.history-video-clip-actions a {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  padding: 0 12px;
  border: 1px solid rgba(216, 68, 68, 0.18);
  border-radius: var(--workspace-radius-sm, var(--radius-md, 8px));
  background: #fff8f7;
  color: var(--color-brand);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
}

.history-video-clip-actions a:hover {
  border-color: rgba(216, 68, 68, 0.34);
  background: #fff1ef;
}

.history-video-refund {
  margin: 10px 0;
  color: var(--color-success, #2c7547);
  font-size: 12px;
}

.script-box-inner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.script-icon {
  font-size: 24px;
}

.script-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.script-info strong {
  font-size: 13.5px;
  color: var(--workspace-text, #222);
}

.script-info small {
  color: var(--workspace-text-muted, #7c7074);
  font-size: 12px;
}

.history-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.history-grid img {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  cursor: pointer;
}

.history-slide-cell {
  min-width: 0;
}

@keyframes skeleton-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(90deg, #f0eae6 25%, #fbf8f6 50%, #f0eae6 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
}

.skeleton-title {
  height: 20px;
  width: 60%;
  margin: 10px 0 8px;
}

.skeleton-ref {
  height: 12px;
  width: 40%;
  margin-bottom: 6px;
}

.skeleton-copy {
  width: 90%;
  margin-bottom: 6px;
}

.skeleton-copy.short {
  width: 65%;
}

.history-placeholder-image {
  width: 100%;
  aspect-ratio: 16 / 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 1px dashed rgba(216, 68, 68, 0.24);
  border-radius: var(--radius-md);
  background: #fff9f8;
  color: #b83a3d;
  font-size: 13px;
  font-weight: 600;
}

.history-placeholder-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-md);
}

.history-placeholder-cell {
  width: 100%;
  aspect-ratio: 1 / 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: #faf7f5;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.history-placeholder-cell.is-generating {
  border-color: rgba(216, 68, 68, 0.35);
  background: #fff7f5;
  color: #b83a3d;
  font-weight: 600;
}

.history-placeholder-cell.is-idle {
  border-color: var(--color-border);
  background: #faf7f5;
  color: var(--color-text-secondary);
}

.history-placeholder-cell.is-failed {
  border-color: rgba(201, 42, 42, 0.35);
  background: #fff5f5;
  color: #c92a2a;
}

.history-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(216, 68, 68, 0.2);
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.history-spinner-sm {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(216, 68, 68, 0.2);
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.history-spinner-xs {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border: 2px solid rgba(216, 68, 68, 0.25);
  border-top-color: var(--workspace-brand, #d83b46);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.history-video-spinner {
  display: inline-block;
  width: 26px;
  height: 26px;
  margin-bottom: 4px;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--workspace-brand, #e5484d);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.is-generating-tag {
  background: #ffebe8 !important;
  color: #b83a3d !important;
  border: 1px solid rgba(216, 68, 68, 0.25) !important;
  display: inline-flex;
  align-items: center;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.history-image-error {
  width: 100%;
  aspect-ratio: 3 / 4;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 13px;
}

.history-preview {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.history-preview img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.history-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 24px;
}

.history-modal-body {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 20px;
  width: min(920px, 100%);
  max-height: 90vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.history-modal-body.is-video-script-modal {
  width: min(1180px, calc(100vw - 48px));
}

.history-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.history-modal-header h3 {
  margin: 0;
  font-size: 16px;
}

.history-modal-image {
  max-width: 100%;
  border-radius: var(--radius-md);
}

.history-slide-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.history-slide-tab.is-active {
  border-color: var(--color-brand, #2f6fed);
  color: var(--color-brand, #2f6fed);
  font-weight: 700;
}

.history-edit-history {
  display: grid;
  gap: 8px;
}

.history-edit-history-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-edit-history-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius, var(--radius-md));
  background: var(--workspace-surface-soft, #faf7f5);
  cursor: pointer;
}

.history-edit-history-item.is-active {
  border-color: var(--workspace-brand, var(--color-brand, #2f6fed));
}

.history-edit-history-item img {
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: var(--workspace-radius-sm, var(--radius-md, 8px));
  border: 1px solid var(--workspace-border, var(--color-border));
}

.history-edit-history-meta {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 8px;
  align-content: start;
}

.history-edit-history-meta h3 {
  margin: 0;
  font-size: 13px;
}

.history-edit-empty {
  margin: 0;
  color: var(--workspace-text-muted, var(--color-text-secondary));
  font-size: 13px;
}

.history-asset-header {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius, var(--radius-md));
  background: var(--workspace-surface-soft, #faf7f5);
}

.history-asset-header p {
  margin: 0;
}

.history-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.history-detail-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius-sm, var(--radius-md));
  background: #faf7f5;
}

.history-detail-preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.history-detail-form {
  display: grid;
  gap: 10px;
  align-content: start;
}

.history-detail-form h3 {
  margin: 0;
  font-size: 15px;
}

.history-edit-hint {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius-sm, var(--radius-md));
  color: var(--workspace-text-muted, var(--color-text-secondary));
  font-size: 13px;
  background: var(--workspace-surface-soft, #faf7f5);
}

/* Legacy light-workspace history parity. */
.history-view {
  gap: 0;
  color: var(--workspace-text);
}

.history-generate-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
  align-items: stretch;
  grid-auto-rows: 560px;
}

.history-card {
  min-height: 560px;
  max-height: 560px;
}

.history-card-top h3 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.history-card-ref {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.history-copy p {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.history-view .panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.history-view .panel-icon-title {
  display: flex;
  align-items: center;
  gap: 14px;
}

.history-view .panel-icon {
  display: block;
  width: 24.0625px;
  color: var(--workspace-brand);
  font-size: 1.8rem;
  font-weight: 400;
}

.history-view .panel-title {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.history-view .panel-subtitle {
  margin: 10px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.view-header h1 {
  margin: 0 0 10px;
  color: var(--workspace-text);
  font-size: 2.1rem;
  line-height: 1.2;
}

.view-subtitle {
  color: var(--workspace-text-muted);
  font-size: 0.98rem;
  line-height: 1.6;
}

.history-filters {
  display: grid;
  grid-template-columns: minmax(220px, 1.4fr) repeat(4, minmax(140px, 1fr)) auto;
  gap: 12px;
  align-items: end;
  margin-bottom: 18px;
}

.history-filter-actions {
  display: flex;
  gap: 6px;
}

.history-retention-note {
  margin: -10px 0 18px;
  padding: 12px 14px;
  border: 1px solid rgba(216, 68, 68, 0.14);
  border-radius: 8px;
  background: #fff7f5;
  color: #6d4d51;
  font-size: 0.95rem;
  line-height: 1.6;
}

.history-filters label {
  display: grid;
  gap: 7px;
  min-width: 0;
  color: #6f687a;
  font-size: 0.78rem;
  font-weight: 700;
}

.history-filters input,
.history-filters select {
  width: 100%;
  min-width: 0;
  height: 42px;
  padding: 0 12px;
  border: 1px solid rgba(18, 16, 17, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--workspace-text);
  font: inherit;
}

.history-filters input:focus,
.history-filters select:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  font-size: 0.9rem;
}

.history-filters .small-btn {
  min-height: 42px;
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.history-error {
  color: #b72e3a;
}

.history-loading,
.history-empty {
  position: relative;
  overflow: hidden;
  padding: 22px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text-muted);
  line-height: 1.7;
}

.history-loading::before,
.history-empty::before,
.history-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.history-card {
  position: relative;
  overflow: hidden;
  gap: 16px;
  padding: 22px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.history-script-box,
.history-video-box,
.history-preview,
.history-grid,
.history-placeholder-image {
  width: 100%;
  height: 220px;
  min-height: 220px;
  margin-top: auto;
}

.history-script-box {
  display: flex;
  align-items: center;
}

.history-video-box video,
.history-video-box img,
.history-preview img {
  width: 100%;
  height: 100%;
  max-height: none;
  aspect-ratio: auto;
  object-fit: cover;
}

.history-video-box {
  overflow: hidden;
  border-radius: var(--workspace-radius-sm, var(--radius-md, 8px));
  background: #211d1d;
}

.history-grid {
  grid-template-rows: repeat(2, minmax(0, 1fr));
}

.history-grid img,
.history-slide-cell {
  height: 100%;
  min-height: 0;
  aspect-ratio: auto;
}

.history-card-top {
  gap: 16px;
}

.history-card-top h3 {
  margin: 10px 0 8px;
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.4;
}

.history-card-meta {
  gap: 8px;
}

.brand-tag {
  padding: 4px 9px;
  border: 0;
  border-radius: var(--workspace-radius-sm);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-weight: 600;
}

.history-card-time,
.history-card-ref {
  color: var(--workspace-text-muted);
  font-size: 0.88rem;
  line-height: 1.6;
}

.history-card-actions {
  gap: 10px;
}

.history-copy {
  color: #4c4244;
  font-size: 0.93rem;
  line-height: 1.75;
}

.history-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.history-grid img,
.history-preview img {
  border-color: rgba(229, 72, 77, 0.08);
  border-radius: var(--workspace-radius-sm);
  background: #faf7f5;
}

.history-modal {
  padding: 28px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.history-modal-body {
  width: min(920px, 100%);
  padding: 24px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.history-modal-header {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--workspace-border);
}

.history-modal-header h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
}

.history-modal-image {
  border-radius: var(--workspace-radius-sm);
}

@media (max-width: 1100px) {
  .history-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .history-filter-search {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .history-filters {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px;
  }

  .history-generate-list {
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: auto;
  }

  .history-card {
    min-height: 0;
    max-height: none;
  }

  .history-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .history-video-clip-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .history-video-prompt-editor textarea {
    min-height: 156px;
  }

  .history-video-clip-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .history-filter-search {
    grid-column: auto;
  }

  .history-filters .small-btn {
    width: 100%;
  }
}
</style>
