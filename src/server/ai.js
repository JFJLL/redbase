const { generateAiTrendSet, regenerateTrendIdeas, ensureTrendIdeaContentAssets } = require("./ai/trend-service");
const { createImageJob, resolveImageJob, buildImageJobResponse } = require("./ai/image-jobs");
const { buildTextProviderEndpoint } = require("./ai/text-provider");

function createAiServices(appConfig) {
  const imageJobs = new Map();

  return {
    imageJobs,
    generateAiTrendSet: (brand, baseId, options) => generateAiTrendSet(appConfig, brand, baseId, options),
    regenerateTrendIdeas: (brand, trend, customPrompt) => regenerateTrendIdeas(appConfig, brand, trend, customPrompt),
    ensureTrendIdeaContentAssets: (brand, trend, ideaIndex) => ensureTrendIdeaContentAssets(appConfig, brand, trend, ideaIndex),
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
