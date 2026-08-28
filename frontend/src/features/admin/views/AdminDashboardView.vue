<template>
  <div class="admin-layout">
    <!-- Sidebar -->
    <AdminSidebar
      :active-section="activeSection"
      :collapsed="sidebarCollapsed"
      @update:active-section="switchSection"
      @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
    />

    <!-- Main Body Area -->
    <div class="admin-main-area">
      <!-- Top Global Filter Bar -->
      <AdminGlobalFilters
        :filters="filters"
        :coverage="coverage"
        :loading="refreshing"
        @update:filters="onFiltersUpdate"
        @refresh="refreshActivePanel"
      />

      <!-- Main Panel View Area -->
      <main class="admin-content-container">
        <div v-if="authError" class="auth-error-wrapper">
          <AdminErrorState :message="authError" :retryable="false" />
        </div>

        <div v-else-if="sessionLoading" class="session-loading-wrapper">
          <div class="spinner"></div>
          <span>验证管理员会话...</span>
        </div>

        <div v-else class="panel-wrapper">
          <component
            :is="currentPanelComponent"
            ref="activePanelRef"
            :filters="filters"
          />
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from "vue";
import type { AdminSection, AdminFilters, CoverageInfo } from "../types";
import { fetchSession } from "../api";
import AdminSidebar from "../components/AdminSidebar.vue";
import AdminGlobalFilters from "../components/AdminGlobalFilters.vue";
import AdminErrorState from "../components/AdminErrorState.vue";

// Lazy-loaded sub-panels
const AdminOverviewPanel = defineAsyncComponent(() => import("../panels/AdminOverviewPanel.vue"));
const AdminUsersPanel = defineAsyncComponent(() => import("../panels/AdminUsersPanel.vue"));
const AdminFeaturesPanel = defineAsyncComponent(() => import("../panels/AdminFeaturesPanel.vue"));
const AdminAiPanel = defineAsyncComponent(() => import("../panels/AdminAiPanel.vue"));
const AdminFinancePanel = defineAsyncComponent(() => import("../panels/AdminFinancePanel.vue"));
const AdminSystemPanel = defineAsyncComponent(() => import("../panels/AdminSystemPanel.vue"));
const AdminManagementPanel = defineAsyncComponent(() => import("../panels/AdminManagementPanel.vue"));

const VALID_SECTIONS: Set<AdminSection> = new Set([
  "overview",
  "users",
  "features",
  "ai",
  "finance",
  "system",
  "management",
]);

const activeSection = ref<AdminSection>("overview");
const sidebarCollapsed = ref(false);
const refreshing = ref(false);
const sessionLoading = ref(true);
const authError = ref("");
const coverage = ref<CoverageInfo | undefined>(undefined);
const activePanelRef = ref<any>(null);

const filters = ref<AdminFilters>({
  preset: "7d",
  accountType: "",
});

const currentPanelComponent = computed(() => {
  switch (activeSection.value) {
    case "overview": return AdminOverviewPanel;
    case "users": return AdminUsersPanel;
    case "features": return AdminFeaturesPanel;
    case "ai": return AdminAiPanel;
    case "finance": return AdminFinancePanel;
    case "system": return AdminSystemPanel;
    case "management": return AdminManagementPanel;
    default: return AdminOverviewPanel;
  }
});

function syncFromHash() {
  const hash = window.location.hash.replace(/^#/, "").trim() as AdminSection;
  if (VALID_SECTIONS.has(hash)) {
    activeSection.value = hash;
  } else {
    activeSection.value = "overview";
  }
}

function switchSection(sec: AdminSection) {
  if (activeSection.value === sec) return;
  activeSection.value = sec;
  window.location.hash = `#${sec}`;
}

function onFiltersUpdate(newFilters: AdminFilters) {
  filters.value = newFilters;
}

async function refreshActivePanel() {
  refreshing.value = true;
  try {
    if (activePanelRef.value && typeof activePanelRef.value.refresh === "function") {
      await activePanelRef.value.refresh();
    }
  } finally {
    refreshing.value = false;
  }
}

async function checkSession() {
  sessionLoading.value = true;
  authError.value = "";
  try {
    const res = await fetchSession();
    if (!res?.user?.isAdmin) {
      authError.value = "当前账号没有管理后台权限";
    }
  } catch (err: any) {
    authError.value = err?.message || "登录状态验证失败，请重新登录";
  } finally {
    sessionLoading.value = false;
  }
}

onMounted(() => {
  syncFromHash();
  window.addEventListener("hashchange", syncFromHash);
  checkSession();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", syncFromHash);
});
</script>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  background: #f8fafc;
  color: #1e293b;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.admin-main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.admin-content-container {
  flex: 1;
  padding: 20px;
  max-width: 1440px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.session-loading-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 100px 20px;
  color: #64748b;
  gap: 12px;
}
.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid #fee2e2;
  border-top-color: #e11d48;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}

.auth-error-wrapper {
  padding: 40px 20px;
}

.panel-wrapper {
  animation: fadeIn 0.15s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
