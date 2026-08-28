import { computed, ref, type Ref } from "vue";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useHistoryStore } from "@/features/history/stores/history";
import { useGenerationTasksStore } from "../stores/generationTasks";
import type { GenerationHistoryItem } from "@/features/history/api";
import type {
  ProductImageInput,
  VideoScript,
  VideoScriptRequest,
} from "../api";

export interface UseIdeaVideoScriptOptions {
  brandId: Ref<number | null | undefined>;
  trendId: Ref<number | null | undefined>;
  ideaIndex: Ref<number | null | undefined>;
  aspectRatioSelection: Ref<string>;
  videoDuration?: Ref<string | undefined>;
  useBrandLogo: Ref<boolean>;
  useProductImages: Ref<boolean>;
  selectedProductImageInputs: Ref<ProductImageInput[]>;
  selectedStyleReferenceInputs: Ref<Array<{ name?: string; dataUrl?: string }>>;
  onUnauthorized?: (error: unknown) => boolean | Promise<boolean>;
}

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `vs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useIdeaVideoScript(options: UseIdeaVideoScriptOptions) {
  const auth = useAuthStore();
  const historyStore = useHistoryStore();
  const tasksStore = useGenerationTasksStore();

  const activeTask = computed(() => {
    if (options.brandId.value == null || options.trendId.value == null || options.ideaIndex.value == null) {
      return undefined;
    }
    return tasksStore.findTask(
      "videoScript",
      Number(options.brandId.value),
      Number(options.trendId.value),
      Number(options.ideaIndex.value),
    );
  });

  const localLoading = ref(false);
  const localError = ref("");
  const localScript = ref<VideoScript | null>(null);
  const localGeneration = ref<GenerationHistoryItem | null>(null);
  const currentRequestId = ref<string>(generateRequestId());

  const loading = computed(() => {
    const t = activeTask.value;
    if (!t) return localLoading.value;
    return t.status === "submitting" || t.status === "polling";
  });

  const error = computed(() => {
    const t = activeTask.value;
    if (t?.status === "failed" && t.error) return t.error;
    return localError.value;
  });

  const script = computed<VideoScript | null>(() => {
    const t = activeTask.value;
    if (t?.status === "completed" && t.videoScript) {
      return t.videoScript;
    }
    return localScript.value;
  });

  const generation = computed<GenerationHistoryItem | null>(() => {
    const t = activeTask.value;
    if (t?.generationId) {
      return historyStore.items.find((item) => Number(item.id) === Number(t.generationId)) || localGeneration.value;
    }
    return localGeneration.value;
  });

  const canGenerate = computed(() => {
    return (
      options.brandId.value != null &&
      options.trendId.value != null &&
      options.ideaIndex.value != null &&
      Number(options.ideaIndex.value) >= 0
    );
  });

  async function generateScript(customRequestId?: string): Promise<VideoScript | null> {
    if (!canGenerate.value || loading.value) return null;

    const brandId = Number(options.brandId.value);
    const trendId = Number(options.trendId.value);
    const ideaIndex = Number(options.ideaIndex.value);
    const reqId = customRequestId || currentRequestId.value;

    localLoading.value = true;
    localError.value = "";

    const payload: VideoScriptRequest = {
      requestId: reqId,
      aspectRatioSelection: options.aspectRatioSelection.value,
      videoDuration: options.videoDuration?.value || "auto",
      useBrandLogo: options.useBrandLogo.value,
      useProductImages: options.useProductImages.value,
      productImages: options.selectedProductImageInputs.value,
      styleReferenceImages: options.selectedStyleReferenceInputs.value,
    };

    try {
      const task = await tasksStore.startVideoScriptTask({
        brandId,
        trendId,
        ideaIndex,
        payload,
      });
      localScript.value = task.videoScript || null;
      localLoading.value = false;
      return task.videoScript || null;
    } catch (err) {
      if (isAbortError(err)) return null;
      if (options.onUnauthorized && (await options.onUnauthorized(err))) return null;
      if (isUnauthorized(err)) {
        auth.handleUnauthorized();
        return null;
      }
      localError.value = (err as Error).message || "视频脚本生成失败，请重试。";
      localLoading.value = false;
      return null;
    }
  }

  function retry(): Promise<VideoScript | null> {
    return generateScript(currentRequestId.value);
  }

  function reset(): void {
    currentRequestId.value = generateRequestId();
    localScript.value = null;
    localGeneration.value = null;
    localError.value = "";
    localLoading.value = false;
  }

  return {
    loading,
    error,
    script,
    generation,
    currentRequestId,
    canGenerate,
    generateScript,
    retry,
    reset,
  };
}

