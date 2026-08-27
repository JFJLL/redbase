const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { DEFAULT_APP_CONFIG, resolveAssetStorageConfig } = require("../src/server/config");
const { createGeneratedAssetStorage } = require("../src/server/assets/generated-asset-storage");
const {
  createAliyunOssGeneratedAssetStorage,
  DELETION_STAGING_GRACE_MS: OSS_STAGING_GRACE_MS,
} = require("../src/server/assets/aliyun-oss-generated-asset-storage");
const { createLocalGeneratedAssetStorage } = require("../src/server/assets/local-generated-asset-storage");
const { doesImageBufferMatchMimeType } = require("../src/server/assets/generated-asset-utils");
const { assertGenerationAssetOwnership } = require("../src/server/assets/generation-deletion-service");
const { persistGenerationAndCommit, stripClientGeneratedAssetMetadata } = require("../src/server/api/image-generation-routes");
const { sanitizeGeneration, sanitizeIdea, sanitizePayloadForClient, sanitizeTrend } = require("../src/server/utils");
const {
  assertSafeRemoteImageUrl,
  createPinnedImageLookup,
  persistGeneratedImageReference,
  recoverStagedBrandLogoDeletions,
  recoverStagedProductImageDeletions,
  readGeneratedImageResponseBuffer,
  resolveGeneratedImageInputForEdit,
  sanitizeGenerationPayloadUrls,
  serveStoredGeneratedImage,
} = require("../src/server/assets/image-store");

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function completeEnvironment(overrides = {}) {
  return {
    ALIYUN_OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com",
    ALIYUN_OSS_BUCKET: "redmagic",
    ALIYUN_OSS_PREFIX: "/redbase/",
    ALIYUN_OSS_ACCESS_KEY_ID: "id-placeholder",
    ALIYUN_OSS_ACCESS_KEY_SECRET: "secret-placeholder",
    ...overrides,
  };
}

function ossConfig() {
  return {
    endpoint: "https://oss-cn-beijing.aliyuncs.com",
    bucket: "redmagic",
    prefix: "redbase",
    accessKeyId: "id-placeholder",
    accessKeySecret: "secret-placeholder",
  };
}

test("complete environment selects aliyun_oss and overrides local config", () => {
  const config = resolveAssetStorageConfig({
    assetStorage: {
      aliyunOss: {
        endpoint: "https://local.invalid",
        bucket: "local-bucket",
        prefix: "local",
        accessKeyId: "local-id-placeholder",
        accessKeySecret: "local-secret-placeholder",
      },
    },
  }, completeEnvironment(), { warn: false });
  assert.equal(config.provider, "aliyun_oss");
  assert.equal(config.aliyunOss.endpoint, "https://oss-cn-beijing.aliyuncs.com");
  assert.equal(config.aliyunOss.bucket, "redmagic");
  assert.equal(config.aliyunOss.prefix, "redbase");
});

test("explicit local provider wins over complete file-based OSS settings", () => {
  const config = resolveAssetStorageConfig({ assetStorage: { provider: "local", aliyunOss: ossConfig() } }, {});
  assert.equal(config.provider, "local");
});

test("OSS deployment defaults are externalized and the config example uses a placeholder bucket", async () => {
  assert.deepEqual(DEFAULT_APP_CONFIG.assetStorage.aliyunOss, {
    endpoint: "",
    bucket: "",
    prefix: "",
    accessKeyId: "",
    accessKeySecret: "",
  });
  const example = JSON.parse(await fsp.readFile(path.join(__dirname, "..", "config.local.example.json"), "utf8"));
  assert.equal(example.assetStorage.aliyunOss.endpoint, "https://oss-cn-beijing.aliyuncs.com");
  assert.equal(example.assetStorage.aliyunOss.bucket, "your-bucket");
  assert.equal(example.assetStorage.aliyunOss.prefix, "redbase");
  assert.equal(JSON.stringify(example).includes("redmagic"), false);
});

test("incomplete or invalid OSS configuration falls back to local without logging credential values", () => {
  const warnings = [];
  const cases = [
    completeEnvironment({ ALIYUN_OSS_ACCESS_KEY_ID: "" }),
    completeEnvironment({ ALIYUN_OSS_ENDPOINT: "http://oss-cn-beijing.aliyuncs.com" }),
    completeEnvironment({ ALIYUN_OSS_BUCKET: "Bad_Bucket" }),
    completeEnvironment({ ALIYUN_OSS_PREFIX: "redbase/../escape" }),
    completeEnvironment({ ALIYUN_OSS_PREFIX: "redbase//prod" }),
    completeEnvironment({ ALIYUN_OSS_PREFIX: "redbase/./prod" }),
  ];
  for (const env of cases) {
    const config = resolveAssetStorageConfig({}, env, { logger: { warn: (message) => warnings.push(message) } });
    assert.equal(config.provider, "local");
  }
  const output = warnings.join("\n");
  assert.equal(output.includes("id-placeholder"), false);
  assert.equal(output.includes("secret-placeholder"), false);
  assert.equal(output.includes("Authorization"), false);
  assert.match(output, /ALIYUN_OSS_/);
});

test("OSS save uploads a Buffer with safe key and forbid-overwrite header", async () => {
  const calls = [];
  const client = {
    async put(...args) {
      calls.push(args);
      return { res: { status: 200 } };
    },
  };
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client,
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    randomId: () => "abc123",
  });
  const buffer = PNG_BUFFER;
  const asset = await storage.save({ ownerUserId: 12, generationId: 1024, variant: "slide_1", buffer, mimeType: "image/png" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "redbase/generated-images/users/12/2026/07/1024/gi_1024_slide_1_abc123.png");
  assert.strictEqual(calls[0][1], buffer);
  assert.equal(calls[0][2].headers["x-oss-forbid-overwrite"], "true");
  assert.equal(calls[0][2].headers["Content-Type"], "image/png");
  assert.equal(asset.provider, "aliyun_oss");
  assert.equal(asset.storedPath, "");
  assert.equal(asset.objectKey.includes(".."), false);
  assert.equal(JSON.stringify(asset).includes("placeholder"), false);
});

