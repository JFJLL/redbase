<script setup lang="ts">
import { computed, ref } from "vue";
import type { VideoScriptClip } from "../api";

const props = defineProps<{
  clip: VideoScriptClip;
  index: number;
}>();

const expanded = ref(false);
const copiedPrompt = ref(false);
const copiedClip = ref(false);

function toggleExpand() {
  expanded.value = !expanded.value;
}

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

const timeRangeLabel = computed(() => {
  const start = formatSec(props.clip.startSec ?? 0);
  const end = formatSec(props.clip.endSec ?? 0);
  const duration = props.clip.durationSec || (props.clip.endSec - props.clip.startSec) || 0;
  return start + " - " + end + " (" + duration + "s)";
});

async function copyPrompt(event?: Event) {
  event?.stopPropagation();
  try {
    await navigator.clipboard.writeText(props.clip.prompt || "");
    copiedPrompt.value = true;
    setTimeout(() => {
      copiedPrompt.value = false;
    }, 2000);
  } catch {
    /* ignore */
  }
}

async function copyFullClip(event?: Event) {
  event?.stopPropagation();
  const text = [
    "### 片段 " + (props.clip.index || props.index + 1) + "：" + (props.clip.purpose || "分镜"),
    "- 时间：" + timeRangeLabel.value,
    "- 主体参考：" + (props.clip.subjectReference || "-"),
    "- 场景描述：" + (props.clip.scene || "-"),
    "- 主体动作：" + (props.clip.subjectAction || "-"),
    "- 镜头运动：" + (props.clip.cameraMovement || "-"),
    "- 环境动态：" + (props.clip.environmentMotion || "-"),
    "- 光影与风格：" + (props.clip.lightingAndStyle || "-"),
    "- 首帧画面：" + (props.clip.firstFrame || "-"),
    "- 尾帧画面：" + (props.clip.lastFrame || "-"),
    "- 音频提示：" + (props.clip.audioPrompt || "-"),
    props.clip.voiceover ? "- 旁白：" + props.clip.voiceover : "",
    props.clip.dialogue ? "- 对话：" + props.clip.dialogue : "",
    props.clip.onScreenText ? "- 画面花字：" + props.clip.onScreenText : "",
    props.clip.transition ? "- 转场：" + props.clip.transition : "",
    props.clip.continuity ? "- 连续性：" + props.clip.continuity : "",
    "",
    "#### AI 视频模型提示词",
    "```text",
    props.clip.prompt || "",
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await navigator.clipboard.writeText(text);
    copiedClip.value = true;
    setTimeout(() => {
      copiedClip.value = false;
    }, 2000);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="video-clip-row" :class="{ 'is-expanded': expanded }" :data-test="'video-clip-row-' + index">
    <div class="clip-summary" @click="toggleExpand">
      <div class="clip-summary-left">
        <span class="clip-index-badge">#{{ clip.index || index + 1 }}</span>
        <strong class="clip-time">{{ timeRangeLabel }}</strong>
        <span class="clip-purpose-tag">{{ clip.purpose || "分镜片段" }}</span>
      </div>

      <div class="clip-actions-col">
        <button
          type="button"
          class="secondary-btn clip-action-btn"
          :data-test="'copy-clip-prompt-' + index"
          @click.stop="copyPrompt"
        >
          {{ copiedPrompt ? "已复制提示词" : "复制提示词" }}
        </button>
        <button
          type="button"
          class="secondary-btn clip-action-btn"
          :data-test="'copy-clip-full-' + index"
          @click.stop="copyFullClip"
        >
          {{ copiedClip ? "已复制片段" : "复制片段" }}
        </button>
        <button
          type="button"
          class="toggle-expand-btn"
          :aria-expanded="expanded"
          :data-test="'toggle-clip-expand-' + index"
          @click.stop="toggleExpand"
        >
          {{ expanded ? "收起" : "展开详情" }}
          <span class="expand-chevron" :class="{ 'is-expanded': expanded }" aria-hidden="true">▾</span>
        </button>
      </div>
    </div>

    <div v-if="expanded" class="clip-details" :data-test="'clip-details-' + index">
      <div class="details-grid">
        <div class="detail-item">
          <strong>主体参考</strong>
          <p>{{ clip.subjectReference || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>场景环境</strong>
          <p>{{ clip.scene || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>主体动作</strong>
          <p>{{ clip.subjectAction || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>镜头运动</strong>
          <p>{{ clip.cameraMovement || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>环境动态</strong>
          <p>{{ clip.environmentMotion || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>光影与风格</strong>
          <p>{{ clip.lightingAndStyle || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>首帧描述</strong>
          <p>{{ clip.firstFrame || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>尾帧描述</strong>
          <p>{{ clip.lastFrame || "-" }}</p>
        </div>
        <div class="detail-item">
          <strong>音频提示</strong>
          <p>{{ clip.audioPrompt || "-" }}</p>
        </div>
        <div v-if="clip.voiceover" class="detail-item">
          <strong>旁白</strong>
          <p>{{ clip.voiceover }}</p>
        </div>
        <div v-if="clip.dialogue" class="detail-item">
          <strong>对话</strong>
          <p>{{ clip.dialogue }}</p>
        </div>
        <div v-if="clip.onScreenText" class="detail-item">
          <strong>画面花字</strong>
          <p>{{ clip.onScreenText }}</p>
        </div>
        <div v-if="clip.transition" class="detail-item">
          <strong>转场方式</strong>
          <p>{{ clip.transition }}</p>
        </div>
        <div v-if="clip.continuity" class="detail-item">
          <strong>连续性要求</strong>
          <p>{{ clip.continuity }}</p>
        </div>
      </div>

      <div class="clip-prompt-box">
        <div class="prompt-box-header">
          <div class="prompt-box-title">
            <span class="prompt-icon">✦</span>
            <strong>完整 AI 视频生成模型提示词</strong>
          </div>
          <button type="button" class="secondary-btn small-btn" @click.stop="copyPrompt">
            {{ copiedPrompt ? "已复制提示词" : "复制完整提示词" }}
          </button>
        </div>
        <pre class="prompt-code" :data-test="'clip-prompt-text-' + index">{{ clip.prompt }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-clip-row {
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius, 8px);
  background: var(--workspace-surface, #ffffff);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
  overflow: hidden;
}

.video-clip-row:hover {
  border-color: rgba(216, 68, 68, 0.3);
}

.video-clip-row.is-expanded {
  border-color: var(--workspace-brand, #d83b46);
  box-shadow: 0 4px 16px rgba(216, 59, 70, 0.06);
}

.clip-summary {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
  background: #fff;
  transition: background 0.16s ease;
}

.clip-summary:hover {
  background: #fffdfc;
}

.clip-summary-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.clip-index-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: 6px;
  background: #f4edea;
  color: var(--workspace-brand-ink, #7c2d32);
  font-weight: 700;
  font-size: 12.5px;
}

.clip-time {
  font-size: 13px;
  color: var(--workspace-text, #31292b);
  white-space: nowrap;
}

.clip-purpose-tag {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  background: #f3e7e2;
  color: var(--workspace-brand-ink, #7c2d32);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.clip-actions-col {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.secondary-btn {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--workspace-border, rgba(18, 16, 17, 0.12));
  border-radius: var(--workspace-radius-sm, 6px);
  background: #fff;
  color: var(--workspace-text, #31292b);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.secondary-btn:hover {
  border-color: rgba(216, 68, 68, 0.28);
  background: #fff8f7;
  color: var(--workspace-brand, #d83b46);
}

.toggle-expand-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--workspace-brand, #d83b46);
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: background 0.16s ease;
}

.toggle-expand-btn:hover {
  background: rgba(216, 68, 68, 0.08);
}

.expand-chevron {
  display: inline-block;
  transition: transform 0.2s ease;
}

.expand-chevron.is-expanded {
  transform: rotate(180deg);
}

.clip-details {
  padding: 18px 20px 22px;
  background: #faf7f5;
  border-top: 1px dashed var(--workspace-border, rgba(18, 16, 17, 0.1));
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.details-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.detail-item strong {
  font-size: 12px;
  color: var(--workspace-text-muted, #7c7074);
  font-weight: 700;
}

.detail-item p {
  margin: 0;
  color: var(--workspace-text, #31292b);
  line-height: 1.55;
}

.clip-prompt-box {
  border: 1px solid rgba(216, 68, 68, 0.18);
  border-radius: var(--workspace-radius, 8px);
  background: #ffffff;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-box-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.prompt-box-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt-icon {
  color: var(--workspace-brand, #d83b46);
  font-size: 14px;
}

.prompt-box-title strong {
  color: var(--workspace-brand-ink, #7c2d32);
  font-size: 13px;
  font-weight: 700;
}

.prompt-code {
  margin: 0;
  padding: 12px 14px;
  background: #fff9f8;
  border: 1px solid #f3dedb;
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.65;
  color: #31292b;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 760px) {
  .clip-summary {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .clip-actions-col {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
