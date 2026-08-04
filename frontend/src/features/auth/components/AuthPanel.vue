<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import { resetPassword, sendCode, sendResetPasswordCode } from "../api";
import FeishuLoginButtons from "./FeishuLoginButtons.vue";

type AuthMode = "login" | "register" | "reset";

const props = defineProps<{ initialMode: AuthMode }>();
const LOGO_SRC = "/assets/redbase-logo.png";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const activeMode = ref<AuthMode>(props.initialMode);
const submitting = ref(false);
const sendingCode = ref(false);
const errorMessage = ref("");
const codeNotice = ref("");
const resetSuccess = ref(false);
const cooldownSeconds = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;
const loginForm = reactive({ phone: "", password: "" });
const registerForm = reactive({ phone: "", name: "", password: "", code: "" });
const resetForm = reactive({ phone: "", code: "", password: "" });

function startCooldown(seconds: number): void {
  stopCooldown();
  cooldownSeconds.value = Math.max(0, Math.floor(seconds));
  if (cooldownSeconds.value <= 0) return;
  cooldownTimer = setInterval(() => {
    cooldownSeconds.value -= 1;
    if (cooldownSeconds.value <= 0) stopCooldown();
  }, 1000);
}

function stopCooldown(): void {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

onBeforeUnmount(stopCooldown);

function setMode(mode: AuthMode): void {
  activeMode.value = mode;
  errorMessage.value = "";
  codeNotice.value = "";
  resetSuccess.value = false;
}

function afterAuthTarget(): string {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
  return redirect.startsWith("/") && !redirect.startsWith("//") && redirect !== "/" ? redirect : "";
}

async function goToWorkspace(): Promise<void> {
  const redirect = afterAuthTarget();
  if (redirect) {
    await router.push(redirect);
    return;
  }
  await router.push({ name: "brands" });
}

async function refreshAuthUser(): Promise<void> {
  try {
    await auth.refreshUser();
  } catch {
    // Login/register already succeeded; keep the workspace usable if the
    // supplementary session refresh is temporarily unavailable.
  }
}

async function handleLogin(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  try {
    await auth.login(loginForm.phone, loginForm.password);
    await refreshAuthUser();
    await goToWorkspace();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}

async function handleSendCodeForRegister(): Promise<void> {
  sendingCode.value = true;
  errorMessage.value = "";
  codeNotice.value = "";
  try {
    const data = await sendCode(registerForm.phone, "register");
    codeNotice.value = data.demoCode ? `${data.message}（测试验证码：${data.demoCode}）` : data.message;
    startCooldown(60);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    sendingCode.value = false;
  }
}

async function handleSendCodeForReset(): Promise<void> {
  sendingCode.value = true;
  errorMessage.value = "";
  codeNotice.value = "";
  try {
    const data = await sendResetPasswordCode(resetForm.phone);
    codeNotice.value = data.demoCode ? `${data.message}（测试验证码：${data.demoCode}）` : data.message;
    startCooldown(60);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    sendingCode.value = false;
  }
}

async function handleRegister(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  try {
    await auth.register({
      phone: registerForm.phone,
      name: registerForm.name,
      password: registerForm.password,
      code: registerForm.code,
    });
    await refreshAuthUser();
    await goToWorkspace();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}

async function handleResetPassword(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  codeNotice.value = "";
  try {
    await resetPassword(resetForm.phone, resetForm.code, resetForm.password);
    resetSuccess.value = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    setMode("login");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}

function close(): void {
  window.location.href = "/";
}
</script>

<template>
  <div class="auth-route-page">
    <div class="auth-route-backdrop" aria-hidden="true"></div>
    <section class="auth-modal-panel auth-route-panel" role="dialog" aria-modal="true" aria-labelledby="authPanelTitle">
      <div class="auth-modal-head">
        <div>
          <div class="auth-modal-kicker">账户访问</div>
          <h1 id="authPanelTitle">欢迎来到 RedBase</h1>
          <p>先完成手机号注册或登录，再进入你的品牌增长工作台。</p>
        </div>
        <button class="auth-modal-close" type="button" aria-label="返回官网" title="返回官网" @click="close">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="auth-shell">
        <div class="auth-brand-panel">
          <div class="logo-wrap logo-wrap-vertical auth-brand-logo">
            <div class="logo-icon logo-icon-large">
              <img class="logo-image" :src="LOGO_SRC" alt="RedBase logo" />
            </div>
            <div>
              <div class="auth-brand-system">内容趋势与品牌运营系统</div>
            </div>
          </div>
          <h2>让热点服务于品牌，而不是让品牌被热点牵着走。</h2>
          <p>注册后你就可以创建品牌档案、生成热点分析、产出内容选题，并一键获取视觉方案。</p>
        </div>

        <div class="auth-form-panel">
          <FeishuLoginButtons />

          <div class="auth-tab-row">
            <button
              class="auth-tab"
              :class="{ 'is-active': activeMode === 'register' }"
              type="button"
              @click="setMode('register')"
            >
              手机号注册
            </button>
            <button
              class="auth-tab"
              :class="{ 'is-active': activeMode === 'login' }"
              type="button"
              @click="setMode('login')"
            >
              手机号登录
            </button>
          </div>

          <form v-if="activeMode === 'register'" id="registerForm" class="auth-form" @submit.prevent="handleRegister">
            <label>
              <span>手机号</span>
              <input v-model="registerForm.phone" name="phone" type="tel" placeholder="请输入手机号" autocomplete="tel" required />
            </label>
            <label>
              <span>昵称</span>
              <input v-model="registerForm.name" name="name" placeholder="请输入你的昵称" required />
            </label>
            <div class="auth-code-row">
              <label class="auth-code-field">
                <span>验证码</span>
                <input
                  v-model="registerForm.code"
                  name="code"
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="6 位验证码"
                  autocomplete="one-time-code"
                  required
                />
              </label>
              <button
                class="auth-code-btn"
                type="button"
                :disabled="sendingCode || cooldownSeconds > 0 || !/^1\d{10}$/.test(registerForm.phone)"
                @click="handleSendCodeForRegister"
              >
                {{ cooldownSeconds > 0 ? `${cooldownSeconds}s` : sendingCode ? "发送中..." : "获取验证码" }}
              </button>
            </div>
            <label>
              <span>登录密码</span>
              <input
                v-model="registerForm.password"
                name="password"
                type="password"
                placeholder="至少 6 位密码"
                autocomplete="new-password"
                required
              />
            </label>
            <button class="primary-btn auth-submit-btn" type="submit" :disabled="submitting">
              {{ submitting ? "注册中..." : "注册并进入工作台" }}
            </button>
            <p v-if="codeNotice" class="code-notice" role="status">{{ codeNotice }}</p>
          </form>

          <form v-else-if="activeMode === 'login'" id="loginForm" class="auth-form" @submit.prevent="handleLogin">
            <label>
              <span>手机号</span>
              <input v-model="loginForm.phone" name="phone" type="tel" placeholder="请输入手机号" autocomplete="tel" required />
            </label>
            <label>
              <span>密码</span>
              <input
                v-model="loginForm.password"
                name="password"
                type="password"
                placeholder="请输入登录密码"
                autocomplete="current-password"
                required
              />
            </label>
            <div class="auth-helper">
              <span>已注册账号可直接登录。</span>
              <button type="button" class="auth-forgot-link" @click="setMode('reset')">忘记密码？</button>
            </div>
            <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
            <button class="primary-btn auth-submit-btn" type="submit" :disabled="submitting">
              {{ submitting ? "登录中..." : "登录 RedBase" }}
            </button>
          </form>

          <form v-else-if="activeMode === 'reset'" id="resetForm" class="auth-form" @submit.prevent="handleResetPassword">
            <label>
              <span>手机号</span>
              <input v-model="resetForm.phone" name="phone" type="tel" placeholder="请输入注册手机号" autocomplete="tel" required />
            </label>
            <div class="auth-code-row">
              <label class="auth-code-field">
                <span>验证码</span>
                <input
                  v-model="resetForm.code"
                  name="code"
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="6 位验证码"
                  autocomplete="one-time-code"
                  required
                />
              </label>
              <button
                class="auth-code-btn"
                type="button"
                :disabled="sendingCode || cooldownSeconds > 0 || !/^1\d{10}$/.test(resetForm.phone)"
                @click="handleSendCodeForReset"
              >
                {{ cooldownSeconds > 0 ? `${cooldownSeconds}s` : sendingCode ? "发送中..." : "获取验证码" }}
              </button>
            </div>
            <label>
              <span>新密码</span>
              <input
                v-model="resetForm.password"
                name="password"
                type="password"
                placeholder="至少 6 位新密码"
                autocomplete="new-password"
                required
              />
            </label>
            <p v-if="codeNotice" class="code-notice" role="status">{{ codeNotice }}</p>
            <p v-if="resetSuccess" class="form-success" role="status">密码已重置，请用新密码重新登录。</p>
            <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
            <button class="primary-btn auth-submit-btn" type="submit" :disabled="submitting">
              {{ submitting ? "重置中..." : "重置密码" }}
            </button>
            <div class="auth-helper">
              <button type="button" class="auth-forgot-link" @click="setMode('login')">返回登录</button>
            </div>
          </form>

          <p v-if="activeMode === 'register' && errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