test("image, clip, and final video limits are independent for local and OSS storage", async () => {
  const image150 = Buffer.concat([PNG_BUFFER, Buffer.alloc(141)]);
  const video150 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(142)]);
  const localDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-video-size-limits-"));
  const limits = { imageMaxBytes: 100, videoClipMaxBytes: 300, videoFinalMaxBytes: 800 };
  const local = createLocalGeneratedAssetStorage({ dataDir: localDir, ...limits, randomId: () => "local-size" });
  const ossCalls = [];
  const oss = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    ...limits,
    randomId: () => "oss-size",
    client: {
      async put(...args) { ossCalls.push({ method: "put", args }); },
      async putStream(...args) {
        const chunks = [];
        for await (const chunk of args[1]) chunks.push(chunk);
        ossCalls.push({ method: "putStream", key: args[0], bytes: Buffer.concat(chunks).length });
      },
    },
  });
  try {
    for (const storage of [local, oss]) {
      await assert.rejects(
        storage.save({ ownerUserId: 1, generationId: 2, variant: "image", mimeType: "image/png", buffer: image150 }),
        (error) => error.code === "PAYLOAD_TOO_LARGE" && error.maxBytes === 100,
      );
      const clip = await storage.save({ ownerUserId: 1, generationId: 2, variant: "clip-1", mimeType: "video/mp4", buffer: video150 });
      const final = await storage.save({ ownerUserId: 1, generationId: 2, variant: "final", mimeType: "video/mp4", buffer: Buffer.concat([video150, Buffer.alloc(350)]) });
      assert.equal(clip.sizeBytes, 150);
      assert.equal(final.sizeBytes, 500);
      await assert.rejects(
        storage.save({ ownerUserId: 1, generationId: 2, variant: "clip-too-large", mimeType: "video/mp4", buffer: Buffer.concat([video150, Buffer.alloc(151)]) }),
        (error) => error.code === "PAYLOAD_TOO_LARGE" && error.maxBytes === 300,
      );
    }

    const sourcePath = path.join(localDir, "source.mp4");
    await fsp.writeFile(sourcePath, video150);
    const localFile = await local.saveFile({ ownerUserId: 1, generationId: 3, variant: "clip-file", mimeType: "video/mp4", filePath: sourcePath });
    assert.equal(localFile.sizeBytes, 150);
    assert.deepEqual(await local.readBuffer(localFile), video150);
    const ossFile = await oss.saveFile({ ownerUserId: 1, generationId: 3, variant: "clip-file", mimeType: "video/mp4", filePath: sourcePath });
    assert.equal(ossFile.sizeBytes, 150);
    assert.equal(ossCalls.at(-1).method, "putStream");
    assert.equal(ossCalls.at(-1).bytes, 150);
  } finally {
    await fsp.rm(localDir, { recursive: true, force: true });
  }
});

test("OSS upload failure rejects without manufacturing asset metadata", async () => {
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client: { put: async () => { throw Object.assign(new Error("upload unavailable"), { status: 500 }); } },
  });
  await assert.rejects(
    storage.save({ ownerUserId: 1, generationId: 2, variant: "main", buffer: PNG_BUFFER, mimeType: "image/png" }),
    /upload unavailable/,
  );
});

test("generation persistence failure keeps the upstream URL and records persistError without fake objectKey", async () => {
  const upstreamUrl = "https://temporary.invalid/generated.png";
  const target = { imageUrl: upstreamUrl, previewUrl: upstreamUrl };
  const result = await persistGeneratedImageReference({
    ownerUserId: 1,
    generationId: 2,
    target,
    remoteUrl: upstreamUrl,
    variant: "main",
    localUrl: "/api/generated-images/2/file",
    downloadImage: async () => ({ buffer: Buffer.from("image"), mimeType: "image/png" }),
    storage: { save: async () => { throw new Error("asset persistence unavailable"); } },
  });
  assert.equal(result, null);
  assert.equal(target.imageUrl, upstreamUrl);
  assert.equal(target.previewUrl, upstreamUrl);
  assert.match(target.persistError, /asset persistence unavailable/);
  assert.equal(target.localImage, undefined);
  assert.equal(JSON.stringify(target).includes("objectKey"), false);
});

test("base64 image results are persisted as local generated assets", async () => {
  const dataUrl = `data:image/png;base64,${PNG_BUFFER.toString("base64")}`;
  const target = { imageUrl: dataUrl, previewUrl: dataUrl };
  let savedInput = null;
  const result = await persistGeneratedImageReference({
    ownerUserId: 1,
    generationId: 2,
    target,
    remoteUrl: dataUrl,
    variant: "main",
    localUrl: "/api/generated-images/2/file",
    storage: {
      save: async (input) => {
        savedInput = input;
        return { provider: "local", storedPath: "uploads/generated-images/users/1/main.png", mimeType: input.mimeType };
      },
    },
  });
  assert.equal(result.provider, "local");
  assert.deepEqual(savedInput.buffer, PNG_BUFFER);
  assert.equal(savedInput.mimeType, "image/png");
  assert.equal(target.imageUrl, "/api/generated-images/2/file");
  assert.equal(target.previewUrl, "/api/generated-images/2/file");
});

