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
  warmExcellentContentCache,
  mapExcellentContentError,
  __resetExcellentContentInFlightForTests,
} = require("../src/server/services/excellent-content-service");
const {
  upsertExcellentContentCache,
  findExcellentContentCache,
} = require("../src/server/db/repositories/excellent-content-cache-repository");
const { normalizeGeneratedXhsCarouselPack } = require("../src/server/ai/content-service");
const { buildImagePrompt } = require("../src/server/ai/image-prompt-builder");
const { getPgyPublicErrorMessage } = require("../src/server/integrations/pgy-content-square");

function makeNote(id, { type = "image", like = 10, fav = 5, cmt = 1 } = {}) {
  return {
    noteId: String(id),
    id: String(id),
    title: `note-${id}`,
    noteType: type,
    imageUrls: [`https://img.example/${id}.jpg`],
    imageCount: 1,
    metrics: {
      likeCount: like,
      favoriteCount: fav,
      commentCount: cmt,
      engagementCount: like + fav + cmt,
      readCount: 100,
    },
    author: { nickname: "a", fansCount: 1 },
    source: "pgy_content_square",
    sourceKey: "xhs_hot",
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
              readNum: note.metrics.readCount,
            },
            userInfo: { nickName: note.author.nickname, fansNum: note.author.fansCount },
          })),
        },
      }),
  };
}

test("filterRankAndLimitNotes filters videos, dedupes, sorts by engagement, limits 8", () => {
  const notes = [
    makeNote("v1", { type: "video", like: 999 }),
    makeNote("a", { like: 10, fav: 1, cmt: 1 }),
    makeNote("b", { like: 50, fav: 20, cmt: 5 }),
    makeNote("a", { like: 10, fav: 1, cmt: 1 }),
    makeNote("c", { like: 30 }),
    makeNote("d", { like: 5 }),
    makeNote("e", { like: 40 }),
    makeNote("f", { like: 8 }),
    makeNote("g", { like: 12 }),
    makeNote("h", { like: 60 }),
    makeNote("i", { like: 3 }),
  ];
  const result = filterRankAndLimitNotes(notes);
  assert.equal(result.length, 8);
  // b = 75 engagement, h = 60
  assert.equal(result[0].noteId, "b");
  assert.equal(result[0].rank, 1);
  assert.equal(result[1].noteId, "h");
  assert.ok(result.every((item) => item.noteType !== "video"));
  assert.equal(new Set(result.map((item) => item.noteId)).size, 8);
});

test("excellent content service returns fresh cache without refetch", async () => {
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
  assert.equal(result.items.length, 2);
  assert.equal(result.sort, "engagement_desc");
  assert.equal(result.windowDays, 7);
  assert.ok(result.updatedAt);
});

test("expired cache returns stale and refreshes in background", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
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
  assert.equal(result.items[0].noteId, "old");

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(fetchCount >= 1);
  const refreshed = findExcellentContentCache("xhs_hot", "内容类目#美妆");
  assert.ok(refreshed.items.some((item) => item.noteId === "new1"));
});

test("waitForFresh joins background refresh and returns fresh items", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const oldItems = filterRankAndLimitNotes([makeNote("stale-item", { like: 5 })]);
  const now = new Date();
  const categoryPath = "内容类目#wait-fresh";
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
    await new Promise((resolve) => setTimeout(resolve, 60));
    return pgyPage([makeNote("fresh-a", { like: 90 }), makeNote("fresh-b", { like: 70 })]);
  };
  const appConfig = { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000, excellentContentCacheTtlMs: 3600000 } };

  const stale = await getExcellentContents(appConfig, {
    source: "xhs_hot",
    categoryPath,
    fetchImpl,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.items[0].noteId, "stale-item");

  const [freshA, freshB] = await Promise.all([
    getExcellentContents(appConfig, { source: "xhs_hot", categoryPath, waitForFresh: true, fetchImpl }),
    getExcellentContents(appConfig, { source: "xhs_hot", categoryPath, waitForFresh: true, fetchImpl }),
  ]);
  assert.equal(freshA.stale, false);
  assert.equal(freshB.stale, false);
  assert.equal(freshA.lastError, "");
  assert.equal(freshA.items[0].noteId, "fresh-a");
  assert.equal(fetchCount, 1);
});

