<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { notifyBrandDataChanged } from "@/shared/stores/brandDataVersion";
import {
  deleteBrand as requestDeleteBrand,
  fetchBrandDetail,
  fetchBrandSummaries,
  fetchGenerationHistory,
  type BrandDetail,
  type BrandSummary,
  type GenerationRecord,
} from "../api";
import ProfileFormModal from "../components/ProfileFormModal.vue";
import ProfileDeleteModal from "../components/ProfileDeleteModal.vue";

// Brands tab. Ported from the legacy renderBrands()/loadBrands() flow in
// public/app.js — same endpoints, card fields, copy and action buttons.

const router = useRouter();
const auth = useAuthStore();
const { signalFor } = useAbortScope();

const brands = ref<BrandSummary[]>([]);
const generations = ref<GenerationRecord[]>([]);
const loading = ref(false);
const loadError = ref("");
const actionError = ref("");

const formOpen = ref(false);
const editingBrand = ref<BrandDetail | null>(null);

const deleteTarget = ref<BrandSummary | null>(null);
const deleting = ref(false);

const brandCards = computed(() => brands.value.filter((brand) => brand.profileType !== "personal"));

function handleUnauthorizedError(): void {
  auth.handleUnauthorized();
  router.push({ name: "login" });
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    // Legacy loadBrands() fetches summaries and generation history together;
    // the history feeds the delete dialog's generation counter.
    const [brandData, historyData] = await Promise.all([
      fetchBrandSummaries(signalFor("brands")),
      fetchGenerationHistory(signalFor("history")),
    ]);
    brands.value = brandData.brands;
    generations.value = historyData.generations;
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(): void {
  editingBrand.value = null;
  actionError.value = "";
  formOpen.value = true;
}

async function openEdit(brandId: number): Promise<void> {
  actionError.value = "";
  try {
    const data = await fetchBrandDetail(brandId, signalFor("brand-detail"));
    editingBrand.value = data.brand;
    formOpen.value = true;
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    actionError.value = `品牌详情加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleSaved(brand: BrandDetail): Promise<void> {
  formOpen.value = false;
  editingBrand.value = null;
  // 品牌新增/编辑成功：使趋势/选题的品牌缓存失效（brandDataVersion）。
  notifyBrandDataChanged(brand?.id);
  await load();
}

function generationCountFor(brandId: number): number {
  return generations.value.filter((item) => Number(item.brandId) === Number(brandId)).length;
}

function openDelete(brand: BrandSummary): void {
  actionError.value = "";
  deleteTarget.value = brand;
}

async function confirmDelete(deleteGenerations: boolean): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  actionError.value = "";
  try {
    await requestDeleteBrand(target.id, deleteGenerations);
    deleteTarget.value = null;
    // 品牌删除成功：同样使品牌缓存失效。
    notifyBrandDataChanged(target.id);
    await load();
  } catch (error) {
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    actionError.value = `品牌删除失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    deleting.value = false;
  }
}

function goTrends(brandId: number): void {
  // Legacy switched tab with the brand pre-selected; the SPA passes the brand
  // through the route query instead (shared selected-brand store is公共层).
  router.push({ name: "trends", query: { brandId: String(brandId) } });
}
</script>

<template>
  <section class="tab-panel is-active" data-testid="brands-view">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon">⌘</span>
          <h1 class="panel-title">品牌档案</h1>
        </div>
        <p class="panel-subtitle">管理你的品牌信息，为 AI 分析提供输入</p>
      </div>
      <div class="header-actions">
        <button class="primary-btn small-btn" type="button" @click="openCreate">新增品牌</button>
      </div>
    </header>

    <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>

    <div class="brand-list">
      <article v-if="loading" class="brand-card">
        <div class="brand-description">加载中...</div>
      </article>
      <article v-else-if="loadError" class="brand-card">
        <div class="brand-description form-error" role="alert">品牌加载失败：{{ loadError }}</div>
        <div class="brand-actions">
          <button class="secondary-btn" type="button" @click="load">重试</button>
        </div>
      </article>
      <article v-else-if="!brandCards.length" class="brand-card">
        <div class="brand-description">你还没有品牌档案。登录后先新增品牌，就可以开始热点分析和内容选题。</div>
      </article>
      <template v-else>
        <article v-for="brand in brandCards" :key="brand.id" class="brand-card" data-testid="brand-card">
          <div class="brand-card-head">
            <div>
              <div class="brand-meta">
                <h3>{{ brand.name }}</h3>
                <span class="brand-tag">{{ brand.industry }}</span>
              </div>
              <div class="brand-description">
                <strong>目标受众：</strong>{{ brand.audience }}
                <br /><br />
                {{ brand.description }}
              </div>
              <div class="panel-subtitle">趋势 {{ Number(brand.trendCount || 0) }} 条 · 分析 {{ Number(brand.analysisCount || 0) }} 次</div>
            </div>
          </div>
          <div class="brand-actions">
            <button class="primary-btn small-btn" type="button" @click="goTrends(brand.id)">AI趋势分析</button>
            <button class="secondary-btn" type="button" @click="openEdit(brand.id)">编辑</button>
            <button class="secondary-btn danger-btn" type="button" @click="openDelete(brand)">删除</button>
          </div>
        </article>
      </template>
    </div>

    <ProfileFormModal
      :open="formOpen"
      profile-type="brand"
      :brand="editingBrand"
      @close="formOpen = false"
      @saved="handleSaved"
    />
    <ProfileDeleteModal
      :open="Boolean(deleteTarget)"
      :brand-name="deleteTarget?.name || ''"
      :generation-count="deleteTarget ? generationCountFor(deleteTarget.id) : 0"
      :deleting="deleting"
      @close="deleteTarget = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 24px;
}

