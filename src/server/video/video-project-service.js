const fsp = require("fs/promises");
const path = require("path");

const { signAssetUrl } = require("../assets/signed-urls");
const { resolveStoredProductImagePath } = require("../assets/image-store");
const {
  findGenerationById,
  findGenerationByOwner,
  upsertGeneration,
} = require("../db/repositories/generation-repository");
const { findProductImageByOwner } = require("../db/repositories/product-image-repository");
const { findUserById } = require("../db/repositories/auth-repository");
const { allocateCounter } = require("../db/repositories/core-repository");
const {
  getPublicVideoCapabilities,
  getVideoModelConfig,
  normalizeModelId,
  normalizeResolution,
  normalizeTotalDuration,
  resolveVideoAspectRatio,
  segmentVideoDuration,
  estimateVideoCredits,
} = require("./video-model-registry");
const { createD2Provider } = require("./providers/d2-provider");
const { createG2Provider } = require("./providers/g2-provider");
const { createAgnesKeyPool } = require("./agnes-key-pool");
const { downloadProviderMedia } = require("./video-remote");
const { extractStableLastFrame, withVideoTempDir, defaultExecutor } = require("./video-frame-extractor");
const { assembleVideoClips } = require("./video-assembler");
const {
  DEFAULT_GENERATED_IMAGE_ASSET_BYTES,
  DEFAULT_VIDEO_CLIP_ASSET_BYTES,
  DEFAULT_VIDEO_FINAL_ASSET_BYTES,
  doesImageBufferMatchMimeType,
} = require("../assets/generated-asset-utils");
const {
  findProjectByOwnerAndRequestId,
  getProject,
  listProjectsByOwner,
  listRecoverableProjects,
  listProjectsForRefundReconciliation,
  updateProject,
  updateClip,
  createProjectWithBilling,
  retryProjectWithBilling,
  claimAssemblyStart,
  claimAssemblyRetry,
} = require("../db/repositories/video-project-repository");
const { refundVideoCredits, sumVideoProjectRefundCredits } = require("./video-billing");

const ACTIVE_PROJECT_STATUSES = new Set([
  "preparing",
  "queued",
  "running",
  "partial_failed",
  "uncertain",
  "waiting_configuration",
  "assembling",
  "assembly_failed",
]);
const TERMINAL_PROJECT_STATUSES = new Set(["completed", "failed", "cancelled", "assembly_failed"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_BACKOFF_STEPS_MS = [2000, 4000, 8000, 15000, 30000];

function toSafeIdList(value, max = 9) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => Number(typeof item === "object" ? item.id : item)).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, max);
}

function makeTimeline(durations) {
  let start = 0;
  return durations.map((duration, index) => {
    const end = start + Number(duration);
    const result = { index: index + 1, startSec: start, endSec: end, durationSec: Number(duration) };
    start = end;
    return result;
  });
}

