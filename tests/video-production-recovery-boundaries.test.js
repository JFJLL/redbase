const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const http = require("node:http");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertProductImage } = require("../src/server/db/repositories/product-image-repository");
const { getProject, updateProject, updateClip } = require("../src/server/db/repositories/video-project-repository");
const { createVideoProjectService } = require("../src/server/video/video-project-service");
const { createAgnesKeyPool } = require("../src/server/video/agnes-key-pool");
const { downloadProviderMediaToFile } = require("../src/server/video/video-remote");
const { createLocalGeneratedAssetStorage } = require("../src/server/assets/local-generated-asset-storage");
const { createGeneratedAssetStorage } = require("../src/server/assets/generated-asset-storage");
const { insertBrand, upsertBrandFull } = require("../src/server/db/repositories/brand-repository");
const { handleVideoScriptRoutes } = require("../src/server/api/video-script-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

const MP4_BUFFER = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(12)]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-video-boundary-source-"));
const frozenSourcePath = path.join(sourceDir, "product.png");
fs.writeFileSync(frozenSourcePath, Buffer.from("product-image-data"));

function addUser(id, credits = 1000) {
  insertUser({
    id,
    name: `Boundary User ${id}`,
    phone: `1390001${String(id).padStart(4, "0")}`,
    password: "hash",
    accountType: "customer",
    credits,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
}

function makeStorage() {
  const buffers = new Map();
  let readBufferCallCount = 0;
  return {
    provider: "local",
    buffers,
    get readBufferCallCount() { return readBufferCallCount; },
    async save({ ownerUserId, generationId, variant, mimeType, buffer }) {
      const extension = mimeType === "video/mp4" ? "mp4" : "jpg";
      const storedPath = `generated-images/users/${ownerUserId}/${generationId}/${variant}.${extension}`;
      buffers.set(storedPath, Buffer.from(buffer));
      return { provider: "local", storedPath, objectKey: "", mimeType, sizeBytes: buffer.length };
    },
    async saveFile({ ownerUserId, generationId, variant, mimeType, filePath, sizeBytes }) {
      const extension = mimeType === "video/mp4" ? "mp4" : "jpg";
      const storedPath = `generated-images/users/${ownerUserId}/${generationId}/${variant}.${extension}`;
      const buffer = await fsp.readFile(filePath);
      buffers.set(storedPath, buffer);
      return { provider: "local", storedPath, objectKey: "", mimeType, sizeBytes: sizeBytes || buffer.length };
    },
    async readBuffer(asset) {
      readBufferCallCount += 1;
      const buffer = buffers.get(asset.storedPath);
      if (!buffer) throw new Error(`missing test asset: ${asset.storedPath}`);
      return Buffer.from(buffer);
    },
    createReadStream(asset, options = {}) {
      const buffer = buffers.get(asset.storedPath);
      if (!buffer) throw new Error(`missing test asset: ${asset.storedPath}`);
      const { Readable } = require("stream");
      const start = options.start ?? 0;
      const end = options.end != null ? options.end + 1 : buffer.length;
      return Readable.from(buffer.subarray(start, end));
    },
    async stat(asset) {
      const buffer = buffers.get(asset.storedPath);
      if (!buffer) throw Object.assign(new Error("asset not found"), { code: "ENOENT" });
      return { size: buffer.length, mtime: new Date() };
    },
    async copyToFile(asset, targetPath) {
      const buffer = buffers.get(asset.storedPath);
      if (!buffer) throw new Error(`missing test asset: ${asset.storedPath}`);
      await fsp.mkdir(path.dirname(path.resolve(targetPath)), { recursive: true });
      await fsp.writeFile(targetPath, buffer);
    },
    async deleteMany(assets) {
      for (const asset of assets) buffers.delete(asset?.storedPath);
    },
  };
}

function makeAppConfig(overrides = {}) {
  const baseVideo = {
    publicBaseUrl: "https://redbase.boundary.example",
    pollIntervalMs: 1,
    pollMaxBackoffMs: 1,
    submitTimeoutMs: 20,
    pollTimeoutMs: 20,
    d2MaxConcurrentSubmissions: 4,
    mediaMaxConcurrency: 3,
    ffmpegMaxConcurrency: 1,
    runninghub: { outputHosts: ["runninghub.ai", "runninghub.cn", "provider.example"] },
    agnes: { apiKeys: [], pollIntervalMs: 1, outputHosts: ["platform-outputs.agnes-ai.space", "provider.example"] },
  };
  const overrideVideo = overrides.video || {};
  return {
    security: { assetSigningSecret: "boundary-stable-secret" },
    video: {
      ...baseVideo,
      ...overrideVideo,
      runninghub: { ...baseVideo.runninghub, ...(overrideVideo.runninghub || {}) },
      agnes: { ...baseVideo.agnes, ...(overrideVideo.agnes || {}) },
    },
    ...(overrides.security ? { security: { ...overrides.security } } : {}),
    ...(overrides.textProvider ? { textProvider: overrides.textProvider } : {}),
  };
}

function makeScript({ title = "测试脚本", totalDurationSec = 10, clipCount = 1 } = {}) {
  return {
    title,
    creativeConcept: "边界测试概念",
    totalDurationSec,
    aspectRatio: "9:16",
    model: "d2",
    mode: "text",
    clips: Array.from({ length: clipCount }, (_, index) => ({
      index: index + 1,
      purpose: `分镜 ${index + 1}`,
      scene: "场景",
      subjectAction: "动作",
      cameraMovement: "运镜",
      environmentMotion: "动态",
      lightingAndStyle: "光影",
      continuity: "连续性",
      prompt: `分镜 ${index + 1} 提示词`,
      generationDurationSec: Math.floor(totalDurationSec / clipCount),
      referenceAssetIds: [],
    })),
  };
}

function makeService({
  provider,
  providers,
  storage = makeStorage(),
  keyPool = createAgnesKeyPool({ keys: ["boundary-key-a"], rpmPerKey: 60 }),
  appConfig = makeAppConfig(),
  fetchImpl = fetch,
  resolver,
  resolveStoredProductImagePath = resolver || (() => frozenSourcePath),
  executor = async (_binary, args) => {
    await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
  },
} = {}) {
  const p = provider || {
    provider: "fake",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { return { taskId: "task-1" }; },
    async getTaskStatus() { return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER }; },
  };
  return createVideoProjectService({
    appConfig,
    generatedAssetStorage: storage,
    providers: providers || { d2: p, g2: p },
    keyPool,
    resolveStoredProductImagePath,
    fetchImpl,
    executor,
    allowLegacyScript: true,
  });
}

function createMockHttpResponse() {
  const chunks = [];
  const headers = {};
  let statusCode = 0;
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  writable.writeHead = function (code, h) {
    statusCode = code;
    Object.assign(headers, h);
  };
  Object.defineProperty(writable, "statusCode", { get: () => statusCode });
  Object.defineProperty(writable, "headers", { get: () => headers });
  Object.defineProperty(writable, "body", { get: () => Buffer.concat(chunks) });
  return writable;
}

test("42.A: Provider completed -> first download timeout -> NO refund, NO 2nd submit -> next download succeeds -> completed", async () => {
  const ownerUserId = 1001;
  addUser(ownerUserId, 100);
  const storage = makeStorage();
  let submitCount = 0;
  let downloadAttempts = 0;

  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() {
      submitCount += 1;
      return { taskId: "d2-persistence-a" };
    },
    async getTaskStatus() {
      return { status: "completed", videoUrl: "https://provider.example/clip.mp4" };
    },
  };

  const fetchImpl = async (url) => {
    downloadAttempts += 1;
    if (downloadAttempts === 1) {
      throw new Error("download timeout on first attempt");
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "video/mp4" : "" },
      async arrayBuffer() {
        return Uint8Array.from(MP4_BUFFER).buffer;
      },
    };
  };

  const service = makeService({ provider, storage, fetchImpl });
  const created = await service.createProject({
    ownerUserId,
    requestId: "persistence-test-a",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  assert.equal(findUserById(ownerUserId).credits, 80);
  assert.equal(submitCount, 0);

  // Pump 1: submits clip -> status running
  await service.pump();
  assert.equal(submitCount, 1);
  assert.equal(service.getProject(created.project.id, ownerUserId).clips[0].status, "running");

  await new Promise((r) => setTimeout(r, 10));
  // Pump 2: poll returns completed -> downloadMedia fails -> clip becomes processing_result
  await service.pump();
  const afterFirstFail = service.getProject(created.project.id, ownerUserId);
  assert.equal(afterFirstFail.clips[0].status, "processing_result");
  assert.equal(afterFirstFail.clips[0].resultProcessingFailureCount, 1);
  assert.equal(submitCount, 1, "submitClip must not be called again");
  assert.equal(findUserById(ownerUserId).credits, 80, "must not refund on transient result processing failure");

  await new Promise((r) => setTimeout(r, 10));
  // Pump 3: second download attempt succeeds -> clip completed!
  await service.pump();
  const completed = service.getProject(created.project.id, ownerUserId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.clips[0].status, "completed");
  assert.equal(submitCount, 1, "submitClip call count must remain strictly 1");
  assert.equal(findUserById(ownerUserId).credits, 80);
});

test("42.B: Storage saveFile throws 503 error on first try -> NO refund, NO provider resubmit -> 2nd try succeeds", async () => {
  const ownerUserId = 1002;
  addUser(ownerUserId, 100);
  const storage = makeStorage();
  let saveAttempts = 0;
  const originalSaveFile = storage.saveFile.bind(storage);
  storage.saveFile = async (args) => {
    saveAttempts += 1;
    if (saveAttempts === 1) throw new Error("OSS temporary 503 Service Unavailable");
    return originalSaveFile(args);
  };

  let submitCount = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() {
      submitCount += 1;
      return { taskId: "d2-persistence-b" };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER };
    },
  };

  const service = makeService({ provider, storage });
  const created = await service.createProject({
    ownerUserId,
    requestId: "persistence-test-b",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump(); // submits
  assert.equal(submitCount, 1);

  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // polls completed -> saveFile fails -> processing_result
  const projectAfterFail = service.getProject(created.project.id, ownerUserId);
  assert.equal(projectAfterFail.clips[0].status, "processing_result");
  assert.equal(projectAfterFail.clips[0].resultProcessingFailureCount, 1);
  assert.equal(submitCount, 1);
  assert.equal(findUserById(ownerUserId).credits, 80);

  await new Promise((r) => setTimeout(r, 10));
  // Pump again -> second saveFile succeeds
  await service.pump();
  const completed = service.getProject(created.project.id, ownerUserId);
  assert.equal(completed.status, "completed");
  assert.equal(submitCount, 1);
});

test("42.C: Native last frame download fails -> FFmpeg fallback succeeds -> Clip completed with submitCount = 1", async () => {
  const ownerUserId = 1003;
  addUser(ownerUserId, 100);
  const storage = makeStorage();
  let submitCount = 0;
  let ffmpegExtracted = false;

  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() {
      submitCount += 1;
      return { taskId: "d2-persistence-c" };
    },
    async getTaskStatus() {
      return {
        status: "completed",
        videoUrl: "https://provider.example/clip.mp4",
        nativeLastFrameUrl: "https://provider.example/bad-frame.jpg",
      };
    },
  };

  const fetchImpl = async (url) => {
    if (String(url).includes("bad-frame.jpg")) {
      return { ok: false, status: 403, headers: { get: () => "" } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "video/mp4" : "" },
      async arrayBuffer() {
        return Uint8Array.from(MP4_BUFFER).buffer;
      },
    };
  };

  const executor = async (_bin, args) => {
    ffmpegExtracted = true;
    await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
  };

  const service = makeService({ provider, storage, fetchImpl, executor });
  const created = await service.createProject({
    ownerUserId,
    requestId: "persistence-test-c",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  await service.pump(); // submits clip 1
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // polls clip 1 completed -> native frame 403 -> falls back to FFmpeg -> completes clip 1

  const p1 = service.getProject(created.project.id, ownerUserId);
  assert.equal(p1.clips[0].status, "completed");
  assert.ok(ffmpegExtracted, "FFmpeg fallback must have extracted continuity frame");
  assert.equal(submitCount, 1);
  updateProject(created.project.id, { status: "completed" });
});

test("42.D & 8: Native frame + FFmpeg both fail -> result_processing_failed -> 0-credit retry-result recovers without charging", async () => {
  const ownerUserId = 1004;
  addUser(ownerUserId, 100);
  const storage = makeStorage();
  let clip1SubmitCount = 0;
  let ffmpegFails = true;

  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() {
      clip1SubmitCount += 1;
      return { taskId: "d2-persistence-d" };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER };
    },
  };

  const executor = async (_bin, args) => {
    if (ffmpegFails) throw new Error("FFmpeg broken pipe");
    await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
  };

  const service = makeService({ provider, storage, executor });
  const created = await service.createProject({
    ownerUserId,
    requestId: "persistence-test-d",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  await service.pump(); // submits clip 1
  assert.equal(clip1SubmitCount, 1);

  // Pump multiple times until max retries reached -> result_processing_failed
  for (let i = 0; i < 7; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    await service.pump();
  }

  const failedProject = service.getProject(created.project.id, ownerUserId);
  assert.equal(failedProject.status, "result_processing_failed");
  assert.equal(failedProject.clips[0].status, "result_processing_failed");
  const failureCountBeforeResultRetry = failedProject.clips[0].resultProcessingFailureCount;
  assert.ok(failureCountBeforeResultRetry > 0);
  assert.equal(findUserById(ownerUserId).credits, 70, "credits must stay deducted, no refund");
  assert.equal(clip1SubmitCount, 1);

  // Paid retry is disallowed for result_processing_failed
  await assert.rejects(
    service.retryClip(created.project.id, ownerUserId, 1, "paid-retry-attempt"),
    (err) => err.code === "VIDEO_CLIP_RETRY_NOT_ALLOWED",
  );

  // Now fix FFmpeg and perform 0-credit retry-result
  ffmpegFails = false;
  const retryResult = await service.retryClipResult(created.project.id, ownerUserId, 1, "retry-res-01");
  assert.equal(retryResult.project.clips[0].status, "processing_result");
  const claimedClip = getProject(created.project.id).clips[0];
  assert.equal(claimedClip.resultProcessingFailureCount, failureCountBeforeResultRetry, "claim must not reset failureCount to infer attempt kind");
  assert.equal(claimedClip.nextResultAttemptKind, "result_retry");
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    await service.pump();
    if (service.getProject(created.project.id, ownerUserId).clips[0].status === "completed") break;
  }
  const completedAfterRetry = service.getProject(created.project.id, ownerUserId);
  assert.equal(completedAfterRetry.clips[0].status, "completed");
  const completedResultAttempt = db.prepare(`
    SELECT attempt_kind, status
    FROM ai_task_attempts
    WHERE project_id = ? AND clip_id = ? AND task_type = 'video_result_processing' AND status = 'completed'
    ORDER BY id DESC LIMIT 1
  `).get(created.project.id, created.project.clips[0].id);
  assert.deepEqual(completedResultAttempt, { attempt_kind: "result_retry", status: "completed" });
  assert.equal(findUserById(ownerUserId).credits, 70, "0 credits deducted for retry-result");
  assert.equal(clip1SubmitCount, 2, "clip 1 submit is 1, clip 2 submit is 2");
  updateProject(created.project.id, { status: "completed" });
});

test("43: Local video asset serving supports Range headers (206/416/200) without calling readBuffer", async () => {
  const ownerUserId = 1005;
  addUser(ownerUserId, 100);
  const storage = makeStorage();
  const service = makeService({ storage });
  const created = await service.createProject({
    ownerUserId,
    requestId: "range-test-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump();
  await new Promise((r) => setTimeout(r, 5));
  await service.pump();
  const completed = service.getProject(created.project.id, ownerUserId);
  assert.equal(completed.status, "completed");

  // 1. Full request without Range -> 200
  const res200 = createMockHttpResponse();
  const served200 = await service.serveAsset(completed.id, ownerUserId, "final", null, res200, { headers: {} });
  assert.ok(served200);
  assert.equal(res200.statusCode, 200);
  assert.equal(res200.headers["Accept-Ranges"], "bytes");
  assert.equal(Number(res200.headers["Content-Length"]), MP4_BUFFER.length);
  assert.equal(storage.readBufferCallCount, 0, "readBuffer must NOT be called for video");

  // 2. Range bytes=0-9 -> 206
  const res206 = createMockHttpResponse();
  const served206 = await service.serveAsset(completed.id, ownerUserId, "final", null, res206, { headers: { range: "bytes=0-9" } });
  assert.ok(served206);
  assert.equal(res206.statusCode, 206);
  assert.equal(res206.headers["Content-Range"], `bytes 0-9/${MP4_BUFFER.length}`);
  assert.equal(res206.headers["Content-Length"], 10);
  assert.equal(storage.readBufferCallCount, 0);

  // 3. Range bytes=10- -> 206
  const res206Tail = createMockHttpResponse();
  await service.serveAsset(completed.id, ownerUserId, "final", null, res206Tail, { headers: { range: "bytes=10-" } });
  assert.equal(res206Tail.statusCode, 206);
  assert.equal(res206Tail.headers["Content-Range"], `bytes 10-${MP4_BUFFER.length - 1}/${MP4_BUFFER.length}`);
  assert.equal(storage.readBufferCallCount, 0);

  // 4. Unsatisfiable range bytes=999999- -> 416
  const res416 = createMockHttpResponse();
  await service.serveAsset(completed.id, ownerUserId, "final", null, res416, { headers: { range: "bytes=999999-" } });
  assert.equal(res416.statusCode, 416);
  assert.equal(res416.headers["Content-Range"], `bytes */${MP4_BUFFER.length}`);
  assert.equal(storage.readBufferCallCount, 0);
});

test("44: Provider stream download enforces max size, verifies ftyp, and checks redirects", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-dl-test-"));
  const targetFile1 = path.join(tmpDir, "downloaded1.mp4");
  const targetFile2 = path.join(tmpDir, "downloaded2.mp4");
  const targetFile3 = path.join(tmpDir, "downloaded3.mp4");
  const targetFile4 = path.join(tmpDir, "downloaded4.mp4");

  // 1. Content-Length precheck > maxBytes
  await assert.rejects(
    downloadProviderMediaToFile("https://provider.example/huge.mp4", {
      targetPath: targetFile1,
      allowedHosts: ["provider.example"],
      maxBytes: 100,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => String(n).toLowerCase() === "content-length" ? "500" : (String(n).toLowerCase() === "content-type" ? "video/mp4" : "") },
      }),
    }),
    (err) => err.code === "PAYLOAD_TOO_LARGE",
  );

  // 2. Chunked stream exceeds maxBytes -> aborts and unlinks
  await assert.rejects(
    downloadProviderMediaToFile("https://provider.example/chunked.mp4", {
      targetPath: targetFile2,
      allowedHosts: ["provider.example"],
      maxBytes: 50,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => String(n).toLowerCase() === "content-type" ? "video/mp4" : "" },
        body: {
          getReader() {
            let chunks = [Buffer.alloc(30), Buffer.alloc(30)];
            return {
              async read() {
                if (!chunks.length) return { done: true };
                return { done: false, value: chunks.shift() };
              },
            };
          },
        },
      }),
    }),
    (err) => err.code === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(fs.existsSync(targetFile2), false, "temp file must be unlinked on size limit abort");

  // 3. Valid MP4 with ftyp -> succeeds
  const validResult = await downloadProviderMediaToFile("https://provider.example/good.mp4", {
    targetPath: targetFile3,
    allowedHosts: ["provider.example"],
    maxBytes: 1024,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => String(n).toLowerCase() === "content-type" ? "video/mp4" : "" },
      async arrayBuffer() {
        return Uint8Array.from(MP4_BUFFER).buffer;
      },
    }),
  });
  assert.equal(validResult.sizeBytes, MP4_BUFFER.length);
  assert.equal(fs.existsSync(targetFile3), true);

  // 4. Non-ftyp file -> rejected and unlinked
  await assert.rejects(
    downloadProviderMediaToFile("https://provider.example/bad-header.mp4", {
      targetPath: targetFile4,
      allowedHosts: ["provider.example"],
      maxBytes: 1024,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => String(n).toLowerCase() === "content-type" ? "video/mp4" : "" },
        async arrayBuffer() {
          return Uint8Array.from(Buffer.from("not-a-valid-mp4-file")).buffer;
        },
      }),
    }),
    /ftyp/,
  );
  assert.equal(fs.existsSync(targetFile4), false);
});

