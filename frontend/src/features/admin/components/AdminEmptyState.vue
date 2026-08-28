<template>
  <div class="empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    </div>
    <h4 class="empty-title">{{ title || '暂无数据' }}</h4>
    <p class="empty-desc" v-if="description">{{ description }}</p>
    <div class="empty-actions" v-if="$slots.actions">
      <slot name="actions"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  description?: string;
}>();
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: #6b7280;
}
.empty-icon {
  color: #9ca3af;
  margin-bottom: 12px;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: #374151;
  margin: 0 0 4px 0;
}
.empty-desc {
  font-size: 13px;
  color: #6b7280;
  margin: 0;
}
.empty-actions {
  margin-top: 16px;
}
</style>