test("database failure after upload deletes only assets created by that persistence attempt", async () => {
  const generation = {
    id: 42,
    ownerUserId: 7,
    payload: {
      previous: { objectKey: "redbase/generated-images/users/7/2026/07/42/gi_42_old.png", provider: "aliyun_oss" },
    },
  };
  const deleted = [];
  await assert.rejects(
    persistGenerationAndCommit(generation, {
      persistGenerationImages: async (target) => {
        target.payload.created = {
          objectKey: "redbase/generated-images/users/7/2026/07/42/gi_42_new.png",
          provider: "aliyun_oss",
        };
      },
      generatedAssetStorage: {
        stageDeleteMany: async (assets) => ({
          commit: async () => deleted.push(...assets),
          rollback: async () => {},
        }),
      },
      commit: async () => { throw new Error("database unavailable"); },
    }),
    /database unavailable/,
  );
  assert.deepEqual(deleted.map((asset) => asset.objectKey), ["redbase/generated-images/users/7/2026/07/42/gi_42_new.png"]);
});

test("successful database commit restores newly uploaded assets from reversible staging", async () => {
  const generation = { id: 43, ownerUserId: 7, payload: {} };
  const calls = [];
  const result = await persistGenerationAndCommit(generation, {
    persistGenerationImages: async (target) => {
      target.payload.localImage = { provider: "local", storedPath: "uploads/generated-images/users/7/2026/07/43/gi_43_main_new.png" };
    },
    generatedAssetStorage: {
      stageDeleteMany: async (assets) => {
        calls.push(["stage", assets.length]);
        return {
          commit: async () => calls.push(["discard"]),
          rollback: async () => calls.push(["restore"]),
        };
      },
    },
    commit: async () => ({ saved: true }),
  });
  assert.deepEqual(result, { saved: true });
  assert.deepEqual(calls, [["stage", 1], ["restore"]]);
});

test("OSS ambiguous delete keeps its only staging backup when restore fails", async () => {
  const originalKey = "redbase/generated-images/users/1/2026/07/2/main.png";
  const objects = new Map([[originalKey, Buffer.from("asset")]]);
  const client = {
    async copy(target, source) {
      if (target === originalKey && source.includes("/.deletion-staging/")) throw new Error("restore unavailable");
      if (!objects.has(source)) throw Object.assign(new Error("missing"), { status: 404, code: "NoSuchKey" });
      objects.set(target, objects.get(source));
    },
    async deleteMulti(keys) {
      keys.forEach((key) => objects.delete(key));
      throw new Error("delete response lost");
    },
    async delete(key) { objects.delete(key); },
  };
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), { client });
  await assert.rejects(storage.stageDeleteMany([{ provider: "aliyun_oss", objectKey: originalKey }]), /could not be restored/);
  assert.equal(objects.has(originalKey), false);
  assert.equal([...objects.keys()].some((key) => key.includes("/.deletion-staging/")), true);
});

test("daily OSS staging cleanup restores referenced objects and removes unreferenced backups", async () => {
  const referencedKey = "redbase/generated-images/users/1/2026/07/2/referenced.png";
  const orphanKey = "redbase/generated-images/users/1/2026/07/2/orphan.png";
  const encode = (key) => Buffer.from(key, "utf8").toString("base64url");
  const cleanupNowMs = OSS_STAGING_GRACE_MS + 10;
  const staged = [referencedKey, orphanKey].map((key) => `redbase/.deletion-staging/v1-1-run/${encode(key)}`);
  const activeKey = "redbase/generated-images/users/1/2026/07/2/active.png";
  staged.push(`redbase/.deletion-staging/v1-${cleanupNowMs}-run/${encode(activeKey)}`);
  const objects = new Map(staged.map((key) => [key, Buffer.from(key)]));
  const client = {
    async list() { return { objects: [...objects.keys()].filter((key) => key.includes("/.deletion-staging/")).map((name) => ({ name })), isTruncated: false }; },
    async copy(target, source) { objects.set(target, objects.get(source)); },
    async delete(key) { objects.delete(key); },
  };
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), { client });
  assert.deepEqual(await storage.cleanupDeletionStaging({
    nowMs: cleanupNowMs,
    isReferenced: (asset) => asset.objectKey === referencedKey,
  }), { recovered: 1, removed: 1 });
  assert.equal(objects.has(referencedKey), true);
  assert.equal(objects.has(orphanKey), false);
  assert.equal([...objects.keys()].some((key) => key.includes(`/${encode(activeKey)}`)), true, "active staging must survive cleanup");
  assert.deepEqual(await storage.cleanupDeletionStaging({ nowMs: cleanupNowMs, ignoreGrace: true, isReferenced: () => false }), { recovered: 0, removed: 1 });
  assert.equal([...objects.keys()].some((key) => key.includes("/.deletion-staging/")), false, "startup recovery may process active markers before serving requests");
});

