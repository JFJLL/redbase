<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import ImageEditPanel from "@/features/generation/components/ImageEditPanel.vue";
import type { ImageEditTarget } from "@/features/generation/composables/useImageEdit";
import {
  HISTORY_TYPE_LABELS,
  KNOWN_ASPECT_RATIOS,
  createEmptyGenerationHistoryFilters,
  deleteGeneration,
  fetchBrands,
  fetchGenerationHistory,
  getGenerationPrimaryImageUrl,
  hasExpiredAssetSignature,
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
const detailSlideIndex = ref<number | null>(null);
const editEntryId = ref<string | null>(null);
let filterTimer: ReturnType<typeof setTimeout> | null = null;

// 图片加载失败：明确错误态 + 重试；签名过期只刷新一次列表拿新签名，不无限循环。
const failedImageUrls = reactive(new Set<string>());
const refreshedSignatureUrls = new Set<string>();
let signatureRefreshInFlight = false;
let signatureRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const detailImageUrl = computed(() => {
  const item = detailItem.value;
  if (!item) return "";
  if (detailSlideIndex.value != null && Array.isArray(item.payload?.slides)) {
    const slide = item.payload.slides[detailSlideIndex.value];
    const slideSrc = safeImageSrc(slide?.imageUrl || slide?.previewUrl);
    if (slideSrc) return slideSrc;
  }
  return safeImageSrc(item.previewUrl);
});

const editTarget = computed<ImageEditTarget | null>(() => {
  const item = detailItem.value;
  if (!item) return null;
  return {
    imageUrl: detailImageUrl.value,
    title: item.cardTitle || "历史图片",
    generationId: Number(item.id),
    aspectRatio: String(item.payload?.aspectRatio || ""),
    slideIndex: detailSlideIndex.value,
  };
});

interface EditHistoryEntry {
  id?: unknown;
  imageUrl?: string;
  previewUrl?: string;
  title?: string;
  createdAt?: string;
  completedAt?: string;
  aspectRatio?: string;
  sourceSlideIndex?: number;
}

const editHistoryEntries = computed<EditHistoryEntry[]>(() => {
  const item = detailItem.value;
  if (!item || !Array.isArray(item.payload?.editHistory)) return [];
  return item.payload.editHistory as EditHistoryEntry[];
});

/** 历史记录自己的内联改图面板目标：父链由记录自身推导，不共享主表单。 */
function editTargetForEntry(entry: EditHistoryEntry): ImageEditTarget | null {
  const item = detailItem.value;
  if (!item) return null;
  const entryId = entry.id != null ? String(entry.id) : "";
  return {
    imageUrl: String(entry.imageUrl || entry.previewUrl || ""),
    title: String(entry.title || item.cardTitle || "改图结果"),
    generationId: Number(item.id),
    aspectRatio: String(entry.aspectRatio || item.payload?.aspectRatio || ""),
    ...(entryId ? { parentEditId: entryId } : {}),
    slideIndex: Number.isInteger(entry.sourceSlideIndex) ? Number(entry.sourceSlideIndex) : detailSlideIndex.value,
  };
}

function isImageFailed(url: string): boolean {
  return Boolean(url) && failedImageUrls.has(url);
}

function retryImage(url: string) {
  if (!url) return;
  failedImageUrls.delete(url);
}

function onHistoryImageError(url: string) {
  if (!url) return;
  if (hasExpiredAssetSignature(url)) {
    if (refreshedSignatureUrls.has(url)) {
      failedImageUrls.add(url);
      return;
    }
    refreshedSignatureUrls.add(url);
    scheduleSignatureRefresh();
    return;
  }
  failedImageUrls.add(url);
}

function scheduleSignatureRefresh() {
  if (signatureRefreshInFlight) return;
  if (signatureRefreshTimer) clearTimeout(signatureRefreshTimer);
  signatureRefreshTimer = setTimeout(() => {
    signatureRefreshTimer = null;
    signatureRefreshInFlight = true;
    loadHistory().finally(() => {
      signatureRefreshInFlight = false;
    });
  }, 250);
}

function slideImages(item: GenerationHistoryItem): Array<{ sourceIndex: number; src: string; title: string }> {
  return (item.payload?.slides || [])
    .slice(0, 4)
    .map((slide, sourceIndex) => ({
      sourceIndex,
      src: safeImageSrc(slide.imageUrl || slide.previewUrl),
      title: slide.title || "",
    }))
    .filter((entry) => Boolean(entry.src));
}

function previewSrc(item: GenerationHistoryItem): string {
  return safeImageSrc(item.previewUrl);
}

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
    // 签名过期刷新后，把已打开的详情同步到新签名，避免旧 URL 继续 401 破图。
    if (detailItem.value) {
      const currentId = detailItem.value.id;
      const currentIndex = detailSlideIndex.value;
      const refreshed = generations.value.find((generation) => Number(generation.id) === Number(currentId));
      if (refreshed) {
        detailItem.value = refreshed;
        detailSlideIndex.value = currentIndex;
      }
    }
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
  const slides = slideImages(item);
  const requestedUrl = slideUrl || safeImageSrc(item.previewUrl);
  const selected = slides.find((slide) => slide.src === requestedUrl) || slides[0] || null;
  detailSlideIndex.value = selected?.sourceIndex ?? null;
  editEntryId.value = null;
}

