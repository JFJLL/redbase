<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import {
  MAX_SELECTED_PRODUCT_IMAGES,
  MAX_SELECTED_PRODUCT_IMAGE_BYTES,
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  deleteProductImage,
  fetchProductImages,
  uploadProductImage,
  type ProductImageView,
} from "../api";

// 产品图管理：列表 / 上传 / 删除 / 勾选，语义对齐旧版产品图库
// （app.js loadProductImages / uploadProductImage / getSelectedProductImages）。
const props = defineProps<{
  selectedIds: number[];
}>();

const emit = defineEmits<{
  (event: "update:selectedIds", value: number[]): void;
  (event: "images-loaded", images: ProductImageView[]): void;
}>();

const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const images = ref<ProductImageView[]>([]);
const loading = ref(false);
const uploading = ref(false);
const message = ref("");

const selectedImages = computed(() => images.value.filter((image) => props.selectedIds.includes(image.id)));
const selectedBytes = computed(() => selectedImages.value.reduce((total, image) => total + Number(image.sizeBytes || 0), 0));

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

async function handleUnauthorizedError(error: unknown): Promise<boolean> {
  if (!isUnauthorized(error)) return false;
  auth.handleUnauthorized();
  await router.push({ name: "login" });
  return true;
}

async function loadImages() {
  loading.value = true;
  try {
    const result = await fetchProductImages(scope.signalFor("product-images"));
    images.value = result.images || [];
    emit("images-loaded", images.value);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    message.value = `产品素材加载失败：${(error as Error).message}`;
  } finally {
    loading.value = false;
  }
}

onMounted(loadImages);

function toggleSelect(image: ProductImageView, checked: boolean) {
  message.value = "";
  if (!checked) {
    emit(
      "update:selectedIds",
      props.selectedIds.filter((id) => id !== image.id),
    );
    return;
  }
  if (props.selectedIds.includes(image.id)) return;
  if (props.selectedIds.length + 1 > MAX_SELECTED_PRODUCT_IMAGES) {
    message.value = `产品参考图最多选择 ${MAX_SELECTED_PRODUCT_IMAGES} 张。请删除已有图片后重新上传或选择。`;
    return;
  }
  if (selectedBytes.value + Number(image.sizeBytes || 0) > MAX_SELECTED_PRODUCT_IMAGE_BYTES) {
    message.value = `产品参考图总大小最多 ${formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES)}。当前选择约 ${formatFileSize(selectedBytes.value)}，新增后会超过上限，请压缩图片或删除已有图片后重新上传。`;
    return;
  }
  emit("update:selectedIds", [...props.selectedIds, image.id]);
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || uploading.value) return;
  const oversizedFile = files.find((file) => file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES);
  if (oversizedFile) {
    message.value = `单张产品参考图最多上传 ${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)}。${oversizedFile.name} 过大，请压缩图片后重新上传。`;
    return;
  }
  uploading.value = true;
  message.value = "";
  try {
    for (const file of files) {
      // 读取与上传共用同一 signal：账号切换（notifyAuthReset）时读取被中止，
      // 且读取完成后 signal 已 abort 的情况下 uploadProductImage 也不会发出 POST。
      const signal = scope.signalFor(`upload-${file.name}`);
      const dataUrl = await fileToDataUrl(file, signal);
      if (signal.aborted) return;
      const result = await uploadProductImage({ name: file.name, dataUrl }, signal);
      const image = result.image;
      if (!image) continue;
      images.value = [image, ...images.value.filter((item) => item.id !== image.id)];
      if (!props.selectedIds.includes(image.id) && props.selectedIds.length < MAX_SELECTED_PRODUCT_IMAGES) {
        emit("update:selectedIds", [...props.selectedIds, image.id]);
      }
      if (result.duplicate) message.value = "该图片已在素材库中";
    }
    emit("images-loaded", images.value);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    message.value = `上传失败：${(error as Error).message}`;
  } finally {
    uploading.value = false;
  }
}

async function handleDelete(image: ProductImageView) {
  message.value = "";
  try {
    await deleteProductImage(image.id, scope.signalFor(`delete-${image.id}`));
    images.value = images.value.filter((item) => item.id !== image.id);
    emit(
      "update:selectedIds",
      props.selectedIds.filter((id) => id !== image.id),
    );
    emit("images-loaded", images.value);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    message.value = `删除失败：${(error as Error).message}`;
  }
}
</script>

<template>
  <section class="product-image-panel" data-test="product-image-panel">
    <header class="panel-header">
      <h3>产品图参考</h3>
      <p>
        最多 {{ MAX_SELECTED_PRODUCT_IMAGES }} 张，共 {{ formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES) }}；当前
        {{ selectedImages.length }} 张，约 {{ formatFileSize(selectedBytes) }}
      </p>
    </header>

    <label class="upload-button">
      <input type="file" accept="image/*" multiple data-test="product-image-upload" :disabled="uploading" @change="handleUpload" />
      <span>{{ uploading ? "上传中..." : "上传产品图" }}</span>
    </label>

    <p v-if="loading" class="panel-hint">正在加载产品素材...</p>
    <p v-else-if="!images.length" class="panel-hint">还没有已上传的产品图。</p>

    <ul v-if="images.length" class="image-list">
      <li v-for="image in images" :key="image.id" class="image-item">
        <label class="image-check">
          <input
            type="checkbox"
            :data-test="`product-image-check-${image.id}`"
            :checked="props.selectedIds.includes(image.id)"
            @change="toggleSelect(image, ($event.target as HTMLInputElement).checked)"
          />
          <img :src="image.url" :alt="image.originalName" loading="lazy" decoding="async" />
          <span class="image-name">{{ image.originalName }}</span>
        </label>
        <button type="button" class="image-delete" :data-test="`product-image-delete-${image.id}`" @click="handleDelete(image)">
          删除
        </button>
      </li>
    </ul>

    <p v-if="message" class="panel-message" data-test="product-image-message">{{ message }}</p>
  </section>
</template>

<style scoped>
.product-image-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
}

.panel-header p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.upload-button {
  align-self: flex-start;
  position: relative;
  overflow: hidden;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.upload-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.panel-hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.image-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.image-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.image-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  min-width: 0;
}

.image-check img {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.image-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-delete {
  border: none;
  background: none;
  color: var(--color-brand);
  font-size: 12px;
  cursor: pointer;
}

.panel-message {
  margin: 0;
  font-size: 12px;
  color: var(--color-brand);
}
</style>
