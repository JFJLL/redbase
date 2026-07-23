const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load the browser ESM module into a sandbox and capture exports.
const source = fs.readFileSync(path.join(__dirname, "../public/js/excellent-image-nav.js"), "utf8");
const sandbox = { exports: {}, module: { exports: {} } };
const transformed = source
  .replace(/export function (\w+)/g, "function $1")
  .concat(
    "\nmodule.exports = { clampImageIndex, getPreviousImageIndex, getNextImageIndex, canGoPrevious, canGoNext };\n",
  );
vm.runInNewContext(transformed, { module: sandbox.module, exports: sandbox.exports });
const {
  clampImageIndex,
  getPreviousImageIndex,
  getNextImageIndex,
  canGoPrevious,
  canGoNext,
} = sandbox.module.exports;

test("clampImageIndex handles empty and out-of-range", () => {
  assert.equal(clampImageIndex(3, 0), 0);
  assert.equal(clampImageIndex(-1, 5), 0);
  assert.equal(clampImageIndex(99, 5), 4);
  assert.equal(clampImageIndex(2, 5), 2);
});

test("previous stays at first image", () => {
  assert.equal(getPreviousImageIndex(0, 8), 0);
  assert.equal(canGoPrevious(0, 8), false);
  assert.equal(getPreviousImageIndex(3, 8), 2);
  assert.equal(canGoPrevious(3, 8), true);
});

test("next stays at last image", () => {
  assert.equal(getNextImageIndex(7, 8), 7);
  assert.equal(canGoNext(7, 8), false);
  assert.equal(getNextImageIndex(3, 8), 4);
  assert.equal(canGoNext(3, 8), true);
});

test("empty image array does not throw", () => {
  assert.equal(getPreviousImageIndex(0, 0), 0);
  assert.equal(getNextImageIndex(0, 0), 0);
  assert.equal(canGoPrevious(0, 0), false);
  assert.equal(canGoNext(0, 0), false);
});
