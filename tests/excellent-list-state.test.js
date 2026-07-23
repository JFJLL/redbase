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
    "\nmodule.exports = { shouldApplyExcellentListResult, applyExcellentListResult, applyExcellentListError, applyExcellentRefreshResult, applyExcellentRefreshError, excellentContentCacheKey, excellentFiltersAreDirty, commitExcellentDraftFilters, rollbackExcellentDraftFilters, excellentRefreshResponseMatches };\n",
  );
vm.runInNewContext(transformed, { module: sandbox.module, exports: sandbox.exports });
const {
  shouldApplyExcellentListResult,
  applyExcellentListResult,
  applyExcellentListError,
  applyExcellentRefreshResult,
  applyExcellentRefreshError,
  excellentContentCacheKey,
  excellentFiltersAreDirty,
  commitExcellentDraftFilters,
  rollbackExcellentDraftFilters,
  excellentRefreshResponseMatches,
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
    categoryPath: "",
    industryPath: "",
    draftCategoryPath: "",
    draftIndustryPath: "",
    draftContentSource: "all",
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

test("category change only dirties draftCategoryPath", () => {
  const slice = makeSlice({
    items: [{ noteId: "keep-1" }],
    categoryPath: "",
    contentSource: "all",
    draftCategoryPath: "",
    draftContentSource: "all",
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
  // Simulate taxonomy change handler: only draftCategoryPath mutates.
  slice.draftCategoryPath = "内容类目#美妆";
  assert.equal(slice.categoryPath, "");
  assert.equal(slice.contentSource, "all");
  assert.equal(slice.draftContentSource, "all");
  assert.equal(slice.items[0].noteId, "keep-1");
  assert.equal(slice.updatedAt, "2026-07-23T00:00:00.000Z");
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), true);
});

test("industry change only dirties draftIndustryPath", () => {
  const slice = makeSlice({
    items: [{ noteId: "ecom-keep" }],
    industryPath: "",
    contentSource: "all",
    draftIndustryPath: "",
    draftContentSource: "all",
  });
  slice.draftIndustryPath = "所属行业#美妆";
  assert.equal(slice.industryPath, "");
  assert.equal(slice.contentSource, "all");
  assert.equal(slice.items[0].noteId, "ecom-keep");
  assert.equal(excellentFiltersAreDirty(slice, "ecommerce_hot"), true);
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), false);
});

test("content source change only dirties draftContentSource", () => {
  const slice = makeSlice({
    items: [{ noteId: "a" }],
    contentSource: "all",
    draftContentSource: "all",
    categoryPath: "内容类目#美妆",
    draftCategoryPath: "内容类目#美妆",
  });
  slice.draftContentSource = "professional";
  assert.equal(slice.contentSource, "all");
  assert.equal(slice.categoryPath, "内容类目#美妆");
  assert.equal(slice.draftCategoryPath, "内容类目#美妆");
  assert.equal(slice.items.length, 1);
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), true);
});

test("draft filter changes do not clear items or formal filters", () => {
  const slice = makeSlice({
    items: Array.from({ length: 8 }, (_, i) => ({ noteId: `n${i}` })),
    categoryPath: "",
    contentSource: "all",
    draftCategoryPath: "",
    draftContentSource: "all",
    updatedAt: "t0",
    status: "ready",
  });
  slice.draftCategoryPath = "内容类目#穿搭";
  slice.draftContentSource = "kol";
  assert.equal(slice.items.length, 8);
  assert.equal(slice.categoryPath, "");
  assert.equal(slice.contentSource, "all");
  assert.equal(slice.updatedAt, "t0");
  assert.equal(slice.status, "ready");
});

test("commitExcellentDraftFilters promotes draft to formal on success", () => {
  const slice = makeSlice({
    items: [{ noteId: "old" }],
    categoryPath: "",
    contentSource: "all",
    draftCategoryPath: "内容类目#美妆",
    draftContentSource: "professional",
  });
  const requestFilters = {
    board: "xhs_hot",
    categoryPath: "内容类目#美妆",
    industryPath: "",
    contentSource: "professional",
  };
  applyExcellentRefreshResult({
    slice,
    requestId: 1,
    sessionEpoch: 1,
    loadEpoch: 1,
    result: {
      items: Array.from({ length: 8 }, (_, i) => ({ noteId: `new-${i}` })),
      updatedAt: "2026-07-23T12:00:00.000Z",
      hasCache: true,
    },
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  commitExcellentDraftFilters(slice, "xhs_hot", requestFilters);
  assert.equal(slice.categoryPath, "内容类目#美妆");
  assert.equal(slice.contentSource, "professional");
  assert.equal(slice.draftCategoryPath, "内容类目#美妆");
  assert.equal(slice.draftContentSource, "professional");
  assert.equal(slice.items.length, 8);
  assert.equal(slice.items[0].noteId, "new-0");
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), false);
});

test("refresh failure keeps old items and formal filters; rolls draft back", () => {
  const slice = makeSlice({
    requestId: 2,
    status: "ready",
    items: [{ noteId: "old-1" }, { noteId: "old-2" }],
    categoryPath: "",
    contentSource: "all",
    draftCategoryPath: "内容类目#美妆",
    draftContentSource: "kol",
    updatedAt: "2026-07-20T00:00:00.000Z",
    refreshing: true,
  });
  applyExcellentRefreshError({
    slice,
    requestId: 2,
    sessionEpoch: 1,
    loadEpoch: 1,
    error: new Error("pgy down"),
    activeBoard: "xhs_hot",
    requestBoard: "xhs_hot",
  });
  rollbackExcellentDraftFilters(slice, "xhs_hot");
  assert.equal(slice.items[0].noteId, "old-1");
  assert.equal(slice.items.length, 2);
  assert.equal(slice.categoryPath, "");
  assert.equal(slice.contentSource, "all");
  assert.equal(slice.updatedAt, "2026-07-20T00:00:00.000Z");
  assert.equal(slice.draftCategoryPath, "");
  assert.equal(slice.draftContentSource, "all");
  assert.match(slice.refreshError, /更新失败，当前仍展示上一次保存的数据/);
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), false);
});

