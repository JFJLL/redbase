const { bindRouteScope } = require("./route-scope");
const { findUserById } = require("../db/repositories/auth-repository");
const { requireAdminFromSql: requireAdmin } = require("./admin-auth");
const { addCredits, deleteUserCascadeRows, readAdminOverviewStore, readUserDeletionAssets } = require("../db/repositories/admin-repository");
const { findGenerationById } = require("../db/repositories/generation-repository");
const { createGeneratedAssetStorage } = require("../assets/generated-asset-storage");
const {
  removeGenerationAssetsAndRows: removeGenerationAssetsAndRowsDefault,
  removeGenerationsAssets: removeGenerationsAssetsDefault,
} = require("../assets/generation-deletion-service");

async function handleAdminRoutes(context, req, res, pathname) {
  const {
    appConfig,
    sanitizeUser,
    removeGenerationAssetsAndRows,
    removeGenerationsAssets,
    resolveStoredProductImagePath,
    resolveStoredAssetPath,
    stageStoredFilesForDeletion,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    isAdminUser,
    buildAdminOverview,
    json,
    notFound,
    badRequest,
    unauthorized,
    forbidden,
  } = bindRouteScope(context);
  const deleteGeneration = removeGenerationAssetsAndRows || ((generation, options = {}) =>
    removeGenerationAssetsAndRowsDefault(generation, {
      ...options,
      storage: createGeneratedAssetStorage(appConfig),
    }));
  const deleteGenerationAssets = removeGenerationsAssets || ((generations, options = {}) =>
    removeGenerationsAssetsDefault(generations, {
      ...options,
      storage: createGeneratedAssetStorage(appConfig),
    }));

  function requireAdminFromSql() {
    return requireAdmin(req, res, { getSessionToken, buildApiUserLog, isAdminUser, appConfig, unauthorized, forbidden });
  }

  if (req.method === "GET" && pathname === "/api/admin/health") {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;
    json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
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

  if (req.method === "GET" && pathname === "/api/admin/overview") {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;
    json(res, 200, buildAdminOverview(readAdminOverviewStore(), appConfig));
    return true;
  }

  const adminCreditMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/credits$/);
  if (req.method === "POST" && adminCreditMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;

    const targetUser = findUserById(Number(adminCreditMatch[1]));
    if (!targetUser) {
      notFound(res);
      return true;
    }

    const payload = await collectBody(req);
    const amount = Math.floor(Number(payload.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      badRequest(res, "请输入大于 0 的加额度数量");
      return true;
    }

    const updatedUser = addCredits({
      targetUserId: targetUser.id,
      amount,
      adminUser,
      note: String(payload.note || "").trim(),
    });
    json(res, 200, {
      user: sanitizeUser(updatedUser),
      overview: buildAdminOverview(readAdminOverviewStore(), appConfig),
    });
    return true;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (req.method === "DELETE" && adminUserMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;

    const targetUserId = Number(adminUserMatch[1]);
    const targetUser = findUserById(targetUserId);
    if (!targetUser) {
      notFound(res);
      return true;
    }
    if (targetUser.id === adminUser.id) {
      badRequest(res, "不能删除当前登录的管理员账号。");
      return true;
    }

    const deletionAssets = readUserDeletionAssets(targetUser.id);
    let generationAssetStage;
    let localAssetStage;
    try {
      generationAssetStage = await deleteGenerationAssets(deletionAssets.generations, { deleteReason: "admin_user_delete" });
      localAssetStage = await stageStoredFilesForDeletion([
        ...deletionAssets.brandLogoStoredPaths.map((storedPath) => resolveStoredAssetPath(storedPath)),
        ...deletionAssets.productImages.map((productImage) => resolveStoredProductImagePath(productImage)),
      ]);
    } catch (error) {
      if (localAssetStage?.rollback) await localAssetStage.rollback().catch(() => {});
      if (generationAssetStage?.rollback) await generationAssetStage.rollback().catch(() => {});
      console.warn("[admin-delete] failed to delete generated assets", {
        userId: targetUser.id,
        errorCode: String(error?.code || "ASSET_DELETE_FAILED"),
        status: Number(error?.status || error?.statusCode || 0) || undefined,
      });
      json(res, 503, { error: "用户生成资产删除暂时失败，请稍后重试" });
      return true;
    }
    try {
      deleteUserCascadeRows(targetUser.id);
    } catch (error) {
      if (localAssetStage?.rollback) await localAssetStage.rollback().catch(() => {});
      if (generationAssetStage?.rollback) await generationAssetStage.rollback().catch(() => {});
      throw error;
    }
    if (generationAssetStage?.commit) await generationAssetStage.commit();
    if (localAssetStage?.commit) await localAssetStage.commit();
    json(res, 200, {
      ok: true,
      deletedUserId: targetUser.id,
      overview: buildAdminOverview(readAdminOverviewStore(), appConfig),
    });
    return true;
  }

  const adminGenerationMatch = pathname.match(/^\/api\/admin\/generations\/(\d+)$/);
  if (req.method === "DELETE" && adminGenerationMatch) {
    const adminUser = requireAdminFromSql();
    if (!adminUser) return true;
    const generation = findGenerationById(Number(adminGenerationMatch[1]));
    if (!generation) {
      notFound(res);
      return true;
    }

    try {
      await deleteGeneration(generation, { deleteReason: "admin_history_delete" });
    } catch (error) {
      console.warn("[admin-delete] failed to delete generation", {
        generationId: generation.id,
        errorCode: String(error?.code || "ASSET_DELETE_FAILED"),
        status: Number(error?.status || error?.statusCode || 0) || undefined,
      });
      json(res, 503, { error: "历史删除暂时失败，请稍后重试" });
      return true;
    }
    json(res, 200, {
      ok: true,
      deletedGenerationId: generation.id,
      overview: buildAdminOverview(readAdminOverviewStore(), appConfig),
    });
    return true;
  }

  return false;
}

module.exports = {
  handleAdminRoutes,
};
