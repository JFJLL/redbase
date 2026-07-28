const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Directory-switch logic of the frontend release pipeline. The vite build
// itself is not run here: verifyEntries/finalizeStage/promoteCandidate/
// rollbackToBackup accept injectable paths, so everything is exercised on
// pre-built fake directories.
const {
  verifyEntries,
  finalizeStage,
  promoteCandidate,
  rollbackToBackup,
} = require("../scripts/build-frontend.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUDGET_SCRIPT = path.join(REPO_ROOT, "scripts", "check-asset-budget.cjs");

function makeTempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redbase-release-"));
}

// A fake build output with the three mandatory entries plus one hashed asset.
function makeCandidate(base, name, marker) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.mkdirSync(path.join(dir, "admin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<html>${marker}-landing</html>`);
  fs.writeFileSync(path.join(dir, "app", "index.html"), `<html>${marker}-app</html>`);
  fs.writeFileSync(path.join(dir, "admin", "index.html"), `<html>${marker}-admin</html>`);
  fs.writeFileSync(path.join(dir, "assets", `chunk-${marker}Ab12Cd34.js`), `console.log("${marker}");`);
  return dir;
}

// Deterministic digest over relative paths + contents of a directory tree.
function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        walk(full);
      } else {
        hash.update(`file:${rel}\n`);
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

test("verifyEntries: passes on a complete candidate, names the missing entry otherwise", () => {
  const base = makeTempBase();
  const good = makeCandidate(base, "good", "ok");
  assert.doesNotThrow(() => verifyEntries(good));

  fs.rmSync(path.join(good, "admin", "index.html"));
  assert.throws(() => verifyEntries(good), /admin[\\/]index\.html/);
});

test("finalizeStage merges legacy assets into the candidate without touching the live dir", () => {
  const base = makeTempBase();
  // Fake repo root: public/assets carries fixed-name files, dist/public is live.
  const rootDir = path.join(base, "root");
  fs.mkdirSync(path.join(rootDir, "public", "assets"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "public", "assets", "qrcode.png"), "legacy-qrcode");
  const liveDir = makeCandidate(path.join(rootDir, "dist"), "public", "live");
  const liveBefore = hashTree(liveDir);

  const candidate = makeCandidate(base, "candidate", "new");
  finalizeStage(candidate, { rootDir });

  // Candidate gained the legacy asset next to its hashed build assets...
  assert.equal(fs.readFileSync(path.join(candidate, "assets", "qrcode.png"), "utf8"), "legacy-qrcode");
  assert.ok(fs.existsSync(path.join(candidate, "assets", "chunk-newAb12Cd34.js")));
  // ...and the live dist/public digest is bit-for-bit unchanged.
  assert.equal(hashTree(liveDir), liveBefore);
});

test("finalizeStage rejects a candidate with missing entries and leaves the live dir alone", () => {
  const base = makeTempBase();
  const rootDir = path.join(base, "root");
  fs.mkdirSync(rootDir, { recursive: true });
  const liveDir = makeCandidate(path.join(rootDir, "dist"), "public", "live");
  const liveBefore = hashTree(liveDir);

  const broken = makeCandidate(base, "broken", "bad");
  fs.rmSync(path.join(broken, "app", "index.html"));
  assert.throws(() => finalizeStage(broken, { rootDir }), /missing build entries/);
  assert.equal(hashTree(liveDir), liveBefore);
});

test("promoteCandidate: backup keeps the old build, target becomes the candidate", () => {
  const base = makeTempBase();
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  const oldLive = makeCandidate(distDir, "public", "old");
  const oldDigest = hashTree(oldLive);
  const candidate = makeCandidate(base, "candidate", "new");
  const candidateDigest = hashTree(candidate);
  const backupDir = path.join(distDir, ".public-previous");

  const result = promoteCandidate(candidate, { distDir, targetDir, backupDir });

  assert.equal(result.backupDir, backupDir);
  assert.ok(fs.existsSync(backupDir), "backup directory must exist after promote");
  assert.equal(hashTree(backupDir), oldDigest, "backup preserves the previous build");
  assert.equal(hashTree(targetDir), candidateDigest, "target now serves the candidate");
  assert.ok(!fs.existsSync(candidate), "candidate directory was renamed away");
});

test("rollbackToBackup: restores the previous build and moves the bad one aside", () => {
  const base = makeTempBase();
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  makeCandidate(distDir, "public", "old");
  const oldDigest = hashTree(targetDir);
  const candidate = makeCandidate(base, "candidate", "new");
  const newDigest = hashTree(candidate);
  const backupDir = path.join(distDir, ".public-previous");

  promoteCandidate(candidate, { distDir, targetDir, backupDir });
  assert.equal(hashTree(targetDir), newDigest);

  const rolled = rollbackToBackup(backupDir, { distDir, targetDir });
  assert.equal(hashTree(targetDir), oldDigest, "target restored to the previous build");
  assert.ok(!fs.existsSync(backupDir), "backup was renamed back to the target");
  assert.ok(rolled.movedAsideDir && fs.existsSync(rolled.movedAsideDir), "rejected build kept aside for inspection");
  assert.equal(hashTree(rolled.movedAsideDir), newDigest);
});

test("promoteCandidate: incomplete candidate is rejected before anything moves", () => {
  const base = makeTempBase();
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  makeCandidate(distDir, "public", "old");
  const liveBefore = hashTree(targetDir);

  const broken = makeCandidate(base, "broken", "bad");
  fs.rmSync(path.join(broken, "index.html"));

  assert.throws(() => promoteCandidate(broken, { distDir, targetDir }), /missing build entries/);
  assert.equal(hashTree(targetDir), liveBefore, "live target untouched after a rejected promote");
  assert.ok(fs.existsSync(broken), "rejected candidate stays where it was");
  assert.ok(!fs.existsSync(path.join(distDir, ".public-previous")), "no backup created for a rejected promote");
});

test("promoteCandidate refuses a missing candidate and the target itself", () => {
  const base = makeTempBase();
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  makeCandidate(distDir, "public", "old");
  const liveBefore = hashTree(targetDir);

  assert.throws(() => promoteCandidate(path.join(base, "nope"), { distDir, targetDir }), /does not exist/);
  assert.throws(() => promoteCandidate(targetDir, { distDir, targetDir }), /must not be the live target/);
  assert.equal(hashTree(targetDir), liveBefore);
});

test("rollbackToBackup refuses a missing backup and leaves the target alone", () => {
  const base = makeTempBase();
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  makeCandidate(distDir, "public", "old");
  const liveBefore = hashTree(targetDir);

  assert.throws(() => rollbackToBackup(path.join(distDir, ".public-previous"), { distDir, targetDir }), /does not exist/);
  assert.equal(hashTree(targetDir), liveBefore);
});

test("budget script: --dir pointing at a directory without a manifest exits non-zero", () => {
  const base = makeTempBase();
  const emptyDir = path.join(base, "no-manifest");
  fs.mkdirSync(emptyDir, { recursive: true });

  const result = spawnSync(process.execPath, [BUDGET_SCRIPT, "--dir", emptyDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "missing manifest must fail the budget check");
  assert.match(result.stderr, /missing .*manifest\.json/);
});

test("budget script: --dir without a value and unknown flags exit non-zero", () => {
  const noValue = spawnSync(process.execPath, [BUDGET_SCRIPT, "--dir"], { encoding: "utf8" });
  assert.notEqual(noValue.status, 0);

  const unknown = spawnSync(process.execPath, [BUDGET_SCRIPT, "--nope"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
});
