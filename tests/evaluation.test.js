const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  TASKS,
  PROMPT_VERSIONS,
  configureEvaluationStore,
  resetEvaluationStoreForTests,
  recordAiRun,
  rateGeneration,
  findEvaluationRun,
  listEvaluationRuns,
  comparePromptVersions,
  compareByContext,
  estimateTrendAutoQualityScore,
} = require("../src/server/ai/evaluation");

let tempDir = "";
let tempFile = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-eval-"));
  tempFile = path.join(tempDir, "runs.jsonl");
  configureEvaluationStore({ storePath: tempFile, memory: false });
});

afterEach(() => {
  resetEvaluationStoreForTests();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_error) {
    // ignore cleanup failures
  }
});

test("recordAiRun persists required observability fields", () => {
  const run = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "deepseek/deepseek-v4-flash",
    prompt_version: PROMPT_VERSIONS.trend_analysis,
    latency: 1234,
    success: true,
    quality_score: null,
  });

  assert.ok(run.id);
  assert.equal(run.task, "trend_analysis");
  assert.equal(run.model, "deepseek/deepseek-v4-flash");
  assert.equal(run.prompt_version, "trend-v2");
  assert.equal(run.latency, 1234);
  assert.equal(run.success, true);
  assert.equal(run.quality_score, null);

  const loaded = findEvaluationRun(run.id);
  assert.equal(loaded.id, run.id);
  assert.equal(loaded.latency, 1234);
});

test("rateGeneration accepts scores from 1 to 5", () => {
  const run = recordAiRun({
    task: TASKS.IMAGE_GENERATION,
    model: "gpt-image-2",
    prompt_version: PROMPT_VERSIONS.image_generation,
    latency: 500,
    success: true,
  });

  const rated = rateGeneration(run.id, 4);
  assert.equal(rated.quality_score, 4);
  assert.ok(rated.rated_at);

  assert.throws(() => rateGeneration(run.id, 0), /1-5/);
  assert.throws(() => rateGeneration(run.id, 6), /1-5/);
  assert.throws(() => rateGeneration("missing-id", 3), /未找到/);
});

test("comparePromptVersions reports average quality by version", () => {
  const v1a = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 1000,
    success: true,
  });
  const v1b = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 1200,
    success: true,
  });
  const v2a = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v2",
    latency: 900,
    success: true,
  });
  const v2b = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v2",
    latency: 1100,
    success: true,
  });

  rateGeneration(v1a.id, 3);
  rateGeneration(v1b.id, 3.5);
  rateGeneration(v2a.id, 4);
  rateGeneration(v2b.id, 4.5);

  const comparison = comparePromptVersions({ task: TASKS.TREND_ANALYSIS });
  assert.equal(comparison.total_runs, 4);
  assert.equal(comparison.versions.length, 2);

  const v1 = comparison.versions.find((item) => item.prompt_version === "trend-v1");
  const v2 = comparison.versions.find((item) => item.prompt_version === "trend-v2");
  assert.equal(v1.avg_quality_score, 3.25);
  assert.equal(v2.avg_quality_score, 4.25);
  assert.equal(v1.rated_count, 2);
  assert.equal(v2.rated_count, 2);
  assert.ok(comparison.improvement);
  assert.equal(comparison.improvement.quality_delta, 1);
  assert.equal(comparison.improvement.improved, true);
});

test("memory store isolates test data without writing disk", () => {
  configureEvaluationStore({ memory: true });
  const run = recordAiRun({
    task: TASKS.IMAGE_GENERATION,
    model: "gpt-image-2",
    prompt_version: "image-v1",
    latency: 10,
    success: false,
  });
  assert.equal(listEvaluationRuns().length, 1);
  assert.equal(findEvaluationRun(run.id).success, false);
  assert.equal(fs.existsSync(tempFile), false);
});

test("estimateTrendAutoQualityScore rewards clean first-pass success", () => {
  assert.equal(
    estimateTrendAutoQualityScore({ generated: 10, modelAttempts: 1, validationFailures: 0 }, true),
    4.5,
  );
  assert.ok(estimateTrendAutoQualityScore({ generated: 10, modelAttempts: 3, validationFailures: 5 }, true) < 4);
  assert.equal(estimateTrendAutoQualityScore({}, false), null);
});

test("recordAiRun ignores quality_score so auto scores cannot pollute human averages", () => {
  const run = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 100,
    success: true,
    quality_score: 5,
  });
  assert.equal(run.quality_score, null);
  assert.equal(findEvaluationRun(run.id).quality_score, null);

  const comparison = comparePromptVersions({ task: TASKS.TREND_ANALYSIS });
  const version = comparison.versions.find((item) => item.prompt_version === "trend-v1");
  assert.equal(version.rated_count, 0);
  assert.equal(version.avg_quality_score, null);
});

