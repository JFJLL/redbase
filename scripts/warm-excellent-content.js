#!/usr/bin/env node
/**
 * Warm shared excellent-content cache (default 专业号笔记, all categories).
 * Safe to run before traffic switch. Does not print cookies or secrets.
 * Exit 0 only when Pgy refresh succeeds with at least one fresh item.
 */
const { loadAppConfig } = require("../src/server/config");
const { ensureStore } = require("../src/server/store");
const {
  EXCELLENT_SOURCE_DEFAULT,
  warmExcellentContentCache,
} = require("../src/server/services/excellent-content-service");

async function main() {
  const appConfig = loadAppConfig();
  await ensureStore();
  const result = await warmExcellentContentCache(appConfig, {
    source: EXCELLENT_SOURCE_DEFAULT,
    categoryPath: "",
  });
  const count = Array.isArray(result?.items) ? result.items.length : 0;
  const stale = Boolean(result?.stale);
  const lastError = String(result?.lastError || "").slice(0, 300);
  const ok = !stale && !lastError && count > 0;
  console.log(
    JSON.stringify({
      ok,
      source: result?.source || EXCELLENT_SOURCE_DEFAULT,
      categoryPath: "",
      count,
      updatedAt: result?.updatedAt || "",
      stale,
      lastError: lastError || undefined,
    }),
  );
  if (!ok) {
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
