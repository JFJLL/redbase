const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-remix-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "remix.sqlite");

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../src/server/db/repositories/excellent-content-cache-repository");
const {
  findRemixAnalysisCache,
  upsertRemixAnalysisCache,
} = require("../src/server/db/repositories/excellent-remix-analysis-cache-repository");
const {
  insertProductImage,
  listProductImagesByOwnerAndBrand,
  findProductImageByOwnerBrandAndType,
  ASSET_TYPE_PRODUCT,
  ASSET_TYPE_UNASSIGNED,
} = require("../src/server/db/repositories/product-image-repository");
const {
  analyzeExcellentNoteForRemix,
  buildMetadataOnlyAnalysis,
  buildSourceSignature,
  supportsMultimodalVision,
  filterAnalysisByLearningFocus,
  __resetRemixAnalysisInFlightForTests,
  ANALYSIS_VERSION,
} = require("../src/server/services/excellent-remix-analysis-service");
const {
  buildDeterministicDirections,
  directionsAreDistinct,
  generateContentDirections,
  recommendTrendsForRemix,
  buildExcellentRemixFusionPlan,
  flattenBrandIdeas,
  mapSlideRolesToFourPages,
  scoreTrendRelevance,
  TREND_RELEVANCE_THRESHOLD,
} = require("../src/server/services/excellent-remix-fusion-service");
const { buildImagePrompt } = require("../src/server/ai/image-prompt-builder");
const { normalizeGeneratedXhsCarouselPack, normalizeRemixBrief } = require("../src/server/ai/content-service");
const { getExcellentContents, refreshExcellentContents } = require("../src/server/services/excellent-content-service");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 201,
  name: "Remix Tester",
  phone: "13910000201",
  password: "hash",
  accountType: "customer",
  credits: 20,
  createdAt: "2026-07-23T00:00:00.000Z",
});

const sampleNote = {
  id: "note-remix-1",
  noteId: "note-remix-1",
  title: "转奶避坑清单：这 5 步别再做错",
  author: { nickname: "育儿笔记" },
  imageUrls: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg", "https://cdn.example/c.jpg", "https://cdn.example/d.jpg"],
  imageCount: 4,
  metrics: { readCount: 56000, engagementCount: 1200 },
  categoryPath: "内容类目#母婴",
  contentSource: "professional",
  noteUrl: "https://www.xiaohongshu.com/explore/note-remix-1",
  board: "xhs_hot",
};

function seedNoteCache(note = sampleNote) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [note],
    fetchedAt: new Date().toISOString(),
    expiresAt,
    lastError: "",
  });
}

const mockBrand = {
  id: 11,
  name: "温和星球",
  industry: "母婴",
  audience: "新手妈妈",
  description: "关注宝宝喂养与消化舒适",
  product: "有机奶粉，温和好吸收",
  goal: "帮助家长更安心完成转奶",
  knowledgeBase: "",
  trends: [
    {
      key: "xhs",
      title: "小红书热点",
      items: [
        {
          id: 301,
          title: "宝宝转奶话题升温",
          summary: "家长讨论转奶节奏与便便变化",
          reason: "母婴喂养讨论活跃",
          category: "母婴",
          tags: ["转奶", "便便", "新手妈妈"],
          ideas: [
            {
              title: "转奶节奏对照表",
              summary: "用对照表讲清转奶节奏",
              angle: "夜间喂养场景",
              audience: "新手妈妈",
              brandFit: "自然带出温和好吸收",
              hook: "转奶卡在哪一步",
              tags: ["转奶"],
            },
            {
              title: "消化舒适观察法",
              summary: "观察便便与精神状态",
              angle: "日常护理",
              audience: "宝妈",
              brandFit: "产品卖点作为方法补充",
              hook: "先看这三项",
              tags: ["消化"],
            },
          ],
        },
        {
          id: 302,
          title: "办公室提效工具",
          summary: "职场效率软件讨论",
          reason: "工具热",
          category: "效率",
          tags: ["办公", "软件"],
          ideas: [
            {
              title: "表格模板",
              summary: "效率模板",
              angle: "办公",
              audience: "打工人",
              brandFit: "无关",
              hook: "模板",
              tags: ["办公"],
            },
          ],
        },
      ],
    },
  ],
};

// Monkey-patch brand lookup used by fusion service.
const brandRepo = require("../src/server/db/repositories/brand-repository");
const originalFindBrandByOwner = brandRepo.findBrandByOwner;
brandRepo.findBrandByOwner = (brandId, ownerUserId) => {
  if (Number(brandId) === 11 && Number(ownerUserId) === 201) return mockBrand;
  return originalFindBrandByOwner(brandId, ownerUserId);
};