test("rateGeneration does not drop concurrent appends", () => {
  const first = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 10,
    success: true,
  });
  rateGeneration(first.id, 4);
  const second = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 20,
    success: true,
  });

  assert.equal(listEvaluationRuns().length, 2);
  assert.equal(findEvaluationRun(first.id).quality_score, 4);
  assert.equal(findEvaluationRun(second.id).quality_score, null);
  assert.ok(fs.existsSync(tempFile));
  assert.ok(fs.existsSync(tempFile.replace(/\.jsonl$/, ".ratings.json")));
});

test("recordAiRun persists nested business context fields", () => {
  const run = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: PROMPT_VERSIONS.trend_analysis,
    latency: 800,
    success: true,
    context: {
      user_id: "42",
      brand_id: "7",
      brand_name: "BabyCare",
      industry: "母婴",
      generation_id: "",
      content_type: "",
      platform: "",
    },
  });

  assert.equal(run.brand_id, "7");
  assert.equal(run.brand_name, "BabyCare");
  assert.equal(run.industry, "母婴");
  assert.equal(run.context.industry, "母婴");

  const loaded = findEvaluationRun(run.id);
  assert.equal(loaded.brand_id, "7");
  assert.equal(loaded.industry, "母婴");
  assert.equal(loaded.context.brand_name, "BabyCare");
});

test("compareByContext answers industry and task quality questions", () => {
  const momTrendA = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 1000,
    success: true,
    context: { industry: "母婴", brand_id: "1", brand_name: "A" },
  });
  const momTrendB = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 1400,
    success: true,
    context: { industry: "母婴", brand_id: "2", brand_name: "B" },
  });
  const foodImageA = recordAiRun({
    task: TASKS.IMAGE_GENERATION,
    model: "img-1",
    prompt_version: "image-v1",
    latency: 2000,
    success: true,
    context: { industry: "食品", brand_id: "3", content_type: "cover", platform: "xiaohongshu" },
  });
  const foodImageB = recordAiRun({
    task: TASKS.IMAGE_GENERATION,
    model: "img-1",
    prompt_version: "image-v1",
    latency: 3000,
    success: false,
    context: { industry: "食品", brand_id: "3", content_type: "cover", platform: "xiaohongshu" },
  });
  recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 500,
    success: true,
    context: { industry: "美妆", brand_id: "9" },
  });

  rateGeneration(momTrendA.id, 4);
  rateGeneration(momTrendB.id, 5);
  rateGeneration(foodImageA.id, 3);

  const momTrends = compareByContext({ industry: "母婴", task: TASKS.TREND_ANALYSIS });
  assert.equal(momTrends.total_runs, 2);
  assert.equal(momTrends.avg_quality_score, 4.5);
  assert.equal(momTrends.avg_latency_ms, 1200);
  assert.equal(momTrends.success_rate, 1);

  const foodImages = compareByContext({ industry: "食品", task: TASKS.IMAGE_GENERATION });
  assert.equal(foodImages.total_runs, 2);
  assert.equal(foodImages.avg_quality_score, 3);
  assert.equal(foodImages.avg_latency_ms, 2500);
  assert.equal(foodImages.success_rate, 0.5);

  const byIndustry = compareByContext({ task: TASKS.TREND_ANALYSIS, groupBy: "industry" });
  assert.ok(Array.isArray(byIndustry.groups));
  const momGroup = byIndustry.groups.find((item) => item.value === "母婴");
  assert.equal(momGroup.avg_quality_score, 4.5);
  assert.equal(byIndustry.best.value, "母婴");
});

test("comparePromptVersions still finds best prompt version and accepts context filters", () => {
  const v1 = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v1",
    latency: 1000,
    success: true,
    context: { industry: "母婴" },
  });
  const v2 = recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v2",
    latency: 900,
    success: true,
    context: { industry: "母婴" },
  });
  recordAiRun({
    task: TASKS.TREND_ANALYSIS,
    model: "m1",
    prompt_version: "trend-v2",
    latency: 800,
    success: true,
    context: { industry: "食品" },
  });

  rateGeneration(v1.id, 3);
  rateGeneration(v2.id, 4.5);

  const comparison = comparePromptVersions({ task: TASKS.TREND_ANALYSIS, industry: "母婴" });
  assert.equal(comparison.total_runs, 2);
  const best = comparison.versions.reduce((acc, item) =>
    (item.avg_quality_score || 0) > (acc.avg_quality_score || 0) ? item : acc,
  );
  assert.equal(best.prompt_version, "trend-v2");
  assert.equal(best.avg_quality_score, 4.5);

  const byVersion = compareByContext({
    task: TASKS.TREND_ANALYSIS,
    industry: "母婴",
    groupBy: "prompt_version",
  });
  assert.equal(byVersion.best.value, "trend-v2");
  assert.equal(byVersion.best.avg_quality_score, 4.5);
});
