<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import { fetchRechargePlans } from "@/features/billing/api";

const SIDEBAR_COLLAPSED_KEY = "redbase.sidebarCollapsed";
const LOGO_SRC = "/assets/redbase-logo.png";
const router = useRouter();
const auth = useAuthStore();
const sidebarCollapsed = ref(false);
const accountCenterOpen = ref(false);
const billingAvailable = ref(false);

const navItems = [
  { name: "home", icon: "首", label: "首页" },
  { name: "brands", icon: "品", label: "品牌档案" },
  { name: "personal", icon: "人", label: "个人 IP" },
  { name: "trends", icon: "趋", label: "趋势分析" },
  { name: "ideas", icon: "选", label: "内容选题" },
  { name: "excellent", icon: "优", label: "优秀内容" },
  { name: "generation", icon: "生", label: "生图任务" },
  { name: "history", icon: "历", label: "历史生成" },
  { name: "billing", icon: "充", label: "积分充值" },
] as const;

const visibleNavItems = computed(() =>
  navItems.filter((item) => item.name !== "billing" || billingAvailable.value),
);

const displayName = computed(() => String(auth.user?.nickname || auth.user?.name || auth.user?.phone || "RedBase User"));
const displayPhone = computed(() => String(auth.user?.phone || ""));
const displayCredits = computed(() => {
  const credits = Number(auth.user?.credits);
  return Number.isFinite(credits) ? credits : null;
});
const avatarText = computed(() => displayName.value.trim().charAt(0).toUpperCase() || "R");
const accountUser = computed(() => (auth.user ? (auth.user as Record<string, unknown>) : null));
const accountIdentifier = computed(() => firstTextValue(accountUser.value?.phone, accountUser.value?.name) || "-");
const accountPackage = computed(() => getAccountPackageName(accountUser.value));
const accountExpiry = computed(() => getAccountPackageExpiry(accountUser.value));

onMounted(() => {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  document.addEventListener("keydown", handleDocumentKeydown);
  fetchRechargePlans()
    .then((data) => {
      billingAvailable.value = data.plans.length > 0;
    })
    .catch(() => {
      billingAvailable.value = false;
    });
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleDocumentKeydown);
});

watch(sidebarCollapsed, (collapsed) => {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
});

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function openAccountCenter(): void {
  accountCenterOpen.value = true;
}

function closeAccountCenter(): void {
  accountCenterOpen.value = false;
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && accountCenterOpen.value) closeAccountCenter();
}

async function handleLogout() {
  try {
    await auth.logout();
  } finally {
    await router.push({ name: "login" });
  }
}
</script>