.panel-icon-title {
  display: flex;
  align-items: center;
  gap: 14px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: rgba(255, 36, 66, 0.1);
  color: var(--color-brand, #ff2442);
  font-size: 1.2rem;
}

.panel-title {
  margin: 0;
  font-size: 1.5rem;
}

.panel-subtitle {
  margin: 8px 0 0;
  color: var(--color-text-secondary, #646a73);
  font-size: 14px;
}

.brand-list {
  display: grid;
  gap: 18px;
}

.brand-card {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 14px;
  padding: 22px;
  background: var(--color-surface, #fff);
  display: grid;
  gap: 16px;
}

.brand-meta {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-meta h3 {
  margin: 0;
}

.brand-tag {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(255, 36, 66, 0.1);
  color: var(--color-brand, #ff2442);
  font-size: 12px;
}

.brand-description {
  margin-top: 12px;
  color: var(--color-text-secondary, #4a4f58);
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.brand-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.primary-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 16px;
  background: var(--color-brand, #ff2442);
  color: #fff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.secondary-btn {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 8px 16px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.danger-btn {
  color: #d64545;
  border-color: rgba(214, 69, 69, 0.4);
}

.form-error {
  margin: 0 0 16px;
  color: #d64545;
  font-size: 13px;
  white-space: pre-wrap;
}

/* Legacy light-workspace parity: final effective values from 0edaf1b. */
.tab-panel {
  color: var(--workspace-text);
}

.panel-header {
  gap: 18px;
  margin-bottom: 28px;
}

.panel-icon-title {
  gap: 14px;
}

.panel-icon {
  width: auto;
  height: auto;
  border-radius: 0;
  background: transparent;
  color: var(--workspace-brand);
  font-size: 1.8rem;
}

.panel-title {
  color: var(--workspace-text);
  font-size: 2.1rem;
  line-height: 1.2;
}

.panel-subtitle {
  margin-top: 10px;
  color: var(--workspace-text-muted);
  font-size: 0.98rem;
  line-height: 1.6;
}

.brand-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
}

.brand-list > .brand-card:only-child {
  grid-column: 1 / -1;
}

.brand-card {
  position: relative;
  overflow: hidden;
  gap: 16px;
  padding: 22px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.brand-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.brand-meta {
  gap: 14px;
  flex-wrap: wrap;
}

.brand-meta h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.35;
}

.brand-tag {
  padding: 4px 10px;
  border-radius: var(--workspace-radius-sm);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-weight: 600;
}

.brand-description {
  color: var(--workspace-text-muted);
  line-height: 1.7;
}

.brand-actions {
  gap: 14px;
  align-items: center;
  margin-top: auto;
}

.primary-btn,
.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.92rem;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
}

.primary-btn {
  background: var(--workspace-brand);
  color: #fff;
}

.primary-btn:hover {
  background: var(--workspace-brand-hover);
}

.secondary-btn {
  border-color: var(--workspace-border);
  background: #fff;
  color: var(--workspace-text);
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.danger-btn {
  border-color: rgba(198, 44, 54, 0.18);
  background: rgba(255, 250, 250, 0.92);
  color: #b72e3a;
}

.danger-btn:hover {
  border-color: rgba(198, 44, 54, 0.34);
  background: rgba(255, 242, 242, 0.98);
}

.form-error {
  margin-bottom: 16px;
  color: var(--workspace-danger, #b72e3a);
}
</style>
