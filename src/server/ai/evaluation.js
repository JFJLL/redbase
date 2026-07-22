/**
 * AI observability & evaluation
 *
 * Records each AI generation run so prompt/model changes can be compared
 * with latency, success rate, and human quality scores (1-5).
 *
 * Storage model (concurrent-safe for generation + rating):
 * - runs: append-only JSONL (never rewritten after append)
 * - ratings: separate JSON map keyed by run id (human scores only)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_STORE_PATH = path.join(ROOT, "data", "ai-evaluation-runs.jsonl");

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

/** Stable prompt version labels - bump when prompts change meaningfully. */
const PROMPT_VERSIONS = Object.freeze({
  trend_analysis: "trend-v1",
  image_generation: "image-v1",
});

const TASKS = Object.freeze({
  TREND_ANALYSIS: "trend_analysis",
  IMAGE_GENERATION: "image_generation",
});

/**
 * @type {{
 *   storePath: string,
 *   memoryRuns: Array<object>|null,
 *   memoryRatings: Record<string, { quality_score: number, rated_at: string }>|null,
 * }}
 */
const storeState = {
  storePath: DEFAULT_STORE_PATH,
  memoryRuns: null,
  memoryRatings: null,
};

function ratingsPathFor(storePath) {
  if (storePath.endsWith(".jsonl")) {
    return `${storePath.slice(0, -".jsonl".length)}.ratings.json`;
  }
  return `${storePath}.ratings.json`;
}

function configureEvaluationStore(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "storePath")) {
    storeState.storePath = options.storePath ? path.resolve(String(options.storePath)) : DEFAULT_STORE_PATH;
  }
  if (Object.prototype.hasOwnProperty.call(options, "memory")) {
    if (options.memory === true) {
      storeState.memoryRuns = [];
      storeState.memoryRatings = {};
    } else if (options.memory === false) {
      storeState.memoryRuns = null;
      storeState.memoryRatings = null;
    } else if (Array.isArray(options.memory)) {
      storeState.memoryRuns = options.memory;
      storeState.memoryRatings = {};
    } else {
      storeState.memoryRuns = null;
      storeState.memoryRatings = null;
    }
  }
  return {
    storePath: storeState.storePath,
    ratingsPath: ratingsPathFor(storeState.storePath),
    memory: storeState.memoryRuns !== null,
  };
}

function resetEvaluationStoreForTests() {
  storeState.storePath = DEFAULT_STORE_PATH;
  storeState.memoryRuns = null;
  storeState.memoryRatings = null;
}

function normalizeRequiredScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    const error = new Error("评分必须是 1-5 的数字");
    error.code = "EVALUATION_INVALID_SCORE";
    throw error;
  }
  return Math.min(5, Math.max(1, Math.round(score * 2) / 2));
}

function normalizeLatency(value) {
  const latency = Number(value);
  if (!Number.isFinite(latency) || latency < 0) return 0;
  return Math.round(latency);
}

/**
 * Normalize a generation run. quality_score is NEVER accepted from recordAiRun input;
 * only rateGeneration may set human scores (merged from the ratings side store).
 */
function normalizeRunRecord(input = {}, rating = null) {
  return {
    id: String(input.id || randomId()),
    task: String(input.task || "").trim(),
    model: String(input.model || "").trim(),
    prompt_version: String(input.prompt_version || "").trim(),
    latency: normalizeLatency(input.latency),
    success: Boolean(input.success),
    quality_score: rating && rating.quality_score != null ? Number(rating.quality_score) : null,
    created_at: String(input.created_at || new Date().toISOString()),
    rated_at: rating && rating.rated_at ? String(rating.rated_at) : "",
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : {},
  };
}

function ensureStoreDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadRatingsMap() {
  if (storeState.memoryRatings && typeof storeState.memoryRatings === "object") {
    return { ...storeState.memoryRatings };
  }

  const filePath = ratingsPathFor(storeState.storePath);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_error) {
    return {};
  }
}

