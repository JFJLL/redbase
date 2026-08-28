const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const path = require("path");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertProductImage } = require("../src/server/db/repositories/product-image-repository");
const { updateClip } = require("../src/server/db/repositories/video-project-repository");
const { createVideoProjectService } = require("../src/server/video/video-project-service");
const {
  getVideoModelConfig,
  segmentVideoDuration,
  estimateVideoCredits,
  getPublicVideoCapabilities,
} = require("../src/server/video/video-model-registry");
const { createAgnesKeyPool } = require("../src/server/video/agnes-key-pool");
const { createD2Provider } = require("../src/server/video/providers/d2-provider");
const { createG2Provider } = require("../src/server/video/providers/g2-provider");
const { validateGeneratedAssetInput } = require("../src/server/assets/generated-asset-utils");
const { collectGenerationAssets } = require("../src/server/assets/generation-deletion-service");
const { sanitizeGeneration } = require("../src/server/utils");
const { assertSafeProviderUrl, downloadProviderMedia } = require("../src/server/video/video-remote");
const { extractStableLastFrame, withVideoTempDir } = require("../src/server/video/video-frame-extractor");
const { assembleVideoClips } = require("../src/server/video/video-assembler");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

insertUser({
  id: 901,
  name: "Video Tester",
  phone: "13900000901",
  password: "hash",
  accountType: "customer",
  credits: 100,
  createdAt: "2026-08-26T00:00:00.000Z",
});

for (const id of [902, 903, 904, 905, 906, 907, 908, 909, 910, 911]) {
  insertUser({
    id,
    name: `Video Tester ${id}`,
    phone: `13900000${String(id).padStart(3, "0")}`,
    password: "hash",
    accountType: "customer",
    credits: 300,
    createdAt: "2026-08-26T00:00:00.000Z",
  });
}

for (let index = 1; index <= 9; index += 1) {
  insertProductImage({
    id: 9020 + index,
    ownerUserId: 902,
    brandId: 1,
    originalName: `product-${index}.png`,
    storedPath: `uploads/video-tests/902/product-${index}.png`,
    mimeType: "image/png",
    sizeBytes: 4,
    sha256: `video-test-sha-${index}`,
    createdAt: "2026-08-26T00:00:00.000Z",
  });
}
insertProductImage({
  id: 9041,
  ownerUserId: 904,
  brandId: 1,
  originalName: "g2-reference.png",
  storedPath: "uploads/video-tests/904/g2-reference.png",
  mimeType: "image/png",
  sizeBytes: 4,
  sha256: "video-test-g2-reference",
  createdAt: "2026-08-26T00:00:00.000Z",
});

const MP4_BUFFER = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(12)]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeScript(totalDurationSec = 10, clipCount = 1) {
  const baseClip = {
    purpose: "开场",
    scene: "桌面",
    subjectReference: "产品",
    subjectAction: "缓慢旋转",
    cameraMovement: "推近",
    environmentMotion: "光影流动",
    lightingAndStyle: "自然光",
    continuity: "保持主体位置",
  };
  return {
    title: "测试视频",
    creativeConcept: "连续展示产品质感",
    totalDurationSec,
    aspectRatio: "9:16",
    globalSubjectReference: "产品主体保持一致",
    globalStyleReference: "自然光",
    globalContinuity: "前后镜头连续",
    audioDirection: { music: "轻快", ambience: "环境声", voiceStyle: "自然" },
    clips: Array.from({ length: clipCount }, (_, index) => ({ ...baseClip, index: index + 1, purpose: `分镜 ${index + 1}` })),
  };
}

