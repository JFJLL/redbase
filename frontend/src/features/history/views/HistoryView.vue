<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import {
  HISTORY_TYPE_LABELS,
  KNOWN_ASPECT_RATIOS,
  createEmptyGenerationHistoryFilters,
  deleteGeneration,
  fetchBrands,
  fetchGenerationHistory,
  getGenerationPrimaryImageUrl,
  matchesGenerationHistoryFilters,
  safeImageSrc,
  type GenerationHistoryItem,
  type HistoryBrand,
} from "../api";

// 历史生成：列表 + 筛选 + 详情查看 + 删除。签名图片 URL 直接使用后端返回值。
const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const filters = reactive(createEmptyGenerationHistoryFilters());
const generations = ref<GenerationHistoryItem[]>([]);
const brands = ref<HistoryBrand[]>([]);
const loading = ref(false);
const loadError = ref("");
const detailItem = ref<GenerationHistoryItem | null>(null);
const detailImageUrl = ref("");
let filterTimer: ReturnType<typeof setTimeout> | null = null;

const visibleHistory = computed(() => generations.value.filter((item) => matchesGenerationHistoryFilters(item, filters)));
const hasFilters = computed(() => Boolean(filters.q || filters.brandId || filters.type || filters.from || filters.to));

const TYPE_OPTIONS = [...HISTORY_TYPE_LABELS.entries()];

function aspectRatioOf(item: GenerationHistoryItem): string {
  const ratio = String(item.payload?.aspectRatio || "");
  return KNOWN_ASPECT_RATIOS.has(ratio) ? ratio : "";
}

function typeLabel(item: GenerationHistoryItem): string {
  return HISTORY_TYPE_LABELS.get(item.type) || item.type;
}

function formatTime(value?: string): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

async function loadHistory() {
  loading.value = true;
  try {
    const result = await fetchGenerationHistory(filters, scope.signalFor("history"));
    generations.value = result.generations || [];
    loadError.value = "";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    loadError.value = `加载历史失败：${(error as Error).message}`;
  } finally {
    loading.value = false;
  }
}

function scheduleLoad(useDelay: boolean) {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => loadHistory(), useDelay ? 280 : 0);
}

function resetFilters() {
  Object.assign(filters, createEmptyGenerationHistoryFilters());
  loadHistory();
}

async function removeItem(generationId: number) {
  const item = generations.value.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  if (!confirm(`确定删除「${item.cardTitle || item.ideaTitle || "这条生成内容"}」吗？删除后将无法找回。`)) return;
  try {
    await deleteGeneration(generationId, scope.signalFor(`delete-${generationId}`));
    generations.value = generations.value.filter((generation) => Number(generation.id) !== Number(generationId));
    if (detailItem.value && Number(detailItem.value.id) === Number(generationId)) closeDetail();
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    alert(`删除失败：${(error as Error).message}`);
  }
}

function openDetail(item: GenerationHistoryItem, slideUrl = "") {
  detailItem.value = item;
  detailImageUrl.value = slideUrl || getGenerationPrimaryImageUrl(item);
}

function closeDetail() {
  detailItem.value = null;
  detailImageUrl.value = "";
}

async function loadBrands() {
  try {
    const result = await fetchBrands(scope.signalFor("brands"));
    brands.value = result.brands || [];
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    // 品牌下拉加载失败不阻断历史列表。
  }
}

onMounted(() => {
  loadBrands();
  loadHistory();
});

onUnmounted(() => {
  if (filterTimer) clearTimeout(filterTimer);
});
</script>

