<template>
  <div class="kpi-card" :data-test="`kpi-${testId || 'card'}`">
    <div class="kpi-card-header">
      <span class="kpi-title">{{ title }}</span>
      <span v-if="tooltip" class="kpi-tip-icon" :title="tooltip">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      </span>
    </div>

    <div class="kpi-value-row">
      <span class="kpi-value">
        <span v-if="prefix" class="kpi-prefix">{{ prefix }}</span>
        {{ formattedValue }}
        <span v-if="suffix" class="kpi-suffix">{{ suffix }}</span>
      </span>

      <div v-if="deltaPercent !== undefined && deltaPercent !== null" class="delta-badge" :class="deltaClass">
        <span class="delta-arrow">{{ deltaPercent > 0 ? '↑' : deltaPercent < 0 ? '↓' : '' }}</span>
        <span>{{ Math.abs(deltaPercent) }}%</span>
      </div>
    </div>

    <div class="kpi-subtext" v-if="sampleSize !== undefined || subtext">
      <span v-if="sampleSize !== undefined">样本量: {{ formatNumber(sampleSize) }}</span>
      <span v-else>{{ subtext }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { formatNumber } from "../dateRange";

const props = defineProps<{
  title: string;
  value: number | string | null;
  prefix?: string;
  suffix?: string;
  deltaPercent?: number | null;
  sampleSize?: number;
  subtext?: string;
  tooltip?: string;
  testId?: string;
}>();

const formattedValue = computed(() => {
  if (props.value === null || props.value === undefined) return "-";
  if (typeof props.value === "number") {
    return props.value.toLocaleString("zh-CN");
  }
  return String(props.value);
});

const deltaClass = computed(() => {
  if (props.deltaPercent === null || props.deltaPercent === undefined) return "delta--neutral";
  if (props.deltaPercent > 0) return "delta--positive";
  if (props.deltaPercent < 0) return "delta--negative";
  return "delta--neutral";
});
</script>

<style scoped>
.kpi-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 100px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

.kpi-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kpi-title {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}

.kpi-tip-icon {
  color: #9ca3af;
  cursor: help;
  display: flex;
}

.kpi-value-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 0 4px 0;
}

.kpi-value {
  font-size: 24px;
  font-weight: 700;
  color: #111827;
  letter-spacing: -0.02em;
}

.kpi-prefix,
.kpi-suffix {
  font-size: 14px;
  font-weight: 500;
  color: #6b7280;
}

.delta-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.delta--positive {
  background: #ecfdf5;
  color: #059669;
}

.delta--negative {
  background: #fef2f2;
  color: #dc2626;
}

.delta--neutral {
  background: #f3f4f6;
  color: #6b7280;
}

.kpi-subtext {
  font-size: 11px;
  color: #9ca3af;
}
</style>