function makeStorage() {
  const buffers = new Map();
  return {
    provider: "local",
    buffers,
    async save({ ownerUserId, generationId, variant, mimeType, buffer }) {
      const extension = mimeType === "video/mp4" ? "mp4" : "jpg";
      const storedPath = `generated-images/users/${ownerUserId}/2026/08/${generationId}/gi_${generationId}_${variant}_test.${extension}`;
      const asset = { provider: "local", storedPath, objectKey: "", mimeType, sizeBytes: buffer.length };
      buffers.set(storedPath, Buffer.from(buffer));
      return asset;
    },
    async readBuffer(asset) {
      return Buffer.from(buffers.get(asset.storedPath));
    },
    async createReadUrl() {
      return "https://assets.example/video.mp4";
    },
  };
}

function makeProvider({ failNext = false } = {}) {
  let nextTask = 1;
  let shouldFail = failNext;
  return {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip() {
      const taskId = `fake-${nextTask++}`;
      return { taskId };
    },
    async getTaskStatus() {
      if (shouldFail) {
        shouldFail = false;
        return { status: "failed", error: "fake provider failure" };
      }
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
}

function makeService(provider, storage = makeStorage(), overrides = {}) {
  return createVideoProjectService({
    appConfig: overrides.appConfig || {
      security: { assetSigningSecret: "video-test-secret" },
      video: {
        publicBaseUrl: "https://redbase.example",
        schedulerIntervalMs: 1000,
        pollIntervalMs: 1,
        agnes: { apiKeys: [], pollIntervalMs: 1, maxClipAttempts: overrides.g2MaxClipAttempts || 3 },
      },
    },
    generatedAssetStorage: storage,
    providers: overrides.providers || { d2: provider, g2: provider },
    keyPool: overrides.keyPool || createAgnesKeyPool({ keys: ["test-key-a", "test-key-b"], rpmPerKey: 60 }),
    executor: overrides.executor || (async (_binary, args) => {
      await fsp.writeFile(args[args.length - 1], MP4_BUFFER);
    }),
    now: overrides.now || (() => Date.now()),
    fetchImpl: overrides.fetchImpl,
    allowLegacyScript: true,
  });
}

async function settleProject(service, projectId, ownerUserId, maxIterations = 30) {
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    await service.pump();
    const project = service.getProject(projectId, ownerUserId);
    if (["completed", "partial_failed", "uncertain", "assembly_failed", "failed", "cancelled"].includes(project?.status)) return project;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`项目 ${projectId} 未在测试窗口内结束`);
}

test("video registry enforces D2/G2 clip rules and pricing", () => {
  assert.deepEqual(segmentVideoDuration("d2", 10), [10]);
  assert.deepEqual(segmentVideoDuration("d2", 15), [10, 5]);
  assert.deepEqual(segmentVideoDuration("d2", 60), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(segmentVideoDuration("g2", 10), [10]);
  assert.deepEqual(segmentVideoDuration("g2", 15), [10, 5]);
  assert.deepEqual(segmentVideoDuration("g2", 30), [10, 10, 10]);
  assert.deepEqual(segmentVideoDuration("g2", 45), [10, 10, 10, 10, 5]);
  assert.deepEqual(segmentVideoDuration("g2", 60), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(segmentVideoDuration("g2", 9), []);
  assert.deepEqual(getVideoModelConfig("d2").resolutions, ["720p", "1080p", "2K"]);
  assert.deepEqual(getVideoModelConfig("d2").aspectRatios, ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
  assert.equal(getVideoModelConfig("d2").maxReferenceImages, 9);
  assert.equal(getVideoModelConfig("g2").maxReferenceImages, 5);
  assert.equal(estimateVideoCredits({ model: "d2", resolution: "720p", totalDurationSec: 15 }), 30);
  assert.equal(estimateVideoCredits({ model: "d2", resolution: "1080p", totalDurationSec: 10 }), 30);
  assert.equal(estimateVideoCredits({ model: "d2", resolution: "2K", totalDurationSec: 10 }), 40);
  assert.equal(estimateVideoCredits({ model: "g2", clipDurations: [5] }), 1);
  assert.equal(estimateVideoCredits({ model: "g2", totalDurationSec: 10 }), 2);
  assert.equal(estimateVideoCredits({ model: "g2", totalDurationSec: 15 }), 3);
  assert.equal(getVideoModelConfig("d2").hiddenDefaults.generateAudio, true);
  assert.equal(getVideoModelConfig("g2").providerCapabilities.supportsVideoInput, false);
  assert.deepEqual(getPublicVideoCapabilities().map((model) => model.id), ["d2", "g2"]);
});

test("Agnes key pool never exposes API keys and applies per-key cooldown", () => {
  let clock = 0;
  const pool = createAgnesKeyPool({ keys: ["a", "b"], rpmPerKey: 60, now: () => clock, cooldownMs: 1000 });
  const lease = pool.acquire();
  assert.equal(lease.key, "a");
  pool.release(lease.slot, { statusCode: 429 });
  assert.equal(pool.snapshot().some((slot) => Object.prototype.hasOwnProperty.call(slot, "key")), false);
  clock = 1001;
  assert.ok(pool.acquire());
});

test("Agnes key pool can exclude the previous key when retrying a clip", () => {
  const pool = createAgnesKeyPool({ keys: ["a", "b", "c"], rpmPerKey: 60 });
  const first = pool.acquire();
  pool.release(first.slot, {});
  const second = pool.acquire({ excludeKeyRefs: [first.keyRef] });
  assert.ok(second);
  assert.notEqual(second.keyRef, first.keyRef);
  assert.equal(pool.hasAlternativeKey(first.keyRef), true);
});

test("Agnes polling leases do not consume the submission RPM slot", () => {
  let clock = 0;
  const pool = createAgnesKeyPool({ keys: ["single-key"], rpmPerKey: 1, now: () => clock });
  const submission = pool.acquire();
  assert.ok(submission);
  pool.release(submission.slot, {});
  const polling = pool.acquire({ rateLimit: false });
  assert.ok(polling);
  pool.release(polling.slot, {});
  assert.equal(pool.acquire(), null);
  clock = 60001;
  assert.ok(pool.acquire());
});

test("generated asset validation accepts MP4 but rejects a fake MP4 header", () => {
  const valid = validateGeneratedAssetInput({ ownerUserId: 901, generationId: 1, variant: "clip-1", mimeType: "video/mp4", buffer: MP4_BUFFER });
  assert.equal(valid.mimeType, "video/mp4");
  assert.throws(() => validateGeneratedAssetInput({ ownerUserId: 901, generationId: 1, variant: "clip-1", mimeType: "video/mp4", buffer: Buffer.from("not-video") }), /content does not match/);
});

test("provider media downloads reject insecure hosts and private redirect targets", async () => {
  assert.throws(() => assertSafeProviderUrl("http://provider.example/clip.mp4", { allowedHosts: ["provider.example"] }), /HTTPS/);
  assert.throws(() => assertSafeProviderUrl("https://127.0.0.1/clip.mp4", { allowedHosts: ["provider.example"] }), /host/);
  assert.throws(() => assertSafeProviderUrl("https://evil.example/clip.mp4", { allowedHosts: ["provider.example"] }), /host/);

  let fetchCount = 0;
  await assert.rejects(downloadProviderMedia("https://provider.example/clip.mp4", {
    allowedHosts: ["provider.example"],
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => String(name).toLowerCase() === "location" ? "https://127.0.0.1/private.mp4" : "" },
      };
    },
  }), /host/);
  assert.equal(fetchCount, 1);
});

test("D2 and G2 provider adapters send only the approved product contract fields", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async json() {
        return String(url).includes("agnes") ? { video_id: "g2-task" } : { taskId: "d2-task" };
      },
    };
  };
  const d2 = createD2Provider({ appConfig: { video: { runninghub: { apiKey: "d2-key" } } }, fetchImpl });
  const g2 = createG2Provider({ appConfig: { video: { agnes: { baseUrl: "https://api.agnes-ai.cn" } } }, fetchImpl });
  await d2.submitClip({ prompt: "d2 prompt", resolution: "720p", durationSec: 10, aspectRatio: "9:16", referenceUrls: ["https://redbase.example/a"] });
  await g2.submitClip({ apiKey: "g2-key", prompt: "g2 prompt", durationSec: 5, aspectRatio: "9:16", mode: "reference", referenceUrls: ["https://redbase.example/a"] });
  const d2Body = JSON.parse(calls[0].options.body);
  const g2Body = JSON.parse(calls[1].options.body);
  assert.deepEqual(d2Body, {
    prompt: "d2 prompt\n\n【D2 参考图对应关系】\n@Image 1：产品参考图\n请严格保持上述 @Image 编号与实际参考图顺序一致，不引用不存在的图片编号。",
    resolution: "720p",
    duration: "10",
    generateAudio: true,
    ratio: "9:16",
    realPersonMode: true,
    conversionSlots: ["all"],
    returnLastFrame: true,
    seed: -1,
    imageUrls: ["https://redbase.example/a"],
  });
  assert.deepEqual(g2Body, {
    model: "agnes-video-2.5-flash",
    prompt: "g2 prompt",
    mode: "reference",
    seconds: "5",
    size: "720P",
    aspect_ratio: "9:16",
    seed: 0,
    n: 1,
    images: ["https://redbase.example/a"],
  });
});

