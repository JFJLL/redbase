<script setup lang="ts">
import { onMounted, ref } from "vue";
import { isAbortError } from "@/shared/api/client";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fetchFeishuApps, feishuStartUrl, type FeishuApp } from "../api";

// Feishu SSO entry. Ported from loadFeishuLoginApps()/startFeishuLogin() in
// public/app.js: a single tenant becomes one button, multiple tenants are
// listed by name; load failures hide the section like the legacy UI.

const { signalFor } = useAbortScope();
const apps = ref<FeishuApp[]>([]);

onMounted(async () => {
  try {
    const data = await fetchFeishuApps(signalFor("feishu-apps"));
    apps.value = Array.isArray(data.apps) ? data.apps : [];
  } catch (error) {
    if (isAbortError(error)) return;
    apps.value = [];
  }
});

function startLogin(app: FeishuApp): void {
  window.location.href = feishuStartUrl(app.key);
}
</script>

<template>
  <div v-if="apps.length" class="feishu-login" data-testid="feishu-login">
    <div class="feishu-divider"><span>或</span></div>
    <button
      v-for="app in apps"
      :key="app.key"
      class="feishu-btn"
      type="button"
      @click="startLogin(app)"
    >
      {{ apps.length === 1 ? "使用飞书登录" : `飞书登录 · ${app.name}` }}
    </button>
  </div>
</template>

<style scoped>
.feishu-login {
  display: grid;
  gap: 10px;
}

.feishu-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary, #646a73);
  font-size: 12px;
}

.feishu-divider::before,
.feishu-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-border, #e4e6eb);
}

.feishu-btn {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 10px 16px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.feishu-btn:hover {
  border-color: #3370ff;
  color: #3370ff;
}
</style>
