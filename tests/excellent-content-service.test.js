const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-"));
const dbFile = path.join(tempDir, "test.sqlite");
process.env.REDBASE_DB_FILE = dbFile;

const { ensureStore } = require("../src/server/store");
const {
  filterRankAndLimitNotes,
  getExcellentContents,
  refreshExcellentContents,
  warmExcellentContentCache,
  warmAllExcellentContentBoards,
  getExcellentContentDetail,
  buildCacheSourceKey,
  mapExcellentContentError,
  noteHasCompleteImages,
  validateExcellentTaxonomyPath,
  __resetExcellentContentInFlightForTests,
  __seedExcellentTaxonomyTreeForTests,
} = require("../src/server/services/excellent-content-service");
const {
  upsertExcellentContentCache,
  findExcellentContentCache,
} = require("../src/server/db/repositories/excellent-content-cache-repository");
const { normalizeGeneratedXhsCarouselPack } = require("../src/server/ai/content-service");
const { buildImagePrompt } = require("../src/server/ai/image-prompt-builder");
const { getPgyPublicErrorMessage } = require("../src/server/integrations/pgy-content-square");

function makeNote(id, { type = "image", like = 10, fav = 5, cmt = 1, read = 100, publishTime = "" } = {}) {
  return {
    noteId: String(id),
    id: String(id),
    title: `note-${id}`,
    noteType: type,
    content: "",
    imageUrls: [`https://img.example/${id}.jpg`],
    imageCount: 1,
    publishTime,
    metrics: {
      likeCount: like,
      favoriteCount: fav,
      commentCount: cmt,
      engagementCount: like + fav + cmt,
      readCount: read,
    },
    author: { nickname: "a", fansCount: 1 },
    source: "pgy_content_square",
    sourceKey: "xhs_hot",
    board: "xhs_hot",
  };
}

function pgyPage(notes) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        code: 0,
        success: true,
        data: {
          noteList: notes.map((note) => ({
            noteInfo: {
              noteId: note.noteId,
              title: note.title,
              noteType: note.noteType === "video" ? 2 : 1,
              noteImages: (note.imageUrls || []).map((imageUrl) => ({ imageUrl })),
              likeNum: note.metrics.likeCount,
              favNum: note.metrics.favoriteCount,
              cmtNum: note.metrics.commentCount,
              readNum: note.metrics.readCount || 0,
            },
            userInfo: { nickName: note.author.nickname, fansNum: note.author.fansCount },
          })),
        },
      }),
  };
}

function seedCategoryPaths(paths) {
  const items = (paths || []).map((value) => ({
    value,
    label: String(value).split("#").pop() || value,
    children: [],
  }));
  __seedExcellentTaxonomyTreeForTests({
    categoryTree: { root: "内容类目", items },
  });
}

function seedIndustryPaths(paths) {
  const items = (paths || []).map((value) => ({
    value,
    label: String(value).split("#").pop() || value,
    children: [],
  }));
  __seedExcellentTaxonomyTreeForTests({
    industryTree: { root: "所属行业", items },
  });
}

test("filterRankAndLimitNotes filters videos, dedupes, sorts by readCount, limits 8", () => {
  const notes = [
    makeNote("v1", { type: "video", like: 999, read: 99999 }),
    makeNote("a", { like: 10, fav: 1, cmt: 1, read: 100 }),
    makeNote("b", { like: 50, fav: 20, cmt: 5, read: 500 }),
    makeNote("a", { like: 10, fav: 1, cmt: 1, read: 100 }),
    makeNote("c", { like: 30, read: 300 }),
    makeNote("d", { like: 5, read: 50 }),
    makeNote("e", { like: 40, read: 400 }),
    makeNote("f", { like: 8, read: 80 }),
    makeNote("g", { like: 12, read: 120 }),
    makeNote("h", { like: 60, read: 600 }),
    makeNote("i", { like: 3, read: 30 }),
  ];
  const result = filterRankAndLimitNotes(notes);
  assert.equal(result.length, 8);
  assert.equal(result[0].noteId, "h");
  assert.equal(result[0].rank, 1);
  assert.equal(result[1].noteId, "b");
  assert.ok(result.every((item) => item.noteType !== "video"));
  assert.equal(new Set(result.map((item) => item.noteId)).size, 8);
});

