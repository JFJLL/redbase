<script setup lang="ts">
// 生图任务恢复提示（toast presenter）：
// 常驻“生图任务恢复”卡片已移除。恢复服务照常扫描/轮询服务端权威任务；
// 终态事件只以自动消失的 toast 呈现，扫描与轮询过程不产生任何常驻 UI。
// 只读展示，不在此发起任何生成 POST；失败退款与历史写入仍由服务端轮询时幂等完成。
import { onBeforeUnmount, ref, watch } from "vue";
import { useImageJobRecovery } from "../composables/useImageJobRecovery";

const TOAST_DURATION_MS = 4000;
const AGGREGATE_WINDOW_MS = 600;

interface RecoveryToastEvent {
  kind: "completed" | "failed";
  label: string;
  group: boolean;
  hasFailedSlides: boolean;
  /** 404/401 等未扣费终态：不得冒充“积分已退回”。 */
  noRefund: boolean;
  errorText: string;
}

const recovery = useImageJobRecovery();

const toastMessage = ref("");
const toastRole = ref<"status" | "alert">("status");

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let aggregateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingEvents: RecoveryToastEvent[] = [];
/** 会话内已提示过的终态：rescan/路由变化/重复轮询不重复弹同一终态。 */
const seenTerminal = new Set<string>();

function groupLabel(title: string): string {
  return title.includes("组图") ? title : `${title}组图`;
}

function isNoRefundTerminal(errorText: string): boolean {
  return errorText.includes("不存在") || errorText.includes("无权") || errorText.includes("登录");
}

function showToast(message: string, role: "status" | "alert"): void {
  toastMessage.value = message;
  toastRole.value = role;
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    toastMessage.value = "";
    dismissTimer = null;
  }, TOAST_DURATION_MS);
}

function buildFailureMessage(events: RecoveryToastEvent[]): string {
  const tasks = events.filter((event) => !event.group);
  const groups = events.filter((event) => event.group);
  const parts: string[] = [];
  const refundTasks = tasks.filter((event) => !event.noRefund);
  const noRefundTasks = tasks.filter((event) => event.noRefund);
  if (refundTasks.length === 1) {
    parts.push(`${refundTasks[0].label}生成失败，积分已退回。`);
  } else if (refundTasks.length > 1) {
    parts.push(`${refundTasks.length} 个生图任务生成失败，积分已退回。`);
  }
  if (noRefundTasks.length === 1) {
    // 404/401 等终态并未产生可退款项，直接展示服务端原因，不冒充“积分已退回”。
    parts.push(`${noRefundTasks[0].label}：${noRefundTasks[0].errorText}`);
  } else if (noRefundTasks.length > 1) {
    parts.push(`${noRefundTasks.length} 个生图任务已停止恢复。`);
  }
  const failedGroups = groups.filter((event) => event.hasFailedSlides);
  const refundFailedGroups = failedGroups.filter((event) => !event.noRefund);
  const noRefundFailedGroups = failedGroups.filter((event) => event.noRefund);
  const historyGroups = groups.filter(
    (event) =>
      !event.hasFailedSlides &&
      (event.errorText.includes("写入历史失败") || event.errorText.includes("上下文已失效")),
  );
  const partialGroups = groups.filter(
    (event) => !event.hasFailedSlides && !historyGroups.includes(event),
  );
  if (refundFailedGroups.length === 1) {
    parts.push(`${groupLabel(refundFailedGroups[0].label)}生成失败，积分已退回。`);
  } else if (refundFailedGroups.length > 1) {
    parts.push(`${refundFailedGroups.length} 个组图生成失败，积分已退回。`);
  }
  if (noRefundFailedGroups.length === 1) {
    parts.push(`${groupLabel(noRefundFailedGroups[0].label)}：${noRefundFailedGroups[0].errorText}`);
  } else if (noRefundFailedGroups.length > 1) {
    parts.push(`${noRefundFailedGroups.length} 个组图已停止恢复。`);
  }
  if (historyGroups.length === 1) {
    parts.push(`${groupLabel(historyGroups[0].label)}写入历史失败，可稍后重试。`);
  } else if (historyGroups.length > 1) {
    parts.push(`${historyGroups.length} 个组图写入历史失败，可稍后重试。`);
  }
  if (partialGroups.length === 1) {
    parts.push(`${groupLabel(partialGroups[0].label)}部分页面未生成，可重新生成。`);
  } else if (partialGroups.length > 1) {
    parts.push(`${partialGroups.length} 个组图部分页面未生成，可重新生成。`);
  }
  return parts.join("；");
}

