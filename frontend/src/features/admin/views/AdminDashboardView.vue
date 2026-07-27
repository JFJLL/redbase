<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import {
  addUserCredits,
  deleteAdminGeneration,
  deleteAdminUser,
  fetchAdminOverview,
  fetchSession,
  formatDate,
  formatNumber,
  type AdminGenerationRow,
  type AdminOverview,
  type AdminUserRow,
} from "../api";

// 管理后台：统计、用户表、品牌档案、额度流水、生成内容与积分调整。
// 语义与 public/admin.js 一致；401 视为会话失效，回到工作台登录页。
const auth = useAuthStore();
const scope = useAbortScope();

const overview = ref<AdminOverview | null>(null);
const currentAdmin = ref<{ id?: number | string; name?: string } | null>(null);
const loadError = ref("");
const loading = ref(false);

const brandUserId = ref("all");
const usageUserId = ref("all");
const generationUserId = ref("all");
const userSearchQuery = ref("");
const creditUserSearchQuery = ref("");
const selectedCreditUserId = ref("");
const creditUserPickerOpen = ref(false);
const creditAmount = ref("");
const creditNote = ref("");
const generationModalItem = ref<AdminGenerationRow | null>(null);

function normalizeSearchText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function compactSearchText(value: unknown): string {
  return String(value || "").replace(/\s+/g, "");
}

function matchesUserQuery(user: AdminUserRow, rawQuery: string): boolean {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;
  const compactQuery = compactSearchText(query);
  const fields = [user.name, user.phone].map(normalizeSearchText);
  const compactFields = fields.map(compactSearchText);
  return fields.some((field) => field.includes(query)) || compactFields.some((field) => field.includes(compactQuery));
}

const users = computed(() => overview.value?.users || []);
const visibleUsers = computed(() => users.value.filter((user) => matchesUserQuery(user, userSearchQuery.value)));
const creditUserMatches = computed(() => {
  const query = normalizeSearchText(creditUserSearchQuery.value);
  if (!query) return users.value;
  return users.value.filter((user) => matchesUserQuery(user, creditUserSearchQuery.value));
});
const selectedCreditUser = computed(
  () => users.value.find((user) => String(user.id) === String(selectedCreditUserId.value)) || null,
);

const statsCards = computed(() => {
  const stats = overview.value?.stats || {};
  return [
    ["用户数", stats.userCount],
    ["品牌数", stats.brandCount],
    ["生成次数", stats.generationCount],
    ["总消耗使用额度", stats.totalConsumedTokens],
    ["当前总额度", stats.currentCreditsTotal],
  ] as const;
});

const visibleBrands = computed(() => {
  const brands = overview.value?.brands || [];
  if (brandUserId.value === "all") return brands;
  return brands.filter((brand) => String(brand.ownerUserId) === String(brandUserId.value));
});

const visibleUsageEvents = computed(() => {
  const events = overview.value?.usageEvents || [];
  if (usageUserId.value === "all") return events;
  return events.filter((event) => String(event.userId) === String(usageUserId.value));
});

const visibleGenerations = computed(() => {
  const generations = overview.value?.generations || [];
  if (generationUserId.value === "all") return generations;
  return generations.filter((generation) => String(generation.user?.id) === String(generationUserId.value));
});

function accountTypeLabel(user: AdminUserRow): string {
  return user.accountType === "yimei" ? "易美" : "客户";
}

function getGenerationPreview(item: AdminGenerationRow): string {
  if (item.previewUrl) return item.previewUrl;
  const slides = Array.isArray((item.payload as { slides?: Array<Record<string, unknown>> })?.slides)
    ? ((item.payload as { slides?: Array<Record<string, unknown>> }).slides as Array<Record<string, unknown>>)
    : [];
  return String(slides[0]?.previewUrl || slides[0]?.imageUrl || "");
}

function handleSessionInvalid(): void {
  auth.handleUnauthorized();
  window.location.href = "/app/login";
}

async function loadOverview() {
  loading.value = true;
  try {
    const [session, data] = await Promise.all([
      fetchSession(scope.signalFor("session")),
      fetchAdminOverview(scope.signalFor("overview")),
    ]);
    currentAdmin.value = session.user;
    overview.value = data;
    loadError.value = "";
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleSessionInvalid();
      return;
    }
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function removeUser(userId: number) {
  const user = users.value.find((item) => item.id === userId);
  if (!user) return;
  if (String(currentAdmin.value?.id) === String(userId)) {
    alert("不能删除当前登录的管理员账号。");
    return;
  }
  const message = [
    `确定删除用户「${user.name}」吗？`,
    `手机号：${user.phone}`,
    `这会删除该用户的品牌档案、生成记录、额度流水、登录状态和已上传产品图文件。`,
    `当前额度 ${formatNumber(user.currentCredits)}，生成次数 ${formatNumber(user.generationCount)}，品牌数 ${formatNumber(user.brandCount)}。`,
  ].join("\n");
  if (!confirm(message)) return;
  try {
    const result = await deleteAdminUser(userId, scope.signalFor(`delete-user-${userId}`));
    overview.value = result.overview;
    if (brandUserId.value === String(userId)) brandUserId.value = "all";
    if (usageUserId.value === String(userId)) usageUserId.value = "all";
    if (generationUserId.value === String(userId)) generationUserId.value = "all";
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleSessionInvalid();
      return;
    }
    alert((error as Error).message);
  }
}

