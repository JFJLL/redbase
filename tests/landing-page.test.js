const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const landingCss = fs.readFileSync(path.join(root, "public", "landing-v3.css"), "utf8");

test("commercial landing page preserves the required product story and sections", () => {
  assert.match(indexHtml, /让品牌每天都知道[\s\S]*什么内容值得做/);
  for (const sectionId of ["problems", "workspace", "workflow", "compare", "outputs", "pricing", "faq"]) {
    assert.match(indexHtml, new RegExp(`id="${sectionId}"`));
  }
  assert.match(indexHtml, /landing-v3\.css\?v=/);
});

test("landing calls to action stay connected to the real application flows", () => {
  assert.match(indexHtml, /data-auth-open="register"/);
  assert.match(indexHtml, /data-auth-open="login"/);
  assert.match(indexHtml, /data-business-quote-open/);
  assert.match(appJs, /function bindLandingExperience\(\)/);
  assert.match(appJs, /bindLandingExperience\(\);/);
});

test("landing media is local and desktop layout prevents horizontal overflow", () => {
  assert.doesNotMatch(indexHtml, /image\.qwenlm\.ai/);
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
    assert.match(indexHtml, new RegExp(`\\./assets/${asset.replaceAll(".", "\\.")}`));
  }
  assert.doesNotMatch(indexHtml, /landing-content-[^"' ]+-v\d+\.webp/);
  assert.match(indexHtml, /href="\/assets\/favicon\.ico"/);
  assert.match(indexHtml, /href="\/assets\/favicon-32\.png"/);
  assert.match(indexHtml, /href="\/assets\/apple-touch-icon\.png"/);
  assert.doesNotMatch(indexHtml, /\.\/assets\/home-(trend-insight|idea-generation|brand-archive)\.webp/);
  assert.match(indexHtml, /landing-v3\.css\?v=20260727-gpt-image-assets-v1/);
  assert.match(landingCss, /\.hero-grid\s*\{[\s\S]*grid-template-columns:\s*1\.02fr 0\.98fr/);
  assert.match(landingCss, /\.card-media\s*\{[\s\S]*aspect-ratio:\s*5\s*\/\s*2/);
  assert.match(landingCss, /\.history-preview img\s*\{[\s\S]*aspect-ratio:\s*2\s*\/\s*1/);
  assert.match(landingCss, /\.learning-panel > img\s*\{[\s\S]*aspect-ratio:\s*5\s*\/\s*6/);
  assert.match(landingCss, /\.outputs-grid article > div\s*\{[\s\S]*aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(landingCss, /\.compare-table-wrap\s*\{[\s\S]*overflow:\s*hidden/);
});
