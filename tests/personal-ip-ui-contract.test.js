// 迁移说明：原断言对象 public/index.html、public/app.js、public/styles.css
// 已随旧前端删除。1:1 改写为读取新实现：
//   frontend/src/features/personal/views/PersonalIpView.vue
// 映射变化：
// - 旧 id="openPersonalModal" 按钮 → @click="openCreateProfile" 按钮（同文案）。
// - 旧 renderPersonalIps() 渲染片段 → PersonalIpView 模板中的 brand-card 列表。
// - 【缺口已在最终修复轮修复】旧契约要求个人 IP 页不渲染/不加载创作者素材库；
//   现按产品决定用 MATERIAL_LIBRARY_ENABLED=false 门控关闭素材库的自动加载与
//   管理界面（实现保留但不可达，后续另开产品需求）。下方断言为旧线上契约的
//   同强度版本：门控必须为 false，渲染与自动加载都必须被门控约束，且不得
//   存在绕过门控的渲染路径；旧素材库 DOM id、全局加载器、样式类禁止复活。
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
  // 修复后的旧线上契约：素材库默认关闭——门控常量必须为 false，
  // 管理界面渲染与自动加载都必须挂在该门控之下（不可达）。
  assert.match(personalView, /const MATERIAL_LIBRARY_ENABLED = false/);
  assert.match(personalView, /<section v-if="MATERIAL_LIBRARY_ENABLED && selectedProfile" class="material-section"/);
  assert.match(personalView, /if \(MATERIAL_LIBRARY_ENABLED && brandId != null\) void loadMaterials\(brandId\)/);
  // 素材区不得存在任何绕过门控的渲染路径。
  assert.doesNotMatch(personalView, /<section v-if="selectedProfile" class="material-section"/);
});
