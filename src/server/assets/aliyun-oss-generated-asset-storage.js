const path = require("path");
const {
  validateGeneratedAssetInput,
  buildGeneratedAssetFileName,
  isOssObjectNotFoundError,
  MAX_GENERATED_ASSET_BYTES,
} = require("./generated-asset-utils");

const OSS_DELETE_BATCH_LIMIT = 1000;
const DEFAULT_READ_URL_EXPIRY_SECONDS = 300;

function createAliyunOssClient(config, dependencies = {}) {
  if (dependencies.client) return dependencies.client;
  const OSS = dependencies.OSS || require("ali-oss");
  return new OSS({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: true,
  });
}

function assertSafeObjectKey(objectKey, prefix) {
  const key = String(objectKey || "");
  if (!key || key.includes("..") || key.includes("\\") || key.startsWith("/") || !key.startsWith(`${prefix}/`)) {
    throw new Error("Invalid OSS object key");
  }
  return key;
}

function createAliyunOssGeneratedAssetStorage(config, dependencies = {}) {
  const prefix = String(config?.prefix || "").replace(/^\/+|\/+$/g, "");
  const client = createAliyunOssClient(config, dependencies);
  const now = dependencies.now || (() => new Date());
  const randomId = dependencies.randomId;

  return {
    provider: "aliyun_oss",
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
      const objectKey = assertSafeObjectKey(
        path.posix.join(
          prefix,
          "generated-images",
          "users",
          String(assetInput.ownerUserId),
          year,
          month,
          String(assetInput.generationId),
          filename,
        ),
        prefix,
      );
      await client.put(objectKey, assetInput.buffer, {
        headers: {
          "Content-Type": assetInput.mimeType,
          "x-oss-forbid-overwrite": "true",
        },
      });
      return {
        provider: "aliyun_oss",
        storedPath: "",
        objectKey,
        mimeType: assetInput.mimeType,
        sizeBytes: assetInput.buffer.length,
        createdAt: createdAt.toISOString(),
        bucket: config.bucket,
        endpoint: config.endpoint,
      };
    },
    async delete(asset) {
      if (!asset?.objectKey) return { deleted: false, missing: true };
      const objectKey = assertSafeObjectKey(asset.objectKey, prefix);
      try {
        await client.delete(objectKey);
        return { deleted: true, missing: false };
      } catch (error) {
        if (isOssObjectNotFoundError(error)) return { deleted: false, missing: true };
        throw error;
      }
    },
    async deleteMany(assets = []) {
      const objectKeys = [...new Set(assets.map((asset) => asset?.objectKey).filter(Boolean))]
        .map((key) => assertSafeObjectKey(key, prefix));
      const results = [];
      for (let offset = 0; offset < objectKeys.length; offset += OSS_DELETE_BATCH_LIMIT) {
        const batch = objectKeys.slice(offset, offset + OSS_DELETE_BATCH_LIMIT);
        if (typeof client.deleteMulti !== "function") {
          for (const objectKey of batch) results.push({ objectKey, ...await this.delete({ objectKey }) });
          continue;
        }
        try {
          const response = await client.deleteMulti(batch, { quiet: false });
          const deletedKeys = Array.isArray(response?.deleted)
            ? new Set(response.deleted.map((item) => String(item?.Key || item?.key || item)))
            : null;
          if (deletedKeys && batch.some((key) => !deletedKeys.has(key))) {
            throw new Error("OSS delete response did not confirm every object");
          }
          results.push(...batch.map((objectKey) => ({ objectKey, deleted: true, missing: false })));
        } catch (error) {
          // A bare batch-level HTTP 404 can mean NoSuchBucket or a wrong endpoint.
          // Only an object-specific OSS code proves that every requested key is absent.
          if (isOssObjectNotFoundError(error)) {
            results.push(...batch.map((objectKey) => ({ objectKey, deleted: false, missing: true })));
            continue;
          }
          throw error;
        }
      }
      return results;
    },
    async createReadUrl(asset, options = {}) {
      if (!asset?.objectKey) throw new Error("Generated asset not found");
      const expires = Math.max(1, Math.min(3600, Number(options.expiresSeconds || DEFAULT_READ_URL_EXPIRY_SECONDS)));
      return client.signatureUrl(assertSafeObjectKey(asset.objectKey, prefix), { method: "GET", expires });
    },
    async readBuffer(asset) {
      if (!asset?.objectKey) throw new Error("Generated asset not found");
      const objectKey = assertSafeObjectKey(asset.objectKey, prefix);
      if (typeof client.head === "function") {
        const metadata = await client.head(objectKey);
        const contentLength = Number(
          metadata?.res?.headers?.["content-length"] || metadata?.res?.headers?.["Content-Length"] || metadata?.meta?.["content-length"] || 0,
        );
        if (contentLength > MAX_GENERATED_ASSET_BYTES) {
          throw Object.assign(new Error("Generated asset exceeds the 60MB limit"), { code: "PAYLOAD_TOO_LARGE" });
        }
      }
      const response = await client.get(objectKey);
      if (!Buffer.isBuffer(response?.content)) throw new Error("OSS object content is unavailable");
      if (response.content.length > MAX_GENERATED_ASSET_BYTES) {
        throw Object.assign(new Error("Generated asset exceeds the 60MB limit"), { code: "PAYLOAD_TOO_LARGE" });
      }
      return response.content;
    },
  };
}

module.exports = {
  OSS_DELETE_BATCH_LIMIT,
  DEFAULT_READ_URL_EXPIRY_SECONDS,
  createAliyunOssGeneratedAssetStorage,
  assertSafeObjectKey,
};