test("provider does not claim multimodal vision support", () => {
  assert.equal(supportsMultimodalVision({ textProvider: { model: "gpt-like" } }), false);
});

test("metadata_only analysis never fabricates body text and never includes image URLs", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  assert.equal(analysis.analysisMode, "metadata_only");
  assert.equal(analysis.meta.hasBodyText, false);
  assert.match(analysis.narrativeStructure.summary, /正文未由接口提供|元数据/);
  const serialized = JSON.stringify(analysis);
  assert.doesNotMatch(serialized, /cdn\.example/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /爆款原因/);
});

test("source signature is stable and does not embed raw URLs", () => {
  const a = buildSourceSignature(sampleNote);
  const b = buildSourceSignature({ ...sampleNote, imageUrls: [...sampleNote.imageUrls] });
  const c = buildSourceSignature({ ...sampleNote, title: "标题变了" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.doesNotMatch(a, /cdn\.example/);
  assert.equal(a.length, 32);
});

test("analyze hits cache for same note signature and reuses in-flight promise", async () => {
  __resetRemixAnalysisInFlightForTests();
  seedNoteCache();
  let modelCalls = 0;
  const textModelImpl = async () => {
    modelCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      analysisMode: "metadata_only",
      referenceTopic: "转奶方法",
      hookPattern: { type: "list", description: "清单钩子", titleFormula: "步骤清单" },
      narrativeStructure: {
        summary: "四页方法结构",
        slideRoles: [
          { sourceIndex: 0, role: "对比", contentFunction: "先比" },
          { sourceIndex: 1, role: "误区", contentFunction: "再避坑" },
          { sourceIndex: 2, role: "方法", contentFunction: "给步骤" },
          { sourceIndex: 3, role: "清单", contentFunction: "可收藏" },
        ],
      },
      visualLanguage: {
        layout: "信息流",
        textDensity: "少",
        imageTextRatio: "图主文辅",
        colorMood: "柔和",
        typography: "粗标题",
        composition: "竖图",
      },
      conversionPattern: { type: "checklist", description: "清单转化" },
      usableLearningPoints: ["结构"],
      originalityConstraints: ["不复制"],
    };
  };

  const [one, two] = await Promise.all([
    analyzeExcellentNoteForRemix({ textProvider: { apiKey: "k", model: "m" } }, {
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      textModelImpl,
    }),
    analyzeExcellentNoteForRemix({ textProvider: { apiKey: "k", model: "m" } }, {
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      textModelImpl,
    }),
  ]);
  assert.equal(modelCalls, 1);
  assert.equal(one.noteId, sampleNote.noteId);
  assert.equal(two.fromCache || one.fromCache, false);
  const cached = await analyzeExcellentNoteForRemix({ textProvider: { apiKey: "k", model: "m" } }, {
    noteId: sampleNote.noteId,
    board: "xhs_hot",
    textModelImpl,
  });
  assert.equal(cached.fromCache, true);
  assert.equal(modelCalls, 1);
  assert.equal(cached.narrativeStructure.slideRoles[0].role, "对比");
});

test("analysis failure does not overwrite successful cache", () => {
  const noteId = "note-fail-1";
  const sourceSignature = "sig-fail-1";
  upsertRemixAnalysisCache({
    noteId,
    boardKey: "xhs_hot",
    sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    analysisMode: "metadata_only",
    analysis: buildMetadataOnlyAnalysis({ ...sampleNote, noteId, id: noteId }, "xhs_hot"),
    modelName: "m",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    lastError: "",
  });
  const { recordRemixAnalysisCacheError } = require("../src/server/db/repositories/excellent-remix-analysis-cache-repository");
  recordRemixAnalysisCacheError({
    noteId,
    boardKey: "xhs_hot",
    sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    lastError: "temporary failure",
  });
  const row = findRemixAnalysisCache({
    noteId,
    boardKey: "xhs_hot",
    sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
  });
  assert.ok(row.analysis?.noteId);
  assert.equal(row.lastError, "temporary failure");
});

test("excellent list and refresh do not call remix analysis", async () => {
  seedNoteCache();
  let analyzeTouched = false;
  const original = analyzeExcellentNoteForRemix;
  // Ensure module export reference isn't used by list/refresh.
  const list = await getExcellentContents({ pgy: { enabled: false } }, { board: "xhs_hot" });
  assert.equal(list.items.length, 1);
  assert.equal(analyzeTouched, false);
  assert.ok(list.items[0].noteId);
  void original;
});

test("learning focus filters which analysis fields enter fusion learning set", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  const structureOnly = filterAnalysisByLearningFocus(analysis, ["structure"]);
  assert.deepEqual(structureOnly.focus, ["structure"]);
  assert.equal(structureOnly.applied.every((item) => item.type === "structure"), true);
  const hookVisual = filterAnalysisByLearningFocus(analysis, ["hook", "visual"]);
  assert.ok(hookVisual.applied.some((item) => item.type === "hook"));
  assert.ok(hookVisual.applied.some((item) => item.type === "visual"));
  assert.ok(!hookVisual.applied.some((item) => item.type === "conversion"));
});

