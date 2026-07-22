#!/usr/bin/env node
/**
 * Warm shared excellent-content cache (default xhs_hot, all categories).
 * Safe to run before traffic switch. Does not print cookies or secrets.
 */
const { loadAppConfig } = require("../src/server/config");
const { ensureStore } = require("../src/server/store");
const { warmExcellentContentCache } = require("../src/server/services/excellent-content-service");

async function main() {
  const appConfig = loadAppConfig();
  await ensureStore();
  const result = await warmExcellentContentCache(appConfig, { categoryPath: "" });
  const count = Array.isArray(result?.items) ? result.items.length : 0;
  console.log(
    JSON.stringify({
      ok: true,
      source: "xhs_hot",
      categoryPath: "",
      count,
      updatedAt: result?.updatedAt || "",
      stale: Boolean(result?.stale),
    }),
  );
  if (count <= 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      code: error?.code || "WARM_FAILED",
      message: String(error?.message || "warm failed").slice(0, 300),
    }),
  );
  process.exit(1);
});
