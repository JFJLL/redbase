<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { isAbortError, isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import {
  createBrand,
  updateBrand,
  type BrandDetail,
  type ProfileFormPayload,
} from "../api";

// Create/edit dialog for brand and personal-IP profiles. Copy, field labels
// and payload shape are ported from public/app.js bindBrandModal().

const MAX_BRAND_PROFILE_CHARS = 5000;
const MAX_SINGLE_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

const props = defineProps<{
  open: boolean;
  profileType: "brand" | "personal";
  /** Full detail when editing; null when creating. */
  brand: BrandDetail | null;
}>();

const router = useRouter();
const auth = useAuthStore();
const scope = useAbortScope();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "saved", brand: BrandDetail, created: boolean): void;
}>();

const form = reactive({
  name: "",
  industry: "",
  audience: "",
  description: "",
  product: "",
  contentPillars: "",
  personaStyle: "",
  knowledgeBase: "",
  goal: "",
});
const pendingLogo = ref<{ name: string; dataUrl: string } | null>(null);
const submitting = ref(false);
const errorMessage = ref("");
const logoInput = ref<HTMLInputElement | null>(null);

const isPersonal = computed(() => props.profileType === "personal");
const editingBrandId = computed(() => props.brand?.id ?? null);
const subjectLabel = computed(() => (isPersonal.value ? "个人 IP" : "品牌"));
const assetLabel = computed(() => (isPersonal.value ? "个人头像" : "品牌 Logo"));

const modalKicker = computed(() =>
  isPersonal.value ? "个人 IP 档案" : editingBrandId.value ? "品牌资产维护" : "品牌资产录入",
);
const modalTitle = computed(() =>
  `${editingBrandId.value ? "编辑" : "新增"}${subjectLabel.value}`,
);
const modalDescription = computed(() => {
  if (isPersonal.value) return "填写真实定位、目标受众、内容支柱和表达风格，后续可随时修改。";
  return editingBrandId.value
    ? "更新品牌定位、产品信息和资料库，后续 AI 分析会使用最新内容。"
    : "填写品牌信息，帮助 AI 更好地理解你的需求";
});
const submitLabel = computed(() =>
  editingBrandId.value ? "保存修改" : `创建${subjectLabel.value}`,
);
const logoUploadText = computed(() => {
  if (pendingLogo.value) return "重新选择 Logo";
  return props.brand?.logo
    ? `更换${isPersonal.value ? "头像" : " Logo"}`
    : `选择${isPersonal.value ? "头像" : " Logo 图片"}`;
});

watch(
  () => [props.open, props.brand] as const,
  ([open]) => {
    if (!open) return;
    errorMessage.value = "";
    pendingLogo.value = null;
    if (logoInput.value) logoInput.value.value = "";
    const brand = props.brand;
    form.name = brand?.name || "";
    form.industry = brand?.industry || "";
    form.audience = brand?.audience || "";
    form.description = brand?.description || "";
    form.product = brand?.product || "";
    form.knowledgeBase = brand?.knowledgeBase || "";
    form.goal = brand?.goal || "";
    form.contentPillars = Array.isArray(brand?.contentPillars) ? brand.contentPillars.join("，") : "";
    form.personaStyle = brand?.personaStyle || "";
  },
  { immediate: true },
);

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

