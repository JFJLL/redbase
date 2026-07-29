const http = require("http");
const { HOST, PORT, loadAppConfig } = require("./config");
const { ensureStore, readStore, writeStore } = require("./store");
const { createAiServices } = require("./ai");
const { createApiHandler, json } = require("./api");
const { applyCorsHeaders, handleCorsPreflight, validateCorsConfigForStartup } = require("./cors");
const { serveStatic } = require("./static");
const {
  createGenerationHistoryCleanupRunner,
  startGenerationHistoryCleanupScheduler,
} = require("./api/history-routes");
const { cleanupEmptyGeneratedImageDirs, recoverStagedBrandLogoDeletions } = require("./assets/image-store");
const { createGeneratedAssetStorage } = require("./assets/generated-asset-storage");
const { isBrandLogoStoredPathReferenced } = require("./db/repositories/brand-repository");

async function start() {
  const appConfig = loadAppConfig();
  validateCorsConfigForStartup(appConfig);
  const store = { ensureStore, readStore, writeStore };
  const ai = createAiServices(appConfig);
  const generatedAssetStorage = createGeneratedAssetStorage(appConfig);
  const historyCleanupRunner = createGenerationHistoryCleanupRunner({
    storage: generatedAssetStorage,
    cleanupEmptyGeneratedImageDirs,
  });
  const handleApi = createApiHandler({ appConfig, store, ai, generatedAssetStorage, historyCleanupRunner });

  console.log(`[asset-storage] generated images provider: ${generatedAssetStorage.provider}`);
  if (generatedAssetStorage.provider === "aliyun_oss") {
    console.log(`[asset-storage] bucket: ${appConfig.assetStorage.aliyunOss.bucket}`);
    console.log(`[asset-storage] prefix: ${appConfig.assetStorage.aliyunOss.prefix}`);
  }

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
    await recoverStagedBrandLogoDeletions({ isReferenced: isBrandLogoStoredPathReferenced });
  } catch (error) {
    console.warn("[brand-delete] failed to recover staged logo deletions", { error: error.message });
  }
  try {
    await historyCleanupRunner({ nowMs: Date.now() });
  } catch (error) {
    console.warn("[history-expiry] failed to clean expired generation history", { error: error.message });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`Server running at http://${HOST}:${PORT}`);

  const historyCleanupScheduler = startGenerationHistoryCleanupScheduler({ runCleanup: historyCleanupRunner });
  server.once("close", () => historyCleanupScheduler.stop());

  // Excellent content is cache-only on startup. Do not auto-call Pgy search_note_v2.
  // Manual ops: npm run warm:excellent-content (explicit maintenance only; not part of normal start).

  return server;
}

module.exports = {
  start,
};
