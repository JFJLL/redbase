const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/excellent-remix-request.js"), "utf8");
const transformed = source
  .replace(/export function /g, "function ")
  .replace(/export const /g, "const ")
  .concat(
    `\nmodule.exports = {
  createRemixRequestCounters,
  captureRemixRequestToken,
  nextRemixRequestId,
  isRemixResponseCurrent,
  isRemixAnalysisSettled,
  shouldAutoGenerateSmartDirections,
};\n`,
  );
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(transformed, { module: sandbox.module, exports: sandbox.exports });
const {
  captureRemixRequestToken,
  nextRemixRequestId,
  isRemixResponseCurrent,
  shouldAutoGenerateSmartDirections,
} = sandbox.module.exports;

function baseState(overrides = {}) {
  return {
    instanceId: 1,
    sessionEpoch: 10,
    requestEpoch: 10,
    noteId: "note-a",
    board: "xhs_hot",
    brandId: 11,
    analysisRequestId: 1,
    brandRequestId: 1,
    directionsRequestId: 1,
    trendRequestId: 0,
    fusionRequestId: 0,
    productImagesRequestId: 0,
    analysisStatus: "ready",
    contentDirectionMode: "smart",
    directionsAutoTriggered: false,
    loadingBrand: false,
    directionsStatus: "idle",
    ...overrides,
  };
}

test("cross-note async response is rejected", () => {
  const state = baseState({ noteId: "note-b" });
  const token = captureRemixRequestToken(baseState({ noteId: "note-a" }), "analysisRequestId", 1);
  assert.equal(isRemixResponseCurrent(state, token), false);
});

test("closed modal (null state) rejects writes", () => {
  const token = captureRemixRequestToken(baseState(), "analysisRequestId", 1);
  assert.equal(isRemixResponseCurrent(null, token), false);
});

test("instanceId mismatch rejects writes", () => {
  const state = baseState({ instanceId: 2 });
  const token = captureRemixRequestToken(baseState({ instanceId: 1 }), "analysisRequestId", 1);
  assert.equal(isRemixResponseCurrent(state, token), false);
});

test("fast brand switch rejects old brand directions", () => {
  const state = baseState({ brandId: 22, directionsRequestId: 3 });
  const token = captureRemixRequestToken(
    baseState({ brandId: 11, directionsRequestId: 2 }),
    "directionsRequestId",
    2,
  );
  assert.equal(isRemixResponseCurrent(state, token, { requireBrand: true, brandId: 11 }), false);
  assert.equal(
    isRemixResponseCurrent(baseState({ brandId: 22, directionsRequestId: 3 }), {
      ...token,
      brandId: 22,
      requestId: 3,
      requestKey: "directionsRequestId",
    }, { requireBrand: true }),
    true,
  );
});

test("stale requestId is rejected after newer request", () => {
  const state = baseState();
  const firstId = nextRemixRequestId(state, "fusionRequestId");
  const token = captureRemixRequestToken(state, "fusionRequestId", firstId);
  nextRemixRequestId(state, "fusionRequestId");
  assert.equal(isRemixResponseCurrent(state, token), false);
});

test("smart directions never auto-generate; user must click generate", () => {
  assert.equal(shouldAutoGenerateSmartDirections(baseState({ analysisStatus: "loading" })), false);
  assert.equal(shouldAutoGenerateSmartDirections(baseState({ analysisStatus: "ready" })), false);
  assert.equal(
    shouldAutoGenerateSmartDirections(baseState({ analysisStatus: "ready", directionsAutoTriggered: false })),
    false,
  );
  assert.equal(shouldAutoGenerateSmartDirections(baseState({ analysisStatus: "ready", loadingBrand: false })), false);
});
