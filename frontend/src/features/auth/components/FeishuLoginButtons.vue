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
const menuOpen = ref(false);

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

function handlePrimaryClick(): void {
  if (apps.value.length <= 1) {
    startLogin(apps.value[0] || { key: "", name: "" });
    return;
  }
  menuOpen.value = !menuOpen.value;
}
</script>

<template>
  <div v-if="apps.length" class="feishu-login" data-testid="feishu-login">
    <div class="feishu-login-actions">
      <button class="feishu-login-btn" type="button" @click="handlePrimaryClick">
        <span class="feishu-login-mark">飞</span>
        <span>{{ apps.length === 1 ? "使用飞书登录" : "飞书企业登录" }}</span>
      </button>
      <div v-if="apps.length > 1 && menuOpen" class="feishu-app-menu">
        <button v-for="app in apps" :key="app.key" class="feishu-app-option" type="button" @click="startLogin(app)">
          {{ app.name }}
        </button>
      </div>
    </div>
    <div class="auth-divider"><span>或使用手机号</span></div>
  </div>
</template>

<style scoped>
.feishu-login {
  display: grid;
  gap: 0;
}

.feishu-login-actions {
  position: relative;
  display: grid;
  gap: 10px;
}

.feishu-login-btn {
  width: 100%;
  min-height: 50px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid rgba(36, 143, 255, 0.48);
  border-radius: 8px;
  background: #1f7cff;
  color: #fff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.feishu-login-mark {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 0.86rem;
}

.feishu-app-menu {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(36, 143, 255, 0.24);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 18px 36px rgba(39, 46, 69, 0.14);
}

.feishu-app-option {
  min-height: 42px;
  padding: 0 14px;
  border: 1px solid rgba(226, 232, 240, 0.92);
  border-radius: 8px;
  background: #f8fafc;
  color: #1c2440;
  font: inherit;
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}

.feishu-app-option:hover {
  border-color: rgba(36, 143, 255, 0.48);
  background: #eff6ff;
}
</style>
