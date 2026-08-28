<template>
  <div class="users-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载用户与转化数据...</span>
    </div>

    <div v-else-if="data" class="panel-content">
      <!-- Activity Cards -->
      <div class="activity-row">
        <div class="activity-card">
          <span class="act-label">今日活跃 (DAU)</span>
          <span class="act-val">{{ data.activity.todayDau }}</span>
        </div>
        <div class="activity-card">
          <span class="act-label">近 7 天活跃 (WAU)</span>
          <span class="act-val">{{ data.activity.wau }}</span>
        </div>
        <div class="activity-card">
          <span class="act-label">近 30 天活跃 (MAU)</span>
          <span class="act-val">{{ data.activity.mau }}</span>
        </div>
        <div class="activity-card">
          <span class="act-label">D1 / D7 / D30 留存率</span>
          <span class="act-val act-retention">
            {{ data.retention.d1Rate !== null ? `${data.retention.d1Rate}%` : '-' }} /
            {{ data.retention.d7Rate !== null ? `${data.retention.d7Rate}%` : '-' }} /
            {{ data.retention.d30Rate !== null ? `${data.retention.d30Rate}%` : '-' }}
          </span>
          <span class="act-note" v-if="data.retention.cohortSize">同期样本: {{ data.retention.cohortSize }} 人</span>
        </div>
      </div>

      <!-- Funnels Grid -->
      <div class="funnels-grid">
        <!-- Main Product Funnel -->
        <div class="funnel-card">
          <AdminMetricChart
            type="funnel"
            title="产品主链路转化漏斗"
            subtitle="从注册到完成创作与支付的各层转化"
            :data="data.mainFunnel"
          />
        </div>

        <!-- Video Pipeline Funnel -->
        <div class="funnel-card">
          <AdminMetricChart
            type="funnel"
            title="AI 视频生产转化漏斗"
            subtitle="视频脚本生成至视频项目与最终成片转化"
            :data="data.videoFunnel"
          />
        </div>
      </div>

      <!-- Account Type Distribution -->
      <div class="accounts-card">
        <h4 class="card-title">账号类型分布</h4>
        <div class="accounts-grid">
          <div v-for="acc in data.accountDistribution" :key="acc.accountType" class="account-item">
            <div class="acc-info">
              <span class="acc-name">{{ acc.label }}</span>
              <span class="acc-count">{{ acc.count }} 个</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, UsersResponse } from "../types";
import { computeDateParams } from "../dateRange";
import { fetchUsersAnalytics } from "../api";
import AdminMetricChart from "../components/AdminMetricChart.vue";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();

const loading = ref(false);
const error = ref("");
const data = ref<UsersResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchUsersAnalytics(params, abortController.signal);
    data.value = res;
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载用户与转化数据失败";
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
.users-panel {
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

.activity-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 1024px) {
  .activity-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .activity-row {
    grid-template-columns: 1fr;
  }
}

.activity-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.act-label {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}
.act-val {
  font-size: 22px;
  font-weight: 700;
  color: #111827;
}
.act-retention {
  font-size: 16px;
}
.act-note {
  font-size: 11px;
  color: #9ca3af;
}

.funnels-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
@media (max-width: 960px) {
  .funnels-grid {
    grid-template-columns: 1fr;
  }
}

.accounts-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px 20px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 12px 0;
}
.accounts-grid {
  display: flex;
  gap: 20px;
}
.account-item {
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 6px;
  padding: 12px 20px;
}
.acc-info {
  display: flex;
  align-items: center;
  gap: 12px;
}
.acc-name {
  font-size: 13px;
  color: #4b5563;
  font-weight: 500;
}
.acc-count {
  font-size: 16px;
  font-weight: 700;
  color: #111827;
}
</style>
