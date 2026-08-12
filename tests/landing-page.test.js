// 迁移说明：原断言对象 public/index.html、public/app.js、public/landing-v3.css
// 已随旧前端删除。1:1 改写为读取新落地页实现：
//   frontend/src/landing/template.ts  （落地页 markup，1:1 迁移）
//   frontend/src/landing/main.ts      （bindLandingExperience 等交互移植）
//   frontend/src/landing/landing.css  （landing-v3.css 的样式移植）
//   frontend/index.html               （官网入口 html）
// 映射变化：
// - 旧 data-auth-open="register|login" 弹窗触发在 Vue 落地页中保留为同名按钮契约，
//   同时直接访问 /app/login、/app/register 仍由 SPA 路由提供。
// - 旧 landing-v3.css?v=... 手工缓存戳 → Vite 构建时对 landing.css 做内容哈希，
//   等价断言为 main.ts 顶部静态引入 ./landing.css 且不再出现旧的 landing-v3.css 链接。
// - favicon-32.png / apple-touch-icon.png 资源仍随 public/assets 发布，但
//   frontend/index.html 尚未声明这两个 link（真实缺口，已记入 BLOCKED.md
//   业务 Agent 上报区）；此处断言指向已存在的等价接线（favicon.ico link +
//   两个图标资源仍然存在）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const templateTs = fs.readFileSync(path.join(root, "frontend", "src", "landing", "template.ts"), "utf8");
const mainTs = fs.readFileSync(path.join(root, "frontend", "src", "landing", "main.ts"), "utf8");
const landingCss = fs.readFileSync(path.join(root, "frontend", "src", "landing", "landing.css"), "utf8");
const landingHtml = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
const fallbackHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("commercial landing page preserves the required product story and sections", () => {
  assert.match(templateTs, /让品牌每天都知道[\s\S]*什么内容值得做/);
  for (const sectionId of ["problems", "workspace", "workflow", "compare", "outputs", "pricing", "faq"]) {
    assert.match(templateTs, new RegExp(`id="${sectionId}"`));
  }
  // Cache-busted stylesheet: Vite content-hashes the imported landing.css at
  // build time; the legacy hand-rolled ?v= query must not survive.
  assert.match(mainTs, /import "\.\/landing\.css";/);
  assert.doesNotMatch(templateTs, /landing-v3\.css/);
  assert.doesNotMatch(landingHtml, /landing-v3\.css/);
});

test("landing calls to action stay connected to the real application flows", () => {
  assert.match(templateTs, /data-auth-open="register"/);
  assert.match(templateTs, /data-auth-open="login"/);
  assert.match(templateTs, /data-business-quote-open/);
  assert.match(mainTs, /function bindLandingExperience\(/);
  assert.match(mainTs, /bindLandingExperience\(page\);/);
  assert.match(mainTs, /redirectAuthenticatedUser/);
});

test("built-source and tracked fallback agree on one-time business-plan credits", () => {
  for (const source of [templateTs, fallbackHtml]) {
    assert.match(source, /一次到账 1000 积分/);
    assert.match(source, /一次到账 12000 积分/);
    assert.doesNotMatch(source, /积分到期自动刷新|不会结转至下个月|每月 1000 积分/);
  }
  assert.match(fallbackHtml, /href="\/app\/billing\?plan=business-monthly"/);
  assert.match(fallbackHtml, /href="\/app\/billing\?plan=business-annual"/);
});

test("landing media is local and desktop layout prevents horizontal overflow", () => {
  assert.doesNotMatch(templateTs, /image\.qwenlm\.ai/);
  for (const asset of [
    "landing-excellent-source-01.webp",
    "landing-excellent-source-02.webp",
    "landing-excellent-source-03.webp",
    "landing-generated-xhs-01.webp",
    "landing-generated-xhs-02.webp",
    "landing-generated-xhs-03.webp",
    "landing-capability-excellent.webp",
    "landing-history-thumb-01.webp",
    "landing-history-thumb-02.webp",
    "landing-history-thumb-03.webp",
    "landing-learning-example.webp",
    "landing-output-xhs.webp",
    "landing-output-moments.webp",
    "landing-output-longform.webp",
  ]) {
    assert.match(templateTs, new RegExp(`/assets/${asset.replaceAll(".", "\\.")}`));
  }
  assert.doesNotMatch(templateTs, /landing-content-[^"' ]+-v\d+\.webp/);
  assert.match(landingHtml, /href="\/assets\/favicon\.ico"/);
  // 缺口（见 BLOCKED.md）：favicon-32 / apple-touch-icon 尚未在 frontend/index.html
  // 声明；等价断言为两个图标资源仍随 public/assets 发布。
  assert.equal(fs.existsSync(path.join(root, "public", "assets", "favicon-32.png")), true);
  assert.equal(fs.existsSync(path.join(root, "public", "assets", "apple-touch-icon.png")), true);
  assert.doesNotMatch(templateTs, /assets\/home-(trend-insight|idea-generation|brand-archive)\.webp/);
  assert.match(landingCss, /\.hero-grid\s*\{[\s\S]*grid-template-columns:\s*1\.02fr 0\.98fr/);
  assert.match(landingCss, /\.card-media\s*\{[\s\S]*aspect-ratio:\s*5\s*\/\s*2/);
  assert.match(landingCss, /\.history-preview img\s*\{[\s\S]*aspect-ratio:\s*2\s*\/\s*1/);
  assert.match(landingCss, /\.learning-panel > img\s*\{[\s\S]*aspect-ratio:\s*5\s*\/\s*6/);
  assert.match(landingCss, /\.outputs-grid article > div\s*\{[\s\S]*aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(landingCss, /\.compare-table-wrap\s*\{[\s\S]*overflow:\s*hidden/);
});
