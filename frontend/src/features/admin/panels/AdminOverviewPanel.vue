<template>
  <div class="overview-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载经营总览数据...</span>
    </div>

    <div v-else-if="data" class="panel-content" data-test="admin-stats">
      <!-- Top 8 KPI Grid -->
      <div class="kpis-grid">
        <AdminKpiCard
          title="平均日活 (DAU)"
          :value="data.kpis.dau.value"
          :delta-percent="data.kpis.dau.deltaPercent"
          :sample-size="data.kpis.dau.sampleSize"
          tooltip="统计所选范围内活跃用户数的日均值 (以 user_active_day 去重统计)"
          test-id="dau"
        />
        <AdminKpiCard
          title="新增注册用户"
          :value="data.kpis.newUsers.value"
          :delta-percent="data.kpis.newUsers.deltaPercent"
          tooltip="范围内新注册的用户总数"
          test-id="new-users"
        />
        <AdminKpiCard
          title="有效创作用户"
          :value="data.kpis.effectiveCreators.value"
          :delta-percent="data.kpis.effectiveCreators.deltaPercent"
          tooltip="范围内至少成功生成过 1 次内容（图片/视频/文案）的去重用户数"
          test-id="creators"
        />
        <AdminKpiCard
          title="付费用户数"
          :value="data.kpis.payingUsers.value"
          :delta-percent="data.kpis.payingUsers.deltaPercent"
          tooltip="范围内有成功充值记录的去重用户数"
          test-id="paying-users"
        />
        <AdminKpiCard
          title="累计营收 (元)"
          :value="data.kpis.revenueYuan.value"
          prefix="¥"
          :delta-percent="data.kpis.revenueYuan.deltaPercent"
          tooltip="已支付订单的实收人民币金额总和"
          test-id="revenue"
        />
        <AdminKpiCard
          title="成功内容产出"
          :value="data.kpis.outputs.value"
          :delta-percent="data.kpis.outputs.deltaPercent"
          tooltip="各生成功能成功产出的总条数"
          test-id="outputs"
        />
        <AdminKpiCard
          title="Net 积分消耗"
          :value="data.kpis.netCredits.value"
          :delta-percent="data.kpis.netCredits.deltaPercent"
          tooltip="Gross 积分消耗扣除退款积分后的净消耗"
          test-id="net-credits"
        />
        <AdminKpiCard
          title="AI 整体成功率"
          :value="data.kpis.aiSuccessRate.value !== null ? `${data.kpis.aiSuccessRate.value}%` : '-'"
          :delta-percent="data.kpis.aiSuccessRate.deltaPercent"
          :sample-size="data.kpis.aiSuccessRate.sampleSize"
          tooltip="所有终态 AI 任务中成功的比例"
          test-id="ai-success"
        />
      </div>

      <!-- Charts Grid -->
      <div class="charts-row">
        <div class="chart-col">
          <AdminMetricChart
            type="line"
            title="用户与创作趋势"
            subtitle="每日活跃用户 (DAU) 与有效创作用户走势"
            :data="data.trends.dauSeries"
          />
        </div>
        <div class="chart-col">
          <AdminMetricChart
            type="line"
            title="营收与产出走势"
            subtitle="每日生成内容产出总量"
            :data="data.trends.outputsSeries"
          />
        </div>
      </div>

      <!-- Feature Usage Breakdown -->
      <div class="feature-distribution-card" v-if="data.featureDistribution.length">
        <h4 class="card-section-title">功能产出分布</h4>
        <div class="feature-bars-grid">
          <div v-for="f in data.featureDistribution" :key="f.feature" class="feature-bar-item">
            <div class="feature-meta">
              <span class="feature-name">{{ f.label }}</span>
              <span class="feature-count">{{ formatNumber(f.count) }} 条</span>
            </div>
            <div class="feature-bar-track">
              <div
                class="feature-bar-progress"
                :style="{ width: `${Math.max(4, (f.count / (data.kpis.outputs.value || 1)) * 100)}%` }"
              ></div>
            </div>
            <div class="feature-users-sub">{{ f.usersCount }} 人使用</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, OverviewResponse } from "../types";
import { computeDateParams, formatNumber } from "../dateRange";
import { fetchOverviewAnalytics } from "../api";
import AdminKpiCard from "../components/AdminKpiCard.vue";
import AdminMetricChart from "../components/AdminMetricChart.vue";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();

const loading = ref(false);
const error = ref("");
const data = ref<OverviewResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchOverviewAnalytics(params, abortController.signal);
    data.value = res;
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载经营总览数据失败";
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
.overview-panel {
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

.kpis-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}

@media (max-width: 1200px) {
  .kpis-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .kpis-grid {
    grid-template-columns: 1fr;
  }
}

.charts-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
@media (max-width: 900px) {
  .charts-row {
    grid-template-columns: 1fr;
  }
}

.feature-distribution-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px 20px;
}

.card-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 14px 0;
}

.feature-bars-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 24px;
}
@media (max-width: 768px) {
  .feature-bars-grid {
    grid-template-columns: 1fr;
  }
}

.feature-bar-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.feature-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
}

.feature-bar-track {
  height: 8px;
  background: #f3f4f6;
  border-radius: 4px;
  overflow: hidden;
}
.feature-bar-progress {
  height: 100%;
  background: #e11d48;
  border-radius: 4px;
}

.feature-users-sub {
  font-size: 11px;
  color: #9ca3af;
}
</style>
