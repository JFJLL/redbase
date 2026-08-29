<template>
  <div class="system-panel">
    <AdminErrorState v-if="error" :message="error" @retry="loadData" />

    <div v-else-if="loading && !data" class="panel-loading">
      <div class="spinner-large"></div>
      <span>正在加载系统与异常监控数据...</span>
    </div>

    <div v-else-if="data" class="panel-content">
      <!-- Active Alert Banners -->
      <div class="alerts-container" v-if="data.alerts && data.alerts.length">
        <div v-for="(alert, idx) in data.alerts" :key="idx" class="alert-banner" :class="`alert--${alert.level}`">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>{{ alert.message }}</span>
        </div>
      </div>

      <!-- Status Grid -->
      <div class="system-grid">
        <!-- Database Health -->
        <div class="sys-card">
          <h4 class="card-title">数据库存储</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">数据库状态</span>
              <span class="meta-val text-success">正常运行 (SQLite)</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">文件体积</span>
              <span class="meta-val">{{ formatBytes(data.database.dbSizeBytes) }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">页面数量</span>
              <span class="meta-val">{{ formatNumber(data.database.pageCount) }} 页 ({{ formatBytes(data.database.pageSize) }}/页)</span>
            </div>
          </div>
        </div>

        <!-- Image Jobs Queue -->
        <div class="sys-card">
          <h4 class="card-title">图片任务队列</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">排队中 (Pending)</span>
              <span class="meta-val">{{ data.imageJobs.pending }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">执行中 (Running)</span>
              <span class="meta-val">{{ data.imageJobs.running }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">近24小时失败</span>
              <span class="meta-val" :class="{ 'text-danger': data.imageJobs.failedLast24h > 0 }">{{ data.imageJobs.failedLast24h }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">超时疑似卡住 (>10m)</span>
              <span class="meta-val" :class="{ 'text-danger': data.imageJobs.stuckCount > 0 }">{{ data.imageJobs.stuckCount }}</span>
            </div>
          </div>
        </div>

        <!-- Video Jobs Runtime -->
        <div class="sys-card">
          <h4 class="card-title">视频调度引擎</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">调度器状态</span>
              <span class="meta-val text-success">Running</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">活跃项目总数</span>
              <span class="meta-val">{{ data.videoJobs.activeProjectCount }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">配置阻塞</span>
              <span class="meta-val" :class="{ 'text-warning': data.videoJobs.actionable.waitingConfiguration > 0 }">
                {{ data.videoJobs.actionable.waitingConfiguration }}
              </span>
            </div>
            <div class="meta-row">
              <span class="meta-label">拼接失败需处理</span>
              <span class="meta-val" :class="{ 'text-danger': data.videoJobs.actionable.assemblyFailed > 0 }">
                {{ data.videoJobs.actionable.assemblyFailed }}
              </span>
            </div>
            <div class="meta-row">
              <span class="meta-label">超时疑似卡住 (>2h)</span>
              <span class="meta-val" :class="{ 'text-danger': data.videoJobs.stuckCount > 0 }">{{ data.videoJobs.stuckCount }}</span>
            </div>
          </div>
        </div>

        <!-- Agnes Key Pool -->
        <div class="sys-card">
          <h4 class="card-title">G2 (Agnes) 密钥池</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">配置 Key 总数</span>
              <span class="meta-val">{{ data.videoJobs.agnes.keyTotal }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">健康可用 (Healthy)</span>
              <span class="meta-val text-success">{{ data.videoJobs.agnes.healthy }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">限流冷却中 (Cooldown)</span>
              <span class="meta-val" :class="{ 'text-warning': data.videoJobs.agnes.cooldown > 0 }">{{ data.videoJobs.agnes.cooldown }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">降级 (Degraded)</span>
              <span class="meta-val" :class="{ 'text-danger': data.videoJobs.agnes.degraded > 0 }">{{ data.videoJobs.agnes.degraded }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">当前并发占用</span>
              <span class="meta-val">{{ data.videoJobs.agnes.inFlight }}</span>
            </div>
          </div>
        </div>

        <!-- Concurrency & Semaphores -->
        <div class="sys-card">
          <h4 class="card-title">本地并发信号量</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">D2 提交并发</span>
              <span class="meta-val">{{ data.videoJobs.d2Submission.active }} / {{ data.videoJobs.d2Submission.limit }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">媒体处理并发</span>
              <span class="meta-val">{{ data.videoJobs.mediaProcessing.active }} / {{ data.videoJobs.mediaProcessing.limit }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">FFmpeg 拼接并发</span>
              <span class="meta-val">{{ data.videoJobs.ffmpeg.active }} / {{ data.videoJobs.ffmpeg.limit }}</span>
            </div>
          </div>
        </div>

        <!-- Asset Purge Status -->
        <div class="sys-card">
          <h4 class="card-title">媒体资产 30 天清理</h4>
          <div class="sys-meta-list">
            <div class="meta-row">
              <span class="meta-label">已清理生成记录</span>
              <span class="meta-val">{{ formatNumber(data.assetPurge.purgedGenerationCount) }} 篇</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">已释放物理文件</span>
              <span class="meta-val">{{ formatNumber(data.assetPurge.purgedAssetCount) }} 个</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">已释放磁盘空间</span>
              <span class="meta-val text-success">{{ formatBytes(data.assetPurge.purgedBytes) }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">清理失败待重试</span>
              <span class="meta-val" :class="{ 'text-danger': data.assetPurge.purgeFailedCount > 0 }">{{ data.assetPurge.purgeFailedCount }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">最近清理执行</span>
              <span class="meta-val text-muted">{{ formatDateTime(data.assetPurge.lastPurgeAt) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { AdminFilters, SystemResponse } from "../types";
import { computeDateParams, formatNumber, formatBytes, formatDateTime } from "../dateRange";
import { fetchSystemAnalytics } from "../api";
import AdminErrorState from "../components/AdminErrorState.vue";

const props = defineProps<{
  filters: AdminFilters;
}>();
const emit = defineEmits<{ (e: "coverage-update", coverage: any): void }>();

const loading = ref(false);
const error = ref("");
const data = ref<SystemResponse | null>(null);
let abortController: AbortController | null = null;

async function loadData() {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  loading.value = true;
  error.value = "";
  try {
    const params = computeDateParams(props.filters);
    const res = await fetchSystemAnalytics(params, abortController.signal);
    data.value = res;
    emit("coverage-update", res.coverage);
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    error.value = err?.message || "加载系统与异常监控数据失败";
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
.system-panel {
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

.alerts-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.alert-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
}
.alert--warning {
  background: #fffbeb;
  border: 1px solid #fef3c7;
  color: #b45309;
}
.alert--error {
  background: #fef2f2;
  border: 1px solid #fee2e2;
  color: #b91c1c;
}

.system-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
@media (max-width: 1100px) {
  .system-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .system-grid {
    grid-template-columns: 1fr;
  }
}

.sys-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 18px;
  display: flex;
  flex-direction: column;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid #f3f4f6;
}

.sys-meta-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.meta-label {
  color: #6b7280;
}
.meta-val {
  font-weight: 600;
  color: #111827;
}
.text-success { color: #059669; }
.text-warning { color: #d97706; }
.text-danger { color: #dc2626; }
.text-muted { color: #9ca3af; }
</style>
