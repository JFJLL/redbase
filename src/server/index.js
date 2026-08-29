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
const {
  cleanupEmptyGeneratedImageDirs,
  recoverStagedBrandLogoDeletions,
  recoverStagedProductImageDeletions,
} = require("./assets/image-store");
const { createGeneratedAssetStorage } = require("./assets/generated-asset-storage");
const { createVideoProjectService } = require("./video/video-project-service");
const { recoverStaleVideoScriptRequests } = require("./db/repositories/video-script-billing-repository");
const { isBrandLogoStoredPathReferenced } = require("./db/repositories/brand-repository");
const {
  isGeneratedAssetReferenced,
  createGeneratedAssetReferenceLookup,
} = require("./db/repositories/generation-repository");
const { isProductImageStoredPathReferenced } = require("./db/repositories/product-image-repository");
const { ensureAnalyticsBackfill } = require("./analytics/analytics-backfill");
const { setAnalyticsMeta, sanitizeErrorMessage } = require("./analytics/analytics-repository");

async function start() {
  const appConfig = loadAppConfig();
  validateCorsConfigForStartup(appConfig);
  const store = { ensureStore, readStore, writeStore };
  const ai = createAiServices(appConfig);
  const generatedAssetStorage = createGeneratedAssetStorage(appConfig);
  const videoProjectService = createVideoProjectService({ appConfig, generatedAssetStorage });
  const cleanupStagedStoredAssets = ({ nowMs, ignoreGrace = false } = {}) => Promise.all([
    recoverStagedBrandLogoDeletions({ isReferenced: isBrandLogoStoredPathReferenced, nowMs, ignoreGrace }),
    recoverStagedProductImageDeletions({ isReferenced: isProductImageStoredPathReferenced, nowMs, ignoreGrace }),
  ]);
  const historyCleanupRunner = createGenerationHistoryCleanupRunner({
    storage: generatedAssetStorage,
    isAssetReferenced: isGeneratedAssetReferenced,
    createAssetReferenceLookup: createGeneratedAssetReferenceLookup,
    cleanupStagedStoredAssets,
    cleanupEmptyGeneratedImageDirs,
  });
  const handleApi = createApiHandler({ appConfig, store, ai, generatedAssetStorage, historyCleanupRunner, videoProjectService });

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
    ensureAnalyticsBackfill();
  } catch (error) {
    const safeError = sanitizeErrorMessage(error?.message || "analytics backfill failed");
    console.warn("[analytics] startup backfill failed", { error: safeError });
    try {
      setAnalyticsMeta("backfill_status", "failed");
      setAnalyticsMeta("backfill_error", safeError);
    } catch (_) {}
  }
  try {
    const recoveredVideoScriptRequests = recoverStaleVideoScriptRequests();
    if (recoveredVideoScriptRequests.length) {
      console.log(`[video-script] recovered ${recoveredVideoScriptRequests.length} stale billing request(s)`);
    }
  } catch (error) {
    console.warn("[video-script] failed to recover stale billing requests", { error: error.message });
  }
  videoProjectService.start();
  try {
    await cleanupStagedStoredAssets({ nowMs: Date.now(), ignoreGrace: true });
  } catch (error) {
    console.warn("[asset-delete] failed to recover staged local deletions", { error: error.message });
  }
  try {
    await historyCleanupRunner({
      nowMs: Date.now(),
      cleanupRecovery: true,
      cleanupRecoveryIgnoreGrace: true,
    });
  } catch (error) {
    console.warn("[history-expiry] failed to clean expired generation history", { error: error.message });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`Server running at http://${HOST}:${PORT}`);

  const historyCleanupScheduler = startGenerationHistoryCleanupScheduler({
    runCleanup: historyCleanupRunner,
    cleanupRecovery: true,
  });
  server.once("close", () => historyCleanupScheduler.stop());
  server.once("close", () => videoProjectService.stop());

  // Excellent content is cache-only on startup. Do not auto-call Pgy search_note_v2.
  // Manual ops: npm run warm:excellent-content (explicit maintenance only; not part of normal start).

  return server;
}

module.exports = {
  start,
};
