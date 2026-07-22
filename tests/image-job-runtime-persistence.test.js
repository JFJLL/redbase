const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const {
  createJob,
  getJob,
  updateJob,
  listPendingJobs,
  markFailed,
} = require("../src/server/db/repositories/image-job-runtime-repository");
const {
  IMAGE_JOB_TIMEOUT_MS,
  IMAGE_JOB_TIMEOUT_ERROR,
  createImageJobStore,
  recoverPendingImageJobs,
  resolveImageJob,
} = require("../src/server/ai/image-jobs");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 501,
  name: "Image Job Runtime Tester",
  phone: "13910000501",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-07-22T00:00:00.000Z",
});

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `job_${Math.random().toString(16).slice(2, 10)}`,
    ownerUserId: 501,
    status: "pending",
    provider: "wavespeed",
    providerMode: "text-to-image",
    providerResultUrl: "https://example.com/result/abc",
    model: "test-model",
    metadata: {
      providerTaskId: "upstream-1",
      prompt: "a product photo",
      title: "测试图",
    },
    generationContext: {
      type: "moments",
      userId: 501,
      brandId: 1,
    },
    imageUrl: "",
    error: "",
    generationId: null,
    createdAt: now,
    evaluationStartedAt: now,
    evaluationRunId: "",
    ...overrides,
  };
}

test("createJob/getJob/updateJob persist image job state in SQLite", () => {
  const created = createJob(makeJob({ id: "persist-create-1", status: "pending" }));
  assert.equal(created.id, "persist-create-1");
  assert.equal(created.status, "pending");
  assert.equal(created.providerResultUrl, "https://example.com/result/abc");
  assert.equal(created.metadata.providerTaskId, "upstream-1");

  const loaded = getJob("persist-create-1");
  assert.ok(loaded);
  assert.equal(loaded.ownerUserId, 501);
  assert.equal(loaded.generationContext.type, "moments");

  const updated = updateJob({
    ...loaded,
    status: "running",
  });
  assert.equal(updated.status, "running");
  assert.equal(getJob("persist-create-1").status, "running");

  const completed = updateJob({
    ...updated,
    status: "completed",
    imageUrl: "https://cdn.example.com/out.png",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.imageUrl, "https://cdn.example.com/out.png");
  assert.ok(completed.completedAt);
});

test("listPendingJobs only returns pending and running rows", () => {
  createJob(makeJob({ id: "list-pending-1", status: "pending" }));
  createJob(makeJob({ id: "list-running-1", status: "running" }));
  createJob(makeJob({ id: "list-done-1", status: "completed", imageUrl: "https://x/1.png" }));
  createJob(makeJob({ id: "list-fail-1", status: "failed", error: "boom" }));

  const pending = listPendingJobs({ limit: 200 });
  const ids = new Set(pending.map((job) => job.id));
  assert.equal(ids.has("list-pending-1"), true);
  assert.equal(ids.has("list-running-1"), true);
  assert.equal(ids.has("list-done-1"), false);
  assert.equal(ids.has("list-fail-1"), false);
});

test("markFailed sets status=failed and error=timeout", () => {
  createJob(makeJob({ id: "mark-fail-1", status: "pending" }));
  const failed = markFailed("mark-fail-1", IMAGE_JOB_TIMEOUT_ERROR);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "timeout");

  const again = markFailed("mark-fail-1", "other");
  assert.equal(again.status, "failed");
  assert.equal(again.error, "timeout", "terminal jobs are not overwritten");
});

test("imageJobs facade survives process-local store replacement (restart simulation)", () => {
  const storeA = createImageJobStore();
  const job = makeJob({ id: "restart-job-1", status: "pending" });
  storeA.set(job.id, job);

  const storeB = createImageJobStore();
  const restored = storeB.get("restart-job-1");
  assert.ok(restored, "job must remain queryable after restart");
  assert.equal(restored.status, "pending");
  assert.equal(restored.providerResultUrl, "https://example.com/result/abc");
  assert.equal(restored.metadata.providerTaskId, "upstream-1");
});

test("recoverPendingImageJobs marks jobs older than 10 minutes as failed/timeout", () => {
  const staleCreatedAt = Date.now() - IMAGE_JOB_TIMEOUT_MS - 1_000;
  createJob(makeJob({ id: "recover-stale-1", status: "pending", createdAt: staleCreatedAt }));
  createJob(makeJob({ id: "recover-fresh-1", status: "pending", createdAt: Date.now() }));

  const result = recoverPendingImageJobs({ force: true });
  assert.ok(result.scanned >= 2);
  assert.ok(result.timedOut >= 1);

  const stale = getJob("recover-stale-1");
  const fresh = getJob("recover-fresh-1");
  assert.equal(stale.status, "failed");
  assert.equal(stale.error, "timeout");
  assert.equal(fresh.status, "pending");
});

test("resolveImageJob reloads from SQLite and times out stale jobs without Map", async () => {
  const staleCreatedAt = Date.now() - IMAGE_JOB_TIMEOUT_MS - 5_000;
  createJob(
    makeJob({
      id: "resolve-timeout-1",
      status: "pending",
      createdAt: staleCreatedAt,
      providerResultUrl: "https://example.com/result/timeout",
    }),
  );

  const appConfig = {
    imageProvider: {
      provider: "wavespeed",
      apiKey: "test-key",
      baseUrl: "https://example.com/generate",
    },
  };

  const resolved = await resolveImageJob(appConfig, { id: "resolve-timeout-1" });
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.error, "timeout");
  assert.equal(getJob("resolve-timeout-1").status, "failed");
});
