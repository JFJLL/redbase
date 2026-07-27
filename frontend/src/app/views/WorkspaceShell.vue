<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";

// Workspace shell (orchestrator-owned shared layout): sidebar navigation and
// session block. Mirrors the legacy sidebar tab order and labels.
const router = useRouter();
const auth = useAuthStore();

const navItems = [
  { name: "home", icon: "首", label: "首页" },
  { name: "brands", icon: "品", label: "品牌档案" },
  { name: "personal", icon: "我", label: "个人 IP" },
  { name: "trends", icon: "趋", label: "趋势分析" },
  { name: "ideas", icon: "选", label: "内容选题" },
  { name: "excellent", icon: "优", label: "优秀内容" },
  { name: "history", icon: "史", label: "历史生成" },
] as const;

const displayName = computed(() => String(auth.user?.nickname || auth.user?.name || auth.user?.phone || ""));

async function handleLogout() {
  try {
    await auth.logout();
  } finally {
    await router.push({ name: "login" });
  }
}
</script>

<template>
  <div class="workspace-layout">
    <aside class="workspace-sidebar">
      <div class="workspace-logo">RedBase</div>
      <nav class="workspace-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name }"
          class="sidebar-item"
          active-class="is-active"
        >
          <span class="sidebar-item-icon">{{ item.icon }}</span>
          <span class="sidebar-item-label">{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="workspace-session">
        <div class="workspace-user" :title="displayName">{{ displayName }}</div>
        <a v-if="auth.isAdmin" class="workspace-admin-link" href="/admin/">管理后台</a>
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
  display: flex;
  min-height: 100vh;
}

.workspace-sidebar {
  display: flex;
  flex-direction: column;
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 16px 12px;
  gap: 16px;
}

.workspace-logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-brand);
  padding: 4px 8px;
}

.workspace-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  color: var(--color-text);
  text-decoration: none;
  font-size: 14px;
}

.sidebar-item:hover {
  background: var(--color-bg);
}

.sidebar-item.is-active {
  background: rgba(255, 36, 66, 0.08);
  color: var(--color-brand);
  font-weight: 600;
}

.sidebar-item-icon {
  width: 20px;
  text-align: center;
}

.workspace-session {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}

.workspace-user {
  font-size: 13px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 8px;
}

.workspace-admin-link {
  font-size: 13px;
  color: var(--color-text-secondary);
  text-decoration: none;
  padding: 0 8px;
}

.workspace-logout {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 8px;
  font-size: 13px;
  cursor: pointer;
}

.workspace-logout:hover {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.workspace-main {
  flex: 1;
  min-width: 0;
  padding: 24px;
}
</style>
