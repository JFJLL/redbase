#!/usr/bin/env node
// Machine-checkable asset budgets for the built frontend. By default the
// live dist/public is checked; pass `--dir <candidate>` to audit a staged
// candidate directory (its .vite/manifest.json and files) before promotion.
// Budgets are hard limits — raising them is forbidden by the project rules:
//   1. Landing initial JS+CSS (gzip, summed)  <= 100 KB
//   2. Workspace shared initial JS (gzip)     <= 250 KB
//   3. Every business route ships as its own lazy chunk
//   4. Landing must not share any chunk with the workspace/admin apps
//      (module preload polyfill excepted) — i.e. no Vue on the landing page.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");

function parseTargetDir(argv) {
  let dir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") {
      dir = argv[i + 1];
      if (!dir) {
        console.error("[budget] --dir requires a directory argument");
        process.exit(2);
      }
      i += 1;
    } else {
      console.error(`[budget] unknown argument: ${argv[i]} (usage: check-asset-budget.cjs [--dir <dir>])`);
      process.exit(2);
    }
  }
  return dir ? path.resolve(dir) : path.join(ROOT, "dist", "public");
}

const DIST = parseTargetDir(process.argv.slice(2));
const MANIFEST_PATH = path.join(DIST, ".vite", "manifest.json");

const LANDING_BUDGET_BYTES = 100 * 1024;
const APP_SHARED_JS_BUDGET_BYTES = 250 * 1024;
const ROUTE_CHUNKS = [
  "LoginView",
  "RegisterView",
  "BrandsView",
  "PersonalIpView",
  "TrendsView",
  "IdeasView",
  "ExcellentView",
  "HistoryView",
  "AdminDashboardView",
];
const SHARED_ALLOWLIST = /modulepreload-polyfill/;

function fail(message) {
  console.error(`[budget] FAIL: ${message}`);
  process.exitCode = 1;
}

function gzipSize(filePath) {
  return zlib.gzipSync(fs.readFileSync(filePath)).length;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Transitive static import closure of one manifest entry.
function collectStatic(manifest, key, seen = new Set()) {
  if (seen.has(key) || !manifest[key]) return seen;
  seen.add(key);
  for (const dep of manifest[key].imports || []) {
    collectStatic(manifest, dep, seen);
  }
  return seen;
}

function entryFiles(manifest, keys) {
  const js = new Set();
  const css = new Set();
  for (const key of keys) {
    const chunk = manifest[key];
    if (!chunk) continue;
    if (chunk.file && chunk.file.endsWith(".js")) js.add(chunk.file);
    for (const sheet of chunk.css || []) css.add(sheet);
  }
  return { js, css };
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`missing ${path.relative(ROOT, MANIFEST_PATH)} — run npm run build first`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  const landingKeys = collectStatic(manifest, "index.html");
  const appKeys = collectStatic(manifest, "app/index.html");
  const adminKeys = collectStatic(manifest, "admin/index.html");
  if (!landingKeys.size || !appKeys.size || !adminKeys.size) {
    fail("manifest is missing one of the three entries (index.html, app/index.html, admin/index.html)");
    return;
  }

  // 1. Landing initial JS+CSS gzip total.
  const landing = entryFiles(manifest, landingKeys);
  let landingTotal = 0;
  for (const file of [...landing.js, ...landing.css]) {
    landingTotal += gzipSize(path.join(DIST, file));
  }
  console.log(`[budget] landing initial JS+CSS gzip: ${kb(landingTotal)} (limit ${kb(LANDING_BUDGET_BYTES)})`);
  if (landingTotal > LANDING_BUDGET_BYTES) {
    fail(`landing initial payload ${kb(landingTotal)} exceeds ${kb(LANDING_BUDGET_BYTES)}`);
  }

  // 2. Workspace shared initial JS gzip (entry + static imports, JS only).
  const app = entryFiles(manifest, appKeys);
  let appJsTotal = 0;
  for (const file of app.js) {
    appJsTotal += gzipSize(path.join(DIST, file));
  }
  console.log(`[budget] workspace shared initial JS gzip: ${kb(appJsTotal)} (limit ${kb(APP_SHARED_JS_BUDGET_BYTES)})`);
  if (appJsTotal > APP_SHARED_JS_BUDGET_BYTES) {
    fail(`workspace shared initial JS ${kb(appJsTotal)} exceeds ${kb(APP_SHARED_JS_BUDGET_BYTES)}`);
  }

  // 3. Every business route must be its own lazy chunk, absent from the
  //    static import closure of any entry.
  const staticFiles = new Set();
  for (const key of [...landingKeys, ...appKeys, ...adminKeys]) {
    const chunk = manifest[key];
    if (chunk?.file) staticFiles.add(chunk.file);
  }
  for (const routeName of ROUTE_CHUNKS) {
    const key = Object.keys(manifest).find((entry) => manifest[entry].name === routeName || entry.includes(`${routeName}.vue`));
    if (!key) {
      fail(`route chunk ${routeName} not found in manifest — view must stay a dynamic import`);
      continue;
    }
    const file = manifest[key].file;
    if (staticFiles.has(file)) {
      fail(`route chunk ${routeName} (${file}) is statically imported by an entry — must stay lazy`);
    }
  }
  console.log(`[budget] all ${ROUTE_CHUNKS.length} business routes are lazy chunks`);

  // 4. Landing must not share real code chunks with app/admin (no Vue on "/").
  const workspaceFiles = new Set();
  for (const key of [...appKeys, ...adminKeys]) {
    const chunk = manifest[key];
    if (chunk?.file) workspaceFiles.add(chunk.file);
  }
  for (const key of landingKeys) {
    const chunk = manifest[key];
    if (!chunk?.file) continue;
    if (workspaceFiles.has(chunk.file) && !SHARED_ALLOWLIST.test(chunk.file)) {
      fail(`landing shares chunk ${chunk.file} with the workspace/admin bundle — landing must not load Vue`);
    }
  }
  console.log("[budget] landing shares no code chunk with workspace/admin");

  if (process.exitCode) {
    console.error("[budget] RESULT: FAIL");
  } else {
    console.log("[budget] RESULT: PASS");
  }
}

main();
