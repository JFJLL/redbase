const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { upsertGeneration, searchGenerations } = require("../src/server/db/repositories/generation-repository");
const { buildHistoryFilters } = require("../src/server/api/history-routes");

const db = openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

db.prepare(`
  INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(1, "History Tester", "13900000001", "hash", "customer", "", 5, "2026-05-02T00:00:00.000Z");

function seedGeneration(input) {
  upsertGeneration({
    ownerUserId: 1,
    channelLabel: "测试渠道",
    trendId: 1,
    trendTitle: "默认趋势",
    ideaTitle: "默认选题",
    previewUrl: "",
    summary: "",
    payload: {},
    ...input,
  });
}

test("searchGenerations filters by keyword, brand, type, and date range", () => {
  seedGeneration({
    id: 1,
    type: "moments",
    brandId: 10,
    brandName: "红盒品牌",
    trendTitle: "春日上新",
    ideaTitle: "关键词选题",
    cardTitle: "春日关键词",
    summary: "包含搜索词",
    createdAt: "2026-05-01T10:00:00.000Z",
  });
  seedGeneration({
    id: 2,
    type: "xhsCarousel",
    brandId: 10,
    brandName: "红盒品牌",
    trendTitle: "夏日趋势",
    ideaTitle: "组图选题",
    cardTitle: "夏日轮播",
    summary: "另一条内容",
    createdAt: "2026-05-02T10:00:00.000Z",
  });
  seedGeneration({
    id: 3,
    type: "moments",
    brandId: 20,
    brandName: "蓝盒品牌",
    trendTitle: "春日上新",
    ideaTitle: "其他选题",
    cardTitle: "其他内容",
    summary: "包含搜索词",
    createdAt: "2026-05-03T10:00:00.000Z",
  });

  assert.deepEqual(searchGenerations(1, { q: "搜索词", brandId: 10 }).map((item) => item.id), [1]);
  assert.deepEqual(searchGenerations(1, { type: "xhsCarousel" }).map((item) => item.id), [2]);
  assert.deepEqual(
    searchGenerations(1, {
      brandId: 10,
      from: "2026-05-02T00:00:00.000Z",
      to: "2026-05-02T23:59:59.999Z",
    }).map((item) => item.id),
    [2],
  );
});

test("buildHistoryFilters trims query params and ignores unknown generation types", () => {
  const req = {
    url: "/api/history?q=%20春日%20&brandId=10&type=unknown&from=2026-05-01&to=2026-05-02",
    headers: { host: "localhost:3013" },
  };

  assert.deepEqual(buildHistoryFilters(req), {
    q: "春日",
    brandId: "10",
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-05-02T23:59:59.999Z",
  });
});
