const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { DATA_DIR } = require("../src/server/config");
const { cleanupEmptyGeneratedImageDirs, removeGenerationLocalFiles } = require("../src/server/assets/image-store");

test("removeGenerationLocalFiles prunes empty generated image directories", async () => {
  const ownerUserId = 990001;
  const monthDir = path.join(DATA_DIR, "uploads", "generated-images", "users", String(ownerUserId), "2026", "04");
  const filePath = path.join(monthDir, "expired.png");
  const userRoot = path.join(DATA_DIR, "uploads", "generated-images", "users", String(ownerUserId));

  await fsp.mkdir(monthDir, { recursive: true });
  await fsp.writeFile(filePath, "expired");

  await removeGenerationLocalFiles({
    id: 10001,
    ownerUserId,
    payload: {
      localImage: {
        storedPath: path.join("uploads", "generated-images", "users", String(ownerUserId), "2026", "04", "expired.png"),
      },
    },
  });

  await assert.rejects(() => fsp.stat(filePath), { code: "ENOENT" });
  await assert.rejects(() => fsp.stat(monthDir), { code: "ENOENT" });
  await assert.rejects(() => fsp.stat(path.dirname(monthDir)), { code: "ENOENT" });
  await fsp.rm(userRoot, { recursive: true, force: true });
});

test("cleanupEmptyGeneratedImageDirs removes existing empty generated image folders", async () => {
  const ownerUserId = 990002;
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-generated-cleanup-"));
  const userRoot = path.join(tempRoot, "users", String(ownerUserId));
  const monthDir = path.join(userRoot, "2026", "04");

  try {
    await fsp.mkdir(monthDir, { recursive: true });

    const result = await cleanupEmptyGeneratedImageDirs(userRoot);

    await assert.rejects(() => fsp.stat(monthDir), { code: "ENOENT" });
    await assert.rejects(() => fsp.stat(path.dirname(monthDir)), { code: "ENOENT" });
    assert.equal(result.deletedCount >= 2, true);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
