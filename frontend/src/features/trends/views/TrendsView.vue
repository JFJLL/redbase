<script setup lang="ts">
// 趋势分析页。迁移自旧前端 public/index.html data-tab-panel="trends" 与
// public/app.js 的 bindAnalysisButton / renderBrandChips / renderTrendModeTabs /
// renderTrendAnalysisButton / renderXhsCategorySelector / renderHistory /
// renderAnalysisSummary / renderTrends / restoreAnalysisSnapshot / deleteAnalysisSnapshot。
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, isAbortError } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { deleteAnalysis, runTrendAnalysis } from "../api/insightsApi";
import {
  DEFAULT_TREND_BUCKETS,
  DEFAULT_TREND_MODE,
  TREND_ANALYSIS_POLL_INTERVAL_MS,
} from "../model/constants";
import {
  cloneTrendBucket,
  firstTrendBucket,
  flattenXhsCategoryOptions,
  formatTrendAnalysisError,
  getAnalysisBucketKey,
  getDefaultTrendBucket,
  getTrendBucketDescription,
  getTrendBucketsForBrand,
  normalizeTrendBucketKey,
  shouldResetTrendAnalysisRequestId,
} from "../model/trendBuckets";
import { getTrendAnalysisKey, useInsightsStore } from "../stores/insights";
import { useUnauthorizedHandler } from "../composables/useUnauthorizedHandler";
import { buildTrendWarningNotice, type TrendWarningNotice } from "../model/analysisWarnings";
import type { TrendItem } from "../model/types";

const store = useInsightsStore();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const scope = useAbortScope();
const handleUnauthorized = useUnauthorizedHandler();

const deleting = ref(false);
const analysisError = ref("");
const analysisNotice = ref("");
// 非阻断 warning 提示（迁移自 master notifyTrendAnalysisWarnings）：
// 降级批次仍是成功，只展示提示，不弹失败框、不退款。
const analysisWarning = ref<TrendWarningNotice | null>(null);
const historyError = ref("");
const detailError = ref("");

// 轮询定时器与本组件持有的 busy key：卸载/退出登录（路由离开）时必须清理。
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeBusyKeys = new Set<string>();

onScopeDispose(() => {
  for (const timer of pollTimers.values()) clearTimeout(timer);
  pollTimers.clear();
  if (activeBusyKeys.size) {
    store.trendAnalysisLoadingKeys = store.trendAnalysisLoadingKeys.filter((key) => !activeBusyKeys.has(key));
    activeBusyKeys.clear();
  }
});

