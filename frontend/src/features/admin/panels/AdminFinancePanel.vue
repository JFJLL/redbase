<template>
  <div class="finance-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载财务与积分数据...</span>
    </div>

    <div v-else-if="data" class="panel-content">
      <!-- Finance KPI Cards -->
      <div class="finance-kpis-grid">
        <div class="fin-card highlight">
          <span class="fin-label">实收总营收</span>
          <span class="fin-val text-red">{{ formatCurrency(data.overview.revenueYuan) }}</span>
        </div>
        <div class="fin-card">
          <span class="fin-label">付费用户数</span>
          <span class="fin-val">{{ formatNumber(data.overview.payingUsers) }}</span>
        </div>
        <div class="fin-card">
          <span class="fin-label">ARPPU (人均付费)</span>
          <span class="fin-val">{{ formatCurrency(data.overview.arppu) }}</span>
        </div>
        <div class="fin-card">
          <span class="fin-label">订单支付转化率</span>
          <span class="fin-val">
            {{ data.overview.conversionRate !== null ? `${data.overview.conversionRate}%` : '-' }}
          </span>
          <span class="fin-sub">创建 cohort：{{ data.overview.cohortPaid }} 笔最终支付 / {{ data.overview.createdInPeriod }} 笔创建</span>
          <span class="fin-sub">期间支付 {{ data.overview.paidInPeriod }}；待支付 {{ data.overview.pendingUnexpired }}；失败/过期/关闭 {{ data.overview.expiredOrFailed }}</span>
        </div>
        <div class="fin-card">
          <span class="fin-label">用户剩余积分总量</span>
          <span class="fin-val">{{ formatNumber(data.overview.currentRemainingCredits) }}</span>
        </div>
        <div class="fin-card">
          <span class="fin-label">管理员赠送积分</span>
          <span class="fin-val">{{ formatNumber(data.overview.adminGrantedCredits) }}</span>
        </div>
        <div class="fin-card" :class="{ 'fin-card-alert': data.overview.auditIssuesCount > 0 }">
          <span class="fin-label">支付审计异常订单</span>
          <span class="fin-val">{{ data.overview.auditIssuesCount }}</span>
          <span class="fin-sub" v-if="data.overview.auditIssuesCount > 0">需人工复核</span>
        </div>
      </div>

      <!-- Revenue Trend Chart -->
      <div class="revenue-chart-card">
        <AdminMetricChart
          type="line"
          title="营收走势"
          subtitle="每日已支付订单实收金额"
          :data="data.revenueSeries"
        />
      </div>

      <!-- Payment Channels & Plan Distribution -->
      <div class="tables-row">
        <!-- Channels -->
        <div class="section-card">
          <h4 class="card-title">支付渠道对比</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>渠道</th>
                <th class="text-right">创建订单</th>
                <th class="text-right">成交笔数</th>
                <th class="text-right">实收金额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ch in data.channelComparison" :key="ch.provider">
                <td class="font-medium text-main">{{ ch.providerLabel }}</td>
                <td class="text-right">{{ formatNumber(ch.totalOrders) }}</td>
                <td class="text-right text-success">{{ formatNumber(ch.paidOrders) }}</td>
                <td class="text-right font-bold text-main">{{ formatCurrency(ch.revenueYuan) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Plans -->
        <div class="section-card">
          <h4 class="card-title">充值套餐分布</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>套餐名称</th>
                <th class="text-right">购买笔数</th>
                <th class="text-right">累计金额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plan in data.planDistribution" :key="plan.planId">
                <td class="font-medium text-main">{{ plan.planName }}</td>
                <td class="text-right">{{ formatNumber(plan.ordersCount) }}</td>
                <td class="text-right font-bold text-main">{{ formatCurrency(plan.revenueYuan) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, FinanceResponse } from "../types";
import { computeDateParams, formatNumber, formatCurrency } from "../dateRange";
import { fetchFinanceAnalytics } from "../api";
import AdminMetricChart from "../components/AdminMetricChart.vue";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();
const emit = defineEmits<{ (e: "coverage-update", coverage: any): void }>();

const loading = ref(false);
const error = ref("");
const data = ref<FinanceResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchFinanceAnalytics(params, abortController.signal);
    data.value = res;
    emit("coverage-update", res.coverage);
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载财务与积分数据失败";
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
.finance-panel {
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

.finance-kpis-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 1200px) {
  .finance-kpis-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .finance-kpis-grid {
    grid-template-columns: 1fr;
  }
}

.fin-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fin-card.highlight {
  border-color: #fecdd3;
  background: #fff5f5;
}
.fin-card-alert {
  border-color: #fed7aa;
  background: #fffbeb;
}
.fin-label {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}
.fin-val {
  font-size: 22px;
  font-weight: 700;
  color: #111827;
}
.text-red { color: #e11d48; }
.fin-sub {
  font-size: 11px;
  color: #9ca3af;
}

.tables-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
@media (max-width: 900px) {
  .tables-row {
    grid-template-columns: 1fr;
  }
}

.section-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px 20px;
  overflow: hidden;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 12px 0;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th {
  background: #f9fafb;
  color: #4b5563;
  font-weight: 600;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
}
.data-table td {
  padding: 8px 12px;
  border-bottom: 1px solid #f3f4f6;
  color: #374151;
}
.text-right { text-align: right; }
.text-main { color: #111827; }
.text-success { color: #059669; }
.font-medium { font-weight: 500; }
.font-bold { font-weight: 700; }
</style>