async function removeGeneration(generationId: number) {
  const item = (overview.value?.generations || []).find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  const message = [
    `确定删除「${item.cardTitle || item.ideaTitle || "这条生成内容"}」吗？`,
    `用户：${item.user?.name || "-"} ${item.user?.phone || ""}`,
    "对应数据库记录和图片文件会一起删除，额度流水会保留但不再包含生成内容详情。",
  ].join("\n");
  if (!confirm(message)) return;
  try {
    const result = await deleteAdminGeneration(generationId, scope.signalFor(`delete-generation-${generationId}`));
    overview.value = result.overview;
    generationModalItem.value = null;
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleSessionInvalid();
      return;
    }
    alert(`删除失败：${(error as Error).message}`);
  }
}

function selectCreditUser(userId: number | string) {
  selectedCreditUserId.value = String(userId);
  const user = users.value.find((item) => String(item.id) === String(userId));
  creditUserSearchQuery.value = user ? `${user.name || "-"} · ${user.phone || ""}` : "";
  creditUserPickerOpen.value = false;
}

function onCreditSearchInput() {
  selectedCreditUserId.value = "";
  creditUserPickerOpen.value = true;
}

function onCreditSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    creditUserPickerOpen.value = false;
    return;
  }
  if (event.key === "Enter" && creditUserPickerOpen.value) {
    const firstUser = creditUserMatches.value[0];
    if (firstUser) {
      event.preventDefault();
      selectCreditUser(firstUser.id);
    }
  }
}

async function submitCreditForm() {
  if (!selectedCreditUserId.value) {
    alert("请先搜索并选择要加额度的用户。");
    return;
  }
  try {
    const result = await addUserCredits(
      selectedCreditUserId.value,
      // Old admin.js submitted FormData, so amount travels as a string.
      { amount: String(creditAmount.value), note: creditNote.value },
      scope.signalFor("credit-adjust"),
    );
    overview.value = result.overview;
    creditAmount.value = "";
    creditNote.value = "";
    selectedCreditUserId.value = "";
    creditUserSearchQuery.value = "";
    creditUserPickerOpen.value = false;
  } catch (error) {
    if (isAbortError(error)) return;
    if (isUnauthorized(error)) {
      handleSessionInvalid();
      return;
    }
    alert((error as Error).message);
  }
}

async function handleLogout() {
  try {
    await auth.logout();
  } catch {
    // 与旧版一致：登出请求失败也清理本地会话。
  }
  window.location.href = "/app/login";
}

onMounted(() => {
  loadOverview();
});
</script>