<template>
  <section class="history-view">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon">◍</span>
          <h1 class="panel-title">历史生成</h1>
        </div>
        <p class="panel-subtitle">查看所有生成过的图片、标题和文案，统一回看并复用已产出的内容资产。</p>
      </div>
    </header>

    <div class="history-retention-note" role="note">历史生成图片会保存七天，请及时下载。</div>

    <section class="history-filters" aria-label="历史生成筛选">
      <label class="history-filter-search">
        <span>搜索</span>
        <input
          v-model="filters.q"
          type="search"
          placeholder="搜索标题、摘要、品牌或趋势"
          data-test="history-search"
          @input="scheduleLoad(true)"
        />
      </label>
      <label>
        <span>品牌</span>
        <select v-model="filters.brandId" data-test="history-brand" @change="scheduleLoad(false)">
          <option value="">全部品牌</option>
          <option v-for="brand in brands" :key="brand.id" :value="String(brand.id)">{{ brand.name }}</option>
        </select>
      </label>
      <label>
        <span>类型</span>
        <select v-model="filters.type" data-test="history-type" @change="scheduleLoad(false)">
          <option value="">全部类型</option>
          <option v-for="[value, label] in TYPE_OPTIONS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>
        <span>开始日期</span>
        <input v-model="filters.from" type="date" @change="scheduleLoad(false)" />
      </label>
      <label>
        <span>结束日期</span>
        <input v-model="filters.to" type="date" @change="scheduleLoad(false)" />
      </label>
      <button type="button" class="secondary-btn small-btn" @click="resetFilters">重置</button>
    </section>

    <p v-if="loadError" class="history-error" data-test="history-error">{{ loadError }}</p>
    <p v-else-if="loading && !generations.length" class="history-loading">正在加载历史生成…</p>

    <div v-if="!loading && !visibleHistory.length && !loadError" class="history-empty" data-test="history-empty">
      {{
        hasFilters
          ? "没有找到符合筛选条件的历史生成记录。"
          : "你还没有任何生成记录。去内容选题页生成朋友圈图、公众号长图或小红书组图后，这里会自动沉淀下来。"
      }}
    </div>

    <article v-for="item in visibleHistory" :key="item.id" class="history-card" data-test="history-card">
      <div class="history-card-top">
        <div>
          <div class="history-card-meta">
            <span class="brand-tag">{{ item.channelLabel }}</span>
            <span class="brand-tag">{{ typeLabel(item) }}</span>
            <span v-if="aspectRatioOf(item)" class="brand-tag">{{ aspectRatioOf(item) }}</span>
            <span class="history-card-time">{{ formatTime(item.createdAt) }}</span>
            <span v-if="(item.payload?.editHistory || []).length" class="brand-tag">
              已改图 {{ (item.payload?.editHistory || []).length }} 次
            </span>
          </div>
          <h3>{{ item.cardTitle }}</h3>
          <div class="history-card-ref">{{ item.brandName }} · {{ item.trendTitle }}</div>
          <div class="history-card-ref">{{ item.ideaTitle }}</div>
        </div>
        <div class="history-card-actions">
          <button
            v-if="getGenerationPrimaryImageUrl(item)"
            type="button"
            class="secondary-btn"
            @click="openDetail(item)"
          >
            查看
          </button>
          <button type="button" class="secondary-btn" data-test="history-delete" @click="removeItem(item.id)">删除</button>
        </div>
      </div>

      <div v-if="item.type === 'moments'" class="history-copy">
        <p v-if="item.payload?.caption"><strong>朋友圈文案：</strong>{{ item.payload?.caption }}</p>
        <p v-if="item.payload?.visualDirection"><strong>视觉方向：</strong>{{ item.payload?.visualDirection }}</p>
      </div>
      <div v-else-if="item.type === 'wechat'" class="history-copy">
        <p v-if="item.payload?.publishTitle"><strong>发布标题：</strong>{{ item.payload?.publishTitle }}</p>
        <p v-if="item.payload?.intro"><strong>文章导语：</strong>{{ item.payload?.intro }}</p>
      </div>
      <div v-else class="history-copy">
        <p v-if="item.payload?.publishTitle"><strong>发布标题：</strong>{{ item.payload?.publishTitle }}</p>
        <p v-if="item.payload?.publishCaption"><strong>发布文案：</strong>{{ item.payload?.publishCaption }}</p>
      </div>

      <div v-if="item.type === 'xhsCarousel'" class="history-grid">
        <img
          v-for="(slide, index) in (item.payload?.slides || []).slice(0, 4).filter((slide) => safeImageSrc(slide.imageUrl || slide.previewUrl))"
          :key="index"
          :src="safeImageSrc(slide.imageUrl || slide.previewUrl)"
          :alt="slide.title || ''"
          loading="lazy"
          decoding="async"
          @click="openDetail(item, safeImageSrc(slide.imageUrl || slide.previewUrl))"
        />
      </div>
      <button
        v-else-if="item.previewUrl"
        type="button"
        class="history-preview"
        @click="openDetail(item)"
      >
        <img :src="safeImageSrc(item.previewUrl)" :alt="item.cardTitle || ''" loading="lazy" decoding="async" />
      </button>
    </article>

    <div v-if="detailItem" class="history-modal" @click.self="closeDetail()">
      <div class="history-modal-body">
        <header class="history-modal-header">
          <h3>{{ detailItem.cardTitle || "历史图片" }}</h3>
          <button type="button" class="secondary-btn" @click="closeDetail()">关闭</button>
        </header>
        <p class="history-card-ref">{{ detailItem.channelLabel }} · {{ typeLabel(detailItem) }}</p>
        <img v-if="detailImageUrl" :src="detailImageUrl" alt="历史生成图片" class="history-modal-image" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.history-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-header h1 {
  margin: 0 0 4px;
  font-size: 22px;
}

