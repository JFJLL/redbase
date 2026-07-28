// 迁移说明：本文件原有 22 个用例中，21 个断言旧 public/js/excellent-list-state.js
// （现为 frontend/src/features/excellent/listState.ts）与旧 public/app.js 的
// DOM 接线（现为 frontend/src/features/excellent/views/ExcellentView.vue）。
// 这 21 个用例已 1:1 迁移至：
//   frontend/src/features/excellent/__tests__/legacyListState.test.ts（vitest）
// 仅保留下面这个只读取 src/server 与 scripts 的用例。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("server startup does not auto-warm excellent content boards", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "../src/server/index.js"), "utf8");
  assert.equal(indexSource.includes("warmAllExcellentContentBoards"), false);
  assert.equal(indexSource.includes("excellentContentWarmOnStart"), false);
  const warmScript = fs.readFileSync(path.join(__dirname, "../scripts/warm-excellent-content.js"), "utf8");
  assert.match(warmScript, /warmAllExcellentContentBoards/);
  assert.match(warmScript, /Explicit manual maintenance|人工|manual/i);
});
