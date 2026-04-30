const { generateAiTrendSet, regenerateTrendIdeas } = require("./ai/trend-service");
const { createImageJob, resolveImageJob, buildImageJobResponse } = require("./ai/image-jobs");
const { buildTextProviderEndpoint } = require("./ai/text-provider");

function createAiServices(appConfig) {
  const imageJobs = new Map();

  return {
    imageJobs,
    generateAiTrendSet: (brand, baseId) => generateAiTrendSet(appConfig, brand, baseId),
    regenerateTrendIdeas: (brand, trend, customPrompt) => regenerateTrendIdeas(appConfig, brand, trend, customPrompt),
    createImageJob: ({ brand, trend, idea, metadata, productImage, productImages, logoImage, styleReferenceImages, sourceImageUrls, sourceImages, aspectRatio }) =>
      createImageJob(appConfig, imageJobs, {
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
    resolveImageJob: (job) => resolveImageJob(appConfig, imageJobs, job),
    buildImageJobResponse,
    buildTextProviderEndpoint: () => buildTextProviderEndpoint(appConfig),
  };
}

module.exports = {
  createAiServices,
};
