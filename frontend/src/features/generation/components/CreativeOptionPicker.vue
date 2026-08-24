<script setup lang="ts">
import { computed, ref } from "vue";
import type { CreativeOption } from "../api";

const props = defineProps<{
  title: string;
  value: string;
  options: readonly CreativeOption[];
  testId?: string;
}>();

const emit = defineEmits<{
  (e: "update:value", value: string): void;
}>();

const isOpen = ref(false);

const selectedOption = computed(() => {
  return props.options.find((opt) => opt.value === props.value) || props.options[0];
});

function openPicker() {
  isOpen.value = true;
}

function closePicker() {
  isOpen.value = false;
}

function selectOption(val: string) {
  emit("update:value", val);
  isOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closePicker();
  }
}
</script>

<template>
  <div class="creative-option-picker" :data-test="testId" @keydown="handleKeydown">
    <div class="picker-summary-card" :data-test="testId ? testId + '-summary' : undefined" @click="openPicker">
      <div class="picker-summary-info">
        <span class="picker-label">{{ title }}</span>
        <strong class="picker-current-label" :data-test="testId ? testId + '-label' : undefined">
          {{ selectedOption?.label || "智能匹配" }}
        </strong>
        <span class="picker-current-desc">
          {{ selectedOption?.description || "" }}
        </span>
      </div>
      <button
        type="button"
        class="picker-change-btn"
        :data-test="testId ? testId + '-change' : undefined"
        :aria-expanded="isOpen"
        @click.stop="openPicker"
      >
        更换
      </button>
    </div>

    <!-- 弹窗/浮层单选列表 -->
    <div
      v-if="isOpen"
      class="picker-modal-backdrop"
      :data-test="testId ? testId + '-modal' : undefined"
      @click.self="closePicker"
    >
      <div class="picker-modal-content" role="dialog" aria-modal="true" :aria-label="title">
        <header class="picker-modal-head">
          <h3>选择{{ title }}</h3>
          <button
            type="button"
            class="picker-modal-close"
            :data-test="testId ? testId + '-modal-close' : undefined"
            aria-label="关闭选择器"
            @click="closePicker"
          >
            ×
          </button>
        </header>

        <fieldset class="picker-fieldset">
          <legend class="sr-only">{{ title }}</legend>
          <label
            v-for="option in options"
            :key="option.value"
            class="picker-option-row"
            :class="{ 'is-selected': option.value === value }"
            :data-test="testId ? testId + '-option-' + option.value : undefined"
            @click.prevent="selectOption(option.value)"
          >
            <input
              type="radio"
              :name="(testId || 'creative') + '-radio'"
              :value="option.value"
              :checked="option.value === value"
              class="picker-radio-input"
            />
            <div class="picker-option-text">
              <strong class="picker-option-title">{{ option.label }}</strong>
              <span class="picker-option-desc">{{ option.description }}</span>
            </div>
          </label>
        </fieldset>
      </div>
    </div>
  </div>
</template>

<style scoped>
.creative-option-picker {
  display: flex;
  flex-direction: column;
  position: relative;
}

.picker-summary-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--workspace-border, rgba(50, 37, 41, 0.1));
  border-radius: var(--workspace-radius, 8px);
  background: var(--workspace-surface, #ffffff);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.picker-summary-card:hover {
  border-color: rgba(216, 68, 68, 0.35);
  background: #fffdfc;
}

.picker-summary-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.picker-label {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--workspace-text-muted, #7c7074);
}

.picker-current-label {
  font-size: 13.5px;
  color: var(--workspace-text, #222);
}

.picker-current-desc {
  font-size: 12px;
  color: var(--workspace-text-muted, #7c7074);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-change-btn {
  padding: 5px 12px;
  border: 1px solid var(--workspace-border, rgba(50, 37, 41, 0.15));
  border-radius: 6px;
  background: #fff;
  color: var(--workspace-text, #333);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.picker-change-btn:hover {
  border-color: var(--workspace-brand, #d83b46);
  color: var(--workspace-brand, #d83b46);
  background: #fff8f7;
}

.picker-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(30, 20, 22, 0.4);
  backdrop-filter: blur(2px);
}

.picker-modal-content {
  width: min(540px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  border-radius: var(--workspace-radius, 10px);
  border: 1px solid var(--workspace-border, #eae5e3);
  background: #fff;
  color: var(--workspace-text, #222);
  box-shadow: 0 16px 48px rgba(45, 25, 30, 0.18);
  overflow: hidden;
}

.picker-modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--workspace-border, #eae5e3);
}

.picker-modal-head h3 {
  margin: 0;
  font-size: 1.1rem;
}

.picker-modal-close {
  border: none;
  background: transparent;
  color: var(--workspace-text-muted, #7c7074);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
}

.picker-fieldset {
  margin: 0;
  padding: 16px 20px 20px;
  border: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.picker-option-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--workspace-border, #eae5e3);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.picker-option-row:hover {
  border-color: rgba(216, 68, 68, 0.3);
  background: #fffdfc;
}

.picker-option-row.is-selected {
  border-color: var(--workspace-brand, #d83b46);
  background: #fff5f3;
  box-shadow: inset 0 0 0 1px rgba(216, 59, 70, 0.12);
}

.picker-radio-input {
  margin-top: 3px;
  cursor: pointer;
  accent-color: var(--workspace-brand, #d83b46);
}

.picker-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.picker-option-title {
  font-size: 13.5px;
  color: var(--workspace-text, #222);
}

.picker-option-row.is-selected .picker-option-title {
  color: var(--workspace-brand, #d83b46);
}

.picker-option-desc {
  font-size: 12px;
  color: var(--workspace-text-muted, #7c7074);
  line-height: 1.4;
}
</style>
