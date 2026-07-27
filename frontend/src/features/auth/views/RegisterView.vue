<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import { sendCode } from "../api";
import FeishuLoginButtons from "../components/FeishuLoginButtons.vue";

// Registration. Fields follow the backend contract (phone/name/password);
// the send-code step surfaces the backend notice (and demo code) verbatim.

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const form = reactive({ phone: "", name: "", password: "", code: "" });
const submitting = ref(false);
const sendingCode = ref(false);
const errorMessage = ref("");
const codeNotice = ref("");

async function handleSendCode(): Promise<void> {
  sendingCode.value = true;
  errorMessage.value = "";
  codeNotice.value = "";
  try {
    const data = await sendCode(form.phone);
    codeNotice.value = data.demoCode ? `${data.message}（验证码：${data.demoCode}）` : data.message;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    sendingCode.value = false;
  }
}

async function handleSubmit(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  try {
    // Backend register contract: { phone, name, password }.
    await auth.register({ phone: form.phone, name: form.name, password: form.password });
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
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
      <h1>注册 RedBase</h1>
      <p class="auth-subtitle">创建账号，开始品牌与个人 IP 的内容运营。</p>

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
          <span>验证码</span>
          <div class="code-row">
            <input v-model="form.code" name="code" placeholder="收到的验证码" />
            <button class="secondary-btn" type="button" :disabled="sendingCode" @click="handleSendCode">
              {{ sendingCode ? "发送中..." : "获取验证码" }}
            </button>
          </div>
        </label>
        <p v-if="codeNotice" class="code-notice" role="status">{{ codeNotice }}</p>
        <label>
          <span>昵称</span>
          <input v-model="form.name" name="name" placeholder="请输入昵称" required />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="form.password"
            name="password"
            type="password"
            placeholder="至少 6 位密码"
            autocomplete="new-password"
            required
          />
        </label>

        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>

        <button class="primary-btn" type="submit" :disabled="submitting">
          {{ submitting ? "注册中..." : "注册" }}
        </button>
      </form>

      <FeishuLoginButtons />

      <p class="auth-switch">
        已有账号？
        <RouterLink :to="{ name: 'login', query: route.query }">直接登录</RouterLink>
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

.code-row {
  display: flex;
  gap: 10px;
}

.code-row input {
  flex: 1;
}

.code-notice {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary, #4a4f58);
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

.secondary-btn {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 10px 14px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.primary-btn:disabled,
.secondary-btn:disabled {
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
