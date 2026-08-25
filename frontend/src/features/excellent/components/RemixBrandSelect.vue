<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { BrandSummary } from "../types";

const props = defineProps<{
  modelValue: number | string | null;
  brands: readonly BrandSummary[];
  disabled?: boolean;
  testId: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: number | string): void;
}>();

const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const isOpen = ref(false);
const query = ref("");
const activeIndex = ref(-1);

const selectedBrand = computed(
  () => props.brands.find((brand) => Number(brand.id) === Number(props.modelValue)) || props.brands[0] || null,
);

const filteredBrands = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) return props.brands;
  return props.brands.filter((brand) => {
    const searchable = [brand.name, brand.product, brand.description, brand.profileType === "personal" ? "个人 IP" : "品牌"]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(keyword);
  });
});

function profileTypeLabel(brand: BrandSummary): string {
  return brand.profileType === "personal" ? "个人 IP" : "品牌";
}

function productLabel(brand: BrandSummary): string {
  return String(brand.product || brand.description || "已配置内容主体档案").split(/[。；\n]/)[0].slice(0, 40);
}

function optionId(brand: BrandSummary): string {
  return `${props.testId}-option-${brand.id}`;
}

function focusSearch(): void {
  void nextTick(() => searchInput.value?.focus());
}

function openMenu(): void {
  if (props.disabled || !props.brands.length) return;
  isOpen.value = true;
  query.value = "";
  activeIndex.value = Math.max(
    0,
    props.brands.findIndex((brand) => Number(brand.id) === Number(props.modelValue)),
  );
  focusSearch();
}

function closeMenu({ restoreFocus = false } = {}): void {
  isOpen.value = false;
  query.value = "";
  activeIndex.value = -1;
  if (restoreFocus) {
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>(".remix-brand-trigger")?.focus());
  }
}

function toggleMenu(): void {
  if (isOpen.value) closeMenu();
  else openMenu();
}

function chooseBrand(brand: BrandSummary): void {
  emit("update:modelValue", brand.id);
  closeMenu({ restoreFocus: true });
}

function moveActive(direction: 1 | -1): void {
  const items = filteredBrands.value;
  if (!items.length) return;
  activeIndex.value = (Math.max(activeIndex.value, 0) + direction + items.length) % items.length;
  void nextTick(() => root.value?.querySelector<HTMLElement>(`#${optionId(items[activeIndex.value]!)}`)?.focus());
}

function onSearchInput(): void {
  activeIndex.value = filteredBrands.value.length ? 0 : -1;
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter" && activeIndex.value >= 0) {
    event.preventDefault();
    const brand = filteredBrands.value[activeIndex.value];
    if (brand) chooseBrand(brand);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function onOptionKeydown(event: KeyboardEvent, brand: BrandSummary): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    chooseBrand(brand);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (isOpen.value && !root.value?.contains(event.target as Node)) closeMenu();
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closeMenu();
  },
);

onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <div ref="root" class="remix-brand-combobox" :class="{ 'is-open': isOpen, 'is-disabled': disabled }">
    <button
      type="button"
      class="remix-brand-trigger"
      :data-test="testId"
      role="combobox"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      :aria-controls="`${testId}-menu`"
      :disabled="disabled || !brands.length"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
      @keydown.up.prevent="openMenu"
    >
      <span class="remix-brand-trigger-copy">
        <span class="remix-brand-trigger-name">{{ selectedBrand?.name || (disabled ? "正在加载品牌…" : "暂无可选主体") }}</span>
        <span v-if="selectedBrand" class="remix-brand-trigger-meta">{{ profileTypeLabel(selectedBrand) }}</span>
      </span>
      <svg class="remix-brand-chevron" :class="{ 'is-open': isOpen }" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.25 4.25 6 8l3.75-3.75" />
      </svg>
    </button>

    <div v-if="isOpen" :id="`${testId}-menu`" class="remix-brand-menu" role="listbox" aria-label="选择品牌或个人 IP" :data-test="`${testId}-menu`">
      <div class="remix-brand-menu-topline">
        <strong>选择内容主体</strong>
        <span>{{ brands.length }} 个档案</span>
      </div>
      <label class="remix-brand-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11.5 11.5 3 3M7.1 12.1a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" /></svg>
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          :data-test="`${testId}-search`"
          placeholder="搜索品牌、产品或个人 IP"
          autocomplete="off"
          @input="onSearchInput"
          @keydown="onSearchKeydown"
        />
      </label>
      <div class="remix-brand-options" :data-test="`${testId}-options`">
        <button
          v-for="(brand, index) in filteredBrands"
          :id="optionId(brand)"
          :key="brand.id"
          type="button"
          class="remix-brand-option"
          :class="{ 'is-selected': Number(brand.id) === Number(modelValue), 'is-active': index === activeIndex }"
          role="option"
          :aria-selected="Number(brand.id) === Number(modelValue)"
          :data-test="`${testId}-option-${brand.id}`"
          @click="chooseBrand(brand)"
          @keydown="onOptionKeydown($event, brand)"
        >
          <span class="remix-brand-avatar" aria-hidden="true">{{ String(brand.name || "主").trim().slice(0, 1) }}</span>
          <span class="remix-brand-option-copy">
            <strong>{{ brand.name }}</strong>
            <small>{{ productLabel(brand) }}</small>
          </span>
          <span class="remix-brand-type">{{ profileTypeLabel(brand) }}</span>
          <span v-if="Number(brand.id) === Number(modelValue)" class="remix-brand-check" aria-label="已选择">✓</span>
        </button>
        <p v-if="!filteredBrands.length" class="remix-brand-empty">未找到匹配的内容主体，请换一个关键词。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remix-brand-combobox {
  position: relative;
  width: 100%;
}