test("equal readCount prefers newer publishTime then stable noteId", () => {
  const result = filterRankAndLimitNotes([
    makeNote("b", { read: 100, publishTime: "2026-07-01T00:00:00.000Z" }),
    makeNote("a", { read: 100, publishTime: "2026-07-02T00:00:00.000Z" }),
    makeNote("c", { read: 100, publishTime: "2026-07-01T00:00:00.000Z" }),
  ]);
  assert.equal(result[0].noteId, "a");
  assert.equal(result[1].noteId, "b");
  assert.equal(result[2].noteId, "c");
});

test("GET list is cache-only and does not call Pgy", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const items = filterRankAndLimitNotes([makeNote("1", { like: 20 }), makeNote("2", { like: 10 })]);
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    lastError: "",
  });

  let fetchCount = 0;
  const result = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    {
      source: "xhs_hot",
      categoryPath: "",
      fetchImpl: async () => {
        fetchCount += 1;
        return pgyPage([makeNote("z", { like: 1 })]);
      },
    },
  );
  assert.equal(fetchCount, 0);
  assert.equal(result.stale, false);
  assert.equal(result.hasCache, true);
  assert.equal(result.needsUpdate, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.sort, "read_desc");
  assert.equal(result.windowDays, 7);
  assert.equal(result.board, "xhs_hot");
  assert.ok(result.updatedAt);
});

test("GET list without cache returns needsUpdate and does not call Pgy", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  let fetchCount = 0;
  const result = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    {
      board: "xhs_hot",
      contentSource: "professional",
      categoryPath: "",
      fetchImpl: async () => {
        fetchCount += 1;
        return pgyPage([makeNote("should-not")]);
      },
    },
  );
  assert.equal(fetchCount, 0);
  assert.equal(result.hasCache, false);
  assert.equal(result.needsUpdate, true);
  assert.equal(result.items.length, 0);
  assert.equal(result.updatedAt, "");
});

test("xhs and ecommerce caches are isolated by board and content source", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: filterRankAndLimitNotes([makeNote("xhs-only", { read: 10 })]),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  upsertExcellentContentCache({
    sourceKey: "ecommerce_hot",
    categoryPath: "",
    items: filterRankAndLimitNotes([makeNote("ecom-only", { read: 20 })]),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  upsertExcellentContentCache({
    sourceKey: buildCacheSourceKey("xhs_hot", "professional"),
    categoryPath: "",
    items: filterRankAndLimitNotes([makeNote("pro-only", { read: 30 })]),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });

  const xhs = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    { board: "xhs_hot", contentSource: "all", fetchImpl: async () => pgyPage([makeNote("should-not")]) },
  );
  const ecom = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    { board: "ecommerce_hot", contentSource: "all", fetchImpl: async () => pgyPage([makeNote("should-not")]) },
  );
  const pro = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    { board: "xhs_hot", contentSource: "professional", fetchImpl: async () => pgyPage([makeNote("should-not")]) },
  );
  assert.equal(xhs.items[0].noteId, "xhs-only");
  assert.equal(ecom.items[0].noteId, "ecom-only");
  assert.equal(pro.items[0].noteId, "pro-only");
  assert.equal(ecom.board, "ecommerce_hot");
});