const brand = computed(() => store.selectedBrand);
const profileLabel = computed(() => (brand.value?.profileType === "personal" ? "个人 IP" : "品牌"));
const pageBusy = computed(() => store.brandsStatus === "loading" || deleting.value);
const bucketKey = computed(
  () => normalizeTrendBucketKey(store.selectedTrendMode || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE,
);
const bucketLabel = computed(() => getDefaultTrendBucket(store.selectedTrendMode)?.title || "当前维度");
const isXhsMode = computed(() => bucketKey.value === "xhs");
const modeBuckets = computed(() =>
  brand.value ? getTrendBucketsForBrand(brand.value) : DEFAULT_TREND_BUCKETS.map((item) => ({ ...item, items: [] })),
);

const waitingForBrand = computed(() => Boolean(brand.value && !brand.value._detailLoaded));
const analysisLoading = computed(() =>
  Boolean(brand.value && store.isAnalysisLoading(brand.value.id, bucketKey.value)),
);
const analysisDisabled = computed(() => pageBusy.value || waitingForBrand.value || analysisLoading.value);

const categoryOptions = computed(() => flattenXhsCategoryOptions(store.xhsCategories));
const categoryDisabled = computed(
  () =>
    pageBusy.value ||
    Boolean(brand.value && store.isAnalysisLoading(brand.value.id, "xhs")) ||
    store.xhsCategoryStatus !== "ready",
);
const categoryStatusText = computed(() => {
  if (store.xhsCategoryStatus === "loading") return "正在加载类目...";
  if (store.xhsCategoryStatus === "error") return store.xhsCategoryError || "小红书内容类目暂时不可用";
  if (store.xhsCategoryStatus === "empty") return "暂无可选类目";
  const selected = categoryOptions.value.find((item) => item.value === store.xhsCategoryPath);
  return selected ? `当前类目：${selected.label}` : "全部内容类目";
});

// 右侧分析提示（旧版 renderAnalysisSummary）。
const summaryText = computed(() => {
  const current = brand.value;
  if (!current) return "先新增品牌或个人 IP 档案，再开始基于主体档案的热点趋势分析。";
  if (!current._detailLoaded) {
    return `正在加载 ${current.name} 的完整${profileLabel.value}详情和趋势记录。`;
  }
  if (!current.trends.length) {
    return `已为 ${current.name} 建立「${profileLabel.value}」档案。请选择一个热点维度，点击左侧按钮只生成该维度的 10 条趋势和 20 个完整选题。`;
  }
  const bucket = store.currentBucket;
  const label = getDefaultTrendBucket(bucket?.key)?.title || bucket?.title || "当前维度";
  const count = bucket?.items?.length || 0;
  if (!count) {
    return `${current.name} 的「${label}」还没有生成。点击左侧按钮后，只会生成这个维度，不会生成其他维度。`;
  }
  return `${current.name} 的「${label}」已生成 ${count}/10 条趋势，每条趋势下有 2 个完整内容选题。切换到其他维度后可按需单独生成。`;
});

const fallbackBucket = computed(() => getDefaultTrendBucket(store.selectedTrendMode) || DEFAULT_TREND_BUCKETS[0]);
const currentBucket = computed(() => store.currentBucket);
const bucketDescription = computed(() =>
  getTrendBucketDescription(currentBucket.value ?? fallbackBucket.value, brand.value),
);

onMounted(() => {
  void loadPage();
});

async function loadPage(): Promise<void> {
  try {
    // 每次进入趋势页强制刷新摘要，品牌档案页的增删改才能同步进来。
    await store.loadBrands(scope.signalFor("brands"), { force: true });
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    return;
  }
  applyRouteBrandId();
  store.loadXhsCategories(scope.signalFor("xhs-categories")).catch((error) => {
    if (!isAbortError(error)) handleUnauthorized(error);
  });
  await loadSelectedBrandDetail();
}

// 品牌档案页「AI趋势分析」按 ?brandId= 跳转过来时预选该品牌；
// 无效或不存在的 brandId 忽略，保持默认选中行为。
function applyRouteBrandId(): void {
  const raw = route.query.brandId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return;
  const brandId = Number(value);
  if (!Number.isInteger(brandId) || brandId <= 0) return;
  if (!store.brands.some((item) => Number(item.id) === brandId)) return;
  if (store.selectedBrandId !== brandId) {
    store.selectedBrandId = brandId;
    store.selectedTrendId = null;
    store.syncSelectedTrendSelection();
  }
}

async function loadSelectedBrandDetail(): Promise<void> {
  const brandId = store.selectedBrandId;
  if (!brandId) return;
  detailError.value = "";
  try {
    await store.ensureBrandDetail(brandId, scope.signalFor(`brand-detail:${brandId}`));
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    detailError.value = `${profileLabel.value}详情加载失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

function selectBrand(brandId: number): void {
  store.selectedBrandId = brandId;
  store.syncSelectedTrendSelection();
  void loadSelectedBrandDetail();
}

function selectMode(key: string): void {
  store.selectedTrendMode = key;
  store.selectedTrendId = store.currentBucket?.items?.[0]?.id ?? null;
}

function onCategoryChange(event: Event): void {
  store.xhsCategoryPath = (event.target as HTMLSelectElement).value;
}

// --- 趋势分析（含 409 轮询复取，旧版 bindAnalysisButton）---

function finishAnalysis(brandId: number, key: string): void {
  const busyKey = getTrendAnalysisKey(brandId, key);
  store.setAnalysisBusy(brandId, key, false);
  activeBusyKeys.delete(busyKey);
}

async function handleRunAnalysis(): Promise<void> {
  const brandId = Number(store.selectedBrandId);
  const key = bucketKey.value;
  if (!brandId || store.isAnalysisLoading(brandId, key)) return;
  analysisError.value = "";
  analysisNotice.value = "";
  analysisWarning.value = null;
  store.setAnalysisBusy(brandId, key, true);
  activeBusyKeys.add(getTrendAnalysisKey(brandId, key));
  try {
    const detail = await store.ensureBrandDetail(brandId, scope.signalFor(`brand-detail:${brandId}`));
    if (!detail) {
      finishAnalysis(brandId, key);
      return;
    }
  } catch (error) {
    finishAnalysis(brandId, key);
    if (isAbortError(error) || handleUnauthorized(error)) return;
    analysisError.value = formatTrendAnalysisError(error);
    return;
  }
  await attemptAnalysis(brandId, key);
}

async function attemptAnalysis(brandId: number, key: string): Promise<void> {
  const requestId = store.getOrCreateAnalysisRequestId(brandId, key);
  try {
    const result = await runTrendAnalysis(
      brandId,
      {
        requestId,
        bucketKey: key,
        xhsCategoryPath: key === "xhs" ? store.xhsCategoryPath || "" : "",
      },
      scope.signalFor(`analysis:${brandId}:${key}`),
    );
    const generatedBucket = getTrendBucketsForBrand(result.brand).find((bucket) => bucket.key === key);
    if (!generatedBucket || generatedBucket.items?.length !== 10) {
      throw new Error("服务端未返回完整的 10 条趋势，本次结果未应用。");
    }
    // 成功即成功：warnings 只产生非阻断提示（409 轮询复取的最终成功同样走这里）。
    analysisWarning.value = buildTrendWarningNotice(result.warnings, generatedBucket.items.length);
    store.applyAnalysisResult(brandId, key, result);
    store.clearAnalysisRequestId(brandId, key);
    analysisNotice.value = "";
    finishAnalysis(brandId, key);
  } catch (error) {
    if (isAbortError(error)) {
      finishAnalysis(brandId, key);
      return;
    }
    if (handleUnauthorized(error)) {
      finishAnalysis(brandId, key);
      return;
    }
    if (error instanceof ApiError && error.status === 409) {
      // 服务端同一 requestId 仍在生成：保持进行中状态并定时复取（幂等重放）。
      analysisNotice.value = error.message;
      schedulePoll(brandId, key);
      return;
    }
    if (shouldResetTrendAnalysisRequestId(error)) {
      store.clearAnalysisRequestId(brandId, key);
    }
    analysisNotice.value = "";
    analysisError.value = formatTrendAnalysisError(error);
    finishAnalysis(brandId, key);
  }
}

function schedulePoll(brandId: number, key: string): void {
  const timerKey = getTrendAnalysisKey(brandId, key);
  const existing = pollTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pollTimers.delete(timerKey);
    if (!auth.isLoggedIn) {
      finishAnalysis(brandId, key);
      return;
    }
    void attemptAnalysis(brandId, key);
  }, TREND_ANALYSIS_POLL_INTERVAL_MS);
  pollTimers.set(timerKey, timer);
}

// --- 历史分析（旧版 restoreAnalysisSnapshot / deleteAnalysisSnapshot）---

function viewAnalysis(analysisId: number): void {
  historyError.value = "";
  const current = brand.value;
  if (!current) return;
  const analysis = (current.analyses || []).find((item) => item.id === analysisId);
  if (!analysis) {
    historyError.value = "未找到对应的历史分析。";
    return;
  }
  if (!Array.isArray(analysis.trendSnapshot) || analysis.trendSnapshot.length === 0) {
    historyError.value = "这条历史分析没有保存趋势快照，暂时无法恢复查看。请重新生成一次分析。";
    return;
  }
  const analysisBucketKey = getAnalysisBucketKey(analysis);
  const trendSnapshot = analysisBucketKey
    ? analysis.trendSnapshot.filter((bucket) => normalizeTrendBucketKey(bucket.key) === analysisBucketKey)
    : analysis.trendSnapshot;
  if (analysisBucketKey && !trendSnapshot.length) {
    historyError.value = "这条历史分析没有当前维度的趋势快照，请重新生成一次该维度分析。";
    return;
  }
  store.brands = store.brands.map((item) => {
    if (item.id !== current.id) return item;
    return { ...item, trends: trendSnapshot.map(cloneTrendBucket) };
  });
  store.selectedTrendMode = analysisBucketKey || firstTrendBucket(store.selectedBrand)?.key || DEFAULT_TREND_MODE;
  store.selectedTrendId = store.currentBucket?.items?.[0]?.id ?? null;
}

async function removeAnalysis(analysisId: number): Promise<void> {
  historyError.value = "";
  const current = brand.value;
  if (!current) return;
  const analysis = (current.analyses || []).find((item) => Number(item.id) === Number(analysisId));
  if (!analysis) {
    historyError.value = "未找到对应的历史分析。";
    return;
  }
  if (!window.confirm(`确定删除「${analysis.name}」吗？删除后这条历史分析和其中保存的话题快照将无法恢复。`)) return;
  deleting.value = true;
  try {
    const result = await deleteAnalysis(current.id, analysisId, scope.signalFor(`analysis-delete:${analysisId}`));
    store.replaceBrand(result.brand);
    const nextBrand = store.selectedBrand;
    if (!store.currentBucket?.items?.some((trend) => Number(trend.id) === Number(store.selectedTrendId))) {
      store.selectedTrendMode = firstTrendBucket(nextBrand)?.key ?? DEFAULT_TREND_MODE;
      store.selectedTrendId = firstTrendBucket(nextBrand)?.items?.[0]?.id ?? null;
    }
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    historyError.value = `删除失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    deleting.value = false;
  }
}

// 「生成选题」跳转内容选题页（旧版 data-idea-trend → switchTab("ideas")）。
function goToIdeas(trend: TrendItem): void {
  store.selectedTrendId = Number(trend.id);
  void router.push({ name: "ideas" });
}
</script>

<template>
  <section class="trends-panel">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon panel-icon-orange">↗</span>
          <h1 class="panel-title">热点趋势分析</h1>
        </div>
        <p class="panel-subtitle">选择品牌或个人 IP，AI 分析全网十大热点趋势</p>
      </div>
    </header>

    <div v-if="store.brandsStatus === 'error'" class="error-banner" data-test="brands-error">
      加载失败：{{ store.brandsError }}
      <button class="text-btn" type="button" @click="loadPage">重试</button>
    </div>
    <div v-if="detailError" class="error-banner" data-test="detail-error">{{ detailError }}</div>

    <div class="brand-chip-row" data-test="brand-chips">
      <button
        v-for="item in store.brands"
        :key="item.id"
        class="brand-chip"
        :class="{ 'is-active': item.id === store.selectedBrandId }"
        type="button"
        @click="selectBrand(item.id)"
      >
        {{ item.name }}
        <small v-if="item.profileType === 'personal'">个人 IP</small>
      </button>
    </div>

    <div class="trend-mode-row" data-test="trend-mode-tabs">
      <button
        v-for="bucket in modeBuckets"
        :key="bucket.key"
        class="trend-mode-tab"
        :class="{ 'is-active': bucket.key === store.selectedTrendMode }"
        type="button"
        @click="selectMode(bucket.key)"
      >
        {{ getDefaultTrendBucket(bucket.key)?.title || bucket.title }}
      </button>
    </div>

    <div class="trend-screen">
      <div class="trend-left-panel">
        <label v-if="isXhsMode" class="xhs-category-control">
          <span>小红书内容类目</span>
          <select
            data-test="xhs-category-select"
            :value="store.xhsCategoryPath"
            :disabled="categoryDisabled"
            @change="onCategoryChange"
          >
            <option value="">全部内容类目</option>
            <option v-for="option in categoryOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <small data-test="xhs-category-status">{{ categoryStatusText }}</small>
        </label>

        <button
          class="primary-btn wide-btn cost-button"
          data-test="run-analysis"
          type="button"
          :disabled="analysisDisabled"
          @click="handleRunAnalysis"
        >
          <template v-if="waitingForBrand">
            <span>加载品牌详情中...</span>
            <small>稍后可生成</small>
          </template>
          <template v-else-if="analysisLoading">
            <span>{{ bucketLabel }}生成中...</span>
          </template>
          <template v-else-if="pageBusy">
            <span>处理中...</span>
          </template>
          <template v-else>
            <span>生成{{ bucketLabel }}</span>
            <small>消耗 1 积分</small>
          </template>
        </button>

        <p v-if="analysisNotice" class="analysis-notice" data-test="analysis-notice">{{ analysisNotice }}</p>
        <p v-if="analysisError" class="analysis-error" data-test="analysis-error">{{ analysisError }}</p>
        <aside v-if="analysisWarning" class="analysis-warning" data-test="analysis-warning">
          <p class="analysis-warning-summary" data-test="analysis-warning-summary">{{ analysisWarning.summary }}</p>
          <ul class="analysis-warning-list">
            <li v-for="message in analysisWarning.messages" :key="message" data-test="analysis-warning-message">
              {{ message }}
            </li>
          </ul>
        </aside>

        <section class="history-block">
          <h3>历史分析</h3>
          <p v-if="historyError" class="analysis-error" data-test="history-error">{{ historyError }}</p>
          <div data-test="history-list">
            <p v-if="!brand" class="analysis-tip">当前账号还没有任何品牌分析记录。</p>
            <p v-else-if="!brand._detailLoaded" class="analysis-tip">正在加载 {{ brand.name }} 的分析记录...</p>
            <p v-else-if="!brand.analyses.length" class="analysis-tip">
              当前{{ profileLabel }}还没有分析记录，点击上方按钮即可开始分析。
            </p>
            <template v-else>
              <div v-for="item in brand.analyses" :key="item.id" class="history-item">
                <div>
                  <div>{{ item.name }}</div>
                  <div class="panel-subtitle">{{ item.timestamp }}</div>
                </div>
                <div class="history-item-actions">
                  <button class="text-btn" type="button" @click="viewAnalysis(item.id)">查看</button>
                  <button class="text-btn danger-text-btn" type="button" @click="removeAnalysis(item.id)">删除</button>
                </div>
              </div>
            </template>
          </div>
        </section>
      </div>

      <div class="trend-right-panel">
        <div class="analysis-tip analysis-summary" data-test="analysis-summary">{{ summaryText }}</div>
        <div class="trend-cards" data-test="trend-list">
          <article class="trend-card">
            <div>
              <h3>{{ getDefaultTrendBucket(currentBucket?.key ?? fallbackBucket.key)?.title || fallbackBucket.title }}</h3>
              <p>{{ bucketDescription }}</p>
              <p v-if="brand && !brand._detailLoaded" class="analysis-tip">
                正在加载 {{ brand.name }} 的趋势和选题记录...
              </p>
              <p v-else-if="!brand || !currentBucket || !currentBucket.items.length" class="analysis-tip">
                当前维度还没有生成。点击左侧按钮后，将只生成这个维度的 10 条趋势和 20 个完整选题。
              </p>
            </div>
          </article>

          <template v-if="brand && brand._detailLoaded && currentBucket">
            <article v-for="trend in currentBucket.items" :key="trend.id" class="trend-card" data-test="trend-card">
              <div class="trend-top">
                <div class="trend-rank">{{ trend.rank }}</div>
                <div>
                  <h3>{{ trend.title }}</h3>
                  <span class="trend-category">{{ trend.category }}</span>
                </div>
              </div>
              <p>{{ trend.summary }}</p>
              <p v-if="trend.reason" class="trend-reason"><strong>机会点：</strong>{{ trend.reason }}</p>
              <div class="score-track">
                <div class="score-fill" :style="{ width: `${trend.score}%` }"></div>
              </div>
              <div v-if="trend.evidence?.length" class="trend-evidence" data-test="trend-evidence">
                <strong>证据链接：</strong>
                <a
                  v-for="item in trend.evidence"
                  :key="item.id || item.url"
                  :href="item.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ item.title || item.url }}
                  <small v-if="item.host || item.source"> · {{ item.host || item.source }}</small>
                </a>
              </div>
              <div class="trend-footer">
                <span v-for="tag in trend.tags" :key="tag" class="idea-tag">{{ tag }}</span>
                <span class="trend-score">{{ trend.score }}/100</span>
                <button class="text-btn" type="button" data-test="go-ideas" @click="goToIdeas(trend)">生成选题</button>
              </div>
            </article>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.trends-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-icon-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: rgba(255, 122, 36, 0.12);
  color: #ff7a24;
  font-weight: 700;
}

