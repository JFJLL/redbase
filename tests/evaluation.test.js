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
  assert.equal(run.prompt_version, "trend-v1");
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
