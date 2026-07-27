<script setup lang="ts">
// Workspace home tab (orchestrator-owned): quick links into the business tabs,
// mirroring the legacy home panel's jump entries.
const entries = [
  { name: "brands", title: "品牌档案", desc: "维护品牌资料，为生成提供上下文", action: "去创建品牌" },
  { name: "personal", title: "个人 IP", desc: "打造个人 IP 内容资产", action: "去创建个人 IP" },
  { name: "trends", title: "趋势分析", desc: "获取真实证据支撑的趋势洞察", action: "去看趋势" },
  { name: "ideas", title: "内容选题", desc: "从趋势生成可执行选题", action: "去做选题" },
] as const;
</script>

<template>
  <section class="home-panel">
    <h1 class="home-title">首页</h1>
    <div class="home-grid">
      <article v-for="entry in entries" :key="entry.name" class="home-card">
        <h2 class="home-card-title">{{ entry.title }}</h2>
        <p class="home-card-desc">{{ entry.desc }}</p>
        <RouterLink class="inline-link" :to="{ name: entry.name }">{{ entry.action }}</RouterLink>
      </article>
    </div>
  </section>
</template>

<style scoped>
.home-title {
  font-size: 20px;
  margin: 0 0 16px;
}

.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.home-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.home-card-title {
  font-size: 16px;
  margin: 0 0 8px;
}

.home-card-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0 0 12px;
}

.inline-link {
  color: var(--color-brand);
  font-size: 13px;
  text-decoration: none;
}
</style>