test("local staging cleanup retries a failed commit and removes the hidden copy", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-local-stage-cleanup-"));
  const storedPath = path.join("uploads", "generated-images", "users", "1", "2026", "07", "2", "main.png");
  const originalPath = path.join(dataDir, storedPath);
  await fsp.mkdir(path.dirname(originalPath), { recursive: true });
  await fsp.writeFile(originalPath, PNG_BUFFER);
  let failStagedUnlink = true;
  let nowMs = 1_000;
  const storage = createLocalGeneratedAssetStorage({
    dataDir,
    now: () => new Date(nowMs),
    fsp: {
      ...fsp,
      async unlink(filePath) {
        if (failStagedUnlink && String(filePath).includes(".delete-stage-")) {
          failStagedUnlink = false;
          throw Object.assign(new Error("file busy"), { code: "EBUSY" });
        }
        return fsp.unlink(filePath);
      },
    },
  });
  try {
    const stage = await storage.stageDeleteMany([{ provider: "local", storedPath }]);
    await assert.rejects(stage.commit(), /file busy/);
    assert.deepEqual(await storage.cleanupDeletionStaging({ nowMs, isReferenced: () => false }), { recovered: 0, removed: 0 });
    assert.deepEqual(await storage.cleanupDeletionStaging({ nowMs, ignoreGrace: true, isReferenced: () => false }), { recovered: 0, removed: 1 });
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("local orphan cleanup removes only old unreferenced generated originals", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-local-orphans-"));
  const oldStoredPath = path.join("uploads", "generated-images", "users", "1", "2026", "07", "2", "old.png");
  const freshStoredPath = path.join("uploads", "generated-images", "users", "1", "2026", "07", "3", "fresh.png");
  for (const storedPath of [oldStoredPath, freshStoredPath]) {
    const filePath = path.join(dataDir, storedPath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, PNG_BUFFER);
  }
  const nowMs = Date.now();
  await fsp.utimes(path.join(dataDir, oldStoredPath), new Date(1), new Date(1));
  const storage = createLocalGeneratedAssetStorage({ dataDir });
  try {
    assert.deepEqual(await storage.cleanupUnreferencedAssets({ nowMs, isReferenced: () => false }), { removed: 1 });
    await assert.rejects(fsp.stat(path.join(dataDir, oldStoredPath)), { code: "ENOENT" });
    assert.equal((await fsp.stat(path.join(dataDir, freshStoredPath))).isFile(), true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("OSS orphan cleanup removes only old unreferenced generated originals", async () => {
  const nowMs = Date.now();
  const oldKey = "redbase/generated-images/users/1/2026/07/2/old.png";
  const freshKey = "redbase/generated-images/users/1/2026/07/3/fresh.png";
  const deleted = [];
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client: {
      async list() {
        return {
          objects: [
            { name: oldKey, lastModified: new Date(1).toISOString() },
            { name: freshKey, lastModified: new Date(nowMs).toISOString() },
          ],
          isTruncated: false,
        };
      },
      async delete(key) { deleted.push(key); },
    },
  });
  assert.deepEqual(await storage.cleanupUnreferencedAssets({ nowMs, isReferenced: () => false }), { removed: 1 });
  assert.deepEqual(deleted, [oldKey]);
});

test("signed upstream query credentials are neither persisted nor returned to clients", async () => {
  const signedUrl = "https://provider.invalid/generated.png?OSSAccessKeyId=id-placeholder&Signature=signature-placeholder&sig=sig-placeholder&access=access-placeholder&Expires=1&authToken=auth-placeholder&refreshToken=refresh-placeholder&width=100#fragment";
  const failedTarget = {
    imageUrl: signedUrl,
    previewUrl: "https://provider.invalid/preview.png?token=preview-placeholder",
    sourceImageUrl: "https://provider.invalid/source.png?token=source-placeholder",
    nested: { providerResultUrl: "https://provider.invalid/result.png?Signature=nested-placeholder" },
    source: { url: signedUrl },
    original: { url: signedUrl },
    providerResult: { url: signedUrl },
  };
  await persistGeneratedImageReference({
    ownerUserId: 1,
    generationId: 2,
    target: failedTarget,
    remoteUrl: signedUrl,
    variant: "main",
    localUrl: "/api/generated-images/2/file",
    downloadImage: async () => ({ buffer: PNG_BUFFER, mimeType: "image/png" }),
    storage: { save: async () => { throw new Error("persist failed"); } },
  });
  assert.equal(failedTarget.imageUrl, "https://provider.invalid/generated.png?width=100");
  assert.equal(failedTarget.previewUrl, "https://provider.invalid/generated.png?width=100");
  assert.equal(failedTarget.sourceImageUrl, undefined);
  assert.deepEqual(failedTarget.nested, {});
  assert.equal(failedTarget.source, undefined);
  assert.equal(failedTarget.original, undefined);
  assert.equal(failedTarget.providerResult, undefined);
  assert.equal(JSON.stringify(failedTarget).includes("signature-placeholder"), false);
  assert.equal(JSON.stringify(failedTarget).includes("auth-placeholder"), false);
  assert.equal(JSON.stringify(failedTarget).includes("refresh-placeholder"), false);

  const clientPayload = sanitizePayloadForClient({
    originalImageUrl: signedUrl,
    nested: { sourceImageUrl: signedUrl, url: signedUrl, imageUrls: [signedUrl] },
    source: { url: signedUrl },
    original: { url: signedUrl },
    providerResult: { url: signedUrl },
  });
  assert.equal(JSON.stringify(clientPayload).includes("id-placeholder"), false);
  assert.equal(JSON.stringify(clientPayload).includes("signature-placeholder"), false);
});

test("client URL sanitation removes authority credentials and top-level preview signatures", () => {
  const sanitized = sanitizeGeneration({
    id: 1,
    previewUrl: "https://alice:credential-placeholder@provider.invalid/x.png?Signature=top-secret&width=100",
    payload: {},
  });
  assert.equal(sanitized.previewUrl, "https://provider.invalid/x.png?width=100");
  assert.equal(
    sanitizePayloadForClient({ imageUrl: "https://alice:credential-placeholder@provider.invalid/x.png?height=20" }).imageUrl,
    "https://provider.invalid/x.png?height=20",
  );
});

test("client payload sanitation removes nested storage metadata and credential aliases", () => {
  const payload = {
    publishTitle: "safe title",
    bucketKey: "xhs",
    stableKey: "stable-1",
    sourceKey: "source-1",
    slides: [{ title: "safe slide", pageRoleKey: "cover", imageUrl: "/api/generated-images/1/file?sig=secret&width=10" }],
    localImage: {
      provider: "aliyun_oss",
      objectKey: "redbase/generated-images/users/1/2026/07/2/gi_2_main_x.png",
      storedPath: "uploads/generated-images/users/1/2026/07/2/gi_2_main_x.png",
      bucket: "redmagic",
      endpoint: "https://oss-cn-beijing.aliyuncs.com",
      accessKeyId: "id-placeholder",
      access_key_secret: "secret-placeholder",
      authorization: "authorization-placeholder",
      credential: "credential-placeholder",
      signature: "signature-placeholder",
      mimeType: "image/png",
      sizeBytes: 123,
    },
    nested: {
      ApiKey: "api-placeholder",
      client_secret: "client-placeholder",
      secretKey: "secret-key-placeholder",
      securityToken: "security-placeholder",
      sts_token: "sts-placeholder",
      privateKey: "private-placeholder",
      sessionToken: "session-placeholder",
    },
    moreNested: {
      "x-api-key": "x-api-placeholder",
      "x-goog-api-key": "goog-placeholder",
      "x-auth-token": "auth-placeholder",
      id_token: "id-token-placeholder",
      oauth_token: "oauth-placeholder",
      bearerToken: "bearer-placeholder",
      jwtToken: "jwt-placeholder",
      accountKey: "account-placeholder",
      "subscription-key": "subscription-placeholder",
      serviceAccountKey: "service-account-placeholder",
      connectionString: "connection-placeholder",
      customToken: "custom-token-placeholder",
      signingKey: "signing-key-placeholder",
    },
    generated_asset: { mimeType: "image/png", createdAt: "2026-07-29T00:00:00.000Z" },
  };
  const expected = {
    publishTitle: "safe title",
    bucketKey: "xhs",
    stableKey: "stable-1",
    sourceKey: "source-1",
    slides: [{ title: "safe slide", pageRoleKey: "cover", imageUrl: "/api/generated-images/1/file?width=10" }],
  };
  const defaultSanitized = sanitizePayloadForClient(payload);
  assert.deepEqual(defaultSanitized, expected);
  const legacyThirdArgumentSanitized = sanitizePayloadForClient(payload, "", { allowUnknownBusinessKeys: true });
  assert.deepEqual(legacyThirdArgumentSanitized, expected);
  for (const [mode, sanitized] of [["default", defaultSanitized], ["legacy-third-argument", legacyThirdArgumentSanitized]]) {
    const text = JSON.stringify(sanitized).toLowerCase();
    for (const marker of ["objectkey", "storedpath", "redmagic", "accesskey", "secret-placeholder", "authorization", "credential", "signature", "api-placeholder", "client-placeholder", "security-placeholder", "sts-placeholder", "private-placeholder", "session-placeholder", "x-api-placeholder", "goog-placeholder", "auth-placeholder", "id-token-placeholder", "oauth-placeholder", "bearer-placeholder", "jwt-placeholder", "account-placeholder", "subscription-placeholder", "service-account-placeholder", "connection-placeholder", "custom-token-placeholder", "signing-key-placeholder", "generated_asset"]) {
      assert.equal(text.includes(marker), false, `${mode}:${marker}`);
    }
  }
});

test("client payload allowlist preserves known idea assets and evidence metrics", () => {
  const contentAssets = {
    moments: { title: "moments", caption: "caption", visualDirection: "visual" },
    xhsCarousel: {
      title: "carousel",
      publishTitle: "publish",
      publishCaption: "caption",
      slides: [{ pageLabel: "第 1 张", title: "slide", copy: "copy", visualDirection: "visual" }],
    },
    wechatLongImage: {
      title: "wechat",
      publishTitle: "publish",
      intro: "intro",
      outline: ["one", "two", "three"],
      positioning: "positioning",
      cta: "cta",
      visualDirection: "visual",
    },
  };
  assert.deepEqual(sanitizeIdea({ title: "idea", contentAssets }).contentAssets, contentAssets);

  const metrics = {
    readCount: 10,
    likeCount: 9,
    favoriteCount: 8,
    commentCount: 7,
    shareCount: 6,
    engagementCount: 5,
  };
  const sanitized = sanitizeTrend({ evidence: [{ metrics }], ideas: [] });
  assert.deepEqual(sanitized.evidence[0].metrics, metrics);
});

test("successful persistence stores only the RedBase route and generated asset metadata", async () => {
  const target = { imageUrl: "https://provider.invalid/generated.png?token=temporary" };
  await persistGeneratedImageReference({
    ownerUserId: 7,
    generationId: 88,
    target,
    remoteUrl: target.imageUrl,
    variant: "main",
    localUrl: "/api/generated-images/88/file",
    downloadImage: async () => ({ buffer: PNG_BUFFER, mimeType: "image/png" }),
    storage: {
      save: async () => ({
        provider: "aliyun_oss",
        objectKey: "redbase/generated-images/users/7/2026/07/88/gi_88_main_x.png",
        storedPath: "",
        mimeType: "image/png",
      }),
    },
  });
  assert.equal(target.imageUrl, "/api/generated-images/88/file");
  assert.equal(target.originalImageUrl, undefined);
  assert.equal(JSON.stringify(target).includes("provider.invalid"), false);
});

test("client carousel metadata is stripped so a forged in-scope objectKey cannot bypass save", async () => {
  const incoming = stripClientGeneratedAssetMetadata({
    upstream: { foo: { url: "https://provider.invalid/top.png?Signature=top-placeholder", imageUrls: ["https://provider.invalid/top.png?authToken=top-placeholder"] } },
    foo: {
      imageUrl: "https://evil.invalid/nested.png?Signature=nested-placeholder",
      previewUrl: "https://evil.invalid/nested.png?token=nested-placeholder",
      slides: [{ imageUrl: "https://evil.invalid/bypass.png?access=bypass-placeholder" }],
    },
    slides: [{
      imageUrl: "https://provider.invalid/slide.png",
      previewUrl: "https://provider.invalid/slide-preview.png",
      localImage: {
        provider: "aliyun_oss",
        objectKey: "redbase/generated-images/users/7/2026/07/88/gi_88_main_FAKE.png",
        bucket: "redmagic",
        endpoint: "https://oss-cn-beijing.aliyuncs.com",
      },
      sourceImageUrl: "https://provider.invalid/source.png?token=source-placeholder",
      providerResultUrl: "https://provider.invalid/result.png?Signature=result-placeholder",
      source: { url: "https://provider.invalid/source.png?authToken=source-placeholder" },
      original: { url: "https://provider.invalid/original.png?refreshToken=original-placeholder" },
      providerResult: { url: "https://provider.invalid/result.png?Credential=result-placeholder" },
      upstream: {
        imageUrl: "https://evil.invalid/upstream.png?Credential=upstream-placeholder",
        slides: [{ previewUrl: "https://evil.invalid/bypass.png?access=nested-bypass-placeholder" }],
      },
    }],
  });
  assert.equal(incoming.slides[0].localImage, undefined);
  assert.equal(incoming.slides[0].sourceImageUrl, undefined);
  assert.equal(incoming.slides[0].providerResultUrl, undefined);
  assert.equal(incoming.slides[0].source, undefined);
  assert.equal(incoming.slides[0].original, undefined);
  assert.equal(incoming.slides[0].providerResult, undefined);
  assert.deepEqual(incoming.upstream, { foo: {} });
  assert.deepEqual(incoming.foo, { slides: [{}] });
  assert.equal(incoming.slides[0].imageUrl, "https://provider.invalid/slide.png");
  assert.equal(incoming.slides[0].previewUrl, "https://provider.invalid/slide-preview.png");
  assert.deepEqual(incoming.slides[0].upstream, { slides: [{}] });
  let saveCalled = false;
  await persistGeneratedImageReference({
    ownerUserId: 7,
    generationId: 88,
    target: incoming.slides[0],
    remoteUrl: incoming.slides[0].imageUrl,
    variant: "slide_1",
    localUrl: "/api/generated-images/88/slides/0/file",
    downloadImage: async () => ({ buffer: PNG_BUFFER, mimeType: "image/png" }),
    storage: {
      save: async () => {
        saveCalled = true;
        return { provider: "local", storedPath: "uploads/generated-images/users/7/2026/07/88/gi_88_slide_1_x.png" };
      },
    },
  });
  assert.equal(saveCalled, true);
});

test("whole generation payload URL whitelist removes top-level and nested upstream URL arrays", () => {
  const signed = "https://provider.invalid/source.png?Signature=signature-placeholder&authToken=auth-placeholder";
  const payload = {
    imageUrl: "/api/generated-images/88/file",
    previewUrl: "/api/generated-images/88/file",
    upstream: { foo: { url: signed, imageUrls: [signed] } },
    slides: [
      { imageUrl: "/api/generated-images/88/slides/0/file", previewUrl: "/api/generated-images/88/slides/0/file" },
      { imageUrl: signed, previewUrl: signed, persistError: "save failed", source: { url: signed } },
    ],
  };
  sanitizeGenerationPayloadUrls(payload, 88);
  assert.deepEqual(payload.upstream, { foo: {} });
  assert.equal(payload.slides[0].imageUrl, "/api/generated-images/88/slides/0/file");
  assert.equal(payload.slides[1].imageUrl, "https://provider.invalid/source.png");
  assert.equal(payload.slides[1].previewUrl, "https://provider.invalid/source.png");
  assert.equal(payload.slides[1].source, undefined);
  assert.equal(JSON.stringify(payload).includes("signature-placeholder"), false);
  assert.equal(JSON.stringify(payload).includes("auth-placeholder"), false);
});

test("OSS creates a 300-second signed read URL and reads object bytes for editing", async () => {
  const calls = [];
  const client = {
    signatureUrl(key, options) {
      calls.push({ key, options });
      return "https://signed.invalid/read";
    },
    async get(key) {
      calls.push({ get: key });
      return { content: Buffer.from("oss-image") };
    },
  };
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), { client });
  const asset = { provider: "aliyun_oss", objectKey: "redbase/generated-images/users/1/2026/07/2/gi_2_main_x.png", mimeType: "image/png" };
  assert.equal(await storage.createReadUrl(asset, { expiresSeconds: 300 }), "https://signed.invalid/read");
  assert.equal(calls[0].options.expires, 300);
  assert.deepEqual(await storage.readBuffer(asset), Buffer.from("oss-image"));
});

test("generated asset MIME must match image magic bytes", () => {
  assert.equal(doesImageBufferMatchMimeType(PNG_BUFFER, "image/png"), true);
  assert.equal(doesImageBufferMatchMimeType(Buffer.from("<script>alert(1)</script>"), "image/png"), false);
  assert.equal(doesImageBufferMatchMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
  assert.equal(doesImageBufferMatchMimeType(Buffer.from("GIF89a"), "image/gif"), true);
  assert.equal(doesImageBufferMatchMimeType(Buffer.from("RIFFxxxxWEBP"), "image/webp"), true);
});

test("streamed remote images stop at the byte limit without buffering the complete response", async () => {
  let readCount = 0;
  let cancelled = false;
  const reader = {
    async read() {
      readCount += 1;
      if (readCount <= 3) return { done: false, value: Uint8Array.from([1, 2]) };
      return { done: true };
    },
    async cancel() { cancelled = true; },
    releaseLock() {},
  };
  await assert.rejects(readGeneratedImageResponseBuffer({ body: { getReader: () => reader } }, 5), /超过保存上限/);
  assert.equal(readCount, 3);
  assert.equal(cancelled, true);
});

test("remote image socket lookup reuses only the DNS addresses validated for that hop", async () => {
  let dnsCalls = 0;
  const target = await assertSafeRemoteImageUrl("https://images.example.invalid/x.png", async () => {
    dnsCalls += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  });
  let socketAddress = "";
  createPinnedImageLookup(target.addresses)(target.parsed.hostname, {}, (error, address, family) => {
    assert.ifError(error);
    socketAddress = address;
    assert.equal(family, 4);
  });
  assert.equal(dnsCalls, 1);
  assert.equal(socketAddress, "93.184.216.34");
  assert.equal(target.parsed.hostname, "images.example.invalid");
});

test("startup recovery restores referenced staged logos and removes unreferenced staging files", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-logo-recovery-"));
  const root = path.join(dataDir, "uploads", "brand-logos", "users", "1");
  await fsp.mkdir(root, { recursive: true });
  const referencedOriginal = path.join(root, "referenced.png");
  const orphanOriginal = path.join(root, "orphan.png");
  await fsp.writeFile(`${referencedOriginal}.deleting-1-1`, PNG_BUFFER);
  await fsp.writeFile(`${orphanOriginal}.deleting-1-2`, PNG_BUFFER);
  try {
    const result = await recoverStagedBrandLogoDeletions({
      dataDir,
      root: path.join(dataDir, "uploads", "brand-logos"),
      isReferenced: (storedPath) => storedPath.replace(/\\/g, "/").endsWith("referenced.png"),
    });
    assert.deepEqual(result, { recovered: 1, removed: 1 });
    assert.equal((await fsp.stat(referencedOriginal)).isFile(), true);
    await assert.rejects(fsp.stat(`${orphanOriginal}.deleting-1-2`), { code: "ENOENT" });
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery restores referenced staged product images", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-product-recovery-"));
  const root = path.join(dataDir, "uploads", "product-images");
  const original = path.join(root, "users", "7", "product.png");
  const staged = `${original}.deleting-1-1`;
  await fsp.mkdir(path.dirname(original), { recursive: true });
  await fsp.writeFile(staged, PNG_BUFFER);
  try {
    assert.deepEqual(await recoverStagedProductImageDeletions({
      dataDir,
      isReferenced: (storedPath) => storedPath.replace(/\\/g, "/").endsWith("product.png"),
    }), { recovered: 1, removed: 0 });
    assert.equal((await fsp.stat(original)).isFile(), true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("OSS edit read checks object size before downloading content", async () => {
  let getCalled = false;
  const storage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client: {
      async head() { return { res: { headers: { "content-length": String(60 * 1024 * 1024 + 1) } } }; },
      async get() { getCalled = true; return { content: PNG_BUFFER }; },
    },
  });
  await assert.rejects(
    storage.readBuffer({ objectKey: "redbase/generated-images/users/1/2026/07/2/main.png" }),
    { code: "PAYLOAD_TOO_LARGE" },
  );
  assert.equal(getCalled, false);
});

test("OSS 404 deletion is success while non-404 deleteMulti failure is propagated", async () => {
  const asset = { provider: "aliyun_oss", objectKey: "redbase/generated-images/users/1/2026/07/2/main.png" };
  const missingStorage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client: { deleteMulti: async () => { throw Object.assign(new Error("missing"), { status: 404, code: "NoSuchKey" }); } },
  });
  assert.deepEqual(await missingStorage.deleteMany([asset]), [{ objectKey: asset.objectKey, deleted: false, missing: true }]);

  for (const error of [
    Object.assign(new Error("bare 404"), { status: 404 }),
    Object.assign(new Error("bucket missing"), { status: 404, code: "NoSuchBucket" }),
  ]) {
    const unsafeMissingStorage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
      client: { deleteMulti: async () => { throw error; } },
    });
    await assert.rejects(unsafeMissingStorage.deleteMany([asset]), error);
  }

  const failingStorage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
    client: { deleteMulti: async () => { throw Object.assign(new Error("service unavailable"), { status: 500 }); } },
  });
  await assert.rejects(failingStorage.deleteMany([asset]), /service unavailable/);

  for (const error of [
    Object.assign(new Error("single bare 404"), { status: 404 }),
    Object.assign(new Error("single bucket missing"), { status: 404, code: "NoSuchBucket" }),
  ]) {
    const unsafeSingleStorage = createAliyunOssGeneratedAssetStorage(ossConfig(), {
      client: { delete: async () => { throw error; } },
    });
    await assert.rejects(unsafeSingleStorage.delete(asset), error);
  }
});

