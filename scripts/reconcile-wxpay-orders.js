"use strict";

// Reconcile WeChat Pay payment orders against the provider.
// Usage: node scripts/reconcile-wxpay-orders.js [--dry-run] [--max N]

const { loadAppConfig } = require("../src/server/config");
const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { getWxpayProvider } = require("../src/server/integrations/wxpay");
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
  const gateway = getWxpayProvider(appConfig);
  if (!gateway) {
    console.log(JSON.stringify({
      ok: false,
      reason: "wxpay_gateway_not_configured",
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

