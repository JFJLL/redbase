const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { insertCreditEvent } = require("../src/server/db/repositories/admin-repository");
const { upsertGeneration, findGenerationById, deleteGenerationRowsBatch } = require("../src/server/db/repositories/generation-repository");
const {
  removeGenerationAssetsAndRows,
  removeGenerationsAssets,
  collectGenerationAssets,
} = require("../src/server/assets/generation-deletion-service");
const {
  HISTORY_GENERATION_RETENTION_MS,
  cleanupExpiredGenerationHistory,
  createGenerationHistoryCleanupRunner,
  startGenerationHistoryCleanupScheduler,
  isGenerationExpired,
  parseGenerationCreatedAtMs,
} = require("../src/server/api/history-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
insertUser({
  id: 501,
  name: "Retention Tester",
  phone: "13910000501",
  password: "hash",
  accountType: "customer",
  credits: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function seedGeneration(id, createdAt, payload = {}) {
  upsertGeneration({
    id,
    ownerUserId: 501,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 0,
    brandName: "",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: `generation-${id}`,
    createdAt,
    previewUrl: "",
    summary: "",
    payload,
  });
}

function seedLinkedRows(generationId, suffix = "") {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, generation_context_json, generation_id, created_at_ms
    ) VALUES (?, ?, 'completed', 'mock', ?, ?, ?)
  `).run(`job-${generationId}${suffix}`, 501, JSON.stringify({ sourceGenerationId: generationId }), generationId, Date.now());
  insertCreditEvent({
    id: generationId,
    userId: 501,
    actionType: "moments",
    actionLabel: "生成图片",
    creditDelta: -1,
    creditCost: 1,
    generationId,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { original: true },
  });
}

test("successful asset deletion removes generation and image jobs but preserves audited credit event", async () => {
  const generationId = 7101;
  seedGeneration(generationId, "2026-05-01T00:00:00.000Z", {
    localImage: { provider: "aliyun_oss", objectKey: `redbase/generated-images/users/501/2026/05/${generationId}/gi_${generationId}_main_x.png` },
  });
  seedLinkedRows(generationId);
  const deletedAssets = [];
  const deletedAt = "2026-06-01T00:00:00.000Z";

  const result = await removeGenerationAssetsAndRows(findGenerationById(generationId), {
    storage: { deleteMany: async (assets) => deletedAssets.push(...assets) },
    deletedAt,
    deleteReason: "history_retention_expired",
  });

  const db = getDatabase();
  assert.equal(result.ok, true);
  assert.equal(deletedAssets.length, 1);
  assert.equal(findGenerationById(generationId), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE generation_id = ?").get(generationId).count, 0);
  const credit = db.prepare("SELECT generation_id, payload_json FROM credit_events WHERE id = ?").get(generationId);
  assert.ok(credit);
  assert.equal(credit.generation_id, null);
  assert.deepEqual(JSON.parse(credit.payload_json), {
    deletedGenerationId: generationId,
    deletedAt,
    deleteReason: "history_retention_expired",
  });
});

test("non-404 OSS deletion failure preserves generation, image jobs, and credit linkage until retry", async () => {
  const generationId = 7102;
  seedGeneration(generationId, "2026-05-01T00:00:00.000Z", {
    localImage: { provider: "aliyun_oss", objectKey: `redbase/generated-images/users/501/2026/05/${generationId}/gi_${generationId}_main_x.png` },
  });
  seedLinkedRows(generationId);
  const generation = findGenerationById(generationId);

  await assert.rejects(
    removeGenerationAssetsAndRows(generation, {
      storage: { deleteMany: async () => { throw Object.assign(new Error("OSS unavailable"), { status: 500 }); } },
      deleteReason: "history_retention_expired",
    }),
    /OSS unavailable/,
  );
  const db = getDatabase();
  assert.ok(findGenerationById(generationId));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE generation_id = ?").get(generationId).count, 1);
  assert.equal(db.prepare("SELECT generation_id FROM credit_events WHERE id = ?").get(generationId).generation_id, generationId);

  await removeGenerationAssetsAndRows(generation, {
    storage: { deleteMany: async () => [] },
    deleteReason: "history_retention_expired",
  });
  assert.equal(findGenerationById(generationId), null);
});

test("repeated generation deletion is idempotent", async () => {
  const generationId = 7103;
  seedGeneration(generationId, "2026-05-01T00:00:00.000Z", {});
  const generation = findGenerationById(generationId);
  const storage = { deleteMany: async () => [] };
  const first = await removeGenerationAssetsAndRows(generation, { storage });
  const second = await removeGenerationAssetsAndRows(generation, { storage });
  assert.equal(first.alreadyDeleted, false);
  assert.equal(second.alreadyDeleted, true);
});

test("deletion rejects cross-tenant and cross-generation asset references before touching storage", () => {
  assert.throws(() => collectGenerationAssets({
    id: 77,
    ownerUserId: 501,
    payload: {
      localImage: { objectKey: "redbase/generated-images/users/999/2026/07/77/main.png" },
    },
  }), { code: "ASSET_SCOPE_VIOLATION" });
  assert.throws(() => collectGenerationAssets({
    id: 77,
    ownerUserId: 501,
    payload: {
      localImage: { objectKey: "redbase/generated-images/users/501/2026/07/78/gi_77_main_x.png" },
    },
  }), { code: "ASSET_SCOPE_VIOLATION" });
  assert.throws(() => collectGenerationAssets({
    id: 77,
    ownerUserId: 501,
    payload: {
      localImage: { storedPath: "uploads/generated-images/users/501/2026/07/78/main.png" },
    },
  }), { code: "ASSET_SCOPE_VIOLATION" });
});

test("multi-generation asset deletion validates every scope before touching storage", async () => {
  let storageCalled = false;
  const generations = [
    {
      id: 7301,
      ownerUserId: 501,
      payload: { localImage: { objectKey: "redbase/generated-images/users/501/2026/07/7301/gi_7301_main_x.png" } },
    },
    {
      id: 7302,
      ownerUserId: 501,
      payload: { localImage: { objectKey: "redbase/generated-images/users/999/2026/07/7302/gi_7302_main_x.png" } },
    },
  ];
  await assert.rejects(
    removeGenerationsAssets(generations, { storage: { async deleteMany() { storageCalled = true; } } }),
    { code: "ASSET_SCOPE_VIOLATION" },
  );
  assert.equal(storageCalled, false);
});

test("batch generation row deletion rolls back every generation on a later SQL failure", () => {
  const firstId = 7311;
  const secondId = 7312;
  seedGeneration(firstId, "2026-07-29T00:00:00.000Z");
  seedGeneration(secondId, "2026-07-29T00:00:00.000Z");
  const db = getDatabase();
  db.exec(`CREATE TRIGGER reject_second_generation_delete
    BEFORE DELETE ON generations WHEN OLD.id = ${secondId}
    BEGIN SELECT RAISE(ABORT, 'blocked batch deletion'); END`);
  try {
    assert.throws(() => deleteGenerationRowsBatch([
      { generationId: firstId, deleteReason: "test_batch" },
      { generationId: secondId, deleteReason: "test_batch" },
    ]), /blocked batch deletion/);
    assert.ok(findGenerationById(firstId));
    assert.ok(findGenerationById(secondId));
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_second_generation_delete");
  }
});

test("30-day boundary is exact and invalid createdAt never expires", () => {
  const nowMs = Date.parse("2026-07-31T00:00:00.000Z");
  assert.equal(HISTORY_GENERATION_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(isGenerationExpired({ createdAt: "2026-07-01T00:00:01.000Z" }, nowMs), false);
  assert.equal(isGenerationExpired({ createdAt: "2026-07-01T00:00:00.000Z" }, nowMs), true);
  assert.equal(isGenerationExpired({ createdAt: "2026-06-30T00:00:00.000Z" }, nowMs), true);
  assert.equal(isGenerationExpired({ createdAt: "invalid" }, nowMs), false);
  assert.equal(isGenerationExpired({ createdAt: "2026-02-30T00:00:00.000Z" }, nowMs), false);
  assert.equal(isGenerationExpired({ createdAt: "2025-02-29T00:00:00.000Z" }, nowMs), false);
  assert.equal(Number.isFinite(parseGenerationCreatedAtMs("2024-02-29T00:00:00.000Z")), true);
});

test("cleanup deletes exactly-30-day and older rows while retaining fresh and invalid rows", async () => {
  const ids = { fresh: 7201, exact: 7202, old: 7203, invalid: 7204, offset: 7205 };
  seedGeneration(ids.fresh, "2026-07-01T00:00:01.000Z");
  seedGeneration(ids.exact, "2026-07-01T00:00:00.000Z");
  seedGeneration(ids.old, "2026-06-30T00:00:00.000Z");
  seedGeneration(ids.invalid, "not-a-date");
  seedGeneration(ids.offset, "2026-07-01T08:00:00+08:00");
  const result = await cleanupExpiredGenerationHistory({
    nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
    storage: { deleteMany: async () => [] },
  });
  assert.ok(findGenerationById(ids.fresh));
  assert.equal(findGenerationById(ids.exact), null);
  assert.equal(findGenerationById(ids.old), null);
  assert.ok(findGenerationById(ids.invalid));
  assert.equal(findGenerationById(ids.offset), null);
  assert.deepEqual(result.deletedGenerationIds.filter((id) => [ids.exact, ids.old, ids.offset].includes(id)), [ids.old, ids.exact, ids.offset]);
});

test("daily cleanup scheduler unrefs its timer, can be stopped, and concurrent callers share one cleanup", async () => {
  let releaseCleanup;
  const blocked = new Promise((resolve) => { releaseCleanup = resolve; });
  const runner = createGenerationHistoryCleanupRunner({
    storage: { deleteMany: async () => [] },
    cleanupEmptyGeneratedImageDirs: async () => blocked,
  });
  const first = runner({ nowMs: Date.parse("2026-07-31T00:00:00.000Z") });
  const second = runner({ nowMs: Date.parse("2026-07-31T00:00:00.000Z") });
  assert.strictEqual(second, first);
  releaseCleanup();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);

  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  let callback;
  let cleared = null;
  const scheduler = startGenerationHistoryCleanupScheduler({
    runCleanup: async () => ({ deletedCount: 0 }),
    setIntervalFn(fn, intervalMs) {
      callback = fn;
      assert.equal(intervalMs, 24 * 60 * 60 * 1000);
      return timer;
    },
    clearIntervalFn(value) { cleared = value; },
  });
  assert.equal(timer.unrefCalled, true);
  await callback();
  scheduler.stop();
  assert.strictEqual(cleared, timer);
});
