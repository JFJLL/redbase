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

const routeScopeCache = new WeakMap();

function bindRouteScope(context) {
  if (context && typeof context === "object" && routeScopeCache.has(context)) {
    return routeScopeCache.get(context);
  }
  const scope = {
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
  if (context && typeof context === "object") {
    routeScopeCache.set(context, scope);
  }
  return scope;
}

module.exports = {
  bindRouteScope,
};
