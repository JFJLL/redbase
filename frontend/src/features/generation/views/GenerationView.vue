<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { pollImageJob, submitImageEdit, type ImageConceptResult } from "../api";

// 生图任务：改图提交 + 任务轮询（与旧版 bindImageEditActions / pollImageJob 语义一致）。
// 轮询使用 abort scope 的 signal，组件卸载与退出登录时自动停止。
const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const IMAGE_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"];

const form = reactive({
  imageUrl: "",
  prompt: "",
  title: "",
  aspectRatio: "",
});

type JobPhase = "idle" | "submitting" | "polling" | "done" | "error";
const phase = ref<JobPhase>("idle");
const statusMessage = ref("");
const errorMessage = ref("");
const jobId = ref("");
const result = ref<ImageConceptResult | null>(null);

const busy = computed(() => phase.value === "submitting" || phase.value === "polling");

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

async function submit() {
  if (busy.value) return;
  errorMessage.value = "";
  const prompt = form.prompt.trim();
  if (!prompt) {
    errorMessage.value = "请先填写改图提示词。";
    return;
  }
  const signal = scope.signalFor("image-edit");
  phase.value = "submitting";
  statusMessage.value = "改图任务已提交，正在等待结果...";
  result.value = null;
  try {
    const submitResult = await submitImageEdit(
      {
        imageUrl: form.imageUrl.trim(),
        prompt,
        title: form.title.trim(),
        aspectRatio: form.aspectRatio || undefined,
      },
      signal,
    );
    if (submitResult.user) auth.user = submitResult.user;
    if (!submitResult.jobId) throw new Error("改图任务创建失败");
    jobId.value = submitResult.jobId;
    phase.value = "polling";
    const concept = await pollImageJob(submitResult.jobId, {
      signal,
      onUser: (user) => {
        auth.user = user;
      },
    });
    result.value = concept;
    phase.value = "done";
    statusMessage.value = "改图完成，可继续追加提示词。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    phase.value = "error";
    statusMessage.value = "";
    errorMessage.value = `改图失败：${(error as Error).message}`;
  }
}
</script>

<template>
  <section class="generation-view">
    <header class="view-header">
      <h1>生图任务</h1>
      <p class="view-subtitle">提交改图任务并跟踪生成状态，生成结果会自动保存到历史生成。</p>
    </header>

    <form class="generation-form" @submit.prevent="submit">
      <label class="form-field">
        <span>原图地址</span>
        <input v-model="form.imageUrl" type="text" name="imageUrl" placeholder="/api/generated-images/... 或历史图片地址" />
      </label>
      <label class="form-field">
        <span>改图提示词</span>
        <textarea v-model="form.prompt" name="prompt" rows="3" placeholder="描述希望修改的内容"></textarea>
      </label>
      <label class="form-field">
        <span>标题（可选）</span>
        <input v-model="form.title" type="text" name="title" />
      </label>
      <label class="form-field">
        <span>宽高比（可选）</span>
        <select v-model="form.aspectRatio" name="aspectRatio">
          <option value="">默认</option>
          <option v-for="ratio in IMAGE_ASPECT_RATIOS" :key="ratio" :value="ratio">{{ ratio }}</option>
        </select>
      </label>
      <button type="submit" class="primary-btn" :disabled="busy">
        {{ busy ? "任务进行中..." : "提交改图任务" }}
      </button>
    </form>

    <p v-if="statusMessage" class="job-status" data-test="job-status">{{ statusMessage }}</p>
    <p v-if="errorMessage" class="job-error" data-test="job-error">{{ errorMessage }}</p>

    <figure v-if="result && (result.imageUrl || result.previewUrl)" class="job-result">
      <img :src="String(result.imageUrl || result.previewUrl)" alt="改图结果" loading="lazy" decoding="async" />
      <figcaption v-if="result.generationId || result.persisted">已保存至历史生成</figcaption>
    </figure>
  </section>
</template>

<style scoped>
.generation-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}

.view-header h1 {
  margin: 0 0 4px;
  font-size: 22px;
}

.view-subtitle {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.generation-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.form-field input,
.form-field textarea,
.form-field select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 14px;
  font-family: inherit;
}

.primary-btn {
  align-self: flex-start;
  background: var(--color-brand);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  padding: 10px 20px;
  font-size: 14px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.job-status {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.job-error {
  color: var(--color-brand);
  font-size: 13px;
}

.job-result img {
  max-width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.job-result figcaption {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 4px;
}
</style>
