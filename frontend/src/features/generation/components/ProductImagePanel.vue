<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import {
  countProductImageReferences,
  removeProductImageFromAllSettings,
} from "../ideaCreativeSettings";
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
  /** 父级递增该 token 可触发图库重新加载（图库加载失败后的可恢复重试）。 */
  reloadToken?: number;
}>();

const emit = defineEmits<{
  (event: "update:selectedIds", value: number[]): void;
  (event: "images-loaded", images: ProductImageView[]): void;
  (event: "images-load-error", message: string): void;
}>();

const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const images = ref<ProductImageView[]>([]);
const loading = ref(false);
const uploading = ref(false);
const message = ref("");
const pendingDelete = ref<ProductImageView | null>(null);

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
  message.value = "";
  try {
    const result = await fetchProductImages(scope.signalFor("product-images"));
    images.value = result.images || [];
    emit("images-loaded", images.value);
  } catch (error) {
    if (isAbortError(error)) return;
    if (await handleUnauthorizedError(error)) return;
    message.value = `产品素材加载失败：${(error as Error).message}`;
    emit("images-load-error", message.value);
  } finally {
    loading.value = false;
  }
}

// 父级重试图库：reloadToken 变化即重新加载，加载成功会再次 emit images-loaded。
watch(
  () => props.reloadToken ?? 0,
  (token, previous) => {
    if (previous !== undefined && token !== previous) void loadImages();
  },
);

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

function requestDelete(image: ProductImageView): void {
  pendingDelete.value = image;
}

function cancelDelete(): void {
  pendingDelete.value = null;
}

const deleteImpactCount = computed(() => {
  const image = pendingDelete.value;
  if (!image) return 0;
  return countProductImageReferences(image.id);
});

async function confirmDelete() {
  const image = pendingDelete.value;
  pendingDelete.value = null;
  if (!image) return;
  message.value = "";
  try {
    await deleteProductImage(image.id, scope.signalFor(`delete-${image.id}`));
    // 删除成功后清理当前账号浏览器内所有选题键位中的失效引用（含本面板选中态）。
    const cleaned = removeProductImageFromAllSettings(image.id);
    images.value = images.value.filter((item) => item.id !== image.id);
    emit(
      "update:selectedIds",
      props.selectedIds.filter((id) => id !== image.id),
    );
    emit("images-loaded", images.value);
    if (cleaned > 0) {
      message.value = `已删除，并清理 ${cleaned} 处选题中的图片引用。`;
    }
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
        <button type="button" class="image-delete" :data-test="`product-image-delete-${image.id}`" @click="requestDelete(image)">
          删除
        </button>
      </li>
    </ul>

    <p v-if="message" class="panel-message" data-test="product-image-message">{{ message }}</p>
  </section>

  <div v-if="pendingDelete" class="product-delete-backdrop" data-test="product-delete-confirm" @click.self="cancelDelete">
    <section class="product-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="productDeleteTitle">
      <h3 id="productDeleteTitle">删除产品图</h3>
      <p data-test="product-delete-impact">
        {{
          deleteImpactCount > 0
            ? `该图片正被 ${deleteImpactCount} 处选题引用，删除后将从相关图片/视频创作设置中移除这些引用。`
            : "该图片未被任何选题引用。"
        }}
      </p>
      <p>已经创建并冻结的视频项目不受影响。</p>
      <p>确定删除「{{ pendingDelete.originalName }}」吗？此操作不可恢复。</p>
      <div class="product-delete-actions">
        <button type="button" class="secondary-btn" data-test="product-delete-cancel" @click="cancelDelete">取消</button>
        <button type="button" class="danger-btn" data-test="product-delete-confirm-action" @click="confirmDelete">确认删除</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.product-image-panel {
  position: relative;
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface-soft);
}

.panel-header h3 {
  margin: 0 0 5px;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1rem;
  font-weight: 700;
}

.panel-header p {
  margin: 0;
  color: var(--workspace-text-muted);
  font-size: 0.8rem;
  line-height: 1.6;
}

.upload-button {
  position: relative;
  display: inline-flex;
  width: fit-content;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0 14px;
  border: 1px solid var(--workspace-brand-border);
  border-radius: var(--workspace-radius-sm);
  background: var(--workspace-surface);
  color: var(--workspace-brand-ink);
  font-size: 0.84rem;
  font-weight: 700;
  cursor: pointer;
}

.upload-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.panel-hint,
.panel-message {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--workspace-radius);
  background: rgba(255, 255, 255, 0.72);
  color: var(--workspace-text-muted);
  font-size: 0.82rem;
}

.panel-message {
  border: 1px solid rgba(216, 68, 68, 0.14);
  background: var(--workspace-surface-accent);
  color: var(--workspace-brand-ink);
}

.image-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.image-item {
  display: grid;
  min-width: 0;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.image-check {
  position: relative;
  display: grid;
  min-width: 0;
  gap: 8px;
  color: var(--workspace-text-body);
  font-size: 0.8rem;
  cursor: pointer;
}

.image-check input {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
}

.image-check img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border: 1px solid var(--workspace-border);
  border-radius: 6px;
  background: var(--workspace-surface-accent);
}

.image-name {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-delete {
  min-height: 34px;
  border: 1px solid rgba(183, 46, 58, 0.16);
  border-radius: var(--workspace-radius-sm);
  background: #fffafa;
  color: #b72e3a;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.product-delete-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(10, 15, 25, 0.45);
}

.product-delete-modal {
  display: grid;
  gap: 10px;
  width: min(420px, calc(100vw - 32px));
  padding: 18px;
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  color: var(--workspace-text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
}

.product-delete-modal h3 {
  margin: 0;
}

.product-delete-modal p {
  margin: 0;
  color: var(--workspace-muted);
}

.product-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.danger-btn {
  border: 1px solid var(--workspace-danger, #c0392b);
  background: var(--workspace-danger, #c0392b);
  color: #fff;
  border-radius: var(--workspace-radius);
  padding: 6px 12px;
  cursor: pointer;
}
</style>
