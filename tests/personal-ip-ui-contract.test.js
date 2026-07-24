const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
const stylesCss = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

const personalRenderer = appJs.slice(appJs.indexOf("function renderPersonalIps()"), appJs.indexOf("function renderBrandChips()"));
const personalTabSwitch = appJs.slice(appJs.indexOf('if (tab === "personal")'), appJs.indexOf('if (tab === "excellent")'));

test("personal IP page mirrors the brand archive create pattern", () => {
  const createButton = indexHtml.match(/<button[^>]*id="openPersonalModal"[^>]*>新增个人 IP<\/button>/)?.[0] || "";
  assert.ok(createButton);
  assert.doesNotMatch(createButton, /\shidden(?:\s|>)/);
  assert.match(personalRenderer, /<article class="brand-card">/);
  assert.match(personalRenderer, /点击右上角“新增个人 IP”/);
  assert.doesNotMatch(personalRenderer, /data-personal-create/);
});

test("personal IP page does not render or load the creator material library", () => {
  assert.doesNotMatch(indexHtml, /id="personalMaterial(?:Panel|Form|List)"/);
  assert.doesNotMatch(personalRenderer, /personalMaterial|creatorMaterials|materialCount/);
  assert.doesNotMatch(personalTabSwitch, /loadCreatorMaterials/);
  assert.doesNotMatch(stylesCss, /\.personal-material-panel/);
});