test("detail returns list cache images without requiring upstream detail", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  const item = {
    ...makeNote("detail-1", { read: 99 }),
    imageUrls: ["https://img.example/1.jpg", "https://img.example/2.jpg", "https://img.example/3.jpg"],
    imageCount: 3,
    content: "",
  };
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [item],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const detail = await getExcellentContentDetail({}, { noteId: "detail-1", board: "xhs_hot" });
  assert.equal(detail.fromCache, true);
  assert.equal(detail.item.noteId, "detail-1");
  assert.equal(detail.item.imageUrls.length, 3);
  assert.equal(typeof detail.item.noteId, "string");
  assert.equal(detail.complete, true);
  assert.equal(detail.availableImageCount, 3);
  assert.equal(detail.board, "xhs_hot");
});

test("detail hits non-empty categoryPath and industryPath caches", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  const xhsPath = "内容类目#美妆#护肤";
  const ecomPath = "所属行业#美妆个护#彩妆";
  seedCategoryPaths([xhsPath]);
  seedIndustryPaths([ecomPath]);
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: xhsPath,
    items: [
      {
        ...makeNote("cat-note", { read: 10 }),
        imageUrls: ["https://img.example/cat.jpg"],
        imageCount: 1,
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  upsertExcellentContentCache({
    sourceKey: "ecommerce_hot",
    categoryPath: ecomPath,
    items: [
      {
        ...makeNote("ind-note", { read: 20 }),
        board: "ecommerce_hot",
        sourceKey: "ecommerce_hot",
        imageUrls: ["https://img.example/ind.jpg", "https://img.example/ind2.jpg"],
        imageCount: 2,
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });

  const xhs = await getExcellentContentDetail(
    {},
    { noteId: "cat-note", board: "xhs_hot", categoryPath: xhsPath },
  );
  assert.equal(xhs.fromCache, true);
  assert.equal(xhs.item.noteId, "cat-note");
  assert.equal(xhs.taxonomyPath, xhsPath);

  const ecom = await getExcellentContentDetail(
    {},
    { noteId: "ind-note", board: "ecommerce_hot", industryPath: ecomPath },
  );
  assert.equal(ecom.fromCache, true);
  assert.equal(ecom.item.noteId, "ind-note");
  assert.equal(ecom.taxonomyPath, ecomPath);
  assert.equal(ecom.board, "ecommerce_hot");
});

test("detail isolates contentSource and does not cross boards for same noteId", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  const noteId = "shared-id";
  upsertExcellentContentCache({
    sourceKey: buildCacheSourceKey("xhs_hot", "professional"),
    categoryPath: "",
    items: [{ ...makeNote(noteId, { read: 1 }), title: "pro-xhs", contentSource: "professional" }],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  upsertExcellentContentCache({
    sourceKey: buildCacheSourceKey("ecommerce_hot", "user"),
    categoryPath: "",
    items: [
      {
        ...makeNote(noteId, { read: 2 }),
        title: "user-ecom",
        board: "ecommerce_hot",
        contentSource: "user",
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });

  const pro = await getExcellentContentDetail(
    {},
    { noteId, board: "xhs_hot", contentSource: "professional" },
  );
  assert.equal(pro.item.title, "pro-xhs");
  assert.equal(pro.contentSource, "professional");

  const user = await getExcellentContentDetail(
    {},
    { noteId, board: "ecommerce_hot", contentSource: "user" },
  );
  assert.equal(user.item.title, "user-ecom");
  assert.equal(user.board, "ecommerce_hot");

  // Looking on wrong board should not return the other board's note without fallbacks.
  const miss = await getExcellentContentDetail(
    {},
    { noteId: "only-on-xhs", board: "ecommerce_hot", contentSource: "all" },
  );
  assert.equal(miss.item, null);
  assert.equal(miss.fromCache, false);
});

test("noteHasCompleteImages only reflects returned urls (no independent full gallery)", () => {
  assert.equal(noteHasCompleteImages({ imageUrls: ["a"], imageCount: 8 }), true);
  assert.equal(
    noteHasCompleteImages({
      imageUrls: Array.from({ length: 8 }, (_, i) => `u${i}`),
      imageCount: 8,
    }),
    true,
  );
  assert.equal(noteHasCompleteImages({ imageUrls: ["a", "b"], imageCount: 0 }), true);
  assert.equal(noteHasCompleteImages({ imageUrls: [], imageCount: 3 }), false);
  assert.equal(noteHasCompleteImages(null), false);
});

test("detail uses returned image count and empty-body copy without full-gallery claims", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        ...makeNote("partial-img", { read: 5 }),
        imageUrls: ["https://img.example/only-cover.jpg"],
        imageCount: 8,
        content: "",
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const detail = await getExcellentContentDetail({}, { noteId: "partial-img", board: "xhs_hot" });
  assert.equal(detail.availableImageCount, 1);
  assert.equal(detail.imageCount, 1);
  assert.equal(detail.item.imageUrls.length, 1);
  assert.match(detail.message, /原笔记正文暂未由接口提供/);
  assert.doesNotMatch(detail.message || "", /完整图集|完整内容/);
});

test("warmAllExcellentContentBoards fails if any board fails", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  let calls = 0;
  await assert.rejects(
    () =>
      warmAllExcellentContentBoards(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        {
          fetchImpl: async (_url, options) => {
            calls += 1;
            const body = JSON.parse(options.body || "{}");
            if (String(body.bizType) === "6") {
              throw Object.assign(new Error("ecom down"), { code: "PGY_NETWORK_ERROR" });
            }
            return pgyPage([makeNote("xhs-warm", { read: 11 })]);
          },
        },
      ),
    (error) => error.code === "PGY_NETWORK_ERROR" || error.code === "WARM_BOARD_FAILED" || Boolean(error?.boards),
  );
  assert.ok(calls >= 1);
});

test("expired cache GET still returns cache and never calls Pgy", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  seedCategoryPaths(["内容类目#美妆"]);
  const oldItems = filterRankAndLimitNotes([makeNote("old", { like: 9 })]);
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "内容类目#美妆",
    items: oldItems,
    fetchedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() - 1000).toISOString(),
    lastError: "",
  });

  let fetchCount = 0;
  const result = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000, excellentContentCacheTtlMs: 3600000 } },
    {
      source: "xhs_hot",
      categoryPath: "美妆",
      fetchImpl: async () => {
        fetchCount += 1;
        return pgyPage([makeNote("new1", { like: 100 }), makeNote("new2", { like: 80 })]);
      },
    },
  );
  assert.equal(result.stale, true);
  assert.equal(result.hasCache, true);
  assert.equal(result.needsUpdate, false);
  assert.equal(result.items[0].noteId, "old");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fetchCount, 0);
  const kept = findExcellentContentCache("xhs_hot", "内容类目#美妆");
  assert.equal(kept.items[0].noteId, "old");
});

