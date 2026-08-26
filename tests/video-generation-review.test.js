const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase, getDbProxy } = require("../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
const { insertUser, findUserById } = require("../src/server/db/repositories/auth-repository");
const { insertGeneration } = require("../src/server/db/repositories/generation-repository");
const { insertProductImage, markProductImageDeleted } = require("../src/server/db/repositories/product-image-repository");
const { updateClip } = require("../src/server/db/repositories/video-project-repository");
const { createVideoProjectService } = require("../src/server/video/video-project-service");
const { createAgnesKeyPool } = require("../src/server/video/agnes-key-pool");
const { createD2Provider, compileD2Prompt } = require("../src/server/video/providers/d2-provider");
const { createG2Provider, readMetadataUrl } = require("../src/server/video/providers/g2-provider");
const { requestProviderJson } = require("../src/server/video/video-provider-http");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();
const db = getDbProxy();

const MP4_BUFFER = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(12)]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-video-review-source-"));
const frozenSourcePath = path.join(sourceDir, "review-product.png");
fs.writeFileSync(frozenSourcePath, Buffer.from("review-product-image"));

for (let id = 980; id <= 991; id += 1) {
  insertUser({
    id,
    name: `视频 Review 用户 ${id}`,
    phone: `1390000${String(id).padStart(4, "0")}`,
    password: "hash",
    accountType: "customer",
    credits: 1000,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
}

insertProductImage({
  id: 9901,
  ownerUserId: 986,
  brandId: 1,
  originalName: "review-product.png",
  storedPath: "uploads/review/product.png",
  mimeType: "image/png",
  sizeBytes: frozenSourcePath.length,
  sha256: "review-product-sha256",
  createdAt: "2026-08-27T00:00:00.000Z",
});

function makeStorage() {
  const buffers = new Map();
  return {
    provider: "local",
    buffers,
    async save({ ownerUserId, generationId, variant, mimeType, buffer }) {
      const extension = mimeType === "video/mp4" ? "mp4" : "jpg";
      const storedPath = `generated-images/users/${ownerUserId}/${generationId}/${variant}.${extension}`;
      buffers.set(storedPath, Buffer.from(buffer));
      return { provider: "local", storedPath, objectKey: "", mimeType, sizeBytes: buffer.length };
    },
    async readBuffer(asset) {
      const buffer = buffers.get(asset.storedPath);
      if (!buffer) throw new Error(`missing test asset: ${asset.storedPath}`);
      return Buffer.from(buffer);
    },
    async deleteMany(assets) {
      for (const asset of assets) buffers.delete(asset?.storedPath);
    },
  };
}

function makeAppConfig(overrides = {}) {
  return {
    security: { assetSigningSecret: "video-review-stable-secret" },
    video: {
      publicBaseUrl: "https://redbase.review.example",
      pollIntervalMs: 1,
      pollMaxBackoffMs: 30000,
      submitTimeoutMs: 20,
      pollTimeoutMs: 20,
      d2MaxConcurrentSubmissions: 4,
      mediaMaxConcurrency: 3,
      ffmpegMaxConcurrency: 1,
      runninghub: { outputHosts: ["runninghub.ai", "runninghub.cn"] },
      agnes: { apiKeys: [], pollIntervalMs: 1, outputHosts: ["platform-outputs.agnes-ai.space"] },
      ...(overrides.video || {}),
    },
    ...(overrides.security ? { security: { ...overrides.security } } : {}),
  };
}

function makeProvider({ provider = "fake", submitClip, getTaskStatus, getAllowedHosts = () => [] } = {}) {
  let taskNumber = 0;
  return {
    provider,
    getAllowedHosts,
    async submitClip(args) {
      if (submitClip) return submitClip(args);
      taskNumber += 1;
      return { taskId: `review-task-${taskNumber}` };
    },
    async getTaskStatus(args) {
      if (getTaskStatus) return getTaskStatus(args);
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  };
}

function makeService({
  provider = makeProvider(),
  providers = { d2: provider, g2: provider },
  storage = makeStorage(),
  keyPool = createAgnesKeyPool({ keys: ["review-key-a", "review-key-b"], rpmPerKey: 60 }),
  appConfig = makeAppConfig(),
  resolver = () => frozenSourcePath,
  fetchImpl = fetch,
  executor = async (_binary, args) => {
    await fs.promises.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
  },
} = {}) {
  return createVideoProjectService({
    appConfig,
    generatedAssetStorage: storage,
    providers,
    keyPool,
    resolveStoredProductImagePath: resolver,
    fetchImpl,
    executor,
  });
}

function makeSourceScript({ model = "d2", mode = "text", totalDurationSec = 10, clipCount = 1, referenceAssetIds = [] } = {}) {
  return {
    title: "服务端权威视频脚本",
    creativeConcept: "以产品细节和连续镜头展示质感",
    totalDurationSec,
    aspectRatio: "9:16",
    model,
    mode,
    globalSubjectReference: "产品主体保持一致",
    globalStyleReference: "清爽商务自然光",
    globalContinuity: "镜头之间保持位置和光线连续",
    clips: Array.from({ length: clipCount }, (_, index) => ({
      index: index + 1,
      purpose: `分镜 ${index + 1}`,
      scene: "干净桌面",
      subjectReference: "产品",
      subjectAction: "缓慢旋转",
      cameraMovement: "平滑推近",
      environmentMotion: "光影流动",
      lightingAndStyle: "自然光",
      continuity: "保持主体位置",
      referenceAssetIds: mode === "image" ? referenceAssetIds : [],
    })),
  };
}

function insertVideoScript({
  id,
  ownerUserId,
  brandId = 1,
  trendId = 2,
  ideaIndex = 0,
  ideaTitle = "Review 视频选题",
  model = "d2",
  mode = "text",
  totalDurationSec = 10,
  clipCount = totalDurationSec > 10 ? 2 : 1,
  referenceAssetIds = [],
} = {}) {
  const script = makeSourceScript({ model, mode, totalDurationSec, clipCount, referenceAssetIds });
  return insertGeneration({
    id,
    ownerUserId,
    type: "videoScript",
    channelLabel: "视频脚本",
    brandId,
    brandName: "Review Brand",
    trendId,
    trendTitle: "Review Trend",
    ideaTitle,
    cardTitle: script.title,
    createdAt: "2026-08-27T00:00:00.000Z",
    previewUrl: "",
    summary: script.creativeConcept,
    payload: {
      requestId: `script-${id}`,
      ideaIndex,
      videoModel: model,
      videoMode: mode,
      videoResolution: "720p",
      videoDuration: totalDurationSec,
      videoAspectRatio: "9:16",
      videoReferenceImageIds: referenceAssetIds,
      semanticInput: {
        model,
        mode,
        totalDurationSec,
        aspectRatio: "9:16",
        referenceImageIds: referenceAssetIds,
      },
      visualBible: {},
      videoScript: script,
    },
  });
}

async function createProject(service, {
  ownerUserId,
  requestId,
  generationId,
  brandId = 1,
  trendId = 2,
  ideaIndex = 0,
  ideaTitle = "Review 视频选题",
  model = "d2",
  mode = "text",
  resolution = "720p",
  totalDurationSec = 10,
  extra = {},
} = {}) {
  return service.createProject({
    ownerUserId,
    requestId,
    brand: { id: brandId, name: "Review Brand" },
    trend: { id: trendId, title: "Review Trend" },
    idea: { title: ideaTitle },
    brandId,
    trendId,
    ideaIndex,
    model,
    mode,
    resolution,
    aspectRatio: "9:16",
    totalDurationSec,
    videoScriptGenerationId: generationId,
    ...extra,
  });
}

async function pumpUntil(service, projectId, ownerUserId, predicate, maxIterations = 60) {
  for (let index = 0; index < maxIterations; index += 1) {
    await service.pump();
    const project = service.getProject(projectId, ownerUserId);
    if (predicate(project)) return project;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return service.getProject(projectId, ownerUserId);
}

test("create billing transaction rolls back the debit, event, generation, project, and clips together", async () => {
  const ownerUserId = 980;
  const source = insertVideoScript({ id: 4001, ownerUserId });
  const service = makeService();
  const before = findUserById(ownerUserId).credits;
  db.exec(`
    CREATE TRIGGER review_fail_create_billing
    BEFORE INSERT ON video_project_billing_requests
    WHEN NEW.operation = 'create'
    BEGIN SELECT RAISE(ABORT, 'forced create transaction failure'); END;
  `);
  try {
    await assert.rejects(
      createProject(service, { ownerUserId, requestId: "review-create-crash", generationId: source.id }),
      (error) => String(error.message).includes("forced create transaction failure"),
    );
  } finally {
    db.exec("DROP TRIGGER review_fail_create_billing");
  }
  assert.equal(findUserById(ownerUserId).credits, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_projects WHERE owner_user_id = ?").get(ownerUserId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProject'").get(ownerUserId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_project_billing_requests WHERE user_id = ?").get(ownerUserId).count, 0);
});

test("retry billing transaction rolls back charge and clip reset together", async () => {
  const ownerUserId = 981;
  const source = insertVideoScript({ id: 4002, ownerUserId });
  const service = makeService();
  const created = await createProject(service, { ownerUserId, requestId: "review-retry-crash-create", generationId: source.id });
  updateClip(created.project.clips[0].id, { status: "failed", error: "fixture failure" });
  const before = findUserById(ownerUserId).credits;
  db.exec(`
    CREATE TRIGGER review_fail_retry_billing
    BEFORE INSERT ON video_project_billing_requests
    WHEN NEW.operation = 'retry'
    BEGIN SELECT RAISE(ABORT, 'forced retry transaction failure'); END;
  `);
  try {
    await assert.rejects(
      service.retryClip(created.project.id, ownerUserId, 1, "review-retry-crash"),
      (error) => String(error.message).includes("forced retry transaction failure"),
    );
  } finally {
    db.exec("DROP TRIGGER review_fail_retry_billing");
  }
  assert.equal(findUserById(ownerUserId).credits, before);
  assert.equal(service.getProject(created.project.id, ownerUserId).clips[0].status, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_project_billing_requests WHERE user_id = ? AND operation = 'retry'").get(ownerUserId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRetry'").get(ownerUserId).count, 0);
});

test("two early task-id submission failures refund two distinct reservations exactly once", async () => {
  const ownerUserId = 982;
  const source = insertVideoScript({ id: 4003, ownerUserId, model: "g2" });
  let submitCount = 0;
  const provider = makeProvider({
    async submitClip() {
      submitCount += 1;
      throw Object.assign(new Error("provider failed before task id"), { uncertainSubmission: true });
    },
  });
  const service = makeService({ provider });
  const created = await createProject(service, { ownerUserId, requestId: "review-early-failure-create", generationId: source.id, model: "g2" });
  const originalCredits = findUserById(ownerUserId).credits + created.project.chargedCredits;

  const firstFailed = await pumpUntil(service, created.project.id, ownerUserId, (project) => project.status === "uncertain");
  assert.equal(firstFailed.clips[0].status, "uncertain_submission");
  assert.equal(findUserById(ownerUserId).credits, originalCredits);

  await service.retryClip(created.project.id, ownerUserId, 1, "review-early-failure-retry");
  const secondFailed = await pumpUntil(service, created.project.id, ownerUserId, (project) => project.status === "uncertain");
  assert.equal(secondFailed.clips[0].status, "uncertain_submission");
  assert.equal(submitCount, 2);
  assert.equal(findUserById(ownerUserId).credits, originalCredits);

  const reservations = db.prepare("SELECT operation, status, credit_event_id FROM video_project_billing_requests WHERE user_id = ? ORDER BY id").all(ownerUserId);
  assert.deepEqual(reservations.map((row) => row.operation), ["create", "retry"]);
  assert.deepEqual(reservations.map((row) => row.status), ["refunded", "refunded"]);
  assert.notEqual(reservations[0].credit_event_id, reservations[1].credit_event_id);
  const refundsBefore = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(ownerUserId).count;
  await service.pump();
  const refundsAfter = db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(ownerUserId).count;
  assert.equal(refundsAfter, refundsBefore);
  const refundEvents = db.prepare("SELECT payload_json FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund' ORDER BY id").all(ownerUserId);
  assert.deepEqual(refundEvents.map((row) => JSON.parse(row.payload_json).reservationCreditEventId), reservations.map((row) => row.credit_event_id));
});

test("a failed clip marker is reconciled after a crash before the refund transaction", async () => {
  const ownerUserId = 993;
  insertUser({
    id: ownerUserId,
    name: "退款恢复 Review 用户",
    phone: "1390000993",
    password: "hash",
    accountType: "customer",
    credits: 1000,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
  const source = insertVideoScript({ id: 4014, ownerUserId });
  const provider = makeProvider({
    async submitClip() {
      throw new Error("fixture provider rejection");
    },
  });
  const service = makeService({ provider });
  const created = await createProject(service, { ownerUserId, requestId: "review-refund-recovery", generationId: source.id });
  db.exec(`
    CREATE TRIGGER review_fail_refund
    BEFORE INSERT ON credit_events
    WHEN NEW.action_type = 'videoProjectRefund'
    BEGIN SELECT RAISE(ABORT, 'forced refund transaction failure'); END;
  `);
  try {
    await assert.rejects(service.pump(), /forced refund transaction failure/);
  } finally {
    db.exec("DROP TRIGGER review_fail_refund");
  }
  const crashed = service.getProject(created.project.id, ownerUserId);
  assert.equal(crashed.status, "running");
  assert.equal(crashed.clips[0].status, "failed");
  const chargedBalance = findUserById(ownerUserId).credits;

  const recovered = await pumpUntil(service, created.project.id, ownerUserId, (project) => project.status === "partial_failed");
  assert.equal(recovered.status, "partial_failed");
  assert.equal(findUserById(ownerUserId).credits, chargedBalance + created.project.chargedCredits);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(ownerUserId).count, 1);
  await service.pump();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM credit_events WHERE user_id = ? AND action_type = 'videoProjectRefund'").get(ownerUserId).count, 1);
});

test("assembly_failed is not scheduled again, completed clips cannot be charged for retry, and assembly retry is free", async () => {
  const ownerUserId = 983;
  const source = insertVideoScript({ id: 4004, ownerUserId, totalDurationSec: 15, clipCount: 2 });
  let ffmpegCalls = 0;
  let failAssembly = true;
  const service = makeService({
    executor: async (_binary, args) => {
      ffmpegCalls += 1;
      if (failAssembly) throw new Error("fixture assembly failure");
      await fs.promises.writeFile(args[args.length - 1], MP4_BUFFER);
    },
  });
  const created = await createProject(service, { ownerUserId, requestId: "review-assembly-failure", generationId: source.id, totalDurationSec: 15 });
  const beforeCredits = findUserById(ownerUserId).credits;
  const failed = await pumpUntil(service, created.project.id, ownerUserId, (project) => project.status === "assembly_failed");
  assert.equal(failed.clips.every((clip) => clip.status === "completed"), true);
  assert.equal(ffmpegCalls, 2, "one failed assembly may try stream-copy and the documented codec fallback");

  for (let index = 0; index < 10; index += 1) await service.pump();
  assert.equal(ffmpegCalls, 2);
  await assert.rejects(service.retryClip(created.project.id, ownerUserId, 1, "review-completed-clip-retry"), (error) => error.code === "VIDEO_CLIP_RETRY_NOT_ALLOWED");

  failAssembly = false;
  const completed = await service.retryAssembly(created.project.id, ownerUserId, "review-assembly-retry");
  assert.equal(completed.status, "completed");
  assert.equal(ffmpegCalls, 3);
  assert.equal(findUserById(ownerUserId).credits, beforeCredits);
  const repeated = await service.retryAssembly(created.project.id, ownerUserId, "review-assembly-retry");
  assert.equal(repeated.status, "completed");
  assert.equal(ffmpegCalls, 3);
});

test("G2 polling keeps the submission key affinity across reordered configuration and refuses a missing key", async () => {
  const ownerUserId = 984;
  const source = insertVideoScript({ id: 4005, ownerUserId, model: "g2" });
  const storage = makeStorage();
  const submittedKeys = [];
  const polledKeys = [];
  const provider = makeProvider({
    async submitClip({ apiKey }) {
      submittedKeys.push(apiKey);
      return { taskId: "review-affinity-task" };
    },
    async getTaskStatus({ apiKey }) {
      polledKeys.push(apiKey);
      return { status: "completed", videoBuffer: MP4_BUFFER, frameBuffer: JPEG_BUFFER };
    },
  });
  const firstService = makeService({
    provider,
    storage,
    keyPool: createAgnesKeyPool({ keys: ["affinity-key-a", "affinity-key-b"], rpmPerKey: 60 }),
  });
  const created = await createProject(firstService, { ownerUserId, requestId: "review-affinity", generationId: source.id, model: "g2" });
  await firstService.pump();
  assert.equal(firstService.getProject(created.project.id, ownerUserId).status, "running");

  const missingKeyService = makeService({
    provider,
    storage,
    keyPool: createAgnesKeyPool({ keys: ["affinity-key-b"], rpmPerKey: 60 }),
  });
  await missingKeyService.recover();
  assert.equal(missingKeyService.getProject(created.project.id, ownerUserId).status, "waiting_configuration");
  assert.equal(polledKeys.length, 0);

  const reorderedService = makeService({
    provider,
    storage,
    keyPool: createAgnesKeyPool({ keys: ["affinity-key-b", "affinity-key-a"], rpmPerKey: 60 }),
  });
  const completed = await pumpUntil(reorderedService, created.project.id, ownerUserId, (project) => project.status === "completed");
  assert.equal(completed.status, "completed");
  assert.equal(polledKeys[0], submittedKeys[0]);
});

test("provider timeout classification is phase-specific and polling remains recoverable", async () => {
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  await assert.rejects(
    requestProviderJson(hangingFetch, "https://provider.example/create", { phase: "submit", timeoutMs: 10 }),
    (error) => error.code === "VIDEO_PROVIDER_TIMEOUT" && error.phase === "submit" && error.uncertainSubmission === true,
  );
  await assert.rejects(
    requestProviderJson(hangingFetch, "https://provider.example/query", { phase: "poll", timeoutMs: 10 }),
    (error) => error.code === "VIDEO_PROVIDER_TIMEOUT" && error.phase === "poll" && !error.uncertainSubmission,
  );

  const d2 = createD2Provider({
    appConfig: { video: { submitTimeoutMs: 10, runninghub: { apiKey: "fixture-d2-key" } } },
    fetchImpl: hangingFetch,
  });
  await assert.rejects(d2.submitClip({ prompt: "timeout", durationSec: 10 }), (error) => error.code === "VIDEO_PROVIDER_TIMEOUT" && error.phase === "submit");

  const ownerUserId = 985;
  const source = insertVideoScript({ id: 4006, ownerUserId, model: "g2" });
  const g2 = createG2Provider({
    appConfig: { video: { submitTimeoutMs: 10, pollTimeoutMs: 10, agnes: { baseUrl: "https://api.agnes-ai.cn" } } },
    fetchImpl: hangingFetch,
  });
  const keyPool = createAgnesKeyPool({ keys: ["timeout-key"], rpmPerKey: 60 });
  const service = makeService({ providers: { d2: g2, g2 }, keyPool });
  const created = await createProject(service, { ownerUserId, requestId: "review-g2-submit-timeout", generationId: source.id, model: "g2" });
  await service.pump();
  assert.equal(service.getProject(created.project.id, ownerUserId).status, "uncertain");
  assert.equal(keyPool.snapshot()[0].inFlight, 0);
});

test("G2 polling timeout releases the affinity lease without marking a new submission uncertain", async () => {
  const ownerUserId = 987;
  const source = insertVideoScript({ id: 4007, ownerUserId, model: "g2" });
  let requestCount = 0;
  const response = (body) => ({ ok: true, status: 200, async json() { return body; } });
  const pollHangingFetch = async (url, options) => {
    requestCount += 1;
    if (String(url).includes("/v1/videos")) return response({ video_id: "review-poll-timeout" });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  };
  const g2 = createG2Provider({
    appConfig: { video: { submitTimeoutMs: 10, pollTimeoutMs: 10, agnes: { baseUrl: "https://api.agnes-ai.cn", pollIntervalMs: 1 } } },
    fetchImpl: pollHangingFetch,
  });
  const keyPool = createAgnesKeyPool({ keys: ["poll-timeout-key"], rpmPerKey: 60 });
  const service = makeService({ providers: { d2: g2, g2 }, keyPool });
  const created = await createProject(service, { ownerUserId, requestId: "review-g2-poll-timeout", generationId: source.id, model: "g2" });
  await service.pump();
  await new Promise((resolve) => setTimeout(resolve, 3));
  await service.pump();
  const current = service.getProject(created.project.id, ownerUserId);
  assert.equal(current.status, "running");
  assert.equal(current.clips[0].status, "running");
  assert.equal(current.clips[0].submissionAttempt, 1);
  assert.equal(keyPool.snapshot()[0].inFlight, 0);
  assert.equal(requestCount, 2);
});

test("D2 fixtures select video by output type, keep native last frame explicit, and map @Image order", () => {
  const d2 = createD2Provider({ appConfig: { video: { runninghub: { apiKey: "fixture-d2-key" } } } });
  const image = "https://runninghub.ai/frame.png";
  const video = "https://runninghub.ai/video.mp4";
  const imageFirst = d2.normalizeResult({ status: "success", results: [{ url: image, outputType: "png" }, { url: video, outputType: "mp4" }] });
  const videoFirst = d2.normalizeResult({ status: "success", results: [{ url: video, outputType: "mp4" }, { url: image, outputType: "png" }] });
  const onlyVideo = d2.normalizeResult({ status: "success", results: [{ url: video, outputType: "mp4" }] });
  const explicitFrame = d2.normalizeResult({ status: "success", videoUrl: video, lastFrameUrl: image });
  const namedFrame = d2.normalizeResult({ status: "success", results: [{ url: image, outputType: "last_frame" }, { url: video, outputType: "mp4" }] });
  assert.equal(imageFirst.videoUrl, video);
  assert.equal(videoFirst.videoUrl, video);
  assert.equal(onlyVideo.videoUrl, video);
  assert.equal(onlyVideo.nativeLastFrameUrl, "");
  assert.equal(explicitFrame.nativeLastFrameUrl, image);
  assert.equal(namedFrame.nativeLastFrameUrl, image);
  assert.equal(compileD2Prompt("保持产品一致", { referenceUrls: ["u1", "u2"], referenceLabels: ["上一镜头结束画面", "产品正面"] }), "保持产品一致\n\n【D2 参考图对应关系】\n@Image 1：上一镜头结束画面\n@Image 2：产品正面\n请严格保持上述 @Image 编号与实际参考图顺序一致，不引用不存在的图片编号。");
  const boundedPrompt = compileD2Prompt("使用 @Image 1 和 @Image 7，保持 @Image2", { referenceUrls: ["u1", "u2"], referenceLabels: ["产品 @Image 8", "侧面"] });
  assert.doesNotMatch(boundedPrompt, /@Image\s*7|@Image\s*8/);
  assert.match(boundedPrompt, /@Image 1/);
  assert.match(boundedPrompt, /@Image 2/);
});

test("G2 output fixtures accept nested metadata and stay inside the narrow output host allowlist", () => {
  assert.equal(readMetadataUrl({ metadata: { url: "https://platform-outputs.agnes-ai.space/a.mp4" } }), "https://platform-outputs.agnes-ai.space/a.mp4");
  assert.equal(readMetadataUrl({ data: { metadata: { url: "https://platform-outputs.agnes-ai.space/b.mp4" } } }), "https://platform-outputs.agnes-ai.space/b.mp4");
  assert.equal(readMetadataUrl({ video_url: "https://platform-outputs.agnes-ai.space/c.mp4" }), "https://platform-outputs.agnes-ai.space/c.mp4");
  assert.equal(readMetadataUrl({ videoUrl: "https://platform-outputs.agnes-ai.space/d.mp4" }), "https://platform-outputs.agnes-ai.space/d.mp4");
  const g2 = createG2Provider({ appConfig: { video: { agnes: { apiKeys: [] } } } });
  assert.ok(g2.getAllowedHosts().includes("platform-outputs.agnes-ai.space"));
  assert.throws(() => require("../src/server/video/video-remote").assertSafeProviderUrl("https://evil.example/a.mp4", { allowedHosts: g2.getAllowedHosts() }), /host/);
  assert.throws(() => require("../src/server/video/video-remote").assertSafeProviderUrl("https://127.0.0.1/a.mp4", { allowedHosts: g2.getAllowedHosts() }), /host/);
});

test("stored script generation is authoritative and resolution can change without making its semantic inputs stale", async () => {
  const ownerUserId = 988;
  const source = insertVideoScript({ id: 4008, ownerUserId });
  const service = makeService();
  const created = await createProject(service, {
    ownerUserId,
    requestId: "review-authoritative-script",
    generationId: source.id,
    resolution: "1080p",
    extra: { script: { title: "browser forged script", clips: [] }, visualBible: { forged: true }, referenceAssetIds: [999999] },
  });
  assert.equal(created.project.script.title, "服务端权威视频脚本");
  assert.equal(created.project.resolution, "1080p");
  assert.equal(created.project.scriptGenerationId, source.id);
});

test("legacy video scripts without persisted model context cannot start a real project", async () => {
  const ownerUserId = 992;
  insertUser({
    id: ownerUserId,
    name: "历史脚本 Review 用户",
    phone: "1390000992",
    password: "hash",
    accountType: "customer",
    credits: 1000,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
  const legacyScript = makeSourceScript({ model: "d2", mode: "text" });
  const source = insertGeneration({
    id: 4013,
    ownerUserId,
    type: "videoScript",
    channelLabel: "视频脚本",
    brandId: 1,
    brandName: "Review Brand",
    trendId: 2,
    trendTitle: "Review Trend",
    ideaTitle: "Review 视频选题",
    cardTitle: legacyScript.title,
    createdAt: "2026-08-27T00:00:00.000Z",
    previewUrl: "",
    summary: legacyScript.creativeConcept,
    payload: { videoScript: legacyScript, ideaIndex: 0 },
  });
  const service = makeService();
  await assert.rejects(
    createProject(service, { ownerUserId, requestId: "review-legacy-script", generationId: source.id }),
    (error) => error.code === "VIDEO_SCRIPT_INCOMPATIBLE",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_projects WHERE owner_user_id = ?").get(ownerUserId).count, 0);
});

test("strict production project creation rejects browser-only scripts and missing stable signing configuration before charging", async () => {
  const ownerUserId = 989;
  const source = insertVideoScript({ id: 4012, ownerUserId });
  let providerCalls = 0;
  const provider = makeProvider({
    provider: "runninghub",
    async submitClip() {
      providerCalls += 1;
      return { taskId: "must-not-run" };
    },
  });
  const service = makeService({
    provider,
    appConfig: makeAppConfig({ security: { assetSigningSecret: "" } }),
  });
  const before = findUserById(ownerUserId).credits;
  await assert.rejects(
    service.createProject({
      ownerUserId,
      requestId: "review-missing-signing",
      brand: { id: 1, name: "Review Brand" },
      trend: { id: 2, title: "Review Trend" },
      idea: { title: "Review 视频选题" },
      brandId: 1,
      trendId: 2,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      videoScriptGenerationId: source.id,
    }),
    (error) => error.code === "VIDEO_ASSET_SIGNING_REQUIRED",
  );
  assert.equal(findUserById(ownerUserId).credits, before);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_projects WHERE owner_user_id = ?").get(ownerUserId).count, 0);

  const noKeyService = makeService({
    provider: makeProvider({ provider: "runninghub" }),
    appConfig: makeAppConfig({ video: { runninghub: { apiKey: "" } } }),
  });
  await assert.rejects(
    noKeyService.createProject({
      ownerUserId,
      requestId: "review-missing-provider-key",
      brandId: 1,
      trendId: 2,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      videoScriptGenerationId: source.id,
    }),
    (error) => error.code === "VIDEO_PROVIDER_NOT_CONFIGURED",
  );
  assert.equal(findUserById(ownerUserId).credits, before);

  await assert.rejects(
    makeService({ provider: makeProvider() }).createProject({
      ownerUserId,
      requestId: "review-missing-script-generation",
      brandId: 1,
      trendId: 2,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      script: makeSourceScript(),
    }),
    (error) => error.code === "VIDEO_SCRIPT_GENERATION_REQUIRED",
  );
});

test("frozen project input remains provider-readable after the original product image is deleted", async () => {
  const ownerUserId = 986;
  const source = insertVideoScript({ id: 4009, ownerUserId, mode: "image", referenceAssetIds: [9901] });
  const submissions = [];
  const provider = makeProvider({
    submitClip(args) {
      submissions.push(args);
      return { taskId: "review-frozen-task" };
    },
  });
  const storage = makeStorage();
  const service = makeService({ provider, storage });
  const created = await createProject(service, { ownerUserId, requestId: "review-frozen-input", generationId: source.id, mode: "image" });
  markProductImageDeleted(9901, "2026-08-27T01:00:00.000Z");
  fs.unlinkSync(frozenSourcePath);
  await service.pump();
  const frozenSubmission = submissions.find((submission) => submission.referenceUrls.some((url) => String(url).includes(`/api/video-projects/${created.project.id}/assets/input/1`)));
  assert.ok(frozenSubmission);
  assert.doesNotMatch(frozenSubmission.referenceUrls[0], /product-images\/9901/);
});

test("D2, media, and FFmpeg semaphores enforce configured local limits", async () => {
  const provider = makeProvider({
    provider: "native",
    getAllowedHosts: () => ["provider.example"],
    async submitClip() { return { taskId: `review-concurrency-${Date.now()}-${Math.random()}` }; },
    async getTaskStatus() { return { status: "completed", videoUrl: "https://provider.example/video.mp4" }; },
  });
  let activeD2 = 0;
  let maxD2 = 0;
  let activeMedia = 0;
  let maxMedia = 0;
  let activeFfmpeg = 0;
  let maxFfmpeg = 0;
  const trackedProvider = {
    ...provider,
    async submitClip(args) {
      activeD2 += 1;
      maxD2 = Math.max(maxD2, activeD2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeD2 -= 1;
      return provider.submitClip(args);
    },
  };
  const fetchImpl = async () => {
    activeMedia += 1;
    maxMedia = Math.max(maxMedia, activeMedia);
    await new Promise((resolve) => setTimeout(resolve, 4));
    activeMedia -= 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "video/mp4" : "" },
      async arrayBuffer() { return Uint8Array.from(MP4_BUFFER).buffer; },
    };
  };
  const service = makeService({
    provider: trackedProvider,
    appConfig: makeAppConfig({ video: { d2MaxConcurrentSubmissions: 1, mediaMaxConcurrency: 1, ffmpegMaxConcurrency: 1 } }),
    fetchImpl,
    executor: async (_binary, args) => {
      activeFfmpeg += 1;
      maxFfmpeg = Math.max(maxFfmpeg, activeFfmpeg);
      await new Promise((resolve) => setTimeout(resolve, 4));
      await fs.promises.writeFile(args[args.length - 1], String(args[args.length - 1]).endsWith(".jpg") ? JPEG_BUFFER : MP4_BUFFER);
      activeFfmpeg -= 1;
    },
    resolver: () => frozenSourcePath,
  });
  const firstSource = insertVideoScript({ id: 4010, ownerUserId: 990 });
  const secondSource = insertVideoScript({ id: 4011, ownerUserId: 991 });
  const first = await createProject(service, { ownerUserId: 990, requestId: "review-concurrency-a", generationId: firstSource.id });
  const second = await createProject(service, { ownerUserId: 991, requestId: "review-concurrency-b", generationId: secondSource.id });
  const completed = await pumpUntil(service, first.project.id, 990, (project) => project.status === "completed");
  assert.equal(completed.status, "completed");
  assert.equal(service.getProject(second.project.id, 991).status, "completed");
  assert.deepEqual(service.getConcurrencySnapshot(), {
    d2Submit: { active: 0, limit: 1 },
    media: { active: 0, limit: 1 },
    ffmpeg: { active: 0, limit: 1 },
  });
  assert.ok(maxD2 <= 1);
  assert.ok(maxMedia <= 1);
  assert.ok(maxFfmpeg <= 1);
});
