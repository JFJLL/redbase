<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
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
} from "@/features/brands/api";
import ProfileFormModal from "@/features/brands/components/ProfileFormModal.vue";
import ProfileDeleteModal from "@/features/brands/components/ProfileDeleteModal.vue";
import {
  MATERIAL_KINDS,
  createMaterial,
  deleteMaterial,
  fetchMaterials,
  materialKindLabel,
  updateMaterial,
  type CreatorMaterial,
  type MaterialPayload,
} from "../api";

// Personal-IP tab. Profile cards mirror the legacy renderPersonalIps();
// the material CRUD is rebuilt from bindPersonalMaterialForm() in
// public/app.js plus src/server/api/personal-ip-routes.js.

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

const selectedProfileId = ref<number | null>(null);
const materials = ref<CreatorMaterial[]>([]);
const materialsLoading = ref(false);
const materialsError = ref("");
const materialNotice = ref("");
const materialSubmitting = ref(false);
const editingMaterialId = ref<number | null>(null);
const materialForm = reactive({
  kind: "experience" as string,
  title: "",
  content: "",
  tags: "",
  sourceDate: "",
});

const profiles = computed(() => brands.value.filter((brand) => brand.profileType === "personal"));
const selectedProfile = computed(
  () => profiles.value.find((brand) => Number(brand.id) === Number(selectedProfileId.value)) || null,
);

