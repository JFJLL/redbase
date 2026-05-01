const crypto = require("crypto");
const path = require("path");
const { bindRouteScope } = require("./route-scope");
const { DATA_DIR } = require("../config");
const { requireSqlAuth } = require("./sql-auth");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  listProductImagesByOwner,
  findProductImageByOwner,
  findProductImageById,
  findDuplicateProductImage,
  insertProductImage,
  markProductImageDeleted,
} = require("../db/repositories/product-image-repository");

async function handleProductImageRoutes(context, req, res, pathname) {
  const {
    appConfig,
    fsp,
    MAX_PRODUCT_IMAGE_BYTES,
    PRODUCT_IMAGE_MIME_EXTENSIONS,
    parseProductImageDataUrl,
    sanitizeFileName,
    resolveStoredProductImagePath,
    buildProductImageView,
    verifySignedAssetRequest,
    sortProductImages,
    collectBody,
    getSessionToken,
    buildApiUserLog,
    json,
    notFound,
    badRequest,
    unauthorized,
  } = bindRouteScope(context);

  if (req.method === "GET" && pathname === "/api/product-images") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    json(res, 200, {
      images: listProductImagesByOwner(user.id)
        .sort(sortProductImages)
        .map((image) => buildProductImageView(image, appConfig)),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/product-images") {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const payload = await collectBody(req);
    let image;
    let duplicate = false;
    try {
      const parsed = parseProductImageDataUrl(payload?.dataUrl);
      if (parsed.buffer.length > MAX_PRODUCT_IMAGE_BYTES) {
        const maxMb = Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024);
        throw Object.assign(new Error(`产品图过大，请上传 ${maxMb}MB 以内的图片。`), { code: "PAYLOAD_TOO_LARGE" });
      }
      const sha256 = crypto.createHash("sha256").update(parsed.buffer).digest("hex");
      const existing = findDuplicateProductImage(user.id, sha256);
      if (existing) {
        image = existing;
        duplicate = true;
      } else {
        const imageId = allocateCounter("nextProductImageId", 1);
        const now = new Date();
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const ext = PRODUCT_IMAGE_MIME_EXTENSIONS[parsed.mimeType];
        const fileName = `pi_${imageId}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
        const storedPath = path.join("uploads", "product-images", "users", String(user.id), year, month, fileName);
        const absolutePath = path.join(DATA_DIR, storedPath);
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
        await fsp.writeFile(absolutePath, parsed.buffer);
        image = insertProductImage({
          id: imageId,
          ownerUserId: user.id,
          originalName: sanitizeFileName(payload?.name || "product-image"),
          storedPath,
          mimeType: parsed.mimeType,
          sizeBytes: parsed.buffer.length,
          sha256,
          createdAt: now.toISOString(),
          lastUsedAt: "",
          deletedAt: "",
        });
      }
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") throw error;
      badRequest(res, error.message || "产品图上传失败");
      return true;
    }
    json(res, 201, { image: buildProductImageView(image, appConfig), duplicate });
    return true;
  }

  const productImageFileMatch = pathname.match(/^\/api\/product-images\/(\d+)\/file$/);
  if (req.method === "GET" && productImageFileMatch) {
    if (!verifySignedAssetRequest(appConfig, req)) {
      unauthorized(res, "图片链接已失效，请刷新页面后重试");
      return true;
    }
    const image = findProductImageById(Number(productImageFileMatch[1]));
    if (!image) {
      notFound(res);
      return true;
    }
    try {
      const data = await fsp.readFile(resolveStoredProductImagePath(image));
      res.writeHead(200, {
        "Content-Type": image.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      });
      res.end(data);
    } catch (error) {
      notFound(res);
    }
    return true;
  }

  const productImageMatch = pathname.match(/^\/api\/product-images\/(\d+)$/);
  if (req.method === "DELETE" && productImageMatch) {
    const user = requireSqlAuth(req, res, { getSessionToken, buildApiUserLog, unauthorized });
    if (!user) return true;
    const image = findProductImageByOwner(Number(productImageMatch[1]), user.id);
    if (!image) {
      notFound(res);
      return true;
    }
    try {
      await fsp.unlink(resolveStoredProductImagePath(image));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[product-image] failed to remove file", { imageId: image.id, error: error.message });
      }
    }
    const deleted = markProductImageDeleted(image.id, new Date().toISOString());
    json(res, 200, { ok: true, image: buildProductImageView(deleted, appConfig) });
    return true;
  }

  return false;
}

module.exports = {
  handleProductImageRoutes,
};
