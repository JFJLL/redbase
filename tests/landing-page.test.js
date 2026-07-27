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
  assert.match(indexHtml, /\.\/assets\/landing-content-xhs-v2\.webp/);
  assert.match(indexHtml, /\.\/assets\/landing-content-moments-v2\.webp/);
  assert.match(indexHtml, /\.\/assets\/landing-content-longform-v2\.webp/);
  assert.doesNotMatch(indexHtml, /landing-content-[^"' ]+-v1\.webp/);
  assert.match(indexHtml, /href="\/assets\/favicon\.ico"/);
  assert.match(indexHtml, /href="\/assets\/favicon-32\.png"/);
  assert.match(indexHtml, /href="\/assets\/apple-touch-icon\.png"/);
  assert.doesNotMatch(indexHtml, /\.\/assets\/home-(trend-insight|idea-generation|brand-archive)\.webp/);
  assert.match(landingCss, /\.hero-grid\s*\{[\s\S]*grid-template-columns:\s*1\.02fr 0\.98fr/);
  assert.match(landingCss, /\.compare-table-wrap\s*\{[\s\S]*overflow:\s*hidden/);
});
