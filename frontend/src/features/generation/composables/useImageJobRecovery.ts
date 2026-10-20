/**
 * 付费生图任务恢复服务（挂载于 WorkspaceShell，模块级单例）。
 *
 * 权威来源是服务端当前用户的持久 image_jobs（GET /api/image-jobs/active +
 * 既有 GET /api/image-jobs/:id 轮询）。恢复只轮询既有任务，绝不创建新任务、
 * 绝不扣费；历史写入与失败退款由服务端在轮询时幂等完成。登出/切换账号时
 * notifyAuthReset 中止全部轮询并清空状态，其他账号绝不恢复本账号任务。
 */
import { reactive } from "vue";
import { useAuthStore } from "@/shared/stores/auth";
import { ApiError, isAbortError } from "@/shared/api/client";
import { onAuthReset } from "@/shared/composables/useAbortScope";
import {
  completeXhsCarousel,
  fetchActiveImageJobs,
  fetchImageJob,
  IMAGE_JOB_POLL_INTERVAL_MS,
  type CarouselPack,
  type RecoverableImageJob,
} from "../api";

export type RecoveredTaskStatus = "polling" | "completed" | "failed";

export interface RecoveredSingleTask {
  jobId: string;
  type: string;
  label: string;
  status: RecoveredTaskStatus;
  imageUrl?: string;
  error?: string;
  brandId?: number | null;
  trendId?: number | null;
  ideaIndex?: number | null;
}

export interface RecoveredCarouselSlide {
  index: number;
  status: RecoveredTaskStatus;
  imageUrl?: string;
  title?: string;
  pageLabel?: string;
  prompt?: string;
  copy?: string;
  visualDirection?: string;
  style?: string;
  composition?: string;
  error?: string;
}

export interface RecoveredCarouselGroup {
  groupId: string;
  brandId: number | null;
  trendId: number | null;
  ideaIndex: number | null;
  creditEventId: number | null;
  aspectRatio: string;
  title: string;
  publishTitle: string;
  publishCaption: string;
  caption: string;
  excellentRemix: boolean;
  slides: RecoveredCarouselSlide[];
  completed: boolean;
  completing: boolean;
  error: string;
}

export interface ImageJobRecoveryState {
  scanning: boolean;
  error: string;
  tasks: RecoveredSingleTask[];
  groups: RecoveredCarouselGroup[];
}

export interface ImageJobRecoveryService {
  readonly state: ImageJobRecoveryState;
  start(): void;
  /** 路由/上下文变化后重新扫描：只补充未跟踪的新任务，不重复轮询。 */
  rescan(): void;
  stop(): void;
  dismissTask(jobId: string): void;
  dismissGroup(groupId: string): void;
  dismissError(): void;
}

const TYPE_LABELS: Record<string, string> = {
  moments: "朋友圈图",
  wechat: "公众号长图",
  xhsCarouselSlide: "小红书组图",
  styleImage: "风格化图",
  imageEdit: "改图",
};

