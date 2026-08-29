const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const {
  recordTextTaskAttempt,
  recordImageTaskAttempt,
  recordVideoClipAttempt,
  recordVideoResultProcessingAttempt,
  recordVideoAssemblyAttempt,
} = require("../src/server/analytics/ai-attempt-recorder");
const { createVideoProjectService } = require("../src/server/video/video-project-service");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

test("records text model task attempt with token telemetry", () => {
  const key = "test:text:attempt:1";
  const recorded = recordTextTaskAttempt({
    attemptKey: key,
    feature: "trend_analysis",
    taskType: "trend_generation",
    provider: "deepseek",
    model: "deepseek-chat",
    status: "completed",
    durationMs: 1450,
    firstByteMs: 320,
    inputTokens: 1200,
    outputTokens: 400,
    totalTokens: 1600,
    actorUserId: 10,
  });
  assert.equal(recorded, true);

  const row = db.prepare("SELECT * FROM ai_task_attempts WHERE attempt_key = ?").get(key);
  assert.ok(row);
  assert.equal(row.task_type, "trend_generation");
  assert.equal(row.total_tokens, 1600);
  assert.equal(row.first_byte_ms, 320);
  assert.equal(row.vendor_cost_fen, null, "Vendor cost must be null when unconfigured");
});

test("records video attempts with distinct attempt kinds and stages", () => {
  const projectId = 991;

  // 1. Initial Clip Attempt
  recordVideoClipAttempt({
    projectId,
    clipId: 1,
    clipIndex: 0,
    attemptNo: 1,
    attemptKind: "initial",
    provider: "agnes",
    model: "g2",
    providerKeyRef: "key-ref-1",
    status: "failed",
    errorStage: "provider",
    errorCode: "RATE_LIMIT",
    errorMessage: "Key rate limited",
    startedAt: "2026-08-28T10:00:00.000Z",
    completedAt: "2026-08-28T10:00:05.000Z",
    durationMs: 5000,
  });

  // 2. Auto Retry Clip Attempt (switched key)
  recordVideoClipAttempt({
    projectId,
    clipId: 1,
    clipIndex: 0,
    attemptNo: 2,
    attemptKind: "auto_retry",
    provider: "agnes",
    model: "g2",
    providerKeyRef: "key-ref-2",
    status: "completed",
    startedAt: "2026-08-28T10:00:06.000Z",
    completedAt: "2026-08-28T10:00:20.000Z",
    durationMs: 14000,
  });

  // 3. First result processing is an initial attempt, not a retry.
  recordVideoResultProcessingAttempt({
    projectId,
    clipId: 1,
    clipIndex: 0,
    attemptNo: 1,
    provider: "agnes",
    model: "g2",
    status: "completed",
    startedAt: "2026-08-28T10:00:21.000Z",
    completedAt: "2026-08-28T10:00:23.000Z",
    durationMs: 2000,
  });

  // 4. Video Assembly
  recordVideoAssemblyAttempt({
    projectId,
    attemptNo: 1,
    attemptKind: "assembly_initial",
    status: "completed",
    startedAt: "2026-08-28T10:00:24.000Z",
    completedAt: "2026-08-28T10:00:26.000Z",
    durationMs: 2000,
  });

  const projectAttempts = db.prepare("SELECT attempt_kind, status, provider_key_ref FROM ai_task_attempts WHERE project_id = ? ORDER BY id ASC").all(projectId);
  assert.equal(projectAttempts.length, 4);
  assert.equal(projectAttempts[0].attempt_kind, "initial");
  assert.equal(projectAttempts[0].status, "failed");
  assert.equal(projectAttempts[1].attempt_kind, "auto_retry");
  assert.equal(projectAttempts[1].status, "completed");
  assert.equal(projectAttempts[2].attempt_kind, "initial");
  assert.equal(projectAttempts[3].attempt_kind, "assembly_initial");
});

test("videoProjectService.getRuntimeHealth returns sanitized runtime metrics", () => {
  const service = createVideoProjectService({
    appConfig: {
      video: {
        agnes: { apiKeys: ["test-key-1", "test-key-2"] },
        d2MaxConcurrentSubmissions: 4,
        mediaMaxConcurrency: 3,
        ffmpegMaxConcurrency: 1,
      },
    },
  });

  const health = service.getRuntimeHealth();
  assert.ok(health);
  assert.equal(typeof health.activeProjectCount, "number");
  assert.equal(health.d2Submission.limit, 4);
  assert.equal(health.mediaProcessing.limit, 3);
  assert.equal(health.ffmpeg.limit, 1);
  assert.equal(health.agnes.keyTotal, 2);
  assert.ok(health.actionable);
  // Ensure no API keys leaked in health object
  assert.equal(JSON.stringify(health).includes("test-key"), false);
});
