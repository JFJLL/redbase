const path = require("path");
const crypto = require("crypto");
const {
  validateGeneratedAssetInput,
  buildGeneratedAssetFileName,
  isOssObjectNotFoundError,
  MAX_GENERATED_ASSET_BYTES,
} = require("./generated-asset-utils");

const OSS_DELETE_BATCH_LIMIT = 1000;
const DEFAULT_READ_URL_EXPIRY_SECONDS = 300;
const DELETION_STAGING_GRACE_MS = 60 * 60 * 1000;

function encodeStagedObjectKey(objectKey) {
  return Buffer.from(String(objectKey), "utf8").toString("base64url");
}

function decodeStagedObjectKey(stagedKey, stagingPrefix) {
  const relative = String(stagedKey || "").slice(stagingPrefix.length);
  const encoded = relative.split("/").filter(Boolean).at(-1);
  if (!encoded) throw new Error("Invalid staged OSS object key");
  return Buffer.from(encoded, "base64url").toString("utf8");
}

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
    async stageDeleteMany(assets = []) {
      if (typeof client.copy !== "function") throw new Error("OSS client does not support reversible deletion");
      const entries = [];
      const stageId = `v1-${now().getTime()}-${crypto.randomUUID()}`;
      const stagingPrefix = `${path.posix.join(prefix, ".deletion-staging")}/`;
      try {
        for (const asset of assets) {
          if (!asset?.objectKey) continue;
          const objectKey = assertSafeObjectKey(asset.objectKey, prefix);
          const stagedKey = assertSafeObjectKey(
            path.posix.join(prefix, ".deletion-staging", stageId, encodeStagedObjectKey(objectKey)),
            prefix,
          );
          try {
            await client.copy(stagedKey, objectKey);
            entries.push({ objectKey, stagedKey });
          } catch (error) {
            if (!isOssObjectNotFoundError(error)) throw error;
          }
        }
        await this.deleteMany(entries.map((entry) => ({ objectKey: entry.objectKey })));
      } catch (error) {
        let restoreError = null;
        for (const entry of entries) {
          try {
            await client.copy(entry.objectKey, entry.stagedKey);
            await client.delete(entry.stagedKey);
          } catch (entryError) {
            restoreError ||= entryError;
          }
        }
        if (restoreError) throw new AggregateError([error, restoreError], "OSS deletion failed and one or more staged assets could not be restored");
        throw error;
      }
      return {
        deletedAssetCount: entries.length,
        async rollback() {
          for (const entry of entries) {
            await client.copy(entry.objectKey, entry.stagedKey);
            try {
              await client.delete(entry.stagedKey);
            } catch (error) {
              if (!isOssObjectNotFoundError(error)) throw error;
            }
          }
        },
        async commit() {
          for (const entry of entries) {
            try {
              await client.delete(entry.stagedKey);
            } catch (error) {
              if (!isOssObjectNotFoundError(error)) throw error;
            }
          }
        },
      };
    },
    async cleanupDeletionStaging(options = {}) {
      if (typeof client.list !== "function") throw new Error("OSS client does not support staged deletion cleanup");
      const stagingPrefix = `${path.posix.join(prefix, ".deletion-staging")}/`;
      const isReferenced = options.isReferenced || (() => false);
      const cleanupNowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : now().getTime();
      let marker;
      let recovered = 0;
      let removed = 0;
      do {
        const page = await client.list({ prefix: stagingPrefix, marker, "max-keys": OSS_DELETE_BATCH_LIMIT });
        const objects = Array.isArray(page?.objects) ? page.objects : [];
        for (const object of objects) {
          const stagedKey = assertSafeObjectKey(object?.name || object?.key, prefix);
          const relative = stagedKey.slice(stagingPrefix.length);
          const stageId = relative.split("/")[0] || "";
          const markerMatch = stageId.match(/^v1-(\d+)-/);
          if (!markerMatch || cleanupNowMs - Number(markerMatch[1]) < DELETION_STAGING_GRACE_MS) continue;
          const objectKey = assertSafeObjectKey(decodeStagedObjectKey(stagedKey, stagingPrefix), prefix);
          const referenced = await isReferenced({ provider: "aliyun_oss", objectKey });
          if (referenced) {
            await client.copy(objectKey, stagedKey);
            recovered += 1;
          }
          try {
            await client.delete(stagedKey);
          } catch (error) {
            if (!isOssObjectNotFoundError(error)) throw error;
          }
          if (!referenced) removed += 1;
        }
        marker = page?.isTruncated ? page?.nextMarker : undefined;
      } while (marker);
      return { recovered, removed };
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
  DELETION_STAGING_GRACE_MS,
  createAliyunOssGeneratedAssetStorage,
  assertSafeObjectKey,
};
