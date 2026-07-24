const { bindRouteScope } = require("./route-scope");
const { requireSqlAuth } = require("./sql-auth");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  findBrandByOwner,
  findBrandById,
  insertBrand,
  updateBrand,
  deleteBrandById,
} = require("../db/repositories/brand-repository");
const { listGenerationsByOwner, deleteGenerationRows } = require("../db/repositories/generation-repository");

function normalizeProfileType(value, fallback = "brand") {
  if (value === "personal") return "personal";
  return fallback === "personal" ? "personal" : "brand";
}

function normalizeContentPillars(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，]/);
  return [...new Set(source.map((item) => String(item || "").trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
}

function normalizeProfilePayload(payload, fallbackType = "brand") {
  const profileType = normalizeProfileType(payload?.profileType, fallbackType);
  return {
    ...payload,
    profileType,
    product: String(payload?.product || "").trim(),
    contentPillars: normalizeContentPillars(payload?.contentPillars),
    personaStyle: String(payload?.personaStyle || "").trim().slice(0, 1000),
  };
}

function findMissingProfileField(payload) {
  const required = payload.profileType === "personal"
    ? ["name", "industry", "audience", "description", "goal"]
    : ["name", "industry", "audience", "description", "product", "goal"];
  return required.find((key) => !String(payload[key] || "").trim());
}

async function handleBrandRoutes(context, req, res, pathname) {
  const {
    appConfig,
    fsp,
    sanitizeBrand,
    createBrandAssetTags,
    MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS,
    getTrendAnalysisBrandProfileSize,
    removeGenerationLocalFiles,
    saveBrandLogo,
    resolveStoredAssetPath,
    removeStoredFileIfExists,
    verifySignedAssetRequest,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    json,
    notFound,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  if (req.method === "POST" && pathname === "/api/brands") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;

    const payload = normalizeProfilePayload(await collectBody(req));
    const missing = findMissingProfileField(payload);
    if (missing) {
      badRequest(res, `Missing field: ${missing}`);
      return true;
    }

    const assetTags = createBrandAssetTags(payload);
    const subjectLabel = payload.profileType === "personal" ? "个人 IP" : "品牌";
    const profileSize = getTrendAnalysisBrandProfileSize({
      ...payload,
      knowledgeBase: payload.knowledgeBase || "",
      assetTags,
    });
    if (profileSize.total > MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS) {
      badRequest(
        res,
        `当前${subjectLabel}档案共 ${profileSize.total} 字，超过上限 ${MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字。请精简档案内容后再创建。`,
      );
      return true;
    }

    const brandId = allocateCounter("nextBrandId", 1);
    const brand = {
      id: brandId,
      ownerUserId: user.id,
      name: payload.name,
      industry: payload.industry,
      audience: payload.audience,
      description: payload.description,
      product: payload.product,
      goal: payload.goal,
      knowledgeBase: payload.knowledgeBase || "",
      logo: null,
      assetTags,
      profileType: payload.profileType,
      contentPillars: payload.contentPillars,
      personaStyle: payload.personaStyle,
      materials: [],
      analyses: [],
      trends: [],
    };
    if (payload.logoDataUrl) {
      try {
        brand.logo = await saveBrandLogo(user, brand, {
          dataUrl: payload.logoDataUrl,
          name: payload.logoName || (payload.profileType === "personal" ? "personal-avatar" : "brand-logo"),
        });
      } catch (error) {
        if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
        badRequest(res, error.message || (payload.profileType === "personal" ? "个人头像上传失败" : "品牌 Logo 上传失败"));
        return true;
      }
    }
    const savedBrand = insertBrand(brand);
    json(res, 201, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  const brandMatch = pathname.match(/^\/api\/brands\/(\d+)$/);
  if (req.method === "GET" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    json(res, 200, { brand: sanitizeBrand(brand, appConfig) });
    return true;
  }

  if (req.method === "PUT" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }

    const payload = normalizeProfilePayload(await collectBody(req), brand.profileType);
    payload.profileType = brand.profileType;
    const missing = findMissingProfileField(payload);
    if (missing) {
      badRequest(res, `Missing field: ${missing}`);
      return true;
    }

    const assetTags = createBrandAssetTags(payload);
    const subjectLabel = payload.profileType === "personal" ? "个人 IP" : "品牌";
    const profileSize = getTrendAnalysisBrandProfileSize({
      ...payload,
      knowledgeBase: payload.knowledgeBase || "",
      assetTags,
    });
    if (profileSize.total > MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS) {
      badRequest(
        res,
        `当前${subjectLabel}档案共 ${profileSize.total} 字，超过上限 ${MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_TREND_ANALYSIS_BRAND_PROFILE_CHARS} 字。请精简档案内容后再保存。`,
      );
      return true;
    }

    const previousLogoPath = brand.logo?.storedPath || "";
    brand.name = payload.name;
    brand.industry = payload.industry;
    brand.audience = payload.audience;
    brand.description = payload.description;
    brand.product = payload.product;
    brand.goal = payload.goal;
    brand.knowledgeBase = payload.knowledgeBase || "";
    brand.assetTags = assetTags;
    brand.contentPillars = payload.contentPillars;
    brand.personaStyle = payload.personaStyle;

    if (payload.logoDataUrl) {
      try {
        brand.logo = await saveBrandLogo(user, brand, {
          dataUrl: payload.logoDataUrl,
          name: payload.logoName || (payload.profileType === "personal" ? "personal-avatar" : "brand-logo"),
        });
        if (previousLogoPath) {
          await removeStoredFileIfExists(resolveStoredAssetPath(previousLogoPath));
        }
      } catch (error) {
        if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
        badRequest(res, error.message || (payload.profileType === "personal" ? "个人头像上传失败" : "品牌 Logo 上传失败"));
        return true;
      }
    }

    const savedBrand = updateBrand(brand);
    json(res, 200, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  if (req.method === "DELETE" && brandMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    const payload = await collectBody(req);
    const deleteGenerations = Boolean(payload.deleteGenerations);
    const deletedGenerationIds = [];
    if (deleteGenerations) {
      const brandGenerations = listGenerationsByOwner(user.id).filter((generation) => generation.brandId === brand.id);
      for (const generation of brandGenerations) {
        deletedGenerationIds.push(generation.id);
        await removeGenerationLocalFiles(generation);
        deleteGenerationRows(generation.id);
      }
    }
    if (brand.logo?.storedPath) {
      await removeStoredFileIfExists(resolveStoredAssetPath(brand.logo.storedPath));
    }
    deleteBrandById(brand.id);
    json(res, 200, { ok: true, deletedGenerationIds });
    return true;
  }

  const brandLogoMatch = pathname.match(/^\/api\/brands\/(\d+)\/logo$/);
  if (req.method === "POST" && brandLogoMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const brand = findBrandByOwner(Number(brandLogoMatch[1]), user.id);
    if (!brand) {
      notFound(res);
      return true;
    }
    const payload = await collectBody(req);
    try {
      const previousLogoPath = brand.logo?.storedPath || "";
      const nextLogo = await saveBrandLogo(user, brand, {
        dataUrl: payload.logoDataUrl || payload.dataUrl,
        name: payload.logoName || payload.name || (brand.profileType === "personal" ? "personal-avatar" : "brand-logo"),
      });
      brand.logo = nextLogo;
      if (previousLogoPath) {
        await removeStoredFileIfExists(resolveStoredAssetPath(previousLogoPath));
      }
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
      badRequest(res, error.message || (brand.profileType === "personal" ? "个人头像上传失败" : "品牌 Logo 上传失败"));
      return true;
    }
    const savedBrand = updateBrand(brand);
    json(res, 200, { brand: sanitizeBrand(savedBrand, appConfig) });
    return true;
  }

  const brandLogoFileMatch = pathname.match(/^\/api\/brands\/(\d+)\/logo\/file$/);
  if (req.method === "GET" && brandLogoFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const brand = findBrandById(Number(brandLogoFileMatch[1]));
    if (!brand?.logo) {
      notFound(res);
      return true;
    }
    try {
      const data = await fsp.readFile(resolveStoredAssetPath(brand.logo.storedPath));
      res.writeHead(200, {
        "Content-Type": brand.logo.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      });
      res.end(data);
    } catch (error) {
      notFound(res);
    }
    return true;
  }

  return false;
}

module.exports = {
  normalizeContentPillars,
  normalizeProfilePayload,
  findMissingProfileField,
  handleBrandRoutes,
};
