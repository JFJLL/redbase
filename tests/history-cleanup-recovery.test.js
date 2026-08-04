const test = require("node:test");
const assert = require("node:assert/strict");

// Isolate from any real Aliyun OSS configuration in config.local.json/.env.
// readEnvOverride honors empty strings, so these force the asset storage
// provider resolved by loadAppConfig() to "local".
process.env.ALIYUN_OSS_ENDPOINT = "";
process.env.ALIYUN_OSS_BUCKET = "";
process.env.ALIYUN_OSS_PREFIX = "";
process.env.ALIYUN_OSS_ACCESS_KEY_ID = "";
process.env.ALIYUN_OSS_ACCESS_KEY_SECRET = "";
process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { upsertGeneration, findGenerationById } = require("../src/server/db/repositories/generation-repository");
const { cleanupExpiredGenerationHistory } = require("../src/server/api/history-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 9901,
  name: "Recovery Tester",
  phone: "13910009901",
  password: "hash",
  accountType: "customer",
  credits: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");

function seedExpiredGeneration(id) {
  upsertGeneration({
    id,
    ownerUserId: 9901,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 0,
    brandName: "",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: `recovery-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: {},
  });
}

function createFailingRecoveryStorage(failStep) {
  return {
    async cleanupDeletionStaging() {
      if (failStep === "cleanupDeletionStaging") {
        throw Object.assign(new Error("OSS unavailable"), { code: "OSS_UNAVAILABLE", status: 503 });
      }
      return { recovered: 0, removed: 0 };
    },
    async cleanupUnreferencedAssets() {
      if (failStep === "cleanupUnreferencedAssets") {
        throw Object.assign(new Error("OSS unavailable"), { code: "OSS_UNAVAILABLE", status: 503 });
      }
      return { removed: 0 };
    },
    async deleteMany() {
      return [];
    },
  };
}

function createWarnCollector() {
  const warnings = [];
  return {
    warnings,
    logger: {
      warn(message, fields) {
        warnings.push({ message, fields });
      },
    },
  };
}

test("cleanupDeletionStaging failure does not block deletion of expired rows", async () => {
  seedExpiredGeneration(99001);
  const collector = createWarnCollector();
  const result = await cleanupExpiredGenerationHistory({
    nowMs: NOW_MS,
    cleanupRecovery: true,
    storage: createFailingRecoveryStorage("cleanupDeletionStaging"),
    logger: collector.logger,
  });
  assert.equal(findGenerationById(99001), null);
  assert.equal(result.deletedGenerationIds.includes(99001), true);
  assert.equal(result.failedGenerationIds.includes(99001), false);
  const recoveryWarning = collector.warnings.find((entry) =>
    String(entry.message).includes("cleanupDeletionStaging"));
  assert.ok(recoveryWarning, "recovery step failure must be logged as a warning");
  assert.equal(recoveryWarning.fields.errorCode, "OSS_UNAVAILABLE");
  assert.equal(recoveryWarning.fields.status, 503);
});

test("cleanupDeletionStaging failure plus row asset deletion failure keeps the expired row", async () => {
  seedExpiredGeneration(99002);
  const collector = createWarnCollector();
  const result = await cleanupExpiredGenerationHistory({
    nowMs: NOW_MS,
    cleanupRecovery: true,
    storage: {
      async cleanupDeletionStaging() {
        throw Object.assign(new Error("OSS unavailable"), { code: "OSS_UNAVAILABLE", status: 503 });
      },
      async deleteMany() {
        throw Object.assign(new Error("OSS delete failed"), { code: "OSS_DELETE_FAILED", status: 500 });
      },
    },
    logger: collector.logger,
  });
  assert.ok(findGenerationById(99002), "row must be retained when its assets cannot be deleted");
  assert.equal(result.failedGenerationIds.includes(99002), true);
  assert.equal(result.deletedGenerationIds.includes(99002), false);
});

test("cleanupUnreferencedAssets failure does not block deletion of expired rows", async () => {
  seedExpiredGeneration(99003);
  const collector = createWarnCollector();
  const result = await cleanupExpiredGenerationHistory({
    nowMs: NOW_MS,
    cleanupRecovery: true,
    storage: createFailingRecoveryStorage("cleanupUnreferencedAssets"),
    logger: collector.logger,
  });
  assert.equal(findGenerationById(99003), null);
  assert.equal(result.deletedGenerationIds.includes(99003), true);
  assert.equal(result.failedGenerationIds.includes(99003), false);
  const recoveryWarning = collector.warnings.find((entry) =>
    String(entry.message).includes("cleanupUnreferencedAssets"));
  assert.ok(recoveryWarning, "recovery step failure must be logged as a warning");
  assert.equal(recoveryWarning.fields.errorCode, "OSS_UNAVAILABLE");
  assert.equal(recoveryWarning.fields.status, 503);
});
