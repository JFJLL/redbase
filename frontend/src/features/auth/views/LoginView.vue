<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import FeishuLoginButtons from "../components/FeishuLoginButtons.vue";

// Phone + password login. Same request and error handling as the legacy
// auth modal in public/app.js — backend error text is shown verbatim.

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const form = reactive({ phone: "", password: "" });
const submitting = ref(false);
const errorMessage = ref("");

function afterLoginTarget(): string {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
  return redirect;
}

async function handleSubmit(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  try {
    await auth.login(form.phone, form.password);
    const redirect = afterLoginTarget();
    if (redirect) {
      router.push(redirect);
    } else {
      router.push({ name: "brands" });
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-panel">
      <h1>登录 RedBase</h1>
      <p class="auth-subtitle">使用手机号和密码登录，继续你的内容工作台。</p>

      <form class="auth-form" @submit.prevent="handleSubmit">
        <label>
          <span>手机号</span>
          <input
            v-model="form.phone"
            name="phone"
            type="tel"
            placeholder="请输入手机号"
            autocomplete="tel"
            required
          />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="form.password"
            name="password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            required
          />
        </label>

        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>

        <button class="primary-btn" type="submit" :disabled="submitting">
          {{ submitting ? "登录中..." : "登录" }}
        </button>
      </form>

      <FeishuLoginButtons />

      <p class="auth-switch">
        还没有账号？
        <RouterLink :to="{ name: 'register', query: route.query }">免费注册</RouterLink>
      </p>
      <p class="auth-switch"><a href="/">返回官网</a></p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--color-bg, #f7f7f9);
}

.auth-panel {
  width: min(420px, 100%);
  padding: 36px 32px;
  border-radius: 16px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e4e6eb);
  display: grid;
  gap: 18px;
}

.auth-panel h1 {
  margin: 0;
  font-size: 1.6rem;
}

.auth-subtitle {
  margin: 0;
  color: var(--color-text-secondary, #646a73);
  font-size: 14px;
}

.auth-form {
  display: grid;
  gap: 14px;
}

.auth-form label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.auth-form input {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 11px 12px;
  font: inherit;
  font-weight: 400;
}

.primary-btn {
  border: 0;
  border-radius: 8px;
  padding: 12px 20px;
  background: var(--color-brand, #ff2442);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-error {
  margin: 0;
  color: #d64545;
  font-size: 13px;
  white-space: pre-wrap;
}

.auth-switch {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary, #646a73);
}

.auth-switch a {
  color: var(--color-brand, #ff2442);
}
</style>
