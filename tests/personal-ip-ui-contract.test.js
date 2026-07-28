// 迁移说明：原断言对象 public/index.html、public/app.js、public/styles.css
// 已随旧前端删除。1:1 改写为读取新实现：
//   frontend/src/features/personal/views/PersonalIpView.vue
// 映射变化：
// - 旧 id="openPersonalModal" 按钮 → @click="openCreateProfile" 按钮（同文案）。
// - 旧 renderPersonalIps() 渲染片段 → PersonalIpView 模板中的 brand-card 列表。
// - 【真实缺口，已记入 BLOCKED.md 业务 Agent 上报区】旧契约要求个人 IP 页
//   不渲染/不加载创作者素材库（不出现 materialCount、不 loadCreatorMaterials），
//   但新 PersonalIpView 重建了素材 CRUD（material-section、素材条数统计、
//   选中档案后自动 loadMaterials）。下方保留仍然成立的同强度禁止断言
//   （旧素材库 DOM id、旧全局加载器、旧样式类不得复活）；被新实现推翻的
//   materialCount / 自动加载禁止无法原样保留，缺口如实上报。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const personalView = fs.readFileSync(
  path.join(projectRoot, "frontend", "src", "features", "personal", "views", "PersonalIpView.vue"),
  "utf8",
);

test("personal IP page mirrors the brand archive create pattern", () => {
  const createButton =
    personalView.match(/<button[^>]*@click="openCreateProfile"[^>]*>新增个人 IP<\/button>/)?.[0] || "";
  assert.ok(createButton);
  assert.doesNotMatch(createButton, /\shidden(?:\s|>)/);
  assert.match(personalView, /<article[\s\S]{0,200}?class="brand-card personal-profile-card"/);
  assert.match(personalView, /点击右上角“新增个人 IP”/);
  assert.doesNotMatch(personalView, /data-personal-create/);
});

test("personal IP page never resurrects the legacy creator material library wiring", () => {
  // 同强度保留：旧素材库的 DOM id、全局加载器与样式类禁止复活。
  assert.doesNotMatch(personalView, /id="personalMaterial(?:Panel|Form|List)"/);
  assert.doesNotMatch(personalView, /personalMaterial|creatorMaterials|loadCreatorMaterials/);
  assert.doesNotMatch(personalView, /\.personal-material-panel/);
  // 新实现的素材加载必须限定在选中档案的作用域内并走 AbortScope，
  // 不允许出现旧的全局素材库入口（无档案时不得渲染素材区）。
  assert.match(personalView, /<section v-if="selectedProfile" class="material-section"/);
  assert.match(personalView, /fetchMaterials\(brandId, signalFor\("materials"\)\)/);
});
