<script setup lang="ts">
// 共享改图面板：任何已生成图片（朋友圈/公众号/风格化/组图单页/历史原图/历史改图结果）
// 都可作为来源。提示词 → POST /api/image-edits → 轮询 → 结果与积分更新。
import { computed } from "vue";
import { useImageEdit, type ImageEditTarget } from "../composables/useImageEdit";
import { safeImageSrc } from "../api";

const props = defineProps<{
  target: ImageEditTarget | null;
  /** 面板标题，默认"继续改图"。 */
  label?: string;
}>();

const emit = defineEmits<{
  (event: "edited", result: Record<string, unknown>): void;
}>();

const { prompt, phase, status, error, result, busy, canSubmit, submitEdit } = useImageEdit(
  () => props.target,
);
const imageSrc = computed(() => safeImageSrc(props.target?.imageUrl));

function submit(): void {
  void submitEdit().then((success) => {
    if (success && result.value) emit("edited", result.value);
  });
}
</script>

<template>
  <div class="image-edit-panel" data-test="image-edit-panel">
    <div v-if="phase === 'running'" class="image-edit-status" data-test="image-edit-status">
      {{ status }}
    </div>
    <div v-else-if="phase === 'done'" class="image-edit-status is-done" data-test="image-edit-status">
      {{ status }}
      <img
        v-if="safeImageSrc(result?.imageUrl || result?.previewUrl)"
        :src="safeImageSrc(result?.imageUrl || result?.previewUrl)"
        alt="改图结果"
        class="image-edit-result"
      />
    </div>
    <div v-if="error" class="image-edit-error" data-test="image-edit-error">
      {{ error }}
    </div>
    <label class="form-field">
      <span class="form-field-label">{{ label || "继续改图提示词" }}</span>
      <textarea
        v-model="prompt"
        rows="3"
        class="form-field-textarea"
        data-test="image-edit-prompt"
        :disabled="busy"
        placeholder="描述希望修改的内容（例如：把背景换成夜晚咖啡馆）"
      ></textarea>
    </label>
    <button
      type="button"
      class="image-edit-submit"
      data-test="image-edit-submit"
      :disabled="!canSubmit"
      @click="submit"
    >
      {{ busy ? "改图中..." : "提交改图" }}
    </button>
    <p v-if="!imageSrc" class="image-edit-hint">请先选择一张已生成的图片。</p>
  </div>
</template>

<style scoped>
.image-edit-panel {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius, 10px);
  background: var(--workspace-surface-soft, #faf7f5);
}

.image-edit-status {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius-sm, 8px);
  background: var(--workspace-surface, #ffffff);
  color: var(--workspace-text-muted, #6f6368);
  font-size: 0.86rem;
  line-height: 1.6;
}

.image-edit-status.is-done {
  border-color: rgba(29, 127, 76, 0.25);
  background: #f1faf4;
  color: var(--workspace-success, #1d7f4c);
}

.image-edit-error {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid rgba(192, 57, 43, 0.18);
  border-radius: var(--workspace-radius-sm, 8px);
  background: #fff1f1;
  color: var(--workspace-danger, #c0392b);
  font-size: 0.86rem;
  line-height: 1.6;
}

.image-edit-result {
  display: block;
  max-width: 220px;
  margin-top: 8px;
  border-radius: var(--workspace-radius-sm, 8px);
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
}

.image-edit-hint {
  margin: 0;
  color: var(--workspace-text-muted, #6f6368);
  font-size: 0.85rem;
}

.form-field {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.form-field-label {
  color: var(--workspace-brand-ink, #bb3f3f);
  font-size: 0.84rem;
  font-weight: 700;
}

.form-field-textarea {
  width: 100%;
  min-width: 0;
  min-height: 84px;
  padding: 10px 12px;
  border: 1px solid var(--workspace-border-strong, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius, 8px);
  background: var(--workspace-surface, #ffffff);
  color: var(--workspace-text, #120f10);
  font: inherit;
  font-size: 0.9rem;
  font-weight: 500;
  line-height: 1.65;
  resize: vertical;
  outline: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.form-field-textarea::placeholder {
  color: var(--workspace-text-faint, #8a7c80);
}

.form-field-textarea:focus {
  border-color: rgba(229, 72, 77, 0.48);
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.08);
}

.form-field-textarea:disabled {
  cursor: not-allowed;
  background: var(--workspace-surface-soft, #faf7f5);
  color: var(--workspace-text-muted, #6f6368);
}

.image-edit-submit {
  display: inline-flex;
  align-self: flex-start;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border: 1px solid var(--workspace-brand-border, rgba(216, 68, 68, 0.14));
  border-radius: var(--workspace-radius-sm, 6px);
  background: var(--workspace-surface, #ffffff);
  color: var(--workspace-text-body, #4b4244);
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.image-edit-submit:hover:not(:disabled) {
  border-color: rgba(216, 68, 68, 0.28);
  background: #fff8f7;
  color: var(--workspace-brand, #d84444);
}

.image-edit-submit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.16);
}

.image-edit-submit:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}
</style>