function buildSuccessMessage(events: RecoveryToastEvent[]): string {
  const tasks = events.filter((event) => !event.group);
  const groups = events.filter((event) => event.group);
  const parts: string[] = [];
  if (tasks.length === 1) {
    parts.push(`${tasks[0].label}已完成，已写入历史。`);
  } else if (tasks.length > 1) {
    parts.push(`${tasks.length} 个生图任务已完成，已写入历史。`);
  }
  if (groups.length === 1) {
    parts.push(`${groupLabel(groups[0].label)}已完成，已写入历史。`);
  } else if (groups.length > 1) {
    parts.push(`${groups.length} 个组图已完成，已写入历史。`);
  }
  return parts.join("；");
}

function flushEvents(): void {
  aggregateTimer = null;
  if (!pendingEvents.length) return;
  const events = pendingEvents.splice(0, pendingEvents.length);
  const failed = events.filter((event) => event.kind === "failed");
  const completed = events.filter((event) => event.kind === "completed");
  // 失败优先：同一窗口内既有失败又有成功时只提示失败摘要。
  if (failed.length) {
    showToast(buildFailureMessage(failed), "alert");
  } else {
    showToast(buildSuccessMessage(completed), "status");
  }
}

function queueEvent(event: RecoveryToastEvent): void {
  pendingEvents.push(event);
  if (aggregateTimer) clearTimeout(aggregateTimer);
  aggregateTimer = setTimeout(flushEvents, AGGREGATE_WINDOW_MS);
}

// 深监听恢复状态：只对“非终态 → 终态”的跃迁出 toast；多个终态在短窗口内合并为一条。
watch(
  () => recovery.state,
  (state) => {
    if (state.tasks.length === 0 && state.groups.length === 0 && state.error === "") {
      // 会话清空（登出/切号）：允许新会话重新提示同一批任务。
      seenTerminal.clear();
      return;
    }
    for (const task of state.tasks) {
      if (task.status === "completed" || task.status === "failed") {
        const key = `task:${task.jobId}:${task.status}`;
        if (seenTerminal.has(key)) continue;
        seenTerminal.add(key);
        queueEvent({
          kind: task.status,
          label: task.label,
          group: false,
          hasFailedSlides: false,
          noRefund: isNoRefundTerminal(task.error || ""),
          errorText: task.error || "",
        });
      }
    }
    for (const group of state.groups) {
      if (group.completed) {
        const key = `group:${group.groupId}:completed`;
        if (seenTerminal.has(key)) continue;
        seenTerminal.add(key);
        queueEvent({
          kind: "completed",
          label: group.title,
          group: true,
          hasFailedSlides: false,
          noRefund: false,
          errorText: "",
        });
      } else if (group.error) {
        const key = `group:${group.groupId}:failed`;
        if (seenTerminal.has(key)) continue;
        seenTerminal.add(key);
        queueEvent({
          kind: "failed",
          label: group.title,
          group: true,
          hasFailedSlides: group.slides.some((slide) => slide.status === "failed"),
          noRefund:
            isNoRefundTerminal(group.error) ||
            group.slides.some(
              (slide) => slide.status === "failed" && isNoRefundTerminal(slide.error || ""),
            ),
          errorText: group.error,
        });
      }
    }
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (dismissTimer) clearTimeout(dismissTimer);
  if (aggregateTimer) clearTimeout(aggregateTimer);
});
</script>

<template>
  <div v-if="toastMessage" class="recovered-job-toast" :role="toastRole" data-test="recovered-job-toast">
    {{ toastMessage }}
  </div>
</template>

<style scoped>
.recovered-job-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 120;
  box-sizing: border-box;
  max-width: min(480px, calc(100vw - 32px));
  padding: 10px 18px;
  border-radius: var(--workspace-radius-sm, 10px);
  background: rgba(42, 31, 34, 0.92);
  color: #fff;
  font-size: 0.9rem;
  line-height: 1.5;
  text-align: center;
  box-shadow: 0 10px 28px rgba(42, 31, 34, 0.2);
  /* 纯提示浮层：不拦截点击、不抢焦点。 */
  pointer-events: none;
}
</style>