function handleUnauthorizedError(): void {
  auth.handleUnauthorized();
  router.push({ name: "login" });
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
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

// Legacy behavior: keep the first personal profile selected by default.
watch(
  profiles,
  (list) => {
    if (!list.some((brand) => Number(brand.id) === Number(selectedProfileId.value))) {
      selectedProfileId.value = list[0]?.id ?? null;
    }
  },
  { immediate: true },
);

// 本轮产品决定：个人 IP 页不提供素材库（旧线上未展示）。不自动加载、
// 不渲染管理界面；实现代码保留但不可达，待后续产品需求再开放。
const MATERIAL_LIBRARY_ENABLED = false;

watch(selectedProfileId, (brandId) => {
  materials.value = [];
  materialsError.value = "";
  resetMaterialForm();
  if (MATERIAL_LIBRARY_ENABLED && brandId != null) void loadMaterials(brandId);
});

async function loadMaterials(brandId: number): Promise<void> {
  materialsLoading.value = true;
  materialsError.value = "";
  try {
    const data = await fetchMaterials(brandId, signalFor("materials"));
    materials.value = data.items;
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    materialsError.value = error instanceof Error ? error.message : "素材加载失败";
  } finally {
    materialsLoading.value = false;
  }
}

function resetMaterialForm(): void {
  editingMaterialId.value = null;
  materialForm.kind = "experience";
  materialForm.title = "";
  materialForm.content = "";
  materialForm.tags = "";
  materialForm.sourceDate = "";
}

function startEditMaterial(item: CreatorMaterial): void {
  editingMaterialId.value = item.id;
  materialForm.kind = item.kind || "experience";
  materialForm.title = item.title || "";
  materialForm.content = item.content || "";
  materialForm.tags = Array.isArray(item.tags) ? item.tags.join(",") : "";
  materialForm.sourceDate = item.sourceDate || "";
  materialNotice.value = "";
}

async function submitMaterial(): Promise<void> {
  const brandId = selectedProfileId.value;
  if (brandId == null) return;
  const payload: MaterialPayload = {
    brandId,
    kind: materialForm.kind,
    title: materialForm.title.trim(),
    content: materialForm.content,
    // Legacy: comma separated input → tag array.
    tags: materialForm.tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    sourceDate: materialForm.sourceDate,
  };
  materialSubmitting.value = true;
  materialNotice.value = "";
  try {
    if (editingMaterialId.value != null) {
      await updateMaterial(editingMaterialId.value, payload);
      materialNotice.value = "素材已更新";
    } else {
      await createMaterial(payload);
      materialNotice.value = "素材已添加";
    }
    resetMaterialForm();
    await loadMaterials(brandId);
  } catch (error) {
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    materialNotice.value = `素材保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    materialSubmitting.value = false;
  }
}

async function removeMaterial(item: CreatorMaterial): Promise<void> {
  materialNotice.value = "";
  try {
    await deleteMaterial(item.id);
    materialNotice.value = "素材已删除";
    if (editingMaterialId.value === item.id) resetMaterialForm();
    if (selectedProfileId.value != null) await loadMaterials(selectedProfileId.value);
  } catch (error) {
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    materialNotice.value = `素材删除失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function openCreateProfile(): void {
  editingBrand.value = null;
  actionError.value = "";
  formOpen.value = true;
}

async function openEditProfile(brandId: number): Promise<void> {
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
    actionError.value = `个人 IP 详情加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleSaved(brand: BrandDetail): Promise<void> {
  formOpen.value = false;
  editingBrand.value = null;
  // 个人 IP 新增/编辑成功：使趋势/选题的品牌缓存失效（brandDataVersion）。
  notifyBrandDataChanged(brand?.id);
  await load();
}

function generationCountFor(brandId: number): number {
  return generations.value.filter((item) => Number(item.brandId) === Number(brandId)).length;
}

async function confirmDelete(deleteGenerations: boolean): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  actionError.value = "";
  try {
    await requestDeleteBrand(target.id, deleteGenerations);
    deleteTarget.value = null;
    // 个人 IP 删除成功：同样使品牌缓存失效。
    notifyBrandDataChanged(target.id);
    await load();
  } catch (error) {
    if (isUnauthorized(error)) {
      handleUnauthorizedError();
      return;
    }
    actionError.value = `删除失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    deleting.value = false;
  }
}

function goTrends(brandId: number): void {
  selectedProfileId.value = brandId;
  router.push({ name: "trends", query: { brandId: String(brandId) } });
}

function avatarInitial(name: string): string {
  return String(name || "IP").slice(0, 1).toUpperCase();
}
</script>

<template>
  <section class="tab-panel is-active" data-testid="personal-view">
    <header class="panel-header personal-panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon">☺</span>
          <h1 class="panel-title">个人 IP</h1>
        </div>
        <p class="panel-subtitle">管理人设定位、内容支柱和表达风格，为 AI 建立稳定的个人表达。</p>
      </div>
      <div class="header-actions">
        <button class="primary-btn small-btn" type="button" @click="openCreateProfile">新增个人 IP</button>
      </div>
    </header>

    <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>

    <div class="brand-list personal-profile-list">
      <article v-if="loading" class="brand-card">
        <div class="brand-description">加载中...</div>
      </article>
      <article v-else-if="loadError" class="brand-card">
        <div class="brand-description form-error" role="alert">个人 IP 加载失败：{{ loadError }}</div>
        <div class="brand-actions">
          <button class="secondary-btn" type="button" @click="load">重试</button>
        </div>
      </article>
      <article v-else-if="!profiles.length" class="brand-card">
        <div class="brand-description">你还没有个人 IP 档案。点击右上角“新增个人 IP”，就可以开始趋势分析和内容选题。</div>
      </article>
      <template v-else>
        <article
          v-for="brand in profiles"
          :key="brand.id"
          class="brand-card personal-profile-card"
          :class="{ 'is-selected': Number(brand.id) === Number(selectedProfileId) }"
          data-testid="personal-card"
          @click="selectedProfileId = brand.id"
        >
          <div class="personal-profile-card-head">
            <div class="personal-avatar">
              <img v-if="brand.logo?.url" :src="brand.logo.url" :alt="brand.name" />
              <template v-else>{{ avatarInitial(brand.name) }}</template>
            </div>
            <div>
              <div class="brand-meta">
                <h3>{{ brand.name }}</h3>
                <span class="brand-tag personal-tag">个人 IP</span>
              </div>
              <p class="personal-sub">{{ brand.industry }} · {{ brand.audience }}</p>
            </div>
          </div>
          <div class="brand-description">{{ brand.description }}</div>
          <div v-if="brand.contentPillars.length" class="personal-pillars">
            <span v-for="pillar in brand.contentPillars" :key="pillar">{{ pillar }}</span>
          </div>
          <div v-else class="personal-card-note">尚未设置内容支柱</div>
          <div v-if="brand.personaStyle" class="personal-style"><strong>表达风格：</strong>{{ brand.personaStyle }}</div>
          <div class="personal-profile-stats">
            <span>趋势 {{ Number(brand.trendCount || 0) }} 条</span>
            <span>分析 {{ Number(brand.analysisCount || 0) }} 次</span>
            <span>素材 {{ Number(brand.materialCount || 0) }} 条</span>
          </div>
          <div class="brand-actions">
            <button class="primary-btn small-btn" type="button" @click.stop="goTrends(brand.id)">AI 趋势分析</button>
            <button class="secondary-btn" type="button" @click.stop="openEditProfile(brand.id)">编辑档案</button>
            <button class="secondary-btn danger-btn" type="button" @click.stop="deleteTarget = brand">删除</button>
          </div>
        </article>
      </template>
    </div>

    <section v-if="MATERIAL_LIBRARY_ENABLED && selectedProfile" class="material-section" data-testid="material-section">
      <h2>「{{ selectedProfile.name }}」的个人素材</h2>
      <p class="panel-subtitle">积累亲身经历、案例、观点和金句，AI 生成内容时会引用这些素材。</p>

      <form class="material-form" @submit.prevent="submitMaterial">
        <div class="material-form-row">
          <label>
            <span>素材类型</span>
            <select v-model="materialForm.kind" name="kind">
              <option v-for="kind in MATERIAL_KINDS" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
            </select>
          </label>
          <label>
            <span>标题（可选）</span>
            <input v-model="materialForm.title" name="title" placeholder="给素材起个标题" />
          </label>
          <label>
            <span>发生日期（可选）</span>
            <input v-model="materialForm.sourceDate" name="sourceDate" type="date" />
          </label>
        </div>
        <label>
          <span>素材内容</span>
          <textarea
            v-model="materialForm.content"
            name="content"
            rows="4"
            placeholder="记录具体经历、案例、观点或金句，越具体越好"
            required
          ></textarea>
        </label>
        <label>
          <span>标签（可选，用逗号分隔）</span>
          <input v-model="materialForm.tags" name="tags" placeholder="如：创业,复盘" />
        </label>
        <p v-if="materialNotice" class="material-notice" role="status">{{ materialNotice }}</p>
        <div class="form-actions">
          <button
            v-if="editingMaterialId != null"
            class="secondary-btn"
            type="button"
            :disabled="materialSubmitting"
            @click="resetMaterialForm"
          >
            取消编辑
          </button>
          <button class="primary-btn" type="submit" :disabled="materialSubmitting">
            {{ materialSubmitting ? "提交中..." : editingMaterialId != null ? "保存素材" : "添加素材" }}
          </button>
        </div>
      </form>

      <div class="material-list">
        <p v-if="materialsLoading" class="panel-subtitle">素材加载中...</p>
        <p v-else-if="materialsError" class="form-error" role="alert">{{ materialsError }}</p>
        <p v-else-if="!materials.length" class="panel-subtitle">还没有素材，先在上方添加第一条。</p>
        <article v-for="item in materials" v-else :key="item.id" class="material-card" data-testid="material-card">
          <div class="material-card-head">
            <span class="brand-tag">{{ materialKindLabel(item.kind) }}</span>
            <strong v-if="item.title">{{ item.title }}</strong>
            <span v-if="item.sourceDate" class="material-date">{{ item.sourceDate }}</span>
          </div>
          <div class="material-content">{{ item.content }}</div>
          <div v-if="item.tags.length" class="personal-pillars">
            <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
          </div>
          <div class="brand-actions">
            <button class="secondary-btn" type="button" @click="startEditMaterial(item)">编辑</button>
            <button class="secondary-btn danger-btn" type="button" @click="removeMaterial(item)">删除</button>
          </div>
        </article>
      </div>
    </section>

    <ProfileFormModal
      :open="formOpen"
      profile-type="personal"
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
  gap: 14px;
}

.personal-profile-card {
  cursor: pointer;
}

.personal-profile-card.is-selected {
  border-color: var(--color-brand, #ff2442);
}

.personal-profile-card-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.personal-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  overflow: hidden;
  background: rgba(255, 36, 66, 0.1);
  color: var(--color-brand, #ff2442);
  font-weight: 700;
  flex-shrink: 0;
}

.personal-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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

.personal-sub {
  margin: 6px 0 0;
  color: var(--color-text-secondary, #646a73);
  font-size: 13px;
}

.brand-description {
  color: var(--color-text-secondary, #4a4f58);
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.personal-pillars {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.personal-pillars span {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(31, 34, 43, 0.06);
  font-size: 12px;
}

.personal-card-note {
  color: var(--color-text-secondary, #646a73);
  font-size: 13px;
}

.personal-style {
  font-size: 13px;
  color: var(--color-text-secondary, #4a4f58);
}

.personal-profile-stats {
  display: flex;
  gap: 14px;
  color: var(--color-text-secondary, #646a73);
  font-size: 13px;
}

.brand-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.material-section {
  margin-top: 32px;
  display: grid;
  gap: 16px;
}

.material-section h2 {
  margin: 0;
}

.material-form {
  display: grid;
  gap: 14px;
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 14px;
  padding: 20px;
}

.material-form-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.material-form label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.material-form input,
.material-form select,
.material-form textarea {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 9px 12px;
  font: inherit;
  font-weight: 400;
}

.material-notice {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary, #4a4f58);
}

.material-list {
  display: grid;
  gap: 12px;
}

.material-card {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 12px;
  padding: 16px;
  display: grid;
  gap: 10px;
}

.material-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.material-date {
  color: var(--color-text-secondary, #646a73);
  font-size: 12px;
}

.material-content {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
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

.primary-btn:disabled,
.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-error {
  margin: 0;
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
  gap: 14px;
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

.personal-profile-card {
  transition: border-color 160ms ease, background 160ms ease;
}

.personal-profile-card:hover {
  border-color: rgba(216, 68, 68, 0.22);
}

.personal-profile-card.is-selected {
  border-color: rgba(216, 68, 68, 0.48);
  background: #fffafa;
}

.personal-avatar {
  width: 52px;
  height: 52px;
  border: 1px solid rgba(216, 68, 68, 0.15);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
}

.brand-meta {
  gap: 12px;
  flex-wrap: wrap;
}

.brand-meta h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.35;
}

.brand-tag,
.personal-pillars span {
  padding: 4px 10px;
  border-radius: var(--workspace-radius-sm);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  font-weight: 600;
}

.personal-pillars span {
  background: #f5f1ef;
  color: #5f5357;
  font-weight: 500;
}

.personal-sub,
.brand-description,
.personal-card-note,
.personal-style,
.personal-profile-stats {
  color: var(--workspace-text-muted);
}

.brand-description {
  line-height: 1.7;
}

.personal-profile-stats {
  gap: 0;
  padding-top: 14px;
  border-top: 1px solid var(--workspace-border);
}

.personal-profile-stats span {
  padding: 0 14px;
  border-right: 1px solid var(--workspace-border);
}

.personal-profile-stats span:first-child {
  padding-left: 0;
}

.personal-profile-stats span:last-child {
  border-right: 0;
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

.material-section,
.material-form,
.material-card {
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.material-form input,
.material-form select,
.material-form textarea {
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
}

.form-error {
  color: var(--workspace-danger, #b72e3a);
}
</style>
