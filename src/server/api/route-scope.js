const fsp = require("fs/promises");
const {
  randomToken,
  isValidPhone,
  sanitizeUser,
  sanitizeTrend,
  sanitizeBrand,
  sanitizeGeneration,
  createBrandAssetTags,
  formatTimestamp,
} = require("../utils");
const helpers = require("./helpers");

function bindRouteScope(context) {
  return {
    ...context,
    fsp,
    randomToken,
    isValidPhone,
    sanitizeUser,
    sanitizeTrend,
    sanitizeBrand,
    sanitizeGeneration,
    createBrandAssetTags,
    formatTimestamp,
    ...helpers,
  };
}

module.exports = {
  bindRouteScope,
};
