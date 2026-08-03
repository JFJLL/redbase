<script setup lang="ts">
// 内容选题页。迁移自旧前端 public/index.html data-tab-panel="ideas" 与
// public/app.js 的 renderIdeas / renderIdeaContent / renderIdeaContentAssets /
// bindIdeaPromptActions / data-idea-edit-form 提交逻辑。
// 旧版内嵌的四个生图按钮属于生图任务域，此处以「去生成内容」跳转 /app/generation 承接。
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { isAbortError } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope } from "@/shared/composables/useAbortScope";
import { regenerateTrendIdeas, updateTrendIdea } from "@/features/trends/api/insightsApi";
import { useInsightsStore } from "@/features/trends/stores/insights";
import { useUnauthorizedHandler } from "@/features/trends/composables/useUnauthorizedHandler";
import type { TrendIdea } from "@/features/trends/model/types";

interface IdeaDraft {
  title: string;
  summary: string;
  angle: string;
  brandFit: string;
  audience: string;
  hook: string;
}

const store = useInsightsStore();
const auth = useAuthStore();
const router = useRouter();
const scope = useAbortScope();
const handleUnauthorized = useUnauthorizedHandler();

const brand = computed(() => store.selectedBrand);
const trend = computed(() => store.selectedTrend);
const isPersonal = computed(() => brand.value?.profileType === "personal");

const loadError = ref("");
const customPrompt = ref("");
const promptMeta = ref("当前使用默认系统提示词生成。");
const regenerating = ref(false);
const editingDrafts = reactive<Record<number, IdeaDraft>>({});
const editErrors = reactive<Record<number, string>>({});

// 切换品牌/趋势时重置提示词输入与草稿（旧版 renderIdeas 每次渲染同步）。
watch(
  () => `${store.selectedBrandId ?? ""}:${trend.value?.id ?? ""}`,
  () => {
    customPrompt.value = trend.value?.customPrompt || "";
    promptMeta.value = trend.value?.customPrompt
      ? `当前已叠加你的补充提示词：${trend.value.customPrompt}`
      : "当前使用默认系统提示词生成。";
    for (const key of Object.keys(editingDrafts)) delete editingDrafts[Number(key)];
    for (const key of Object.keys(editErrors)) delete editErrors[Number(key)];
  },
  { immediate: true },
);

const displayMeta = computed(() => {
  if (!brand.value) return "当前使用默认系统提示词生成。";
  if (!brand.value._detailLoaded) return "品牌详情加载完成后可继续生成内容。";
  if (!trend.value) return "当前使用默认系统提示词生成。";
  return promptMeta.value;
});

const regenerateDisabled = computed(
  () => regenerating.value || !brand.value || !brand.value._detailLoaded || !trend.value,
);

onMounted(() => {
  void loadPage();
});

