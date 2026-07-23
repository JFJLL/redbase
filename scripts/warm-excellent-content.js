#!/usr/bin/env node
/**
 * Warm shared excellent-content cache for both default boards:
 * - 小红书热门 (xhs_hot)
 * - 电商热门 (ecommerce_hot)
 * Safe to run before traffic switch. Does not print cookies or secrets.
 * Exit non-zero if any default board fails strict warm (no stale masquerade).
 */
const { loadAppConfig } = require("../src/server/config");
const { ensureStore } = require("../src/server/store");
const {
  warmAllExcellentContentBoards,
} = require("../src/server/services/excellent-content-service");

async function main() {
  const appConfig = loadAppConfig();
  await ensureStore();
  try {
    const result = await warmAllExcellentContentBoards(appConfig);
    console.log(
      JSON.stringify({
        ok: true,
        boards: (result.boards || []).map((board) => ({
          board: board.board,
          count: board.count,
          stale: board.stale,
          updatedAt: board.updatedAt || "",
        })),
      }),
    );
  } catch (error) {
    const boards = Array.isArray(error?.boards)
      ? error.boards.map((board) => ({
          board: board.board,
          count: board.count || 0,
          stale: board.stale !== false,
          updatedAt: board.updatedAt || "",
          lastError: board.lastError ? String(board.lastError).slice(0, 200) : undefined,
        }))
      : undefined;
    console.log(
      JSON.stringify({
        ok: false,
        code: error?.code || "WARM_FAILED",
        message: String(error?.message || "warm failed").slice(0, 300),
        boards,
      }),
    );
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
