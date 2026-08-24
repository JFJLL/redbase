<script setup lang="ts">
import { computed, ref } from "vue";
import type { VideoScript } from "../api";
import VideoScriptClipRow from "./VideoScriptClipRow.vue";

const props = withDefaults(
  defineProps<{
    script: VideoScript;
    showActions?: boolean;
    showRegenerate?: boolean;
  }>(),
  {
    showActions: true,
    showRegenerate: false,
  },
);

const emit = defineEmits<{
  (e: "regenerate"): void;
  (e: "close"): void;
}>();

const copiedAllScript = ref(false);
const copiedAllPrompts = ref(false);

const title = computed(() => props.script.title || "AI 视频生成脚本");
const totalDuration = computed(() => props.script.totalDurationSec || 30);
const aspectRatio = computed(() => props.script.aspectRatio || "9:16");
const clips = computed(() => (Array.isArray(props.script.clips) ? props.script.clips : []));

function buildFullMarkdown(): string {
  const s = props.script;
  const lines = [
    `# ${title.value}`,
    "",
    `> **核心创意**：${s.creativeConcept || "-"}`,
    "",
    `- **总时长**：${totalDuration.value} 秒`,
    `- **视频比例**：${aspectRatio.value}`,
    `- **分段数量**：${clips.value.length} 个片段`,
    `- **主体参考**：${s.globalSubjectReference || "-"}`,
    `- **风格参考**：${s.globalStyleReference || "-"}`,
    `- **连贯性要求**：${s.globalContinuity || "-"}`,
    "",
    "## 音频方向",
    `- **BGM 音乐**：${s.audioDirection?.music || "-"}`,
    `- **环境音效**：${s.audioDirection?.ambience || "-"}`,
    `- **解说/配音语调**：${s.audioDirection?.voiceStyle || "-"}`,
    "",
    "---",
    "",
    "## 分镜脚本与提示词",
    "",
  ];

  clips.value.forEach((clip, index) => {
    const duration = clip.durationSec || (clip.endSec - clip.startSec) || 0;
    lines.push(`### 片段 ${clip.index || index + 1}：${clip.purpose || "分镜"}`);
    lines.push(`- **时间**：${clip.startSec ?? 0}s - ${clip.endSec ?? duration}s (${duration}s)`);
    lines.push(`- **主体参考**：${clip.subjectReference || "-"}`);
    lines.push(`- **场景环境**：${clip.scene || "-"}`);
    lines.push(`- **主体动作**：${clip.subjectAction || "-"}`);
    lines.push(`- **镜头运动**：${clip.cameraMovement || "-"}`);
    lines.push(`- **环境动态**：${clip.environmentMotion || "-"}`);
    lines.push(`- **光影风格**：${clip.lightingAndStyle || "-"}`);
    lines.push(`- **首帧画面**：${clip.firstFrame || "-"}`);
    lines.push(`- **尾帧画面**：${clip.lastFrame || "-"}`);
    lines.push(`- **音频提示**：${clip.audioPrompt || "-"}`);
    if (clip.voiceover) lines.push(`- **旁白**：${clip.voiceover}`);
    if (clip.dialogue) lines.push(`- **对话**：${clip.dialogue}`);
    if (clip.onScreenText) lines.push(`- **画面花字**：${clip.onScreenText}`);
    if (clip.transition) lines.push(`- **转场**：${clip.transition}`);
    if (clip.continuity) lines.push(`- **连续性**：${clip.continuity}`);
    lines.push("");
    lines.push("#### AI 视频生成模型完整提示词");
    lines.push("```text");
    lines.push(clip.prompt || "");
    lines.push("```");
    lines.push("");
  });

  return lines.join("\n");
}

function buildAllPromptsText(): string {
  return clips.value
    .map((clip, index) => {
      const idx = clip.index || index + 1;
      const purpose = clip.purpose ? ` (${clip.purpose})` : "";
      return `// 片段 ${idx}${purpose} [${clip.startSec}s-${clip.endSec}s]\n${clip.prompt || ""}`;
    })
    .join("\n\n");
}

async function copyAllScript() {
  try {
    await navigator.clipboard.writeText(buildFullMarkdown());
    copiedAllScript.value = true;
    setTimeout(() => {
      copiedAllScript.value = false;
    }, 2000);
  } catch {
    /* ignore */
  }
}

async function copyAllPrompts() {
  try {
    await navigator.clipboard.writeText(buildAllPromptsText());
    copiedAllPrompts.value = true;
    setTimeout(() => {
      copiedAllPrompts.value = false;
    }, 2000);
  } catch {
    /* ignore */
  }
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportMarkdown() {
  const safeName = title.value.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 40);
  downloadFile(buildFullMarkdown(), `${safeName}-video-script.md`, "text/markdown;charset=utf-8");
}

function exportJson() {
  const safeName = title.value.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 40);
  downloadFile(JSON.stringify(props.script, null, 2), `${safeName}-video-script.json`, "application/json;charset=utf-8");
}
</script>