function createProjectError(message, code = "VIDEO_PROJECT_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createSemaphore(limit) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  let active = 0;
  const waiters = [];

  function acquire() {
    return new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  }

  return {
    limit: max,
    get active() { return active; },
    async run(work) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

function getClipPrompt(script, index) {
  const clip = Array.isArray(script?.clips) ? script.clips[index - 1] : null;
  const visualBible = script?.visualBible && typeof script.visualBible === "object"
    ? Object.entries(script.visualBible).filter(([, value]) => value).map(([key, value]) => `${key}：${value}`).join("\n")
    : "";
  const compiled = [
    visualBible ? `【视觉理解 Bible】\n${visualBible}` : "",
    script?.globalSubjectReference ? `【全片主体一致性】\n${script.globalSubjectReference}` : "",
    script?.globalStyleReference ? `【全片风格一致性】\n${script.globalStyleReference}` : "",
    script?.globalContinuity ? `【全片连续性】\n${script.globalContinuity}` : "",
    clip?.scene,
    clip?.subjectAction,
    clip?.cameraMovement,
    clip?.environmentMotion,
    clip?.lightingAndStyle,
    clip?.continuity,
  ].filter(Boolean).join("\n") || "";
  return String(clip?.prompt || compiled).slice(0, 12000);
}

function getClipContinuityState(script, index) {
  const clip = Array.isArray(script?.clips) ? script.clips[index - 1] : null;
  return {
    subjectState: String(clip?.subjectReference || ""),
    positionState: String(clip?.continuity || ""),
    cameraState: String(clip?.cameraMovement || ""),
    environmentState: String(clip?.scene || ""),
    lightingState: String(clip?.lightingAndStyle || ""),
    motionDirection: String(clip?.subjectAction || ""),
  };
}

function buildClipReferenceIds({ model, mode, allIds, clipIndex, maxReferenceImages }) {
  if (mode === "text" && model === "g2") return [];
  if (clipIndex === 1) return mode === "image" ? allIds.slice(0, maxReferenceImages) : [];
  if (model === "g2") return [];
  if (!allIds.length) return [];
  const limit = Math.max(0, maxReferenceImages - 1); // previous continuity frame occupies one slot
  const start = (clipIndex - 2) % allIds.length;
  return Array.from({ length: Math.min(limit, allIds.length) }, (_, offset) => allIds[(start + offset) % allIds.length]);
}

function isAbsoluteHttps(value) {
  return /^https:\/\//i.test(String(value || ""));
}

function sameIdList(left, right) {
  const a = Array.isArray(left) ? left.map(Number) : [];
  const b = Array.isArray(right) ? right.map(Number) : [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function inferImageMimeType(buffer, fallback = "image/jpeg") {
  if (doesImageBufferMatchMimeType(buffer, "image/png")) return "image/png";
  if (doesImageBufferMatchMimeType(buffer, "image/jpeg")) return "image/jpeg";
  if (doesImageBufferMatchMimeType(buffer, "image/webp")) return "image/webp";
  if (doesImageBufferMatchMimeType(buffer, "image/gif")) return "image/gif";
  return fallback;
}

function clipNeedsContinuityFrame(project, clip) {
  return (project?.clips || []).some((candidate) => Number(candidate.dependsOnClipIndex) === Number(clip?.index));
}

function createVideoProjectService(options = {}) {
  const appConfig = options.appConfig || {};
  const storage = options.generatedAssetStorage;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const log = options.logger || console;
  const executor = options.executor || defaultExecutor;
  const providers = options.providers || {
    d2: createD2Provider({ appConfig, fetchImpl }),
    g2: createG2Provider({ appConfig, fetchImpl }),
  };
  const resolveProductImagePath = options.resolveStoredProductImagePath || resolveStoredProductImagePath;
  const allowMissingInputAssets = options.allowMissingInputAssets ?? Object.values(providers).every((provider) => provider?.provider === "fake");
  const keyPool = options.keyPool || createAgnesKeyPool({
    keys: appConfig.video?.agnes?.apiKeys || [],
    rpmPerKey: Number(appConfig.video?.agnes?.rpmPerKey || 1),
    now,
  });
  const d2SubmitSemaphore = createSemaphore(appConfig.video?.d2MaxConcurrentSubmissions || 4);
  const mediaSemaphore = createSemaphore(appConfig.video?.mediaMaxConcurrency || 3);
  const ffmpegSemaphore = createSemaphore(appConfig.video?.ffmpegMaxConcurrency || 1);
  const videoClipMaxBytes = Math.max(1, Number(appConfig.video?.maxClipBytes || DEFAULT_VIDEO_CLIP_ASSET_BYTES));
  const videoFinalMaxBytes = Math.max(1, Number(appConfig.video?.maxFinalBytes || DEFAULT_VIDEO_FINAL_ASSET_BYTES));
  const imageMaxBytes = Math.max(1, Number(appConfig.video?.imageMaxBytes || DEFAULT_GENERATED_IMAGE_ASSET_BYTES));
  const inFlight = new Set();
  const nextPollAt = new Map();
  const d2WaitingConfiguration = new Set();
  let scheduler = null;

  function publicBaseUrl() {
    const value = String(appConfig.video?.publicBaseUrl || "").trim();
    return isAbsoluteHttps(value) ? value.replace(/\/+$/, "") : "";
  }

  function toPublicUrl(relativePath, { requireAbsolute = false } = {}) {
    const value = String(relativePath || "");
    const base = publicBaseUrl();
    if (base) return new URL(value, `${base}/`).toString();
    if (requireAbsolute) throw createProjectError("视频 Provider 需要配置 VIDEO_PUBLIC_BASE_URL 以访问参考素材", "VIDEO_PUBLIC_BASE_URL_REQUIRED");
    return value;
  }

  function signVideoPath(relativePath) {
    return signAssetUrl(appConfig, relativePath, { ttlMs: DAY_MS });
  }

  function videoAssetPath(projectId, kind, position = null) {
    const suffix = position == null ? kind : `${kind}/${Number(position)}`;
    return `/api/video-projects/${Number(projectId)}/assets/${suffix}`;
  }

  function buildPublicClip(project, clip) {
    const videoUrl = clip.outputVideo?.asset ? signVideoPath(videoAssetPath(project.id, "clip", clip.index)) : "";
    const continuityFrameUrl = clip.continuityFrame?.asset ? signVideoPath(videoAssetPath(project.id, "continuity-frame", clip.index)) : "";
    return {
      id: clip.id,
      index: clip.index,
      startSec: clip.startSec,
      endSec: clip.endSec,
      durationSec: clip.durationSec,
      status: clip.status,
      dependsOnClipIndex: clip.dependsOnClipIndex,
      prompt: clip.prompt,
      continuityMode: clip.continuityMode,
      referenceAssetIds: clip.referenceAssetIds,
      continuityState: clip.continuityState,
      videoUrl,
      continuityFrameUrl,
      creditCost: clip.creditCost,
      attempt: clip.attempt,
      retryCount: clip.retryCount,
      submissionAttempt: clip.submissionAttempt,
      lastSuccessfulPollAt: clip.lastSuccessfulPollAt,
      error: clip.error,
    };
  }

  function serializeProject(project) {
    if (!project) return null;
    return {
      id: project.id,
      generationId: project.generationId,
      scriptGenerationId: project.scriptGenerationId,
      brandId: project.brandId,
      trendId: project.trendId,
      ideaIndex: project.ideaIndex,
      model: project.model,
      mode: project.mode,
      resolution: project.resolution,
      aspectRatio: project.aspectRatio,
      totalDurationSec: project.totalDurationSec,
      status: project.status,
      referenceAssetIds: project.referenceAssetIds,
      inputAssets: (project.inputAssets || []).map((asset) => ({
        position: asset.position,
        sourceImageId: asset.sourceImageId,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      })),
      visualBible: project.visualBible,
      script: project.script,
      estimatedCredits: project.estimatedCredits,
      chargedCredits: project.chargedCredits,
      refundedCredits: project.refundedCredits,
      finalVideoUrl: project.finalVideo?.asset ? signVideoPath(videoAssetPath(project.id, "final")) : "",
      assemblyAttempt: project.assemblyAttempt,
      clips: (project.clips || []).map((clip) => buildPublicClip(project, clip)),
      error: project.error,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  function updateGenerationSnapshot(project) {
    if (!project) return null;
    const generation = findGenerationById(project.generationId);
    if (!generation) return null;
    const payload = {
      ...(generation.payload || {}),
      projectId: project.id,
      scriptGenerationId: project.scriptGenerationId || null,
      videoModel: project.model,
      videoMode: project.mode,
      videoResolution: project.resolution,
      videoAspectRatio: project.aspectRatio,
      videoDuration: project.totalDurationSec,
      videoStatus: project.status,
      estimatedCredits: project.estimatedCredits,
      chargedCredits: project.chargedCredits,
      refundedCredits: project.refundedCredits,
      finalVideoUrl: project.finalVideo?.asset ? signVideoPath(videoAssetPath(project.id, "final")) : "",
      videoClips: (project.clips || []).map((clip) => buildPublicClip(project, clip)),
      // Keep storage handles only in the private generation snapshot so the
      // existing history deletion/retention pipeline can reclaim video files.
      videoAssets: {
        input: (project.inputAssets || []).map((asset) => asset.asset || null).filter(Boolean),
        final: project.finalVideo?.asset || null,
        clips: (project.clips || []).map((clip) => ({
          video: clip.outputVideo?.asset || null,
          continuityFrame: clip.continuityFrame?.asset || null,
        })),
      },
    };
    return upsertGeneration({
      ...generation,
      previewUrl: payload.finalVideoUrl || generation.previewUrl || "",
      summary: project.script?.creativeConcept || generation.summary || "",
      payload,
    });
  }

  function reconcileProjectRefundedCredits(project, { snapshot = true } = {}) {
    if (!project) return null;
    const actual = sumVideoProjectRefundCredits({ userId: project.ownerUserId, projectId: project.id });
    if (Number(project.refundedCredits || 0) === actual) return project;
    const reconciled = updateProject(project.id, { refundedCredits: actual }) || project;
    if (snapshot) updateGenerationSnapshot(reconciled);
    return reconciled;
  }

  function getProvider(project) {
    const provider = providers[normalizeModelId(project.model)];
    if (!provider) throw createProjectError(`视频模型 ${project.model} 暂不可用`, "VIDEO_MODEL_UNAVAILABLE");
    return provider;
  }

  function assertExternalVideoConfiguration(model, provider = providers[normalizeModelId(model)]) {
    const modelConfig = getVideoModelConfig(model);
    // Tests and local deterministic providers do not expose project assets to
    // an external service. Only the configured real provider needs the stable
    // public signing prerequisites.
    if (provider?.provider === "fake" || modelConfig.provider === "fake") return;
    if (!String(appConfig.security?.assetSigningSecret || "").trim()) {
      throw createProjectError("视频资源签名配置未完成，请联系管理员。", "VIDEO_ASSET_SIGNING_REQUIRED");
    }
    if (!publicBaseUrl()) {
      throw createProjectError("视频 Provider 需要配置 VIDEO_PUBLIC_BASE_URL 以访问参考素材", "VIDEO_PUBLIC_BASE_URL_REQUIRED");
    }
    if (provider?.provider === "runninghub" && !String(appConfig.video?.runninghub?.apiKey || "").trim()) {
      throw createProjectError("RunningHub 视频 API Key 未配置，请联系管理员。", "VIDEO_PROVIDER_NOT_CONFIGURED");
    }
    if (provider?.provider === "agnes" && !keyPool.hasKeys()) {
      throw createProjectError("Agnes 视频 API Key 未配置，请联系管理员。", "VIDEO_PROVIDER_NOT_CONFIGURED");
    }
  }

  function getFrozenInputAsset(project, sourceImageId) {
    return (project.inputAssets || []).find((asset) => Number(asset.sourceImageId) === Number(sourceImageId)) || null;
  }

  function getReferenceBundle(project, clip, provider) {
    const config = getVideoModelConfig(project.model);
    const references = [];
    const previous = project.clips?.find((candidate) => candidate.index === clip.dependsOnClipIndex);
    if (previous && project.model === "d2") {
      if (!previous.continuityFrame?.asset) {
        throw createProjectError("上一镜头的连续性画面尚未准备好", "VIDEO_CONTINUITY_FRAME_REQUIRED");
      }
      const previousPath = signVideoPath(videoAssetPath(project.id, "continuity-frame", previous.index));
      references.push({
        url: toPublicUrl(previousPath, { requireAbsolute: provider.provider !== "fake" }),
        label: "上一镜头真实结束画面",
      });
    }
    const ids = clip.referenceAssetIds || [];
    for (const id of ids) {
      const frozen = getFrozenInputAsset(project, id);
      if (frozen?.asset) {
        const inputPath = signVideoPath(videoAssetPath(project.id, "input", frozen.position));
        references.push({
          url: toPublicUrl(inputPath, { requireAbsolute: provider.provider !== "fake" }),
          label: `产品参考图${frozen.position || references.length + 1}${frozen.originalName ? `（${frozen.originalName}）` : ""}`,
        });
        continue;
      }
      // Legacy fake-provider tests may not have a real upload on disk. Real
      // projects are rejected at creation unless a frozen copy was saved.
      if (provider.provider !== "fake") {
        throw createProjectError("项目冻结参考素材不可用，请重新创建视频项目", "VIDEO_INPUT_SNAPSHOT_UNAVAILABLE");
      }
      const image = findProductImageByOwner(Number(id), project.ownerUserId);
      if (!image) throw createProjectError("项目参考素材不可用，请重新创建视频项目", "VIDEO_INPUT_SNAPSHOT_UNAVAILABLE");
      const signedPath = signAssetUrl(appConfig, `/api/product-images/${image.id}/file`, { ttlMs: DAY_MS });
      references.push({
        url: toPublicUrl(signedPath),
        label: `产品参考图（${image.originalName || image.id}）`,
      });
    }
    return {
      referenceUrls: references.slice(0, config.maxReferenceImages).map((item) => item.url),
      referenceLabels: references.slice(0, config.maxReferenceImages).map((item) => item.label),
    };
  }

  function getFirstFrameUrl(project, clip, provider) {
    const previous = project.clips?.find((candidate) => candidate.index === clip.dependsOnClipIndex);
    if (!previous?.continuityFrame?.asset) throw createProjectError("上一镜头的连续性画面尚未准备好", "VIDEO_CONTINUITY_FRAME_REQUIRED");
    const signedPath = signVideoPath(videoAssetPath(project.id, "continuity-frame", previous.index));
    return toPublicUrl(signedPath, { requireAbsolute: provider.provider !== "fake" });
  }

  async function downloadMedia(url, result, expected, provider) {
    const maxBytes = expected === "video" ? videoClipMaxBytes : imageMaxBytes;
    if (expected === "video" && Buffer.isBuffer(result?.videoBuffer)) {
      if (result.videoBuffer.length > maxBytes) {
        const error = new Error("供应商媒体超过单 Clip 大小限制");
        error.code = "PAYLOAD_TOO_LARGE";
        throw error;
      }
      return { buffer: result.videoBuffer, contentType: "video/mp4", url };
    }
    if (expected === "image" && Buffer.isBuffer(result?.frameBuffer)) {
      if (result.frameBuffer.length > maxBytes) {
        const error = new Error("供应商尾帧超过图片大小限制");
        error.code = "PAYLOAD_TOO_LARGE";
        throw error;
      }
      return { buffer: result.frameBuffer, contentType: inferImageMimeType(result.frameBuffer), url };
    }
    return downloadProviderMedia(url, {
      allowedHosts: provider.getAllowedHosts ? provider.getAllowedHosts() : [],
      maxBytes,
      timeoutMs: Number(appConfig.video?.remoteTimeoutMs || 30000),
      fetchImpl,
      expected,
    });
  }

  function maxBytesForVariant(variant, mimeType) {
    if (String(mimeType || "").startsWith("image/")) return imageMaxBytes;
    return String(variant || "") === "final" ? videoFinalMaxBytes : videoClipMaxBytes;
  }

  async function saveAsset(project, variant, mimeType, buffer) {
    if (!storage?.save) throw createProjectError("视频资产存储未初始化", "VIDEO_STORAGE_UNAVAILABLE");
    return storage.save({
      ownerUserId: project.ownerUserId,
      generationId: project.generationId,
      variant,
      mimeType,
      buffer,
      maxBytes: maxBytesForVariant(variant, mimeType),
    });
  }

  async function saveAssetFile(project, variant, mimeType, filePath, sizeBytes) {
    const input = {
      ownerUserId: project.ownerUserId,
      generationId: project.generationId,
      variant,
      mimeType,
      filePath,
      sizeBytes,
      maxBytes: maxBytesForVariant(variant, mimeType),
    };
    if (typeof storage?.saveFile === "function") return storage.saveFile(input);
    if (!storage?.save) throw createProjectError("视频资产存储未初始化", "VIDEO_STORAGE_UNAVAILABLE");
    return saveAsset(project, variant, mimeType, await fsp.readFile(filePath));
  }

  async function cleanupAssets(assets) {
    const usable = assets.filter(Boolean);
    if (!usable.length || !storage) return;
    try {
      if (typeof storage.deleteMany === "function") {
        await storage.deleteMany(usable);
      } else if (typeof storage.delete === "function") {
        for (const asset of usable) await storage.delete(asset);
      }
    } catch (error) {
      log.warn?.("[video-project] failed to clean up uncommitted assets", { error: error.message });
    }
  }

  async function freezeInputAssets({ ownerUserId, generationId, referenceAssetIds }) {
    const frozen = [];
    const saved = [];
    try {
      for (const [index, sourceImageId] of referenceAssetIds.entries()) {
        const image = findProductImageByOwner(Number(sourceImageId), ownerUserId);
        if (!image) throw createProjectError("视频参考素材不存在或已被删除，请重新生成脚本", "VIDEO_REFERENCE_NOT_FOUND");
        let buffer = null;
        try {
          buffer = await fsp.readFile(resolveProductImagePath(image));
        } catch (error) {
          if (!allowMissingInputAssets) {
            throw createProjectError("视频参考素材无法读取，请重新上传后再试", "VIDEO_REFERENCE_NOT_READABLE");
          }
        }
        let asset = null;
        if (buffer) {
          try {
            asset = await saveAsset({ ownerUserId, generationId }, `input-${index + 1}`, image.mimeType || "image/png", buffer);
            saved.push(asset);
          } catch (error) {
            if (!allowMissingInputAssets) throw error;
          }
        }
        frozen.push({
          position: index + 1,
          sourceImageId: Number(image.id),
          originalName: String(image.originalName || ""),
          mimeType: String(image.mimeType || "image/png"),
          sizeBytes: Number(image.sizeBytes || buffer?.length || 0),
          asset,
        });
      }
      return { frozen, saved };
    } catch (error) {
      await cleanupAssets(saved);
      throw error;
    }
  }

  async function persistClipResult(project, clip, result, provider) {
    if (!result.videoUrl && !result.videoBuffer) throw new Error("视频任务完成但没有视频文件");
    return mediaSemaphore.run(() => withVideoTempDir(async (tempDir) => {
      const savedAssets = [];
      try {
        const videoPath = path.join(tempDir, `clip-${clip.index}.mp4`);
        const video = await downloadMedia(result.videoUrl, result, "video", provider);
        await fsp.writeFile(videoPath, video.buffer);
        const videoAsset = await saveAssetFile(project, `clip-${clip.index}`, "video/mp4", videoPath, video.buffer.length);
        savedAssets.push(videoAsset);

        // The final clip has no downstream dependency. Its continuity frame is
        // not part of the paid generation contract and must not make an
        // otherwise valid video fail when FFmpeg or frame storage is absent.
        if (!clipNeedsContinuityFrame(project, clip)) {
          if (result.nativeLastFrameUrl || result.frameBuffer) {
            try {
              const frame = await downloadMedia(result.nativeLastFrameUrl, result, "image", provider);
              const continuityFrame = await saveAsset(project, `continuity-frame-${clip.index}`, frame.contentType || "image/jpeg", frame.buffer);
              savedAssets.push(continuityFrame);
              return {
                outputVideo: { asset: videoAsset, mimeType: "video/mp4", sizeBytes: video.buffer.length },
                continuityFrame: { asset: continuityFrame, mimeType: frame.contentType || "image/jpeg", sizeBytes: frame.buffer.length },
              };
            } catch (error) {
              log.warn?.("[video-project] optional final continuity frame unavailable", {
                projectId: project.id,
                clipIndex: clip.index,
                error: error.message,
              });
            }
          }
          return {
            outputVideo: { asset: videoAsset, mimeType: "video/mp4", sizeBytes: video.buffer.length },
            continuityFrame: {},
          };
        }

        let frame;
        if (result.nativeLastFrameUrl || result.frameBuffer) {
          frame = await downloadMedia(result.nativeLastFrameUrl, result, "image", provider);
        } else {
          const framePath = path.join(tempDir, `continuity-${clip.index}.jpg`);
          await ffmpegSemaphore.run(() => extractStableLastFrame({ videoPath, outputPath: framePath, appConfig, executor }));
          frame = { buffer: await fsp.readFile(framePath), contentType: "image/jpeg", url: "" };
        }
        const continuityFrame = await saveAsset(project, `continuity-frame-${clip.index}`, frame.contentType || "image/jpeg", frame.buffer);
        savedAssets.push(continuityFrame);
        return {
          outputVideo: { asset: videoAsset, mimeType: "video/mp4", sizeBytes: video.buffer.length },
          continuityFrame: { asset: continuityFrame, mimeType: frame.contentType || "image/jpeg", sizeBytes: frame.buffer.length },
        };
      } catch (error) {
        await cleanupAssets(savedAssets);
        throw error;
      }
    }));
  }

  async function assembleFinalVideo(project) {
    return withVideoTempDir(async (tempDir) => {
      const clipPaths = [];
      for (const clip of project.clips || []) {
        if (!clip.outputVideo?.asset) throw new Error(`Clip ${clip.index} 缺少视频资产`);
        const buffer = await storage.readBuffer(clip.outputVideo.asset);
        const clipPath = path.join(tempDir, `clip-${clip.index}.mp4`);
        await fsp.writeFile(clipPath, buffer);
        clipPaths.push(clipPath);
      }
      const outputPath = path.join(tempDir, "final.mp4");
      await assembleVideoClips({ clipPaths, outputPath, appConfig, executor });
      const stat = await fsp.stat(outputPath);
      if (Number(stat.size) > videoFinalMaxBytes) {
        const error = new Error("最终成片超过大小限制");
        error.code = "PAYLOAD_TOO_LARGE";
        throw error;
      }
      const asset = await saveAssetFile(project, "final", "video/mp4", outputPath, stat.size);
      return { asset, mimeType: "video/mp4", sizeBytes: Number(stat.size) };
    });
  }

  function clipIsReady(project, clip) {
    if (clip.status === "queued") return true;
    if (clip.status !== "waiting_dependency") return false;
    const dependency = project.clips?.find((candidate) => candidate.index === clip.dependsOnClipIndex);
    if (!dependency || dependency.status !== "completed" || !dependency.continuityFrame?.asset) return false;
    updateClip(clip.id, { status: "queued", error: "" });
    return true;
  }

  async function finalizeCompletedProject(project) {
    if (!project || project.status === "assembly_failed" || project.status === "assembling") return project;
    if (!(project.clips || []).length || !(project.clips || []).every((candidate) => candidate.status === "completed")) return project;
    if (project.finalVideo?.asset) {
      const completed = project.status === "completed" ? project : updateProject(project.id, { status: "completed", error: "" });
      updateGenerationSnapshot(completed);
      return completed;
    }

    // A single persisted clip is already a valid final video. Reusing the
    // same asset avoids an unnecessary local FFmpeg pass and duplicate bytes.
    if (project.clips.length === 1 && project.clips[0].outputVideo?.asset) {
      const completed = updateProject(project.id, { status: "completed", finalVideo: { ...project.clips[0].outputVideo }, error: "" });
      updateGenerationSnapshot(completed);
      return completed;
    }

    const claim = claimAssemblyStart(project.id);
    if (!claim.shouldRun) return claim.project || getProject(project.id);
    try {
      const finalVideo = await ffmpegSemaphore.run(() => assembleFinalVideo(claim.project));
      const completed = updateProject(project.id, { status: "completed", finalVideo, error: "" });
      updateGenerationSnapshot(completed);
      return completed;
    } catch (error) {
      const failed = updateProject(project.id, { status: "assembly_failed", error: error.message || "视频片段已全部完成，最终成片拼接失败" });
      updateGenerationSnapshot(failed);
      return failed;
    }
  }

  function nextProjectClip(project) {
    for (const clip of project.clips || []) {
      if (clipIsReady(project, clip)) return getProject(project.id);
      if (["submitting", "running"].includes(clip.status)) return project;
      if (["failed", "uncertain_submission", "cancelled", "waiting_configuration"].includes(clip.status)) return project;
    }
    return project;
  }

  function pollIntervalFor(project) {
    return Number(project.model === "g2" ? appConfig.video?.agnes?.pollIntervalMs || 2000 : appConfig.video?.pollIntervalMs || 2000);
  }

  function schedulePoll(project, clip, failureCount = 0) {
    // The production default is two seconds; keeping the configured value
    // intact also lets deterministic tests use a short interval without
    // changing the bounded failure backoff below.
    const base = Math.max(0, pollIntervalFor(project));
    const delay = failureCount > 0
      ? Math.min(POLL_BACKOFF_STEPS_MS[Math.min(failureCount - 1, POLL_BACKOFF_STEPS_MS.length - 1)], Number(appConfig.video?.pollMaxBackoffMs || 30000))
      : base;
    nextPollAt.set(clip.id, now() + delay);
  }

  async function submitProviderClip(project, clip, provider, lease, referenceBundle) {
    const mode = project.model === "g2" ? (clip.index === 1 ? (project.mode === "image" ? "reference" : "text") : "keyframe") : undefined;
    const args = {
      prompt: clip.prompt,
      resolution: project.resolution,
      durationSec: clip.durationSec,
      aspectRatio: project.aspectRatio,
      mode,
      referenceUrls: referenceBundle.referenceUrls,
      referenceLabels: referenceBundle.referenceLabels,
      firstFrameUrl: project.model === "g2" && clip.index > 1 ? getFirstFrameUrl(project, clip, provider) : "",
      signal: undefined,
    };
    if (project.model === "g2") args.apiKey = lease.key;
    return provider.submitClip(args);
  }

  async function submitQueuedClip(project, clip, provider) {
    assertExternalVideoConfiguration(project.model, provider);
    let lease = null;
    let releaseResult = {};
    try {
      if (project.model === "g2") {
        if (!keyPool.hasKeys()) {
          if (clip.status !== "queued" || clip.error !== "等待可用生成通道") {
            updateClip(clip.id, { status: "queued", error: "等待可用生成通道" });
          }
          if (project.status !== "waiting_configuration" || project.error !== "等待可用生成通道") {
            updateProject(project.id, { status: "waiting_configuration", error: "等待可用生成通道" });
          }
          return false;
        }
        lease = keyPool.acquire();
        if (!lease) {
          // No RPM slot is available yet. Keep the durable state as queued so
          // the UI does not claim that a provider request is already running.
          if (project.status !== "queued" || project.error) updateProject(project.id, { status: "queued", error: "" });
          if (clip.status !== "queued" || clip.error) updateClip(clip.id, { status: "queued", error: "" });
          return false;
        }
      }

      const runSubmit = async () => {
        // Resolve all local input/signing state before recording a real
        // submission attempt. If configuration is missing, no attempt was
        // sent to the Provider and recovery can safely leave the clip queued.
        const currentProject = getProject(project.id) || project;
        const currentClip = currentProject.clips.find((candidate) => candidate.id === clip.id) || clip;
        const referenceBundle = getReferenceBundle(currentProject, currentClip, provider);
        // A G2 project is only considered running after this worker has a
        // concrete key lease and is about to submit. A missing RPM slot keeps
        // both the project and clip in their durable queued state.
        updateProject(currentProject.id, { status: "running", error: "" });
        // Persist the affinity and increment before the actual network call.
        const persisted = updateClip(clip.id, {
          status: "submitting",
          providerKeyRef: lease?.keyRef || "",
          submissionAttempt: Number(clip.submissionAttempt || 0) + 1,
          error: "",
        });
        const freshProject = getProject(project.id);
        const freshClip = freshProject?.clips.find((candidate) => candidate.id === clip.id) || persisted;
        const result = await submitProviderClip(freshProject || project, freshClip || clip, provider, lease, referenceBundle);
        const taskId = String(result?.taskId || result?.videoId || result?.id || "").trim();
        if (!taskId) throw Object.assign(new Error("供应商未返回任务 ID，无法确认提交结果"), { uncertainSubmission: true });
        const running = updateClip(clip.id, {
          status: "running",
          provider: provider.provider,
          providerTaskId: taskId,
          attempt: Number(clip.attempt || 0) + 1,
          error: "",
          pollFailureCount: 0,
        });
        updateProject(project.id, { status: "running", error: "" });
        schedulePoll(project, running || clip);
        return true;
      };
      if (project.model === "d2") return await d2SubmitSemaphore.run(runSubmit);
      return await runSubmit();
    } catch (error) {
      releaseResult = {
        error: true,
        statusCode: error.statusCode,
        rateLimited: Number(error.statusCode) === 429,
      };
      throw error;
    } finally {
      if (lease) keyPool.release(lease.slot, releaseResult);
    }
  }

  function markWaitingConfiguration(project, clip, message) {
    if (clip) updateClip(clip.id, { status: "waiting_configuration", error: message });
    return updateProject(project.id, { status: "waiting_configuration", error: message });
  }

  async function pollRunningClip(project, clip, provider) {
    if (!clip.providerTaskId) {
      await markUncertainSubmission(project, clip, "服务重启后发现 submitting 任务没有 provider task id");
      return;
    }
    if (Number(nextPollAt.get(clip.id) || 0) > now()) return;

    let pollLease = null;
    let releaseResult = {};
    if (project.model === "g2") {
      if (!clip.providerKeyRef || typeof keyPool.hasKeyRef !== "function" || !keyPool.hasKeyRef(clip.providerKeyRef)) {
        markWaitingConfiguration(project, clip, "原生成通道配置暂不可用，请联系管理员。");
        return;
      }
      pollLease = keyPool.acquireByRef(clip.providerKeyRef, { rateLimit: false });
      if (!pollLease) {
        schedulePoll(project, clip);
        return;
      }
    }

    let result;
    try {
      result = await provider.getTaskStatus({
        taskId: clip.providerTaskId,
        apiKey: pollLease?.key,
        signal: undefined,
      });
    } catch (error) {
      releaseResult = { error: true, statusCode: error.statusCode, rateLimited: Number(error.statusCode) === 429 };
      const failureCount = Number(clip.pollFailureCount || 0) + 1;
      updateClip(clip.id, {
        pollFailureCount: failureCount,
        error: failureCount >= 5 ? "轮询监控暂时受阻，将继续重试" : "暂时无法查询供应商状态，将稍后重试",
      });
      updateProject(project.id, {
        status: "running",
        error: failureCount >= 5 ? "轮询监控暂时受阻，将继续重试" : "",
      });
      schedulePoll(project, clip, failureCount);
      log.warn?.("[video-project] polling failed", { projectId: project.id, clipIndex: clip.index, error: error.message });
      return;
    } finally {
      if (pollLease) keyPool.release(pollLease.slot, releaseResult);
    }

    const successAt = new Date(now()).toISOString();
    const normalizedStatus = String(result?.status || "running").toLowerCase();
    if (normalizedStatus === "running") {
      const updated = updateClip(clip.id, { lastSuccessfulPollAt: successAt, pollFailureCount: 0, error: "" });
      schedulePoll(project, updated || clip);
      return;
    }
    if (normalizedStatus === "failed") {
      updateClip(clip.id, { lastSuccessfulPollAt: successAt, pollFailureCount: 0 });
      await failClip(project, clip, result.error || "供应商生成失败");
      return;
    }

    let persisted;
    try {
      persisted = await persistClipResult(project, clip, result, provider);
    } catch (error) {
      await failClip(project, clip, error.message || "视频资产保存失败");
      return;
    }
    const updatedClip = updateClip(clip.id, {
      status: "completed",
      ...persisted,
      providerTaskId: "",
      lastSuccessfulPollAt: successAt,
      pollFailureCount: 0,
      error: "",
    });
    nextPollAt.delete(clip.id);
    let updatedProject = getProject(project.id);
    updatedProject = updatedClip && updatedProject && updatedProject.clips.every((candidate) => candidate.status === "completed")
      ? await finalizeCompletedProject(updatedProject)
      : updateProject(project.id, { status: "queued", error: "" });
    updateGenerationSnapshot(getProject(updatedProject.id));
  }

  async function markUncertainSubmission(project, clip, message) {
    updateClip(clip.id, { status: "uncertain_submission", error: message });
    await refundRemaining(project, clip, "uncertain_submission", message);
  }

  async function refundRemaining(project, clip, keySuffix, reason) {
    const fresh = reconcileProjectRefundedCredits(getProject(project.id), { snapshot: false });
    if (!fresh) return;
    const candidates = (fresh.clips || []).filter((candidate) => candidate.index >= clip.index && candidate.status !== "completed");
    if (!candidates.length) {
      updateGenerationSnapshot(fresh);
      return;
    }
    const groups = new Map();
    for (const candidate of candidates) {
      const eventId = Number(candidate.reservationCreditEventId || fresh.creditEventId || 0) || null;
      const key = eventId || "legacy";
      const current = groups.get(key) || { eventId, clips: [] };
      current.clips.push(candidate);
      groups.set(key, current);
    }
    for (const group of groups.values()) {
      const amount = group.clips.reduce((sum, candidate) => sum + Number(candidate.creditCost || 0), 0);
      if (!amount) continue;
      const minIndex = Math.min(...group.clips.map((candidate) => candidate.index));
      const maxIndex = Math.max(...group.clips.map((candidate) => candidate.index));
      const result = refundVideoCredits({
        userId: fresh.ownerUserId,
        amount,
        reservationCreditEventId: group.eventId,
        refundRange: `${minIndex}-${maxIndex}`,
        reason,
        generationId: fresh.generationId,
        brandId: fresh.brandId,
        trendId: fresh.trendId,
        ideaTitle: fresh.script?.title || "",
        projectId: fresh.id,
      });
      if (!result.refunded && !result.eventId) {
        log.warn?.("[video-project] refund request did not produce an event", { projectId: fresh.id, reservationCreditEventId: group.eventId, refundRange: `${minIndex}-${maxIndex}` });
      }
    }
    const nextStatus = keySuffix === "uncertain_submission" ? "uncertain" : "partial_failed";
    const reconciled = reconcileProjectRefundedCredits(getProject(fresh.id), { snapshot: false }) || fresh;
    const updated = updateProject(fresh.id, {
      refundedCredits: Number(reconciled.refundedCredits || 0),
      status: nextStatus,
      error: reason,
    });
    if (updated) {
      for (const candidate of updated.clips || []) {
        if (candidate.index > clip.index && !["completed", "failed"].includes(candidate.status)) {
          updateClip(candidate.id, { status: "cancelled", error: "前置镜头失败，尚未执行" });
        }
      }
      updateGenerationSnapshot(getProject(updated.id));
    }
  }

  async function failClip(project, clip, errorMessage) {
    updateClip(clip.id, { status: "failed", error: String(errorMessage || "视频生成失败") });
    await refundRemaining(project, clip, "clip-failed", errorMessage);
  }

  async function reconcileFailedClip(project) {
    const failedClip = (project?.clips || []).find((candidate) => ["failed", "uncertain_submission"].includes(candidate.status));
    if (!failedClip) return false;
    const uncertain = failedClip.status === "uncertain_submission";
    await refundRemaining(
      project,
      failedClip,
      uncertain ? "uncertain_submission" : "clip-failed",
      failedClip.error || (uncertain ? "无法确认供应商是否接受任务" : "视频生成失败"),
    );
    return true;
  }

  async function processProjectOnce(projectId) {
    let initial = getProject(projectId);
    if (!initial || TERMINAL_PROJECT_STATUSES.has(initial.status) || initial.status === "assembling") return;
    initial = reconcileProjectRefundedCredits(initial) || initial;
    if (initial.model === "d2" && initial.status === "waiting_configuration" && d2WaitingConfiguration.has(initial.id)) return;
    // A process crash can happen after a clip is marked failed but before its
    // refund/project update commits. Reconcile that durable clip marker before
    // considering any new submission; refund idempotency makes a repeated pass safe.
    if (await reconcileFailedClip(initial)) return;

    if (initial.status === "waiting_configuration") {
      if (initial.model === "d2") return;
      const waitingConfiguration = initial.clips?.find((candidate) => candidate.status === "waiting_configuration");
      if (waitingConfiguration && initial.model === "g2" && waitingConfiguration.providerTaskId) {
        // A submitted task must resume only when the exact affinity key is
        // available again. Another configured key is never a safe fallback.
        if (waitingConfiguration.providerKeyRef && keyPool.hasKeyRef?.(waitingConfiguration.providerKeyRef)) {
          updateClip(waitingConfiguration.id, { status: "running", error: "" });
          updateProject(initial.id, { status: "running", error: "" });
        } else {
          return;
        }
      } else if (waitingConfiguration && initial.model === "g2" && keyPool.hasKeys()) {
        // No task id means no Provider request was confirmed; it is safe to
        // retry the queued submission when any configured key is available.
        updateClip(waitingConfiguration.id, { status: "queued", providerKeyRef: "", error: "" });
        updateProject(initial.id, { status: "queued", error: "" });
      }
      const refreshed = getProject(projectId);
      const queued = refreshed?.clips?.find((candidate) => candidate.status === "queued");
      if (queued && initial.model === "g2" && keyPool.hasKeys()) {
        updateProject(initial.id, { status: "queued", error: "" });
      } else if (!queued) {
        const active = refreshed?.clips?.find((candidate) => ["running", "submitting"].includes(candidate.status));
        if (active) {
          await pollRunningClip(refreshed, active, getProvider(refreshed));
        }
        return;
      } else if (initial.model !== "g2") {
        updateProject(initial.id, { status: "queued", error: "" });
      } else {
        return;
      }
    }

    const project = nextProjectClip(getProject(projectId));
    const active = (project.clips || []).find((candidate) => ["submitting", "running"].includes(candidate.status));
    if (active) {
      await pollRunningClip(project, active, getProvider(project));
      return;
    }
    const queued = (project.clips || []).find((candidate) => candidate.status === "queued");
    if (!queued) {
      if ((project.clips || []).every((candidate) => candidate.status === "completed")) await finalizeCompletedProject(project);
      else if (project.status === "preparing") updateProject(project.id, { status: "queued" });
      return;
    }

    const fresh = getProject(project.id);
    const provider = getProvider(fresh);
    try {
      await submitQueuedClip(fresh, queued, provider);
    } catch (error) {
      const configurationCodes = new Set([
        "VIDEO_PROVIDER_NOT_CONFIGURED",
        "VIDEO_PUBLIC_BASE_URL_REQUIRED",
        "VIDEO_ASSET_SIGNING_REQUIRED",
        "VIDEO_INPUT_SNAPSHOT_UNAVAILABLE",
        "VIDEO_CONTINUITY_FRAME_REQUIRED",
      ]);
      if (configurationCodes.has(error.code)) {
        if (fresh.model === "d2") d2WaitingConfiguration.add(fresh.id);
        const latest = getProject(project.id);
        const latestClip = latest?.clips.find((candidate) => candidate.id === queued.id);
        if (latestClip?.status === "submitting") updateClip(queued.id, { status: "queued", providerKeyRef: "", error: error.message });
        updateProject(project.id, { status: "waiting_configuration", error: error.message });
        return;
      }
      if (Number(error.statusCode) === 429) {
        updateClip(queued.id, { status: "queued", providerKeyRef: "", error: "供应商限流，等待重试" });
        updateProject(project.id, { status: "queued", error: "供应商限流，等待重试" });
        return;
      }
      if (error.uncertainSubmission || (error.code === "VIDEO_PROVIDER_TIMEOUT" && error.phase === "submit")) {
        await markUncertainSubmission(fresh, queued, error.message || "无法确认供应商是否接受任务");
        return;
      }
      await failClip(fresh, queued, error.message || "提交视频任务失败");
    }
  }

  async function pump() {
    const projects = listRecoverableProjects({ limit: 100 });
    await Promise.all(projects.map(async (project) => {
      if (inFlight.has(project.id)) return;
      inFlight.add(project.id);
      try {
        await processProjectOnce(project.id);
      } catch (error) {
        log.error?.("[video-project] scheduler error", { projectId: project.id, error: error.message });
        const current = getProject(project.id);
        const active = current?.clips?.find((candidate) => ["queued", "submitting"].includes(candidate.status));
        if (active) await failClip(current, active, error.message || "视频任务异常");
        else if (current?.clips?.some((candidate) => ["failed", "uncertain_submission"].includes(candidate.status))) {
          await reconcileFailedClip(current);
        }
        else if (current && current.status !== "assembly_failed") updateProject(project.id, { status: "partial_failed", error: error.message || "视频任务异常" });
      } finally {
        inFlight.delete(project.id);
      }
    }));
  }

  async function recover() {
    for (const summary of listProjectsForRefundReconciliation({ limit: 100 })) {
      const project = reconcileProjectRefundedCredits(getProject(summary.id)) || getProject(summary.id);
      if (project) updateGenerationSnapshot(project);
    }
    for (const summary of listRecoverableProjects({ limit: 100 })) {
      const project = reconcileProjectRefundedCredits(getProject(summary.id)) || getProject(summary.id);
      if (!project) continue;
      if (project.status === "assembling") {
        const failed = updateProject(project.id, { status: "assembly_failed", error: "服务重启后最终成片拼接未完成" });
        updateGenerationSnapshot(failed);
        continue;
      }
      if (project.model === "d2" && project.status === "waiting_configuration") {
        try {
          assertExternalVideoConfiguration(project.model, getProvider(project));
        } catch (_error) {
          d2WaitingConfiguration.add(project.id);
          continue;
        }
        d2WaitingConfiguration.delete(project.id);
        for (const clip of project.clips || []) {
          if (clip.status === "waiting_configuration") updateClip(clip.id, { status: "queued", error: "" });
        }
        const resumed = updateProject(project.id, { status: "queued", error: "" });
        updateGenerationSnapshot(resumed);
        continue;
      }
      const submitting = (project.clips || []).find((clip) => clip.status === "submitting" && !clip.providerTaskId);
      if (submitting) {
        await markUncertainSubmission(project, submitting, "服务重启后无法确认供应商是否已接受任务");
        continue;
      }
      const affinityMissing = project.model === "g2" && (project.clips || []).find((clip) => clip.providerTaskId && (!clip.providerKeyRef || !keyPool.hasKeyRef?.(clip.providerKeyRef)));
      if (affinityMissing) markWaitingConfiguration(project, affinityMissing, "原生成通道配置暂不可用，请联系管理员。");
    }
  }

  function start() {
    if (scheduler) return;
    recover().catch((error) => log.warn?.("[video-project] recovery failed", { error: error.message }));
    scheduler = setInterval(() => pump().catch((error) => log.warn?.("[video-project] scheduler tick failed", { error: error.message })), Number(appConfig.video?.schedulerIntervalMs || 500));
    scheduler.unref?.();
  }

  function stop() {
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
  }

  function validateStoredScript(input, model, mode, totalDurationSec, aspectRatio) {
    const scriptGenerationId = Number(input.videoScriptGenerationId || 0);
    if (!Number.isSafeInteger(scriptGenerationId) || scriptGenerationId <= 0) {
      throw createProjectError("请先生成当前模型对应的视频脚本", "VIDEO_SCRIPT_GENERATION_REQUIRED");
    }
    const generation = findGenerationByOwner(scriptGenerationId, input.ownerUserId);
    if (!generation || generation.type !== "videoScript") {
      throw createProjectError("视频脚本记录不存在或不属于当前用户", "VIDEO_SCRIPT_GENERATION_INVALID");
    }
    const payload = generation.payload || {};
    const storedScript = payload.videoScript;
    const hasPersistedVideoContext = typeof payload.videoModel === "string" && Boolean(payload.videoModel.trim()) &&
      typeof payload.videoMode === "string" && Boolean(payload.videoMode.trim()) &&
      Array.isArray(payload.videoReferenceImageIds);
    const storedModel = String(payload.videoModel || "").trim().toLowerCase();
    const storedMode = String(payload.videoMode || "").trim().toLowerCase();
    if (!hasPersistedVideoContext || !storedModel || !storedMode || !storedScript || !Array.isArray(storedScript.clips)) {
      throw createProjectError("该视频脚本创建于视频模型接入前，请重新生成适配当前模型的脚本。", "VIDEO_SCRIPT_INCOMPATIBLE");
    }
    if (storedModel !== model || storedMode !== mode) {
      throw createProjectError("视频脚本与当前模型或生成方式不匹配，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    if (Number(generation.brandId) !== Number(input.brandId) || Number(generation.trendId) !== Number(input.trendId)) {
      throw createProjectError("视频脚本与当前品牌或趋势不匹配，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    if (payload.ideaIndex == null || Number(payload.ideaIndex) !== Number(input.ideaIndex)) {
      throw createProjectError("视频脚本与当前选题不匹配，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    const storedIdeaTitle = String(generation.ideaTitle || storedScript.title || "").trim();
    if (input.idea?.title && storedIdeaTitle && String(input.idea.title) !== storedIdeaTitle) {
      throw createProjectError("视频脚本与当前选题标题不匹配，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    const storedDuration = Number(payload.videoDuration ?? storedScript.totalDurationSec);
    const storedAspect = resolveVideoAspectRatio(payload.videoAspectRatio || payload.aspectRatio || storedScript.aspectRatio, "9:16");
    if (storedDuration !== Number(totalDurationSec) || storedAspect !== String(aspectRatio)) {
      throw createProjectError("视频脚本与当前时长或比例不匹配，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    const modelConfig = getVideoModelConfig(model);
    const storedReferences = toSafeIdList(payload.videoReferenceImageIds, modelConfig.maxReferenceImages);
    const scriptReferences = mode === "image" ? toSafeIdList(storedScript.clips[0]?.referenceAssetIds, modelConfig.maxReferenceImages) : [];
    if (!sameIdList(storedReferences, scriptReferences)) {
      throw createProjectError("视频脚本参考素材已变化，请重新生成脚本。", "VIDEO_SCRIPT_CONTEXT_MISMATCH");
    }
    if (mode === "image" && !storedReferences.length) {
      throw createProjectError("图生视频至少需要一张参考图，请重新生成脚本。", "VIDEO_REFERENCE_REQUIRED");
    }
    if (storedScript.clips.length < segmentVideoDuration(model, totalDurationSec).length) {
      throw createProjectError("视频脚本分镜数量不足，请重新生成脚本。", "VIDEO_SCRIPT_INCOMPATIBLE");
    }
    return { generation, script: storedScript, referenceAssetIds: storedReferences };
  }

  async function createProject(input = {}) {
    const requestId = String(input.requestId || "").trim();
    if (!requestId) throw createProjectError("缺少视频项目 requestId", "VIDEO_REQUEST_ID_REQUIRED");
    const existing = findProjectByOwnerAndRequestId(input.ownerUserId, requestId);
    if (existing) {
      const existingProject = getProject(existing.id);
      return {
        project: serializeProject(existingProject),
        user: findUserById(input.ownerUserId),
        generation: existingProject ? findGenerationById(existingProject.generationId) : null,
      };
    }

    // A lost client response must not turn a retry with a new request id into
    // a second paid project for the same idea. The UI also restores this
    // server-side choice, while the explicit legacy path remains available to
    // isolated migration/deterministic tests only.
    if (!options.allowLegacyScript) {
      const activeForIdea = listProjectsByOwner(input.ownerUserId, {
        activeOnly: true,
        brandId: input.brandId,
        trendId: input.trendId,
        ideaIndex: input.ideaIndex,
        limit: 1,
      });
      if (activeForIdea.length) {
        const activeProject = getProject(activeForIdea[0].id, { ownerUserId: input.ownerUserId });
        return {
          project: serializeProject(activeProject),
          user: findUserById(input.ownerUserId),
          generation: activeProject ? findGenerationById(activeProject.generationId) : null,
        };
      }
    }

    const model = normalizeModelId(input.model || "d2");
    const modelConfig = getVideoModelConfig(model);
    const mode = String(input.mode || "text").trim().toLowerCase();
    if (!modelConfig.supportedModes.includes(mode)) throw createProjectError("视频生成方式不受当前模型支持", "VIDEO_MODE_UNSUPPORTED");
    const totalDurationSec = normalizeTotalDuration(input.totalDurationSec, 30);
    const durations = segmentVideoDuration(model, totalDurationSec);
    if (!durations.length) throw createProjectError("视频总时长无法按当前模型分段", "VIDEO_DURATION_UNSUPPORTED");
    const resolution = normalizeResolution(model, input.resolution);
    const aspectRatio = resolveVideoAspectRatio(input.aspectRatio, "9:16");
    const estimatedCredits = estimateVideoCredits({ model, resolution, totalDurationSec, clipDurations: durations });

    let source;
    if (input.videoScriptGenerationId) {
      source = validateStoredScript(input, model, mode, totalDurationSec, aspectRatio);
    } else if (options.allowLegacyScript && input.script && Array.isArray(input.script.clips) && input.script.clips.length) {
      // Only explicit test/migration callers may use this compatibility path.
      source = {
        generation: null,
        script: input.script,
        referenceAssetIds: mode === "image" ? toSafeIdList(input.referenceAssetIds, modelConfig.maxReferenceImages) : [],
      };
    } else {
      throw createProjectError("请先生成并确认当前模型的视频脚本", "VIDEO_SCRIPT_GENERATION_REQUIRED");
    }
    if (mode === "image" && !source.referenceAssetIds.length) throw createProjectError("图生视频至少需要一张参考图", "VIDEO_REFERENCE_REQUIRED");
    assertExternalVideoConfiguration(model, providers[model]);

    const projectId = allocateCounter("nextVideoProjectId", 1);
    const generationId = allocateCounter("nextGenerationId", 1);
    let frozen = [];
    let persisted = false;
    try {
      const frozenResult = await freezeInputAssets({
        ownerUserId: input.ownerUserId,
        generationId,
        referenceAssetIds: source.referenceAssetIds,
      });
      frozen = frozenResult.frozen;
      const script = {
        ...source.script,
        model,
        mode,
        resolution,
        aspectRatio,
        totalDurationSec,
        clips: makeTimeline(durations).map((timeline, index) => ({
          ...(source.script.clips?.[index] || {}),
          ...timeline,
          generationDurationSec: timeline.durationSec,
          dependsOnClipIndex: index > 0 ? index : null,
          continuityMode: index === 0 ? mode : model === "g2" ? "keyframe" : "image",
          referenceAssetIds: buildClipReferenceIds({ model, mode, allIds: source.referenceAssetIds, clipIndex: index + 1, maxReferenceImages: modelConfig.maxReferenceImages }),
        })),
      };
      const visualBible = source.generation?.payload?.visualBible || source.script.visualBible || {};
      const createdAt = new Date(now()).toISOString();
      const generation = {
        id: generationId,
        ownerUserId: input.ownerUserId,
        type: "videoProject",
        channelLabel: "AI 视频",
        brandId: input.brandId,
        brandName: input.brand?.name || "",
        trendId: input.trendId,
        trendTitle: input.trend?.title || "",
        ideaTitle: input.idea?.title || script.title || "",
        cardTitle: script.title || input.idea?.title || "AI 视频",
        createdAt,
        previewUrl: "",
        summary: script.creativeConcept || input.idea?.summary || "",
        payload: {
          requestId,
          projectId,
          sourceVideoScriptGenerationId: source.generation?.id || null,
          videoModel: model,
          videoMode: mode,
          videoStatus: "queued",
          videoDuration: totalDurationSec,
          videoAspectRatio: aspectRatio,
          videoResolution: resolution,
          videoScript: script,
          videoAssets: { input: frozen.map((asset) => asset.asset).filter(Boolean) },
        },
      };
      const timeline = makeTimeline(durations);
      const projectData = {
        id: projectId,
        ownerUserId: input.ownerUserId,
        generationId,
        scriptGenerationId: source.generation?.id || null,
        requestId,
        brandId: input.brandId,
        trendId: input.trendId,
        ideaIndex: input.ideaIndex,
        model,
        mode,
        resolution,
        aspectRatio,
        totalDurationSec,
        status: "queued",
        referenceAssetIds: source.referenceAssetIds,
        inputAssets: frozen,
        visualBible,
        script,
        estimatedCredits,
        chargedCredits: 0,
        refundedCredits: 0,
        creditEventId: null,
        createdAt,
      };
      const clips = timeline.map((item, index) => ({
        ...item,
        clipIndex: index + 1,
        status: index === 0 ? "queued" : "waiting_dependency",
        dependsOnClipIndex: index > 0 ? index : null,
        prompt: getClipPrompt(script, index + 1),
        provider: modelConfig.provider,
        continuityMode: index === 0 ? mode : model === "g2" ? "keyframe" : "image",
        referenceAssetIds: script.clips[index].referenceAssetIds || [],
        continuityState: getClipContinuityState(script, index + 1),
        creditCost: model === "g2" ? Number(modelConfig.pricing[String(item.durationSec)] || 0) : item.durationSec * Number(modelConfig.pricing[resolution] || 0),
      }));
      const created = createProjectWithBilling({
        project: projectData,
        clips,
        generation,
        billing: {
          creditCost: estimatedCredits,
          event: {
            actionType: "videoProject",
            actionLabel: "AI 视频生成",
            brandId: input.brandId,
            brandName: input.brand?.name || "",
            trendId: input.trendId,
            trendTitle: input.trend?.title || "",
            ideaTitle: input.idea?.title || script.title || "",
            channelLabel: "AI 视频",
            summary: script.creativeConcept || input.idea?.summary || "",
            payload: {
              requestId,
              projectId,
              sourceVideoScriptGenerationId: source.generation?.id || null,
              model,
              mode,
              resolution,
              aspectRatio,
              totalDurationSec,
            },
          },
        },
      });
      persisted = !created.reused;
      if (!persisted) {
        await cleanupAssets(frozen.map((asset) => asset.asset));
      } else {
        updateGenerationSnapshot(created.project);
      }
      return {
        project: serializeProject(created.project),
        user: created.user,
        generation: created.generation,
      };
    } catch (error) {
      if (!persisted) await cleanupAssets(frozen.map((asset) => asset.asset));
      throw error;
    }
  }

  function getProjectForOwner(projectId, ownerUserId) {
    return serializeProject(reconcileProjectRefundedCredits(getProject(projectId, { ownerUserId })));
  }

  function listActiveProjects(ownerUserId, filters = {}) {
    return listProjectsByOwner(ownerUserId, { activeOnly: true, ...filters })
      .map((project) => serializeProject(reconcileProjectRefundedCredits(getProject(project.id, { ownerUserId }))));
  }

  function startProject(projectId, ownerUserId) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) throw createProjectError("视频项目不存在", "VIDEO_PROJECT_NOT_FOUND");
    if (["completed", "assembly_failed", "uncertain", "partial_failed"].includes(project.status)) return serializeProject(project);
    const next = updateProject(project.id, { status: "queued", error: "" });
    pump().catch((error) => log.warn?.("[video-project] immediate pump failed", { projectId, error: error.message }));
    return serializeProject(next);
  }

  async function retryClip(projectId, ownerUserId, clipIndex, requestId) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) throw createProjectError("视频项目不存在", "VIDEO_PROJECT_NOT_FOUND");
    const clip = project.clips.find((candidate) => candidate.index === Number(clipIndex));
    if (!clip) throw createProjectError("视频镜头不存在", "VIDEO_CLIP_NOT_FOUND");
    const result = retryProjectWithBilling({
      projectId,
      ownerUserId,
      clipIndex,
      requestId,
      event: {
        actionType: "videoProjectRetry",
        actionLabel: "AI 视频失败镜头重试",
        brandId: project.brandId,
        trendId: project.trendId,
        ideaTitle: project.script?.title || "",
        channelLabel: "AI 视频",
      },
    });
    if (!result.reused) updateGenerationSnapshot(result.project);
    pump().catch((error) => log.warn?.("[video-project] retry pump failed", { projectId, error: error.message }));
    return {
      project: serializeProject(getProject(projectId, { ownerUserId })),
      user: findUserById(ownerUserId),
    };
  }

  async function retryAssembly(projectId, ownerUserId, requestId) {
    const claim = claimAssemblyRetry({ projectId, ownerUserId, requestId });
    if (!claim.shouldRun) return serializeProject(claim.project);
    try {
      const finalVideo = await ffmpegSemaphore.run(() => assembleFinalVideo(claim.project));
      const completed = updateProject(projectId, { status: "completed", finalVideo, error: "" });
      updateGenerationSnapshot(completed);
    } catch (error) {
      const failed = updateProject(projectId, { status: "assembly_failed", error: error.message || "视频片段已全部完成，最终成片拼接失败" });
      updateGenerationSnapshot(failed);
    }
    return serializeProject(getProject(projectId, { ownerUserId }));
  }

  async function serveAsset(projectId, ownerUserId, kind, position, res) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) return false;
    let asset = null;
    let contentType = "video/mp4";
    if (kind === "final") asset = project.finalVideo?.asset;
    else if (kind === "input") {
      const input = (project.inputAssets || []).find((candidate) => candidate.position === Number(position));
      asset = input?.asset;
      contentType = input?.mimeType || "image/png";
    } else {
      const clip = project.clips.find((candidate) => candidate.index === Number(position));
      if (kind === "clip") asset = clip?.outputVideo?.asset;
      if (kind === "continuity-frame") {
        asset = clip?.continuityFrame?.asset;
        contentType = clip?.continuityFrame?.mimeType || "image/jpeg";
      }
    }
    if (!asset) return false;
    if (asset.objectKey) {
      const url = await storage.createReadUrl(asset, { expiresSeconds: 300 });
      res.writeHead(302, { Location: url, "Cache-Control": "private, no-store" });
      res.end();
      return true;
    }
    const buffer = await storage.readBuffer(asset);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, max-age=300", "Content-Length": buffer.length });
    res.end(buffer);
    return true;
  }

  return {
    start,
    stop,
    pump,
    recover,
    getCapabilities: getPublicVideoCapabilities,
    estimateCost: (input) => {
      const model = normalizeModelId(input.model || "d2");
      const resolution = normalizeResolution(model, input.resolution);
      const totalDurationSec = normalizeTotalDuration(input.totalDurationSec, 30);
      const clipDurations = segmentVideoDuration(model, totalDurationSec);
      return { model, resolution, totalDurationSec, clipDurations, credits: estimateVideoCredits({ model, resolution, totalDurationSec, clipDurations }) };
    },
    createProject,
    getProject: getProjectForOwner,
    listActiveProjects,
    startProject,
    retryClip,
    retryAssembly,
    serveAsset,
    serializeProject,
    getConcurrencySnapshot: () => ({
      d2Submit: { active: d2SubmitSemaphore.active, limit: d2SubmitSemaphore.limit },
      media: { active: mediaSemaphore.active, limit: mediaSemaphore.limit },
      ffmpeg: { active: ffmpegSemaphore.active, limit: ffmpegSemaphore.limit },
    }),
    isActiveStatus: (status) => ACTIVE_PROJECT_STATUSES.has(status),
  };
}

module.exports = {
  ACTIVE_PROJECT_STATUSES,
  TERMINAL_PROJECT_STATUSES,
  createVideoProjectService,
  makeTimeline,
  buildClipReferenceIds,
  clipNeedsContinuityFrame,
  createSemaphore,
};
