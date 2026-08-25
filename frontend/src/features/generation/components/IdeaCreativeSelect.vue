<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { CreativeOption } from "../api";

const props = defineProps<{
  label: string;
  modelValue: string;
  options: readonly CreativeOption[];
  testId: string;
  disabled?: boolean;
  disabledMessage?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
}>();

const root = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const selectedOption = computed(
  () => props.options.find((option) => option.value === props.modelValue) || props.options[0],
);

function focusOption(value = props.modelValue): void {
  void nextTick(() => {
    const option = Array.from(
      root.value?.querySelectorAll<HTMLButtonElement>("[data-option-value]") || [],
    ).find((button) => button.dataset.optionValue === value);
    option?.focus();
  });
}

function openMenu(): void {
  if (props.disabled) return;
  isOpen.value = true;
  focusOption();
}

function closeMenu({ restoreFocus = false } = {}): void {
  isOpen.value = false;
  if (restoreFocus) {
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>(".idea-creative-select-trigger")?.focus());
  }
}

function toggleMenu(): void {
  if (props.disabled) return;
  if (isOpen.value) closeMenu();
  else openMenu();
}

function choose(value: string): void {
  if (props.disabled) return;
  emit("update:modelValue", value);

  closeMenu({ restoreFocus: true });
}

function moveFocus(direction: 1 | -1): void {
  const currentIndex = Math.max(
    0,
    props.options.findIndex(
      (option) => root.value?.ownerDocument.activeElement?.getAttribute("data-option-value") === option.value,
    ),
  );
  const nextIndex = (currentIndex + direction + props.options.length) % props.options.length;
  focusOption(props.options[nextIndex]?.value);
}

function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveFocus(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusOption(event.key === "Home" ? props.options[0]?.value : props.options.at(-1)?.value);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (isOpen.value && !root.value?.contains(event.target as Node)) closeMenu();
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closeMenu();
  },
);

onMounted(() => document.addEventListener("pointerdown", handleDocumentPointerDown));

onBeforeUnmount(() => document.removeEventListener("pointerdown", handleDocumentPointerDown));
</script>

<template>
    <div ref="root" class="idea-creative-select" :class="{ 'is-open': isOpen, 'is-disabled': disabled }" :title="disabled ? disabledMessage : undefined">

    <span class="idea-creative-select-label">{{ label }}</span>
    <button
      type="button"
      class="idea-creative-select-trigger"
      :data-test="testId"
            :aria-expanded="isOpen"
      :aria-disabled="disabled || undefined"
      :disabled="disabled"
      aria-haspopup="listbox"

      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
      @keydown.up.prevent="openMenu"
    >
      <span class="idea-creative-select-value">{{ selectedOption?.label }}</span>
      <svg
        class="idea-creative-select-chevron"
        :class="{ 'is-open': isOpen }"
        :data-direction="isOpen ? 'up' : 'down'"
        aria-hidden="true"
        viewBox="0 0 12 12"
      >
        <path d="M2.25 4.25 6 8l3.75-3.75" />
      </svg>
    </button>

    <div
      v-if="isOpen"
      class="idea-creative-select-menu"
      role="listbox"
      :aria-label="label"
      :data-test="`${testId}-menu`"
      @keydown="handleMenuKeydown"
    >
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="idea-creative-select-option"
        :class="{ 'is-selected': option.value === modelValue }"
        role="option"
        :aria-selected="option.value === modelValue"
        :data-option-value="option.value"
        :data-test="`${testId}-option-${option.value}`"
        :title="option.description"
        @click="choose(option.value)"
      >
        <span>{{ option.label }}</span>
        <span v-if="option.value === modelValue" class="idea-creative-select-check" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.idea-creative-select {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.idea-creative-select-label {
  color: var(--workspace-text, #31292b);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
}

.idea-creative-select-trigger {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid rgba(50, 37, 41, 0.12);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.88);
  color: var(--workspace-text, #30272a);
  font: inherit;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease;
}

.idea-creative-select-trigger:hover {
  border-color: rgba(216, 59, 70, 0.28);
  background: #fff;
}

.idea-creative-select-trigger:focus-visible,
.is-open .idea-creative-select-trigger {

  border-color: rgba(216, 59, 70, 0.58);
  outline: none;
  box-shadow: 0 0 0 3px rgba(216, 59, 70, 0.1);
}

.idea-creative-select.is-disabled .idea-creative-select-label {
  color: #a99ca0;
}

.idea-creative-select.is-disabled .idea-creative-select-trigger {
  border-color: rgba(91, 75, 79, 0.08);
  background: #f5f3f2;
  color: #aaa0a2;
  box-shadow: none;
  cursor: not-allowed;
}

.idea-creative-select.is-disabled .idea-creative-select-value,
.idea-creative-select.is-disabled .idea-creative-select-chevron {
  color: #aaa0a2;
  stroke: #aaa0a2;
}

.idea-creative-select-value {

  overflow: hidden;
  color: #493c40;
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.idea-creative-select-chevron {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  fill: none;
  stroke: #9d6d72;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
  transform: rotate(0deg);
  transform-origin: center;
  transition: transform 150ms ease;
}

.idea-creative-select-chevron.is-open {
  transform: rotate(180deg);
}

.idea-creative-select-menu {
  position: absolute;
  z-index: 80;
  top: calc(100% + 7px);
  right: 0;
  left: 0;
  display: grid;
  max-height: 256px;
  gap: 3px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid rgba(216, 59, 70, 0.14);
  border-radius: 12px;
  background: rgba(255, 253, 252, 0.98);
  box-shadow:
    0 18px 44px rgba(69, 31, 38, 0.16),
    0 4px 12px rgba(69, 31, 38, 0.08);
  backdrop-filter: blur(12px);
}

.idea-creative-select-option {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #54474b;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.idea-creative-select-option:hover,
.idea-creative-select-option:focus-visible {
  outline: none;
  background: #fff3f1;
  color: #a82e38;
}

.idea-creative-select-option.is-selected {
  background: #fdecea;
  color: #b5303a;
  font-weight: 700;
}

.idea-creative-select-check {
  display: grid;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: #d83b46;
  color: #fff;
  font-size: 11px;
  line-height: 1;
}
</style>
