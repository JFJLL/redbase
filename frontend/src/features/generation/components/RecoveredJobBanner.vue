<script setup lang="ts">
// 全局生图任务恢复横幅：展示服务端权威任务在刷新/离开/关闭弹窗后的恢复进度。
// 只读展示 + 可关闭终态条目；不在此发起任何生成 POST。
import { computed } from "vue";
import { useImageJobRecovery } from "../composables/useImageJobRecovery";

const recovery = useImageJobRecovery();

const visible = computed(() => {
  const state = recovery.state;
  return state.tasks.length > 0 || state.groups.length > 0 || Boolean(state.error);
});

function dismissTask(jobId: string): void {
  recovery.dismissTask(jobId);
}

function dismissGroup(groupId: string): void {
  recovery.dismissGroup(groupId);
}

function taskText(label: string, status: string, error?: string): string {
  if (status === "completed") return `${label}已恢复完成并写入历史。`;
  if (status === "failed") {
    const message = String(error || "");
    if (message.includes("不存在") || message.includes("无权") || message.includes("登录")) {
      return `${label}：${message}`;
    }
    return `${label}生成失败，积分已按规则退回。`;
  }
  return `${label}正在恢复生成…`;
}
</script>

<template>
  <section v-if="visible" class="recovered-job-banner" data-test="recovered-job-banner" aria-live="polite">
    <div class="recovered-job-head">
      <strong>生图任务恢复</strong>
      <span v-if="recovery.state.scanning" class="recovered-job-hint">正在检查未完成任务…</span>
      <span v-else class="recovered-job-hint">未完成任务已从服务端恢复，不重复扣费。</span>
    </div>

    <p v-if="recovery.state.error" class="recovered-job-error" data-test="recovered-job-error">
      {{ recovery.state.error }}
      <button type="button" class="recovered-job-dismiss" data-test="recovered-job-error-dismiss" @click="recovery.dismissError()">
        知道了
      </button>
    </p>

    <ul v-if="recovery.state.tasks.length" class="recovered-job-list">
      <li v-for="task in recovery.state.tasks" :key="task.jobId" class="recovered-job-item">
        <span :class="['recovered-job-status', `is-${task.status}`]" data-test="recovered-job-status">
          {{ taskText(task.label, task.status, task.error) }}
        </span>
        <button
          type="button"
          class="recovered-job-dismiss"
          :data-test="`recovered-job-dismiss-${task.jobId}`"
          @click="dismissTask(task.jobId)"
        >
          {{ task.status === "polling" ? "停止恢复" : "知道了" }}
        </button>
      </li>
    </ul>

    <ul v-if="recovery.state.groups.length" class="recovered-job-list">
      <li v-for="group in recovery.state.groups" :key="group.groupId" class="recovered-job-item">
        <span :class="['recovered-job-status', group.completed ? 'is-completed' : 'is-polling']">
          {{
            group.completed
              ? `${group.title}组图已恢复完成并写入历史。`
              : group.error
                ? `${group.title}组图恢复中断：${group.error}`
                : `${group.title}组图正在恢复（${group.slides.filter((slide) => slide.status === "completed").length}/4）…`
          }}
        </span>
        <button
          type="button"
          class="recovered-job-dismiss"
          :data-test="`recovered-group-dismiss-${group.groupId}`"
          @click="dismissGroup(group.groupId)"
        >
          {{ group.completed || group.error ? "知道了" : "停止恢复" }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recovered-job-banner {
  display: grid;
  gap: 8px;
  margin: 0 0 14px;
  padding: 12px 16px;
  border: 1px solid var(--workspace-border, #e3e6ea);
  border-left: 4px solid var(--workspace-accent, #2f6fed);
  border-radius: var(--workspace-radius, 10px);
  background: var(--workspace-surface-soft, #f6f8fa);
  color: var(--workspace-text, #1d2430);
  font-size: 0.9rem;
}

.recovered-job-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.recovered-job-hint {
  color: var(--workspace-muted, #687385);
}

.recovered-job-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recovered-job-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.recovered-job-status.is-completed {
  color: var(--workspace-success, #1d7f4c);
}

.recovered-job-status.is-failed {
  color: var(--workspace-danger, #c0392b);
}

.recovered-job-error {
  margin: 0;
  color: var(--workspace-danger, #c0392b);
}

.recovered-job-dismiss {
  border: 0;
  background: transparent;
  color: var(--workspace-muted, #687385);
  cursor: pointer;
  text-decoration: underline;
  white-space: nowrap;
}
</style>