<template>
  <div class="workspace-layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="workspace-sidebar">
      <div class="workspace-sidebar-top">
        <RouterLink class="workspace-logo" :to="{ name: 'home' }" aria-label="RedBase 首页">
          <img :src="LOGO_SRC" alt="RedBase" />
        </RouterLink>
        <nav class="workspace-nav" aria-label="工作台导航">
          <RouterLink
            v-for="item in visibleNavItems"
            :key="item.name"
            :to="{ name: item.name }"
            class="sidebar-item"
            active-class="is-active"
            :title="sidebarCollapsed ? item.label : undefined"
          >
            <span class="sidebar-item-icon">{{ item.icon }}</span>
            <span class="sidebar-item-label">{{ item.label }}</span>
          </RouterLink>
        </nav>
      </div>

      <div class="workspace-session">
        <button
          type="button"
          class="sidebar-toggle"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-expanded="!sidebarCollapsed"
          @click="toggleSidebar"
        >
          <span class="sidebar-toggle-icon" aria-hidden="true">{{ sidebarCollapsed ? "›" : "‹" }}</span>
          <span class="sidebar-toggle-label">{{ sidebarCollapsed ? "展开侧边栏" : "收起侧边栏" }}</span>
        </button>

        <a
          v-if="auth.isAdmin"
          class="workspace-user"
          href="/admin/"
          title="进入管理后台"
        >
          <span class="user-avatar">{{ avatarText }}</span>
          <span class="user-details">
            <strong class="user-name">{{ displayName }}</strong>
            <span v-if="displayPhone" class="user-phone">{{ displayPhone }}</span>
            <span v-if="displayCredits !== null" class="user-credits credit-pill">{{ displayCredits }} 积分</span>
          </span>
        </a>
        <div
          v-else
          class="workspace-user"
          role="button"
          tabindex="0"
          aria-haspopup="dialog"
          @click="openAccountCenter"
          @keydown.enter="openAccountCenter"
          @keydown.space.prevent="openAccountCenter"
        >
          <span class="user-avatar">{{ avatarText }}</span>
          <span class="user-details">
            <strong class="user-name">{{ displayName }}</strong>
            <span v-if="displayPhone" class="user-phone">{{ displayPhone }}</span>
            <span v-if="displayCredits !== null" class="user-credits credit-pill">{{ displayCredits }} 积分</span>
          </span>
        </div>

        <button type="button" class="workspace-logout" @click="handleLogout">退出登录</button>
      </div>
    </aside>
    <main class="workspace-main">
      <RouterView />
    </main>

    <div v-if="accountCenterOpen" class="workspace-modal-backdrop" @click.self="closeAccountCenter">
      <section class="workspace-modal account-modal-panel" role="dialog" aria-modal="true" aria-labelledby="accountCenterTitle">
        <div class="workspace-modal-head">
          <div>
            <div class="workspace-modal-kicker">个人中心</div>
            <h2 id="accountCenterTitle" class="workspace-modal-title">账号信息</h2>
            <p class="workspace-modal-copy">查看当前账号、套餐和到期状态。</p>
          </div>
          <button class="workspace-modal-close" type="button" aria-label="关闭账号信息" @click="closeAccountCenter">×</button>
        </div>

        <div class="account-summary-grid">
          <div class="account-summary-item">
            <span>账号</span>
            <strong>{{ accountIdentifier }}</strong>
          </div>
          <div class="account-summary-item">
            <span>套餐到期时间</span>
            <strong>{{ accountExpiry }}</strong>
          </div>
          <div class="account-summary-item">
            <span>当前套餐</span>
            <strong>{{ accountPackage }}</strong>
          </div>
        </div>

        <section class="account-business-plan" aria-label="定制专属增长方案">
          <h3>定制专属增长方案</h3>
          <div class="business-price-grid account-business-price-grid" aria-label="RedBase 企业报价">
            <div class="business-price-item">
              <span>单月版</span>
              <strong>¥3,500</strong>
              <small>按月灵活接入</small>
              <small>每月 1000 积分</small>
            </div>
            <div class="business-price-item">
              <span>包年版</span>
              <strong>¥35,000</strong>
              <small>年付更优惠</small>
              <small>每月 1000 积分</small>
            </div>
          </div>
          <p class="business-credit-note account-business-credit-note">两个版本均为每月 1000 积分；积分到期自动刷新，不会结转至下个月。</p>
          <p class="account-business-contact">联系专属客服获取优惠价格</p>
          <a v-if="auth.isAdmin" class="account-admin-link" href="/admin/">进入管理后台</a>
        </section>
      </section>
    </div>
  </div>
</template>