test("POST refresh pulls Pgy, writes cache, concurrent same key shares one fetch", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  seedCategoryPaths(["内容类目#refresh"]);
  const categoryPath = "内容类目#refresh";
  const oldItems = filterRankAndLimitNotes([makeNote("stale-item", { like: 5 })]);
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath,
    items: oldItems,
    fetchedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() - 1000).toISOString(),
    lastError: "",
  });

  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return pgyPage([makeNote("fresh-a", { like: 90, read: 900 }), makeNote("fresh-b", { like: 70, read: 700 })]);
  };
  const appConfig = {
    pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000, excellentContentCacheTtlMs: 3600000 },
  };

  const [a, b] = await Promise.all([
    refreshExcellentContents(appConfig, { board: "xhs_hot", categoryPath, fetchImpl }),
    refreshExcellentContents(appConfig, { board: "xhs_hot", categoryPath, fetchImpl }),
  ]);
  assert.equal(a.stale, false);
  assert.equal(b.stale, false);
  assert.equal(a.hasCache, true);
  assert.equal(a.items[0].noteId, "fresh-a");
  assert.equal(fetchCount, 1);
  const stored = findExcellentContentCache("xhs_hot", categoryPath);
  assert.equal(stored.items[0].noteId, "fresh-a");
});

test("refresh failure keeps old cache; two boards refresh independently", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: filterRankAndLimitNotes([makeNote("xhs-cached", { like: 12 })]),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });
  upsertExcellentContentCache({
    sourceKey: "ecommerce_hot",
    categoryPath: "",
    items: filterRankAndLimitNotes([makeNote("ecom-cached", { like: 8 })]),
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });

  await assert.rejects(
    () =>
      refreshExcellentContents(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        {
          board: "xhs_hot",
          fetchImpl: async () => {
            throw Object.assign(new Error("network down"), { code: "PGY_NETWORK_ERROR" });
          },
        },
      ),
    (error) => Boolean(error?.message),
  );
  const keptXhs = findExcellentContentCache("xhs_hot", "");
  assert.equal(keptXhs.items[0].noteId, "xhs-cached");

  __resetExcellentContentInFlightForTests();
  const ecom = await refreshExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    {
      board: "ecommerce_hot",
      fetchImpl: async () => pgyPage([makeNote("ecom-new", { like: 50, read: 500 })]),
    },
  );
  assert.equal(ecom.items[0].noteId, "ecom-new");
  assert.equal(findExcellentContentCache("xhs_hot", "").items[0].noteId, "xhs-cached");
  assert.equal(findExcellentContentCache("ecommerce_hot", "").items[0].noteId, "ecom-new");
});

