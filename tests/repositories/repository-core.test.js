const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { getCounter, setCounter, allocateCounter } = require("../../src/server/db/repositories/core-repository");
const { insertUser } = require("../../src/server/db/repositories/auth-repository");
const {
  insertBrand,
  updateBrand,
  upsertBrandFull,
  updateCurrentTrendIdeaContentAssets,
  findBrandByOwner,
  listBrandsByOwner,
} = require("../../src/server/db/repositories/brand-repository");
const { upsertGeneration, listGenerationsByOwner, searchGenerations } = require("../../src/server/db/repositories/generation-repository");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 1,
  name: "Repository Tester",
  phone: "13910000002",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});

insertUser({
  id: 2,
  name: "Other User",
  phone: "13910000003",
  password: "hash",
  accountType: "customer",
  credits: 5,
  createdAt: "2026-05-02T00:00:00.000Z",
});

test("core counters allocate and persist sequential values", () => {
  assert.equal(getCounter("nextTestCounter", 10), 10);
  setCounter("nextTestCounter", 15);
  assert.equal(allocateCounter("nextTestCounter", 10), 15);
  assert.equal(getCounter("nextTestCounter", 10), 16);
});

test("brand repository creates, updates, and scopes by owner", () => {
  const brand = insertBrand({
    id: 10,
    ownerUserId: 1,
    name: "Redbase Labs",
    industry: "SaaS",
    audience: "operators",
    description: "Initial description",
    product: "Content tooling",
    goal: "Growth",
    knowledgeBase: "KB",
    assetTags: ["fast", "focused"],
  });
  assert.equal(brand.name, "Redbase Labs");
  assert.deepEqual(brand.assetTags, ["fast", "focused"]);

  const updated = updateBrand({
    ...brand,
    name: "Redbase Studio",
    description: "Updated description",
  });
  assert.equal(updated.name, "Redbase Studio");
  assert.equal(findBrandByOwner(10, 2), null);
  assert.deepEqual(listBrandsByOwner(1).map((item) => item.id), [10]);
});

test("targeted idea asset updates preserve assets written by concurrent requests", () => {
  const brand = findBrandByOwner(10, 1);
  brand.trends = [{
    key: "traffic",
    title: "流量热点趋势",
    description: "测试趋势",
    items: [{
      id: 1001,
      stableKey: "traffic-concurrency",
      rank: 1,
      title: "并发选题资产",
      category: "内容趋势",
      summary: "验证两个选题分别补齐时不会互相覆盖。",
      score: 80,
      reason: "用于数据库回归测试。",
      tags: ["#并发测试"],
      evidenceIds: ["S1", "S2"],
      evidence: [{
        provider: "anysearch",
        id: "S1",
        title: "可核验证据",
        url: "https://www.ce.cn/evidence",
        source: "ce.cn",
        host: "www.ce.cn",
        publishedAt: "2026-07-20",
        snippet: "用于证明趋势与公开来源的关联。",
        sourceType: "web",
        platformType: "",
        trustLevel: "medium",
        retrievedAt: "2026-07-21T00:00:00.000Z",
      }],
      ideas: [0, 1].map((ideaIndex) => ({
        title: `选题 ${ideaIndex + 1}`,
        summary: "测试摘要",
        angle: "测试角度",
        brandFit: "品牌结合",
        audience: "测试人群",
        hook: "测试钩子",
        tags: ["#测试"],
        contentAssets: {},
      })),
    }],
  }];
  upsertBrandFull(brand);

  assert.equal(updateCurrentTrendIdeaContentAssets(10, 1, 1001, 0, { marker: "first" }), true);
  assert.equal(updateCurrentTrendIdeaContentAssets(10, 1, 1001, 1, { marker: "second" }), true);
  assert.equal(updateCurrentTrendIdeaContentAssets(10, 2, 1001, 0, { marker: "wrong-owner" }), false);

  const persistedTrend = findBrandByOwner(10, 1).trends[0].items[0];
  const persistedIdeas = persistedTrend.ideas;
  assert.equal(persistedIdeas[0].contentAssets.marker, "first");
  assert.equal(persistedIdeas[1].contentAssets.marker, "second");
  assert.deepEqual(persistedTrend.evidenceIds, ["S1", "S2"]);
  assert.equal(persistedTrend.evidence[0].url, "https://www.ce.cn/evidence");
  assert.equal(persistedTrend.evidence[0].snippet, "用于证明趋势与公开来源的关联。");
});

test("generation repository upserts, scopes by owner, and searches combinations", () => {
  upsertGeneration({
    id: 100,
    ownerUserId: 1,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 10,
    brandName: "Redbase Studio",
    trendId: 1,
    trendTitle: "春日趋势",
    ideaTitle: "桌面焕新",
    cardTitle: "春日桌面",
    createdAt: "2026-05-01T10:00:00.000Z",
    previewUrl: "",
    summary: "可搜索摘要",
    payload: { caption: "hello" },
  });
  upsertGeneration({
    id: 101,
    ownerUserId: 1,
    type: "wechat",
    channelLabel: "公众号长图",
    brandId: 10,
    brandName: "Redbase Studio",
    trendId: 2,
    trendTitle: "长图趋势",
    ideaTitle: "深度内容",
    cardTitle: "长图标题",
    createdAt: "2026-05-02T10:00:00.000Z",
    previewUrl: "",
    summary: "公众号摘要",
    payload: { intro: "intro" },
  });
  upsertGeneration({
    id: 102,
    ownerUserId: 2,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 11,
    brandName: "Other",
    trendId: 3,
    trendTitle: "其他趋势",
    ideaTitle: "其他内容",
    cardTitle: "其他标题",
    createdAt: "2026-05-03T10:00:00.000Z",
    previewUrl: "",
    summary: "可搜索摘要",
    payload: {},
  });

  assert.deepEqual(listGenerationsByOwner(1).map((item) => item.id), [101, 100]);
  assert.deepEqual(searchGenerations(1, { q: "可搜索", brandId: 10 }).map((item) => item.id), [100]);
  assert.deepEqual(searchGenerations(1, { type: "wechat" }).map((item) => item.id), [101]);
  assert.deepEqual(searchGenerations(1, { from: "2026-05-02T00:00:00.000Z" }).map((item) => item.id), [101]);
});
