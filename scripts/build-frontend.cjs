#!/usr/bin/env node
// Build the Vue frontend into a candidate directory, then atomically swap it
// into dist/public. The live directory is never emptied in place: a running
// server keeps serving the old build until the rename completes, and any
// build/typecheck failure leaves the current dist/public untouched.
//
// Modes:
//   (no args)               typecheck + vite build + entry check + legacy
//                           assets merge + atomic swap into dist/public
//                           (historic behavior, backup removed on success).
//   --stage-dir <dir>       same build pipeline but stop at the candidate
//                           directory; dist/public is never touched.
//   --promote <dir>         verify the candidate's three entries, keep the
//                           current dist/public as dist/.public-previous and
//                           atomically rename the candidate to dist/public.
//   --rollback <dir>        move the current dist/public aside and restore
//                           the given backup directory as dist/public.
//
// The directory-switch logic (verify/merge/promote/rollback) is exported with
// injectable paths so backend tests can exercise it without running vite.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DIST_DIR = path.join(ROOT, "dist");
const TARGET_DIR = path.join(DIST_DIR, "public");
const DEFAULT_BACKUP_DIR = path.join(DIST_DIR, ".public-previous");

const ENTRY_FILES = ["index.html", path.join("app", "index.html"), path.join("admin", "index.html")];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

// All three build entries must exist before a directory may become (or
// replace) dist/public. Throws with the missing entry names otherwise.
function verifyEntries(dir) {
  const missing = ENTRY_FILES.filter((entry) => !fs.existsSync(path.join(dir, entry)));
  if (missing.length > 0) {
    throw new Error(`missing build entries in ${dir}: ${missing.join(", ")}`);
  }
}

// Legacy shared images (logos, landing shots, favicon) live in
// public/assets and keep their unhashed URLs. Merge them next to the
// hashed build assets so /assets/* keeps working.
function mergeLegacyAssets(stagingDir, rootDir = ROOT) {
  const legacyAssets = path.join(rootDir, "public", "assets");
  if (fs.existsSync(legacyAssets)) {
    fs.cpSync(legacyAssets, path.join(stagingDir, "assets"), { recursive: true, force: false, errorOnExist: false });
  }
}

// Post-build candidate finalization: entry sanity check + legacy asset merge.
// Pure directory work — no vite — so tests can call it on fake directories.
function finalizeStage(stagingDir, { rootDir = ROOT } = {}) {
  verifyEntries(stagingDir);
  mergeLegacyAssets(stagingDir, rootDir);
}

// Atomically publish a verified candidate directory as the live target.
// The previous live directory is renamed to backupDir (stale backups are
// discarded first) so a later rollback can restore it. If the final rename
// fails the previous directory is put back, so the target is never missing.
function promoteCandidate(candidateDir, { distDir = DIST_DIR, targetDir = TARGET_DIR, backupDir = null } = {}) {
  const resolvedCandidate = path.resolve(candidateDir);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedCandidate === resolvedTarget) {
    throw new Error("candidate directory must not be the live target directory");
  }
  if (!fs.existsSync(resolvedCandidate)) {
    throw new Error(`candidate directory does not exist: ${resolvedCandidate}`);
  }
  verifyEntries(resolvedCandidate);

  const resolvedBackup = path.resolve(backupDir || path.join(distDir, ".public-previous"));
  fs.mkdirSync(distDir, { recursive: true });

  let backedUp = null;
  if (fs.existsSync(resolvedTarget)) {
    if (fs.existsSync(resolvedBackup)) {
      fs.rmSync(resolvedBackup, { recursive: true, force: true });
    }
    fs.renameSync(resolvedTarget, resolvedBackup);
    backedUp = resolvedBackup;
  }
  try {
    fs.renameSync(resolvedCandidate, resolvedTarget);
  } catch (error) {
    // Roll the previous build back so the server keeps a working directory.
    if (backedUp && !fs.existsSync(resolvedTarget)) {
      fs.renameSync(backedUp, resolvedTarget);
      backedUp = null;
    }
    throw error;
  }
  return { backupDir: backedUp, targetDir: resolvedTarget };
}