test("45: Video Script, Project, and Retry semantic idempotency and conflict handling", async () => {
  const ownerUserId = 1006;
  addUser(ownerUserId, 1000);

  // Video Project Conflict Check
  const service = makeService();
  const proj = await service.createProject({
    ownerUserId,
    requestId: "idem-conflict-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript({ totalDurationSec: 10 }),
  });

  const creditsBeforeConflict = findUserById(ownerUserId).credits;

  // Same requestId, same project input -> 200 replay
  const replayed = await service.createProject({
    ownerUserId,
    requestId: "idem-conflict-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript({ totalDurationSec: 10 }),
  });
  assert.equal(replayed.project.id, proj.project.id);
  assert.equal(findUserById(ownerUserId).credits, creditsBeforeConflict);

  // Same requestId, different model -> 409 conflict
  await assert.rejects(
    service.createProject({
      ownerUserId,
      requestId: "idem-conflict-proj",
      brandId: 1,
      trendId: 1,
      ideaIndex: 0,
      model: "g2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      script: makeScript({ totalDurationSec: 10 }),
    }),
    (err) => err.code === "VIDEO_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(findUserById(ownerUserId).credits, creditsBeforeConflict, "conflict must not deduct credits");
});

test("45.B: Video Script HTTP API semantic idempotency and conflict rejects without charges", async () => {
  const ownerUserId = 1007;
  addUser(ownerUserId, 100);

  const modelServer = http.createServer((_req, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{
            text: JSON.stringify({
              title: "山野清晨手冲咖啡视频脚本",
              creativeConcept: "露营消暑手冲咖啡",
              totalDurationSec: 15,
              aspectRatio: "9:16",
              globalSubjectReference: "户外手冲咖啡壶",
              globalStyleReference: "清晨自然光电影感",
              globalContinuity: "动作流畅推进",
              clips: [{
                index: 1,
                startSec: 0,
                endSec: 7,
                durationSec: 7,
                purpose: "开场",
                scene: "场景",
                subjectAction: "动作",
                cameraMovement: "运镜",
                environmentMotion: "动态",
                lightingAndStyle: "光影",
                continuity: "连续性",
                prompt: "分镜1提示词",
              }, {
                index: 2,
                startSec: 7,
                endSec: 15,
                durationSec: 8,
                purpose: "结尾",
                scene: "场景2",
                subjectAction: "动作2",
                cameraMovement: "运镜2",
                environmentMotion: "动态2",
                lightingAndStyle: "光影2",
                continuity: "连续性2",
                prompt: "分镜2提示词",
              }],
            }),
          }],
        },
      }],
    }));
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;

  insertBrand({
    id: 107,
    ownerUserId,
    name: "测试品牌",
    industry: "美妆",
    audience: "大众",
    description: "描述",
    product: "产品",
    goal: "目标",
    knowledgeBase: "",
    logoJson: "{}",
    assetTagsJson: "[]",
  });

  const brand = upsertBrandFull({
    id: 107,
    ownerUserId,
    name: "测试品牌",
    industry: "美妆",
    audience: "大众",
    description: "描述",
    product: "产品",
    goal: "目标",
    knowledgeBase: "",
    logoJson: "{}",
    assetTagsJson: "[]",
    trends: [
      {
        key: "traffic",
        title: "流量",
        description: "描述",
        items: [
          {
            id: 301,
            stableKey: "trend-301",
            rank: 1,
            score: 90,
            reason: "原因",
            title: "趋势一",
            category: "美妆",
            summary: "趋势摘要",
            ideas: [
              {
                title: "选题0",
                summary: "摘要0",
                angle: "角度0",
                brandFit: "契合度0",
                audience: "人群0",
                hook: "钩子0",
                tags: ["美妆"],
              },
              {
                title: "选题1",
                summary: "摘要1",
                angle: "角度1",
                brandFit: "契合度1",
                audience: "人群1",
                hook: "钩子1",
                tags: ["护肤"],
              },
            ],
          },
        ],
      },
    ],
  });

  const context = {
    appConfig: makeAppConfig({
      textProvider: {
        apiStyle: "google",
        model: "gemini-3.6-flash",
        baseUrl: `http://127.0.0.1:${modelPort}`,
        apiKey: "fixture-google-key",
        maxOutputTokens: 8192,
      },
    }),
    findTrendItem: (_b, tid) => brand.trends[0].items.find((t) => t.id === Number(tid)),
    getSessionToken: () => "sess-1007",
    buildApiUserLog: () => "",
    resolveStoredProductImagePath: () => frozenSourcePath,
    resolveBrandLogoPath: () => null,
  };
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES ('sess-1007', ?, datetime('now'))").run(ownerUserId);

  function makeMockHttpReq(body, path) {
    const { Readable } = require("stream");
    const stream = Readable.from(Buffer.from(JSON.stringify(body)));
    stream.method = "POST";
    stream.url = path;
    stream.headers = { host: "127.0.0.1" };
    return stream;
  }

  // 1. Initial script generation -> succeeds, charges 1 credit (100 -> 99)
  const req1 = makeMockHttpReq({
    requestId: "script-idem-01",
    model: "d2",
    mode: "text",
    aspectRatioSelection: "9:16",
    durationSelection: "15",
  }, "/api/brands/107/trends/301/ideas/0/video-script");
  const res1 = createMockHttpResponse();
  await handleVideoScriptRoutes(context, req1, res1, "/api/brands/107/trends/301/ideas/0/video-script");
  assert.equal(res1.statusCode, 200);
  assert.equal(findUserById(ownerUserId).credits, 99);

  // 2. Same requestId, same input -> 200 replay, credits stay 99
  const req2 = makeMockHttpReq({
    requestId: "script-idem-01",
    model: "d2",
    mode: "text",
    aspectRatioSelection: "9:16",
    durationSelection: "15",
  }, "/api/brands/107/trends/301/ideas/0/video-script");
  const res2 = createMockHttpResponse();
  await handleVideoScriptRoutes(context, req2, res2, "/api/brands/107/trends/301/ideas/0/video-script");
  assert.equal(res2.statusCode, 200);
  assert.equal(findUserById(ownerUserId).credits, 99);

  // 3. Same requestId, different idea (idea 1 instead of idea 0) -> 409 conflict, credits stay 99
  const req3 = makeMockHttpReq({
    requestId: "script-idem-01",
    model: "d2",
    mode: "text",
    aspectRatioSelection: "9:16",
    durationSelection: "15",
  }, "/api/brands/107/trends/301/ideas/1/video-script");
  const res3 = createMockHttpResponse();
  await handleVideoScriptRoutes(context, req3, res3, "/api/brands/107/trends/301/ideas/1/video-script");
  assert.equal(res3.statusCode, 409);
  assert.equal(JSON.parse(res3.body.toString()).code, "VIDEO_IDEMPOTENCY_CONFLICT");
  assert.equal(findUserById(ownerUserId).credits, 99, "no extra charge on conflict");

  // 4. Same requestId, different model (g2 instead of d2) -> 409 conflict, credits stay 99
  const req4 = makeMockHttpReq({
    requestId: "script-idem-01",
    model: "g2",
    mode: "text",
    aspectRatioSelection: "9:16",
    durationSelection: "15",
  }, "/api/brands/107/trends/301/ideas/0/video-script");
  const res4 = createMockHttpResponse();
  await handleVideoScriptRoutes(context, req4, res4, "/api/brands/107/trends/301/ideas/0/video-script");
  assert.equal(res4.statusCode, 409);
  assert.equal(JSON.parse(res4.body.toString()).code, "VIDEO_IDEMPOTENCY_CONFLICT");
  assert.equal(findUserById(ownerUserId).credits, 99);
  await new Promise((resolve) => modelServer.close(resolve));
});