function writeRatingsMap(ratings) {
  if (storeState.memoryRatings && typeof storeState.memoryRatings === "object") {
    for (const key of Object.keys(storeState.memoryRatings)) {
      delete storeState.memoryRatings[key];
    }
    Object.assign(storeState.memoryRatings, ratings);
    return;
  }

  const filePath = ratingsPathFor(storeState.storePath);
  ensureStoreDir(filePath);
  const tempFile = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(ratings, null, 0)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, filePath);
}

function loadRawRuns() {
  if (Array.isArray(storeState.memoryRuns)) {
    return storeState.memoryRuns.map((run) => ({
      ...run,
      metadata: { ...(run.metadata || {}) },
      // strip any inlined score; ratings side-store is authoritative
      quality_score: null,
      rated_at: "",
    }));
  }

  const filePath = storeState.storePath;
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];

  const runs = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        // Ignore any historical quality_score written into the run line.
        runs.push(normalizeRunRecord({ ...parsed, quality_score: null, rated_at: "" }, null));
      }
    } catch (_error) {
      // Skip corrupt lines; evaluation must not break generation paths.
    }
  }
  return runs;
}

function loadAllRuns() {
  const ratings = loadRatingsMap();
  return loadRawRuns().map((run) => normalizeRunRecord(run, ratings[run.id] || null));
}