test("facade deletes mixed OSS and legacy local assets in OSS-first order", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-mixed-assets-"));
  const localPath = path.join("uploads", "generated-images", "users", "1", "2026", "07", "legacy.png");
  await fsp.mkdir(path.dirname(path.join(tempDir, localPath)), { recursive: true });
  await fsp.writeFile(path.join(tempDir, localPath), "legacy");
  const order = [];
  const facade = createGeneratedAssetStorage(
    { assetStorage: { provider: "aliyun_oss", aliyunOss: ossConfig() } },
    {
      local: {
        dataDir: tempDir,
        fsp: {
          ...fsp,
          async unlink(filePath) {
            order.push("local");
            return fsp.unlink(filePath);
          },
        },
      },
      aliyunOss: {
        client: {
          async deleteMulti(keys) {
            order.push("oss");
            return { deleted: keys.map((Key) => ({ Key })) };
          },
        },
      },
    },
  );
  try {
    await facade.deleteMany([
      { provider: "local", storedPath: localPath },
      { provider: "aliyun_oss", objectKey: "redbase/generated-images/users/1/2026/07/2/main.png" },
    ]);
    assert.deepEqual(order, ["oss", "local"]);
    await assert.rejects(fsp.stat(path.join(tempDir, localPath)), { code: "ENOENT" });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("facade reads legacy local history while OSS is selected for new saves", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "redbase-local-read-"));
  const storedPath = path.join("uploads", "generated-images", "users", "1", "legacy.png");
  await fsp.mkdir(path.dirname(path.join(tempDir, storedPath)), { recursive: true });
  await fsp.writeFile(path.join(tempDir, storedPath), "legacy-image");
  const facade = createGeneratedAssetStorage(
    { assetStorage: { provider: "aliyun_oss", aliyunOss: ossConfig() } },
    { local: { dataDir: tempDir }, aliyunOss: { client: {} } },
  );
  try {
    assert.deepEqual(await facade.readBuffer({ storedPath, mimeType: "image/png" }), Buffer.from("legacy-image"));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("facade supports OSS main, slide, and edit inputs without crossing generation boundaries", async () => {
  const readKeys = [];
  const client = {
    async get(key) {
      readKeys.push(key);
      return { content: Buffer.from(key) };
    },
  };
  const storage = createGeneratedAssetStorage({ assetStorage: { provider: "aliyun_oss", aliyunOss: ossConfig() } }, { aliyunOss: { client } });
  const asset = (name) => ({ provider: "aliyun_oss", objectKey: `redbase/generated-images/users/7/2026/07/88/gi_88_${name}.png`, mimeType: "image/png" });
  const generation = {
    id: 88,
    ownerUserId: 7,
    payload: {
      localImage: asset("main"),
      slides: [{ localImage: asset("slide_1") }],
      editHistory: [{ id: "abc123", localImage: asset("edit_abc123") }],
    },
  };

  const main = await resolveGeneratedImageInputForEdit(generation, "/api/generated-images/88/file", "", storage);
  const slide = await resolveGeneratedImageInputForEdit(generation, "/api/generated-images/88/slides/0/file", "", storage);
  const edit = await resolveGeneratedImageInputForEdit(generation, "/api/generated-images/88/edits/abc123/file", "abc123", storage);
  const crossed = await resolveGeneratedImageInputForEdit(generation, "/api/generated-images/99/slides/0/file", "", storage);

  assert.equal(main.provider, "aliyun_oss");
  assert.equal(slide.objectKey.endsWith("gi_88_slide_1.png"), true);
  assert.equal(edit.objectKey.endsWith("gi_88_edit_abc123.png"), true);
  assert.equal(crossed, null);
  assert.deepEqual(readKeys.map((key) => key.split("/").at(-1)), ["gi_88_main.png", "gi_88_slide_1.png", "gi_88_edit_abc123.png"]);
});

test("forged or cross-tenant generated asset metadata is rejected before read or delete", async () => {
  const generation = { id: 88, ownerUserId: 7 };
  assert.throws(
    () => assertGenerationAssetOwnership({ objectKey: "redbase/private/config-backup.json" }, generation),
    { code: "ASSET_SCOPE_VIOLATION" },
  );
  assert.throws(
    () => assertGenerationAssetOwnership({ objectKey: "redbase/generated-images/users/8/2026/07/88/main.png" }, generation),
    { code: "ASSET_SCOPE_VIOLATION" },
  );
  assert.throws(
    () => assertGenerationAssetOwnership({ storedPath: "uploads/generated-images/users/7/2026/07/99/main.png" }, generation),
    { code: "ASSET_SCOPE_VIOLATION" },
  );

  const target = {
    imageUrl: "/api/generated-images/88/file",
    localImage: { provider: "aliyun_oss", objectKey: "redbase/private/config-backup.json" },
  };
  let saveCalled = false;
  const result = await persistGeneratedImageReference({
    ownerUserId: 7,
    generationId: 88,
    target,
    remoteUrl: target.imageUrl,
    variant: "main",
    localUrl: target.imageUrl,
    storage: { save: async () => { saveCalled = true; } },
  });
  assert.equal(result, null);
  assert.equal(target.localImage, undefined);
  assert.equal(saveCalled, false);
});

test("stored image response redirects OSS privately and streams legacy local bytes", async () => {
  const createResponse = () => ({
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(code, headers = {}) { this.statusCode = code; this.headers = headers; },
    end(data) { this.body = data; },
  });
  const ossRes = createResponse();
  await serveStoredGeneratedImage(
    ossRes,
    { provider: "aliyun_oss", objectKey: "redbase/generated-images/users/1/2026/07/2/main.png" },
    { createReadUrl: async (_asset, options) => {
      assert.equal(options.expiresSeconds, 300);
      return "https://signed.invalid/temporary";
    } },
  );
  assert.equal(ossRes.statusCode, 302);
  assert.equal(ossRes.headers.Location, "https://signed.invalid/temporary");
  assert.equal(ossRes.headers["Cache-Control"], "private, no-store");

  const localRes = createResponse();
  await serveStoredGeneratedImage(
    localRes,
    { provider: "local", storedPath: "uploads/generated-images/legacy.png", mimeType: "image/png" },
    { readBuffer: async () => Buffer.from("legacy") },
  );
  assert.equal(localRes.statusCode, 200);
  assert.equal(localRes.headers["Content-Type"], "image/png");
  assert.deepEqual(localRes.body, Buffer.from("legacy"));
});
