<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export interface StudioSelectOption {
  value: string;
  label: string;
  badge?: string;
}

const props = defineProps<{
  modelValue: string;
  options: StudioSelectOption[];
  disabled?: boolean;
  testId: string;
  label: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
}>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const selected = computed(() => props.options.find((option) => option.value === props.modelValue) || props.options[0]);

function close() {
  open.value = false;
}

function toggle() {
  if (!props.disabled) open.value = !open.value;
}

function select(value: string) {
  if (props.disabled) return;
  emit("update:modelValue", value);
  close();
}

function handleNativeChange(event: Event) {
  select((event.target as HTMLSelectElement).value);
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close();
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") close();
}

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="studio-select" :class="{ open, disabled }">
    <select
      class="studio-select-native"
      :value="modelValue"
      :disabled="disabled"
      :data-test="testId"
      :aria-label="label"
      aria-hidden="true"
      tabindex="-1"
      @change="handleNativeChange"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}{{ option.badge ? ` · ${option.badge}` : "" }}
      </option>
    </select>

    <button
      type="button"
      class="studio-select-trigger"
      :class="{ open }"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :data-test="`${testId}-trigger`"
      @click="toggle"
    >
      <span class="studio-select-value">
        <span>{{ selected?.label || "请选择" }}</span>
        <small v-if="selected?.badge" class="studio-select-badge">{{ selected.badge }}</small>
      </span>
      <span class="studio-select-arrow" aria-hidden="true"></span>
    </button>

    <div v-if="open" class="studio-select-menu" role="listbox" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="studio-select-option"
        :class="{ selected: option.value === modelValue }"
        role="option"
        :aria-selected="option.value === modelValue"
        :data-test="`${testId}-option-${option.value}`"
        @click="select(option.value)"
      >
        <span>{{ option.label }}</span>
        <small v-if="option.badge" class="studio-select-badge">{{ option.badge }}</small>
        <span v-if="option.value === modelValue" class="studio-select-check" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.studio-select {
  position: relative;
  min-width: 0;
  font-family: inherit;
}

.studio-select-native {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.studio-select-trigger {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid #dfd2cc;
  border-radius: 9px;
  background: linear-gradient(180deg, #ffffff 0%, #fffaf8 100%);
  color: #3f3335;
  box-shadow: 0 1px 0 rgba(124, 45, 50, 0.03);
  font: inherit;
  font-size: 12.5px;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
}

.studio-select-trigger:hover:not(:disabled),
.studio-select-trigger.open {
  border-color: #b9827e;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(124, 45, 50, 0.08);
}

.studio-select-trigger:focus-visible {
  outline: 2px solid rgba(124, 45, 50, 0.32);
  outline-offset: 2px;
}

.studio-select-trigger:disabled {
  color: #9b8f91;
  background: #f7f2ef;
  cursor: not-allowed;
}

.studio-select-value {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.studio-select-badge {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 0 7px;
  border: 1px solid #f0cfb1;
  border-radius: 999px;
  background: #fff1df;
  color: #a45f28;
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
  white-space: nowrap;
}

.studio-select-arrow {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid #7c6265;
  border-bottom: 1.5px solid #7c6265;
  transform: translateY(-2px) rotate(45deg);
  transition: transform 0.16s ease;
}

.studio-select-trigger.open .studio-select-arrow {
  transform: translateY(2px) rotate(225deg);
}

.studio-select-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 7px);
  left: 0;
  right: 0;
  display: grid;
  gap: 3px;
  max-height: 240px;
  padding: 6px;
  overflow-y: auto;
  border: 1px solid #dfd2cc;
  border-radius: 10px;
  background: rgba(255, 253, 252, 0.98);
  box-shadow: 0 14px 34px rgba(74, 41, 45, 0.18);
  backdrop-filter: blur(10px);
}

.studio-select-option {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #4a3b3e;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}

.studio-select-option:hover,
.studio-select-option.selected {
  background: #f8ece8;
  color: #7c2d32;
}

.studio-select-check {
  margin-left: auto;
  color: #7c2d32;
  font-size: 12px;
  font-weight: 900;
}
</style>
