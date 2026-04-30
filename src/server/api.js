const { shouldLogApiRequest, installApiRequestLogger, json } = require("./api/helpers");
const { handleHealthRoutes } = require("./api/health-routes");
const { handleAuthRoutes } = require("./api/auth-routes");
const { handleAdminRoutes } = require("./api/admin-routes");
const { handleHistoryRoutes } = require("./api/history-routes");
const { handleProductImageRoutes } = require("./api/product-image-routes");
const { handleBrandRoutes } = require("./api/brand-routes");
const { handleTrendRoutes } = require("./api/trend-routes");
const { handleImageGenerationRoutes } = require("./api/image-generation-routes");

const routeHandlers = [
  handleHealthRoutes,
  handleAuthRoutes,
  handleAdminRoutes,
  handleHistoryRoutes,
  handleProductImageRoutes,
  handleBrandRoutes,
  handleTrendRoutes,
  handleImageGenerationRoutes,
];

function createApiHandler({ appConfig, store, ai }) {
  const { readStore, writeStore } = store;
  const {
    imageJobs,
    generateAiTrendSet,
    regenerateTrendIdeas,
    createImageJob,
    resolveImageJob,
    buildImageJobResponse,
  } = ai;

  const context = {
    appConfig,
    readStore,
    writeStore,
    imageJobs,
    generateAiTrendSet,
    regenerateTrendIdeas,
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
