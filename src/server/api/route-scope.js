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
  // Context overrides win over shared helpers so route tests can mock image/asset deps.
  const scope = {
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
    ...context,
  };
  if (context && typeof context === "object") {
    routeScopeCache.set(context, scope);
  }
  return scope;
}

module.exports = {
  bindRouteScope,
};
