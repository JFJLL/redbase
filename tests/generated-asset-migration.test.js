const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferMimeType,
  inferVariant,
  replaceLocalAssets,
  parseArgs,
} = require("../scripts/migrate-generated-assets-to-oss.cjs");

test("migration infers legacy asset metadata without exposing configuration", () => {
  const asset = {
    storedPath: "uploads/generated-images/users/9/2026/07/42/gi_42_clip_1_abcdef0123456789.mp4",
  };
  assert.equal(inferMimeType(asset), "video/mp4");
  assert.equal(inferVariant(asset, 42), "clip_1");
});

test("migration replaces every duplicate local reference and preserves user-facing fields", () => {
  const storedPath = "uploads/generated-images/users/9/2026/07/42/gi_42_main_abcdef0123456789.png";
  const payload = {
    main: { storedPath, variant: "main", mimeType: "image/png", imageUrl: "/api/generated-images/42/file" },
    slides: [{ storedPath, title: "封面" }],
  };
  const replacements = new Map([[storedPath, {
    provider: "aliyun_oss",
    objectKey: "redbase/generated-images/users/9/2026/08/42/new.png",
    storedPath: "",
    variant: "main",
    mimeType: "image/png",
    sizeBytes: 123,
    createdAt: "2026-08-31T00:00:00.000Z",
  }]]);
  const result = replaceLocalAssets(payload, replacements);
  assert.equal(result.main.provider, "aliyun_oss");
  assert.equal(result.main.storedPath, "");
  assert.equal(result.main.imageUrl, "/api/generated-images/42/file");
  assert.equal(result.slides[0].objectKey, replacements.get(storedPath).objectKey);
  assert.equal(result.slides[0].title, "封面");
  assert.equal(payload.main.provider, undefined, "source payload must not be mutated");
});

test("migration is dry-run by default and requires explicit apply", () => {
  const dryRun = parseArgs(["--project-dir", process.cwd()]);
  const apply = parseArgs(["--apply", "--project-dir", process.cwd()]);
  assert.equal(dryRun.apply, false);
  assert.equal(apply.apply, true);
});
