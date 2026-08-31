<template>
  <div class="ai-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载 AI 运行分析数据...</span>
    </div>

    <div v-else-if="data" class="panel-content">
      <!-- AI Summary Cards -->
      <div class="ai-summary-grid">
        <div class="summary-card">
          <span class="sum-label">AI 任务调用总量</span>
          <span class="sum-val">{{ formatNumber(data.summary.totalRequests) }}</span>
        </div>
        <div class="summary-card">
          <span class="sum-label">整体成功率</span>
          <span class="sum-val text-success">
            {{ data.summary.successRate !== null ? `${data.summary.successRate}%` : '-' }}
          </span>
        </div>
        <div class="summary-card">
          <span class="sum-label">耗时 P50 / P95</span>
          <span class="sum-val text-latency">
            {{ data.summary.p50LatencyMs !== null ? `${(data.summary.p50LatencyMs / 1000).toFixed(1)}s` : '-' }} /
            {{ data.summary.p95LatencyMs !== null ? `${(data.summary.p95LatencyMs / 1000).toFixed(1)}s` : '-' }}
          </span>
        </div>
        <div class="summary-card">
          <span class="sum-label">重试任务率</span>
          <span class="sum-val">
            {{ data.summary.retryRate !== null ? `${data.summary.retryRate}%` : '-' }}
          </span>
        </div>
      </div>

      <!-- Video D2 vs G2 Comparison Card -->
      <div class="section-card" v-if="data.videoComparison && data.videoComparison.length">
        <div class="card-header">
          <h4 class="card-title">视频模型对比 (D2 vs G2)</h4>
          <span class="card-subtitle">按模型、模式、画幅、分辨率分层比较完成率与积分效益</span>
        </div>
        <div class="table-scroll-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>模式</th>
                <th>分辨率</th>
                <th>画幅</th>
                <th>时长</th>
                <th class="text-right">项目数</th>
                <th class="text-right">完成率</th>
                <th class="text-right">首次成功率</th>
                <th class="text-right">自动/人工重试率</th>
                <th class="text-right">救援成功率</th>
                <th class="text-right">Attempt 明细样本/覆盖率</th>
                <th class="text-right">项目 P50 / P95</th>
                <th class="text-right">Clip P50 / P95</th>
                <th class="text-right">成熟/活跃/待配置/待处理</th>
                <th class="text-right">Gross / Refund / Net</th>
                <th class="text-right">平均 Net 积分</th>
                <th class="text-right">每秒 Net 积分</th>
                <th class="text-right">真实成本</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, i) in data.videoComparison" :key="i">
                <td class="font-bold text-main">{{ v.model.toUpperCase() }}</td>
                <td>{{ v.mode === 'image' ? '图生视频' : '文生视频' }}</td>
                <td>{{ v.resolution }}</td>
                <td>{{ v.aspectRatio }}</td>
                <td>{{ v.totalDurationSec }}s</td>
                <td class="text-right">{{ v.projectCount }}</td>
                <td class="text-right font-semibold">{{ v.completionRate !== null ? `${v.completionRate}%` : '-' }}</td>
                <td class="text-right">{{ v.firstSuccessRate !== null ? `${v.firstSuccessRate}%` : '-' }}</td>
                <td class="text-right">{{ v.autoRetryRate !== null ? `${v.autoRetryRate}%` : '-' }} / {{ v.manualRetryRate !== null ? `${v.manualRetryRate}%` : '-' }}</td>
                <td class="text-right">{{ v.rescueRate !== null ? `${v.rescueRate}%` : '-' }}</td>
                <td class="text-right">
                  {{ v.attemptMetricSampleSize === 0 ? '历史明细不可回填' : `${v.attemptMetricSampleSize} / ${v.attemptMetricCoverageRate}%` }}
                </td>
                <td class="text-right">{{ v.p50DurationMs !== null ? `${(v.p50DurationMs / 1000).toFixed(1)}s` : '-' }} / {{ v.p95DurationMs !== null ? `${(v.p95DurationMs / 1000).toFixed(1)}s` : '-' }}</td>
                <td class="text-right">{{ v.clipP50DurationMs !== null ? `${(v.clipP50DurationMs / 1000).toFixed(1)}s` : '-' }} / {{ v.clipP95DurationMs !== null ? `${(v.clipP95DurationMs / 1000).toFixed(1)}s` : '-' }}</td>
                <td class="text-right">{{ v.matureCount }} / {{ v.activeCount }} / {{ v.waitingConfigCount }} / {{ v.actionableCount }}</td>
                <td class="text-right">{{ v.grossCredits }} / {{ v.refundCredits }} / {{ v.netCredits }}</td>
                <td class="text-right">{{ v.avgNetCredits ?? '-' }}</td>
                <td class="text-right">{{ v.netCreditsPerSuccessSecond ?? '-' }}</td>
                <td class="text-right text-muted">{{ v.vendorCostLabel }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- AI Breakdown Table by Feature / Provider / Model -->
      <div class="section-card">
        <div class="card-header">
          <h4 class="card-title">模型与通道运行指标</h4>
          <span class="card-subtitle">按功能、供应商和底层模型统计耗时与成功率</span>
        </div>
        <div class="table-scroll-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>功能模块</th>
                <th>供应商</th>
                <th>模型</th>
                <th class="text-right">调用量</th>
                <th class="text-right">成功率</th>
                <th class="text-right">平均耗时</th>
                <th class="text-right">消耗 Token</th>
                <th class="text-right">重试次数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in data.breakdown" :key="idx">
                <td class="font-medium">{{ row.featureLabel }}</td>
                <td>{{ row.provider }}</td>
                <td class="font-mono text-muted">{{ row.model }}</td>
                <td class="text-right">{{ formatNumber(row.requestsCount) }}</td>
                <td class="text-right font-semibold">{{ row.successRate !== null ? `${row.successRate}%` : '-' }}</td>
                <td class="text-right">{{ (row.avgDurationMs / 1000).toFixed(1) }}s</td>
                <td class="text-right">{{ formatNumber(row.tokensTotal) }}</td>
                <td class="text-right">{{ row.retryCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Error Stages Breakdown -->
      <div class="section-card" v-if="data.errorStages.length">
        <h4 class="card-title">异常阶段分布</h4>
        <div class="error-stages-grid">
          <div v-for="st in data.errorStages" :key="st.stage" class="stage-item">
            <div class="stage-header">
              <span class="stage-name">{{ ERROR_STAGE_LABELS[st.stage] || st.stage }}</span>
              <span class="stage-count">{{ st.count }} 次 ({{ st.percent }}%)</span>
            </div>
            <div class="stage-bar">
              <div class="stage-fill" :style="{ width: `${st.percent}%` }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, AiResponse } from "../types";
import { computeDateParams, formatNumber } from "../dateRange";
import { ERROR_STAGE_LABELS } from "../metrics";
import { fetchAiAnalytics } from "../api";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();
const emit = defineEmits<{ (e: "coverage-update", coverage: any): void }>();

const loading = ref(false);
const error = ref("");
const data = ref<AiResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchAiAnalytics(params, abortController.signal);
    data.value = res;
    emit("coverage-update", res.coverage);
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载 AI 运行数据失败";
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
.ai-panel {
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

.ai-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 1024px) {
  .ai-summary-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .ai-summary-grid {
    grid-template-columns: 1fr;
  }
}

.summary-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sum-label {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}
.sum-val {
  font-size: 22px;
  font-weight: 700;
  color: #111827;
}
.text-success { color: #059669; }
.text-latency { font-size: 18px; }

.section-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px 20px;
  overflow: hidden;
}

.card-header {
  margin-bottom: 12px;
  padding-inline: 12px;
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

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  white-space: nowrap;
}
.data-table th {
  background: #f9fafb;
  color: #4b5563;
  font-weight: 600;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
}
.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #f3f4f6;
  color: #374151;
}
.data-table tr:hover td {
  background: #fcfcfc;
}

.text-right { text-align: right; }
.text-main { color: #111827; }
.text-muted { color: #6b7280; }
.font-medium { font-weight: 500; }
.font-semibold { font-weight: 600; }
.font-bold { font-weight: 700; }
.font-mono { font-family: ui-monospace, monospace; font-size: 12px; }

.error-stages-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 24px;
  margin-top: 12px;
}
@media (max-width: 768px) {
  .error-stages-grid {
    grid-template-columns: 1fr;
  }
}

.stage-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stage-header {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
}
.stage-bar {
  height: 8px;
  background: #f3f4f6;
  border-radius: 4px;
  overflow: hidden;
}
.stage-fill {
  height: 100%;
  background: #ef4444;
  border-radius: 4px;
}
</style>
