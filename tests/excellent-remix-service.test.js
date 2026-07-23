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
  findDuplicateProductImage,
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
  buildFourPageFusionBlueprint,
  normalizeSourcePageRole,
  scoreTrendRelevance,
  tokenizeForRelevance,
  resolveExistingIdea,
  resolveExcellentRemixHistoryAttribution,
  TREND_RELEVANCE_THRESHOLD,
} = require("../src/server/services/excellent-remix-fusion-service");
const { buildImagePrompt } = require("../src/server/ai/image-prompt-builder");
const { normalizeGeneratedXhsCarouselPack, normalizeRemixBrief } = require("../src/server/ai/content-service");
const { getExcellentContents } = require("../src/server/services/excellent-content-service");

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
          title: "转奶期喂养焦虑升温，家长关注宝宝便便变化",
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
        {
          id: 303,
          title: "高温天气底妆脱妆讨论上涨",
          summary: "夏天油皮控油与妆容持久",
          reason: "季节讨论",
          category: "美妆",
          tags: ["脱妆", "底妆", "控油", "高温"],
          ideas: [
            {
              title: "油皮夏日底妆",
              summary: "控油与持久",
              angle: "通勤",
              audience: "油皮",
              brandFit: "无",
              hook: "脱妆",
              tags: ["油皮"],
            },
          ],
        },
        {
          id: 304,
          title: "量子物理实验",
          summary: "实验室装置",
          tags: ["物理", "实验"],
          ideas: [],
        },
        {
          id: 305,
          title: "春节旅游攻略",
          summary: "假期出行",
          tags: ["旅游", "春节"],
          ideas: [],
        },
      ],
    },
  ],
  analyses: [
    {
      id: 77,
      name: "二月转奶复盘",
      timestamp: "2026-02-10T10:00:00.000Z",
      trendSnapshot: [
        {
          key: "xhs",
          items: [
            {
              id: 301,
              title: "历史同 id 趋势不同内容",
              summary: "历史 snapshot 中的转奶选题",
              tags: ["转奶"],
              ideas: [
                {
                  title: "历史 snapshot 转奶选题",
                  summary: "来自历史分析快照，不应与当前串用",
                  angle: "历史场景",
                  audience: "新手妈妈",
                  brandFit: "温和",
                  hook: "历史钩子",
                  tags: ["转奶"],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const brandRepo = require("../src/server/db/repositories/brand-repository");
const originalFindBrandByOwner = brandRepo.findBrandByOwner;
brandRepo.findBrandByOwner = (brandId, ownerUserId) => {
  if (Number(brandId) === 11 && Number(ownerUserId) === 201) return mockBrand;
  if (Number(brandId) === 12 && Number(ownerUserId) === 201) {
    return { ...mockBrand, id: 12, name: "另一品牌", analyses: [], trends: [] };
  }
  return originalFindBrandByOwner(brandId, ownerUserId);
};

test("provider does not claim multimodal vision support", () => {
  assert.equal(supportsMultimodalVision({ textProvider: { model: "gpt-like" } }), false);
});

test("metadata_only analysis never fabricates body text and marks platform_default visual", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  assert.equal(analysis.analysisMode, "metadata_only");
  assert.equal(analysis.meta.hasBodyText, false);
  assert.equal(analysis.visualLanguage.source, "platform_default");
  assert.equal(analysis.visualLanguage.confidence, "low");
  assert.match(analysis.narrativeStructure.summary, /正文未由接口提供|元数据/);
  const serialized = JSON.stringify(analysis);
  assert.doesNotMatch(serialized, /cdn\.example/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /爆款原因/);
});

test("metadata_only does not claim image color recognition as reference learning", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  const learning = filterAnalysisByLearningFocus(analysis, ["structure", "visual", "hook"]);
  assert.ok(learning.applied.every((item) => item.type !== "visual"));
  assert.ok(learning.platformVisualGuidance);
  assert.equal(learning.platformVisualGuidance.source, "platform_default");
  assert.match(learning.platformVisualGuidance.description, /平台通用视觉建议|未进行图片理解/);
  assert.doesNotMatch(JSON.stringify(learning.applied), /参考笔记视觉|已识别配色/);
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

test("excellent list does not call remix analysis", async () => {
  seedNoteCache();
  const list = await getExcellentContents({ pgy: { enabled: false } }, { board: "xhs_hot" });
  assert.equal(list.items.length, 1);
  assert.ok(list.items[0].noteId);
});

test("learning focus filters and separates platform visual guidance", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  const structureOnly = filterAnalysisByLearningFocus(analysis, ["structure"]);
  assert.deepEqual(structureOnly.focus, ["structure"]);
  assert.equal(structureOnly.applied.every((item) => item.type === "structure"), true);
  const hookVisual = filterAnalysisByLearningFocus(analysis, ["hook", "visual"]);
  assert.ok(hookVisual.applied.some((item) => item.type === "hook"));
  assert.ok(!hookVisual.applied.some((item) => item.type === "visual"));
  assert.ok(hookVisual.platformVisualGuidance);
});

test("smart directions produce 3 distinct transfer modes without trend requirement", async () => {
  seedNoteCache();
  const result = await generateContentDirections(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      contentSource: "all",
      categoryPath: "",
      industryPath: "",
    },
  );
  assert.equal(result.directions.length, 3);
  assert.ok(directionsAreDistinct(result.directions));
  assert.deepEqual(
    result.directions.map((item) => item.transferMode).sort(),
    ["brand_problem_transfer", "structure_transfer", "theme_transfer"],
  );
});

test("generateContentDirections forwards taxonomy context when re-analyzing", async () => {
  let seen = null;
  const result = await generateContentDirections(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      contentSource: "professional",
      categoryPath: "内容类目#母婴#喂养",
      industryPath: "电商行业#母婴",
      analyzeImpl: async (_appConfig, options) => {
        seen = options;
        return {
          ...buildMetadataOnlyAnalysis(sampleNote, "xhs_hot"),
          analysisId: "note-remix-1|xhs_hot|sig|v",
        };
      },
    },
  );
  assert.equal(result.directions.length, 3);
  assert.equal(seen.contentSource, "professional");
  assert.equal(seen.categoryPath, "内容类目#母婴#喂养");
  assert.equal(seen.industryPath, "电商行业#母婴");
});

test("existing ideas include current and historical snapshot scopes", () => {
  const ideas = flattenBrandIdeas(mockBrand);
  assert.ok(ideas.some((item) => item.scope === "current" && item.ideaTitle === "转奶节奏对照表"));
  assert.ok(ideas.some((item) => item.scope === "snapshot" && item.ideaTitle === "历史 snapshot 转奶选题"));
  assert.ok(ideas.some((item) => item.scope === "snapshot" && item.analysisName === "二月转奶复盘"));
});

test("resolveExistingIdea does not mix same trendId across analyses", () => {
  const current = resolveExistingIdea(mockBrand, { scope: "current", trendId: 301, ideaIndex: 0 });
  assert.equal(current.idea.title, "转奶节奏对照表");
  const snapshot = resolveExistingIdea(mockBrand, {
    scope: "snapshot",
    analysisId: 77,
    trendId: 301,
    ideaIndex: 0,
  });
  assert.equal(snapshot.idea.title, "历史 snapshot 转奶选题");
  assert.throws(
    () => resolveExistingIdea(mockBrand, { scope: "snapshot", analysisId: 999, trendId: 301, ideaIndex: 0 }),
    /历史分析|不存在/,
  );
});

test("chinese trend relevance positive and negative samples", async () => {
  const direction = "宝宝转奶期间便便变化与新手妈妈观察方法";
  const trend = mockBrand.trends[0].items[0];
  const score = scoreTrendRelevance(trend, direction, mockBrand);
  assert.ok(score >= TREND_RELEVANCE_THRESHOLD, `expected related score, got ${score}`);

  const oilDirection = "油皮夏季控油与妆容持久";
  const oilTrend = mockBrand.trends[0].items.find((item) => item.id === 303);
  const oilScore = scoreTrendRelevance(oilTrend, oilDirection, mockBrand);
  assert.ok(oilScore >= TREND_RELEVANCE_THRESHOLD * 0.7, `expected near-related oil score, got ${oilScore}`);

  const quantum = mockBrand.trends[0].items.find((item) => item.id === 304);
  assert.ok(scoreTrendRelevance(quantum, direction, mockBrand) < TREND_RELEVANCE_THRESHOLD);
  const office = mockBrand.trends[0].items.find((item) => item.id === 302);
  assert.ok(scoreTrendRelevance(office, direction, mockBrand) < TREND_RELEVANCE_THRESHOLD);
  const travel = mockBrand.trends[0].items.find((item) => item.id === 305);
  assert.ok(scoreTrendRelevance(travel, direction, mockBrand) < TREND_RELEVANCE_THRESHOLD);

  const withTrend = await recommendTrendsForRemix({
    userId: 201,
    brandId: 11,
    contentMode: "custom",
    customDirection: direction,
  });
  assert.ok(withTrend.recommendations.some((item) => item.title.includes("转奶") || item.title.includes("便便")));
  assert.ok(!withTrend.recommendations.some((item) => item.title.includes("办公室") || item.title.includes("量子") || item.title.includes("旅游")));

  // Direction that must not match any brand trend (including the quantum trend item).
  const noTrend = await recommendTrendsForRemix({
    userId: 201,
    brandId: 11,
    contentMode: "custom",
    customDirection: "深海鱼类基因测序与航天热防护涂层工艺",
  });
  assert.equal(noTrend.recommendation, "no_trend");
  assert.equal(noTrend.recommendations.length, 0);
  // Quantum direction should not pull 转奶 content.
  const quantumRecs = await recommendTrendsForRemix({
    userId: 201,
    brandId: 11,
    contentMode: "custom",
    customDirection: "量子物理实验",
  });
  assert.ok(!quantumRecs.recommendations.some((item) => item.title.includes("转奶") || item.title.includes("便便")));
});

test("tokenizeForRelevance emits chinese bigrams and domain keywords", () => {
  const tokens = tokenizeForRelevance("宝宝转奶期间便便变化");
  const values = tokens.map((item) => item.token);
  assert.ok(values.some((token) => token.includes("转奶") || token === "转奶"));
  assert.ok(values.some((token) => token.length === 2 || token.length === 3));
});

test("normalizeSourcePageRole maps chinese labels", () => {
  assert.equal(normalizeSourcePageRole("对比横评", "先比"), "comparison");
  assert.equal(normalizeSourcePageRole("证据", "实测数据"), "evidence");
  assert.equal(normalizeSourcePageRole("误区避坑", ""), "mistake");
  assert.equal(normalizeSourcePageRole("方法步骤", "怎么做"), "method");
  assert.equal(normalizeSourcePageRole("总结结论", ""), "conclusion");
});

test("dynamic four-page blueprint follows comparison→evidence→mistake→conclusion", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  analysis.narrativeStructure.slideRoles = [
    { sourceIndex: 0, role: "对比", contentFunction: "先比" },
    { sourceIndex: 1, role: "证据", contentFunction: "实测" },
    { sourceIndex: 2, role: "误区", contentFunction: "避坑" },
    { sourceIndex: 3, role: "结论", contentFunction: "收束" },
  ];
  const blueprint = buildFourPageFusionBlueprint({
    sourceAnalysis: analysis,
    learningFocus: ["structure", "hook"],
    contentDirection: { contentThesis: "转奶观察", ideaTitle: "转奶观察", targetAudience: "新手妈妈" },
    brand: mockBrand,
  });
  assert.equal(blueprint.pages.length, 4);
  assert.deepEqual(
    blueprint.pages.map((page) => page.pageRole),
    ["comparison", "evidence", "mistake", "conclusion"],
  );
  assert.ok(blueprint.pages.some((page) => page.brandPlacement !== "explicit"));
  assert.notEqual(blueprint.pages[2].brandPlacement, "explicit");
});

test("question→explanation→method→reminder structure and 6-page remap", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  analysis.narrativeStructure.slideRoles = [
    { role: "问题", contentFunction: "困扰" },
    { role: "解释", contentFunction: "原理" },
    { role: "方法", contentFunction: "路径" },
    { role: "提醒", contentFunction: "边界" },
  ];
  const four = buildFourPageFusionBlueprint({
    sourceAnalysis: analysis,
    learningFocus: ["structure"],
    contentDirection: { contentThesis: "方法" },
    brand: mockBrand,
  });
  assert.deepEqual(
    four.pages.map((page) => page.pageRole),
    ["question", "explanation", "method", "reminder"],
  );

  analysis.narrativeStructure.slideRoles = [
    { role: "钩子" },
    { role: "问题" },
    { role: "对比" },
    { role: "证据" },
    { role: "方法" },
    { role: "结论" },
  ];
  const mapped = mapSlideRolesToFourPages(analysis, { focus: ["structure"], applied: [] });
  assert.equal(mapped.length, 4);
  assert.equal(mapped[0].pageRoleKey || normalizeSourcePageRole(mapped[0].pageRole), "hook");
});

test("without structure focus uses safe system structure", () => {
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  analysis.narrativeStructure.slideRoles = [
    { role: "对比" },
    { role: "证据" },
    { role: "误区" },
    { role: "结论" },
  ];
  const blueprint = buildFourPageFusionBlueprint({
    sourceAnalysis: analysis,
    learningFocus: ["hook"],
    contentDirection: { contentThesis: "x" },
    brand: mockBrand,
  });
  assert.deepEqual(
    blueprint.pages.map((page) => page.pageRole),
    ["hook", "question", "method", "conclusion"],
  );
});

test("fusion plan roles change title/copy and hook formula affects cover", async () => {
  seedNoteCache();
  const analysis = buildMetadataOnlyAnalysis(sampleNote, "xhs_hot");
  analysis.hookPattern = { type: "question", description: "提问", titleFormula: "疑问句点出用户困惑" };
  analysis.narrativeStructure.slideRoles = [
    { role: "对比", contentFunction: "先比" },
    { role: "证据", contentFunction: "实测" },
    { role: "误区", contentFunction: "避坑" },
    { role: "结论", contentFunction: "收束" },
  ];
  // Seed cache so fusion reuses structured analysis.
  const signature = buildSourceSignature(sampleNote);
  upsertRemixAnalysisCache({
    noteId: sampleNote.noteId,
    boardKey: "xhs_hot",
    sourceSignature: signature,
    analysisVersion: ANALYSIS_VERSION,
    analysisMode: "metadata_only",
    analysis,
    modelName: "m",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    lastError: "",
  });
  const directions = buildDeterministicDirections(mockBrand, analysis);
  const plan = await buildExcellentRemixFusionPlan(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      learningFocus: ["structure", "hook"],
      contentMode: "smart",
      smartDirection: directions[0],
      useTrendContext: false,
      sourceAnalysisId: `${sampleNote.noteId}|xhs_hot|${signature}|${ANALYSIS_VERSION}`,
    },
  );
  assert.equal(plan.carouselPack.slides.length, 4);
  const roles = plan.carouselPack.slides.map((slide) => slide.pageRoleKey || slide.pageRole);
  assert.ok(roles.some((role) => /对比|comparison/i.test(String(role))));
  assert.ok(roles.some((role) => /证据|evidence/i.test(String(role))));
  // Not fixed page-3 brand template.
  assert.doesNotMatch(plan.carouselPack.slides[2].title, /可以这样拆/);
  // Last page not forced checklist when role is conclusion.
  assert.doesNotMatch(plan.carouselPack.slides[3].title, /收藏这份行动清单/);
  // Hook formula affects cover title.
  assert.match(plan.carouselPack.slides[0].title, /哪一步|？|\?|卡/);
  // platform visual separated
  if (plan.platformVisualGuidance) {
    assert.equal(plan.platformVisualGuidance.source, "platform_default");
  }
  assert.ok(!plan.referenceLearningApplied.some((item) => item.type === "visual"));
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
      learningFocus: ["structure", "hook"],
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

test("fusion plan with existing idea and snapshot idea", async () => {
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
      existingIdeaRef: { scope: "current", trendId: 301, ideaIndex: 0 },
      useTrendContext: false,
    },
  );
  assert.equal(plan.contentMode, "existing_idea");
  assert.equal(plan.trendUsed, false);
  assert.match(plan.contentThesis, /转奶|对照/);

  const snapPlan = await buildExcellentRemixFusionPlan(
    { textProvider: {} },
    {
      userId: 201,
      noteId: sampleNote.noteId,
      board: "xhs_hot",
      brandId: 11,
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "snapshot", analysisId: 77, trendId: 301, ideaIndex: 0 },
      useTrendContext: false,
    },
  );
  assert.match(snapPlan.contentThesis, /历史|快照|转奶/);
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

test("history attribution ignores client forged titles", () => {
  const forged = resolveExcellentRemixHistoryAttribution(mockBrand, {
    contentMode: "existing_idea",
    existingIdeaRef: { scope: "current", trendId: 301, ideaIndex: 0 },
    trendTitle: "伪造趋势标题",
    ideaTitle: "伪造选题标题",
    carouselPack: { publishTitle: "也不该覆盖" },
  });
  assert.equal(forged.trendTitle, "转奶期喂养焦虑升温，家长关注宝宝便便变化");
  assert.equal(forged.ideaTitle, "转奶节奏对照表");
  assert.notEqual(forged.ideaTitle, "伪造选题标题");

  const snap = resolveExcellentRemixHistoryAttribution(mockBrand, {
    contentMode: "existing_idea",
    existingIdeaRef: { scope: "snapshot", analysisId: 77, trendId: 301, ideaIndex: 0 },
    ideaTitle: "客户端伪造",
  });
  assert.equal(snap.ideaTitle, "历史 snapshot 转奶选题");

  const smart = resolveExcellentRemixHistoryAttribution(mockBrand, {
    contentMode: "smart",
    trendTitle: "不该出现的趋势",
    ideaTitle: "客户端想塞的标题",
    carouselPack: { publishTitle: "服务端规范化标题", title: "备选" },
  });
  assert.equal(smart.trendId, 0);
  assert.equal(smart.trendTitle, "");
  assert.equal(smart.ideaTitle, "服务端规范化标题");

  assert.throws(
    () =>
      resolveExcellentRemixHistoryAttribution(mockBrand, {
        contentMode: "existing_idea",
        existingIdeaRef: { scope: "snapshot", analysisId: 123456, trendId: 301, ideaIndex: 0 },
      }),
    /不存在|无权/,
  );
});

test("normalizeRemixBrief keeps platformVisualGuidance separate", () => {
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
    platformVisualGuidance: "平台通用视觉建议：竖图信息流",
    sourceUrl: "https://secret.example/note",
    imageUrls: ["https://cdn.example/x.jpg"],
    token: "abc",
  });
  assert.equal(brief.contentMode, "smart");
  assert.equal(brief.pageRole, "对比");
  assert.equal(brief.sourceLearningApplied[0], "结构：对比");
  assert.match(brief.platformVisualGuidance, /平台通用/);
  assert.equal(brief.sourceUrl, undefined);
  assert.equal(brief.token, undefined);
  assert.equal(brief.imageUrls, undefined);
});

test("product images brand-scoped dedupe allows same sha across brands", () => {
  const sha = "d".repeat(64);
  insertProductImage({
    id: 601,
    ownerUserId: 201,
    brandId: 11,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "brand11-product.png",
    storedPath: "uploads/p11.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: sha,
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 602,
    ownerUserId: 201,
    brandId: 12,
    assetType: ASSET_TYPE_PRODUCT,
    originalName: "brand12-same-file.png",
    storedPath: "uploads/p12.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: sha,
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertProductImage({
    id: 603,
    ownerUserId: 201,
    brandId: 0,
    assetType: ASSET_TYPE_UNASSIGNED,
    originalName: "unassigned.png",
    storedPath: "uploads/p0.png",
    mimeType: "image/png",
    sizeBytes: 12,
    sha256: "e".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  const scoped11 = listProductImagesByOwnerAndBrand(201, 11);
  const scoped12 = listProductImagesByOwnerAndBrand(201, 12);
  assert.ok(scoped11.some((item) => item.id === 601));
  assert.ok(scoped12.some((item) => item.id === 602));
  assert.ok(!scoped11.some((item) => item.id === 602));
  assert.ok(!scoped11.some((item) => item.id === 603));
  assert.equal(
    findDuplicateProductImage({ ownerUserId: 201, brandId: 11, assetType: ASSET_TYPE_PRODUCT, sha256: sha })?.id,
    601,
  );
  assert.equal(
    findDuplicateProductImage({ ownerUserId: 201, brandId: 12, assetType: ASSET_TYPE_PRODUCT, sha256: sha })?.id,
    602,
  );
  assert.equal(findProductImageByOwnerBrandAndType(603, 201, 11, ASSET_TYPE_PRODUCT), null);
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
