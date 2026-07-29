const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("../config");
const {
  validateGeneratedAssetInput,
  buildGeneratedAssetFileName,
  MAX_GENERATED_ASSET_BYTES,
} = require("./generated-asset-utils");

const DELETION_STAGING_GRACE_MS = 60 * 60 * 1000;

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

  async function visitFiles(directory, visitor) {
    let entries;
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visitFiles(entryPath, visitor);
      else await visitor(entryPath);
    }
  }

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
    async stageDeleteMany(assets = []) {
      const staged = [];
      try {
        for (const asset of assets) {
          if (!asset?.storedPath) continue;
          const originalPath = resolveLocalAssetPath(asset.storedPath, dataDir);
          const stagedPath = `${originalPath}.delete-stage-v1-${now().getTime()}-${crypto.randomUUID()}`;
          try {
            await fsPromises.rename(originalPath, stagedPath);
            staged.push({ originalPath, stagedPath });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      } catch (error) {
        for (const entry of staged.reverse()) {
          await fsPromises.rename(entry.stagedPath, entry.originalPath).catch(() => {});
        }
        throw error;
      }
      return {
        deletedAssetCount: staged.length,
        async rollback() {
          for (const entry of staged.slice().reverse()) await fsPromises.rename(entry.stagedPath, entry.originalPath);
        },
        async commit() {
          for (const entry of staged) {
            try {
              await fsPromises.unlink(entry.stagedPath);
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
          }
        },
      };
    },
    async cleanupDeletionStaging(options = {}) {
      const root = path.join(dataDir, "uploads", "generated-images");
      const isReferenced = options.isReferenced || (() => false);
      const cleanupNowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : now().getTime();
      let recovered = 0;
      let removed = 0;
      await visitFiles(root, async (stagedPath) => {
        const markerIndex = stagedPath.lastIndexOf(".delete-stage-");
        if (markerIndex < 0) return;
        const marker = stagedPath.slice(markerIndex + ".delete-stage-".length);
        const markerMatch = marker.match(/^v1-(\d+)-/);
        if (!markerMatch || cleanupNowMs - Number(markerMatch[1]) < DELETION_STAGING_GRACE_MS) return;
        const originalPath = stagedPath.slice(0, markerIndex);
        const storedPath = path.relative(dataDir, originalPath);
        if (await isReferenced({ provider: "local", storedPath })) {
          try {
            await fsPromises.rename(stagedPath, originalPath);
            recovered += 1;
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            await fsPromises.unlink(stagedPath);
            removed += 1;
          }
        } else {
          await fsPromises.unlink(stagedPath);
          removed += 1;
        }
      });
      return { recovered, removed };
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
  DELETION_STAGING_GRACE_MS,
  createLocalGeneratedAssetStorage,
  resolveLocalAssetPath,
};
