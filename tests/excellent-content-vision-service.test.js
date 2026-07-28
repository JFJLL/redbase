const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-excellent-vision-"));
process.env.REDBASE_DB_FILE = path.join(tempDir, "vision.sqlite");

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes, ensureSchemaUpgrades } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { upsertExcellentContentCache } = require("../src/server/db/repositories/excellent-content-cache-repository");
const { upsertRemixAnalysisCache } = require("../src/server/db/repositories/excellent-remix-analysis-cache-repository");
const {
  VISION_ANALYSIS_VERSION,
  VISION_CACHE_TTL_MS,
  VISION_CACHE_BOARD_KEY,
  MAX_VISION_IMAGES,
  VISION_FALLBACK_WARNING,
  selectVisionImageUrls,
  buildImageSignature,
  analyzeExcellentContentVision,
  findVisionAnalysisCache,
  __resetVisionAnalysisInFlightForTests,
} = require("../src/server/services/excellent-content-vision-service");
const {
  analyzeExcellentNoteForRemix,
  buildSourceSignature,
  supportsMultimodalVision,
  ANALYSIS_VERSION,
  MULTIMODAL_ANALYSIS_TTL_MS,
  __resetRemixAnalysisInFlightForTests,
} = require("../src/server/services/excellent-remix-analysis-service");
const { generateContentDirections } = require("../src/server/services/excellent-remix-fusion-service");
const { createExcellentVisionStorageProvider } = require("../src/server/services/excellent-vision-storage-provider");

openDatabase();
initializeDatabaseSchema();
ensureSchemaUpgrades();
ensureDatabaseIndexes();

insertUser({
  id: 301,
  name: "Vision Tester",
  phone: "13910000301",
  password: "hash",
  accountType: "customer",
  credits: 20,
  createdAt: "2026-07-28T00:00:00.000Z",
});

const brandRepo = require("../src/server/db/repositories/brand-repository");
const originalFindBrandByOwner = brandRepo.findBrandByOwner;
const visionBrand = {
  id: 21,
  name: "温和星球",
  industry: "母婴",
  audience: "新手妈妈",
  description: "关注宝宝喂养与消化舒适",
  product: "有机奶粉，温和好吸收",
  goal: "帮助家长更安心完成转奶",
  knowledgeBase: "",
  trends: [],
  analyses: [],
};
brandRepo.findBrandByOwner = (brandId, ownerUserId) => {
  if (Number(brandId) === 21 && Number(ownerUserId) === 301) return visionBrand;
  return originalFindBrandByOwner(brandId, ownerUserId);
};

const APP_CONFIG = { textProvider: { apiKey: "test-key", model: "vision-model" } };

function buildNote(noteId, imageCount = 6) {
  return {
    id: noteId,
    noteId,
    title: "转奶避坑清单：这 5 步别再做错？",
    author: { nickname: "育儿笔记" },
    imageUrls: Array.from({ length: imageCount }, (_, index) => `https://cdn.example/${noteId}/p${index + 1}.jpg`),
    imageCount,
    metrics: { readCount: 56000, engagementCount: 1200 },
    categoryPath: "内容类目#母婴",
    contentSource: "professional",
    board: "xhs_hot",
  };
}

function seedNoteCache(note) {
  upsertExcellentContentCache({
    sourceKey: "xhs_hot",
    categoryPath: "",
    items: [note],
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    lastError: "",
  });
}

function buildVisionModelResult() {
  return {
    visualLanguage: {
      layout: "三段式信息卡",
      color: "奶油色低饱和",
      typography: "大号标题加要点短句",
      composition: "封面大标题居中",
      textDensity: "中等偏少",
      imageTextRatio: "图主文辅",
    },
    structure: {
      hook: { type: "question", description: "封面采用问题型标题", titleFormula: "疑问句加人群" },
      pages: [
        { role: "封面钩子", focus: "提出转奶疑问" },
        { role: "痛点场景", focus: "展开常见困扰" },
        { role: "方法拆解", focus: "给出分步做法" },
        { role: "总结清单", focus: "沉淀可收藏要点" },
      ],
      narrativeFlow: "前3页形成痛点-方法-总结结构",
    },
    conversion: { interaction: "结尾引导收藏对照", saveReason: "步骤清单可回看执行" },
    learningSummary: ["封面采用问题型标题", "前3页形成痛点-方法-总结结构", "视觉偏生活化信息卡表达"],
  };
}