<template>
  <section class="video-script-result" data-test="video-script-result">
    <header class="script-header">
      <div class="script-meta-top">
        <div class="script-badges">
          <span class="meta-tag brand-badge">视频脚本</span>
          <span class="meta-tag">{{ totalDuration }} 秒</span>
          <span class="meta-tag">{{ aspectRatio }}</span>
          <span class="meta-tag">{{ clips.length }} 个片段</span>
          <span v-if="script.audioDirection?.music" class="meta-tag audio-tag">
            🎵 {{ script.audioDirection.music }}
          </span>
        </div>
      </div>
      <h2 class="script-title" data-test="video-script-title">{{ title }}</h2>
      <p v-if="script.creativeConcept" class="script-concept" data-test="video-script-concept">
        <strong>核心创意：</strong>{{ script.creativeConcept }}
      </p>

      <div class="script-global-context">
        <div v-if="script.globalSubjectReference" class="global-ctx-item">
          <strong>主体参考：</strong><span>{{ script.globalSubjectReference }}</span>
        </div>
        <div v-if="script.globalStyleReference" class="global-ctx-item">
          <strong>风格参考：</strong><span>{{ script.globalStyleReference }}</span>
        </div>
        <div v-if="script.globalContinuity" class="global-ctx-item">
          <strong>全片衔接：</strong><span>{{ script.globalContinuity }}</span>
        </div>
      </div>

      <div class="script-notice" role="note">
        💡 这里只生成供 AI 视频模型使用的分镜与提示词，不会直接生成视频。可直接复制提示词给 AI 视频工具使用。
      </div>

      <div v-if="showActions" class="script-toolbar" data-test="video-script-toolbar">
        <button
          type="button"
          class="secondary-btn"
          data-test="copy-all-script"
          @click="copyAllScript"
        >
          {{ copiedAllScript ? "已复制全部脚本" : "复制全部脚本" }}
        </button>
        <button
          type="button"
          class="secondary-btn"
          data-test="copy-all-prompts"
          @click="copyAllPrompts"
        >
          {{ copiedAllPrompts ? "已复制全部提示词" : "复制全部提示词" }}
        </button>
        <button
          type="button"
          class="secondary-btn"
          data-test="export-markdown"
          @click="exportMarkdown"
        >
          导出 Markdown
        </button>
        <button
          type="button"
          class="secondary-btn"
          data-test="export-json"
          @click="exportJson"
        >
          导出 JSON
        </button>
        <button
          v-if="showRegenerate"
          type="button"
          class="primary-btn"
          data-test="video-script-regenerate"
          @click="emit('regenerate')"
        >
          重新生成
        </button>
      </div>
    </header>

    <div class="clips-container">
      <div class="clips-table-head" aria-hidden="true">
        <span>时间</span>
        <span>片段作用</span>
        <span>首帧 → 尾帧</span>
        <span>主体与运镜</span>
        <span>音频提示</span>
        <span style="text-align: right">操作</span>
      </div>
      <div class="clips-list" data-test="video-clips-list">
        <VideoScriptClipRow
          v-for="(clip, index) in clips"
          :key="clip.index || index"
          :clip="clip"
          :index="index"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.video-script-result {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}

.script-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border: 1px solid var(--workspace-border, #eae5e3);
  border-radius: var(--workspace-radius, 10px);
  background: var(--workspace-surface, #ffffff);
}

.script-meta-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.script-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.meta-tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  background: #f4edea;
  color: #6d4d51;
  font-size: 12px;
  font-weight: 600;
}

.brand-badge {
  background: #fff0ed;
  color: var(--workspace-brand, #d83b46);
  border: 1px solid rgba(216, 68, 68, 0.2);
}

.audio-tag {
  background: #f0f7ff;
  color: #2b5cb8;
}

.script-title {
  margin: 0;
  font-size: 1.3rem;
  color: var(--workspace-text, #222);
  line-height: 1.4;
}

.script-concept {
  margin: 0;
  font-size: 13.5px;
  color: #4b4244;
  line-height: 1.6;
}

.script-global-context {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  background: #faf7f5;
  border-radius: 8px;
  border: 1px solid rgba(216, 68, 68, 0.08);
  font-size: 13px;
}

.global-ctx-item strong {
  color: #7c7074;
}

.global-ctx-item span {
  color: var(--workspace-text, #333);
}

.script-notice {
  padding: 10px 14px;
  border-radius: 8px;
  background: #fff8eb;
  border: 1px solid #faeccb;
  color: #8c6314;
  font-size: 12.5px;
  line-height: 1.5;
}

.script-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.secondary-btn,
.primary-btn {
  min-height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
}

.secondary-btn {
  border: 1px solid var(--workspace-border, #eae5e3);
  background: #fff;
  color: var(--workspace-text, #333);
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.3);
  background: #fff8f7;
}

.primary-btn {
  border: none;
  background: var(--workspace-brand, #d83b46);
  color: #fff;
}

.primary-btn:hover {
  background: var(--workspace-brand-hover, #c7323d);
}

.clips-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.clips-table-head {
  display: grid;
  grid-template-columns: 140px 110px minmax(200px, 1.2fr) minmax(180px, 1fr) minmax(140px, 0.8fr) 180px;
  gap: 12px;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 700;
  color: var(--workspace-text-muted, #7c7074);
}

.clips-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

@media (max-width: 960px) {
  .clips-table-head {
    display: none;
  }
}
</style>
