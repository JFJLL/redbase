const fsp = require("fs/promises");
const path = require("path");
const { DATA_DIR } = require("../config");
const {
  validateGeneratedAssetInput,
  buildGeneratedAssetFileName,
  MAX_GENERATED_ASSET_BYTES,
} = require("./generated-asset-utils");

function resolveLocalAssetPath(storedPath, dataDir = DATA_DIR) {
  const root = path.resolve(dataDir);
  const filePath = path.resolve(root, String(storedPath || ""));
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid stored asset path");
  }
  return filePath;
}

function createLocalGeneratedAssetStorage(options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const fsPromises = options.fsp || fsp;
  const now = options.now || (() => new Date());
  const randomId = options.randomId;

  return {
    provider: "local",
    isConfigured: () => true,
    async save(input) {
      const assetInput = validateGeneratedAssetInput(input);
      const createdAt = now();
      const year = String(createdAt.getUTCFullYear());
      const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
      const filename = buildGeneratedAssetFileName(
        assetInput.generationId,
        assetInput.variant,
        assetInput.mimeType,
        typeof randomId === "function" ? randomId() : undefined,
      );
      const storedPath = path.join(
        "uploads",
        "generated-images",
        "users",
        String(assetInput.ownerUserId),
        year,
        month,
        String(assetInput.generationId),
        filename,
      );
      const absolutePath = resolveLocalAssetPath(storedPath, dataDir);
      await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fsPromises.writeFile(absolutePath, assetInput.buffer, { flag: "wx" });
      return {
        provider: "local",
        storedPath,
        objectKey: "",
        mimeType: assetInput.mimeType,
        sizeBytes: assetInput.buffer.length,
        createdAt: createdAt.toISOString(),
        bucket: "",
        endpoint: "",
      };
    },
    async delete(asset) {
      if (!asset?.storedPath) return { deleted: false, missing: true };
      try {
        await fsPromises.unlink(resolveLocalAssetPath(asset.storedPath, dataDir));
        return { deleted: true, missing: false };
      } catch (error) {
        if (error?.code === "ENOENT") return { deleted: false, missing: true };
        throw error;
      }
    },
    async deleteMany(assets = []) {
      const results = [];
      for (const asset of assets) results.push(await this.delete(asset));
      return results;
    },
    async createReadUrl() {
      return "";
    },
    async readBuffer(asset) {
      if (!asset?.storedPath) throw Object.assign(new Error("Generated asset not found"), { code: "ENOENT" });
      const absolutePath = resolveLocalAssetPath(asset.storedPath, dataDir);
      const stat = await fsPromises.stat(absolutePath);
      if (stat.size > MAX_GENERATED_ASSET_BYTES) throw Object.assign(new Error("Generated asset exceeds the 60MB limit"), { code: "PAYLOAD_TOO_LARGE" });
      return fsPromises.readFile(absolutePath);
    },
  };
}

module.exports = {
  createLocalGeneratedAssetStorage,
  resolveLocalAssetPath,
};
