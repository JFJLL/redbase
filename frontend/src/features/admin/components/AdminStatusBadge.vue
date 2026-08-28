<template>
  <span class="status-badge" :class="`status--${meta.tone}`">
    <span class="status-dot"></span>
    <span>{{ label || meta.label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { getStatusMeta } from "../metrics";

const props = defineProps<{
  status: string;
  label?: string;
}>();

const meta = computed(() => getStatusMeta(props.status));
</script>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 9999px;
  white-space: nowrap;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.status--success {
  background: #ecfdf5;
  color: #065f46;
}
.status--success .status-dot {
  background: #10b981;
}

.status--warning {
  background: #fffbeb;
  color: #92400e;
}
.status--warning .status-dot {
  background: #f59e0b;
}

.status--danger {
  background: #fef2f2;
  color: #991b1b;
}
.status--danger .status-dot {
  background: #ef4444;
}

.status--info {
  background: #eff6ff;
  color: #1e40af;
}
.status--info .status-dot {
  background: #3b82f6;
}

.status--neutral {
  background: #f3f4f6;
  color: #4b5563;
}
.status--neutral .status-dot {
  background: #9ca3af;
}
</style>