test("FFmpeg helpers inject the binary, prefer the stable tail offset, retry failures, and clean temp files", async () => {
  let tempDir = "";
  const calls = [];
  await withVideoTempDir(async (directory) => {
    tempDir = directory;
    const sourcePath = path.join(directory, "source.mp4");
    const framePath = path.join(directory, "continuity.jpg");
    const clipPath = path.join(directory, "clip.mp4");
    const finalPath = path.join(directory, "final.mp4");
    await fsp.writeFile(sourcePath, MP4_BUFFER);
    await fsp.writeFile(clipPath, MP4_BUFFER);
    const executor = async (binary, args) => {
      calls.push({ binary, args });
      await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
    };

    const extracted = await extractStableLastFrame({
      videoPath: sourcePath,
      outputPath: framePath,
      appConfig: { video: { ffmpegPath: "C:/app/ffmpeg.exe" } },
      executor,
    });
    assert.equal(extracted.ffmpegPath, "C:/app/ffmpeg.exe");
    assert.equal(extracted.offsetSeconds, 0.3);
    assert.deepEqual(calls[0].args.slice(0, 6), ["-hide_banner", "-loglevel", "error", "-sseof", "-0.300", "-i"]);

    await assembleVideoClips({
      clipPaths: [clipPath],
      outputPath: finalPath,
      appConfig: { video: { ffmpegPath: "C:/app/ffmpeg.exe" } },
      executor,
    });
    await assert.rejects(fsp.access(`${finalPath}.concat.txt`));
  });
  await assert.rejects(fsp.access(tempDir));

  let failureAttempts = 0;
  await withVideoTempDir(async (directory) => {
    await assert.rejects(extractStableLastFrame({
      videoPath: path.join(directory, "missing.mp4"),
      outputPath: path.join(directory, "missing.jpg"),
      appConfig: {},
      executor: async () => {
        failureAttempts += 1;
        throw new Error("ffmpeg failure");
      },
    }), /ffmpeg failure/);
  });
  assert.equal(failureAttempts, 3);
});

