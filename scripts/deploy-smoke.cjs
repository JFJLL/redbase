#!/usr/bin/env node
"use strict";

const SMOKE_PATHS = ["/api/health", "/", "/app/", "/admin/"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function smokeOnce(appUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  log = console.log,
  label = "[deploy]",
} = {}) {
  let healthy = true;
  for (const smokePath of SMOKE_PATHS) {
    let code = 0;
    try {
      const response = await fetchImpl(`${String(appUrl).replace(/\/+$/, "")}${smokePath}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer();
      code = response.status;
    } catch (error) {
      code = 0;
    }
    log(`${label} smoke ${smokePath} -> ${code}`);
    if (code !== 200) healthy = false;
  }
  return healthy;
}

async function waitForSmoke(appUrl, {
  attempts = 30,
  delayMs = 1000,
  smoke = smokeOnce,
  sleep = delay,
  log = console.log,
  label = "[deploy]",
} = {}) {
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (await smoke(appUrl, { log, label })) return true;
    if (attempt < totalAttempts) {
      log(`${label} service not ready (${attempt}/${totalAttempts}); retrying...`);
      await sleep(Math.max(0, Number(delayMs) || 0));
    }
  }
  return false;
}

function parseArgs(argv) {
  const args = {
    appUrl: process.env.REDBASE_BASE_URL || "http://127.0.0.1:3013",
    attempts: 30,
    delayMs: 1000,
    label: "[deploy]",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-url") args.appUrl = argv[++index] || "";
    else if (arg === "--attempts") args.attempts = Number(argv[++index]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++index]);
    else if (arg === "--label") args.label = argv[++index] || "[deploy]";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const healthy = await waitForSmoke(args.appUrl, args);
  process.exitCode = healthy ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[deploy] smoke runner failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { SMOKE_PATHS, smokeOnce, waitForSmoke, parseArgs };