test("pgy failure with allowStaleOnError true returns stale; false throws and keeps cache", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const items = filterRankAndLimitNotes([makeNote("cached", { like: 12 })]);
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "内容类目#数码",
    items,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() - 1000).toISOString(),
    lastError: "",
  });

  const stale = await getExcellentContents(
    { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
    {
      source: "xhs_hot",
      categoryPath: "数码",
      forceRefresh: true,
      allowStaleOnError: true,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    },
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.items[0].noteId, "cached");
  assert.ok(stale.lastError);

  __resetExcellentContentInFlightForTests();
  await assert.rejects(
    () =>
      getExcellentContents(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        {
          source: "xhs_hot",
          categoryPath: "数码",
          forceRefresh: true,
          allowStaleOnError: false,
          fetchImpl: async () => {
            throw Object.assign(new Error("fail"), { code: "PGY_UPSTREAM_ERROR" });
          },
        },
      ),
    (error) => Boolean(error?.message),
  );
  const kept = findExcellentContentCache("xhs_hot", "内容类目#数码");
  assert.equal(kept.items[0].noteId, "cached");
  assert.ok(kept.lastError);

  __resetExcellentContentInFlightForTests();
  await assert.rejects(
    () =>
      getExcellentContents(
        { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } },
        {
          source: "xhs_hot",
          categoryPath: "内容类目#不存在类目路径xyz",
          forceRefresh: true,
          fetchImpl: async () => {
            throw Object.assign(new Error("fail"), { code: "PGY_UPSTREAM_ERROR" });
          },
        },
      ),
    (error) => Boolean(error?.message),
  );
});

test("warmExcellentContentCache fails on stale fallback and succeeds on fresh pull", async () => {
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

test("concurrent cold loads share one in-flight refresh", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const categoryPath = "内容类目#并发";
  // Ensure no cache for this path
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
    return pgyPage(Array.from({ length: 8 }, (_, i) => makeNote(`c${i}`, { like: 100 - i })));
  };
  const appConfig = { pgy: { enabled: true, cookie: "web_session=x", timeoutMs: 1000 } };
  const [a, b] = await Promise.all([
    getExcellentContents(appConfig, { source: "xhs_hot", categoryPath, forceRefresh: true, fetchImpl }),
    getExcellentContents(appConfig, { source: "xhs_hot", categoryPath, forceRefresh: true, fetchImpl }),
  ]);
  assert.equal(a.items.length, 8);
  assert.equal(b.items.length, 8);
  assert.equal(fetchCount, 1);
});

test("invalid source is rejected", async () => {
  await ensureStore();
  await assert.rejects(
    () => getExcellentContents({ pgy: { enabled: true, cookie: "x" } }, { source: "other" }),
    (error) => error.code === "INVALID_SOURCE",
  );
  for (const source of ["professional", "kol", "celebrity", "buyer", "employee", "owner", "user"]) {
    await assert.rejects(
      () => getExcellentContents({ pgy: { enabled: true, cookie: "x" } }, { source }),
      (error) => error.code === "INVALID_SOURCE",
    );
  }
});

test("xhs_hot is the only accepted source and filters label", async () => {
  await ensureStore();
  __resetExcellentContentInFlightForTests();
  const items = filterRankAndLimitNotes([makeNote("src1", { like: 20 })]);
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
    { source: "xhs_hot" },
  );
  assert.equal(result.source, "xhs_hot");
  assert.deepEqual(result.filters.sources, [{ value: "xhs_hot", label: "小红书热门" }]);
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
    },
    remixBrief: {
      sourceType: "excellent_content",
      sourceNoteId: "n1",
      sourceTitle: "参考",
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
        pageTask: `任务${n}`,
        originalityGuard: "原创保护",
      },
    })),
  });
  assert.equal(pack.slides.length, 4);
  assert.equal(pack.sourceTemplate.noteId, "n1");
  assert.equal(pack.sourceTemplate.source, "xhs_hot");
  assert.doesNotMatch(JSON.stringify(pack), /professional/);
  assert.equal(pack.remixBrief.sourceType, "excellent_content");
  assert.equal(pack.slides[0].remixBrief.pageTask, "任务1");
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

