const { shouldLogApiRequest, installApiRequestLogger, json } = require("./api/helpers");
const { handleHealthRoutes } = require("./api/health-routes");
const { handleAuthRoutes } = require("./api/auth-routes");
const { handleAdminRoutes } = require("./api/admin-routes");
const { handleHistoryRoutes } = require("./api/history-routes");
const { handlePersonalIpRoutes } = require("./api/personal-ip-routes");
const { handleProductImageRoutes } = require("./api/product-image-routes");
const { handleBrandRoutes } = require("./api/brand-routes");
const { handleTrendRoutes } = require("./api/trend-routes");
const { handleImageGenerationRoutes } = require("./api/image-generation-routes");
const { handleExcellentContentRoutes } = require("./api/excellent-content-routes");
const { handlePaymentRoutes } = require("./api/payment-routes");
const { handleVideoScriptRoutes } = require("./api/video-script-routes");
const imageStore = require("./assets/image-store");
const { createGeneratedAssetStorage } = require("./assets/generated-asset-storage");
const generationDeletionService = require("./assets/generation-deletion-service");

const routeHandlers = [
  handleHealthRoutes,
  handleAuthRoutes,
  handleAdminRoutes,
  handleHistoryRoutes,
  handlePersonalIpRoutes,
  handleProductImageRoutes,
  handleBrandRoutes,
  handleTrendRoutes,
  handleExcellentContentRoutes,
  handleImageGenerationRoutes,
  handleVideoScriptRoutes,
  handlePaymentRoutes,
];

function createApiHandler({ appConfig, store, ai, generatedAssetStorage, historyCleanupRunner }) {
  const {
    imageJobs,
    generateAiTrendSet,
    regenerateTrendIdeas,
    ensureTrendIdeaContentAssets,
    createImageJob,
    resolveImageJob,
    buildImageJobResponse,
  } = ai;

  const assetStorage = generatedAssetStorage || createGeneratedAssetStorage(appConfig);
  const context = {
    appConfig,
    generatedAssetStorage: assetStorage,
    historyCleanupRunner,
    removeGenerationAssetsAndRows: (generation, options = {}) => generationDeletionService.removeGenerationAssetsAndRows(generation, {
      ...options,
      storage: assetStorage,
    }),
    removeGenerationsAssets: (generations, options = {}) => generationDeletionService.removeGenerationsAssets(generations, {
      ...options,
      storage: assetStorage,
    }),
    removeGenerationsAssetsAndRows: (generations, options = {}) => generationDeletionService.removeGenerationsAssetsAndRows(generations, {
      ...options,
      storage: assetStorage,
    }),
    persistGenerationImages: (generation) => imageStore.persistGenerationImages(generation, assetStorage),
    persistGeneratedImageReference: (options) => imageStore.persistGeneratedImageReference({ ...options, storage: assetStorage }),
    serveStoredGeneratedImage: (res, asset, generation) => imageStore.serveStoredGeneratedImage(res, asset, assetStorage, generation),
    resolveGeneratedImageInputForEdit: (generation, sourceImageUrl, parentEditId) =>
      imageStore.resolveGeneratedImageInputForEdit(generation, sourceImageUrl, parentEditId, assetStorage),
    imageJobs,
    generateAiTrendSet,
    regenerateTrendIdeas,
    ensureTrendIdeaContentAssets,
    createImageJob,
    resolveImageJob,
    buildImageJobResponse,
  };

  return async function handleApi(req, res, pathname) {
    if (shouldLogApiRequest(pathname)) {
      installApiRequestLogger(req, res, pathname);
    }

    for (const handleRoute of routeHandlers) {
      if (await handleRoute(context, req, res, pathname)) {
        return true;
      }
    }

    return false;
  };
}

module.exports = {
  createApiHandler,
  json,
};
