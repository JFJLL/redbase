const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/excellent-list-state.js"), "utf8");
const sandbox = { module: { exports: {} }, exports: {} };
const transformed = source
  .replace(/export function (\w+)/g, "function $1")
  .concat(
    "\nmodule.exports = { shouldApplyExcellentListResult, applyExcellentListResult, applyExcellentListError, applyExcellentRefreshResult, applyExcellentRefreshError, excellentContentCacheKey };\n",
  );
vm.runInNewContext(transformed, { module: sandbox.module, exports: sandbox.exports });
const {
  shouldApplyExcellentListResult,
  applyExcellentListResult,
  applyExcellentListError,
  applyExcellentRefreshResult,
  applyExcellentRefreshError,
  excellentContentCacheKey,
} = sandbox.module.exports;

function makeSlice(overrides = {}) {
  return {
    items: [],
    status: "loading",
    error: "",
    updatedAt: "",
    stale: false,
    requestId: 1,
    contentSource: "all",
    ...overrides,
  };
}

test("xhs result still writes xhs slice after switch to ecommerce", () => {
  const xhsSlice = makeSlice({ requestId: 3, status: "loading" });
  const ecomSlice = makeSlice({
    requestId: 1,
    status: "ready",
    items: [{ noteId: "ecom-1" }],
  });

  const applied = applyExcellentListResult({
    slice: xhsSlice,
    requestId: 3,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: {
      items: [{ noteId: "xhs-1" }, { noteId: "xhs-2" }],
      updatedAt: "2026-07-23T00:00:00.000Z",
      stale: false,
    },
    activeBoard: "ecommerce_hot",
    requestBoard: "xhs_hot",
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.isActive, false);
  assert.equal(xhsSlice.status, "ready");
  assert.equal(xhsSlice.items.length, 2);
  assert.equal(xhsSlice.items[0].noteId, "xhs-1");
  // ecommerce UI slice must not be touched by xhs result
  assert.equal(ecomSlice.items[0].noteId, "ecom-1");
  assert.equal(ecomSlice.status, "ready");
});

test("stale requestId does not overwrite newer board request", () => {
  const slice = makeSlice({ requestId: 5, status: "loading", items: [{ noteId: "new" }] });
  const applied = applyExcellentListResult({
    slice,
    requestId: 4,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: { items: [{ noteId: "old" }], updatedAt: "t", stale: false },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(applied.applied, false);
  assert.equal(slice.items[0].noteId, "new");
  assert.equal(slice.status, "loading");
});

test("session epoch mismatch does not write slice", () => {
  const slice = makeSlice({ requestId: 2, status: "loading" });
  const applied = applyExcellentListResult({
    slice,
    requestId: 2,
    sessionEpoch: 9,
    loadEpoch: 8,
    result: { items: [{ noteId: "x" }], updatedAt: "t", stale: false },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(applied.applied, false);
  assert.equal(slice.status, "loading");
  assert.equal(slice.items.length, 0);
});

test("error clears loading so board never stays loading forever", () => {
  const slice = makeSlice({ requestId: 2, status: "loading" });
  const applied = applyExcellentListError({
    slice,
    requestId: 2,
    sessionEpoch: 1,
    loadEpoch: 1,
    error: new Error("network"),
    preserveItems: false,
    hadItems: false,
    activeBoard: "ecommerce_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.isActive, false);
  assert.equal(slice.status, "error");
  assert.match(slice.error, /network|失败/);
});

test("error with preserveItems keeps ready items", () => {
  const slice = makeSlice({
    requestId: 2,
    status: "loading",
    items: [{ noteId: "cached" }],
  });
  const applied = applyExcellentListError({
    slice,
    requestId: 2,
    sessionEpoch: 1,
    loadEpoch: 1,
    error: new Error("down"),
    preserveItems: true,
    hadItems: true,
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.isActive, true);
  assert.equal(slice.status, "ready");
  assert.equal(slice.items[0].noteId, "cached");
});

test("refresh result replaces items; refresh error keeps old items", () => {
  const slice = makeSlice({
    requestId: 3,
    status: "ready",
    items: [{ noteId: "old" }],
    refreshing: true,
  });
  const ok = applyExcellentRefreshResult({
    slice,
    requestId: 3,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: {
      items: [{ noteId: "new" }],
      updatedAt: "2026-07-23T12:00:00.000Z",
      hasCache: true,
    },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(ok.applied, true);
  assert.equal(slice.items[0].noteId, "new");
  assert.equal(slice.refreshing, false);
  assert.equal(slice.refreshError, "");

  slice.requestId = 4;
  slice.refreshing = true;
  slice.items = [{ noteId: "keep" }];
  const failed = applyExcellentRefreshError({
    slice,
    requestId: 4,
    sessionEpoch: 1,
    loadEpoch: 1,
    error: new Error("down"),
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(failed.applied, true);
  assert.equal(slice.items[0].noteId, "keep");
  assert.equal(slice.refreshing, false);
  assert.match(slice.refreshError, /更新失败/);
});

test("list empty result marks needsUpdate", () => {
  const slice = makeSlice({ requestId: 1, status: "loading" });
  applyExcellentListResult({
    slice,
    requestId: 1,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: { items: [], hasCache: false, needsUpdate: true, updatedAt: "" },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(slice.status, "empty");
  assert.equal(slice.hasCache, false);
  assert.equal(slice.needsUpdate, true);
  assert.equal(slice.items.length, 0);
});

test("shouldApplyExcellentListResult gates requestId and epoch", () => {
  assert.equal(
    shouldApplyExcellentListResult({
      requestId: 1,
      sliceRequestId: 1,
      sessionEpoch: 2,
      loadEpoch: 2,
    }),
    true,
  );
  assert.equal(
    shouldApplyExcellentListResult({
      requestId: 1,
      sliceRequestId: 2,
      sessionEpoch: 2,
      loadEpoch: 2,
    }),
    false,
  );
});

test("excellentContentCacheKey isolates board source and taxonomy", () => {
  assert.equal(
    excellentContentCacheKey("xhs_hot", "professional", "内容类目#美妆"),
    "xhs_hot::professional::内容类目#美妆",
  );
  assert.notEqual(
    excellentContentCacheKey("xhs_hot", "all", ""),
    excellentContentCacheKey("ecommerce_hot", "all", ""),
  );
});

test("later filter result overwrites earlier filter for same board", () => {
  const slice = makeSlice({ requestId: 10, status: "loading" });
  applyExcellentListResult({
    slice,
    requestId: 10,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: { items: [{ noteId: "final-filter" }], updatedAt: "t2", stale: false },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  assert.equal(slice.items[0].noteId, "final-filter");
  assert.equal(slice.status, "ready");
});
