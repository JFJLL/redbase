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
  type AdminBrandRow,
  type AdminGenerationRow,
  type AdminOverview,
  type AdminUserRow,
} from "../api";

// 管理后台：统计、用户表、品牌档案、额度流水、生成内容与积分调整。
// 语义与 public/admin.js 一致；401 视为会话失效，回到工作台登录页。
const auth = useAuthStore();
const scope = useAbortScope();

const LOGO_SRC = "/assets/redbase-logo.png";

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
const brandModalItem = ref<AdminBrandRow | null>(null);

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

function scrollToSection(sectionId: string): void {
  document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

onMounted(() => {
  loadOverview();
});
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div>
        <img class="admin-logo" :src="LOGO_SRC" alt="RedBase" />
        <nav class="admin-nav">
          <a href="#overview" @click.prevent="scrollToSection('overview')">总览</a>
          <a href="#users" @click.prevent="scrollToSection('users')">用户管理</a>
          <a href="#brands" @click.prevent="scrollToSection('brands')">品牌档案</a>
          <a href="#generations" @click.prevent="scrollToSection('generations')">生成内容</a>
          <a href="#usage" @click.prevent="scrollToSection('usage')">消耗流水</a>
        </nav>
      </div>
      <div class="admin-user-box">
        <div id="adminUserName">{{ currentAdmin?.name || "管理员" }}</div>
        <button class="ghost-btn" type="button" @click="handleLogout">退出后台</button>
      </div>
    </aside>

    <main class="admin-main">
      <header class="admin-topbar" id="overview">
        <div>
          <h1>RedBase 管理后台</h1>
          <p>集中查看用户额度、使用额度消耗和内容生成记录。</p>
        </div>
        <button type="button" class="secondary-btn" :disabled="loading" @click="loadOverview">刷新数据</button>
      </header>

      <p v-if="loadError" class="admin-error" data-test="admin-error">{{ loadError }}</p>

      <template v-if="overview">
        <section class="stats-grid" id="adminStats" data-test="admin-stats">
          <article v-for="[label, value] in statsCards" :key="label" class="stat-card">
            <div class="stat-label">{{ label }}</div>
            <div class="stat-value">{{ formatNumber(value) }}</div>
          </article>
        </section>

        <section class="admin-panel" id="users">
          <div class="panel-head">
            <div>
              <h2>用户管理</h2>
              <p>查看每个用户当前额度、总消耗使用额度、生成次数，并手动加额度。</p>
            </div>
            <div class="panel-actions">
              <input
                v-model="userSearchQuery"
                class="compact-search"
                type="search"
                placeholder="搜索手机号或昵称"
                autocomplete="off"
                aria-label="搜索手机号或昵称"
                data-test="user-search"
              />
              <span v-if="normalizeSearchText(userSearchQuery)" class="search-result-pill">
                {{ formatNumber(visibleUsers.length) }} / {{ formatNumber(users.length) }}
              </span>
            </div>
          </div>

          <form class="credit-form" data-test="credit-form" @submit.prevent="submitCreditForm">
            <div class="credit-user-field">
              <label class="field-label" for="creditUserSearchInput">搜索用户</label>
              <div class="user-picker">
                <input
                  id="creditUserSearchInput"
                  v-model="creditUserSearchQuery"
                  type="search"
                  placeholder="输入手机号或昵称"
                  autocomplete="off"
                  aria-controls="creditUserOptions"
                  aria-expanded="false"
                  data-test="credit-user-search"
                  @input="onCreditSearchInput"
                  @focus="creditUserPickerOpen = true"
                  @keydown="onCreditSearchKeydown"
                />
                <div
                  v-if="creditUserPickerOpen && creditUserMatches.length"
                  class="user-picker-options"
                  id="creditUserOptions"
                >
                  <button
                    v-for="user in creditUserMatches"
                    :key="user.id"
                    type="button"
                    class="user-picker-option"
                    :data-credit-user-id="user.id"
                    @click="selectCreditUser(user.id)"
                  >
                    <strong>{{ user.name || "-" }}</strong>
                    <span>{{ user.phone || "" }}</span>
                  </button>
                </div>
                <div v-if="selectedCreditUser" class="user-picker-selected" id="creditUserSelected">
                  {{ selectedCreditUser.name }} · {{ selectedCreditUser.phone }}
                </div>
              </div>
            </div>
            <label>
              <span>增加额度</span>
              <input
                v-model="creditAmount"
                type="number"
                min="1"
                step="1"
                placeholder="例如 100"
                data-test="credit-amount"
                required
              />
            </label>
            <label>
              <span>备注</span>
              <input v-model="creditNote" placeholder="例如：线下充值 / 活动赠送" data-test="credit-note" />
            </label>
            <button class="primary-btn" type="submit">确认加额度</button>
          </form>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>账号类型</th>
                  <th>当前额度</th>
                  <th>总消耗使用额度</th>
                  <th>已加额度</th>
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
                    <button type="button" class="danger-btn small-action" data-test="delete-user" @click="removeUser(user.id)">
                      删除
                    </button>
                  </td>
                </tr>
                <tr v-if="!visibleUsers.length">
                  <td colspan="9" class="muted">没有匹配的用户。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="admin-panel" id="brands">
          <div class="panel-head">
            <div>
              <h2>品牌档案</h2>
              <p>品牌以卡片形式展示，点击「详情」查看完整档案内容。</p>
            </div>
            <select v-model="brandUserId" class="compact-select">
              <option value="all">全部用户</option>
              <option v-for="user in users" :key="user.id" :value="String(user.id)">
                {{ user.name }} · {{ user.phone }}
              </option>
            </select>
          </div>
          <div class="brand-grid">
            <article
              v-for="brand in visibleBrands"
              :key="brand.id"
              class="brand-card"
              @click="brandModalItem = brand"
            >
              <div class="brand-card-name">{{ brand.name || "-" }}</div>
              <div class="brand-card-owner">
                所属用户：{{ brand.user?.name || "-" }} {{ brand.user?.phone || "" }}
              </div>
              <div class="brand-card-meta">
                <span class="badge">分析 {{ formatNumber(brand.analysisCount) }} 次</span>
                <span class="badge">趋势 {{ formatNumber(brand.trendCount) }} 条</span>
              </div>
              <button type="button" class="secondary-btn small-action brand-detail-btn" @click.stop="brandModalItem = brand">
                详情
              </button>
            </article>
            <p v-if="!visibleBrands.length" class="muted">暂无品牌档案。</p>
          </div>
        </section>

        <section class="admin-panel" id="generations">
          <div class="panel-head">
            <div>
              <h2>生成内容</h2>
              <p>查看每个用户生成了什么内容、对应品牌趋势和每次生成消耗。</p>
            </div>
            <select v-model="generationUserId" class="compact-select">
              <option value="all">全部用户</option>
              <option v-for="user in users" :key="user.id" :value="String(user.id)">
                {{ user.name }} · {{ user.phone }}
              </option>
            </select>
          </div>
          <div class="generation-list">
            <article v-for="item in visibleGenerations" :key="item.id" class="generation-card">
              <div class="generation-preview">
                <img v-if="getGenerationPreview(item)" :src="getGenerationPreview(item)" alt="" loading="lazy" decoding="async" />
              </div>
              <div class="generation-card-body">
                <h3 class="generation-title">{{ item.cardTitle || item.ideaTitle || "生成内容" }}</h3>
                <p class="generation-meta">
                  <span class="badge">{{ item.channelLabel || item.type }}</span>
                  <span class="muted">{{ item.user?.name || "-" }} {{ item.user?.phone || "" }}</span>
                  <span class="muted">{{ formatDate(item.createdAt) }} · 消耗 {{ formatNumber(item.tokenCost) }}</span>
                </p>
                <div class="generation-actions">
                  <button type="button" class="secondary-btn small-action" @click="generationModalItem = item">详情</button>
                  <button type="button" class="danger-btn small-action" @click="removeGeneration(item.id)">删除</button>
                </div>
              </div>
            </article>
            <p v-if="!visibleGenerations.length" class="muted">暂无生成内容。</p>
          </div>
        </section>

        <section class="admin-panel" id="usage">
          <div class="panel-head">
            <div>
              <h2>消耗流水</h2>
              <p>记录每一次扣额度和管理员加额度操作。</p>
            </div>
            <select v-model="usageUserId" class="compact-select">
              <option value="all">全部用户</option>
              <option v-for="user in users" :key="user.id" :value="String(user.id)">
                {{ user.name }} · {{ user.phone }}
              </option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户</th>
                  <th>动作</th>
                  <th>使用额度</th>
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
          </div>
        </section>
      </template>
    </main>

    <div v-if="generationModalItem" class="modal-mask is-open" @click.self="generationModalItem = null">
      <div class="modal-panel">
        <div class="modal-head">
          <div>
            <div class="modal-kicker">生成内容详情</div>
            <h2>{{ generationModalItem.cardTitle || generationModalItem.ideaTitle || "内容详情" }}</h2>
          </div>
          <button class="modal-close" type="button" @click="generationModalItem = null">×</button>
        </div>
        <div class="detail-grid">
          <div class="detail-block">
            <h3>基本信息</h3>
            <p>
              {{ generationModalItem.user?.name || "-" }} {{ generationModalItem.user?.phone || "" }} ·
              {{ generationModalItem.channelLabel || generationModalItem.type }} ·
              {{ formatDate(generationModalItem.createdAt) }}
            </p>
            <p v-if="generationModalItem.brandName">品牌：{{ generationModalItem.brandName }}</p>
            <p v-if="generationModalItem.trendTitle">选题：{{ generationModalItem.trendTitle }}</p>
            <p v-if="generationModalItem.summary">{{ generationModalItem.summary }}</p>
          </div>
          <div v-if="getGenerationPreview(generationModalItem)" class="detail-block">
            <h3>预览</h3>
            <img :src="getGenerationPreview(generationModalItem)" alt="" class="detail-main-image" />
          </div>
        </div>
        <div class="generation-actions">
          <button type="button" class="danger-btn" @click="removeGeneration(generationModalItem.id)">删除这条生成内容</button>
        </div>
      </div>
    </div>

    <div v-if="brandModalItem" class="modal-mask is-open" @click.self="brandModalItem = null">
      <div class="modal-panel brand-modal-panel">
        <div class="modal-head">
          <div>
            <div class="modal-kicker">品牌档案详情</div>
            <h2>{{ brandModalItem.name || "品牌详情" }}</h2>
          </div>
          <button class="modal-close" type="button" @click="brandModalItem = null">×</button>
        </div>
        <div class="brand-modal-meta">
          <p v-if="brandModalItem.industry" class="muted">行业：{{ brandModalItem.industry }}</p>
          <p v-if="brandModalItem.audience" class="muted">受众：{{ brandModalItem.audience }}</p>
          <p class="muted">
            所属用户：{{ brandModalItem.user?.name || "-" }} {{ brandModalItem.user?.phone || "" }} ·
            {{ formatDate(brandModalItem.createdAt) }}
          </p>
          <p v-if="brandModalItem.hasLogo" class="muted">Logo：{{ brandModalItem.logoName || "已上传" }}</p>
          <div v-if="brandModalItem.assetTags?.length" class="brand-modal-tags">
            <span v-for="tag in brandModalItem.assetTags" :key="tag" class="badge">{{ tag }}</span>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-block">
            <h3>品牌介绍</h3>
            <p>{{ brandModalItem.description || "-" }}</p>
          </div>
          <div class="detail-block">
            <h3>产品介绍</h3>
            <p>{{ brandModalItem.product || "-" }}</p>
          </div>
          <div class="detail-block">
            <h3>运营目标</h3>
            <p>{{ brandModalItem.goal || "-" }}</p>
          </div>
          <div class="detail-block">
            <h3>品牌资料库</h3>
            <p>{{ brandModalItem.knowledgeBase || "-" }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>


<style scoped>
/* 管理后台：与旧版 legacy 界面一致的左侧栏布局。 */
.admin-shell {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 100vh;
}

.admin-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 26px 18px;
  border-right: 1px solid var(--color-border);
  background: #fbf8f6;
}

.admin-logo {
  display: block;
  width: 218px;
  height: auto;
  margin-bottom: 22px;
}

.admin-nav {
  display: grid;
  gap: 6px;
}

.admin-nav a {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 4px;
  color: #4b4244;
  text-decoration: none;
  font-weight: 800;
}

.admin-nav a:hover {
  background: #f6e4df;
  color: #b63b3b;
}

.admin-user-box {
  display: grid;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.admin-main {
  min-width: 0;
  padding: 34px 34px 56px;
}

.admin-topbar,
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.admin-topbar h1 {
  margin: 0;
  font-size: 2.1rem;
  letter-spacing: -0.04em;
}

.admin-topbar p,
.panel-head p {
  margin: 8px 0 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.admin-error {
  color: var(--color-brand);
  font-size: 14px;
}

/* 与旧版 legacy admin 一致的按钮基础样式。 */
.primary-btn,
.secondary-btn,
.ghost-btn,
.danger-btn {
  min-height: 42px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0 16px;
  font-weight: 800;
  font-family: inherit;
  cursor: pointer;
}

.primary-btn {
  background: #d84444;
  color: #fff;
}

.primary-btn:hover:not(:disabled) {
  background: #c63b3b;
}

.secondary-btn,
.ghost-btn {
  background: #fff;
  color: #151112;
  border-color: rgba(24, 18, 18, 0.1);
}

.secondary-btn:hover:not(:disabled),
.ghost-btn:hover:not(:disabled) {
  border-color: rgba(24, 18, 18, 0.22);
  background: var(--color-bg);
}

.ghost-btn {
  width: 100%;
}

.danger-btn {
  background: #fff;
  color: #b63838;
  border-color: rgba(216, 68, 68, 0.24);
}

.danger-btn:hover:not(:disabled) {
  background: #fff0ee;
  border-color: rgba(216, 68, 68, 0.42);
}

.small-action {
  min-height: 34px;
  padding: 0 12px;
  white-space: nowrap;
}

/* 与旧版 legacy admin 一致的输入控件基础样式。 */
.credit-form input,
.credit-form select,
.panel-actions input,
.panel-header select,
.compact-select {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: #fff;
  color: var(--color-text);
  padding: 0 12px;
  outline: none;
  font-size: 0.9rem;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.credit-form input::placeholder,
.panel-actions input::placeholder {
  color: #a7a0a3;
  font-weight: 400;
}

.credit-form input:focus,
.credit-form select:focus,
.panel-actions input:focus,
.panel-header select:focus,
.compact-select:focus {
  border-color: rgba(216, 68, 68, 0.55);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
  margin: 24px 0;
}

.stat-card,
.admin-panel,
.generation-card,
.detail-block {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

.stat-card {
  padding: 18px;
}

.stat-label {
  color: var(--color-text-secondary);
  font-weight: 700;
}

.stat-value {
  margin-top: 8px;
  font-size: 1.8rem;
  font-weight: 900;
  letter-spacing: -0.04em;
}

.admin-panel {
  margin-top: 18px;
  padding: 22px;
}

.admin-panel h2 {
  margin: 0;
  letter-spacing: -0.04em;
}

.panel-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: nowrap;
}

.compact-search {
  width: min(280px, 100%);
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: #fff;
  color: var(--color-text);
  padding: 0 12px;
  outline: none;
  font-size: 0.9rem;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.compact-search::placeholder {
  color: #a7a0a3;
  font-weight: 400;
}

.compact-search:focus {
  border-color: rgba(216, 68, 68, 0.55);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.search-result-pill {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  font-weight: 800;
  white-space: nowrap;
}

.credit-form {
  display: grid;
  grid-template-columns: 1.3fr 0.8fr 1.4fr auto;
  align-items: end;
  gap: 14px;
  margin: 20px 0;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
}

.credit-user-field {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.field-label {
  font-weight: 800;
}

.user-picker {
  position: relative;
  display: grid;
  gap: 8px;
}

.user-picker-options {
  position: absolute;
  top: 48px;
  left: 0;
  right: 0;
  z-index: 20;
  display: grid;
  gap: 4px;
  max-height: 268px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
  box-shadow: 0 16px 32px rgba(58, 38, 38, 0.12);
}

.user-picker-option {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 4px;
  background: var(--color-surface);
  color: #332c2e;
  text-align: left;
}

.user-picker-option:hover,
.user-picker-option:focus-visible {
  background: var(--color-bg);
  outline: none;
}

.user-picker-option strong {
  font-size: 0.96rem;
}

.user-picker-selected {
  width: fit-content;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid rgba(216, 68, 68, 0.16);
  border-radius: 999px;
  background: var(--color-surface);
  color: #4b4244;
  font-size: 0.82rem;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-select {
  width: min(260px, 100%);
}

.table-wrap {
  width: 100%;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 900px;
}

th,
td {
  padding: 13px 14px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

th {
  background: var(--color-bg);
  color: #3a3032;
  font-size: 0.86rem;
}

td {
  color: #332c2e;
}

tr:last-child td {
  border-bottom: 0;
}

.muted {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.strong {
  font-weight: 900;
}

.token-negative {
  color: var(--color-danger);
  font-weight: 900;
}

.token-positive {
  color: var(--color-success);
  font-weight: 900;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #f6e4df;
  color: #a63737;
  font-size: 0.78rem;
  font-weight: 800;
}

.brand-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}

.brand-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  cursor: pointer;
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.brand-card:hover {
  border-color: rgba(216, 68, 68, 0.32);
  box-shadow: 0 10px 24px rgba(58, 38, 38, 0.08);
  transform: translateY(-1px);
}

.brand-card-name {
  font-size: 1.12rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.3;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-card-owner {
  font-size: 0.84rem;
  color: var(--color-text-secondary);
  line-height: 1.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-card-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.brand-detail-btn {
  margin-top: auto;
  align-self: flex-start;
}

.brand-modal-panel {
  width: min(1080px, 100%);
}

.brand-modal-meta {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
}

.brand-modal-meta p {
  margin: 0;
}

.brand-modal-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.generation-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}

.generation-card {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 16px;
  padding: 16px;
}

.generation-preview {
  width: 128px;
  aspect-ratio: 3 / 4;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg);
  overflow: hidden;
}

.generation-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.generation-title {
  margin: 0 0 8px;
  font-size: 1.08rem;
  line-height: 1.35;
}

.generation-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.generation-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.modal-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 28px;
  background: rgba(34, 24, 24, 0.16);
  backdrop-filter: blur(6px);
}

.modal-panel {
  width: min(980px, 100%);
  max-height: calc(100vh - 56px);
  overflow: auto;
  padding: 24px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

.modal-head {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.modal-kicker {
  color: #bb3f3f;
  font-weight: 900;
  margin-bottom: 6px;
}

.modal-close {
  width: 40px;
  height: 40px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  font-size: 1.3rem;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.detail-block {
  padding: 16px;
  background: var(--color-bg);
}

.detail-block h3 {
  margin: 0 0 10px;
  font-size: 1rem;
}

.detail-block p {
  color: #4b4244;
  line-height: 1.75;
}

.detail-main-image {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  display: block;
}

@media (max-width: 1180px) {
  .admin-shell {
    grid-template-columns: 1fr;
  }

  .admin-sidebar {
    position: static;
    height: auto;
    gap: 18px;
  }

  .stats-grid,
  .generation-list,
  .detail-grid,
  .credit-form {
    grid-template-columns: 1fr;
  }

  .brand-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .admin-topbar,
  .panel-head,
  .panel-actions {
    display: grid;
  }

  .panel-actions {
    justify-content: stretch;
    flex-wrap: wrap;
  }

  .compact-search {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .admin-main,
  .admin-sidebar {
    padding: 20px;
  }

  .generation-card {
    grid-template-columns: 1fr;
  }

  .brand-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .generation-preview {
    width: 100%;
    max-height: 300px;
  }
}
</style>