test("provider native last frame wins and is persisted without an unnecessary FFmpeg extraction", async () => {
  const storage = makeStorage();
  const calls = [];
  const provider = {
    provider: "native",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() {
      return { taskId: "native-task" };
    },
    async getTaskStatus() {
      return {
        status: "completed",
        videoUrl: "https://provider.example/clip.mp4",
        nativeLastFrameUrl: "https://provider.example/last.jpg",
      };
    },
  };
  const service = makeService(provider, storage, {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? (String(url).endsWith(".jpg") ? "image/jpeg" : "video/mp4") : "" },
      async arrayBuffer() {
        const source = String(url).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER;
        return Uint8Array.from(source).buffer;
      },
    }),
    executor: async (_binary, args) => {
      calls.push(args);
      await fsp.writeFile(args[args.length - 1], MP4_BUFFER);
    },
  });
  const result = await service.createProject({
    ownerUserId: 906,
    requestId: "video-native-last-frame",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  const completed = await settleProject(service, result.project.id, 906);
  assert.equal(completed.status, "completed");
  assert.equal(calls.some((args) => args.includes("-sseof")), false);
  assert.ok([...storage.buffers.values()].some((buffer) => buffer.equals(JPEG_BUFFER)));
});

test("G2 falls back to FFmpeg for a stable continuity frame before the final clip", async () => {
  const storage = makeStorage();
  const ffmpegCalls = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip() { return { taskId: "g2-frame-task" }; },
    async getTaskStatus() { return { status: "completed", videoBuffer: MP4_BUFFER }; },
  };
  const service = makeService(provider, storage, {
    executor: async (_binary, args) => {
      ffmpegCalls.push(args);
      await fsp.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
    },
  });
  const result = await service.createProject({
    ownerUserId: 905,
    requestId: "video-g2-ffmpeg-fallback",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 15,
    script: makeScript(15, 2),
  });
  const completed = await settleProject(service, result.project.id, 905);
  assert.equal(completed.status, "completed");
  assert.ok(ffmpegCalls.some((args) => args.includes("-sseof") && args.includes("-0.300")));
  assert.ok([...storage.buffers.values()].some((buffer) => buffer.equals(JPEG_BUFFER)));
});