.view-subtitle {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.history-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.history-filters input,
.history-filters select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.history-error {
  color: var(--color-brand);
  font-size: 13px;
}

.history-loading,
.history-empty {
  color: var(--color-text-secondary);
  font-size: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 20px;
  background: var(--color-surface);
}

.history-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px;
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-card-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.history-card-top h3 {
  margin: 6px 0 4px;
  font-size: 16px;
}

.history-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.brand-tag {
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 2px 8px;
  color: var(--color-text-secondary);
}

.history-card-time {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.history-card-ref {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.history-card-actions {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  flex-shrink: 0;
}

.history-copy {
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-copy p {
  margin: 0;
}

.history-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.history-grid img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: contain;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  cursor: pointer;
}

.history-preview {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.history-preview img {
  display: block;
  width: min(100%, 240px);
  aspect-ratio: 3 / 4;
  object-fit: contain;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.history-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.history-modal-body {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 20px;
  max-width: 640px;
  max-height: 90vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.history-modal-header h3 {
  margin: 0;
  font-size: 16px;
}

.history-modal-image {
  max-width: 100%;
  border-radius: var(--radius-md);
}

/* Legacy light-workspace history parity. */
.history-view {
  gap: 0;
  color: var(--workspace-text);
}

.history-view .panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.history-view .panel-icon-title {
  display: flex;
  align-items: center;
  gap: 14px;
}

.history-view .panel-icon {
  display: block;
  width: 24.0625px;
  color: var(--workspace-brand);
  font-size: 1.8rem;
  font-weight: 400;
}

.history-view .panel-title {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.history-view .panel-subtitle {
  margin: 10px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.view-header h1 {
  margin: 0 0 10px;
  color: var(--workspace-text);
  font-size: 2.1rem;
  line-height: 1.2;
}

.view-subtitle {
  color: var(--workspace-text-muted);
  font-size: 0.98rem;
  line-height: 1.6;
}

.history-filters {
  display: grid;
  grid-template-columns: minmax(220px, 1.4fr) repeat(4, minmax(140px, 1fr)) auto;
  gap: 12px;
  align-items: end;
  margin-bottom: 18px;
}

.history-retention-note {
  margin: -10px 0 18px;
  padding: 12px 14px;
  border: 1px solid rgba(216, 68, 68, 0.14);
  border-radius: 8px;
  background: #fff7f5;
  color: #6d4d51;
  font-size: 0.95rem;
  line-height: 1.6;
}

.history-filters label {
  display: grid;
  gap: 7px;
  min-width: 0;
  color: #6f687a;
  font-size: 0.78rem;
  font-weight: 800;
}

.history-filters input,
.history-filters select {
  width: 100%;
  min-width: 0;
  height: 42px;
  padding: 0 12px;
  border: 1px solid rgba(18, 16, 17, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--workspace-text);
  font: inherit;
}

.history-filters input:focus,
.history-filters select:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  font-size: 0.9rem;
}

.history-filters .small-btn {
  min-height: 50px;
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.history-error {
  color: #b72e3a;
}

.history-loading,
.history-empty {
  position: relative;
  overflow: hidden;
  padding: 22px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text-muted);
  line-height: 1.7;
}

.history-loading::before,
.history-empty::before,
.history-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.history-card {
  position: relative;
  overflow: hidden;
  gap: 16px;
  padding: 22px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.history-card-top {
  gap: 16px;
}

.history-card-top h3 {
  margin: 10px 0 8px;
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.4;
}

.history-card-meta {
  gap: 8px;
}

.brand-tag {
  padding: 4px 9px;
  border: 0;
  border-radius: var(--workspace-radius-sm);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-weight: 600;
}

.history-card-time,
.history-card-ref {
  color: var(--workspace-text-muted);
  font-size: 0.88rem;
  line-height: 1.6;
}

.history-card-actions {
  gap: 10px;
}

.history-copy {
  color: #4c4244;
  font-size: 0.93rem;
  line-height: 1.75;
}

.history-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.history-grid img,
.history-preview img {
  border-color: rgba(229, 72, 77, 0.08);
  border-radius: var(--workspace-radius-sm);
  background: #faf7f5;
}

.history-modal {
  padding: 28px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.history-modal-body {
  width: min(680px, 100%);
  padding: 24px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.history-modal-header {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--workspace-border);
}

.history-modal-header h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
}

.history-modal-image {
  border-radius: var(--workspace-radius-sm);
}
</style>
