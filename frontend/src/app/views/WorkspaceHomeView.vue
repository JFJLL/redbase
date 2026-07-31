<script setup lang="ts">
const entries = [
  {
    name: "brands",
    title: "品牌档案",
    desc: "沉淀品牌定位、产品卖点、目标受众和运营目标，为 AI 建立清晰上下文。",
    action: "去管理品牌",
  },
  {
    name: "personal",
    title: "个人 IP",
    desc: "沉淀人设定位、内容支柱和表达风格，让 AI 更像你本人。",
    action: "去管理个人 IP",
  },
  {
    name: "trends",
    title: "趋势分析",
    desc: "从全网热点中筛选最适配品牌的趋势机会，输出热度、标签和适配理由。",
    action: "去看趋势",
  },
  {
    name: "ideas",
    title: "内容选题",
    desc: "把品牌资产和热点趋势结合起来，生成可执行的小红书内容方向。",
    action: "去看选题",
  },
] as const;
</script>

<template>
  <section class="home-panel">
    <h1 class="home-title">RedBase</h1>
    <p class="home-subtitle">围绕品牌资产、个人 IP、热点分析和内容选题打造一站式小红书运营工作台。</p>
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
.home-panel {
  width: 100%;
}

.home-title {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 2.1rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.6;
}

.home-subtitle {
  margin: 10px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.93rem;
  line-height: 1.6;
}

.home-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--workspace-grid-gap);
  align-items: start;
}

.home-card {
  position: relative;
  padding: 20px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
  box-shadow: none;
}

.home-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: -1px;
  width: 42px;
  height: 2px;
  background: var(--workspace-brand);
}

.home-card-title {
  margin: 0 0 14px;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.2rem;
  font-weight: 800;
  letter-spacing: -0.04em;
}

.home-card-desc {
  margin: 0 0 14px;
  color: var(--workspace-text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.inline-link {
  color: var(--workspace-brand-ink);
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  text-decoration: none;
}

.inline-link:hover {
  color: #9f2f34;
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 1100px) {
  .home-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .home-title {
    font-size: 28px;
  }

  .home-grid {
    grid-template-columns: 1fr;
  }
}
</style>