test("D2 projects run clips sequentially and carry the previous continuity frame within the reference limit", async () => {
  const storage = makeStorage();
  const submissions = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      submissions.push(args);
      return { taskId: `d2-sequential-${submissions.length}` };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const service = makeService(provider, storage);
  const result = await service.createProject({
    ownerUserId: 902,
    requestId: "video-d2-sequential",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "image",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 15,
    referenceAssetIds: [9021, 9022, 9023, 9024, 9025, 9026, 9027, 9028, 9029],
    script: makeScript(15, 2),
  });

  await service.pump();
  const running = service.getProject(result.project.id, 902);
  assert.equal(running.clips[0].status, "running");
  assert.equal(running.clips[1].status, "waiting_dependency");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].referenceUrls.length, 9);

  const completed = await settleProject(service, result.project.id, 902);
  assert.equal(completed.status, "completed");
  assert.equal(completed.clips.length, 2);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].referenceUrls.length, 9);
  assert.match(submissions[1].referenceUrls[0], /continuity-frame\/1/);
  assert.equal(completed.clips[1].continuityMode, "image");
});

test("separate D2 projects submit in parallel while each project remains independently schedulable", async () => {
  const storage = makeStorage();
  let active = 0;
  let maxActive = 0;
  let taskNumber = 0;
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      taskNumber += 1;
      return { taskId: `d2-parallel-${taskNumber}` };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const service = makeService(provider, storage);
  const first = await service.createProject({
    ownerUserId: 903,
    requestId: "video-d2-parallel-a",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea A" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  const second = await service.createProject({
    ownerUserId: 908,
    requestId: "video-d2-parallel-b",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea B" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 1,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump();
  assert.equal(maxActive, 2);
  assert.equal(service.getProject(first.project.id, 903).clips[0].status, "running");
  assert.equal(service.getProject(second.project.id, 908).clips[0].status, "running");
  assert.equal((await settleProject(service, first.project.id, 903)).status, "completed");
  assert.equal((await settleProject(service, second.project.id, 908)).status, "completed");
});

test("G2 maps text, reference, and keyframe modes while rotating submission keys", async () => {
  let clock = 0;
  const storage = makeStorage();
  const submissions = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      submissions.push(args);
      return { taskId: `g2-modes-${submissions.length}` };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const service = makeService(provider, storage, {
    now: () => clock,
    keyPool: createAgnesKeyPool({ keys: ["g2-test-a", "g2-test-b"], rpmPerKey: 60, now: () => clock }),
  });
  const result = await service.createProject({
    ownerUserId: 907,
    requestId: "video-g2-mode-sequence",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 15,
    script: makeScript(15, 2),
  });

  await service.pump();
  assert.equal(submissions[0].mode, "text");
  assert.deepEqual(submissions[0].referenceUrls, []);
  clock = 1001;
  await service.pump();
  clock = 1002;
  await service.pump();
  assert.equal(submissions[1].mode, "keyframe");
  assert.notEqual(submissions[0].apiKey, submissions[1].apiKey);
  assert.match(submissions[1].firstFrameUrl, /continuity-frame\/1/);
  assert.deepEqual(submissions[1].referenceUrls, []);
  clock = 2003;
  const completed = await settleProject(service, result.project.id, 907);
  assert.equal(completed.status, "completed");

  let imageClock = 0;
  const imageSubmissions = [];
  const imageProvider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      imageSubmissions.push(args);
      return { taskId: "g2-reference-mode" };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const imageService = makeService(imageProvider, makeStorage(), {
    now: () => imageClock,
    keyPool: createAgnesKeyPool({ keys: ["g2-reference-only"], rpmPerKey: 60, now: () => imageClock }),
  });
  const imageResult = await imageService.createProject({
    ownerUserId: 904,
    requestId: "video-g2-reference-mode",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "image",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    referenceAssetIds: [9041],
    script: makeScript(),
  });
  await imageService.pump();
  assert.equal(imageSubmissions[0].mode, "reference");
  assert.equal(imageSubmissions[0].referenceUrls.length, 1);
  assert.match(imageSubmissions[0].referenceUrls[0], /product-images\/9041\/file/);
  assert.equal(imageSubmissions[0].firstFrameUrl, "");
  imageClock = 1001;
  await imageService.pump();
  imageClock = 1002;
  assert.equal((await settleProject(imageService, imageResult.project.id, 904)).status, "completed");
});

test("G2 automatically retries a failed second clip with another key without charging again", async () => {
  let clock = 0;
  const storage = makeStorage();
  const submissions = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      submissions.push(args);
      return { taskId: `g2-auto-retry-${submissions.length}` };
    },
    async getTaskStatus({ taskId }) {
      if (taskId === "g2-auto-retry-2") return { status: "failed", error: "temporary second clip failure" };
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const keyPool = createAgnesKeyPool({ keys: ["g2-retry-a", "g2-retry-b", "g2-retry-c"], rpmPerKey: 60, now: () => clock });
  const service = makeService(provider, storage, { now: () => clock, keyPool });
  const beforeCredits = findUserById(906).credits;
  const result = await service.createProject({
    ownerUserId: 906,
    requestId: "video-g2-auto-retry-second-clip",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 15,
    script: makeScript(15, 2),
  });

  await service.pump();
  clock = 2;
  await service.pump();
  clock = 3;
  await service.pump();
  clock = 5;
  await service.pump();
  const retrying = service.getProject(result.project.id, 906);
  assert.equal(retrying.status, "queued");
  assert.equal(retrying.clips[1].status, "queued");
  assert.equal(retrying.clips[1].retryCount, 1);
  assert.equal(retrying.error, "");
  assert.equal(retrying.clips[1].error, "");

  clock = 6;
  await service.pump();
  assert.equal(submissions.length, 3);
  assert.notEqual(submissions[1].apiKey, submissions[2].apiKey);
  clock = 8;
  const completed = await settleProject(service, result.project.id, 906);
  assert.equal(completed.status, "completed");
  assert.equal(completed.clips[1].submissionAttempt, 2);
  assert.equal(completed.clips[1].attempt, 2);
  assert.equal(findUserById(906).credits, beforeCredits - 3);
});

test("G2 polling rate limits stay silent on the affinity key and never resubmit", async () => {
  let clock = 0;
  let submitCount = 0;
  let pollCount = 0;
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip() {
      submitCount += 1;
      return { taskId: "g2-poll-rate-limit" };
    },
    async getTaskStatus() {
      pollCount += 1;
      if (pollCount === 1) throw Object.assign(new Error("video status query rate limit exceeded"), { statusCode: 429 });
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const keyPool = createAgnesKeyPool({ keys: ["g2-affinity-key", "g2-unused-key"], rpmPerKey: 60, now: () => clock });
  const service = makeService(provider, makeStorage(), { now: () => clock, keyPool });
  const result = await service.createProject({
    ownerUserId: 908,
    requestId: "video-g2-poll-rate-limit-recovery",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump();
  clock = 2;
  await service.pump();
  const retrying = service.getProject(result.project.id, 908);
  assert.equal(retrying.status, "running");
  assert.equal(retrying.error, "");
  assert.equal(retrying.clips[0].error, "");
  assert.equal(submitCount, 1);

  clock = 62000;
  const completed = await settleProject(service, result.project.id, 908);
  assert.equal(completed.status, "completed");
  assert.equal(completed.error, "");
  assert.equal(submitCount, 1);
  assert.equal(pollCount, 2);
});

test("video recovery polls persisted tasks, marks ambiguous submissions, and retries with idempotent billing", async () => {
  const storage = makeStorage();
  const submissions = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      submissions.push(args);
      return { taskId: `recovery-${submissions.length}` };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const firstService = makeService(provider, storage);
  const restartProject = await firstService.createProject({
    ownerUserId: 905,
    requestId: "video-restart-recovery",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  await firstService.pump();
  const restartedService = makeService(provider, storage);
  await restartedService.recover();
  assert.equal((await settleProject(restartedService, restartProject.project.id, 905)).status, "completed");
  assert.equal(submissions.length, 1, "recovery must poll instead of resubmitting a persisted task");

  const uncertainService = makeService(provider);
  const uncertainProject = await uncertainService.createProject({
    ownerUserId: 909,
    requestId: "video-uncertain-submission",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  updateClip(uncertainProject.project.clips[0].id, { status: "submitting", providerTaskId: "" });
  await uncertainService.recover();
  const uncertain = uncertainService.getProject(uncertainProject.project.id, 909);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.clips[0].status, "uncertain_submission");
  assert.equal(findUserById(909).credits, 300);

  let failNext = true;
  const retryProvider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip() { return { taskId: "retry-task" }; },
    async getTaskStatus() {
      if (failNext) {
        failNext = false;
        return { status: "failed", error: "retryable provider failure" };
      }
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const retryService = makeService(retryProvider);
  const retryProject = await retryService.createProject({
    ownerUserId: 910,
    requestId: "video-retry-billing",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  const completedAfterAutomaticRetry = await settleProject(retryService, retryProject.project.id, 910, 220);
  assert.equal(completedAfterAutomaticRetry.status, "completed");
  assert.equal(completedAfterAutomaticRetry.clips[0].retryCount, 1);
  assert.equal(completedAfterAutomaticRetry.clips[0].submissionAttempt, 2);
  assert.equal(findUserById(910).credits, 298, "automatic retry must not charge twice");
});

test("video project charges once, runs clips sequentially, assembles final video, and retains private cleanup handles", async () => {
  const storage = makeStorage();
  const service = makeService(makeProvider(), storage);
  const result = await service.createProject({
    ownerUserId: 901,
    requestId: "video-project-idempotent",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea", summary: "Test Summary" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "d2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  assert.equal(result.project.status, "queued");
  assert.equal(findUserById(901).credits, 80);
  assert.equal((await service.createProject({ ownerUserId: 901, requestId: "video-project-idempotent", script: makeScript(), model: "d2" })).project.id, result.project.id);

  await service.pump();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.pump();
  const completed = service.getProject(result.project.id, 901);
  assert.equal(completed.status, "completed");
  assert.match(completed.finalVideoUrl, /video-projects/);
  assert.equal(completed.clips[0].status, "completed");
  assert.equal(findUserById(901).credits, 80);

  const rawGeneration = require("../src/server/db/repositories/generation-repository").findGenerationById(completed.generationId);
  assert.ok(rawGeneration.payload.videoAssets.final);
  assert.ok(collectGenerationAssets(rawGeneration).length >= 2);
  assert.equal(rawGeneration.payload.videoAssets.final.storedPath, rawGeneration.payload.videoAssets.clips[0].video.storedPath);
  assert.equal(sanitizeGeneration(rawGeneration).payload.videoAssets, undefined);
  const historyGeneration = sanitizeGeneration(rawGeneration, { security: { assetSigningSecret: "video-test-secret" } });
  assert.match(historyGeneration.payload.finalVideoUrl, /assetExpires=\d+/);
  assert.match(historyGeneration.payload.finalVideoUrl, /assetSignature=/);
  assert.match(historyGeneration.payload.videoClips[0].videoUrl, /assetSignature=/);
});

test("failed video clip refunds the unexecuted reservation once", async () => {
  const service = makeService(makeProvider({ failNext: true }), makeStorage(), { g2MaxClipAttempts: 1 });
  const result = await service.createProject({
    ownerUserId: 901,
    requestId: "video-project-failure",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });
  assert.equal(findUserById(901).credits, 78);
  await service.pump();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.pump();
  const failed = service.getProject(result.project.id, 901);
  assert.equal(failed.status, "partial_failed");
  assert.equal(failed.clips[0].status, "failed");
  assert.equal(failed.clips[0].error, "fake provider failure");
  assert.equal(findUserById(901).credits, 80);
});

test("completed G2 clip can be regenerated with an edited prompt and is assembled again", async () => {
  let clock = 0;
  const submissions = [];
  const provider = {
    provider: "fake",
    getAllowedHosts: () => [],
    async submitClip(args) {
      submissions.push(args);
      return { taskId: `g2-regenerate-${submissions.length}` };
    },
    async getTaskStatus() {
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
  const service = makeService(provider, makeStorage(), { now: () => clock });
  const result = await service.createProject({
    ownerUserId: 911,
    requestId: "video-g2-completed-regenerate",
    brand: { id: 1, name: "Test Brand" },
    trend: { id: 2, title: "Test Trend" },
    idea: { title: "Test Idea" },
    brandId: 1,
    trendId: 2,
    ideaIndex: 0,
    model: "g2",
    mode: "text",
    resolution: "720p",
    aspectRatio: "9:16",
    totalDurationSec: 10,
    script: makeScript(),
  });

  await service.pump();
  clock = 2;
  const completed = await settleProject(service, result.project.id, 911);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const beforeRetryCredits = findUserById(911).credits;
  const editedPrompt = "镜头缓慢推进，突出产品灯光和桌面质感";
  const retried = await service.retryClip(result.project.id, 911, 1, "video-g2-completed-regenerate-retry", editedPrompt);

  assert.equal(retried.project.status, "queued");
  assert.equal(retried.project.finalVideoUrl, "");
  assert.equal(retried.project.clips[0].status, "queued");
  assert.equal(retried.project.clips[0].prompt, editedPrompt);
  assert.equal(findUserById(911).credits, beforeRetryCredits - completed.clips[0].creditCost);

  let regenerated = retried.project;
  for (let attempt = 0; attempt < 12 && regenerated.status !== "completed"; attempt += 1) {
    clock += 2;
    await service.pump();
    await new Promise((resolve) => setTimeout(resolve, 5));
    regenerated = service.getProject(result.project.id, 911);
  }
  assert.equal(regenerated.status, "completed");
  assert.ok(regenerated.finalVideoUrl);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].prompt, editedPrompt);
});
