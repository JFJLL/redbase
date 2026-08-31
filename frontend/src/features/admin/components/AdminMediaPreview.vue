<template>
  <div class="media-preview-container" :class="{ compact }">
    <!-- Purged State Placeholder -->
    <div v-if="assetStatus === 'purged'" class="purged-placeholder">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span class="purged-text">媒体文件已按保留策略清理，业务与统计数据仍保留。</span>
    </div>

    <!-- Purge Failed State -->
    <div v-else-if="assetStatus === 'purge_failed'" class="purged-placeholder purge-failed">
      <span class="purged-text">媒体清理暂时失败，等待下一次重试。</span>
    </div>

    <!-- Video Render -->
    <div v-else-if="isVideo" class="video-preview-wrapper">
      <video
        controls
        preload="metadata"
        :poster="posterUrl"
        class="preview-video"
        v-if="mediaUrl"
      >
        <source :src="mediaUrl" type="video/mp4" />
        您的浏览器不支持视频播放。
      </video>
      <div v-else-if="posterUrl" class="poster-only-box">
        <img :src="posterUrl" alt="视频封面" class="preview-img" />
        <span class="poster-badge">视频成片未生成</span>
      </div>
      <div v-else class="no-media-box">
        <span>暂无视频媒体</span>
      </div>
    </div>

    <!-- Text / Script Render -->
    <div v-else-if="mediaType === 'text' || (!mediaUrl && textSummary)" class="text-preview-box">
      <div class="text-concept" v-if="textSummary">{{ textSummary }}</div>
      <div class="text-fallback" v-else>无文本内容</div>
    </div>

    <!-- Image Render -->
    <div v-else-if="mediaUrl" class="image-preview-wrapper">
      <img :src="mediaUrl" alt="生成图片" class="preview-img" loading="lazy" />
    </div>

    <!-- Empty / None State -->
    <div v-else class="no-media-box">
      <span>无媒体文件</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  mediaUrl?: string;
  mediaType?: "image" | "video" | "text" | string;
  posterUrl?: string;
  assetStatus?: "available" | "purged" | "none" | "purge_failed" | string;
  textSummary?: string;
  compact?: boolean;
}>();

const isVideo = computed(() => {
  if (props.mediaType === "video") return true;
  if (props.mediaUrl && props.mediaUrl.toLowerCase().includes(".mp4")) return true;
  return false;
});
</script>

<style scoped>
.media-preview-container {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  min-height: 80px;
}

.media-preview-container.compact {
  width: 96px;
  height: 72px;
  min-height: 72px;
}
.compact .text-preview-box {
  height: 100%;
  padding: 8px;
  overflow: hidden;
}
.compact .text-concept {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-style: normal;
  line-height: 1.4;
}
.compact .preview-img,
.compact .preview-video {
  width: 100%;
  height: 72px;
  object-fit: cover;
}
.compact .purged-placeholder,
.compact .no-media-box {
  height: 100%;
  padding: 8px;
  overflow: hidden;
}
.compact .purged-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.purged-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  color: #6b7280;
  background: #f3f4f6;
  text-align: center;
}
.purged-placeholder.purge-failed {
  color: #b91c1c;
  background: #fef2f2;
}
.purged-text {
  font-size: 12px;
  font-weight: 500;
}

.video-preview-wrapper {
  width: 100%;
  display: flex;
  justify-content: center;
  background: #000000;
}
.preview-video {
  max-width: 100%;
  max-height: 320px;
  display: block;
}

.image-preview-wrapper {
  width: 100%;
  display: flex;
  justify-content: center;
  padding: 4px;
}
.preview-img {
  max-width: 100%;
  max-height: 240px;
  object-fit: contain;
  border-radius: 4px;
}

.text-preview-box {
  padding: 12px;
  font-size: 12px;
  color: #374151;
  line-height: 1.5;
  width: 100%;
  background: #ffffff;
}
.text-concept {
  font-style: italic;
}

.no-media-box {
  padding: 16px;
  color: #9ca3af;
  font-size: 12px;
}

.poster-only-box {
  position: relative;
  display: inline-block;
}
.poster-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.7);
  color: #ffffff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}
</style>