function resetInFlight() {
  __resetRemixAnalysisInFlightForTests();
  __resetVisionAnalysisInFlightForTests();
}

test("provider vision support requires an api key and an openai-compatible style", () => {
  assert.equal(supportsMultimodalVision({ textProvider: { model: "gpt-like" } }), false);
  assert.equal(supportsMultimodalVision({ textProvider: { apiKey: "k", model: "m", apiStyle: "google" } }), false);
  assert.equal(supportsMultimodalVision({ textProvider: { apiKey: "k", model: "m", apiStyle: "anthropic" } }), false);
  assert.equal(supportsMultimodalVision(APP_CONFIG), true);
});

test("image input strategy keeps at most 4 urls prioritising cover then pages 2-4", () => {
  const note = buildNote("note-limit", 6);
  const selected = selectVisionImageUrls(note.imageUrls);
  assert.equal(selected.length, MAX_VISION_IMAGES);
  assert.deepEqual(selected, note.imageUrls.slice(0, 4));
  // 非 http(s) 输入被拒绝，本阶段不做图片下载。
  assert.deepEqual(selectVisionImageUrls(["file:///tmp/a.jpg", "  ", null]), []);
});

test("multimodal success returns analysisMode=multimodal with user-facing learning summary", async () => {
  resetInFlight();
  const note = buildNote("note-vision-ok", 6);
  seedNoteCache(note);
  const receivedImageUrls = [];
  let visionCalls = 0;
  const visionModelImpl = async (_config, payload) => {
    visionCalls += 1;
    receivedImageUrls.push(...payload.imageUrls);
    return buildVisionModelResult();
  };

  const analysis = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });

  assert.equal(visionCalls, 1);
  // 输入 4 张图片 URL（封面 + 第2/3/4页）。
  assert.deepEqual(receivedImageUrls, note.imageUrls.slice(0, 4));
  assert.equal(analysis.analysisMode, "multimodal");
  assert.equal(analysis.meta.multimodalUsed, true);
  assert.equal(analysis.meta.visionImageCount, 4);
  assert.equal(analysis.visualLanguage.source, "reference_image");
  assert.deepEqual(analysis.learningSummary, [
    "封面采用问题型标题",
    "前3页形成痛点-方法-总结结构",
    "视觉偏生活化信息卡表达",
  ]);
  assert.equal(analysis.narrativeStructure.slideRoles[0].role, "封面钩子");
  assert.equal(analysis.warning, undefined);
  // 面向用户展示：不泄漏图片 URL、prompt 或模型内部字段。
  const serialized = JSON.stringify(analysis);
  assert.doesNotMatch(serialized, /cdn\.example/);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /systemPrompt|userPrompt/);
});

test("vision model failure degrades to metadata_only with warning and the flow continues", async () => {
  resetInFlight();
  const note = buildNote("note-vision-fail", 4);
  seedNoteCache(note);
  let visionCalls = 0;
  const failingVisionImpl = async () => {
    visionCalls += 1;
    throw new Error("vision transport failed");
  };
  const failingTextImpl = async () => {
    throw new Error("text model failed too");
  };

  const analysis = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl: failingVisionImpl,
    textModelImpl: failingTextImpl,
  });

  assert.equal(visionCalls, 1);
  assert.equal(analysis.analysisMode, "metadata_only");
  assert.equal(analysis.meta.multimodalUsed, false);
  assert.equal(analysis.warning, "未成功读取参考图片，本次基于标题和内容结构分析");
  assert.equal(analysis.warning, VISION_FALLBACK_WARNING);

  // 流程继续：内容方向仍然产出 3 个可用方向。
  resetInFlight();
  const directions = await generateContentDirections(APP_CONFIG, {
    userId: 301,
    noteId: note.noteId,
    board: "xhs_hot",
    brandId: 21,
    contentSource: "all",
    visionModelImpl: failingVisionImpl,
    textModelImpl: failingTextImpl,
  });
  assert.equal(directions.directions.length, 3);
  assert.ok(directions.directions.every((item) => item.title && item.contentThesis));
});

