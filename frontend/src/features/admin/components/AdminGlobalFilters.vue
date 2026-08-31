<template>
  <header class="admin-filters-bar">
    <div class="filter-group date-presets">
      <button
        v-for="opt in PRESET_OPTIONS"
        :key="opt.id"
        type="button"
        class="preset-btn"
        :class="{ active: filters.preset === opt.id }"
        :data-range-option="opt.id"
        @click="selectPreset(opt.id)"
      >
        {{ opt.label }}
      </button>
    </div>

    <div class="filter-group custom-date-inputs" v-if="filters.preset === 'custom'">
      <input
        type="date"
        class="filter-input date-input"
        aria-label="开始日期"
        :value="filters.customFrom"
        @input="onCustomFromInput"
      />
      <span class="date-sep">至</span>
      <input
        type="date"
        class="filter-input date-input"
        aria-label="结束日期"
        :value="filters.customTo"
        @input="onCustomToInput"
      />
      <button type="button" class="apply-date-btn" data-test="apply-custom-date" @click="$emit('refresh')">
        应用
      </button>
    </div>

    <div class="filter-group account-select-group">
      <label class="filter-label">账号类型:</label>
      <AdminSelect
        :model-value="filters.accountType || ''"
        :options="ACCOUNT_OPTIONS"
        label="账号类型"
        test-id="account-type-select"
        @change="onAccountChange"
      />
    </div>

    <div class="filter-actions">
      <span class="coverage-badge" v-if="coverage?.isPartial" title="部分数据由历史记录回填，某些埋点仅在启用后完全统计">
        <span class="dot-warn"></span>
        <span>历史回填部分覆盖</span>
      </span>

      <button
        type="button"
        class="refresh-btn"
        :class="{ 'is-loading': loading, 'is-complete': refreshed && !loading }"
        :disabled="loading"
        :aria-busy="loading ? 'true' : 'false'"
        data-test="refresh-data-btn"
        @click="$emit('refresh')"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotating: loading }">
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        <span>{{ loading ? '刷新中...' : refreshed ? '已刷新' : '刷新数据' }}</span>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { AdminFilters, AdminDatePreset, CoverageInfo } from "../types";
import { PRESET_OPTIONS } from "../dateRange";
import AdminSelect, { type AdminSelectOption } from "./AdminSelect.vue";

const ACCOUNT_OPTIONS: AdminSelectOption[] = [
  { value: "", label: "全部账号", description: "客户与易美账号" },
  { value: "customer", label: "仅客户账号", description: "外部客户" },
  { value: "yimei", label: "仅易美账号", description: "内部运营账号" },
];

const props = defineProps<{
  filters: AdminFilters;
  coverage?: CoverageInfo;
  loading?: boolean;
  refreshed?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:filters", filters: AdminFilters): void;
  (e: "refresh"): void;
}>();

function selectPreset(preset: AdminDatePreset) {
  emit("update:filters", {
    ...props.filters,
    preset,
  });
  if (preset !== "custom") {
    emit("refresh");
  }
}

function onCustomFromInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  emit("update:filters", {
    ...props.filters,
    customFrom: val,
  });
}

function onCustomToInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  emit("update:filters", {
    ...props.filters,
    customTo: val,
  });
}

function onAccountChange(val: string) {
  emit("update:filters", {
    ...props.filters,
    accountType: val as "customer" | "yimei" | "",
  });
  emit("refresh");
}
</script>

<style scoped>
.admin-filters-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: #ffffff;
  padding: 12px 20px;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 10;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.date-presets {
  background: #f3f4f6;
  padding: 3px;
  border-radius: 6px;
}

.preset-btn {
  background: transparent;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 13px;
  color: #4b5563;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.15s ease;
}
.preset-btn:hover {
  color: #111827;
}
.preset-btn.active {
  background: #ffffff;
  color: #e11d48;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.custom-date-inputs {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-input {
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 13px;
  color: #111827;
  background: #ffffff;
}

.filter-input:focus {
  outline: none;
  border-color: #e11d48;
}

.date-sep {
  color: #6b7280;
  font-size: 12px;
}

.apply-date-btn {
  background: #e11d48;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}
.apply-date-btn:hover {
  background: #be123c;
}

.filter-label {
  font-size: 13px;
  color: #6b7280;
}

.account-select-group :deep(.admin-select) {
  min-width: 168px;
}

.filter-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.coverage-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #92400e;
  background: #fef3c7;
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.dot-warn {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 94px;
  background: #f9fafb;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  font-weight: 500;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.refresh-btn:hover:not(:disabled) {
  background: #f3f4f6;
}
.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.refresh-btn.is-loading:disabled {
  opacity: 1;
  color: #e11d48;
  border-color: #fecdd3;
  background: #fff1f2;
  box-shadow: 0 0 0 3px rgba(225, 29, 72, 0.08);
}
.refresh-btn.is-complete {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.rotating {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}
</style>
