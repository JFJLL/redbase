<template>
  <div ref="root" class="admin-select" :class="{ 'is-open': open, 'is-disabled': disabled }" :data-test="testId">
    <button
      type="button"
      class="admin-select__trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :aria-activedescendant="open ? optionId(activeIndex) : undefined"
      :disabled="disabled"
      @click="toggle"
      @keydown="handleKeydown"
    >
      <span class="admin-select__value">{{ selectedOption?.label || placeholder }}</span>
      <svg class="admin-select__chevron" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m6 8 4 4 4-4" />
      </svg>
    </button>

    <div v-if="open" :id="listboxId" class="admin-select__menu" role="listbox" :aria-label="label">
      <button
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="option.value"
        type="button"
        class="admin-select__option"
        :class="{ 'is-selected': option.value === modelValue, 'is-active': index === activeIndex }"
        role="option"
        :aria-selected="option.value === modelValue"
        :data-value="option.value"
        @mouseenter="activeIndex = index"
        @click="selectOption(option.value)"
      >
        <span class="admin-select__option-copy">
          <span class="admin-select__option-label">{{ option.label }}</span>
          <span v-if="option.description" class="admin-select__option-description">{{ option.description }}</span>
        </span>
        <svg v-if="option.value === modelValue" class="admin-select__check" viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5 10 3 3 7-7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

export interface AdminSelectOption {
  value: string;
  label: string;
  description?: string;
}

const props = withDefaults(defineProps<{
  modelValue: string;
  options: AdminSelectOption[];
  label: string;
  testId: string;
  placeholder?: string;
  disabled?: boolean;
}>(), {
  placeholder: "请选择",
  disabled: false,
});

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "change", value: string): void;
}>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(0);
const listboxId = `${props.testId}-listbox`;
const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));

function optionId(index: number): string {
  return `${props.testId}-option-${index}`;
}

function selectedIndex(): number {
  const index = props.options.findIndex((option) => option.value === props.modelValue);
  return index >= 0 ? index : 0;
}

function openMenu(): void {
  if (props.disabled || props.options.length === 0) return;
  activeIndex.value = selectedIndex();
  open.value = true;
}

function closeMenu(): void {
  open.value = false;
}

function toggle(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function moveActive(delta: number): void {
  if (!props.options.length) return;
  const next = activeIndex.value + delta;
  activeIndex.value = (next + props.options.length) % props.options.length;
}

function selectOption(value: string): void {
  if (props.disabled) return;
  emit("update:modelValue", value);
  emit("change", value);
  closeMenu();
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) openMenu();
    else moveActive(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Home" && open.value) {
    event.preventDefault();
    activeIndex.value = 0;
    return;
  }
  if (event.key === "End" && open.value) {
    event.preventDefault();
    activeIndex.value = Math.max(0, props.options.length - 1);
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && open.value) {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) selectOption(option.value);
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    closeMenu();
  }
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!root.value?.contains(event.target as Node)) closeMenu();
}

onMounted(() => document.addEventListener("pointerdown", handleDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", handleDocumentPointerDown));
</script>

<style scoped>
.admin-select {
  position: relative;
  min-width: 132px;
  color: #1f2937;
}

.admin-select__trigger {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 7px;
  background: #ffffff;
  color: #374151;
  font: inherit;
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.admin-select__trigger:hover:not(:disabled) {
  border-color: #9ca3af;
  background: #fffafa;
}

.admin-select__trigger:focus-visible,
.is-open .admin-select__trigger {
  outline: none;
  border-color: #e11d48;
  box-shadow: 0 0 0 3px rgba(225, 29, 72, 0.12);
}

.admin-select__trigger:disabled {
  cursor: not-allowed;
  color: #9ca3af;
  background: #f9fafb;
}

.admin-select__value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-select__chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s ease;
}

.is-open .admin-select__chevron {
  transform: rotate(180deg);
}

.admin-select__menu {
  position: absolute;
  z-index: 80;
  top: calc(100% + 7px);
  left: 0;
  min-width: 100%;
  width: max-content;
  max-width: 280px;
  padding: 6px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 14px 35px rgba(15, 23, 42, 0.14), 0 3px 8px rgba(15, 23, 42, 0.08);
}

.admin-select__option {
  width: 100%;
  min-width: 150px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #374151;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.admin-select__option.is-active,
.admin-select__option:hover {
  background: #fff1f2;
  color: #be123c;
}

.admin-select__option.is-selected {
  color: #be123c;
  font-weight: 600;
}

.admin-select__option-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.admin-select__option-label {
  font-size: 13px;
  white-space: nowrap;
}

.admin-select__option-description {
  color: #9ca3af;
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}

.admin-select__check {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: #e11d48;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
