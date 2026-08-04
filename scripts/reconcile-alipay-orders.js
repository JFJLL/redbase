"use strict";

// Reconcile Alipay payment orders against the provider. This script is the
// rollback-safe fallback: it keeps working while alipay.enabled=false as long
// as the gateway stays configured. It never credits twice: settlement reuses
// the same atomic conditional update + unique constraints as the notify path.
//
// Usage: node scripts/reconcile-alipay-orders.js [--dry-run] [--max N]

const { loadAppConfig } = require("../src/server/config");
const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { getAlipayProvider } = require("../src/server/integrations/alipay");
const { reconcileOrders } = require("../src/server/billing/reconcile-orders");

function parseArgs(argv) {
  const options = { dryRun: false, max: 100 };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    if (String(arg).startsWith("--max=")) options.max = Number(arg.slice("--max=".length));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const appConfig = loadAppConfig();
  const gateway = getAlipayProvider(appConfig);
  if (!gateway) {
    console.log(JSON.stringify({
      ok: false,
      reason: "alipay_gateway_not_configured",
      dryRun: options.dryRun,
    }));
    process.exit(0);
  }

  openDatabase();
  initializeDatabaseSchema();
  ensureDatabaseIndexes();

  const summary = await reconcileOrders({
    gateway,
    limit: options.max,
    dryRun: options.dryRun,
  });
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
