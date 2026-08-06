<script setup lang="ts">
// 共享改图面板：任何已生成图片（朋友圈/公众号/风格化/组图单页/历史原图/历史改图结果）
// 都可作为来源。提示词 → POST /api/image-edits → 轮询 → 结果与积分更新。
import { computed } from "vue";
import { useImageEdit, type ImageEditTarget } from "../composables/useImageEdit";
import { safeImageSrc } from "../api";

const props = defineProps<{
  target: ImageEditTarget | null;
  /** 面板标题，默认“继续改图”。 */
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
      <span>{{ label || "继续改图提示词" }}</span>
      <textarea
        v-model="prompt"
        rows="2"
        data-test="image-edit-prompt"
        :disabled="busy"
        placeholder="描述希望修改的内容（例如：把背景换成夜晚咖啡馆）"
      ></textarea>
    </label>
    <button
      type="button"
      class="secondary-btn"
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
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--workspace-border, #e3e6ea);
  border-radius: var(--workspace-radius, 10px);
  background: var(--workspace-surface-soft, #f6f8fa);
}

.image-edit-status {
  color: var(--workspace-muted, #687385);
  font-size: 0.9rem;
}

.image-edit-status.is-done {
  color: var(--workspace-success, #1d7f4c);
}

.image-edit-error {
  color: var(--workspace-danger, #c0392b);
  font-size: 0.9rem;
}

.image-edit-result {
  display: block;
  max-width: 220px;
  margin-top: 8px;
  border-radius: 8px;
}

.image-edit-hint {
  margin: 0;
  color: var(--workspace-muted, #687385);
  font-size: 0.85rem;
}

.form-field {
  display: grid;
  gap: 4px;
}

.form-field textarea {
  min-height: 56px;
  resize: vertical;
}
</style>
