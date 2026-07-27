import "./landing.css";

// Lightweight landing entry — MUST NOT import Vue, Pinia, or any workspace
// module. The Core agent owns everything under src/landing/.
const root = document.getElementById("landing-root");

if (root) {
  root.innerHTML = `
    <header class="landing-header">
      <div class="landing-logo">RedBase</div>
      <nav class="landing-nav">
        <a class="landing-cta" href="/app/login">登录</a>
        <a class="landing-cta landing-cta-primary" href="/app/register">免费注册</a>
      </nav>
    </header>
    <main class="landing-hero">
      <h1>小红书内容运营工作台</h1>
      <p>趋势洞察 · 内容选题 · AI 图文生成</p>
      <a class="landing-cta landing-cta-primary" href="/app/">进入工作台</a>
    </main>
  `;
}
