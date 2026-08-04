#!/usr/bin/env node
// Full deploy rollback for a failed smoke check. Rolling back ONLY the
// frontend directory while the new backend keeps running is forbidden — the
// sequence always restores frontend artifacts AND server sources AND root
// dependencies, then restarts and re-smokes the OLD version:
//   1. restore dist/public from the backup; on a first deploy (no backup)
//      move the failed dist/public aside so the server falls back to the
//      legacy public/ frontend;
//   2. git checkout --detach <OLD_SHA>  (server sources back to the old
//      commit; non-destructive, requires the clean tree the deploy started
//      from);
//   3. npm ci                            (dependencies of the old commit);
//   4. pm2 restart redbase;
//   5. smoke /api/health, /, /app/, /admin/ against the OLD version.
// Exit codes (CLI): 0 = rollback done and old version healthy;
//                   2 = rollback done but old version still failing.
// The calling deploy script exits non-zero either way.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { rollbackToBackup } = require("./build-frontend.cjs");
const { SMOKE_PATHS, waitForSmoke } = require("./deploy-smoke.cjs");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const TARGET_DIR = path.join(DIST_DIR, "public");

function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1 };
}

async function defaultSmoke(appUrl) {
  return waitForSmoke(appUrl, { label: "[deploy-rollback]" });
}

// Step 1 only: bring the served frontend back to the pre-deploy state.
// Returns "backup" when the previous dist/public build was restored, or
// "legacy-public" on a first deploy where the failed dist/public is moved
// aside so the static layer falls back to the old public/ frontend.
function restoreFrontendArtifacts({ backupDir, distDir = DIST_DIR, targetDir = TARGET_DIR, now = Date.now() } = {}) {
  const resolvedBackup = backupDir ? path.resolve(backupDir) : null;
  if (resolvedBackup && fs.existsSync(resolvedBackup)) {
    const { movedAsideDir } = rollbackToBackup(resolvedBackup, { distDir, targetDir });
    return { mode: "backup", movedAsideDir };
  }
  // First deploy: no previous dist/public existed. Remove the failed new
  // dist (kept aside for inspection) so resolveStaticRoot() serves legacy
  // public/ again.
  const resolvedTarget = path.resolve(targetDir);
  let movedAsideDir = null;
  if (fs.existsSync(resolvedTarget)) {
    movedAsideDir = path.join(path.resolve(distDir), `.public-rejected-${now}`);
    fs.renameSync(resolvedTarget, movedAsideDir);
  }
  return { mode: "legacy-public", movedAsideDir };
}

// Full rollback orchestration with injectable exec/smoke so backend tests can
// verify the exact command sequence without touching git/pm2.
async function runDeployRollback({
  oldSha,
  backupDir,
  distDir = DIST_DIR,
  targetDir = TARGET_DIR,
  appUrl = process.env.REDBASE_BASE_URL || "http://127.0.0.1:3013",
  exec = defaultExec,
  smoke = defaultSmoke,
  now = Date.now(),
} = {}) {
  const sha = String(oldSha || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`deploy rollback requires a valid OLD_SHA, got: ${JSON.stringify(oldSha)}`);
  }

  const steps = [];
  const frontend = restoreFrontendArtifacts({ backupDir, distDir, targetDir, now });
  steps.push({ step: "restore-frontend", mode: frontend.mode });
  console.log(
    frontend.mode === "backup"
      ? "[deploy-rollback] dist/public restored from backup."
      : "[deploy-rollback] first deploy: failed dist/public moved aside, serving legacy public/.",
  );

  // Server sources must go back with the frontend — never keep running the
  // new backend against the old frontend.
  const checkout = exec("git", ["checkout", "--detach", sha]);
  steps.push({ step: "git-checkout", sha, status: checkout.status });
  if (checkout.status !== 0) {
    throw new Error(`git checkout --detach ${sha} failed (status ${checkout.status})`);
  }

  const install = exec("npm", ["ci"]);
  steps.push({ step: "npm-ci", status: install.status });
  if (install.status !== 0) {
    throw new Error(`npm ci for the old commit failed (status ${install.status})`);
  }

  const restart = exec("pm2", ["restart", "redbase"]);
  steps.push({ step: "pm2-restart", status: restart.status });
  if (restart.status !== 0) {
    throw new Error(`pm2 restart failed (status ${restart.status})`);
  }

  const healthy = await smoke(appUrl);
  steps.push({ step: "smoke-old-version", healthy });
  return { mode: frontend.mode, movedAsideDir: frontend.movedAsideDir, healthy, steps };
}

function parseArgs(argv) {
  const args = { oldSha: "", backupDir: "", appUrl: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--old-sha") args.oldSha = argv[++index] || "";
    else if (arg === "--backup") args.backupDir = argv[++index] || "";
    else if (arg === "--app-url") args.appUrl = argv[++index] || "";
    else {
      console.error(`[deploy-rollback] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runDeployRollback({
    oldSha: args.oldSha,
    backupDir: args.backupDir || path.join(DIST_DIR, ".public-previous"),
    appUrl: args.appUrl || undefined,
  });
  if (result.healthy) {
    console.log("[deploy-rollback] old version restored and healthy.");
    process.exit(0);
  }
  console.error("[deploy-rollback] old version restored but smoke checks STILL failing; manual intervention required.");
  process.exit(2);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[deploy-rollback] ${error.message}`);
    process.exit(2);
  });
}

module.exports = {
  restoreFrontendArtifacts,
  runDeployRollback,
  SMOKE_PATHS,
};