<template>
  <div class="admin-dashboard">
    <header class="admin-header">
      <div>
        <h1>RedBase 管理后台</h1>
        <p class="admin-subtitle">{{ currentAdmin?.name || "管理员" }}</p>
      </div>
      <div class="admin-header-actions">
        <button type="button" class="secondary-btn" :disabled="loading" @click="loadOverview">刷新数据</button>
        <button type="button" class="secondary-btn" @click="handleLogout">退出登录</button>
      </div>
    </header>

    <p v-if="loadError" class="admin-error" data-test="admin-error">{{ loadError }}</p>

    <template v-if="overview">
      <section class="admin-stats" data-test="admin-stats">
        <article v-for="[label, value] in statsCards" :key="label" class="stat-card">
          <div class="stat-label">{{ label }}</div>
          <div class="stat-value">{{ formatNumber(value) }}</div>
        </article>
      </section>

      <section class="admin-panel">
        <header class="panel-header">
          <h2>积分调整</h2>
        </header>
        <form class="credit-form" data-test="credit-form" @submit.prevent="submitCreditForm">
          <div class="credit-user-picker">
            <input
              v-model="creditUserSearchQuery"
              type="text"
              placeholder="搜索用户姓名或手机号"
              data-test="credit-user-search"
              @input="onCreditSearchInput"
              @focus="creditUserPickerOpen = true"
              @keydown="onCreditSearchKeydown"
            />
            <ul v-if="creditUserPickerOpen && creditUserMatches.length" class="credit-user-options">
              <li v-for="user in creditUserMatches" :key="user.id">
                <button type="button" :data-credit-user-id="user.id" @click="selectCreditUser(user.id)">
                  {{ user.name || "-" }} · {{ user.phone || "" }}
                </button>
              </li>
            </ul>
          </div>
          <input
            v-model="creditAmount"
            type="number"
            min="1"
            placeholder="加额度数量"
            data-test="credit-amount"
            required
          />
          <input v-model="creditNote" type="text" placeholder="备注（可选）" data-test="credit-note" />
          <button type="submit" class="primary-btn">加额度</button>
          <span v-if="selectedCreditUser" class="credit-selected">
            已选择：{{ selectedCreditUser.name }} · {{ selectedCreditUser.phone }}
          </span>
        </form>
      </section>

      <section class="admin-panel">
        <header class="panel-header">
          <h2>用户列表</h2>
          <div class="panel-tools">
            <input
              v-model="userSearchQuery"
              type="search"
              placeholder="搜索姓名或手机号"
              data-test="user-search"
            />
            <span v-if="normalizeSearchText(userSearchQuery)" class="panel-summary">
              {{ formatNumber(visibleUsers.length) }} / {{ formatNumber(users.length) }}
            </span>
          </div>
        </header>
        <table class="admin-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>类型</th>
              <th>当前额度</th>
              <th>已消耗</th>
              <th>已发放</th>
              <th>生成次数</th>
              <th>品牌数</th>
              <th>最近活跃</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody data-test="admin-user-rows">
            <tr v-for="user in visibleUsers" :key="user.id" data-test="admin-user-row">
              <td>
                <div class="strong">{{ user.name }}</div>
                <div class="muted">{{ user.phone }}</div>
              </td>
              <td>
                <span class="badge">{{ accountTypeLabel(user) }}</span>
                <div v-if="user.department" class="muted">{{ user.department }}</div>
              </td>
              <td class="strong">{{ formatNumber(user.currentCredits) }}</td>
              <td class="token-negative">{{ formatNumber(user.consumedTokens) }}</td>
              <td class="token-positive">{{ formatNumber(user.grantedTokens) }}</td>
              <td>{{ formatNumber(user.generationCount) }}</td>
              <td>{{ formatNumber(user.brandCount) }}</td>
              <td>{{ formatDate(user.lastActiveAt || user.createdAt) }}</td>
              <td>
                <button type="button" class="danger-btn" data-test="delete-user" @click="removeUser(user.id)">删除</button>
              </td>
            </tr>
            <tr v-if="!visibleUsers.length">
              <td colspan="9" class="muted">没有匹配的用户。</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="admin-panel">
        <header class="panel-header">
          <h2>品牌档案</h2>
          <select v-model="brandUserId">
            <option value="all">全部用户</option>
            <option v-for="user in users" :key="user.id" :value="String(user.id)">
              {{ user.name }} · {{ user.phone }}
            </option>
          </select>
        </header>
        <div class="brand-list">
          <article v-for="brand in visibleBrands" :key="brand.id" class="brand-card">
            <h3>{{ brand.name }}</h3>
            <p class="muted">{{ brand.industry }} · {{ brand.audience }}</p>
            <p v-if="brand.description" class="brand-description">{{ brand.description }}</p>
            <p class="muted">
              所属：{{ brand.user?.name || "-" }} {{ brand.user?.phone || "" }} · 分析 {{ formatNumber(brand.analysisCount) }} 次 ·
              趋势 {{ formatNumber(brand.trendCount) }} 条 · {{ formatDate(brand.createdAt) }}
            </p>
          </article>
          <p v-if="!visibleBrands.length" class="muted">暂无品牌档案。</p>
        </div>
      </section>

      <section class="admin-panel">
        <header class="panel-header">
          <h2>额度流水</h2>
          <select v-model="usageUserId">
            <option value="all">全部用户</option>
            <option v-for="user in users" :key="user.id" :value="String(user.id)">
              {{ user.name }} · {{ user.phone }}
            </option>
          </select>
        </header>
        <table class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>动作</th>
              <th>额度变化</th>
              <th>关联内容</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in visibleUsageEvents" :key="event.id">
              <td>{{ formatDate(event.createdAt) }}</td>
              <td>
                <div class="strong">{{ event.userName || "-" }}</div>
                <div class="muted">{{ event.userPhone || "" }}</div>
              </td>
              <td>
                {{ event.actionLabel || event.actionType }}
                <div v-if="event.adminUserName" class="muted">操作人：{{ event.adminUserName }}</div>
              </td>
              <td :class="Number(event.tokenDelta || 0) < 0 ? 'token-negative' : 'token-positive'">
                {{ formatNumber(event.tokenDelta) }}
              </td>
              <td class="muted">{{ event.brandName || "" }} {{ event.ideaTitle || event.summary || "" }}</td>
            </tr>
            <tr v-if="!visibleUsageEvents.length">
              <td colspan="5" class="muted">暂无额度流水。</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="admin-panel">
        <header class="panel-header">
          <h2>生成内容</h2>
          <select v-model="generationUserId">
            <option value="all">全部用户</option>
            <option v-for="user in users" :key="user.id" :value="String(user.id)">
              {{ user.name }} · {{ user.phone }}
            </option>
          </select>
        </header>
        <div class="generation-list">
          <article v-for="item in visibleGenerations" :key="item.id" class="generation-card">
            <img v-if="getGenerationPreview(item)" :src="getGenerationPreview(item)" alt="" loading="lazy" decoding="async" />
            <div class="generation-card-body">
              <h3>{{ item.cardTitle || item.ideaTitle || "生成内容" }}</h3>
              <p class="muted">
                {{ item.user?.name || "-" }} {{ item.user?.phone || "" }} · {{ item.channelLabel || item.type }} ·
                {{ formatDate(item.createdAt) }} · 消耗 {{ formatNumber(item.tokenCost) }}
              </p>
              <div class="generation-card-actions">
                <button type="button" class="secondary-btn" @click="generationModalItem = item">详情</button>
                <button type="button" class="danger-btn" @click="removeGeneration(item.id)">删除</button>
              </div>
            </div>
          </article>
          <p v-if="!visibleGenerations.length" class="muted">暂无生成内容。</p>
        </div>
      </section>
    </template>

    <div v-if="generationModalItem" class="admin-modal" @click.self="generationModalItem = null">
      <div class="admin-modal-body">
        <header class="admin-modal-header">
          <h3>{{ generationModalItem.cardTitle || generationModalItem.ideaTitle || "生成内容详情" }}</h3>
          <button type="button" class="secondary-btn" @click="generationModalItem = null">关闭</button>
        </header>
        <p class="muted">
          {{ generationModalItem.user?.name || "-" }} {{ generationModalItem.user?.phone || "" }} ·
          {{ generationModalItem.channelLabel || generationModalItem.type }} · {{ formatDate(generationModalItem.createdAt) }}
        </p>
        <p v-if="generationModalItem.brandName" class="muted">品牌：{{ generationModalItem.brandName }}</p>
        <p v-if="generationModalItem.trendTitle" class="muted">选题：{{ generationModalItem.trendTitle }}</p>
        <p v-if="generationModalItem.summary">{{ generationModalItem.summary }}</p>
        <img
          v-if="getGenerationPreview(generationModalItem)"
          :src="getGenerationPreview(generationModalItem)"
          alt=""
          class="admin-modal-image"
        />
        <button type="button" class="danger-btn" @click="removeGeneration(generationModalItem.id)">删除这条生成内容</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-dashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.admin-header h1 {
  margin: 0;
  font-size: 22px;
}