test("invalid taxonomy returns 400 and does not call Pgy search", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  seedCategoryPaths(["内容类目#美妆"]);
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return pgyPage([makeNote("x")]);
  };
  await assert.rejects(
    () =>
      getExcellentContents(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        { board: "xhs_hot", categoryPath: "内容类目#不存在路径xyz", fetchImpl },
      ),
    (error) => error.code === "INVALID_TAXONOMY" && error.statusCode === 400,
  );
  await assert.rejects(
    () =>
      refreshExcellentContents(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        { board: "xhs_hot", industryPath: "所属行业#美妆", fetchImpl },
      ),
    (error) => error.code === "INVALID_TAXONOMY" && error.statusCode === 400,
  );
  assert.equal(fetchCount, 0);
});

test("warmExcellentContentCache fails without deleting old cache and succeeds on fresh pull", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const items = filterRankAndLimitNotes([makeNote("warm-old", { like: 11 })]);
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });

  await assert.rejects(
    () =>
      warmExcellentContentCache(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        {
          categoryPath: "",
          fetchImpl: async () => {
            throw Object.assign(new Error("pgy down"), { code: "PGY_NETWORK_ERROR" });
          },
        },
      ),
    (error) => error.code === "PGY_NETWORK_ERROR" || Boolean(error?.message),
  );
  const kept = findExcellentContentCache("xhs_hot", "");
  assert.equal(kept.items[0].noteId, "warm-old");

  __resetExcellentContentInFlightForTests();
  const success = await warmExcellentContentCache(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    {
      categoryPath: "",
      fetchImpl: async () => pgyPage([makeNote("warm-new", { like: 50 })]),
    },
  );
  assert.equal(success.stale, false);
  assert.equal(success.lastError, "");
  assert.equal(success.items[0].noteId, "warm-new");
});

test("excellent content empty-result message uses 7-day copy", () => {
  const message = mapExcellentContentError({ code: "PGY_EMPTY_RESULT" });
  assert.match(message, /近7日/);
  assert.doesNotMatch(message, /近3日/);
  assert.match(getPgyPublicErrorMessage({ code: "PGY_EMPTY_RESULT" }), /近3日/);
});

