const test = require("node:test");
const assert = require("node:assert/strict");

process.env.REDBASE_DB_FILE = ":memory:";
process.env.PORT = "0";

const { ensureStore } = require("../src/server/store");
const { insertUser } = require("../src/server/db/repositories/auth-repository");
const { upsertGeneration, findGenerationById } = require("../src/server/db/repositories/generation-repository");
const { start } = require("../src/server/index");

test("server startup removes expired generation history before listening", async () => {
  await ensureStore();
  insertUser({
    id: 8801,
    name: "Startup Cleanup",
    phone: "13910008801",
    password: "hash",
    accountType: "customer",
    credits: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  upsertGeneration({
    id: 8801,
    ownerUserId: 8801,
    type: "moments",
    channelLabel: "朋友圈图",
    brandId: 0,
    brandName: "",
    trendId: 0,
    trendTitle: "",
    ideaTitle: "",
    cardTitle: "expired startup generation",
    createdAt: "2020-01-01T00:00:00.000Z",
    previewUrl: "",
    summary: "",
    payload: {},
  });

  const server = await start();
  try {
    assert.equal(findGenerationById(8801), null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
