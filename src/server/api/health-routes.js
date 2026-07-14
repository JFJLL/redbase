const { bindRouteScope } = require("./route-scope");

async function handleHealthRoutes(context, req, res, pathname) {
  const {
    json,
  } = bindRouteScope(context);

  if (req.method === "GET" && pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
    });
    return true;
  }

  return false;
}

module.exports = {
  handleHealthRoutes,
};
