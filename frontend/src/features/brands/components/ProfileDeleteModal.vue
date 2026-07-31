<script setup lang="ts">
import { ref, watch } from "vue";

// Delete confirmation dialog. Copy is ported verbatim from the legacy
// #brandDeleteModal markup and openBrandDeleteModal() in public/app.js.

const props = defineProps<{
  open: boolean;
  brandName: string;
  /** How many /api/history generations belong to this brand. */
  generationCount: number;
  deleting: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm", deleteGenerations: boolean): void;
}>();

const deleteGenerations = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) deleteGenerations.value = false;
  },
);
</script>

<template>
  <div v-if="open" class="modal-mask is-open" @click.self="emit('close')">
    <div class="modal-panel brand-delete-modal-panel">
      <div class="modal-head">
        <div>
          <div class="modal-kicker">删除品牌档案</div>
          <h2>删除「{{ brandName }}」</h2>
          <p>删除后该品牌档案、趋势分析和内容选题会被移除；历史生成记录默认保留。</p>
        </div>
        <button class="modal-close" type="button" @click="emit('close')">×</button>
      </div>

      <div class="brand-delete-body">
        <label class="brand-delete-option">
          <input v-model="deleteGenerations" type="checkbox" :disabled="generationCount === 0" />
          <span>
            <strong>同时删除该品牌的历史生成记录</strong>
            <small>
              {{ generationCount
                ? `当前品牌有 ${generationCount} 条历史生成记录；勾选后会同步删除对应数据库记录和图片文件。`
                : "当前品牌没有可删除的历史生成记录。" }}
            </small>
          </span>
        </label>
        <div class="form-actions">
          <button class="secondary-btn" type="button" :disabled="deleting" @click="emit('close')">取消</button>
          <button
            class="primary-btn danger-primary-btn"
            type="button"
            :disabled="deleting"
            @click="emit('confirm', deleteGenerations)"
          >
            {{ deleting ? "删除中..." : "确认删除" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  z-index: 100;
  background: rgba(5, 5, 10, 0.72);
}

.modal-panel {
  width: min(520px, 100%);
  padding: 28px;
  border-radius: 16px;
  background: var(--color-surface, #fff);
}

.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 22px;
}

.modal-kicker {
  color: var(--color-brand, #ff2442);
  font-size: 0.95rem;
  margin-bottom: 8px;
}

.modal-head h2 {
  margin: 0 0 10px;
}

.modal-head p {
  margin: 0;
  color: var(--color-text-secondary, #646a73);
}

.modal-close {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 50%;
  background: rgba(31, 34, 43, 0.08);
  font-size: 1.4rem;
  cursor: pointer;
}

.brand-delete-body {
  display: grid;
  gap: 20px;
}

.brand-delete-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 14px;
}

.brand-delete-option span {
  display: grid;
  gap: 4px;
}

.brand-delete-option small {
  color: var(--color-text-secondary, #646a73);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.primary-btn {
  border: 0;
  border-radius: 8px;
  padding: 10px 20px;
  background: var(--color-brand, #ff2442);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.danger-primary-btn {
  background: #d64545;
}

.secondary-btn {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 10px 20px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.primary-btn:disabled,
.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Legacy light-workspace destructive modal parity. */
.modal-mask {
  padding: 28px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.modal-panel {
  width: min(560px, 100%);
  padding: 28px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.modal-head {
  gap: 22px;
  margin-bottom: 22px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--workspace-border);
}

.modal-kicker {
  margin-bottom: 8px;
  color: #b72e3a;
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.modal-head h2 {
  margin: 0 0 10px;
  color: var(--workspace-text);
  font-size: 2.1rem;
  line-height: 1.2;
}

.modal-head p {
  color: var(--workspace-text-muted);
  font-size: 0.95rem;
  line-height: 1.6;
}

.modal-close {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text-muted);
  font-size: 1.25rem;
}

.modal-close:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
  color: var(--workspace-brand-ink);
}

.brand-delete-body {
  gap: 20px;
}

.brand-delete-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  padding: 16px;
  border: 1px solid rgba(183, 46, 58, 0.12);
  border-radius: var(--workspace-radius);
  background: rgba(255, 248, 248, 0.88);
  color: #4c4244;
}

.brand-delete-option input {
  width: 18px;
  height: 18px;
  margin-top: 3px;
  accent-color: var(--workspace-brand);
}

.brand-delete-option span {
  gap: 6px;
}

.brand-delete-option strong {
  color: #2c2225;
  font-size: 0.98rem;
}

.brand-delete-option small {
  color: #887174;
  line-height: 1.55;
}

.form-actions {
  gap: 12px;
}

.primary-btn,
.secondary-btn {
  min-height: 48px;
  padding: 0 20px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.95rem;
}

.danger-primary-btn {
  background: #b72e3a;
  color: #fff;
}

.danger-primary-btn:hover:not(:disabled) {
  background: #a52632;
}

.secondary-btn {
  border-color: var(--workspace-border);
  background: #fff;
  color: var(--workspace-text);
}

.secondary-btn:hover:not(:disabled) {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}
</style>