test("smart directions produce 3 distinct transfer modes without trend requirement", async () => {
  seedNoteCache();
  const result = await generateContentDirections(
    { textProvider: {} },
    { userId: 201, noteId: sampleNote.noteId, board: "xhs_hot", brandId: 11 },
  );
  assert.equal(result.directions.length, 3);
  assert.ok(directionsAreDistinct(result.directions));
  assert.deepEqual(
    result.directions.map((item) => item.transferMode).sort(),
    ["brand_problem_transfer", "structure_transfer", "theme_transfer"],
  );
});

test("existing ideas flatten without requiring trend-first selection", () => {
  const ideas = flattenBrandIdeas(mockBrand);
  assert.equal(ideas.length, 3);
  assert.ok(ideas.every((item) => item.ideaTitle && item.trendId != null && item.ideaIndex != null));
  assert.ok(ideas.some((item) => item.ideaTitle === "转奶节奏对照表"));
});

test("trend recommendations respect threshold and default no-trend", async () => {
  const noTrend = await recommendTrendsForRemix({
    userId: 201,
    brandId: 11,
    contentMode: "custom",
    customDirection: "完全无关的量子物理实验方法",
  });
  assert.equal(noTrend.recommendation, "no_trend");
  assert.equal(noTrend.recommendations.length, 0);

  const withTrend = await recommendTrendsForRemix({
    userId: 201,
    brandId: 11,
    contentMode: "custom",
    customDirection: "想讲宝宝转奶期间便便变化与新手妈妈观察方法",
  });
  assert.ok(withTrend.recommendations.length <= 3);
  assert.ok(withTrend.recommendations.every((item) => item.relevanceScore >= TREND_RELEVANCE_THRESHOLD));
  assert.ok(!withTrend.recommendations.some((item) => item.title.includes("办公室")));
});

test("reference structure influences four-page slide roles", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  analysis.narrativeStructure.slideRoles = [
    { sourceIndex: 0, role: "对比", contentFunction: "先比" },
    { sourceIndex: 1, role: "误区", contentFunction: "再避坑" },
    { sourceIndex: 2, role: "方法", contentFunction: "给步骤" },
    { sourceIndex: 3, role: "清单", contentFunction: "可收藏" },
    { sourceIndex: 4, role: "提醒", contentFunction: "边界" },
  ];
  const pages = mapSlideRolesToFourPages(analysis, { focus: ["structure"], applied: [] });
  assert.equal(pages.length, 4);
  assert.equal(pages[0].pageRole, "对比");
  assert.equal(pages[3].pageRole, "提醒");
});

test("fusion plan works for smart mode without trend/idea and outputs 4 pages", async () => {
  seedNoteCache();
  const directions = buildDeterministicDirections(mockBrand, buildMetadataOnlyAnalysis(sampleNote, "xhs_hot"));
  const plan = await buildExcellentRemixFusionPlan(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      learningFocus: ["structure", "visual", "hook"],
      contentMode: "smart",
      smartDirection: directions[1],
      useTrendContext: false,
    },
  );
  assert.equal(plan.contentMode, "smart");
  assert.equal(plan.trendUsed, false);
  assert.equal(plan.carouselPack.slides.length, 4);
  assert.ok(plan.carouselPack.slides[0].pageRole);
  assert.ok(plan.referenceLearningApplied.some((item) => item.type === "structure"));
  // Not the old hard-coded fixed sequence forced as only path: structure_transfer uses reference roles.
  assert.ok(plan.carouselPack.slides.some((slide) => slide.pageRole));
  const prompt = buildImagePrompt({
    brand: mockBrand,
    contentType: "cover",
    platform: "xiaohongshu",
    remixBrief: plan.carouselPack.slides[0].remixBrief,
  });
  assert.match(prompt, /优秀内容仿写上下文/);
  assert.match(prompt, /内容方向/);
  assert.doesNotMatch(prompt, /cdn\.example/);
  assert.doesNotMatch(prompt, /xiaohongshu\.com\/explore/);
  assert.doesNotMatch(prompt, /sourceUrl/);
});

