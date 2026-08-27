const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("../config");
const {
  validateGeneratedAssetInput,
  validateGeneratedAssetMetadata,
  buildGeneratedAssetFileName,
  resolveGeneratedAssetMaxBytes,
  createAssetTooLargeError,
  doesImageBufferMatchMimeType,
  doesVideoBufferMatchMimeType,
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
  const limits = {
    imageMaxBytes: options.imageMaxBytes,
    videoClipMaxBytes: options.videoClipMaxBytes,
    videoFinalMaxBytes: options.videoFinalMaxBytes,
  };

  async function readFileHeader(filePath) {
    if (typeof fsPromises.open !== "function") {
      const buffer = await fsPromises.readFile(filePath);
      return buffer.subarray(0, 12);
    }
    const handle = await fsPromises.open(filePath, "r");
    try {
      const header = Buffer.alloc(12);
      const result = await handle.read(header, 0, header.length, 0);
      return header.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  function assetMetadata(input, stat) {
    const metadata = validateGeneratedAssetMetadata(input, limits);
    if (Number(stat.size) > metadata.maxBytes) throw createAssetTooLargeError(metadata.maxBytes);
    return metadata;
  }

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
      const assetInput = validateGeneratedAssetInput(input, limits);
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
        variant: assetInput.variant,
        mimeType: assetInput.mimeType,
        sizeBytes: assetInput.buffer.length,
        createdAt: createdAt.toISOString(),
        bucket: "",
        endpoint: "",
      };
    },
    async saveFile(input) {
      const rawSourcePath = String(input?.filePath || "").trim();
      if (!rawSourcePath) throw new Error("Generated asset source file is required");
      const sourcePath = path.resolve(rawSourcePath);
      if (sourcePath === path.parse(sourcePath).root) throw new Error("Generated asset source file is required");
      const stat = await fsPromises.stat(sourcePath);
      const metadata = assetMetadata(input, stat);
      const header = await readFileHeader(sourcePath);
      if (!doesImageBufferMatchMimeType(header, metadata.mimeType) && !doesVideoBufferMatchMimeType(header, metadata.mimeType)) {
        throw new Error("Generated asset content does not match its MIME type");
      }
      const createdAt = now();
      const year = String(createdAt.getUTCFullYear());
      const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
      const filename = buildGeneratedAssetFileName(
        metadata.generationId,
        metadata.variant,
        metadata.mimeType,
        typeof randomId === "function" ? randomId() : undefined,
      );
      const storedPath = path.join(
        "uploads",
        "generated-images",
        "users",
        String(metadata.ownerUserId),
        year,
        month,
        String(metadata.generationId),
        filename,
      );
      const absolutePath = resolveLocalAssetPath(storedPath, dataDir);
      const temporaryPath = `${absolutePath}.tmp-${crypto.randomUUID()}`;
      await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
      try {
        await fsPromises.copyFile(sourcePath, temporaryPath);
        await fsPromises.rename(temporaryPath, absolutePath);
      } catch (error) {
        await fsPromises.unlink(temporaryPath).catch(() => {});
        throw error;
      }
      return {
        provider: "local",
        storedPath,
        objectKey: "",
        variant: metadata.variant,
        mimeType: metadata.mimeType,
        sizeBytes: Number(stat.size),
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
        if (!options.ignoreGrace && (!markerMatch || cleanupNowMs - Number(markerMatch[1]) < DELETION_STAGING_GRACE_MS)) return;
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
    async cleanupUnreferencedAssets(options = {}) {
      const root = path.join(dataDir, "uploads", "generated-images");
      const isReferenced = options.isReferenced || (() => false);
      const cleanupNowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : now().getTime();
      let removed = 0;
      await visitFiles(root, async (filePath) => {
        if (filePath.includes(".delete-stage-")) return;
        const stat = await fsPromises.stat(filePath);
        if (cleanupNowMs - Number(stat.mtimeMs || 0) < DELETION_STAGING_GRACE_MS) return;
        const storedPath = path.relative(dataDir, filePath);
        if (await isReferenced({ provider: "local", storedPath })) return;
        await fsPromises.unlink(filePath);
        removed += 1;
      });
      return { removed };
    },
    async createReadUrl() {
      return "";
    },
    createReadStream(asset, options = {}) {
      if (!asset?.storedPath) throw Object.assign(new Error("Generated asset not found"), { code: "ENOENT" });
      const absolutePath = resolveLocalAssetPath(asset.storedPath, dataDir);
      const fsStream = (options.fs || fs).createReadStream;
      const streamOptions = {};
      if (typeof options.start === "number") streamOptions.start = options.start;
      if (typeof options.end === "number") streamOptions.end = options.end;
      return fsStream(absolutePath, streamOptions);
    },
    async stat(asset) {
      if (!asset?.storedPath) throw Object.assign(new Error("Generated asset not found"), { code: "ENOENT" });
      const absolutePath = resolveLocalAssetPath(asset.storedPath, dataDir);
      return fsPromises.stat(absolutePath);
    },
    async copyToFile(asset, targetPath) {
      if (!asset?.storedPath) throw Object.assign(new Error("Generated asset not found"), { code: "ENOENT" });
      const absolutePath = resolveLocalAssetPath(asset.storedPath, dataDir);
      await fsPromises.mkdir(path.dirname(path.resolve(targetPath)), { recursive: true });
      await fsPromises.copyFile(absolutePath, targetPath);
    },
    async readBuffer(asset, options = {}) {
      if (!asset?.storedPath) throw Object.assign(new Error("Generated asset not found"), { code: "ENOENT" });
      const absolutePath = resolveLocalAssetPath(asset.storedPath, dataDir);
      const stat = await fsPromises.stat(absolutePath);
      const maxBytes = resolveGeneratedAssetMaxBytes({ ...asset, maxBytes: options.maxBytes }, limits);
      if (stat.size > maxBytes) throw createAssetTooLargeError(maxBytes);
      return fsPromises.readFile(absolutePath);
    },
  };
}

module.exports = {
  DELETION_STAGING_GRACE_MS,
  createLocalGeneratedAssetStorage,
  resolveLocalAssetPath,
};
