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

async function copyPrompt(event: Event) {
  event.stopPropagation();
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

async function copyFullClip(event: Event) {
  event.stopPropagation();
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
      <div class="clip-time-col">
        <span class="clip-index-badge">#{{ clip.index || index + 1 }}</span>
        <strong class="clip-time">{{ timeRangeLabel }}</strong>
      </div>
      <div class="clip-purpose-col">
        <span class="clip-purpose-tag">{{ clip.purpose || "分镜片段" }}</span>
      </div>
      <div class="clip-frames-col">
        <div class="frame-brief">
          <span class="frame-label">首帧：</span>
          <span class="frame-text">{{ clip.firstFrame || "-" }}</span>
        </div>
        <div class="frame-brief">
          <span class="frame-label">尾帧：</span>
          <span class="frame-text">{{ clip.lastFrame || "-" }}</span>
        </div>
      </div>
      <div class="clip-motion-col">
        <div><strong>主体：</strong>{{ clip.subjectAction || "-" }}</div>
        <div><strong>运镜：</strong>{{ clip.cameraMovement || "-" }}</div>
      </div>
      <div class="clip-audio-col">
        <span class="clip-audio-text">{{ clip.audioPrompt || "-" }}</span>
      </div>
      <div class="clip-actions-col">
        <button
          type="button"
          class="secondary-btn clip-action-btn"
          :data-test="'copy-clip-prompt-' + index"
          @click="copyPrompt"
        >
          {{ copiedPrompt ? "已复制提示词" : "复制提示词" }}
        </button>
        <button
          type="button"
          class="secondary-btn clip-action-btn"
          :data-test="'copy-clip-full-' + index"
          @click="copyFullClip"
        >
          {{ copiedClip ? "已复制片段" : "复制片段" }}
        </button>
        <button
          type="button"
          class="toggle-expand-btn"
          :aria-expanded="expanded"
          :data-test="'toggle-clip-expand-' + index"
        >
          {{ expanded ? "收起" : "展开详情" }}
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
          <strong>完整 AI 视频生成模型提示词</strong>
          <button type="button" class="secondary-btn small-btn" @click="copyPrompt">
            {{ copiedPrompt ? "已复制" : "复制完整提示词" }}
          </button>
        </div>
        <pre class="prompt-code" :data-test="'clip-prompt-text-' + index">{{ clip.prompt }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-clip-row {
  border: 1px solid var(--workspace-border, #eae5e3);
  border-radius: var(--workspace-radius, 8px);
  background: var(--workspace-surface, #ffffff);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
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
  display: grid;
  grid-template-columns: 140px 110px minmax(200px, 1.2fr) minmax(180px, 1fr) minmax(140px, 0.8fr) 180px;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}

.clip-time-col {
  display: flex;
  align-items: center;
  gap: 8px;
}

.clip-index-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: #f4edea;
  color: #a82e38;
  font-weight: 700;
  font-size: 12px;
}

.clip-time {
  font-size: 12px;
  color: var(--workspace-text, #333);
  white-space: nowrap;
}

.clip-purpose-tag {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  background: #eef5ff;
  color: #2b5cb8;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.clip-frames-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  overflow: hidden;
}

.frame-brief {
  display: flex;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.frame-label {
  color: var(--workspace-text-muted, #7c7074);
  flex-shrink: 0;
}

.frame-text {
  color: var(--workspace-text, #333);
  overflow: hidden;
  text-overflow: ellipsis;
}

.clip-motion-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--workspace-text, #333);
  overflow: hidden;
}

.clip-motion-col div {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clip-audio-col {
  font-size: 12px;
  color: var(--workspace-text-muted, #7c7074);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip-actions-col {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.clip-action-btn {
  padding: 4px 8px;
  font-size: 12px;
  min-height: 28px;
}

.toggle-expand-btn {
  border: none;
  background: transparent;
  color: var(--workspace-brand, #d83b46);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px;
}

.clip-details {
  padding: 16px 20px 20px;
  background: #faf7f5;
  border-top: 1px dashed var(--workspace-border, #eae5e3);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.details-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.detail-item strong {
  font-size: 12px;
  color: #7c7074;
}

.detail-item p {
  margin: 0;
  color: var(--workspace-text, #222);
  line-height: 1.5;
}

.clip-prompt-box {
  border: 1px solid rgba(216, 68, 68, 0.18);
  border-radius: 8px;
  background: #ffffff;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-box-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.prompt-box-header strong {
  color: #a82e38;
  font-size: 13px;
}

.prompt-code {
  margin: 0;
  padding: 10px;
  background: #fff9f8;
  border: 1px solid #f3dedb;
  border-radius: 6px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  color: #2b2224;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 960px) {
  .clip-summary {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .clip-frames-col,
  .clip-motion-col,
  .clip-audio-col {
    grid-column: 1 / -1;
  }
  .clip-actions-col {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
}
</style>
