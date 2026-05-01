const { bindRouteScope } = require("./route-scope");

async function handleHealthRoutes(context, req, res, pathname) {
  const {
    appConfig,
    json,
  } = bindRouteScope(context);

  if (req.method === "GET" && pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      textProvider: {
        apiStyle: appConfig.textProvider.apiStyle,
        model: appConfig.textProvider.model,
        baseUrl: appConfig.textProvider.baseUrl || "",
        configured: Boolean(appConfig.textProvider.apiKey),
        searchEnabled: appConfig.textProvider.searchEnabled,
      },
      imageProvider: {
        model: appConfig.imageProvider.model,
        configured: Boolean(appConfig.imageProvider.apiKey),
      },
    });
    return true;
  }

  return false;
}

module.exports = {
  handleHealthRoutes,
};