async function handleLogoChange(): Promise<void> {
  const file = logoInput.value?.files?.[0];
  if (!file) {
    pendingLogo.value = null;
    return;
  }
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    errorMessage.value = `${assetLabel.value}最多上传 ${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)}。请压缩图片后重新上传。`;
    if (logoInput.value) logoInput.value.value = "";
    pendingLogo.value = null;
    return;
  }
  try {
    // 账号切换/登出时中断读取（notifyAuthReset → signal abort → FileReader.abort()）。
    const signal = scope.signalFor("logo-file-read");
    pendingLogo.value = { name: file.name, dataUrl: await fileToDataUrl(file, signal) };
    errorMessage.value = "";
  } catch (error) {
    pendingLogo.value = null;
    if (isAbortError(error)) return;
    errorMessage.value = `${assetLabel.value}读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function getProfileInputSize(): number {
  const fields = [
    form.name, form.industry, form.audience, form.description, form.product,
    form.goal, form.knowledgeBase, form.contentPillars, form.personaStyle,
  ];
  return fields.reduce((sum, value) => sum + String(value || "").trim().length, 0);
}

async function handleSubmit(): Promise<void> {
  const total = getProfileInputSize();
  if (total > MAX_BRAND_PROFILE_CHARS) {
    errorMessage.value = `当前${subjectLabel.value}档案共 ${total} 字，超过上限 ${MAX_BRAND_PROFILE_CHARS} 字，已超出 ${total - MAX_BRAND_PROFILE_CHARS} 字。请删减档案内容后再保存。`;
    return;
  }
  const payload: ProfileFormPayload = {
    profileType: props.profileType,
    name: form.name,
    industry: form.industry,
    audience: form.audience,
    description: form.description,
    product: form.product,
    knowledgeBase: form.knowledgeBase,
    goal: form.goal,
    contentPillars: form.contentPillars,
    personaStyle: form.personaStyle,
  };
  if (pendingLogo.value) {
    payload.logoName = pendingLogo.value.name;
    payload.logoDataUrl = pendingLogo.value.dataUrl;
  }

  submitting.value = true;
  errorMessage.value = "";
  try {
    const result = editingBrandId.value
      ? await updateBrand(editingBrandId.value, payload)
      : await createBrand(payload);
    emit("saved", result.brand, !editingBrandId.value);
  } catch (error) {
    if (isUnauthorized(error)) {
      auth.handleUnauthorized();
      router.push({ name: "login" });
      return;
    }
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-mask is-open" @click.self="emit('close')">
    <div class="modal-panel">
      <div class="modal-head">
        <div>
          <div class="modal-kicker">{{ modalKicker }}</div>
          <h2>{{ modalTitle }}</h2>
          <p>{{ modalDescription }}</p>
        </div>
        <button class="modal-close" type="button" @click="emit('close')">×</button>
      </div>

      <form class="brand-form" @submit.prevent="handleSubmit">
        <div class="form-row">
          <label>
            <span>{{ isPersonal ? "IP 名称 / 昵称" : "品牌名称" }}</span>
            <input
              v-model="form.name"
              name="name"
              :placeholder="isPersonal ? '请输入昵称或 IP 名称' : '请输入品牌名称'"
              required
            />
          </label>
          <label>
            <span>{{ isPersonal ? "内容领域" : "行业分类" }}</span>
            <input
              v-model="form.industry"
              name="industry"
              :placeholder="isPersonal ? '如：职场成长、创业、育儿' : '如：美妆、食品、科技'"
              required
            />
          </label>
        </div>

        <label>
          <span>目标受众</span>
          <input v-model="form.audience" name="audience" placeholder="如：25-35岁都市女性，注重生活品质" required />
        </label>

        <label>
          <span>{{ isPersonal ? "人设与定位" : "品牌介绍" }}</span>
          <textarea
            v-model="form.description"
            name="description"
            rows="4"
            :placeholder="isPersonal ? '描述你的经历、专业身份、差异化定位与希望建立的认知' : '描述品牌定位、品牌故事、核心价值等'"
            required
          ></textarea>
        </label>

        <label>
          <span>{{ isPersonal ? "专长 / 服务（可选）" : "产品介绍" }}</span>
          <textarea
            v-model="form.product"
            name="product"
            rows="4"
            :placeholder="isPersonal ? '可选：描述课程、咨询或其他服务；没有可留空' : '描述主要产品/服务、卖点、使用场景等'"
            :required="!isPersonal"
          ></textarea>
        </label>

        <div v-if="isPersonal" class="personal-profile-fields">
          <label>
            <span>内容支柱</span>
            <input v-model="form.contentPillars" name="contentPillars" placeholder="用逗号分隔，如：职场成长,效率方法,真实创业" />
          </label>
          <label>
            <span>个人表达风格</span>
            <textarea
              v-model="form.personaStyle"
              name="personaStyle"
              rows="3"
              placeholder="如：真诚直接、讲具体过程、不端着，常用第一人称复盘。"
            ></textarea>
          </label>
        </div>

        <label>
          <span>{{ isPersonal ? "补充背景资料" : "品牌资料库" }}</span>
          <textarea
            v-model="form.knowledgeBase"
            name="knowledgeBase"
            rows="4"
            :placeholder="isPersonal ? '补充履历、专业背景、内容边界和不能编造的信息。' : '补充品牌故事、成分说明、视觉风格、核心卖点、竞品差异、适用场景等，供内容生成和生图参考。'"
          ></textarea>
        </label>

        <div class="brand-logo-field">
          <div class="field-label">{{ assetLabel }}</div>
          <label class="brand-logo-upload-button">
            <input ref="logoInput" type="file" accept="image/*" @change="handleLogoChange" />
            <span>{{ logoUploadText }}</span>
          </label>
          <div class="brand-logo-preview">
            <template v-if="pendingLogo">
              <span>已选择：{{ pendingLogo.name }}</span>
              <img :src="pendingLogo.dataUrl" :alt="pendingLogo.name" />
            </template>
            <template v-else-if="brand?.logo?.url">
              <span>当前{{ assetLabel }}：{{ brand.logo.originalName || assetLabel }}</span>
              <img :src="brand.logo.url" :alt="brand.logo.originalName || assetLabel" />
            </template>
            <template v-else>
              {{ isPersonal
                ? "可选上传个人头像，仅用于识别档案与辅助视觉风格，不会作为品牌 Logo 植入图片。"
                : "可选上传，后续生图时可作为产品 Logo 使用。" }}
            </template>
          </div>
        </div>

        <label>
          <span>{{ isPersonal ? "账号目标" : "运营目标" }}</span>
          <textarea
            v-model="form.goal"
            name="goal"
            rows="4"
            :placeholder="isPersonal ? '例如建立专业影响力、积累精准粉丝、获得咨询线索' : '描述小红书账号的运营目标，例如提升品牌知名度、增加销量、建立用户社区等'"
            required
          ></textarea>
        </label>

        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>

        <div class="form-actions">
          <button class="secondary-btn" type="button" :disabled="submitting" @click="emit('close')">取消</button>
          <button class="primary-btn" type="submit" :disabled="submitting">
            {{ submitting ? "提交中..." : submitLabel }}
          </button>
        </div>
      </form>
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
  width: min(860px, 100%);
  max-height: calc(100vh - 56px);
  overflow: auto;
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

.brand-form {
  display: grid;
  gap: 16px;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.brand-form label {
  display: grid;
  gap: 6px;
  font-size: 14px;
}

.brand-form label > span,
.field-label {
  font-weight: 600;
  font-size: 13px;
}

.brand-form input,
.brand-form textarea {
  border: 1px solid var(--color-border, #e4e6eb);
  border-radius: 8px;
  padding: 10px 12px;
  font: inherit;
}

.personal-profile-fields {
  display: grid;
  gap: 16px;
}

.brand-logo-field {
  display: grid;
  gap: 8px;
}

.brand-logo-upload-button {
  display: inline-flex;
  width: fit-content;
  padding: 8px 16px;
  border: 1px dashed var(--color-border, #e4e6eb);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.brand-logo-upload-button input[type="file"] {
  display: none;
}

.brand-logo-preview {
  display: grid;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text-secondary, #646a73);
}

.brand-logo-preview img {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--color-border, #e4e6eb);
}

.form-error {
  margin: 0;
  color: #d64545;
  font-size: 13px;
  white-space: pre-wrap;
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

/* Legacy light-workspace modal parity. */
.modal-mask {
  padding: 28px;
  background: rgba(42, 31, 34, 0.38);
  backdrop-filter: blur(2px);
}

.modal-panel {
  width: min(860px, 100%);
  max-height: calc(100vh - 56px);
  padding: 28px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #fffdfc;
  color: var(--workspace-text);
  box-shadow: 0 20px 54px rgba(54, 38, 43, 0.16);
}

.modal-head {
  gap: 24px;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--workspace-border);
}

.modal-kicker {
  margin-bottom: 8px;
  color: var(--workspace-brand-ink);
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

.brand-form {
  gap: 18px;
}

.form-row,
.personal-profile-fields {
  gap: 18px;
}

.brand-form label {
  gap: 8px;
  color: var(--workspace-text);
}

.brand-form label > span,
.field-label {
  color: #3b3134;
  font-size: 0.9rem;
  font-weight: 600;
}

.brand-form input,
.brand-form textarea {
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  padding: 11px 12px;
  background: #fff;
  color: var(--workspace-text);
  line-height: 1.55;
  outline: none;
}

.brand-form input:focus,
.brand-form textarea:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.brand-logo-field {
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: #faf7f5;
}

.brand-logo-upload-button {
  min-height: 42px;
  align-items: center;
  padding: 0 16px;
  border-color: rgba(216, 68, 68, 0.28);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-brand-ink);
}

.brand-logo-preview {
  color: var(--workspace-text-muted);
  line-height: 1.55;
}

.brand-logo-preview img {
  width: 72px;
  height: 72px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
}

.form-error {
  padding: 12px 14px;
  border: 1px solid rgba(183, 46, 58, 0.15);
  border-radius: var(--workspace-radius-sm);
  background: #fff6f6;
  color: #b72e3a;
}

.form-actions {
  gap: 12px;
  padding-top: 4px;
}

.primary-btn,
.secondary-btn {
  min-height: 48px;
  padding: 0 20px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.95rem;
}

.primary-btn {
  background: var(--workspace-brand);
  color: #fff;
}

.primary-btn:hover:not(:disabled) {
  background: var(--workspace-brand-hover);
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
