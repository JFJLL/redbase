const { generateAiTrendSet, regenerateTrendIdeas, ensureTrendIdeaContentAssets } = require("./ai/trend-service");
const {
  createImageJob,
  resolveImageJob,
  buildImageJobResponse,
  createImageJobStore,
  recoverPendingImageJobs,
  ensureImageJobRecovery,
} = require("./ai/image-jobs");
const { buildTextProviderEndpoint } = require("./ai/text-provider");

function createAiServices(appConfig) {
  // No in-memory Map: image_jobs SQLite table is the sole job state source.
  // Facade keeps .get/.set compatible with existing image-generation routes.
  const imageJobs = createImageJobStore();

  // Recovery is deferred until DB is open (ensureStore runs after createAiServices).
  setImmediate(() => {
    try {
      ensureImageJobRecovery();
    } catch (error) {
      console.warn("[image-job] deferred recovery failed", {
        message: error?.message || "unknown error",
      });
    }
  });

  return {
    imageJobs,
    generateAiTrendSet: (brand, baseId, options) => generateAiTrendSet(appConfig, brand, baseId, options),
    regenerateTrendIdeas: (brand, trend, customPrompt, options) => regenerateTrendIdeas(appConfig, brand, trend, customPrompt, options),
    ensureTrendIdeaContentAssets: (brand, trend, ideaIndex, options) => ensureTrendIdeaContentAssets(appConfig, brand, trend, ideaIndex, options),
    createImageJob: ({ ownerUserId, brand, trend, idea, metadata, productImage, productImages, logoImage, styleReferenceImages, sourceImageUrls, sourceImages, aspectRatio }) =>
      createImageJob(appConfig, {
        ownerUserId,
        brand,
        trend,
        idea,
        metadata,
        productImage,
        productImages,
        logoImage,
        styleReferenceImages,
        sourceImageUrls,
        sourceImages,
        aspectRatio,
      }),
    resolveImageJob: (job) => resolveImageJob(appConfig, job),
    buildImageJobResponse,
    recoverPendingImageJobs,
    buildTextProviderEndpoint: () => buildTextProviderEndpoint(appConfig),
  };
}

module.exports = {
  createAiServices,
};
