#!/usr/bin/env node
const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema } = require("../src/server/db/schema");
const { ensureAnalyticsBackfill } = require("../src/server/analytics/analytics-backfill");

openDatabase();
initializeDatabaseSchema();

console.log("[analytics-backfill] Starting backfill...");
const result = ensureAnalyticsBackfill();
console.log("[analytics-backfill] Backfill complete:", result);
