"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { SMOKE_PATHS, waitForSmoke } = require("../scripts/deploy-smoke.cjs");

test("deployment smoke waits through startup connection failures", async () => {
  const results = [false, false, true];
  const sleeps = [];
  const healthy = await waitForSmoke("http://127.0.0.1:3013", {
    attempts: 5,
    delayMs: 25,
    smoke: async () => results.shift(),
    sleep: async (delayMs) => sleeps.push(delayMs),
    log: () => {},
  });

  assert.equal(healthy, true);
  assert.deepEqual(sleeps, [25, 25]);
});

test("deployment smoke reports failure only after exhausting readiness attempts", async () => {
  let calls = 0;
  const healthy = await waitForSmoke("http://127.0.0.1:3013", {
    attempts: 3,
    delayMs: 1,
    smoke: async () => {
      calls += 1;
      return false;
    },
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(healthy, false);
  assert.equal(calls, 3);
});

test("deployment smoke covers all public readiness routes", () => {
  assert.deepEqual(SMOKE_PATHS, ["/api/health", "/", "/app/", "/admin/"]);
});