test("45.C: Video Retry conflict rejects with 409 and 0 charge", async () => {
  const ownerUserId = 1008;
  addUser(ownerUserId, 200);

  const provider = {
    provider: "fake",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { return { taskId: "retry-task" }; },
    async getTaskStatus() { return { status: "failed", error: "intentional fail" }; },
  };
  const service = makeService({ provider });
  const p = await service.createProject({
    ownerUserId,
    requestId: "retry-conflict-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  await service.pump();
  await new Promise((r) => setTimeout(r, 10));
  await service.pump();
  const failed = service.getProject(p.project.id, ownerUserId);
  assert.equal(failed.clips[0].status, "failed");
  const creditsAfterRefund = findUserById(ownerUserId).credits;

  // 1. Initial retry -> succeeds
  const retry1 = await service.retryClip(p.project.id, ownerUserId, 1, "retry-req-01");
  const creditsAfterRetry1 = findUserById(ownerUserId).credits;
  assert.ok(creditsAfterRetry1 < creditsAfterRefund);

  // 2. Same retry requestId on SAME clip -> replay (no extra charge)
  const retryReplay = await service.retryClip(p.project.id, ownerUserId, 1, "retry-req-01");
  assert.equal(findUserById(ownerUserId).credits, creditsAfterRetry1);

  // 3. Same retry requestId on DIFFERENT clip (clip 2) -> 409 conflict
  await assert.rejects(
    service.retryClip(p.project.id, ownerUserId, 2, "retry-req-01"),
    (err) => err.code === "VIDEO_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(findUserById(ownerUserId).credits, creditsAfterRetry1, "no extra charge on retry conflict");
});

test("19 & 20: Data error vs Config error classification", async () => {
  const ownerUserId = 1009;
  addUser(ownerUserId, 200);

  // 1. Config error: VIDEO_PROVIDER_NOT_CONFIGURED -> waiting_configuration
  const configWithKey = makeAppConfig({ video: { runninghub: { apiKey: "test-key" } } });
  const serviceConfigError = makeService({
    appConfig: configWithKey,
    provider: {
      provider: "runninghub",
      getAllowedHosts: () => ["runninghub.ai"],
      async submitClip() {
        const error = new Error("RunningHub API Key not configured");
        error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
        throw error;
      },
      async getTaskStatus() { return { status: "running" }; },
    },
  });

  const pConfig = await serviceConfigError.createProject({
    ownerUserId,
    requestId: "config-error-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await serviceConfigError.pump();
  const projectConfigResult = serviceConfigError.getProject(pConfig.project.id, ownerUserId);
  assert.equal(projectConfigResult.status, "waiting_configuration");
  updateProject(pConfig.project.id, { status: "completed" }); // isolate

  // 2. Data error: VIDEO_INPUT_SNAPSHOT_UNAVAILABLE -> project_data_failed
  const serviceDataError = makeService({
    appConfig: configWithKey,
    provider: {
      provider: "runninghub",
      getAllowedHosts: () => ["runninghub.ai"],
      async submitClip() {
        const error = new Error("参考素材不可用");
        error.code = "VIDEO_INPUT_SNAPSHOT_UNAVAILABLE";
        throw error;
      },
      async getTaskStatus() { return { status: "running" }; },
    },
  });

  const pData = await serviceDataError.createProject({
    ownerUserId,
    requestId: "data-error-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await serviceDataError.pump();
  const projectDataResult = serviceDataError.getProject(pData.project.id, ownerUserId);
  assert.equal(projectDataResult.status, "project_data_failed");
  assert.ok(projectDataResult.error.includes("参考素材不可用"));
  assert.notEqual(projectDataResult.status, "waiting_configuration", "data error must NEVER enter waiting_configuration");
  updateProject(pData.project.id, { status: "completed" }); // isolate
});

test("29.A & B: result_processing_failed is returned by active endpoint and prevents second paid project", async () => {
  const ownerUserId = 1010;
  addUser(ownerUserId, 200);

  const service = makeService({
    provider: {
      provider: "fake",
      getAllowedHosts: () => ["provider.example"],
      async submitClip() { return { taskId: "fail-task" }; },
      async getTaskStatus() { return { status: "completed", videoBuffer: MP4_BUFFER }; },
    },
    executor: async () => { throw new Error("forced ffmpeg failure"); },
  });

  const created = await service.createProject({
    ownerUserId,
    requestId: "active-failed-proj-1",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  for (let i = 0; i < 7; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    await service.pump();
  }

  const p = service.getProject(created.project.id, ownerUserId);
  assert.equal(p.status, "result_processing_failed");

  // 29.A: active projects endpoint returns this project
  const activeList = service.listActiveProjects(ownerUserId, { brandId: 1, trendId: 1, ideaIndex: 0 });
  assert.equal(activeList.length, 1);
  assert.equal(activeList[0].id, created.project.id);
  assert.equal(activeList[0].status, "result_processing_failed");

  // 29.B: create project with new requestId for same idea does NOT charge second project
  const creditsBefore = findUserById(ownerUserId).credits;
  const duplicateAttempt = await service.createProject({
    ownerUserId,
    requestId: "new-request-id-for-same-idea",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });
  assert.equal(duplicateAttempt.project.id, created.project.id);
  assert.equal(findUserById(ownerUserId).credits, creditsBefore, "no second charge for duplicate idea project");
  updateProject(created.project.id, { status: "completed" });
});

test("29.C, D, E: retry-result requestId validation, replay, and conflict", async () => {
  const ownerUserId = 1011;
  addUser(ownerUserId, 200);

  const service = makeService();
  const created = await service.createProject({
    ownerUserId,
    requestId: "retry-result-idem-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  updateClip(created.project.clips[0].id, { status: "result_processing_failed", providerTaskId: "prov-1" });
  updateProject(created.project.id, { status: "result_processing_failed" });

  // 29.C: empty requestId throws VIDEO_REQUEST_ID_REQUIRED
  await assert.rejects(
    service.retryClipResult(created.project.id, ownerUserId, 1, ""),
    (err) => err.code === "VIDEO_REQUEST_ID_REQUIRED",
  );

  // 29.D: same requestId same clip -> replay
  const firstClaim = await service.retryClipResult(created.project.id, ownerUserId, 1, "retry-idem-001");
  assert.ok(firstClaim.project);

  const secondClaim = await service.retryClipResult(created.project.id, ownerUserId, 1, "retry-idem-001");
  assert.equal(secondClaim.project.id, created.project.id);

  // 29.E: same requestId different clip (clip 2) -> 409 conflict
  updateClip(created.project.clips[1].id, { status: "result_processing_failed", providerTaskId: "prov-2" });
  await assert.rejects(
    service.retryClipResult(created.project.id, ownerUserId, 2, "retry-idem-001"),
    (err) => err.code === "VIDEO_IDEMPOTENCY_CONFLICT",
  );
  updateProject(created.project.id, { status: "completed" });
});

test("29.F: Concurrency guard: scheduler and manual retry-result share single worker", async () => {
  const ownerUserId = 1012;
  addUser(ownerUserId, 200);

  let providerGetStatusCalls = 0;
  const provider = {
    provider: "fake",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { return { taskId: "task-conc" }; },
    async getTaskStatus() {
      providerGetStatusCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { status: "completed", videoBuffer: MP4_BUFFER };
    },
  };

  const service = makeService({ provider });
  const created = await service.createProject({
    ownerUserId,
    requestId: "concurrent-worker-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump(); // submits clip
  updateClip(created.project.clips[0].id, { status: "result_processing_failed", providerTaskId: "task-conc" });
  updateProject(created.project.id, { status: "result_processing_failed" });

  providerGetStatusCalls = 0;
  // Trigger pump and retry-result concurrently
  await Promise.all([
    service.retryClipResult(created.project.id, ownerUserId, 1, "conc-req-1"),
    service.pump(),
  ]);

  await new Promise((r) => setTimeout(r, 50));
  const finalProject = service.getProject(created.project.id, ownerUserId);
  assert.equal(finalProject.status, "completed");
  assert.equal(providerGetStatusCalls, 1, "strictly 1 provider query/persist instance");
});

test("29.I & J: Continuity frame missing auto-recovery from dependency MP4; unrecoverable refunds", async () => {
  const ownerUserId = 1013;
  addUser(ownerUserId, 200);

  let ffmpegRuns = 0;
  const storage = makeStorage();
  const executor = async (_bin, args) => {
    ffmpegRuns += 1;
    await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
  };

  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-cont-task" }; },
    async getTaskStatus() { return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER }; },
  };

  const service = makeService({ provider, storage, executor });
  const created = await service.createProject({
    ownerUserId,
    requestId: "continuity-auto-recover",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  await service.pump(); // submits clip 1
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // completes clip 1

  // 29.I: Physical continuity frame asset deleted from storage while leaving outputVideo.asset intact
  const clip1Fresh = getProject(created.project.id).clips[0];
  storage.buffers.delete(clip1Fresh.continuityFrame.asset.storedPath);

  ffmpegRuns = 0;
  submitCalls = 0;
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // clip 2 prepares submission -> auto recovers continuity frame from clip 1 video -> submits clip 2
  assert.ok(ffmpegRuns > 0, "FFmpeg must have extracted frame from clip 1 MP4");
  assert.equal(submitCalls, 1, "clip 2 submitted without re-calling submitClip for clip 1");

  // 29.J: Both continuity frame and dependency outputVideo are physically missing -> unrecoverable -> refund unexecuted parts
  const unrecoverableCreated = await service.createProject({
    ownerUserId,
    requestId: "continuity-unrecoverable-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 1,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });
  await service.pump(); // submits clip 1
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // completes clip 1
  // Physically wipe both continuity frame and outputVideo from storage for clip 1
  const unrecFresh = getProject(unrecoverableCreated.project.id);
  if (unrecFresh.clips[0].continuityFrame?.asset?.storedPath) storage.buffers.delete(unrecFresh.clips[0].continuityFrame.asset.storedPath);
  if (unrecFresh.clips[0].outputVideo?.asset?.storedPath) storage.buffers.delete(unrecFresh.clips[0].outputVideo.asset.storedPath);

  const creditsBeforeUnrecoverable = findUserById(ownerUserId).credits;
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // clip 2 tries to run -> fails -> refunds clip 2
  const unrecProject = service.getProject(unrecoverableCreated.project.id, ownerUserId);
  assert.equal(unrecProject.status, "project_data_failed");
  assert.ok(findUserById(ownerUserId).credits > creditsBeforeUnrecoverable, "unexecuted clip credits refunded");
  updateProject(created.project.id, { status: "completed" });
  updateProject(unrecoverableCreated.project.id, { status: "completed" });
});

test("29.K: Missing input snapshot auto-recovery from disk (empty inputAssets)", async () => {
  const ownerUserId = 1014;
  addUser(ownerUserId, 200);

  const img = insertProductImage({
    id: 8881,
    ownerUserId,
    brandId: 1,
    originalName: "recoverable.png",
    storedPath: "uploads/recoverable.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "recoverable-sha",
    createdAt: "2026-08-27T00:00:00.000Z",
  });

  const service = makeService({
    resolver: () => frozenSourcePath,
  });

  const created = await service.createProject({
    ownerUserId,
    requestId: "input-snapshot-recover-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [img.id],
    script: makeScript({ totalDurationSec: 10 }),
  });

  // 29.K: Wipe input assets from project in DB using camelCase inputAssets
  updateProject(created.project.id, { inputAssets: [] });

  // Pump -> auto-recovers frozen input asset from disk
  await service.pump();
  const recoveredProject = getProject(created.project.id);
  assert.equal(recoveredProject.clips[0].status, "running");
  assert.equal((recoveredProject.inputAssets || []).length, 1);
  assert.equal(recoveredProject.inputAssets[0].sourceImageId, img.id);
  assert.ok(recoveredProject.inputAssets[0].asset?.storedPath);
  updateProject(created.project.id, { status: "completed" });
});

test("29.N: Existing null asset entry replacement guarantees strictly 1 record", async () => {
  const ownerUserId = 1015;
  addUser(ownerUserId, 200);

  const img = insertProductImage({
    id: 8882,
    ownerUserId,
    brandId: 1,
    originalName: "null-entry.png",
    storedPath: "uploads/null-entry.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "null-entry-sha",
    createdAt: "2026-08-27T00:00:00.000Z",
  });

  const service = makeService({
    resolver: () => frozenSourcePath,
  });

  const created = await service.createProject({
    ownerUserId,
    requestId: "input-snapshot-null-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [img.id],
    script: makeScript({ totalDurationSec: 10 }),
  });

  // Set inputAssets to an array with a null asset entry
  updateProject(created.project.id, {
    inputAssets: [{ position: 1, sourceImageId: img.id, originalName: "corrupt.png", mimeType: "image/png", sizeBytes: 0, asset: null }],
  });

  await service.pump();
  const recoveredProject = getProject(created.project.id);
  const matching = (recoveredProject.inputAssets || []).filter((x) => Number(x.sourceImageId) === Number(img.id));
  assert.equal(matching.length, 1, "strictly 1 record per sourceImageId");
  assert.ok(matching[0].asset?.storedPath, "asset is non-null and valid");
  assert.equal(recoveredProject.clips[0].status, "running");
  updateProject(created.project.id, { status: "completed" });
});

test("29.O & P: Physical local & OSS missing asset auto-refreezes from source image", async () => {
  const ownerUserId = 1016;
  addUser(ownerUserId, 200);

  const img = insertProductImage({
    id: 8883,
    ownerUserId,
    brandId: 1,
    originalName: "physical-loss.png",
    storedPath: "uploads/physical-loss.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "physical-loss-sha",
    createdAt: "2026-08-27T00:00:00.000Z",
  });

  const storage = makeStorage();
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-ref-task" }; },
    async getTaskStatus() { return { status: "running" }; },
  };

  const service = makeService({
    provider,
    storage,
    resolver: () => frozenSourcePath,
  });

  const created = await service.createProject({
    ownerUserId,
    requestId: "physical-loss-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [img.id],
    script: makeScript({ totalDurationSec: 10 }),
  });

  // 29.O: Physically remove the frozen asset buffer from storage (storage.stat will throw ENOENT)
  const initialProject = getProject(created.project.id);
  const frozenPath = initialProject.inputAssets[0].asset.storedPath;
  storage.buffers.delete(frozenPath);

  submitCalls = 0;
  await service.pump();
  const recoveredProject = getProject(created.project.id);
  const matching = (recoveredProject.inputAssets || []).filter((x) => Number(x.sourceImageId) === Number(img.id));
  assert.equal(matching.length, 1, "strictly 1 record after refreeze");
  assert.ok(matching[0].asset?.storedPath);
  assert.equal(submitCalls, 1, "clip successfully submitted");
  assert.equal(recoveredProject.clips[0].status, "running");

  // 29.P: OSS NoSuchKey simulation
  const ossProject = await service.createProject({
    ownerUserId,
    requestId: "oss-loss-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 1,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [img.id],
    script: makeScript({ totalDurationSec: 10 }),
  });
  // Point asset to objectKey and mock stat throwing NoSuchKey
  const oldStat = storage.stat;
  storage.stat = async (asset) => {
    if (asset?.objectKey === "oss-missing-key") {
      const err = new Error("The specified key does not exist.");
      err.name = "NoSuchKey";
      err.code = "NoSuchKey";
      err.status = 404;
      throw err;
    }
    return oldStat(asset);
  };
  updateProject(ossProject.project.id, {
    inputAssets: [{ position: 1, sourceImageId: img.id, originalName: "oss.png", mimeType: "image/png", sizeBytes: 10, asset: { provider: "aliyun_oss", objectKey: "oss-missing-key" } }],
  });
  submitCalls = 0;
  await service.pump();
  storage.stat = oldStat;
  const recoveredOssProject = getProject(ossProject.project.id);
  assert.equal(recoveredOssProject.inputAssets.filter((x) => Number(x.sourceImageId) === Number(img.id)).length, 1);
  assert.equal(submitCalls, 1);

  updateProject(created.project.id, { status: "completed" });
  updateProject(ossProject.project.id, { status: "completed" });
});

test("29.Q: Source product image deleted + frozen asset missing -> unrecoverable refund", async () => {
  const ownerUserId = 1017;
  addUser(ownerUserId, 200);

  const img = insertProductImage({
    id: 8884,
    ownerUserId,
    brandId: 1,
    originalName: "deleted-source.png",
    storedPath: "uploads/deleted-source.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "deleted-source-sha",
    createdAt: "2026-08-27T00:00:00.000Z",
  });

  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-fail-task" }; },
    async getTaskStatus() { return { status: "running" }; },
  };

  let resolvePath = () => frozenSourcePath;
  const service = makeService({
    provider,
    resolver: () => resolvePath(),
  });

  const created = await service.createProject({
    ownerUserId,
    requestId: "deleted-source-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [img.id],
    script: makeScript({ totalDurationSec: 10 }),
  });

  // Wipe inputAssets and switch resolver to simulate product image deletion on disk
  resolvePath = () => {
    const err = new Error("File not found on disk");
    err.code = "ENOENT";
    throw err;
  };
  updateProject(created.project.id, { inputAssets: [] });

  const creditsBefore = findUserById(ownerUserId).credits;
  await service.pump();
  const failedProject = service.getProject(created.project.id, ownerUserId);
  assert.equal(failedProject.status, "project_data_failed");
  assert.equal(submitCalls, 0, "provider submit count must be 0");
  assert.ok(findUserById(ownerUserId).credits > creditsBefore, "unexecuted clip credits refunded");
  updateProject(created.project.id, { status: "completed" });
});

test("29.R: Local video streaming error handling & client disconnect", async () => {
  const ownerUserId = 1018;
  addUser(ownerUserId, 200);

  const storage = makeStorage();
  const service = makeService({ storage });
  const created = await service.createProject({
    ownerUserId,
    requestId: "stream-err-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  const clipAsset = { provider: "local", storedPath: "generated-images/users/1018/test/clip-1.mp4", mimeType: "video/mp4", sizeBytes: MP4_BUFFER.length };
  storage.buffers.set(clipAsset.storedPath, MP4_BUFFER);
  updateClip(created.project.clips[0].id, { status: "completed", outputVideo: { asset: clipAsset, mimeType: "video/mp4", sizeBytes: MP4_BUFFER.length } });

  // 1. No-Range stream error
  const { EventEmitter, Readable } = require("stream");
  const errorStream = new Readable({
    read() {
      process.nextTick(() => this.emit("error", new Error("disk read error")));
    },
  });
  const oldCreateStream = storage.createReadStream;
  storage.createReadStream = () => errorStream;

  let destroyedWithError = null;
  const mockRes = Object.assign(new EventEmitter(), {
    headersSent: true,
    writeHead() {},
    end() {},
    destroy(err) { destroyedWithError = err; },
  });

  const served = await service.serveAsset(created.project.id, ownerUserId, "clip", 1, mockRes, { headers: {} });
  assert.equal(served, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(destroyedWithError, "res.destroy called on stream error");

  // 2. Client disconnect
  const normalStream = Readable.from(MP4_BUFFER);
  storage.createReadStream = () => normalStream;
  const clientRes = Object.assign(new EventEmitter(), {
    headersSent: true,
    writeHead() {},
    end() {},
    destroy() {},
  });
  await service.serveAsset(created.project.id, ownerUserId, "clip", 1, clientRes, { headers: {} });
  clientRes.emit("close");
  assert.equal(normalStream.destroyed, true, "source stream destroyed when client disconnects");

  storage.createReadStream = oldCreateStream;
  updateProject(created.project.id, { status: "completed" });
});

test("29.S: startProject state matrix enforces valid transitions", async () => {
  const ownerUserId = 1019;
  addUser(ownerUserId, 200);

  const service = makeService();
  const created = await service.createProject({
    ownerUserId,
    requestId: "start-matrix-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  // preparing -> queued
  updateProject(created.project.id, { status: "preparing" });
  const p1 = service.startProject(created.project.id, ownerUserId);
  assert.equal(p1.status, "queued");

  // queued -> queued
  const p2 = service.startProject(created.project.id, ownerUserId);
  assert.equal(p2.status, "queued");

  // Other statuses remain unchanged
  const unmodifiableStatuses = [
    "running",
    "processing_result",
    "result_processing_failed",
    "assembly_failed",
    "partial_failed",
    "uncertain",
    "project_data_failed",
    "completed",
    "failed",
    "cancelled",
  ];

  for (const st of unmodifiableStatuses) {
    updateProject(created.project.id, { status: st });
    const res = service.startProject(created.project.id, ownerUserId);
    assert.equal(res.status, st, "startProject must not change " + st);
    const fresh = service.getProject(created.project.id, ownerUserId);
    assert.equal(fresh.status, st);
  }
  updateProject(created.project.id, { status: "completed" });
});

test("29.T: Top-level project status becomes processing_result when provider completes", async () => {
  const ownerUserId = 1020;
  addUser(ownerUserId, 200);

  const provider = {
    provider: "fake",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { return { taskId: "task-pr-top" }; },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER };
    },
  };

  const service = makeService({ provider });
  const created = await service.createProject({
    ownerUserId,
    requestId: "pr-top-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump(); // submits clip
  updateClip(created.project.clips[0].id, { status: "result_processing_failed", providerTaskId: "task-pr-top" });
  updateProject(created.project.id, { status: "result_processing_failed" });

  // Claim retry-result -> project must be processing_result
  const claim = await service.retryClipResult(created.project.id, ownerUserId, 1, "retry-claim-pr");
  assert.equal(claim.project.status, "processing_result");
  assert.equal(claim.project.clips[0].status, "processing_result");

  updateProject(created.project.id, { status: "completed" });
});

test("29.M: Stream download disk write error causes Promise rejection without Node crash", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-err-test-"));
  // Target is a directory path -> writing to a directory throws EISDIR/EPERM
  const invalidTarget = tmpDir;

  await assert.rejects(
    downloadProviderMediaToFile("https://provider.example/test.mp4", {
      targetPath: invalidTarget,
      allowedHosts: ["provider.example"],
      maxBytes: 1024,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => String(n).toLowerCase() === "content-type" ? "video/mp4" : "" },
        async arrayBuffer() {
          return Uint8Array.from(MP4_BUFFER).buffer;
        },
      }),
    }),
  );
});

test("R7.1: Multi-reference recovery (D2 A/B/C all physically missing) preserves all 3 inputs without stale snapshot overwrite", async () => {
  const ownerUserId = 1021;
  addUser(ownerUserId, 300);

  const pathA = path.join(sourceDir, "ref-71-a.png");
  const pathB = path.join(sourceDir, "ref-71-b.png");
  const pathC = path.join(sourceDir, "ref-71-c.png");
  fs.writeFileSync(pathA, Buffer.from("image-payload-71-a"));
  fs.writeFileSync(pathB, Buffer.from("image-payload-71-b"));
  fs.writeFileSync(pathC, Buffer.from("image-payload-71-c"));

  const imgA = insertProductImage({ id: 8901, ownerUserId, brandId: 1, originalName: "ref-71-a.png", storedPath: "uploads/ref-71-a.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-71-a", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgB = insertProductImage({ id: 8902, ownerUserId, brandId: 1, originalName: "ref-71-b.png", storedPath: "uploads/ref-71-b.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-71-b", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgC = insertProductImage({ id: 8903, ownerUserId, brandId: 1, originalName: "ref-71-c.png", storedPath: "uploads/ref-71-c.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-71-c", createdAt: "2026-08-27T00:00:00.000Z" });

  const storage = makeStorage();
  let lastSubmitArgs = null;
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip(args) {
      submitCalls += 1;
      lastSubmitArgs = args;
      return { taskId: "d2-multi-ref-71" };
    },
    async getTaskStatus() { return { status: "running" }; },
  };

  const resolver = (image) => {
    if (Number(image?.id) === 8901) return pathA;
    if (Number(image?.id) === 8902) return pathB;
    if (Number(image?.id) === 8903) return pathC;
    return frozenSourcePath;
  };

  const service = makeService({ provider, storage, resolver });
  const created = await service.createProject({
    ownerUserId,
    requestId: "multi-ref-71-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [imgA.id, imgB.id, imgC.id],
    script: {
      title: "多参考图恢复测试",
      creativeConcept: "多图概念",
      totalDurationSec: 10,
      aspectRatio: "9:16",
      model: "d2",
      mode: "image",
      clips: [{
        index: 1,
        purpose: "镜头 1",
        scene: "场景 1",
        subjectAction: "动作 1",
        cameraMovement: "运镜 1",
        environmentMotion: "动态 1",
        lightingAndStyle: "光影 1",
        continuity: "连续性 1",
        prompt: "提示词 1",
        generationDurationSec: 10,
        referenceAssetIds: [imgA.id, imgB.id, imgC.id],
      }],
    },
  });

  const initialProject = getProject(created.project.id);
  assert.equal(initialProject.inputAssets.length, 3);
  // Physically wipe all 3 frozen assets from storage
  for (const item of initialProject.inputAssets) {
    storage.buffers.delete(item.asset.storedPath);
  }

  await service.pump();

  const recoveredProject = getProject(created.project.id);
  assert.equal(recoveredProject.inputAssets.length, 3, "must have strictly 3 inputAssets");

  const recoveredSourceIds = recoveredProject.inputAssets.map((x) => Number(x.sourceImageId));
  assert.deepEqual(recoveredSourceIds.sort(), [8901, 8902, 8903], "each sourceImageId A/B/C exactly 1 record");

  const positions = recoveredProject.inputAssets.map((x) => x.position);
  assert.equal(new Set(positions).size, 3, "positions must be strictly unique");

  for (const item of recoveredProject.inputAssets) {
    assert.ok(storage.buffers.has(item.asset.storedPath), `asset for sourceImageId ${item.sourceImageId} must physically exist in storage`);
  }

  assert.equal(submitCalls, 1);
  assert.ok(lastSubmitArgs);
  assert.equal(lastSubmitArgs.referenceUrls.length, 3, "provider must receive 3 reference URLs");
  assert.equal(new Set(lastSubmitArgs.referenceUrls).size, 3, "provider reference URLs must be distinct");

  // Verify serving each position returns the distinct buffer
  for (const item of recoveredProject.inputAssets) {
    const mockRes = createMockHttpResponse();
    await service.serveAsset(recoveredProject.id, ownerUserId, "input", item.position, mockRes, { headers: {} });
    assert.equal(mockRes.statusCode, 200);
    const expectedContent = item.sourceImageId === 8901 ? "image-payload-71-a" : (item.sourceImageId === 8902 ? "image-payload-71-b" : "image-payload-71-c");
    assert.equal(mockRes.body.toString(), expectedContent);
  }

  updateProject(created.project.id, { status: "completed" });
});

test("R7.2: inputAssets=[] with multi-reference (A/B/C) recovers all snapshots with unique positions & URLs", async () => {
  const ownerUserId = 1022;
  addUser(ownerUserId, 300);

  const pathA = path.join(sourceDir, "ref-72-a.png");
  const pathB = path.join(sourceDir, "ref-72-b.png");
  const pathC = path.join(sourceDir, "ref-72-c.png");
  fs.writeFileSync(pathA, Buffer.from("image-payload-72-a"));
  fs.writeFileSync(pathB, Buffer.from("image-payload-72-b"));
  fs.writeFileSync(pathC, Buffer.from("image-payload-72-c"));

  const imgA = insertProductImage({ id: 8904, ownerUserId, brandId: 1, originalName: "ref-72-a.png", storedPath: "uploads/ref-72-a.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-72-a", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgB = insertProductImage({ id: 8905, ownerUserId, brandId: 1, originalName: "ref-72-b.png", storedPath: "uploads/ref-72-b.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-72-b", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgC = insertProductImage({ id: 8906, ownerUserId, brandId: 1, originalName: "ref-72-c.png", storedPath: "uploads/ref-72-c.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-72-c", createdAt: "2026-08-27T00:00:00.000Z" });

  const storage = makeStorage();
  let lastSubmitArgs = null;
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip(args) {
      submitCalls += 1;
      lastSubmitArgs = args;
      return { taskId: "d2-multi-ref-72" };
    },
    async getTaskStatus() { return { status: "running" }; },
  };

  const resolver = (image) => {
    if (Number(image?.id) === 8904) return pathA;
    if (Number(image?.id) === 8905) return pathB;
    if (Number(image?.id) === 8906) return pathC;
    return frozenSourcePath;
  };

  const service = makeService({ provider, storage, resolver });
  const created = await service.createProject({
    ownerUserId,
    requestId: "multi-ref-72-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [imgA.id, imgB.id, imgC.id],
    script: {
      title: "空数组恢复测试",
      creativeConcept: "多图空数组概念",
      totalDurationSec: 10,
      aspectRatio: "9:16",
      model: "d2",
      mode: "image",
      clips: [{
        index: 1,
        purpose: "镜头 1",
        scene: "场景 1",
        subjectAction: "动作 1",
        cameraMovement: "运镜 1",
        environmentMotion: "动态 1",
        lightingAndStyle: "光影 1",
        continuity: "连续性 1",
        prompt: "提示词 1",
        generationDurationSec: 10,
        referenceAssetIds: [imgA.id, imgB.id, imgC.id],
      }],
    },
  });

  // Wipe inputAssets from project table in DB
  updateProject(created.project.id, { inputAssets: [] });

  await service.pump();

  const recoveredProject = getProject(created.project.id);
  assert.equal(recoveredProject.inputAssets.length, 3, "must have 3 recovered inputAssets");

  const positions = recoveredProject.inputAssets.map((x) => x.position);
  assert.equal(new Set(positions).size, 3, "positions must not duplicate");

  for (const item of recoveredProject.inputAssets) {
    assert.ok(storage.buffers.has(item.asset.storedPath), "recovered asset physically exists");
  }

  assert.equal(submitCalls, 1);
  assert.equal(lastSubmitArgs.referenceUrls.length, 3);
  assert.equal(new Set(lastSubmitArgs.referenceUrls).size, 3, "provider reference URLs must not duplicate");

  updateProject(created.project.id, { status: "completed" });
});

test("R7.3: Mixed multi-reference recovery (A=valid, B=missing physical, C=null asset)", async () => {
  const ownerUserId = 1023;
  addUser(ownerUserId, 300);

  const pathA = path.join(sourceDir, "ref-73-a.png");
  const pathB = path.join(sourceDir, "ref-73-b.png");
  const pathC = path.join(sourceDir, "ref-73-c.png");
  fs.writeFileSync(pathA, Buffer.from("image-payload-73-a"));
  fs.writeFileSync(pathB, Buffer.from("image-payload-73-b"));
  fs.writeFileSync(pathC, Buffer.from("image-payload-73-c"));

  const imgA = insertProductImage({ id: 8907, ownerUserId, brandId: 1, originalName: "ref-73-a.png", storedPath: "uploads/ref-73-a.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-73-a", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgB = insertProductImage({ id: 8908, ownerUserId, brandId: 1, originalName: "ref-73-b.png", storedPath: "uploads/ref-73-b.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-73-b", createdAt: "2026-08-27T00:00:00.000Z" });
  const imgC = insertProductImage({ id: 8909, ownerUserId, brandId: 1, originalName: "ref-73-c.png", storedPath: "uploads/ref-73-c.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-73-c", createdAt: "2026-08-27T00:00:00.000Z" });

  const storage = makeStorage();
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-multi-ref-73" }; },
    async getTaskStatus() { return { status: "running" }; },
  };

  const resolver = (image) => {
    if (Number(image?.id) === 8907) return pathA;
    if (Number(image?.id) === 8908) return pathB;
    if (Number(image?.id) === 8909) return pathC;
    return frozenSourcePath;
  };

  const service = makeService({ provider, storage, resolver });
  const created = await service.createProject({
    ownerUserId,
    requestId: "multi-ref-73-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [imgA.id, imgB.id, imgC.id],
    script: {
      title: "混合状态恢复测试",
      creativeConcept: "混合概念",
      totalDurationSec: 10,
      aspectRatio: "9:16",
      model: "d2",
      mode: "image",
      clips: [{
        index: 1,
        purpose: "镜头 1",
        scene: "场景 1",
        subjectAction: "动作 1",
        cameraMovement: "运镜 1",
        environmentMotion: "动态 1",
        lightingAndStyle: "光影 1",
        continuity: "连续性 1",
        prompt: "提示词 1",
        generationDurationSec: 10,
        referenceAssetIds: [imgA.id, imgB.id, imgC.id],
      }],
    },
  });

  const initProject = getProject(created.project.id);
  const assetA = initProject.inputAssets.find((x) => x.sourceImageId === imgA.id);
  const assetB = initProject.inputAssets.find((x) => x.sourceImageId === imgB.id);

  // A = valid (kept in storage)
  // B = missing physical (delete from storage)
  storage.buffers.delete(assetB.asset.storedPath);
  // C = null asset entry
  const customInputs = [
    assetA,
    assetB,
    { position: 3, sourceImageId: imgC.id, originalName: "ref-73-c.png", mimeType: "image/png", sizeBytes: 0, asset: null },
  ];
  updateProject(created.project.id, { inputAssets: customInputs });

  let saveCalls = [];
  const origSave = storage.save.bind(storage);
  storage.save = async (args) => {
    saveCalls.push(args.variant);
    return origSave(args);
  };

  await service.pump();

  const recoveredProject = getProject(created.project.id);
  assert.equal(recoveredProject.inputAssets.length, 3);

  const finalA = recoveredProject.inputAssets.find((x) => x.sourceImageId === imgA.id);
  const finalB = recoveredProject.inputAssets.find((x) => x.sourceImageId === imgB.id);
  const finalC = recoveredProject.inputAssets.find((x) => x.sourceImageId === imgC.id);

  assert.equal(finalA.asset.storedPath, assetA.asset.storedPath, "A was valid so it was not re-saved");
  assert.ok(saveCalls.includes("input-2"), "B was refrozen");
  assert.ok(saveCalls.includes("input-3"), "C was refrozen");
  assert.ok(!saveCalls.includes("input-1"), "A was valid, not re-saved");
  assert.ok(finalC.asset?.storedPath, "C had null asset so it was refrozen");
  assert.ok(storage.buffers.has(finalA.asset.storedPath));
  assert.ok(storage.buffers.has(finalB.asset.storedPath));
  assert.ok(storage.buffers.has(finalC.asset.storedPath));
  assert.equal(submitCalls, 1);

  updateProject(created.project.id, { status: "completed" });
});

test("R7.4: Generation snapshot sync failure during input asset recovery does NOT delete new physical asset", async () => {
  const ownerUserId = 1024;
  addUser(ownerUserId, 300);

  const pathA = path.join(sourceDir, "ref-74-a.png");
  fs.writeFileSync(pathA, Buffer.from("image-payload-74-a"));
  const imgA = insertProductImage({ id: 8910, ownerUserId, brandId: 1, originalName: "ref-74-a.png", storedPath: "uploads/ref-74-a.png", mimeType: "image/png", sizeBytes: 18, sha256: "sha-74-a", createdAt: "2026-08-27T00:00:00.000Z" });

  const storage = makeStorage();
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-multi-ref-74" }; },
    async getTaskStatus() { return { status: "running" }; },
  };

  const service = makeService({ provider, storage, resolver: () => pathA });
  const created = await service.createProject({
    ownerUserId,
    requestId: "multi-ref-74-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    totalDurationSec: 10,
    referenceAssetIds: [imgA.id],
    script: makeScript({ totalDurationSec: 10 }),
  });

  // Physically wipe initial frozen asset from storage
  const initialProject = getProject(created.project.id);
  storage.buffers.delete(initialProject.inputAssets[0].asset.storedPath);

  // Set trigger to make upsertGeneration fail during snapshot update
  db.prepare("CREATE TRIGGER fail_gen_upsert_74 BEFORE UPDATE ON generations BEGIN SELECT RAISE(FAIL, 'generation snapshot DB error'); END;").run();

  try {
    // Pump -> recovers frozen input -> DB update succeeds -> snapshot fails and logs warning -> pump completes
    await service.pump();
  } finally {
    db.prepare("DROP TRIGGER fail_gen_upsert_74;").run();
  }

  const recoveredProject = getProject(created.project.id);
  assert.equal(recoveredProject.inputAssets.length, 1);
  const newAsset = recoveredProject.inputAssets[0].asset;
  assert.ok(newAsset?.storedPath, "project DB points to new asset");
  assert.ok(storage.buffers.has(newAsset.storedPath), "new asset must NOT be deleted even if generation snapshot update failed");
  assert.equal(submitCalls, 1, "clip proceeds to provider submission");

  updateProject(created.project.id, { status: "completed" });
});

test("R7.5: Generation snapshot sync failure during continuity frame recovery does NOT delete new frame asset", async () => {
  const ownerUserId = 1025;
  addUser(ownerUserId, 300);

  const storage = makeStorage();
  let submitCalls = 0;
  const provider = {
    provider: "d2",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { submitCalls += 1; return { taskId: "d2-cont-75" }; },
    async getTaskStatus() { return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER }; },
  };

  const service = makeService({ provider, storage });
  const created = await service.createProject({
    ownerUserId,
    requestId: "cont-75-proj",
    brandId: 1,
    trendId: 1,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    totalDurationSec: 15,
    script: makeScript({ totalDurationSec: 15, clipCount: 2 }),
  });

  await service.pump(); // submits clip 1
  await new Promise((r) => setTimeout(r, 10));
  await service.pump(); // completes clip 1

  // Physically delete continuity frame asset from storage (leaving outputVideo intact)
  const clip1 = getProject(created.project.id).clips[0];
  storage.buffers.delete(clip1.continuityFrame.asset.storedPath);

  // Make generation snapshot update fail
  db.prepare("CREATE TRIGGER fail_gen_upsert_75 BEFORE UPDATE ON generations BEGIN SELECT RAISE(FAIL, 'generation snapshot DB error'); END;").run();

  submitCalls = 0;
  try {
    await new Promise((r) => setTimeout(r, 10));
    await service.pump(); // clip 2 extracts continuity frame from clip 1 video -> snapshot sync fails (caught) -> clip 2 submits
  } finally {
    db.prepare("DROP TRIGGER fail_gen_upsert_75;").run();
  }

  const freshClip1 = getProject(created.project.id).clips[0];
  assert.ok(freshClip1.continuityFrame?.asset?.storedPath);
  assert.ok(storage.buffers.has(freshClip1.continuityFrame.asset.storedPath), "new continuity frame buffer must NOT be deleted");
  assert.equal(submitCalls, 1, "clip 2 submitted successfully");

  updateProject(created.project.id, { status: "completed" });
});
