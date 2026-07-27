#!/usr/bin/env node
// Build the Vue frontend into a temporary directory, then atomically swap it
// into dist/public. The live directory is never emptied in place: a running
// server keeps serving the old build until the rename completes, and any
// build/typecheck failure leaves the current dist/public untouched.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const DIST_DIR = path.join(ROOT, "dist");
const TARGET_DIR = path.join(DIST_DIR, "public");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main() {
  if (!fs.existsSync(path.join(FRONTEND_DIR, "node_modules"))) {
    console.error("[build-frontend] frontend/node_modules missing. Run: npm --prefix frontend ci");
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const stagingDir = path.join(DIST_DIR, `.public-staging-${process.pid}-${Date.now()}`);

  let staged = false;
  try {
    console.log("[build-frontend] type checking (vue-tsc)...");
    if (!run("npm", ["run", "typecheck"], FRONTEND_DIR)) {
      console.error("[build-frontend] type check failed; dist/public left untouched.");
      process.exit(1);
    }

    console.log(`[build-frontend] building into ${stagingDir} ...`);
    if (!run("npx", ["vite", "build", "--outDir", stagingDir, "--emptyOutDir"], FRONTEND_DIR)) {
      console.error("[build-frontend] vite build failed; dist/public left untouched.");
      process.exit(1);
    }
    staged = true;

    // Sanity guard: all three entries must exist before we swap.
    for (const entry of ["index.html", path.join("app", "index.html"), path.join("admin", "index.html")]) {
      const entryPath = path.join(stagingDir, entry);
      if (!fs.existsSync(entryPath)) {
        console.error(`[build-frontend] missing build entry ${entry}; dist/public left untouched.`);
        process.exit(1);
      }
    }

    // Legacy shared images (logos, landing shots, favicon) live in
    // public/assets and keep their unhashed URLs. Merge them next to the
    // hashed build assets so /assets/* keeps working.
    const legacyAssets = path.join(ROOT, "public", "assets");
    if (fs.existsSync(legacyAssets)) {
      fs.cpSync(legacyAssets, path.join(stagingDir, "assets"), { recursive: true, force: false, errorOnExist: false });
    }

    let backupDir = null;
    if (fs.existsSync(TARGET_DIR)) {
      backupDir = path.join(DIST_DIR, `.public-old-${Date.now()}`);
      fs.renameSync(TARGET_DIR, backupDir);
    }
    try {
      fs.renameSync(stagingDir, TARGET_DIR);
      staged = false;
    } catch (error) {
      // Roll the previous build back so the server keeps a working directory.
      if (backupDir && !fs.existsSync(TARGET_DIR)) {
        fs.renameSync(backupDir, TARGET_DIR);
      }
      throw error;
    }
    if (backupDir) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    console.log(`[build-frontend] done: ${TARGET_DIR}`);
  } finally {
    if (staged) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

main();