.admin-subtitle {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.admin-header-actions {
  display: flex;
  gap: 8px;
}

.admin-error {
  color: var(--color-brand);
  font-size: 14px;
}

.admin-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.stat-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px;
  background: var(--color-surface);
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  margin-top: 4px;
}

.admin-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.panel-header h2 {
  margin: 0;
  font-size: 16px;
}

.panel-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-summary {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.admin-table th,
.admin-table td {
  border-bottom: 1px solid var(--color-border);
  padding: 8px;
  text-align: left;
  vertical-align: top;
}

.strong {
  font-weight: 600;
}

.muted {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.badge {
  display: inline-block;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
}

.token-negative {
  color: #c0392b;
}

.token-positive {
  color: #1e824c;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.danger-btn {
  border: 1px solid #c0392b;
  color: #c0392b;
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.primary-btn {
  background: var(--color-brand);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.credit-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}

.credit-form input,
.panel-tools input,
.panel-header select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 13px;
}

.credit-user-picker {
  position: relative;
}

.credit-user-options {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  margin: 4px 0 0;
  padding: 4px;
  list-style: none;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  max-height: 220px;
  overflow: auto;
}

.credit-user-options button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
}

.credit-user-options button:hover {
  background: var(--color-bg);
}

.credit-selected {
  font-size: 12px;
  color: var(--color-text-secondary);
  align-self: center;
}

.brand-list,
.generation-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.brand-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.brand-card h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.brand-description {
  font-size: 13px;
  margin: 4px 0;
}

.generation-card {
  display: flex;
  gap: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.generation-card img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.generation-card-body h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.generation-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.admin-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.admin-modal-body {
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

.admin-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.admin-modal-header h3 {
  margin: 0;
  font-size: 16px;
}

.admin-modal-image {
  max-width: 100%;
  border-radius: var(--radius-md);
}
</style>
