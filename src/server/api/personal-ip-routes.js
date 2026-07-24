const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { findBrandByOwner } = require("../db/repositories/brand-repository");
const {
  listCreatorMaterials,
  findCreatorMaterialByOwner,
  insertCreatorMaterial,
  updateCreatorMaterial,
  deleteCreatorMaterial,
} = require("../db/repositories/creator-material-repository");

function sanitizeCreatorMaterial(item) {
  if (!item) return null;
  const { ownerUserId: _ownerUserId, ...safeItem } = item;
  return safeItem;
}

async function handlePersonalIpRoutes(context, req, res, pathname) {
  const {
    collectBody,
    getSessionToken,
    buildApiUserLog,
    json,
    notFound,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  function requireUser() {
    return requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
  }

  if (req.method === "GET" && pathname === "/api/personal-materials") {
    const user = requireUser();
    if (!user) return true;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const rawBrandId = url.searchParams.get("brandId");
    let brandId = null;
    if (rawBrandId != null && rawBrandId !== "") {
      brandId = Number(rawBrandId);
      const brand = Number.isInteger(brandId) && brandId > 0 ? findBrandByOwner(brandId, user.id) : null;
      if (!brand || brand.profileType !== "personal") {
        badRequest(res, "请选择有效的个人 IP 档案");
        return true;
      }
    }
    json(res, 200, { items: listCreatorMaterials(user.id, brandId).map(sanitizeCreatorMaterial) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/personal-materials") {
    const user = requireUser();
    if (!user) return true;
    const payload = await collectBody(req);
    const brand = findBrandByOwner(Number(payload.brandId), user.id);
    if (!brand || brand.profileType !== "personal") {
      badRequest(res, "请选择有效的个人 IP 档案");
      return true;
    }
    if (!String(payload.content || "").trim()) {
      badRequest(res, "请填写素材内容");
      return true;
    }
    const item = insertCreatorMaterial({
      ...payload,
      ownerUserId: user.id,
      brandId: brand.id,
    });
    json(res, 201, { item: sanitizeCreatorMaterial(item) });
    return true;
  }

  const materialMatch = pathname.match(/^\/api\/personal-materials\/(\d+)$/);
  if (req.method === "PUT" && materialMatch) {
    const user = requireUser();
    if (!user) return true;
    const existing = findCreatorMaterialByOwner(Number(materialMatch[1]), user.id);
    if (!existing) {
      notFound(res);
      return true;
    }
    const payload = await collectBody(req);
    if (!String(payload.content ?? existing.content).trim()) {
      badRequest(res, "请填写素材内容");
      return true;
    }
    const item = updateCreatorMaterial(existing.id, user.id, payload);
    json(res, 200, { item: sanitizeCreatorMaterial(item) });
    return true;
  }

  if (req.method === "DELETE" && materialMatch) {
    const user = requireUser();
    if (!user) return true;
    if (!deleteCreatorMaterial(Number(materialMatch[1]), user.id)) {
      notFound(res);
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handlePersonalIpRoutes, sanitizeCreatorMaterial };
