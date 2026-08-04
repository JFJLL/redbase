"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_FILE_PATTERN = /(?:^test-.+|.+[._-]test)\.(?:cjs|mjs|js)$/;

function collectTestFiles(inputs, files = []) {
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules")
        .map((entry) => path.join(resolved, entry.name));
      collectTestFiles(children, files);
    } else if (stat.isFile() && TEST_FILE_PATTERN.test(path.basename(resolved))) {
      files.push(resolved);
    }
  }
  return files;
}

function main(argv) {
  const inputs = argv.slice(2);
  if (inputs.length === 0) {
    console.error("Usage: node scripts/run-node-tests.js <file-or-directory> [...]");
    return 2;
  }
  const files = [...new Set(collectTestFiles(inputs))].sort();
  if (files.length === 0) {
    console.error("No Node test files found.");
    return 2;
  }
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { TEST_FILE_PATTERN, collectTestFiles, main };
