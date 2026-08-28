<template>
  <div class="error-state" data-test="admin-error">
    <div class="error-icon">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    </div>
    <h4 class="error-title">加载失败</h4>
    <p class="error-msg">{{ message || '数据加载出现异常，请稍后重试。' }}</p>
    <button type="button" class="retry-btn" v-if="retryable !== false" @click="$emit('retry')">
      重试
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  message?: string;
  retryable?: boolean;
}>();

defineEmits<{
  (e: "retry"): void;
}>();
</script>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
}
.error-icon {
  color: #ef4444;
  margin-bottom: 12px;
}
.error-title {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 4px 0;
}
.error-msg {
  font-size: 13px;
  color: #6b7280;
  margin: 0 0 16px 0;
  max-width: 400px;
}
.retry-btn {
  background: #e11d48;
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.retry-btn:hover {
  background: #be123c;
}
</style>
