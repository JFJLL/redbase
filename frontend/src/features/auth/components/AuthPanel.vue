<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import { sendCode } from "../api";
import FeishuLoginButtons from "./FeishuLoginButtons.vue";

type AuthMode = "login" | "register";

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
const loginForm = reactive({ phone: "", password: "" });
const registerForm = reactive({ phone: "", name: "", password: "" });

function setMode(mode: AuthMode): void {
  activeMode.value = mode;
  errorMessage.value = "";
  codeNotice.value = "";
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

async function handleLogin(): Promise<void> {
  submitting.value = true;
  errorMessage.value = "";
  try {
    await auth.login(loginForm.phone, loginForm.password);
    await goToWorkspace();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
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
    });
    await goToWorkspace();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}

// The legacy register surface did not show a verification-code field because
// the backend registration contract is phone + name + password. Keep the
// existing dev-only send-code behavior available to automated callers without
// changing that reference surface.
async function handleSendCode(): Promise<void> {
  sendingCode.value = true;
  errorMessage.value = "";
  codeNotice.value = "";
  try {
    const data = await sendCode(registerForm.phone);
    codeNotice.value = data.demoCode ? `${data.message}（验证码：${data.demoCode}）` : data.message;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    sendingCode.value = false;
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
        <button class="auth-modal-close" type="button" aria-label="返回官网" @click="close">×</button>
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
          <FeishuLoginButtons :next="afterAuthTarget() || '/app/brands'" />

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

            <button
              class="auth-code-compat"
              type="button"
              :disabled="sendingCode"
              aria-hidden="true"
              tabindex="-1"
              @click="handleSendCode"
            >
              {{ sendingCode ? "发送中..." : "获取验证码" }}
            </button>
            <p v-if="codeNotice" class="code-notice auth-code-compat" role="status">{{ codeNotice }}</p>
          </form>

          <form v-else id="loginForm" class="auth-form" @submit.prevent="handleLogin">
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
            <div class="auth-helper">已注册账号可直接登录。</div>
            <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
            <button class="primary-btn auth-submit-btn" type="submit" :disabled="submitting">
              {{ submitting ? "登录中..." : "登录 RedBase" }}
            </button>
          </form>

          <p v-if="activeMode === 'register' && errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
