<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export interface CustomSelectOption {
  value?: string | number | null;
  label?: string;
  [key: string]: unknown;
}

const props = defineProps<{
  modelValue?: string | number | null;
  options: readonly (CustomSelectOption | string | number)[];
  label: string;
  testId?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "change", value: string): void;
}>();

const root = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const activeIndex = ref(-1);

const normalizedOptions = computed<Array<{ value: string; label: string }>>(() => {
  const normalized: Array<{ value: string; label: string }> = [];
  const seenValues = new Set<string>();

  for (const opt of props.options) {
    if (typeof opt === "string" || typeof opt === "number") {
      const s = String(opt);
      if (seenValues.has(s)) continue;
      seenValues.add(s);
      normalized.push({ value: s, label: s === "all" ? "全部" : s });
      continue;
    }
    const val = String(opt.value ?? "");
    const lab = String(opt.label ?? val ?? "");
    if (seenValues.has(val)) continue;
    seenValues.add(val);
    normalized.push({ value: val, label: lab || (val === "all" ? "全部" : val) });
  }

  return normalized;
});

const currentLabel = computed(() => {
  const strVal = String(props.modelValue ?? "");
  const match = normalizedOptions.value.find((opt) => opt.value === strVal);
  return match ? match.label : strVal || "全部";
});

function openMenu(): void {
  if (props.disabled) return;
  isOpen.value = true;
  const strVal = String(props.modelValue ?? "");
  activeIndex.value = Math.max(
    0,
    normalizedOptions.value.findIndex((opt) => opt.value === strVal),
  );
}

function closeMenu(): void {
  isOpen.value = false;
  activeIndex.value = -1;
}

function toggleMenu(): void {
  if (isOpen.value) closeMenu();
  else openMenu();
}

function selectOption(val: string): void {
  emit("update:modelValue", val);
  emit("change", val);
  closeMenu();
}

function onNativeChange(e: Event): void {
  const target = e.target as HTMLSelectElement;
  selectOption(target.value);
}

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  if (e.key === "Escape") {
    closeMenu();
    return;
  }
  if (!isOpen.value && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openMenu();
    return;
  }
  if (isOpen.value) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex.value = (activeIndex.value + 1) % normalizedOptions.value.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex.value = (activeIndex.value - 1 + normalizedOptions.value.length) % normalizedOptions.value.length;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (activeIndex.value >= 0 && activeIndex.value < normalizedOptions.value.length) {
        selectOption(normalizedOptions.value[activeIndex.value]!.value);
      }
    }
  }
}

function handleClickOutside(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) {
    closeMenu();
  }
}

onMounted(() => {
  document.addEventListener("click", handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleClickOutside);
});
</script>

<template>
  <div ref="root" class="custom-select-field" :class="{ 'is-open': isOpen, 'is-disabled': disabled }" @keydown="onKeydown">
    <span class="custom-select-label">{{ label }}</span>
    <button
      type="button"
      class="custom-select-trigger"
      :class="{ 'has-focus': isOpen }"
      :disabled="disabled"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click="toggleMenu()"
    >
      <span class="custom-select-value">{{ currentLabel }}</span>
      <span class="custom-select-icon-wrap" :class="{ 'is-rotated': isOpen }">
        <svg class="custom-select-chevron" width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>

    <!-- Hidden native select to maintain form and automated test compatibility -->
    <select
      class="custom-select-native"
      :data-test="testId"
      :value="modelValue"
      :disabled="disabled"
      tabindex="-1"
      aria-hidden="true"
      @change="onNativeChange"
    >
      <option v-for="opt in normalizedOptions" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>

    <!-- Beautiful floating menu -->
    <transition name="dropdown-pop">
      <div v-if="isOpen" class="custom-select-dropdown" role="listbox">
        <div
          v-for="(opt, idx) in normalizedOptions"
          :key="opt.value"
          class="custom-select-option"
          :class="{ 'is-selected': opt.value === String(modelValue ?? ''), 'is-active': idx === activeIndex }"
          role="option"
          :aria-selected="opt.value === String(modelValue ?? '')"
          @click.stop="selectOption(opt.value)"
        >
          <span class="custom-select-option-text">{{ opt.label }}</span>
          <svg
            v-if="opt.value === String(modelValue ?? '')"
            class="custom-select-check"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.custom-select-field {
  position: relative;
  display: grid;
  gap: 6px;
  min-width: 0;
}

.custom-select-label {
  color: #7a6669;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  user-select: none;
}

.custom-select-trigger {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-width: 130px;
  height: 40px;
  padding: 0 14px;
  border: 1px solid #ead7da;
  border-radius: 10px;
  background: #ffffff;
  color: #2c2526;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  outline: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
}

.custom-select-trigger:hover:not(:disabled) {
  border-color: #dca5ac;
  background-color: #fffafa;
}

.custom-select-trigger.has-focus,
.custom-select-trigger:focus-visible {
  border-color: #d6394d;
  box-shadow: 0 0 0 3px rgba(214, 57, 77, 0.14);
}

.custom-select-trigger:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.custom-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-select-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #c53043;
  transition: transform 0.2s ease;
}

.custom-select-icon-wrap.is-rotated {
  transform: rotate(180deg);
}

.custom-select-native {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
  pointer-events: none;
  opacity: 0;
}

.custom-select-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 80;
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid #f1d8db;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 12px 32px rgba(189, 45, 60, 0.14), 0 2px 8px rgba(0, 0, 0, 0.05);
}

.custom-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  color: #3b2c2e;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}

.custom-select-option:hover,
.custom-select-option.is-active {
  background-color: #fff0f2;
  color: #c53043;
}

.custom-select-option.is-selected {
  background-color: #fce8eb;
  color: #b82337;
  font-weight: 700;
}

.custom-select-check {
  color: #c53043;
  flex-shrink: 0;
}

.dropdown-pop-enter-active,
.dropdown-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-pop-enter-from,
.dropdown-pop-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}
</style>
