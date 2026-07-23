const { Readable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-api-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "api.sqlite");

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../../src/server/db/repositories/excellent-content-cache-repository");
const { handleExcellentContentRoutes } = require("../../src/server/api/excellent-content-routes");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 91,
  name: "Excellent Tester",
  phone: "13910000091",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-07-22T00:00:00.000Z",
});
insertSession({ token: "excellent-token", userId: 91, createdAt: "2026-07-22T00:00:00.000Z" });

function createGetReq(url, cookie = "") {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie,
  };
  return req;
}

function createRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: null,
    writeHead(code, nextHeaders = {}) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(nextHeaders)) {
        headers.set(key.toLowerCase(), value);
      }
    },
    setHeader(key, value) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key) {
      return headers.get(String(key).toLowerCase());
    },
    end(data = "") {
      this.body = data ? JSON.parse(data) : null;
    },
  };
}

test("excellent contents requires login", async () => {
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
});

test("excellent contents rejects invalid board", async () => {
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents?board=other", "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
});

test("excellent contents rejects unknown contentSource", async () => {
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents?board=xhs_hot&contentSource=nope", "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
});

test("excellent contents returns cached items with metadata", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "n1",
        noteId: "n1",
        title: "测试笔记",
        noteType: "image",
        rank: 1,
        metrics: { engagementCount: 10, likeCount: 5, favoriteCount: 3, commentCount: 2, readCount: 100 },
        author: { nickname: "作者", fansCount: 1 },
        imageUrls: ["https://img.example/1.jpg"],
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });

  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents?board=xhs_hot", "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length <= 8);
  assert.equal(res.body.items[0].noteId, "n1");
  assert.ok(res.body.updatedAt);
  assert.equal(typeof res.body.stale, "boolean");
  assert.equal(res.body.windowDays, 7);
  assert.equal(res.body.sort, "read_desc");
  assert.equal(res.body.board, "xhs_hot");
  assert.equal(res.body.source, "xhs_hot");
  assert.ok(res.body.filters.boards.some((item) => item.value === "ecommerce_hot"));
  assert.ok(res.body.filters.contentSources.some((item) => item.value === "all"));
});

test("excellent contents detail returns cached note images", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "ecommerce_hot",
    categoryPath: "",
    items: [
      {
        id: "e1",
        noteId: "e1",
        title: "电商笔记",
        noteType: "image",
        board: "ecommerce_hot",
        imageUrls: ["https://img.example/a.jpg", "https://img.example/b.jpg"],
        imageCount: 2,
        metrics: { readCount: 9, likeCount: 1, favoriteCount: 1, commentCount: 1, engagementCount: 3 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents/e1/detail?board=ecommerce_hot", "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents/e1/detail",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.noteId, "e1");
  assert.equal(res.body.item.imageUrls.length, 2);
  assert.equal(res.body.fromCache, true);
  assert.equal(res.body.board, "ecommerce_hot");
  assert.equal(typeof res.body.item.noteId, "string");
});

test("excellent detail hits taxonomy-scoped cache via query params", async () => {
  const now = new Date();
  const categoryPath = "内容类目#美妆#护肤";
  upsertExcellentContentCache({
    sourceKey: "xhs_hot:professional",
    categoryPath,
    items: [
      {
        id: "tax-1",
        noteId: "tax-1",
        title: "类目笔记",
        noteType: "image",
        board: "xhs_hot",
        imageUrls: ["https://img.example/t1.jpg"],
        imageCount: 1,
        metrics: { readCount: 3, likeCount: 1, favoriteCount: 0, commentCount: 0, engagementCount: 1 },
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  const res = createRes();
  const qs = new URLSearchParams({
    board: "xhs_hot",
    contentSource: "professional",
    categoryPath,
  });
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq(`/api/excellent-contents/tax-1/detail?${qs}`, "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents/tax-1/detail",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.item.noteId, "tax-1");
  assert.equal(res.body.taxonomyPath, categoryPath);
  assert.equal(res.body.contentSource, "professional");
});

test("excellent detail rejects invalid board and contentSource", async () => {
  const badBoard = createRes();
  await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents/n1/detail?board=other", "redbase_session=excellent-token"),
    badBoard,
    "/api/excellent-contents/n1/detail",
  );
  assert.equal(badBoard.statusCode, 400);

  const badSource = createRes();
  await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq(
      "/api/excellent-contents/n1/detail?board=xhs_hot&contentSource=nope",
      "redbase_session=excellent-token",
    ),
    badSource,
    "/api/excellent-contents/n1/detail",
  );
  assert.equal(badSource.statusCode, 400);
});

test("excellent contents accepts waitForFresh query flag", async () => {
  const now = new Date();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [
      {
        id: "n2",
        noteId: "n2",
        title: "fresh flag note",
        noteType: "image",
        rank: 1,
        metrics: { engagementCount: 4, likeCount: 2, favoriteCount: 1, commentCount: 1, readCount: 10 },
        author: { nickname: "作者", fansCount: 1 },
        imageUrls: ["https://img.example/2.jpg"],
      },
    ],
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600000).toISOString(),
    lastError: "",
  });

  const res = createRes();
  const handled = await handleExcellentContentRoutes(
    { appConfig: { pgy: { enabled: false } } },
    createGetReq("/api/excellent-contents?source=xhs_hot&waitForFresh=1", "redbase_session=excellent-token"),
    res,
    "/api/excellent-contents",
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.items[0].noteId, "n2");
});