test("cache hit serves the second request without calling the model and is shared by note+imageSignature", async () => {
  resetInFlight();
  const note = buildNote("note-vision-cache", 5);
  seedNoteCache(note);
  let visionCalls = 0;
  const visionModelImpl = async () => {
    visionCalls += 1;
    return buildVisionModelResult();
  };

  const first = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });
  assert.equal(first.fromCache, false);
  assert.equal(visionCalls, 1);

  // 第二次请求：同一优秀内容（任何用户）直接命中缓存，不再调模型。
  const second = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });
  assert.equal(second.fromCache, true);
  assert.equal(second.analysisMode, "multimodal");
  assert.equal(visionCalls, 1);

  // 标题变化只改外层签名；imageSignature 未变时视觉层缓存兜底，仍不调模型。
  const retitled = { ...note, title: "标题被运营改了一次" };
  seedNoteCache(retitled);
  resetInFlight();
  const third = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });
  assert.equal(third.analysisMode, "multimodal");
  assert.equal(visionCalls, 1);

  // 缓存行只保存分析结果与签名（30 天周期），不保存图片或原始 URL。
  const imageSignature = buildImageSignature(note.noteId, note.imageUrls);
  const row = findVisionAnalysisCache(note.noteId, imageSignature);
  assert.ok(row?.analysis);
  assert.equal(row.sourceSignature, imageSignature);
  assert.equal(row.analysisVersion, VISION_ANALYSIS_VERSION);
  assert.equal(row.boardKey, VISION_CACHE_BOARD_KEY);
  assert.equal(Date.parse(row.expiresAt) - Date.parse(row.createdAt), VISION_CACHE_TTL_MS);
  assert.equal(VISION_CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(MULTIMODAL_ANALYSIS_TTL_MS, VISION_CACHE_TTL_MS);
  assert.doesNotMatch(JSON.stringify(row.analysis), /cdn\.example|https?:\/\//i);
});

test("an expired 30-day cache triggers a fresh multimodal analysis", async () => {
  resetInFlight();
  const note = buildNote("note-vision-expired", 4);
  seedNoteCache(note);
  let visionCalls = 0;
  const visionModelImpl = async () => {
    visionCalls += 1;
    return buildVisionModelResult();
  };

  const first = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });
  assert.equal(first.analysisMode, "multimodal");
  assert.equal(visionCalls, 1);

  // 模拟 30 天后：视觉层与外层分析行同时过期。
  const past = new Date(Date.now() - 1000).toISOString();
  const imageSignature = buildImageSignature(note.noteId, note.imageUrls);
  const visionRow = findVisionAnalysisCache(note.noteId, imageSignature);
  upsertRemixAnalysisCache({ ...visionRow, expiresAt: past });
  upsertRemixAnalysisCache({
    noteId: note.noteId,
    boardKey: "xhs_hot",
    sourceSignature: buildSourceSignature(note),
    analysisVersion: ANALYSIS_VERSION,
    analysisMode: "multimodal",
    analysis: first,
    createdAt: past,
    expiresAt: past,
  });

  resetInFlight();
  const again = await analyzeExcellentNoteForRemix(APP_CONFIG, {
    noteId: note.noteId,
    board: "xhs_hot",
    visionModelImpl,
  });
  assert.equal(again.analysisMode, "multimodal");
  assert.equal(again.fromCache, false);
  assert.equal(visionCalls, 2);
});

test("degraded outcomes are never written into the 30-day vision cache", async () => {
  resetInFlight();
  const note = buildNote("note-vision-no-degraded-cache", 4);
  seedNoteCache(note);
  const outcome = await analyzeExcellentContentVision(APP_CONFIG, {
    noteId: note.noteId,
    imageUrls: note.imageUrls,
    title: note.title,
    visionModelImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(outcome.analysisMode, "metadata_only");
  assert.equal(outcome.warning, VISION_FALLBACK_WARNING);
  const row = findVisionAnalysisCache(note.noteId, buildImageSignature(note.noteId, note.imageUrls));
  assert.equal(row, null);
});

test("storage provider reserves the OSS seam with a local url-passthrough driver", async () => {
  const provider = createExcellentVisionStorageProvider();
  assert.equal(provider.driver, "local");
  const inputs = await provider.resolveImageInputs(["https://cdn.example/a.jpg", "not-a-url"]);
  assert.deepEqual(inputs, [{ type: "url", url: "https://cdn.example/a.jpg" }]);
  assert.throws(() => createExcellentVisionStorageProvider({ driver: "aliyun" }), /暂不支持的存储驱动/);
});