test("cold concurrent refresh shares one in-flight Pgy pull", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  seedCategoryPaths(["内容类目#并发"]);
  const categoryPath = "内容类目#并发";
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath,
    items: [],
    fetchedAt: new Date(0).toISOString(),
    expiresAt: new Date(0).toISOString(),
    lastError: "",
  });

  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return pgyPage(Array.from({ length: 8 }, (_, i) => makeNote(`c${i}`, { like: 100 - i, read: 1000 - i })));
  };
  const appConfig = { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } };
  const [a, b] = await Promise.all([
    refreshExcellentContents(appConfig, { source: "xhs_hot", categoryPath, fetchImpl }),
    refreshExcellentContents(appConfig, { source: "xhs_hot", categoryPath, fetchImpl }),
  ]);
  assert.equal(a.items.length, 8);
  assert.equal(b.items.length, 8);
  assert.equal(fetchCount, 1);
});

test("invalid board is rejected; content sources accepted separately", async () => {
  await ensureStore();
  await assert.rejects(
    () => getExcellentContents({ pgy: { enabled: true, cookie: "x" } }, { board: "other" }),
    (error) => error.code === "INVALID_BOARD",
  );
  await assert.rejects(
    () => getExcellentContents({ pgy: { enabled: true, cookie: "x" } }, { board: "xhs_hot", contentSource: "nope" }),
    (error) => error.code === "INVALID_SOURCE",
  );
});

test("boards and content sources appear in filters", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const items = filterRankAndLimitNotes([makeNote("src1", { like: 20, read: 20 })]);
  assert.equal(items[0].sourceKey, "xhs_hot");
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    lastError: "",
  });
  const result = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    { board: "xhs_hot" },
  );
  assert.equal(result.source, "xhs_hot");
  assert.equal(result.board, "xhs_hot");
  assert.ok(result.filters.boards.some((item) => item.value === "xhs_hot"));
  assert.ok(result.filters.boards.some((item) => item.value === "ecommerce_hot"));
  assert.ok(result.filters.contentSources.some((item) => item.value === "all"));
  assert.ok(result.filters.contentSources.some((item) => item.value === "professional"));
  const emptySource = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    { source: "" },
  );
  assert.equal(emptySource.source, "xhs_hot");
});

test("remix carousel pack normalize keeps 4 pages sourceTemplate and remixBrief", () => {
  const pack = normalizeGeneratedXhsCarouselPack({
    title: "方案",
    publishTitle: "发布标题",
    publishCaption: "发布文案内容足够长",
    caption: "caption",
    aspectRatio: "3:4",
    sourceTemplate: {
      noteId: "n1",
      title: "参考",
      sourceUrl: "https://www.xiaohongshu.com/explore/n1",
      source: "xhs_hot",
      board: "ecommerce_hot",
      contentSource: "professional",
    },
    remixBrief: {
      sourceType: "excellent_content",
      sourceNoteId: "n1",
      sourceTitle: "参考",
      sourceBoard: "ecommerce_hot",
      sourceCategoryPath: "内容类目#美妆",
      sourceIndustryPath: "所属行业#美妆个护",
      sourceImageCount: 4,
      sourceReadCount: 1200,
      sourceEngagementCount: 88,
      originalityGuard: "原创保护",
      learningFocus: ["structure"],
      pageTask: "封面",
    },
    slides: [1, 2, 3, 4].map((n) => ({
      pageLabel: `第 ${n} 张`,
      title: `标题${n}`,
      copy: `文案${n}`,
      visualDirection: `视觉${n}`,
      style: "风格",
      composition: "构图",
      remixBrief: {
        sourceType: "excellent_content",
        sourceNoteId: "n1",
        sourceBoard: "ecommerce_hot",
        sourceReadCount: 1200,
        pageTask: `任务${n}`,
        originalityGuard: "原创保护",
      },
    })),
  });
  assert.equal(pack.slides.length, 4);
  assert.equal(pack.sourceTemplate.noteId, "n1");
  assert.equal(pack.sourceTemplate.source, "ecommerce_hot");
  assert.equal(pack.sourceTemplate.board, "ecommerce_hot");
  assert.equal(pack.sourceTemplate.contentSource, "professional");
  assert.equal(pack.remixBrief.sourceType, "excellent_content");
  assert.equal(pack.remixBrief.sourceBoard, "ecommerce_hot");
  assert.equal(pack.remixBrief.sourceIndustryPath, "所属行业#美妆个护");
  assert.equal(pack.remixBrief.sourceReadCount, 1200);
  assert.equal(pack.remixBrief.sourceImageCount, 4);
  assert.equal(pack.slides[0].remixBrief.pageTask, "任务1");
  assert.equal(pack.slides[0].remixBrief.sourceBoard, "ecommerce_hot");
  assert.ok(!JSON.stringify(pack).includes("http://cdn.example/original.jpg"));
});