<script lang="ts">
function firstTextValue(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getAccountPackageName(user: Record<string, unknown> | null): string {
  const subscription = asRecord(user?.subscription);
  const packageInfo = asRecord(user?.package);
  const planInfo = asRecord(user?.plan);
  const directPlan = typeof user?.plan === "string" ? user.plan : "";
  const directPackage = typeof user?.package === "string" ? user.package : "";
  return (
    firstTextValue(
      user?.packageName,
      user?.planName,
      user?.currentPackage,
      directPackage,
      directPlan,
      subscription.packageName,
      subscription.planName,
      packageInfo.name,
      packageInfo.title,
      planInfo.name,
      planInfo.title,
    ) || "未开通"
  );
}

function getAccountPackageExpiry(user: Record<string, unknown> | null): string {
  const subscription = asRecord(user?.subscription);
  const packageInfo = asRecord(user?.package);
  const planInfo = asRecord(user?.plan);
  const rawExpiry = firstTextValue(
    user?.packageExpiry,
    user?.packageExpiresAt,
    user?.planExpiry,
    user?.planExpiresAt,
    user?.subscriptionExpiry,
    user?.subscriptionExpiresAt,
    subscription.expiresAt,
    subscription.expiry,
    subscription.endDate,
    packageInfo.expiresAt,
    packageInfo.expiry,
    planInfo.expiresAt,
    planInfo.expiry,
  );
  if (!rawExpiry) return "-";
  const timestamp = /^\d+$/.test(rawExpiry) ? Number(rawExpiry) : Number.NaN;
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp > 100000000000 ? timestamp : timestamp * 1000)
    : new Date(rawExpiry);
  return Number.isNaN(date.getTime())
    ? rawExpiry
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}
</script>

<style scoped>
.workspace-layout {
  --workspace-sidebar-width: var(--workspace-sidebar-expanded);
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 100vh;
  background: linear-gradient(180deg, var(--workspace-bg-top), var(--workspace-bg-bottom));
}

.workspace-sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 20;
  display: flex;
  width: var(--workspace-sidebar-width);
  flex-direction: column;
  justify-content: space-between;
  padding: 28px 18px 18px;
  overflow: hidden;
  border-right: 1px solid var(--workspace-border);
  background: var(--workspace-sidebar-bg);
  box-shadow: var(--workspace-shadow-sidebar);
  transition: width 0.18s ease, padding 0.18s ease;
}

.workspace-sidebar-top {
  min-height: 0;
}

.workspace-logo {
  display: block;
  width: 224px;
  height: 78px;
  color: inherit;
  text-decoration: none;
  transition: width 0.18s ease;
}

.workspace-logo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: left center;
}

.workspace-nav {
  display: grid;
  gap: 8px;
  margin-top: 26px;
}

.sidebar-item {
  display: flex;
  min-height: 50px;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--workspace-radius);
  color: #564d50;
  font-size: 0.98rem;
  font-weight: 800;
  text-decoration: none;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.sidebar-item:hover,
.sidebar-item.is-active {
  border-color: transparent;
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  box-shadow: none;
}

.sidebar-item-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 7px;
  background: rgba(216, 68, 68, 0.08);
  color: var(--workspace-brand-ink);
  font-size: 0.8rem;
  font-weight: 900;
}

.sidebar-item:hover .sidebar-item-icon,
.sidebar-item.is-active .sidebar-item-icon {
  background: var(--workspace-brand);
  color: #fff;
}

.workspace-session {
  display: grid;
  gap: 16px;
}