function jobLabel(type: string): string {
  return TYPE_LABELS[type] || "生图任务";
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

function createImageJobRecoveryService(): ImageJobRecoveryService {
  const auth = useAuthStore();
  const state = reactive<ImageJobRecoveryState>({
    scanning: false,
    error: "",
    tasks: [],
    groups: [],
  });
  const controllers = new Map<string, AbortController>();
  const groupByJobId = new Map<string, string>();
  /** 注册时固定的 job 上下文（groupId/slideIndex），不依赖扫描快照，杜绝轮询期快照更新竞态。 */
  const jobMeta = new Map<string, { groupId?: string; slideIndex?: number }>();
  /** 用户主动关闭的任务/组：本轮会话内不再重新注册（登出/切号时整体清空）。 */
  const dismissedJobIds = new Set<string>();
  const dismissedGroupIds = new Set<string>();
  let scanController: AbortController | null = null;
  let scanGeneration = 0;
  let pendingRescan = false;

  function stop(): void {
    scanController?.abort();
    scanController = null;
    scanGeneration += 1;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    groupByJobId.clear();
    jobMeta.clear();
    dismissedJobIds.clear();
    dismissedGroupIds.clear();
    pendingRescan = false;
    state.tasks.splice(0, state.tasks.length);
    state.groups.splice(0, state.groups.length);
    state.error = "";
    state.scanning = false;
  }

  onAuthReset(stop);

  function refreshUser(): void {
    void auth.refreshUser().catch((error) => {
      if (isAbortError(error)) return;
      // 积分刷新失败不阻塞恢复结果展示。
    });
  }

  function markTask(jobId: string, patch: Partial<RecoveredSingleTask>): void {
    const task = state.tasks.find((item) => item.jobId === jobId);
    if (task) Object.assign(task, patch);
  }

  function markSlide(jobId: string, patch: Partial<RecoveredCarouselSlide>): void {
    const meta = jobMeta.get(jobId);
    const groupId = meta?.groupId ?? groupByJobId.get(jobId);
    const group = groupId ? state.groups.find((item) => item.groupId === groupId) : null;
    if (!group) return;
    const index = Number(meta?.slideIndex ?? -1);
    const slide = group.slides.find((item) => item.index === index);
    if (slide) Object.assign(slide, patch);
  }

  function registerSingleJob(job: RecoverableImageJob): void {
    state.tasks.push({
      jobId: job.jobId,
      type: job.type,
      label: jobLabel(job.type),
      status: "polling",
      brandId: job.brandId ?? null,
      trendId: job.trendId ?? null,
      ideaIndex: job.ideaIndex ?? null,
    });
    startPoll(job.jobId);
  }

  function registerCarouselJob(job: RecoverableImageJob): void {
    const groupId = String(job.carouselGroupId || "");
    if (!groupId) {
      registerSingleJob(job);
      return;
    }
    groupByJobId.set(job.jobId, groupId);
    const index = Number(job.slideIndex);
    jobMeta.set(job.jobId, { groupId, slideIndex: Number.isInteger(index) && index >= 0 && index <= 3 ? index : undefined });
    let group = state.groups.find((item) => item.groupId === groupId);
    if (!group) {
      group = {
        groupId,
        brandId: job.brandId ?? null,
        trendId: job.trendId ?? null,
        ideaIndex: job.ideaIndex ?? null,
        creditEventId: job.creditEventId ?? null,
        aspectRatio: job.aspectRatio || "",
        title: job.carouselTitle || job.publishTitle || "小红书组图",
        publishTitle: job.publishTitle || "",
        publishCaption: job.publishCaption || "",
        caption: job.caption || "",
        excellentRemix: job.excellentRemix === true,
        slides: [],
        completed: false,
        completing: false,
        error: "",
      };
      state.groups.push(group);
    }
    if (Number.isInteger(index) && index >= 0 && index <= 3) {
      const slide = group.slides.find((item) => item.index === index);
      if (!slide) {
        // 用户补生成缺失页后 rescan 注册新 job：恢复中的组图清除此前“中断”文案。
        if (group.error && !group.completed) group.error = "";
        group.slides.push({
          index,
          // 终态页由服务端快照回填：只展示不轮询（completed/failed）。
          status: job.status === "completed" || job.status === "failed" ? job.status : "polling",
          title: job.slide?.title || "",
          pageLabel: job.slide?.pageLabel || `第 ${index + 1} 张`,
          prompt: job.slide?.prompt || "",
          copy: job.slide?.copy || "",
          visualDirection: job.slide?.visualDirection || "",
          style: job.slide?.style || "",
          composition: job.slide?.composition || "",
          imageUrl: String(job.imageUrl || job.slide?.imageUrl || ""),
          error: job.status === "failed" ? job.error || "图片生成失败" : "",
        });
      }
    }
    if (job.status === "completed" || job.status === "failed") {
      // 终态成员：直接评估组进度（全部完成→complete；部分终态→明确文案）。
      if (job.status === "completed") {
        void maybeCompleteGroup(groupId);
        void finalizePartialGroupIfTerminal(groupId);
      } else {
        void finalizePartialGroupIfTerminal(groupId);
      }
    } else {
      startPoll(job.jobId);
    }
  }

  function startPoll(jobId: string): void {
    if (controllers.has(jobId)) return;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    void pollUntilTerminal(jobId, controller.signal);
  }

  async function pollUntilTerminal(jobId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      let result;
      try {
        result = await fetchImageJob(jobId, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // 任务不存在或不属于当前会话：立即终态（404），绝不无限重试；
        // 会话失效（401）同样终态并触发全局登出。
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          const message = error.status === 404 ? "任务不存在或无权访问，已停止恢复。" : "登录已失效，已停止恢复。";
          markTask(jobId, { status: "failed", error: message });
          markSlide(jobId, { status: "failed", error: message });
          const groupId = groupByJobId.get(jobId);
          if (groupId) void finalizePartialGroupIfTerminal(groupId);
          controllers.delete(jobId);
          if (error.status === 401) {
            auth.handleUnauthorized();
          }
          return;
        }
        try {
          await sleep(IMAGE_JOB_POLL_INTERVAL_MS, signal);
        } catch {
          return;
        }
        continue;
      }
      if (signal.aborted) return;
      if (result.status === "completed") {
        const imageUrl = String(result.imageConcept?.imageUrl || result.imageConcept?.previewUrl || "");
        markTask(jobId, { status: "completed", imageUrl: imageUrl || undefined });
        markSlide(jobId, { status: "completed", imageUrl: imageUrl || undefined });
        refreshUser();
        const groupId = groupByJobId.get(jobId);
        if (groupId) void maybeCompleteGroup(groupId);
        if (groupId) void finalizePartialGroupIfTerminal(groupId);
        controllers.delete(jobId);
        return;
      }
      if (result.status === "failed") {
        const message = result.error || "图片生成失败";
        markTask(jobId, { status: "failed", error: message });
        markSlide(jobId, { status: "failed", error: message });
        refreshUser();
        const groupId = groupByJobId.get(jobId);
        if (groupId) void finalizePartialGroupIfTerminal(groupId);
        controllers.delete(jobId);
        return;
      }
      try {
        await sleep(IMAGE_JOB_POLL_INTERVAL_MS, signal);
      } catch {
        return;
      }
    }
  }

  function buildCarouselPack(group: RecoveredCarouselGroup): CarouselPack {
    return {
      title: group.title,
      publishTitle: group.publishTitle,
      publishCaption: group.publishCaption,
      caption: group.caption,
      aspectRatio: group.aspectRatio,
      carouselGroupId: group.groupId,
      slides: [...group.slides]
        .sort((left, right) => left.index - right.index)
        .map((slide) => ({
          title: slide.title || "",
          pageLabel: slide.pageLabel || `第 ${slide.index + 1} 张`,
          copy: slide.copy || "",
          prompt: slide.prompt || "",
          visualDirection: slide.visualDirection || "",
          style: slide.style || "",
          composition: slide.composition || "",
          imageUrl: slide.imageUrl || "",
          previewUrl: slide.imageUrl || "",
        })),
    };
  }

  async function maybeCompleteGroup(groupId: string): Promise<void> {
    const group = state.groups.find((item) => item.groupId === groupId);
    if (!group || group.completed || group.completing) return;
    if (group.excellentRemix) return; // 仿图文完成走其自身流程，服务端已按组落历史
    if (group.slides.length !== 4 || !group.slides.every((slide) => slide.status === "completed")) return;
    if (group.brandId == null || group.trendId == null || group.ideaIndex == null) {
      group.error = "任务上下文已失效，无法写入历史。";
      return;
    }
    group.completing = true;
    try {
      await completeXhsCarousel(group.brandId, group.trendId, group.ideaIndex, {
        carouselPack: buildCarouselPack(group),
        creditEventId: group.creditEventId,
      });
      group.completed = true;
      group.error = "";
      refreshUser();
    } catch (error) {
      if (isAbortError(error)) return;
      group.error = `组图写入历史失败：${(error as Error).message}`;
    } finally {
      group.completing = false;
    }
  }

  /**
   * 部分组图终态化：组内所有已注册页都到达终态（完成/失败）且不足 4 页时，
   * 组图不可能再自动完成——给出明确文案与可关闭入口，禁止永久“正在恢复”。
   */
  function finalizePartialGroupIfTerminal(groupId: string): void {
    const group = state.groups.find((item) => item.groupId === groupId);
    if (!group || group.completed || group.completing) return;
    if (group.slides.length === 0) return;
    if (!group.slides.every((slide) => slide.status === "completed" || slide.status === "failed")) return;
    // 仿图文恢复组：服务端在每页轮询时已按组落历史，4/4 全完成即视为完成，
    // 不再调用 complete（该组也永远不会走 maybeCompleteGroup）。
    if (group.excellentRemix && group.slides.length === 4 && group.slides.every((slide) => slide.status === "completed")) {
      group.completed = true;
      group.error = "";
      return;
    }
    if (group.slides.length === 4 && group.slides.every((slide) => slide.status === "completed")) return; // 4/4 由 complete 处理
    const failedCount = group.slides.filter((slide) => slide.status === "failed").length;
    const doneCount = group.slides.filter((slide) => slide.status === "completed").length;
    if (failedCount > 0) {
      group.error = group.excellentRemix
        ? `组图有 ${failedCount} 页生成失败，已停止恢复；可到优秀内容页重新生成该页。`
        : `组图有 ${failedCount} 页生成失败，已停止恢复；可到内容选题重新生成该页。`;
    } else {
      group.error = group.excellentRemix
        ? `组图仅完成 ${doneCount}/4 页，其余页面未创建，不会自动补页；可到优秀内容页重新生成。`
        : `组图仅完成 ${doneCount}/4 页，其余页面未创建，不会自动补页；可到内容选题重新生成。`;
    }
  }

  function start(): void {
    if (state.scanning) {
      // 扫描在途：记录补扫请求，当前扫描结束后立即再扫一次（不丢弃新任务）。
      pendingRescan = true;
      return;
    }
    if (!auth.isLoggedIn) return;
    state.scanning = true;
    state.error = "";
    scanController = new AbortController();
    const scanSignal = scanController.signal;
    const generation = ++scanGeneration;
    void fetchActiveImageJobs(scanSignal)
      .then(({ jobs }) => {
        if (scanSignal.aborted || !auth.isLoggedIn || generation !== scanGeneration) return;
        const jobsList = Array.isArray(jobs) ? jobs : [];
        for (const job of jobsList) {
          if (scanSignal.aborted || !auth.isLoggedIn || generation !== scanGeneration) return;
          if (dismissedJobIds.has(job.jobId)) continue;
          if (job.carouselGroupId && dismissedGroupIds.has(job.carouselGroupId)) continue;
          if (controllers.has(job.jobId)) continue;
          if (job.type === "xhsCarouselSlide" && job.carouselGroupId) {
            registerCarouselJob(job);
          } else {
            registerSingleJob(job);
          }
        }
      })
      .catch((error) => {
        if (isAbortError(error) || scanSignal.aborted || generation !== scanGeneration) return;
        state.error = `生图任务恢复失败：${(error as Error).message}`;
      })
      .finally(() => {
        if (generation === scanGeneration) {
          state.scanning = false;
          if (pendingRescan) {
            pendingRescan = false;
            start();
          }
        }
      });
  }

  function rescan(): void {
    if (!auth.isLoggedIn) return;
    start();
  }

  function dismissTask(jobId: string): void {
    dismissedJobIds.add(jobId);
    controllers.get(jobId)?.abort();
    controllers.delete(jobId);
    jobMeta.delete(jobId);
    const index = state.tasks.findIndex((task) => task.jobId === jobId);
    if (index >= 0) state.tasks.splice(index, 1);
    groupByJobId.delete(jobId);
  }

  function dismissGroup(groupId: string): void {
    dismissedGroupIds.add(groupId);
    for (const [jobId, id] of [...groupByJobId]) {
      if (id === groupId) {
        dismissedJobIds.add(jobId);
        controllers.get(jobId)?.abort();
        controllers.delete(jobId);
        jobMeta.delete(jobId);
      }
    }
    const index = state.groups.findIndex((group) => group.groupId === groupId);
    if (index >= 0) state.groups.splice(index, 1);
    for (const [jobId, id] of [...groupByJobId]) {
      if (id === groupId) groupByJobId.delete(jobId);
    }
  }

  function dismissError(): void {
    state.error = "";
  }

  return {
    state,
    start,
    rescan,
    stop,
    dismissTask,
    dismissGroup,
    dismissError,
  };
}

let service: ImageJobRecoveryService | null = null;

export function useImageJobRecovery(): ImageJobRecoveryService {
  if (!service) service = createImageJobRecoveryService();
  return service;
}

/** 测试专用：销毁单例并中止全部轮询。 */
export function resetImageJobRecoveryForTests(): void {
  service?.stop();
  service = null;
}