test("remix prompt engine appends context without sourceUrl", () => {
  const base = buildImagePrompt({
    brand: { name: "测试品牌", product: "产品" },
    product: "产品",
    contentType: "cover",
    platform: "xiaohongshu",
    objective: "种草",
  });
  const withRemix = buildImagePrompt({
    brand: { name: "测试品牌", product: "产品" },
    product: "产品",
    contentType: "cover",
    platform: "xiaohongshu",
    objective: "种草",
    remixBrief: {
      sourceTitle: "参考标题",
      sourceBoard: "ecommerce_hot",
      sourceIndustryPath: "所属行业#美妆个护",
      sourceReadCount: 5600,
      pageTask: "封面钩子",
      pageTitle: "本页标题",
      pageCopy: "本页文案",
      learningFocus: ["structure", "visual"],
      originalityGuard: "不得复制原文",
      sourceUrl: "https://secret.example/note",
    },
  });
  assert.match(base, /【视觉目标】/);
  assert.doesNotMatch(base, /优秀内容仿写上下文/);
  assert.match(withRemix, /优秀内容仿写上下文/);
  assert.match(withRemix, /封面钩子/);
  assert.match(withRemix, /structure/);
  assert.match(withRemix, /不得复制原文/);
  assert.match(withRemix, /电商热门/);
  assert.match(withRemix, /所属行业#美妆个护/);
  assert.match(withRemix, /阅读量约 5600/);
  assert.doesNotMatch(withRemix, /secret\.example/);
  const long = buildImagePrompt({
    brand: { name: "测试品牌", product: "产品" },
    contentType: "cover",
    platform: "xiaohongshu",
    remixBrief: {
      sourceTitle: "x".repeat(500),
      pageTask: "y".repeat(500),
      originalityGuard: "z".repeat(800),
      learningFocus: ["structure"],
    },
  });
  assert.ok(long.includes("优秀内容仿写上下文"));
  assert.ok(!long.includes("y".repeat(200)));
});

test("invalid board in sourceTemplate is cleared; normal prompt unchanged", () => {
  const pack = normalizeGeneratedXhsCarouselPack({
    title: "方案",
    publishTitle: "发布标题",
    publishCaption: "发布文案内容足够长",
    slides: [1, 2, 3, 4].map((n) => ({
      pageLabel: `第 ${n} 张`,
      title: `标题${n}`,
      copy: `文案${n}`,
      visualDirection: `视觉${n}`,
    })),
    sourceTemplate: {
      noteId: "n2",
      title: "t",
      board: "invalid_board",
      contentSource: "user",
      sourceUrl: "https://www.xiaohongshu.com/explore/n2",
    },
  });
  assert.equal(pack.sourceTemplate.board, "");
  assert.equal(pack.sourceTemplate.contentSource, "user");
  const base = buildImagePrompt({
    brand: { name: "测试品牌", product: "产品" },
    contentType: "cover",
    platform: "xiaohongshu",
  });
  assert.match(base, /【视觉目标】/);
  assert.doesNotMatch(base, /优秀内容仿写上下文/);
});

