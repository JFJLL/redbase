"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const packageJson = require("../package.json");

test("Node test scripts stay compatible with the minimum supported Node 20 runtime", () => {
  for (const scriptName of ["test", "test:integration", "test:data"]) {
    const command = String(packageJson.scripts?.[scriptName] || "");
    assert.match(
      command,
      /^node scripts\/run-node-tests\.js(?:\s|$)/,
      `${scriptName} must use the cross-platform Node test launcher`,
    );
    assert.doesNotMatch(
      command,
      /[*?\[\]{}]/,
      `${scriptName} must use paths/directories instead of CLI glob patterns`,
    );
  }
});