function appendRun(run) {
  // Persist generation rows without human scores (append-only).
  const persisted = {
    id: run.id,
    task: run.task,
    model: run.model,
    prompt_version: run.prompt_version,
    latency: run.latency,
    success: run.success,
    created_at: run.created_at,
    metadata: run.metadata || {},
  };

  if (Array.isArray(storeState.memoryRuns)) {
    storeState.memoryRuns.push({ ...persisted, metadata: { ...(persisted.metadata || {}) } });
    return;
  }

  const filePath = storeState.storePath;
  ensureStoreDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(persisted)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Persist one AI run for later rating and version comparison.
 * quality_score is always null here; use rateGeneration for human scores.
 * @returns {object} normalized run record (includes id)
 */
function recordAiRun(input = {}) {
  const run = normalizeRunRecord({
    ...input,
    quality_score: null,
    rated_at: "",
  }, null);
  appendRun(run);
  return run;
}

/**
 * Human quality rating for internal testing (1-5).
 * Writes only the ratings side-store so concurrent appends are never rewritten away.
 * @param {string} runId
 * @param {number} score
 */
function rateGeneration(runId, score) {
  const id = String(runId || "").trim();
  if (!id) {
    const error = new Error("缺少 evaluation run id");
    error.code = "EVALUATION_RUN_NOT_FOUND";
    throw error;
  }

  const normalizedScore = normalizeRequiredScore(score);
  const runs = loadRawRuns();
  const existing = runs.find((run) => run.id === id);
  if (!existing) {
    const error = new Error(`未找到 evaluation run: ${id}`);
    error.code = "EVALUATION_RUN_NOT_FOUND";
    throw error;
  }

  const ratings = loadRatingsMap();
  ratings[id] = {
    quality_score: normalizedScore,
    rated_at: new Date().toISOString(),
  };
  writeRatingsMap(ratings);
  return normalizeRunRecord(existing, ratings[id]);
}

function findEvaluationRun(runId) {
  const id = String(runId || "").trim();
  if (!id) return null;
  return loadAllRuns().find((run) => run.id === id) || null;
}

function listEvaluationRuns(filters = {}) {
  let runs = loadAllRuns();
  if (filters.task) {
    const task = String(filters.task);
    runs = runs.filter((run) => run.task === task);
  }
  if (filters.prompt_version) {
    const version = String(filters.prompt_version);
    runs = runs.filter((run) => run.prompt_version === version);
  }
  if (filters.model) {
    const model = String(filters.model);
    runs = runs.filter((run) => run.model === model);
  }
  if (filters.success != null) {
    const success = Boolean(filters.success);
    runs = runs.filter((run) => run.success === success);
  }
  if (filters.ratedOnly) {
    // Human-rated only: requires rated_at from rateGeneration.
    runs = runs.filter((run) => run.quality_score != null && run.rated_at);
  }
  return runs;
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

function buildVersionStats(runs) {
  const ratedScores = runs
    .filter((run) => run.quality_score != null && run.rated_at)
    .map((run) => Number(run.quality_score));
  const latencies = runs.map((run) => Number(run.latency) || 0);
  const successCount = runs.filter((run) => run.success).length;

  return {
    run_count: runs.length,
    rated_count: ratedScores.length,
    success_count: successCount,
    success_rate: runs.length ? Math.round((successCount / runs.length) * 1000) / 1000 : null,
    avg_quality_score: average(ratedScores),
    avg_latency_ms: average(latencies),
    models: [...new Set(runs.map((run) => run.model).filter(Boolean))],
  };
}

/**
 * Compare prompt versions for a task (or all tasks).
 * Averages only human ratings (rateGeneration).
 */
function comparePromptVersions(filters = {}) {
  const runs = listEvaluationRuns({
    task: filters.task,
    model: filters.model,
  });

  const byVersion = new Map();
  for (const run of runs) {
    const key = run.prompt_version || "(unknown)";
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push(run);
  }

  const versions = [...byVersion.entries()]
    .map(([prompt_version, versionRuns]) => ({
      prompt_version,
      task: filters.task || null,
      ...buildVersionStats(versionRuns),
    }))
    .sort((a, b) => String(a.prompt_version).localeCompare(String(b.prompt_version), undefined, { numeric: true }));

  let improvement = null;
  if (filters.baseline && filters.candidate) {
    const baseline = versions.find((item) => item.prompt_version === filters.baseline) || null;
    const candidate = versions.find((item) => item.prompt_version === filters.candidate) || null;
    if (baseline && candidate && baseline.avg_quality_score != null && candidate.avg_quality_score != null) {
      improvement = {
        baseline: filters.baseline,
        candidate: filters.candidate,
        quality_delta: Math.round((candidate.avg_quality_score - baseline.avg_quality_score) * 100) / 100,
        latency_delta_ms:
          baseline.avg_latency_ms != null && candidate.avg_latency_ms != null
            ? Math.round((candidate.avg_latency_ms - baseline.avg_latency_ms) * 100) / 100
            : null,
        improved: candidate.avg_quality_score > baseline.avg_quality_score,
      };
    }
  } else if (versions.length === 2) {
    const [a, b] = versions;
    if (a.avg_quality_score != null && b.avg_quality_score != null) {
      improvement = {
        baseline: a.prompt_version,
        candidate: b.prompt_version,
        quality_delta: Math.round((b.avg_quality_score - a.avg_quality_score) * 100) / 100,
        latency_delta_ms:
          a.avg_latency_ms != null && b.avg_latency_ms != null
            ? Math.round((b.avg_latency_ms - a.avg_latency_ms) * 100) / 100
            : null,
        improved: b.avg_quality_score > a.avg_quality_score,
      };
    }
  }

  return {
    task: filters.task || null,
    total_runs: runs.length,
    versions,
    improvement,
  };
}

/**
 * Coarse automatic quality hint from trend metrics (optional).
 * Does not replace human rateGeneration scores.
 */
function estimateTrendAutoQualityScore(metrics = {}, success = true) {
  if (!success) return null;
  const generated = Number(metrics.generated || metrics.returned || 0);
  const validationFailures = Number(metrics.validationFailures || 0);
  const modelAttempts = Number(metrics.modelAttempts || metrics.modelRequests || 1);
  if (generated <= 0) return null;

  let score = 4;
  if (modelAttempts > 1) score -= Math.min(1.5, (modelAttempts - 1) * 0.5);
  if (validationFailures > 0) score -= Math.min(1, validationFailures * 0.1);
  if (generated >= 10 && modelAttempts === 1 && validationFailures === 0) score = 4.5;
  return Math.min(5, Math.max(1, Math.round(score * 2) / 2));
}

module.exports = {
  TASKS,
  PROMPT_VERSIONS,
  DEFAULT_STORE_PATH,
  configureEvaluationStore,
  resetEvaluationStoreForTests,
  recordAiRun,
  rateGeneration,
  findEvaluationRun,
  listEvaluationRuns,
  comparePromptVersions,
  estimateTrendAutoQualityScore,
  ratingsPathFor,
};
