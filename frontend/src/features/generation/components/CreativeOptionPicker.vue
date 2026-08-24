<script setup lang="ts">
import { computed } from "vue";
import type { CreativeOption } from "../api";

const props = withDefaults(
  defineProps<{
  title: string;
  hint?: string;
  name: string;
  value: string;
  options: readonly CreativeOption[];
  testId?: string;
  }>(),
  {
    hint: "",
    testId: "",
  },
);

const emit = defineEmits<{
  (e: "update:value", value: string): void;
}>();

const selectedOption = computed(() => {
  return props.options.find((opt) => opt.value === props.value) || props.options[0];
});

function selectOption(val: string) {
  if (val !== props.value) {
    emit("update:value", val);
  }
}
</script>

<template>
  <fieldset class="creative-option-picker" :data-test="testId">
    <legend class="picker-legend">
      <div class="picker-legend-header">
        <span class="picker-title">{{ title }}</span>
        <span v-if="hint" class="picker-hint">{{ hint }}</span>
      </div>
    </legend>

    <div class="picker-options-grid">
      <label
        v-for="option in options"
        :key="option.value"
        class="picker-option-card"
        :class="{ 'is-selected': option.value === value }"
        :data-test="testId ? `${testId}-option-${option.value}` : undefined"
      >
        <input
          type="radio"
          :name="name"
          :value="option.value"
          :checked="option.value === value"
          class="picker-radio-input"
          @change="selectOption(option.value)"
        />
        <span class="picker-radio-dot" aria-hidden="true"></span>
        <span class="picker-option-label">{{ option.label }}</span>
      </label>
    </div>

    <div class="picker-selected-desc" :data-test="testId ? `${testId}-desc` : undefined">
      <span class="picker-desc-text">{{ selectedOption?.description || "" }}</span>
    </div>
  </fieldset>
</template>

<style scoped>
.creative-option-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.09));
  border-radius: var(--workspace-radius-sm, 10px);
  background: var(--workspace-surface, #ffffff);
  min-width: 0;
}

.picker-legend {
  padding: 0;
  margin: 0 0 2px;
  width: 100%;
}

.picker-legend-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.picker-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--workspace-text, #31292b);
}

.picker-hint {
  font-size: 11.5px;
  color: var(--workspace-text-muted, #7c7074);
  font-weight: 400;
}

.picker-options-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.picker-option-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  min-height: 32px;
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius-sm, 6px);
  background: #ffffff;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.picker-option-card:hover {
  border-color: rgba(216, 59, 70, 0.35);
  background: #fffdfc;
}

.picker-option-card.is-selected {
  border-color: var(--workspace-brand, #d83b46);
  background: #fff5f3;
  color: var(--workspace-brand, #d83b46);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px rgba(216, 59, 70, 0.15);
}

.picker-radio-input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  pointer-events: none;
}

.picker-option-card:has(.picker-radio-input:focus-visible) {
  outline: 2px solid var(--workspace-brand, #d83b46);
  outline-offset: 1px;
}

.picker-radio-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--workspace-border, rgba(18, 16, 17, 0.25));
  background: #ffffff;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.picker-option-card.is-selected .picker-radio-dot {
  border-color: var(--workspace-brand, #d83b46);
  background: var(--workspace-brand, #d83b46);
  box-shadow: inset 0 0 0 2px #ffffff;
}

.picker-option-label {
  font-size: 12px;
  white-space: nowrap;
  line-height: 1.2;
}

.picker-selected-desc {
  padding: 6px 10px;
  border-radius: 6px;
  background: #fbf7f6;
  font-size: 11.5px;
  color: var(--workspace-text-muted, #7c7074);
  line-height: 1.45;
  min-height: 28px;
  display: flex;
  align-items: center;
}
</style>