test("ecommerce refresh commit and rollback use industry draft fields", () => {
  const slice = makeSlice({
    industryPath: "所属行业#数码",
    contentSource: "all",
    draftIndustryPath: "所属行业#美妆",
    draftContentSource: "buyer",
    items: [{ noteId: "e1" }],
  });
  assert.equal(excellentFiltersAreDirty(slice, "ecommerce_hot"), true);
  commitExcellentDraftFilters(slice, "ecommerce_hot", {
    board: "ecommerce_hot",
    industryPath: "所属行业#美妆",
    contentSource: "buyer",
  });
  assert.equal(slice.industryPath, "所属行业#美妆");
  assert.equal(slice.draftIndustryPath, "所属行业#美妆");
  assert.equal(slice.contentSource, "buyer");
  assert.equal(slice.draftContentSource, "buyer");
  assert.equal(excellentFiltersAreDirty(slice, "ecommerce_hot"), false);

  slice.draftIndustryPath = "所属行业#其他";
  rollbackExcellentDraftFilters(slice, "ecommerce_hot");
  assert.equal(slice.draftIndustryPath, "所属行业#美妆");
  assert.equal(slice.industryPath, "所属行业#美妆");
});

test("excellentRefreshResponseMatches requires board source and taxonomy", () => {
  const filters = {
    board: "xhs_hot",
    contentSource: "all",
    categoryPath: "内容类目#美妆",
    industryPath: "",
  };
  assert.equal(
    excellentRefreshResponseMatches(
      { board: "xhs_hot", contentSource: "all", categoryPath: "内容类目#美妆", industryPath: "" },
      filters,
    ),
    true,
  );
  assert.equal(
    excellentRefreshResponseMatches(
      { board: "ecommerce_hot", contentSource: "all", categoryPath: "内容类目#美妆" },
      filters,
    ),
    false,
  );
  assert.equal(
    excellentRefreshResponseMatches(
      { board: "xhs_hot", contentSource: "kol", categoryPath: "内容类目#美妆" },
      filters,
    ),
    false,
  );
  assert.equal(
    excellentRefreshResponseMatches(
      { board: "xhs_hot", contentSource: "all", categoryPath: "" },
      filters,
    ),
    false,
  );
});

test("filters dirty detection is false when draft equals formal", () => {
  const slice = makeSlice({
    categoryPath: "内容类目#美妆",
    contentSource: "professional",
    draftCategoryPath: "内容类目#美妆",
    draftContentSource: "professional",
  });
  assert.equal(excellentFiltersAreDirty(slice, "xhs_hot"), false);
});

test("app.js filter change handlers only mutate draft and never auto-load", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.equal(appSource.includes("applyExcellentFiltersAndLoad"), false);
  assert.match(appSource, /slice\.draftCategoryPath = event\.target\.value/);
  assert.match(appSource, /slice\.draftIndustryPath = event\.target\.value/);
  assert.match(appSource, /slice\.draftContentSource = event\.target\.value/);
  // change handlers must not call list/load/refresh
  const categoryHandler = appSource.slice(
    appSource.indexOf('getElementById("excellentCategoryFilter")'),
    appSource.indexOf('getElementById("excellentSourceFilter")'),
  );
  const sourceHandler = appSource.slice(
    appSource.indexOf('getElementById("excellentSourceFilter")'),
    appSource.indexOf('getElementById("refreshExcellentContentsBtn")'),
  );
  for (const block of [categoryHandler, sourceHandler]) {
    assert.equal(block.includes("loadExcellentContents"), false);
    assert.equal(block.includes("loadExcellentContentsForBoard"), false);
    assert.equal(block.includes("refreshExcellentContentsForBoard"), false);
    assert.equal(block.includes("/api/excellent-contents"), false);
    assert.equal(block.includes("slice.items = []"), false);
  }
  // refresh uses draft snapshot
  assert.match(appSource, /draftContentSource/);
  assert.match(appSource, /requestFilters/);
  assert.match(appSource, /commitExcellentDraftFilters/);
  assert.match(appSource, /rollbackExcellentDraftFilters/);
});

test("server startup does not auto-warm excellent content boards", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "../src/server/index.js"), "utf8");
  assert.equal(indexSource.includes("warmAllExcellentContentBoards"), false);
  assert.equal(indexSource.includes("excellentContentWarmOnStart"), false);
  const warmScript = fs.readFileSync(path.join(__dirname, "../scripts/warm-excellent-content.js"), "utf8");
  assert.match(warmScript, /warmAllExcellentContentBoards/);
  assert.match(warmScript, /Explicit manual maintenance|人工|manual/i);
});

test("scroll rule: dirty formal change means top; same filter keeps position", () => {
  // Pure semantics used by refreshExcellentContentsForBoard
  const same = makeSlice({
    categoryPath: "",
    draftCategoryPath: "",
    contentSource: "all",
    draftContentSource: "all",
  });
  assert.equal(excellentFiltersAreDirty(same, "xhs_hot"), false);
  const dirty = makeSlice({
    categoryPath: "",
    draftCategoryPath: "内容类目#美妆",
    contentSource: "all",
    draftContentSource: "all",
  });
  assert.equal(excellentFiltersAreDirty(dirty, "xhs_hot"), true);
});
