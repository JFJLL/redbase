/**
 * Image job API for the generation feature. Mirrors public/js/api-client.js
 * pollImageJob semantics and image-generation-routes request bodies.
 */
import { apiFetch } from "@/shared/api/client";
import type { SessionUser } from "@/shared/types/api";

export const IMAGE_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
export const IMAGE_JOB_POLL_INTERVAL_MS = 5000;

export interface ImageJobStatusResult {
  status?: string;
  imageConcept?: Record<string, unknown> | null;
  generationId?: number | null;
  persisted?: boolean;
  error?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

export interface ImageConceptResult extends Record<string, unknown> {
  imageUrl?: string;
  previewUrl?: string;
  generationId?: number | null;
  persisted?: boolean;
  jobId?: string;
}

export interface ImageEditRequest {
  imageUrl: string;
  prompt: string;
  title?: string;
  aspectRatio?: string;
  generationId?: number | null;
  parentEditId?: number | null;
  slideIndex?: number | null;
}

export interface ImageEditSubmitResult {
  jobId?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

/** POST /api/image-edits — returns 202 with the queued jobId. */
export function submitImageEdit(body: ImageEditRequest, signal?: AbortSignal): Promise<ImageEditSubmitResult> {
  return apiFetch("/api/image-edits", { method: "POST", body, signal });
}

export function fetchImageJob(jobId: string, signal?: AbortSignal): Promise<ImageJobStatusResult> {
  return apiFetch(`/api/image-jobs/${encodeURIComponent(jobId)}`, { signal });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollImageJobOptions {
  maxWaitMs?: number;
  delayMs?: number;
  signal?: AbortSignal;
  onUser?: (user: SessionUser) => void;
}

/**
 * Poll an image job until completed/failed/timeout. Aborting the signal stops
 * the loop immediately (both the fetch and the wait between attempts).
 */
export async function pollImageJob(jobId: string, options: PollImageJobOptions = {}): Promise<ImageConceptResult> {
  const maxWaitMs = options.maxWaitMs ?? IMAGE_JOB_MAX_WAIT_MS;
  const delayMs = options.delayMs ?? IMAGE_JOB_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    const result = await fetchImageJob(jobId, options.signal);
    if (result.user && options.onUser) options.onUser(result.user);
    if (result.status === "completed") {
      return {
        ...(result.imageConcept || {}),
        generationId: result.generationId ?? null,
        persisted: Boolean(result.persisted),
        jobId,
      };
    }
    if (result.status === "failed") {
      throw new Error(result.error || "图片生成失败");
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error(`图片生成时间超过 ${Math.round(maxWaitMs / 60000)} 分钟，请稍后再试。`);
    }
    await sleep(delayMs, options.signal);
  }
}
