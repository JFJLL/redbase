<template>
  <div class="features-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载功能指标数据...</span>
    </div>

    <div v-else-if="data" class="panel-content">
      <!-- Features Table -->
      <div class="features-table-card">
        <div class="card-header">
          <h4 class="card-title">各功能使用与积分明细</h4>
          <span class="card-subtitle">覆盖趋势、优秀内容、图片、视频全量功能</span>
        </div>
        <div class="table-scroll-wrapper">
          <table class="features-table">
            <thead>
              <tr>
                <th>功能模块</th>
                <th class="text-right">使用用户</th>
                <th class="text-right">总请求数</th>
                <th class="text-right">成功数</th>
                <th class="text-right">失败数</th>
                <th class="text-right">成功率</th>
                <th class="text-right">Gross 积分</th>
                <th class="text-right">退款积分</th>
                <th class="text-right">Net 积分</th>
                <th class="text-right">人均请求</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="feat in data.features" :key="feat.feature">
                <td class="font-medium text-main">{{ feat.label }}</td>
                <td class="text-right">{{ formatNumber(feat.usersCount) }}</td>
                <td class="text-right">{{ formatNumber(feat.requestsCount) }}</td>
                <td class="text-right text-success">{{ formatNumber(feat.successCount) }}</td>
                <td class="text-right text-danger">{{ formatNumber(feat.failureCount) }}</td>
                <td class="text-right font-semibold">
                  {{ feat.successRate !== null ? `${feat.successRate}%` : '-' }}
                </td>
                <td class="text-right">{{ formatNumber(feat.grossCredits) }}</td>
                <td class="text-right text-refund">{{ formatNumber(feat.refundCredits) }}</td>
                <td class="text-right font-bold text-main">{{ formatNumber(feat.netCredits) }}</td>
                <td class="text-right">{{ feat.avgRequestsPerUser }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Failure Reasons Card -->
      <div class="failure-reasons-card" v-if="data.failureReasons && data.failureReasons.length">
        <h4 class="card-title">Top 失败原因分布</h4>
        <div class="reasons-list">
          <div v-for="(reason, i) in data.failureReasons" :key="i" class="reason-row">
            <div class="reason-badge">{{ ERROR_STAGE_LABELS[reason.stage] || reason.stage }}</div>
            <div class="reason-code">{{ reason.code }}</div>
            <div class="reason-count">{{ reason.count }} 次失败</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, FeaturesResponse } from "../types";
import { computeDateParams, formatNumber } from "../dateRange";
import { ERROR_STAGE_LABELS } from "../metrics";
import { fetchFeaturesAnalytics } from "../api";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();
const emit = defineEmits<{ (e: "coverage-update", coverage: any): void }>();

const loading = ref(false);
const error = ref("");
const data = ref<FeaturesResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchFeaturesAnalytics(params, abortController.signal);
    data.value = res;
    emit("coverage-update", res.coverage);
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载功能指标数据失败";
  } finally {
    loading.value = false;
  }
}

watch(() => props.filters, () => {
  loadData();
}, { deep: true });

onMounted(() => {
  loadData();
});

defineExpose({
  refresh: loadData,
});
</script>

<style scoped>
.features-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.panel-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  color: #6b7280;
  gap: 12px;
}
.spinner-large {
  width: 32px;
  height: 32px;
  border: 3px solid #fee2e2;
  border-top-color: #e11d48;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}

.features-table-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  overflow: hidden;
}

.card-header {
  margin-bottom: 12px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0;
}
.card-subtitle {
  font-size: 12px;
  color: #6b7280;
}

.table-scroll-wrapper {
  overflow-x: auto;
}

.features-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  white-space: nowrap;
}
.features-table th {
  background: #f9fafb;
  color: #4b5563;
  font-weight: 600;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
}
.features-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #f3f4f6;
  color: #374151;
}
.features-table tr:hover td {
  background: #fcfcfc;
}

.text-right { text-align: right; }
.text-main { color: #111827; }
.text-success { color: #059669; }
.text-danger { color: #dc2626; }
.text-refund { color: #d97706; }
.font-medium { font-weight: 500; }
.font-semibold { font-weight: 600; }
.font-bold { font-weight: 700; }

.failure-reasons-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px 20px;
}
.reasons-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.reason-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  padding: 6px 0;
  border-bottom: 1px solid #f3f4f6;
}
.reason-badge {
  background: #fee2e2;
  color: #b91c1c;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  min-width: 110px;
  text-align: center;
}
.reason-code {
  flex: 1;
  color: #374151;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.reason-count {
  color: #6b7280;
  font-weight: 600;
}
</style>
