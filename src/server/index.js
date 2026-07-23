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

  // Excellent content is cache-only on startup. Do not auto-call Pgy search_note_v2.
  // Manual ops: npm run warm:excellent-content (explicit maintenance only; not part of normal start).

  return server;
}

module.exports = {
  start,
};