.remix-brand-trigger {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border: 1px solid rgba(216, 68, 68, 0.22);
  border-radius: 13px;
  background: linear-gradient(135deg, #fff 0%, #fff4f2 100%);
  box-shadow: 0 5px 14px rgba(117, 47, 56, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.92);
  color: #432e33;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.remix-brand-trigger:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(216, 68, 68, 0.46);
  box-shadow: 0 9px 18px rgba(159, 50, 61, 0.11);
}

.remix-brand-trigger:focus-visible,
.remix-brand-combobox.is-open .remix-brand-trigger {
  border-color: #dd535d;
  outline: none;
  box-shadow: 0 0 0 4px rgba(216, 68, 68, 0.11), 0 9px 18px rgba(159, 50, 61, 0.08);
}

.remix-brand-trigger:disabled {
  border-color: rgba(112, 83, 89, 0.1);
  background: #f4f1f0;
  color: #a49699;
  cursor: wait;
}

.remix-brand-trigger-copy {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.remix-brand-trigger-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remix-brand-trigger-meta,
.remix-brand-type {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  background: #fff0ed;
  color: #c4424e;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.2;
}

.remix-brand-chevron {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  fill: none;
  stroke: #c84652;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
  transition: transform 160ms ease;
}

.remix-brand-chevron.is-open {
  transform: rotate(180deg);
}

.remix-brand-menu {
  position: absolute;
  z-index: 120;
  top: calc(100% + 8px);
  right: 0;
  left: 0;
  overflow: hidden;
  border: 1px solid rgba(216, 68, 68, 0.18);
  border-radius: 16px;
  background: rgba(255, 253, 252, 0.98);
  box-shadow: 0 22px 48px rgba(79, 30, 38, 0.2), 0 6px 16px rgba(79, 30, 38, 0.08);
  backdrop-filter: blur(14px);
}

.remix-brand-menu-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 14px 9px;
  color: #3f2d31;
}

.remix-brand-menu-topline strong {
  font-size: 12px;
  font-weight: 900;
}

.remix-brand-menu-topline span {
  color: #9d777d;
  font-size: 11px;
  font-weight: 700;
}

.remix-brand-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 10px;
  padding: 0 10px;
  border: 1px solid rgba(105, 75, 81, 0.12);
  border-radius: 10px;
  background: #fff8f6;
}

.remix-brand-search:focus-within {
  border-color: rgba(216, 68, 68, 0.42);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.remix-brand-search svg {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  fill: none;
  stroke: #bc6a73;
  stroke-linecap: round;
  stroke-width: 1.5;
}

.remix-brand-search input {
  width: 100%;
  height: 36px;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #4a3539;
  font: inherit;
  font-size: 12px;
}

.remix-brand-search input::placeholder {
  color: #b4a3a6;
}

.remix-brand-options {
  display: grid;
  max-height: 272px;
  gap: 3px;
  overflow-y: auto;
  padding: 4px 7px 8px;
  scrollbar-color: #e8a4aa transparent;
  scrollbar-width: thin;
}

.remix-brand-option {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto auto;
  width: 100%;
  min-height: 52px;
  align-items: center;
  gap: 9px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: #4a3539;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.remix-brand-option:hover,
.remix-brand-option:focus-visible,
.remix-brand-option.is-active {
  border-color: rgba(216, 68, 68, 0.16);
  outline: none;
  background: #fff2f0;
}

.remix-brand-option.is-selected {
  border-color: rgba(216, 68, 68, 0.3);
  background: linear-gradient(135deg, #fff1ef, #fff9f7);
}

.remix-brand-avatar {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(145deg, #e8545d, #fa987e);
  color: #fff;
  font-size: 13px;
  font-weight: 900;
}

.remix-brand-option-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.remix-brand-option-copy strong,
.remix-brand-option-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remix-brand-option-copy strong {
  color: #4a3035;
  font-size: 12px;
  font-weight: 850;
}

.remix-brand-option-copy small {
  color: #957e82;
  font-size: 10px;
}

.remix-brand-check {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: #d94b56;
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}

.remix-brand-empty {
  margin: 0;
  padding: 16px 10px 18px;
  color: #967e83;
  font-size: 12px;
  text-align: center;
}

@media (max-width: 760px) {
  .remix-brand-menu {
    position: fixed;
    top: max(72px, 14vh);
    right: 16px;
    left: 16px;
    max-height: min(62vh, 460px);
  }

  .remix-brand-options {
    max-height: min(43vh, 300px);
  }

  .remix-brand-option {
    grid-template-columns: 30px minmax(0, 1fr) auto auto;
  }
}
</style>