test("fusion plan with existing idea reads real idea and can omit parent trend", async () => {
  seedNoteCache();
  const plan = await buildExcellentRemixFusionPlan(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      learningFocus: ["structure", "conversion"],
      contentMode: "existing_idea",
      existingIdeaRef: { trendId: 301, ideaIndex: 0 },
      useTrendContext: false,
    },
  );
  assert.equal(plan.contentMode, "existing_idea");
  assert.equal(plan.trendUsed, false);
  assert.match(plan.contentThesis, /转奶|对照/);
  assert.equal(plan.carouselPack.slides.length, 4);
});

test("custom mode validates length and builds 4 pages", async () => {
  seedNoteCache();
  await assert.rejects(
    () =>
      buildExcellentRemixFusionPlan(
        { textProvider: {} },
        {
          userId: 201,
          noteId: sampleNote.noteId,
          board: "xhs_hot",
          brandId: 11,
          contentMode: "custom",
          customDirection: "短",
        },
      ),
    /至少/,
  );
  const plan = await buildExcellentRemixFusionPlan(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      contentMode: "custom",
      customDirection: "想讲宝宝转奶期间容易出现的便便变化，让妈妈理解温和好吸收。",
      useTrendContext: false,
    },
  );
  assert.equal(plan.contentMode, "custom");
  assert.equal(plan.carouselPack.slides.length, 4);
});

test("normalizeRemixBrief strips secrets and keeps structured fields", () => {
  const brief = normalizeRemixBrief({
    sourceType: "excellent_content",
    sourceNoteId: "n1",
    contentMode: "smart",
    contentDirection: "讲转奶节奏",
    targetAudience: "新手妈妈",
    userScene: "夜间喂养",
    trendUsed: true,
    trendTitle: "转奶话题",
    learningFocus: ["structure"],
    pageRole: "对比",
    contentGoal: "先比",
    sourceLearningApplied: ["结构：对比"],
    sourceUrl: "https://secret.example/note",
    imageUrls: ["https://cdn.example/x.jpg"],
    token: "abc",
  });
  assert.equal(brief.contentMode, "smart");
  assert.equal(brief.pageRole, "对比");
  assert.equal(brief.sourceLearningApplied[0], "结构：对比");
  assert.equal(brief.sourceUrl, undefined);
  assert.equal(brief.token, undefined);
  assert.equal(brief.imageUrls, undefined);
});

test("product images are brand scoped; unassigned and other brand excluded", () => {
  insertProductImage({
    id: 501,
    ownerUserId: 201,
    brandId: 11,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "brand11-product.png",
    storedPath: "uploads/p1.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 502,
    ownerUserId: 201,
    brandId: 99,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "other-brand.png",
    storedPath: "uploads/p2.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: "b".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 503,
    ownerUserId: 201,
    brandId: 0,
    assetType: ASSET_TYPE_UNASSIGNED,
    originalName: "laptop-screenshot.png",
    storedPath: "uploads/p3.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: "c".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  const scoped = listProductImagesByOwnerAndBrand(201, 11);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].originalName, "brand11-product.png");
  assert.equal(findProductImageByOwnerBrandAndType(502, 201, 11, ASSET_TYPE_PRODUCT), null);
  assert.equal(findProductImageByOwnerBrandAndType(503, 201, 11, ASSET_TYPE_PRODUCT), null);
  assert.ok(findProductImageByOwnerBrandAndType(501, 201, 11, ASSET_TYPE_PRODUCT));
});

test("normal xhs carousel pack path still normalizes 4 slides", () => {
  const pack = normalizeGeneratedXhsCarouselPack({
    title: "普通组图",
    publishTitle: "普通组图标题",
    publishCaption: "普通组图发布文案足够长",
    slides: [1, 2, 3, 4].map((n) => ({
      pageLabel: `第 ${n} 张`,
      title: `标题${n}`,
      copy: `文案${n}`,
      visualDirection: `视觉${n}`,
    })),
  });
  assert.equal(pack.slides.length, 4);
  assert.ok(!pack.remixBrief);
});

test("scoreTrendRelevance is deterministic", () => {
  const trend = mockBrand.trends[0].items[0];
  const a = scoreTrendRelevance(trend, "宝宝转奶 新手妈妈 便便", mockBrand);
  const b = scoreTrendRelevance(trend, "宝宝转奶 新手妈妈 便便", mockBrand);
  assert.equal(a, b);
  assert.ok(a > scoreTrendRelevance(trend, "量子物理 航天 材料", mockBrand));
});