.sidebar-toggle {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgba(229, 72, 77, 0.12);
  border-radius: 999px;
  background: #fff;
  color: #7f383d;
  box-shadow: 0 10px 24px rgba(126, 55, 55, 0.06);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.sidebar-toggle:hover {
  border-color: rgba(229, 72, 77, 0.3);
  background: #fff7f5;
}

.sidebar-toggle-icon {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 50%;
  background: #f3e7e2;
  color: #b84043;
  font-family: Arial, sans-serif;
  font-size: 17px;
  line-height: 1;
}

.workspace-user {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 14px;
  padding: 10px 8px;
  border: 0;
  border-radius: var(--workspace-radius);
  background: transparent;
  color: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: background 180ms ease;
}

.workspace-user:hover,
.workspace-user:focus-visible {
  background: rgba(216, 68, 68, 0.06);
  outline: none;
}

.user-avatar {
  display: grid;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(216, 68, 68, 0.1);
  border-radius: 50%;
  background: #efe7e2;
  color: #a13a3a;
  font-size: 14px;
  font-weight: 700;
}

.user-details {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.user-name,
.user-phone {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-name {
  color: #31292b;
  font-size: 13px;
  font-weight: 500;
}

.user-phone {
  color: #7b7073;
  font-size: 12px;
}

.user-credits {
  padding: 2px 7px;
  border-radius: 999px;
  background: #fff0ed;
  color: #db4b4e;
  font-size: 11px;
  font-weight: 700;
}

.workspace-logout {
  min-height: 42px;
  border: 1px solid rgba(18, 16, 17, 0.08);
  border-radius: 4px;
  background: #fff;
  color: #4b4244;
  font-size: 13px;
  cursor: pointer;
}

.workspace-logout:hover {
  border-color: rgba(216, 68, 68, 0.24);
  color: #b83a3d;
}

.workspace-main {
  width: calc(100% - var(--workspace-sidebar-width));
  min-width: 0;
  min-height: 100vh;
  margin-left: var(--workspace-sidebar-width);
  padding: var(--workspace-page-top) var(--workspace-page-x) var(--workspace-page-bottom);
  transition: width 0.18s ease, margin-left 0.18s ease;
}

.workspace-layout.sidebar-collapsed {
  --workspace-sidebar-width: var(--workspace-sidebar-collapsed);
}

.sidebar-collapsed .workspace-sidebar {
  padding: 24px 12px 18px;
}

.sidebar-collapsed .workspace-logo {
  width: 54px;
  height: 54px;
  overflow: hidden;
}

.sidebar-collapsed .workspace-nav {
  margin-top: 24px;
}

.sidebar-collapsed .sidebar-item {
  justify-content: center;
  padding: 0;
}

.sidebar-collapsed .sidebar-item-label,
.sidebar-collapsed .sidebar-toggle-label,
.sidebar-collapsed .user-details,
.sidebar-collapsed .workspace-logout {
  display: none;
}

.sidebar-collapsed .sidebar-toggle {
  width: 30px;
  min-height: 30px;
  justify-self: center;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.sidebar-collapsed .sidebar-toggle-icon {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(216, 68, 68, 0.14);
  background: #f7e8e4;
  box-shadow: 0 8px 18px rgba(126, 55, 55, 0.08);
}

.sidebar-collapsed .workspace-user {
  justify-content: center;
  padding: 0;
}

@media (max-width: 1100px) {
  .workspace-layout {
    min-width: 0;
    --workspace-sidebar-width: var(--workspace-sidebar-collapsed);
  }

  .workspace-sidebar {
    padding: 24px 12px 18px;
  }

  .workspace-logo {
    width: 54px;
    height: 54px;
    overflow: hidden;
  }

  .workspace-nav {
    margin-top: 24px;
  }

  .sidebar-item {
    justify-content: center;
    padding: 0;
  }

  .sidebar-item-label,
  .sidebar-toggle-label,
  .user-details,
  .workspace-logout {
    display: none;
  }

  .sidebar-toggle {
    width: 30px;
    min-height: 30px;
    justify-self: center;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .sidebar-toggle-icon {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(216, 68, 68, 0.14);
    background: #f7e8e4;
    box-shadow: 0 8px 18px rgba(126, 55, 55, 0.08);
  }

  .workspace-user {
    justify-content: center;
    padding: 0;
  }

  .workspace-main {
    width: calc(100% - var(--workspace-sidebar-width));
    margin-left: var(--workspace-sidebar-width);
    padding: 24px;
  }
}

@media (max-width: 760px) {
  .workspace-layout {
    min-width: 0;
  }

  .workspace-sidebar {
    position: static;
    width: 88px;
    padding: 18px 10px;
  }

  .workspace-logo {
    width: 58px;
    height: 58px;
    overflow: hidden;
  }

  .workspace-nav {
    margin-top: 20px;
  }

  .sidebar-item {
    justify-content: center;
    padding: 0;
  }

  .sidebar-item-label,
  .sidebar-toggle-label,
  .user-details,
  .workspace-logout {
    display: none;
  }

  .workspace-main {
    width: calc(100% - 88px);
    margin-left: 0;
    padding: 24px 16px;
  }
}
</style>
