const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, findUserById } = require("../src/server/db/repositories/auth-repository");
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

const MP4_BUFFER = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(12)]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeScript() {
  return {
    title: "测试视频",
    creativeConcept: "连续展示产品质感",
    totalDurationSec: 10,
    aspectRatio: "9:16",
    globalSubjectReference: "产品主体保持一致",
    globalStyleReference: "自然光",
    globalContinuity: "前后镜头连续",
    audioDirection: { music: "轻快", ambience: "环境声", voiceStyle: "自然" },
    clips: [{
      index: 1,
      purpose: "开场",
      scene: "桌面",
      subjectReference: "产品",
      subjectAction: "缓慢旋转",
      cameraMovement: "推近",
      environmentMotion: "光影流动",
      lightingAndStyle: "自然光",
      continuity: "保持主体位置",
    }],
  };
}

function makeStorage() {
  const buffers = new Map();
  return {
    provider: "local",
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

function makeService(provider, storage = makeStorage()) {
  return createVideoProjectService({
    appConfig: {
      security: { assetSigningSecret: "video-test-secret" },
      video: { publicBaseUrl: "https://redbase.example", schedulerIntervalMs: 1000, pollIntervalMs: 1, agnes: { apiKeys: [] } },
    },
    generatedAssetStorage: storage,
    providers: { d2: provider, g2: provider },
    keyPool: createAgnesKeyPool({ keys: ["test-key"], rpmPerKey: 60 }),
    executor: async (_binary, args) => {
      await fsp.writeFile(args[args.length - 1], MP4_BUFFER);
    },
    now: () => Date.now(),
  });
}

test("video registry enforces D2/G2 clip rules and pricing", () => {
  assert.deepEqual(segmentVideoDuration("d2", 15), [15]);
  assert.deepEqual(segmentVideoDuration("g2", 30), [10, 10, 10]);
  assert.deepEqual(segmentVideoDuration("g2", 45), [10, 10, 10, 10, 5]);
  assert.equal(estimateVideoCredits({ model: "d2", resolution: "720p", totalDurationSec: 15 }), 30);
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

test("generated asset validation accepts MP4 but rejects a fake MP4 header", () => {
  const valid = validateGeneratedAssetInput({ ownerUserId: 901, generationId: 1, variant: "clip-1", mimeType: "video/mp4", buffer: MP4_BUFFER });
  assert.equal(valid.mimeType, "video/mp4");
  assert.throws(() => validateGeneratedAssetInput({ ownerUserId: 901, generationId: 1, variant: "clip-1", mimeType: "video/mp4", buffer: Buffer.from("not-video") }), /content does not match/);
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
    prompt: "d2 prompt",
    resolution: "720p",
    duration: "10",
    generateAudio: true,
    watermark: false,
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
    seed: -1,
    n: 1,
    images: ["https://redbase.example/a"],
  });
});

test("video project charges once, runs clips sequentially, assembles final video, and retains private cleanup handles", async () => {
  const storage = makeStorage();
  const service = makeService(makeProvider(), storage);
  const result = service.createProject({
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
  assert.equal(service.createProject({ ownerUserId: 901, requestId: "video-project-idempotent", script: makeScript(), model: "d2" }).project.id, result.project.id);

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
  assert.ok(collectGenerationAssets(rawGeneration).length >= 3);
  assert.equal(sanitizeGeneration(rawGeneration).payload.videoAssets, undefined);
});

test("failed video clip refunds the unexecuted reservation once", async () => {
  const service = makeService(makeProvider({ failNext: true }));
  const result = service.createProject({
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
  assert.equal(findUserById(901).credits, 80);
});