.panel-title {
  margin: 0;
  font-size: 22px;
}

.panel-subtitle {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.error-banner {
  border: 1px solid rgba(245, 74, 69, 0.4);
  background: rgba(245, 74, 69, 0.06);
  color: var(--color-danger);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-chip-row,
.trend-mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.brand-chip,
.trend-mode-tab {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}

.brand-chip small {
  color: var(--color-text-secondary);
  margin-left: 4px;
}

.brand-chip.is-active,
.trend-mode-tab.is-active {
  border-color: var(--color-brand);
  color: var(--color-brand);
  background: rgba(255, 36, 66, 0.06);
  font-weight: 600;
}

.trend-screen {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.trend-left-panel {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.trend-right-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 旧版桌面端独立滚动（styles.css .trend-right-panel）。 */
  max-height: calc(100vh - 250px);
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 8px;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

/* 旧版桌面端页面锁滚语义：趋势页激活时整页不滚，由右侧结果面板独立滚动。 */
@media (min-width: 761px) {
  :global(html:has(.trends-panel)),
  :global(body:has(.trends-panel)) {
    height: 100%;
    overflow: hidden;
  }
}

/* 窄屏降级（旧版 ≤760px）：整页滚动、单列布局，右侧面板不再独立滚动。 */
@media (max-width: 760px) {
  .trend-screen {
    flex-direction: column;
  }

  .trend-left-panel {
    width: 100%;
  }

  .trend-right-panel {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }
}

.xhs-category-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.xhs-category-control select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px;
}

.xhs-category-control small {
  color: var(--color-text-secondary);
}

.primary-btn {
  border: none;
  background: var(--color-brand);
  color: #fff;
  border-radius: var(--radius-md);
  padding: 10px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.primary-btn small {
  font-size: 11px;
  opacity: 0.85;
}

.text-btn {
  border: none;
  background: none;
  color: var(--color-brand);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
}

.danger-text-btn {
  color: var(--color-danger);
}

.analysis-notice {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: pre-line;
}

.analysis-error {
  margin: 0;
  font-size: 13px;
  color: var(--color-danger);
  white-space: pre-line;
}

/* 非阻断 warning：黄色提示条，区别于失败红与常规灰。 */
.analysis-warning {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #f0c78a;
  border-radius: var(--radius-md);
  background: #fff8ec;
  font-size: 13px;
  color: #8a5a00;
}

.analysis-warning-summary {
  margin: 0 0 4px;
  font-weight: 600;
}

.analysis-warning-list {
  margin: 0;
  padding-left: 18px;
}

.history-block {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.history-block h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--color-border);
  font-size: 13px;
}

.history-item-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.analysis-tip {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.analysis-summary {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}

.trend-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.trend-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trend-card h3 {
  margin: 0;
  font-size: 16px;
}

.trend-card p {
  margin: 0;
  font-size: 13px;
  color: var(--color-text);
}

.trend-top {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.trend-rank {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 36, 66, 0.08);
  color: var(--color-brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}

.trend-category {
  display: inline-block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 1px 8px;
}

.trend-reason {
  color: var(--color-text-secondary);
}

.score-track {
  height: 6px;
  border-radius: 999px;
  background: var(--color-bg);
  overflow: hidden;
}

.score-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #ff7a24, var(--color-brand));
}

.trend-evidence {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.trend-evidence a {
  color: var(--color-brand);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trend-evidence a small {
  color: var(--color-text-secondary);
}

.trend-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.idea-tag {
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: 999px;
  padding: 2px 10px;
}

.trend-score {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
