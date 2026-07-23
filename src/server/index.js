const http = require("http");
const { HOST, PORT, loadAppConfig } = require("./config");
const { ensureStore, readStore, writeStore } = require("./store");
const { createAiServices } = require("./ai");
const { createApiHandler, json } = require("./api");
const { applyCorsHeaders, handleCorsPreflight, validateCorsConfigForStartup } = require("./cors");
const { serveStatic } = require("./static");
const { cleanupExpiredGenerationHistory } = require("./api/history-routes");
const { cleanupEmptyGeneratedImageDirs, removeGenerationLocalFiles } = require("./assets/image-store");

async function start() {
  const appConfig = loadAppConfig();
  validateCorsConfigForStartup(appConfig);
  const store = { ensureStore, readStore, writeStore };
  const ai = createAiServices(appConfig);
  const handleApi = createApiHandler({ appConfig, store, ai });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    applyCorsHeaders(req, res, appConfig);
    if (handleCorsPreflight(req, res, appConfig)) return;

    try {
      const handled = await handleApi(req, res, url.pathname);
      if (handled) return;
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      console.error(error);
      if (error?.code === "PAYLOAD_TOO_LARGE") {
        json(res, 413, { error: error.message });
        return;
      }
      if (error?.code === "IMAGE_LIMIT_EXCEEDED") {
        json(res, 400, { error: error.message });
        return;
      }
      json(res, 500, { error: "Internal server error" });
    }
  });

  await ensureStore();
  try {
    await cleanupExpiredGenerationHistory({ cleanupEmptyGeneratedImageDirs, removeGenerationLocalFiles });
  } catch (error) {
    console.warn("[history-expiry] failed to clean expired generation history", error);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`Server running at http://${HOST}:${PORT}`);

  // Best-effort warm of both default excellent-content boards; never block startup.
  // Strict warm: stale/empty is not treated as success for logging.
  setImmediate(() => {
    try {
      const { warmAllExcellentContentBoards } = require("./services/excellent-content-service");
      warmAllExcellentContentBoards(appConfig)
        .then((result) => {
          for (const board of result.boards || []) {
            console.log(
              `[excellent-content] warm complete board=${board.board} items=${board.count} updatedAt=${board.updatedAt || ""}`,
            );
          }
        })
        .catch((error) => {
          const boards = Array.isArray(error?.boards) ? error.boards : [];
          if (boards.length) {
            for (const board of boards) {
              if (board.ok) {
                console.log(
                  `[excellent-content] warm complete board=${board.board} items=${board.count}`,
                );
              } else {
                console.warn(
                  `[excellent-content] warm failed board=${board.board}`,
                  board.lastError ? String(board.lastError).slice(0, 160) : board.code || "failed",
                );
              }
            }
            return;
          }
          console.warn(
            "[excellent-content] warm skipped",
            error?.code || "UNKNOWN",
            error?.message ? String(error.message).slice(0, 160) : "unknown",
          );
        });
    } catch (error) {
      console.warn("[excellent-content] warm unavailable", error?.message || error);
    }
  });

  return server;
}

module.exports = {
  start,
};
