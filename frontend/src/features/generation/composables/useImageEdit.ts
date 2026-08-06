/**
 * 共享改图能力：POST /api/image-edits → 轮询 /api/image-jobs/:id → 更新积分。
 * 普通图、公众号长图、风格化图、组图任一页、历史原图与历史改图结果共用同一契约，
 * 父链（generationId/parentEditId/slideIndex）由调用方按来源传入，不在此伪造。
 */
import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";
import { useAuthStore } from "@/shared/stores/auth";
import { isAbortError } from "@/shared/api/client";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import {
  pollImageJob,
  submitImageEdit,
  type ImageConceptResult,
  type ImageEditRequest,
} from "../api";
import type { SessionUser } from "@/shared/types/api";

export interface ImageEditTarget {
  imageUrl: string;
  title?: string;
  aspectRatio?: string;
  generationId?: number | null;
  parentEditId?: string | number | null;
  slideIndex?: number | null;
}

export interface RunImageEditOptions {
  signal?: AbortSignal;
  onUser?: (user: SessionUser) => void;
}

/** 提交 + 轮询 + 返回结果的纯函数核心（组件与 composable 共用，不复制实现）。 */
export async function runImageEdit(
  target: ImageEditTarget,
  prompt: string,
  options: RunImageEditOptions = {},
): Promise<ImageConceptResult> {
  const editPrompt = String(prompt || "").trim();
  if (!editPrompt) throw new Error("请填写改图提示词。");
  if (!String(target.imageUrl || "").trim()) throw new Error("请先选择一张已生成的图片再改图。");
  const request: ImageEditRequest = {
    imageUrl: String(target.imageUrl).trim(),
    prompt: editPrompt,
    title: String(target.title || "改图结果").slice(0, 120),
    aspectRatio: target.aspectRatio || "3:4",
  };
  if (target.generationId != null) request.generationId = Number(target.generationId);
  if (target.parentEditId != null && String(target.parentEditId).trim() !== "") {
    request.parentEditId = String(target.parentEditId);
  }
  if (target.slideIndex != null) request.slideIndex = Number(target.slideIndex);

  const submitResult = await submitImageEdit(request, options.signal);
  if (submitResult.user && options.onUser) options.onUser(submitResult.user);
  if (!submitResult.jobId) throw new Error("改图任务创建失败");
  const concept = await pollImageJob(submitResult.jobId, { signal: options.signal, onUser: options.onUser });
  return concept;
}

export type ImageEditPhase = "idle" | "running" | "done" | "error";

/** 组件级改图状态机：单个面板/入口一次一任务，失败可重试。 */
export function useImageEdit(targetRef: MaybeRefOrGetter<ImageEditTarget | null>) {
  const auth = useAuthStore();
  const scope = useAbortScope();
  const prompt = ref("");
  const phase = ref<ImageEditPhase>("idle");
  const status = ref("");
  const error = ref("");
  const result = ref<ImageConceptResult | null>(null);

  const target = computed(() => toValue(targetRef));
  const busy = computed(() => phase.value === "running");
  const canSubmit = computed(
    () => Boolean(target.value?.imageUrl && prompt.value.trim() && !busy.value),
  );

  function applyUser(user: SessionUser): void {
    auth.user = user;
  }

  async function submitEdit(): Promise<boolean> {
    const current = target.value;
    if (!current || busy.value) return false;
    const editPrompt = prompt.value.trim();
    if (!editPrompt || !current.imageUrl) return false;
    const signal = scope.signalFor("image-edit");
    phase.value = "running";
    status.value = "改图任务已进入队列，正在排队生成…";
    error.value = "";
    result.value = null;
    try {
      const concept = await runImageEdit(current, editPrompt, { signal, onUser: applyUser });
      if (signal.aborted) return false;
      result.value = concept;
      phase.value = "done";
      status.value = "改图完成，已写入历史生成。";
      return true;
    } catch (submitError) {
      if (isAbortError(submitError)) return false;
      phase.value = "error";
      status.value = "";
      error.value = `改图失败：${(submitError as Error).message}`;
      return false;
    }
  }

  function reset(): void {
    prompt.value = "";
    phase.value = "idle";
    status.value = "";
    error.value = "";
    result.value = null;
  }

  return {
    prompt,
    phase,
    status,
    error,
    result,
    target,
    busy,
    canSubmit,
    submitEdit,
    reset,
  };
}
