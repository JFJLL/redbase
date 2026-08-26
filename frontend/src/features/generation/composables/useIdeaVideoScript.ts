import { computed, ref, type Ref } from "vue";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { useHistoryStore } from "@/features/history/stores/history";
import type { GenerationHistoryItem } from "@/features/history/api";
import {
  submitVideoScript,
  type ProductImageInput,
  type VideoScript,
  type VideoScriptRequest,
  type VideoScriptSubmitResult,
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
  videoModel?: Ref<string | undefined>;
  videoMode?: Ref<string | undefined>;
  videoResolution?: Ref<string | undefined>;
  videoReferenceImageIds?: Ref<number[]>;
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
  const scope = useAbortScope();

  const loading = ref(false);
  const error = ref("");
  const script = ref<VideoScript | null>(null);
  const generation = ref<GenerationHistoryItem | null>(null);
  const currentRequestId = ref<string>(generateRequestId());

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

    loading.value = true;
    error.value = "";
    const signal = scope.signalFor("video-script");

    const payload: VideoScriptRequest = {
      requestId: reqId,
      aspectRatioSelection: options.aspectRatioSelection.value,
      videoDuration: options.videoDuration?.value || "auto",
      useBrandLogo: options.useBrandLogo.value,
      useProductImages: options.useProductImages.value,
      productImages: options.selectedProductImageInputs.value,
      styleReferenceImages: options.selectedStyleReferenceInputs.value,
      model: options.videoModel?.value || "d2",
      mode: options.videoMode?.value || "text",
      resolution: options.videoResolution?.value || "720p",
      videoReferenceImageIds: options.videoReferenceImageIds?.value || options.selectedProductImageInputs.value.map((item) => Number(item.id)).filter(Boolean),
    };

    try {
      const result: VideoScriptSubmitResult = await submitVideoScript(
        brandId,
        trendId,
        ideaIndex,
        payload,
        signal,
      );

      if (result.user) {
        auth.user = { ...auth.user, ...result.user };
      } else {
        await auth.refreshUser().catch(() => {});
      }

      const generatedScript = (result.videoScript ||
        (result.generation?.payload as Record<string, unknown> | undefined)?.videoScript ||
        null) as VideoScript | null;
      script.value = generatedScript;
      generation.value = (result.generation as GenerationHistoryItem) || null;

      if (generation.value) {
        historyStore.upsertGeneration(generation.value);
      } else {
        historyStore.refresh().catch(() => {});
      }

      return generatedScript;
    } catch (err) {
      if (isAbortError(err)) return null;
      if (options.onUnauthorized && (await options.onUnauthorized(err))) return null;
      if (isUnauthorized(err)) {
        auth.handleUnauthorized();
        return null;
      }
      error.value = (err as Error).message || "视频脚本生成失败，请重试。";
      return null;
    } finally {
      loading.value = false;
    }
  }

  function retry(): Promise<VideoScript | null> {
    return generateScript(currentRequestId.value);
  }

  function reset(): void {
    currentRequestId.value = generateRequestId();
    script.value = null;
    generation.value = null;
    error.value = "";
    loading.value = false;
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