async function loadPage(): Promise<void> {
  loadError.value = "";
  try {
    // 不强制刷新：保留从趋势页「生成选题」带过来的选中品牌与趋势。
    await store.loadBrands(scope.signalFor("brands"));
    if (store.selectedBrandId) {
      await store.ensureBrandDetail(store.selectedBrandId, scope.signalFor(`brand-detail:${store.selectedBrandId}`));
    }
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    loadError.value = `加载失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

// --- 自定义补充提示词 / 重新生成选题（旧版 bindIdeaPromptActions）---

async function handleRegenerate(): Promise<void> {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  if (!currentBrand || !currentTrend) {
    promptMeta.value = "请先选择品牌或个人 IP，并生成热点趋势。";
    return;
  }
  const prompt = customPrompt.value.trim();
  regenerating.value = true;
  promptMeta.value = "正在把你的补充提示词追加到系统提示词中并重新生成选题...";
  try {
    const result = await regenerateTrendIdeas(currentBrand.id, currentTrend.id, prompt, scope.signalFor("regenerate"));
    if (result.user) auth.user = result.user;
    store.replaceTrendInBrand(currentBrand.id, result.trend);
    store.selectedTrendId = result.trend.id;
    promptMeta.value = prompt
      ? `已按你的补充提示词重新生成。当前额外要求：${prompt}`
      : "已恢复为默认系统提示词生成。";
  } catch (error) {
    if (isAbortError(error)) return;
    if (handleUnauthorized(error)) return;
    promptMeta.value = `生成失败：${String((error as { message?: unknown })?.message || "")}`;
  } finally {
    regenerating.value = false;
  }
}

// --- 选题编辑（旧版 data-edit-idea / data-idea-edit-form）---

function startEdit(index: number): void {
  const idea = trend.value?.ideas?.[index];
  if (!idea) return;
  editingDrafts[index] = {
    title: idea.title || "",
    summary: idea.summary || "",
    angle: idea.angle || "",
    brandFit: idea.brandFit || "",
    audience: idea.audience || "",
    hook: idea.hook || "",
  };
  delete editErrors[index];
}

function cancelEdit(index: number): void {
  delete editingDrafts[index];
  delete editErrors[index];
}

async function saveIdea(index: number): Promise<void> {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  const draft = editingDrafts[index];
  if (!currentBrand || !currentTrend || !draft) return;
  try {
    const result = await updateTrendIdea(
      currentBrand.id,
      currentTrend.id,
      index,
      { ...draft },
      scope.signalFor(`idea-edit:${index}`),
    );
    store.replaceTrendInBrand(currentBrand.id, result.trend);
    delete editingDrafts[index];
    delete editErrors[index];
  } catch (error) {
    if (isAbortError(error) || handleUnauthorized(error)) return;
    editErrors[index] = `保存失败：${String((error as { message?: unknown })?.message || "")}`;
  }
}

// --- 内容资产预览（旧版 hasCompleteIdeaContentAssets / renderIdeaContentAssets）---

function hasCompleteIdeaContentAssets(idea: TrendIdea): boolean {
  const assets = idea?.contentAssets || {};
  const slides = assets.xhsCarousel?.slides;
  return Boolean(
    assets.moments?.caption &&
      assets.xhsCarousel?.publishTitle &&
      Array.isArray(slides) &&
      slides.length === 4 &&
      assets.wechatLongImage?.intro,
  );
}

// 去生图任务页继续生成内容（旧版四个生图按钮的承接入口）。
function goToGeneration(ideaIndex: number): void {
  const currentBrand = brand.value;
  const currentTrend = trend.value;
  if (!currentBrand || !currentTrend) return;
  void router.push({
    name: "generation",
    query: {
      brandId: String(currentBrand.id),
      trendId: String(currentTrend.id),
      ideaIndex: String(ideaIndex),
    },
  });
}
</script>

<template>
  <section class="ideas-panel">
    <header class="panel-header">
      <div>
        <div class="panel-icon-title">
          <span class="panel-icon panel-icon-green">◌</span>
          <h1 class="panel-title">内容选题</h1>
        </div>
        <p class="panel-subtitle">结合主体档案和热点趋势，生成更匹配品牌或个人 IP 的小红书内容</p>
      </div>
    </header>

    <div v-if="loadError" class="error-banner" data-test="load-error">
      {{ loadError }}
      <button class="text-btn" type="button" @click="loadPage">重试</button>
    </div>

    <div class="idea-context-card" data-test="idea-context">
      <div v-if="!brand" class="idea-copy">先新增品牌，再开始生成内容选题。</div>
      <div v-else-if="!brand._detailLoaded" class="idea-copy">
        正在加载 {{ brand.name }} 的完整品牌详情和选题记录...
      </div>
      <div v-else-if="!trend" class="idea-copy">
        先在“趋势分析”中为 {{ brand.name }} 生成一批热点，再进入内容选题页。
      </div>
      <div v-else class="idea-context-top">
        <div>
          <h3>{{ brand.name }} × {{ trend.title }}</h3>
          <p class="idea-copy">
            {{
              isPersonal
                ? "内容选题不是只追热点，而是把个人定位、真实素材、目标读者和表达风格一起带入，生成符合本人经历与人设边界的小红书内容方向。"
                : "内容选题不是只追热点，而是把品牌资产、产品卖点、目标受众和运营目标一起带入，生成真正适合该品牌的小红书内容方向。"
            }}
          </p>
          <p class="idea-copy"><strong>热点适配原因：</strong>{{ trend.reason }}</p>
          <p class="idea-copy">
            <strong>{{ isPersonal ? "补充背景资料" : "品牌资料库" }}：</strong
            >{{ brand.knowledgeBase || `当前未补充${isPersonal ? "背景资料" : "品牌资料库"}。` }}
          </p>
          <p class="idea-copy">
            <strong>参考图片：</strong>
            {{
              isPersonal
                ? "可上传内容参考图、使用个人头像参考或添加风格参考图；系统不会把个人头像当作品牌 Logo 植入画面。"
                : "可在下方每个选题中上传产品图、选择品牌 Logo 或添加风格参考图，并勾选后用于对应生图。"
            }}
          </p>
        </div>
        <div class="idea-tag-list">
          <span v-for="tag in brand.assetTags" :key="tag" class="idea-tag">{{ tag }}</span>
        </div>
      </div>
    </div>

    <div class="idea-prompt-card">
      <div class="idea-prompt-header">
        <div>
          <h3>自定义补充提示词</h3>
          <p class="idea-copy">
            在系统提示词的基础上追加你的要求，例如内容语气、强调卖点、限制风格或指定人群。
          </p>
        </div>
        <button
          class="primary-btn small-btn cost-button"
          data-test="regenerate-ideas"
          type="button"
          :disabled="regenerateDisabled"
          @click="handleRegenerate"
        >
          <template v-if="regenerating">生成中...</template>
          <template v-else>
            <span>重新生成选题</span>
            <small>1 积分</small>
          </template>
        </button>
      </div>
      <textarea
        v-model="customPrompt"
        data-test="custom-idea-prompt"
        rows="4"
        placeholder="例如：希望选题更偏高端质感，强调女性独居场景，标题更克制，不要太营销化。"
      ></textarea>
      <div class="idea-prompt-meta" data-test="idea-prompt-meta">{{ displayMeta }}</div>
    </div>

    <div class="idea-cards" data-test="idea-list">
      <template v-if="brand && brand._detailLoaded && trend">
        <article v-for="(idea, index) in trend.ideas" :key="index" class="idea-card" data-test="idea-card">
          <form v-if="editingDrafts[index]" class="idea-edit-form" @submit.prevent="saveIdea(index)">
            <label>
              <span>选题标题</span>
              <input v-model="editingDrafts[index].title" name="title" />
            </label>
            <label>
              <span>内容摘要</span>
              <textarea v-model="editingDrafts[index].summary" name="summary" rows="3"></textarea>
            </label>
            <div class="form-row">
              <label>
                <span>切入角度</span>
                <input v-model="editingDrafts[index].angle" name="angle" />
              </label>
              <label>
                <span>面向人群</span>
                <input v-model="editingDrafts[index].audience" name="audience" />
              </label>
            </div>
            <label>
              <span>品牌结合方式</span>
              <input v-model="editingDrafts[index].brandFit" name="brandFit" />
            </label>
            <label>
              <span>开头钩子</span>
              <input v-model="editingDrafts[index].hook" name="hook" />
            </label>
            <p v-if="editErrors[index]" class="idea-error" data-test="idea-edit-error">{{ editErrors[index] }}</p>
            <div class="idea-edit-actions">
              <button class="primary-btn small-btn" type="submit">确认</button>
              <button class="secondary-btn small-btn" type="button" @click="cancelEdit(index)">取消</button>
            </div>
          </form>

          <template v-else>
            <div class="idea-title-row">
              <h3>{{ idea.title }}</h3>
              <button class="text-btn" type="button" data-test="edit-idea" @click="startEdit(index)">编辑</button>
            </div>
            <div><strong>内容摘要：</strong>{{ idea.summary }}</div>
            <div><strong>切入角度：</strong>{{ idea.angle }}</div>
            <div><strong>品牌结合方式：</strong>{{ idea.brandFit }}</div>
            <div><strong>面向人群：</strong>{{ idea.audience }}</div>
            <div><strong>开头钩子：</strong>{{ idea.hook }}</div>

            <div v-if="!hasCompleteIdeaContentAssets(idea)" class="idea-asset-preview is-incomplete">
              趋势和选题已生成。朋友圈、小红书和公众号的完整发布文案会在你首次生成对应内容时自动补齐。
            </div>
            <div v-else class="idea-asset-preview">
              <div><strong>朋友圈标题：</strong>{{ idea.contentAssets.moments?.title || "" }}</div>
              <div><strong>朋友圈文案：</strong>{{ idea.contentAssets.moments?.caption || "" }}</div>
              <div>
                <strong>小红书标题：</strong
                >{{ idea.contentAssets.xhsCarousel?.publishTitle || idea.contentAssets.xhsCarousel?.title || "" }}
              </div>
              <div>
                <strong>小红书文案：</strong
                >{{ idea.contentAssets.xhsCarousel?.publishCaption || idea.contentAssets.xhsCarousel?.caption || "" }}
              </div>
            </div>

            <div class="idea-actions">
              <button
                class="primary-btn small-btn"
                type="button"
                data-test="go-generation"
                @click="goToGeneration(index)"
              >
                去生成内容
              </button>
            </div>
            <div class="idea-tag-list">
              <span v-for="tag in idea.tags" :key="tag" class="idea-tag">{{ tag }}</span>
            </div>
          </template>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.ideas-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-icon-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: rgba(52, 199, 36, 0.12);
  color: var(--color-success);
  font-weight: 700;
}

.panel-title {
  margin: 0;
  font-size: 22px;
}

.panel-subtitle {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.error-banner {
  border: 1px solid rgba(245, 74, 69, 0.4);
  background: rgba(245, 74, 69, 0.06);
  color: var(--color-danger);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.idea-context-card,
.idea-prompt-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.idea-context-top {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.idea-context-top h3 {
  margin: 0 0 8px;
  font-size: 16px;
}

.idea-copy {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.idea-prompt-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.idea-prompt-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.idea-prompt-card textarea {
  width: 100%;
  margin-top: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
  font-size: 13px;
  resize: vertical;
}

.idea-prompt-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.idea-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.idea-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.idea-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.idea-title-row h3 {
  margin: 0;
  font-size: 15px;
}

.idea-asset-preview {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.idea-asset-preview.is-incomplete {
  color: var(--color-text-secondary);
}

.idea-actions {
  display: flex;
  gap: 8px;
}

.idea-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.idea-tag {
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: 999px;
  padding: 2px 10px;
}

.idea-edit-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.idea-edit-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.idea-edit-form input,
.idea-edit-form textarea {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px;
  font-size: 13px;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.idea-edit-actions {
  display: flex;
  gap: 8px;
}

.idea-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger);
}

.primary-btn {
  border: none;
  background: var(--color-brand);
  color: #fff;
  border-radius: var(--radius-md);
  padding: 8px 14px;
  cursor: pointer;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 13px;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.primary-btn small {
  font-size: 11px;
  opacity: 0.85;
}

.secondary-btn {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}

.text-btn {
  border: none;
  background: none;
  color: var(--color-brand);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
}

/* Legacy light-workspace parity: all Vue editing and generation routes remain intact. */
.ideas-panel {
  gap: 0;
  color: var(--workspace-text);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.panel-icon-title {
  gap: 14px;
}

.panel-icon {
  display: block;
  width: 14.40625px;
  height: auto;
  border-radius: 0;
  background: transparent;
  color: #4c9775;
  font-size: 1.8rem;
  font-weight: 400;
}

.panel-title {
  color: var(--workspace-text);
  font-size: 2.1rem;
  font-family: var(--workspace-font-heading);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.panel-subtitle {
  margin-top: 10px;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.error-banner {
  border-radius: var(--workspace-radius-sm);
}

.idea-context-card,
.idea-prompt-card,
.idea-card {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.idea-context-card,
.idea-prompt-card,
.idea-card {
  padding: 20px;
}

.idea-context-card,
.idea-prompt-card {
  margin-bottom: 24px;
}

.idea-context-card > .idea-copy {
  margin: 0;
}

.idea-context-top {
  gap: 18px;
}

.idea-context-top h3,
.idea-prompt-header h3,
.idea-title-row h3 {
  color: var(--workspace-text);
  font-size: 1.2rem;
  line-height: 1.6;
}

.idea-copy {
  margin: 1em 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.idea-prompt-header {
  gap: 16px;
  margin-bottom: 16px;
}

.idea-prompt-header h3 {
  margin: 0 0 8px;
}

.idea-prompt-card textarea,
.idea-edit-form input,
.idea-edit-form textarea {
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #fff;
  color: var(--workspace-text);
  outline: none;
}

.idea-prompt-card textarea {
  min-height: 132px;
  margin-top: 0;
  padding: 14px;
  font-size: 0.94rem;
  line-height: 1.6;
}

.idea-prompt-card textarea:focus,
.idea-edit-form input:focus,
.idea-edit-form textarea:focus {
  border-color: rgba(216, 68, 68, 0.5);
  box-shadow: 0 0 0 3px rgba(216, 68, 68, 0.08);
}

.idea-prompt-meta {
  display: flex;
  align-items: center;
  margin-top: 12px;
  color: #b9b2cd;
  font-size: 0.95rem;
  line-height: 1.6;
}

.idea-cards {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
}

.idea-card {
  display: grid;
  gap: 14px;
  font-size: 0.92rem;
  line-height: 1.65;
}

.idea-card strong {
  color: #bf3641;
}

.idea-title-row {
  gap: 12px;
}

.idea-asset-preview {
  gap: 8px;
  padding: 12px;
  border-color: var(--workspace-border);
  border-radius: var(--workspace-radius-sm);
  background: #faf7f5;
  line-height: 1.65;
}

.idea-asset-preview.is-incomplete {
  color: var(--workspace-text-muted);
}

.idea-actions {
  gap: 12px;
  margin-top: 4px;
}

.idea-tag-list {
  gap: 8px;
}

.idea-tag {
  padding: 4px 10px;
  border-radius: var(--workspace-radius-sm);
  background: #f5f1ef;
  color: var(--workspace-text-muted);
}

.idea-edit-form {
  gap: 12px;
}

.idea-edit-form label {
  gap: 6px;
  color: #5f5357;
  font-size: 0.86rem;
}

.idea-edit-form input,
.idea-edit-form textarea {
  padding: 10px 11px;
  font-size: 0.92rem;
}

.idea-error {
  color: #b72e3a;
}

.primary-btn,
.secondary-btn {
  min-height: 42px;
  padding: 0 16px;
  border-radius: var(--workspace-radius-sm);
  font-size: 0.92rem;
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

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.2);
  background: #fff8f7;
}

.text-btn {
  color: var(--workspace-brand-ink);
}

@media (max-width: 1180px) {
  .idea-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .idea-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
