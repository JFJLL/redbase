<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";

const SIDEBAR_COLLAPSED_KEY = "redbase.sidebarCollapsed";
const LOGO_SRC = "/assets/redbase-logo.png";
const router = useRouter();
const auth = useAuthStore();
const sidebarCollapsed = ref(false);

const navItems = [
  { name: "home", icon: "首", label: "首页" },
  { name: "brands", icon: "品", label: "品牌档案" },
  { name: "personal", icon: "人", label: "个人 IP" },
  { name: "trends", icon: "趋", label: "趋势分析" },
  { name: "ideas", icon: "选", label: "内容选题" },
  { name: "excellent", icon: "优", label: "优秀内容" },
  { name: "history", icon: "历", label: "历史生成" },
] as const;

const displayName = computed(() => String(auth.user?.nickname || auth.user?.name || auth.user?.phone || "RedBase User"));
const displayPhone = computed(() => String(auth.user?.phone || ""));
const displayCredits = computed(() => {
  const credits = Number(auth.user?.credits);
  return Number.isFinite(credits) ? credits : null;
});
const avatarText = computed(() => displayName.value.trim().charAt(0).toUpperCase() || "R");

onMounted(() => {
  sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
});

watch(sidebarCollapsed, (collapsed) => {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
});

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
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
            v-for="item in navItems"
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

        <a v-if="auth.isAdmin" class="workspace-user" href="/admin/" title="进入管理后台">
          <span class="user-avatar">{{ avatarText }}</span>
          <span class="user-details">
            <strong class="user-name">{{ displayName }}</strong>
            <span v-if="displayPhone" class="user-phone">{{ displayPhone }}</span>
            <span v-if="displayCredits !== null" class="user-credits">{{ displayCredits }} 积分</span>
          </span>
        </a>
        <div v-else class="workspace-user">
          <span class="user-avatar">{{ avatarText }}</span>
          <span class="user-details">
            <strong class="user-name">{{ displayName }}</strong>
            <span v-if="displayPhone" class="user-phone">{{ displayPhone }}</span>
            <span v-if="displayCredits !== null" class="user-credits">{{ displayCredits }} 积分</span>
          </span>
        </div>

        <button type="button" class="workspace-logout" @click="handleLogout">退出登录</button>
      </div>
    </aside>
    <main class="workspace-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.workspace-layout {
  --workspace-sidebar-width: var(--workspace-sidebar-expanded);
  display: flex;
  min-width: 1440px;
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
  border-color: rgba(216, 68, 68, 0.1);
  background: #f3e7e2;
  color: var(--workspace-brand-ink);
  box-shadow: 0 10px 24px rgba(126, 55, 55, 0.07);
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
  font-size: 0.88rem;
  font-weight: 900;
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
  transition: background 180ms ease;
}

a.workspace-user:hover,
a.workspace-user:focus-visible {
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
  gap: 0;
}

.user-name,
.user-phone {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-name {
  color: var(--workspace-text);
  font-size: 14px;
  font-weight: 400;
}

.user-phone {
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
}

.user-credits {
  margin-top: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(229, 72, 77, 0.12);
  color: #e5484d;
  font-size: 0.72rem;
  font-weight: 800;
}

.workspace-logout {
  min-height: 42px;
  border: 1px solid rgba(229, 72, 77, 0.12);
  border-radius: 4px;
  background: #fff;
  color: #151112;
  font-size: 0.92rem;
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
