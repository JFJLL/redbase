const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession, findUserById } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, updateBrand, findBrandById } = require("../../src/server/db/repositories/brand-repository");
const { upsertGeneration, findGenerationById } = require("../../src/server/db/repositories/generation-repository");
const { handleAdminRoutes } = require("../../src/server/api/admin-routes");
const { handleBrandRoutes } = require("../../src/server/api/brand-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({ id: 901, name: "Admin", phone: "13910000901", password: "hash", accountType: "admin", credits: 10, createdAt: "2026-01-01T00:00:00.000Z" });
insertUser({ id: 902, name: "Owner", phone: "13910000902", password: "hash", accountType: "customer", credits: 10, createdAt: "2026-01-01T00:00:00.000Z" });
insertSession({ token: "admin-delete-token", userId: 901, createdAt: "2026-01-01T00:00:00.000Z" });
insertSession({ token: "owner-delete-token", userId: 902, createdAt: "2026-01-01T00:00:00.000Z" });
insertBrand({
  id: 990,
  ownerUserId: 902,
  name: "Deletion Brand",
  industry: "Test",
  audience: "Test",
  description: "Test",
  product: "Test",
  goal: "Test",
  knowledgeBase: "",
});

function seedGeneration(id) {
  upsertGeneration({
    id,
    ownerUserId: 902,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 990,
    brandName: "Deletion Brand",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: `delete-${id}`,
    createdAt: "2026-07-29T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: { localImage: { provider: "aliyun_oss", objectKey: `redbase/generated-images/users/902/2026/07/${id}/gi_${id}_main_x.png` } },
  });
}

function createReq(url, method, token) {
  return { method, url, headers: { host: "localhost:3013", cookie: `redbase_session=${token}` } };
}

function createRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(data) { this.body = data ? JSON.parse(data) : null; },
  };
}

const appConfig = {
  admin: { phones: ["13910000901"] },
  security: { assetSigningSecret: "test-secret" },
};

test("admin generation deletion keeps rows when generated asset deletion fails", async () => {
  seedGeneration(9911);
  let called = 0;
  const res = createRes();
  await handleAdminRoutes({
    appConfig,
    removeGenerationAssetsAndRows: async () => {
      called += 1;
      throw Object.assign(new Error("OSS unavailable"), { status: 500 });
    },
  }, createReq("/api/admin/generations/9911", "DELETE", "admin-delete-token"), res, "/api/admin/generations/9911");
  assert.equal(res.statusCode, 503);
  assert.equal(called, 1);
  assert.ok(findGenerationById(9911));
});

test("brand deletion keeps brand and generation when generated asset deletion fails", async () => {
  seedGeneration(9912);
  seedGeneration(9914);
  const res = createRes();
  let batchCalled = 0;
  await handleBrandRoutes({
    appConfig,
    collectBody: async () => ({ deleteGenerations: true }),
    removeGenerationsAssets: async () => {
      batchCalled += 1;
      throw Object.assign(new Error("OSS unavailable"), { status: 500 });
    },
  }, createReq("/api/brands/990", "DELETE", "owner-delete-token"), res, "/api/brands/990");
  assert.equal(res.statusCode, 503);
  assert.equal(batchCalled, 1);
  assert.ok(findBrandById(990));
  assert.ok(findGenerationById(9912));
  assert.ok(findGenerationById(9914));
});

test("brand logo removal failure preserves brand and every generation row", async () => {
  seedGeneration(9915);
  updateBrand({ ...findBrandById(990), logo: { storedPath: "uploads/brand-logos/blocked.png" } });
  const res = createRes();
  let assetsDeleted = 0;
  try {
    await handleBrandRoutes({
      appConfig,
      collectBody: async () => ({ deleteGenerations: true }),
      removeGenerationsAssets: async () => { assetsDeleted += 1; return { ok: true }; },
      resolveStoredAssetPath: (storedPath) => storedPath,
      fsp: { rename: async () => { throw Object.assign(new Error("logo locked"), { code: "EACCES" }); } },
    }, createReq("/api/brands/990", "DELETE", "owner-delete-token"), res, "/api/brands/990");
    assert.equal(res.statusCode, 503);
    assert.equal(assetsDeleted, 0);
    assert.ok(findBrandById(990));
    assert.ok(findGenerationById(9915));
  } finally {
    updateBrand({ ...findBrandById(990), logo: null });
  }
});

test("brand database failure restores the staged logo and rolls back generation rows", async () => {
  const generationId = 9916;
  seedGeneration(generationId);
  updateBrand({ ...findBrandById(990), logo: { storedPath: "uploads/brand-logos/live.png" } });
  const renames = [];
  const db = getDatabase();
  db.exec(`CREATE TRIGGER reject_brand_generation_delete
    BEFORE DELETE ON generations WHEN OLD.id = ${generationId}
    BEGIN SELECT RAISE(ABORT, 'brand transaction blocked'); END`);
  try {
    await assert.rejects(handleBrandRoutes({
      appConfig,
      collectBody: async () => ({ deleteGenerations: true }),
      removeGenerationsAssets: async () => ({ ok: true }),
      resolveStoredAssetPath: (storedPath) => storedPath,
      fsp: { rename: async (from, to) => { renames.push([from, to]); } },
    }, createReq("/api/brands/990", "DELETE", "owner-delete-token"), createRes(), "/api/brands/990"), /brand transaction blocked/);
    assert.equal(renames.length, 2);
    assert.equal(renames[1][0], renames[0][1]);
    assert.equal(renames[1][1], renames[0][0]);
    assert.ok(findBrandById(990));
    assert.ok(findGenerationById(generationId));
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_brand_generation_delete");
    updateBrand({ ...findBrandById(990), logo: null });
  }
});

test("admin user deletion keeps the user when generated asset deletion fails", async () => {
  seedGeneration(9913);
  const res = createRes();
  await handleAdminRoutes({
    appConfig,
    removeGenerationsAssets: async () => { throw Object.assign(new Error("OSS unavailable"), { status: 500 }); },
  }, createReq("/api/admin/users/902", "DELETE", "admin-delete-token"), res, "/api/admin/users/902");
  assert.equal(res.statusCode, 503);
  assert.ok(findUserById(902));
  assert.ok(findGenerationById(9913));
});
