<template>
  <aside class="admin-sidebar" :class="{ 'admin-sidebar--collapsed': collapsed }">
    <div class="sidebar-header">
      <div class="brand-logo" v-if="!collapsed">
        <span class="logo-red">RedBase</span>
        <span class="badge-admin">Analytics V1</span>
      </div>
      <button
        type="button"
        class="collapse-btn"
        :title="collapsed ? '展开侧边栏' : '折叠侧边栏'"
        @click="$emit('toggleCollapse')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path v-if="collapsed" d="M9 18l6-6-6-6" />
          <path v-else d="M15 18l-6-6 6-6" />
        </svg>
      </button>
    </div>

    <nav class="sidebar-nav">
      <a
        v-for="item in navItems"
        :key="item.id"
        :href="`#${item.id}`"
        class="nav-link"
        :class="{ active: activeSection === item.id }"
        :title="collapsed ? item.label : undefined"
        :data-test="`nav-${item.id}`"
        @click.prevent="$emit('update:activeSection', item.id)"
      >
        <span class="nav-icon" v-html="item.icon"></span>
        <span class="nav-label" v-if="!collapsed">{{ item.label }}</span>
      </a>
    </nav>

    <div class="sidebar-footer" v-if="!collapsed">
      <a href="/app/" class="back-workspace-link">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        <span>返回工作台</span>
      </a>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { AdminSection } from "../types";

defineProps<{
  activeSection: AdminSection;
  collapsed?: boolean;
}>();

defineEmits<{
  (e: "update:activeSection", section: AdminSection): void;
  (e: "toggleCollapse"): void;
}>();

const navItems: Array<{ id: AdminSection; label: string; icon: string }> = [
  {
    id: "overview",
    label: "经营总览",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  },
  {
    id: "users",
    label: "用户与转化",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  },
  {
    id: "features",
    label: "内容与功能",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  },
  {
    id: "ai",
    label: "AI 运行",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><path d="M12 6v6l4 2"/></svg>',
  },
  {
    id: "finance",
    label: "收入与积分",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  },
  {
    id: "system",
    label: "系统与异常",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  },
  {
    id: "management",
    label: "数据管理",
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  },
];
</script>

<style scoped>
.admin-sidebar {
  width: 220px;
  min-width: 220px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: sticky;
  top: 0;
  transition: width 0.2s ease, min-width 0.2s ease;
  user-select: none;
  z-index: 20;
}

.admin-sidebar--collapsed {
  width: 64px;
  min-width: 64px;
}

.sidebar-header {
  height: 60px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #f3f4f6;
}

.brand-logo {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 16px;
}

.logo-red {
  color: #e11d48;
}

.badge-admin {
  font-size: 11px;
  font-weight: 600;
  background: #fee2e2;
  color: #b91c1c;
  padding: 2px 6px;
  border-radius: 4px;
}

.collapse-btn {
  background: transparent;
  border: none;
  color: #6b7280;
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.collapse-btn:hover {
  background: #f3f4f6;
  color: #111827;
}

.sidebar-nav {
  flex: 1;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  color: #4b5563;
  text-decoration: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.nav-link:hover {
  background: #f9fafb;
  color: #111827;
}

.nav-link.active {
  background: #fee2e2;
  color: #e11d48;
  font-weight: 600;
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid #f3f4f6;
}

.back-workspace-link {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #6b7280;
  text-decoration: none;
  font-size: 13px;
  padding: 6px 0;
}
.back-workspace-link:hover {
  color: #111827;
}
</style>