// Restore a backup directory as the live target. The broken current target
// is moved aside (kept for inspection) instead of deleted; if restoring the
// backup fails, the moved directory is put back so the target never vanishes.
function rollbackToBackup(backupDir, { distDir = DIST_DIR, targetDir = TARGET_DIR } = {}) {
  const resolvedBackup = path.resolve(backupDir);
  const resolvedTarget = path.resolve(targetDir);
  if (!fs.existsSync(resolvedBackup)) {
    throw new Error(`backup directory does not exist: ${resolvedBackup}`);
  }
  if (resolvedBackup === resolvedTarget) {
    throw new Error("backup directory must not be the live target directory");
  }

  let movedAsideDir = null;
  if (fs.existsSync(resolvedTarget)) {
    movedAsideDir = path.join(distDir, `.public-rolledback-${process.pid}-${Date.now()}`);
    fs.renameSync(resolvedTarget, movedAsideDir);
  }
  try {
    fs.renameSync(resolvedBackup, resolvedTarget);
  } catch (error) {
    if (movedAsideDir && !fs.existsSync(resolvedTarget)) {
      fs.renameSync(movedAsideDir, resolvedTarget);
      movedAsideDir = null;
    }
    throw error;
  }
  return { targetDir: resolvedTarget, movedAsideDir };
}

// typecheck + vite build + entry check + legacy assets merge into stageDir.
// Never touches dist/public; a failed build removes the partial stageDir.
function buildIntoStage(stageDir) {
  const resolvedStage = path.resolve(stageDir);
  if (resolvedStage === TARGET_DIR || resolvedStage.startsWith(TARGET_DIR + path.sep)) {
    console.error("[build-frontend] stage directory must not be dist/public or inside it.");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(FRONTEND_DIR, "node_modules"))) {
    console.error("[build-frontend] frontend/node_modules missing. Run: npm --prefix frontend ci");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(resolvedStage), { recursive: true });

  let ok = false;
  try {
    console.log("[build-frontend] type checking (vue-tsc)...");
    if (!run("npm", ["run", "typecheck"], FRONTEND_DIR)) {
      console.error("[build-frontend] type check failed; dist/public left untouched.");
      process.exit(1);
    }

    console.log(`[build-frontend] building into ${resolvedStage} ...`);
    if (!run("npx", ["vite", "build", "--outDir", resolvedStage, "--emptyOutDir"], FRONTEND_DIR)) {
      console.error("[build-frontend] vite build failed; dist/public left untouched.");
      process.exit(1);
    }

    finalizeStage(resolvedStage);
    ok = true;
    return resolvedStage;
  } finally {
    // Never leave a half-built candidate around on any failure path.
    if (!ok && fs.existsSync(resolvedStage)) {
      fs.rmSync(resolvedStage, { recursive: true, force: true });
    }
  }
}

function runStageMode(stageDir) {
  const resolvedStage = buildIntoStage(stageDir);
  console.log(`[build-frontend] candidate ready (dist/public untouched): ${resolvedStage}`);
}

function runPromoteMode(candidateDir) {
  const { backupDir, targetDir } = promoteCandidate(candidateDir, { backupDir: DEFAULT_BACKUP_DIR });
  if (backupDir) {
    console.log(`[build-frontend] previous build saved for rollback: ${backupDir}`);
  } else {
    console.log("[build-frontend] no previous dist/public existed; nothing to back up.");
  }
  console.log(`[build-frontend] promoted: ${targetDir}`);
}

function runRollbackMode(backupDir) {
  const { targetDir, movedAsideDir } = rollbackToBackup(backupDir);
  if (movedAsideDir) {
    console.log(`[build-frontend] rejected build moved aside: ${movedAsideDir}`);
  }
  console.log(`[build-frontend] rollback complete: ${targetDir}`);
}

// Historic default: build into an internal staging dir, then swap it into
// dist/public and discard the transient backup on success.
function runDefaultMode() {
  const stagingDir = path.join(DIST_DIR, `.public-staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  buildIntoStage(stagingDir);
  const transientBackup = path.join(DIST_DIR, `.public-old-${Date.now()}`);
  try {
    const { backupDir } = promoteCandidate(stagingDir, { backupDir: transientBackup });
    if (backupDir) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } finally {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
  console.log(`[build-frontend] done: ${TARGET_DIR}`);
}

function parseCliMode(argv) {
  if (argv.length === 0) return { mode: "default" };
  const [flag, value, ...rest] = argv;
  const modes = { "--stage-dir": "stage", "--promote": "promote", "--rollback": "rollback" };
  if (!modes[flag] || !value || rest.length > 0) {
    console.error("Usage: node scripts/build-frontend.cjs [--stage-dir <dir> | --promote <dir> | --rollback <dir>]");
    process.exit(2);
  }
  return { mode: modes[flag], dir: value };
}

function main() {
  const { mode, dir } = parseCliMode(process.argv.slice(2));
  try {
    if (mode === "stage") runStageMode(dir);
    else if (mode === "promote") runPromoteMode(dir);
    else if (mode === "rollback") runRollbackMode(dir);
    else runDefaultMode();
  } catch (error) {
    console.error(`[build-frontend] ${mode} failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  verifyEntries,
  mergeLegacyAssets,
  finalizeStage,
  promoteCandidate,
  rollbackToBackup,
};