function closeDetail() {
  detailItem.value = null;
  detailSlideIndex.value = null;
  editEntryId.value = null;
}

function openEditFromHistory(entryId: string | null): void {
  // 幂等选中：点击记录展开它自己的内联面板；面板内按钮的点击冒泡不会切换面板。
  editEntryId.value = entryId;
}

function selectSlide(sourceIndex: number): void {
  detailSlideIndex.value = sourceIndex;
  editEntryId.value = null;
}

async function onEdited(): Promise<void> {
  try {
    await auth.refreshUser();
  } catch (error) {
    if (isAbortError(error) || isUnauthorized(error)) return;
  }
  await loadHistory();
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
  if (signatureRefreshTimer) clearTimeout(signatureRefreshTimer);
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

    <div class="history-generate-list" data-test="history-generate-list">
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
              data-test="history-detail"
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
          <div v-for="(slide, index) in slideImages(item)" :key="index" class="history-slide-cell">
            <div v-if="isImageFailed(slide.src)" class="history-image-error" data-test="history-image-error">
              <span>图片加载失败</span>
              <button
                type="button"
                class="secondary-btn"
                data-test="history-image-retry"
                @click="retryImage(slide.src)"
              >
                重试
              </button>
            </div>
            <img
              v-else
              :src="slide.src"
              :alt="slide.title"
              loading="lazy"
              decoding="async"
              @click="openDetail(item, slide.src)"
              @error="onHistoryImageError(slide.src)"
            />
          </div>
        </div>
        <button
          v-else-if="previewSrc(item)"
          type="button"
          class="history-preview"
          @click="openDetail(item)"
        >
          <div v-if="isImageFailed(previewSrc(item))" class="history-image-error" data-test="history-image-error">
            <span>图片加载失败</span>
            <button
              type="button"
              class="secondary-btn"
              data-test="history-image-retry"
              @click.stop="retryImage(previewSrc(item))"
            >
              重试
            </button>
          </div>
          <img
            v-else
            :src="previewSrc(item)"
            :alt="item.cardTitle || ''"
            loading="lazy"
            decoding="async"
            @error="onHistoryImageError(previewSrc(item))"
          />
        </button>
      </article>
    </div>

    <div v-if="detailItem" class="history-modal" @click.self="closeDetail()">
      <div class="history-modal-body">
        <header class="history-modal-header">
          <h3>{{ detailItem.cardTitle || "历史图片" }}</h3>
          <button type="button" class="secondary-btn" @click="closeDetail()">关闭</button>
        </header>

        <div class="history-asset-header" data-test="history-asset-header">
          <p class="history-card-ref"><strong>生成类型：</strong>{{ detailItem.channelLabel }} · {{ typeLabel(detailItem) }}</p>
          <p v-if="detailItem.ideaTitle" class="history-card-ref"><strong>来源选题：</strong>{{ detailItem.ideaTitle }}</p>
          <div v-if="detailItem.type === 'moments'" class="history-copy">
            <p v-if="detailItem.payload?.caption"><strong>朋友圈文案：</strong>{{ detailItem.payload?.caption }}</p>
            <p v-if="detailItem.payload?.visualDirection"><strong>视觉方向：</strong>{{ detailItem.payload?.visualDirection }}</p>
          </div>
          <div v-else-if="detailItem.type === 'wechat'" class="history-copy">
            <p v-if="detailItem.payload?.publishTitle"><strong>发布标题：</strong>{{ detailItem.payload?.publishTitle }}</p>
            <p v-if="detailItem.payload?.intro"><strong>文章导语：</strong>{{ detailItem.payload?.intro }}</p>
          </div>
          <div v-else class="history-copy">
            <p v-if="detailItem.payload?.publishTitle"><strong>发布标题：</strong>{{ detailItem.payload?.publishTitle }}</p>
            <p v-if="detailItem.payload?.publishCaption"><strong>发布文案：</strong>{{ detailItem.payload?.publishCaption }}</p>
          </div>
        </div>

        <div v-if="slideImages(detailItem).length > 1" class="history-slide-tabs" data-test="history-slide-tabs">
          <button
            v-for="slide in slideImages(detailItem)"
            :key="slide.sourceIndex"
            type="button"
            class="secondary-btn history-slide-tab"
            :class="{ 'is-active': detailSlideIndex === slide.sourceIndex }"
            :data-test="`history-slide-tab-${slide.sourceIndex}`"
            @click="selectSlide(slide.sourceIndex)"
          >
            第 {{ slide.sourceIndex + 1 }} 张
          </button>
        </div>

        <div class="history-detail-grid" data-test="history-detail-grid">
          <div class="history-detail-preview" data-test="history-detail-preview">
            <template v-if="detailImageUrl">
              <div v-if="isImageFailed(detailImageUrl)" class="history-image-error" data-test="history-image-error">
                <span>图片加载失败</span>
                <button
                  type="button"
                  class="secondary-btn"
                  data-test="history-image-retry"
                  @click="retryImage(detailImageUrl)"
                >
                  重试
                </button>
              </div>
              <img
                v-else
                :src="detailImageUrl"
                :alt="detailItem.cardTitle || '历史生成图片'"
                @error="onHistoryImageError(detailImageUrl)"
              />
            </template>
          </div>
          <div class="history-detail-form" data-test="history-edit-open" @click="editEntryId = null">
            <h3>原图改图</h3>
            <ImageEditPanel v-if="!editEntryId" :target="editTarget" @edited="onEdited" />
            <p v-else class="history-edit-hint" data-test="history-edit-hint">
              已选择一条改图记录，正在基于该结果继续改图。
            </p>
          </div>
        </div>

        <section class="history-edit-history" data-test="history-edit-history">
          <strong>图片修改历史</strong>
          <p v-if="!editHistoryEntries.length" class="history-edit-empty">还没有改图记录。</p>
          <ul v-else class="history-edit-history-list">
            <li
              v-for="entry in editHistoryEntries"
              :key="String(entry.id || '')"
              class="history-edit-history-item"
              :class="{ 'is-active': editEntryId === String(entry.id || '') }"
              :data-test="`history-edit-history-item-${String(entry.id || '')}`"
              @click="openEditFromHistory(String(entry.id || ''))"
            >
              <img
                v-if="safeImageSrc(entry.imageUrl || entry.previewUrl)"
                :src="safeImageSrc(entry.imageUrl || entry.previewUrl)"
                :alt="entry.title || '改图结果'"
                loading="lazy"
                decoding="async"
              />
              <div class="history-edit-history-meta">
                <div class="history-card-meta">
                  <span class="brand-tag">改图</span>
                  <span v-if="entry.sourceSlideIndex != null" class="brand-tag">
                    第 {{ Number(entry.sourceSlideIndex) + 1 }} 张
                  </span>
                  <span class="history-card-time" data-test="history-edit-history-time">
                    {{ formatTime(entry.createdAt || entry.completedAt) }}
                  </span>
                </div>
                <h3>{{ entry.title || "改图结果" }}</h3>
                <ImageEditPanel
                  v-if="editEntryId === String(entry.id || '')"
                  :target="editTargetForEntry(entry)"
                  label="基于此结果继续改图"
                  @edited="onEdited"
                />
              </div>
            </li>
          </ul>
        </section>
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.history-grid img {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  cursor: pointer;
}

.history-slide-cell {
  min-width: 0;
}

.history-image-error {
  width: 100%;
  aspect-ratio: 3 / 4;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 13px;
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
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
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

.history-slide-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.history-slide-tab.is-active {
  border-color: var(--color-brand, #2f6fed);
  color: var(--color-brand, #2f6fed);
  font-weight: 700;
}

.history-edit-history {
  display: grid;
  gap: 8px;
}

.history-edit-history-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-edit-history-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius, var(--radius-md));
  background: var(--workspace-surface-soft, #faf7f5);
  cursor: pointer;
}

.history-edit-history-item.is-active {
  border-color: var(--workspace-brand, var(--color-brand, #2f6fed));
}

.history-edit-history-item img {
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: var(--workspace-radius-sm, var(--radius-md, 8px));
  border: 1px solid var(--workspace-border, var(--color-border));
}

.history-edit-history-meta {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 8px;
  align-content: start;
}

.history-edit-history-meta h3 {
  margin: 0;
  font-size: 13px;
}

.history-edit-empty {
  margin: 0;
  color: var(--workspace-text-muted, var(--color-text-secondary));
  font-size: 13px;
}

.history-asset-header {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius, var(--radius-md));
  background: var(--workspace-surface-soft, #faf7f5);
}

.history-asset-header p {
  margin: 0;
}

.history-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.history-detail-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border: 1px solid var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius-sm, var(--radius-md));
  background: #faf7f5;
}

.history-detail-preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.history-detail-form {
  display: grid;
  gap: 10px;
  align-content: start;
}

.history-detail-form h3 {
  margin: 0;
  font-size: 15px;
}

.history-edit-hint {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--workspace-border, var(--color-border));
  border-radius: var(--workspace-radius-sm, var(--radius-md));
  color: var(--workspace-text-muted, var(--color-text-secondary));
  font-size: 13px;
  background: var(--workspace-surface-soft, #faf7f5);
}

/* Legacy light-workspace history parity. */
.history-view {
  gap: 0;
  color: var(--workspace-text);
}

/* 旧版 styles.css:773 历史列表两列网格；卡内标题/引用/正文按行数截断。 */
.history-generate-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
  align-items: start;
}

.history-card {
  min-height: 0;
  max-height: 680px;
}

.history-card-top h3 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.history-card-ref {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.history-copy p {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
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
  width: min(920px, 100%);
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

@media (max-width: 1100px) {
  .history-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .history-filter-search {
    grid-column: 1 / -1;
  }
}

@media (max-width: 760px) {
  .history-filters {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px;
  }

  .history-generate-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .history-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .history-filter-search {
    grid-column: auto;
  }

  .history-filters .small-btn {
    width: 100%;
  }
}
</style>
