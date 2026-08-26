const fsp = require("fs/promises");
const path = require("path");

const { signAssetUrl } = require("../assets/signed-urls");
const { insertGeneration, findGenerationById, upsertGeneration, deleteGenerationRows } = require("../db/repositories/generation-repository");
const { findProductImageByOwner } = require("../db/repositories/product-image-repository");
const { findUserById } = require("../db/repositories/auth-repository");
const { trySpendCreditsWithEvent } = require("../db/repositories/admin-repository");
const { allocateCounter } = require("../db/repositories/core-repository");
const { getDbProxy } = require("../db/connection");
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
  createProjectWithClips,
  findProjectByOwnerAndRequestId,
  getProject,
  listProjectsByOwner,
  listRecoverableProjects,
  updateProject,
  updateClip,
  updateClipByProjectIndex,
} = require("../db/repositories/video-project-repository");
const { refundVideoCredits } = require("./video-billing");

const db = getDbProxy();
const ACTIVE_PROJECT_STATUSES = new Set(["preparing", "queued", "running", "partial_failed"]);
const TERMINAL_PROJECT_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function createVideoProjectService(options = {}) {
  const appConfig = options.appConfig || {};
  const storage = options.generatedAssetStorage;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const log = options.logger || console;
  const executor = options.executor || defaultExecutor;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const providers = options.providers || {
    d2: createD2Provider({ appConfig, fetchImpl }),
    g2: createG2Provider({ appConfig, fetchImpl }),
  };
  const keyPool = options.keyPool || createAgnesKeyPool({
    keys: appConfig.video?.agnes?.apiKeys || [],
    rpmPerKey: Number(appConfig.video?.agnes?.rpmPerKey || 1),
    now,
  });
  const inFlight = new Set();
  const nextPollAt = new Map();
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

  function videoAssetPath(projectId, kind, clipIndex = null) {
    const suffix = clipIndex == null ? kind : `${kind}/${Number(clipIndex)}`;
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
      error: clip.error,
    };
  }

  function serializeProject(project) {
    if (!project) return null;
    return {
      id: project.id,
      generationId: project.generationId,
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
      visualBible: project.visualBible,
      script: project.script,
      estimatedCredits: project.estimatedCredits,
      chargedCredits: project.chargedCredits,
      refundedCredits: project.refundedCredits,
      finalVideoUrl: project.finalVideo?.asset ? signVideoPath(videoAssetPath(project.id, "final")) : "",
      clips: (project.clips || []).map((clip) => buildPublicClip(project, clip)),
      error: project.error,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  function updateGenerationSnapshot(project) {
    const generation = findGenerationById(project.generationId);
    if (!generation) return null;
    const payload = {
      ...(generation.payload || {}),
      projectId: project.id,
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

  function getProvider(project) {
    const provider = providers[normalizeModelId(project.model)];
    if (!provider) throw createProjectError(`视频模型 ${project.model} 暂不可用`, "VIDEO_MODEL_UNAVAILABLE");
    return provider;
  }

  function getReferenceUrls(project, clip, provider) {
    const config = getVideoModelConfig(project.model);
    const urls = [];
    const previous = project.clips?.find((candidate) => candidate.index === clip.dependsOnClipIndex);
    const previousPath = previous?.continuityFrame?.asset
      ? signVideoPath(videoAssetPath(project.id, "continuity-frame", previous.index))
      : "";
    if (previousPath && project.model === "d2") urls.push(toPublicUrl(previousPath, { requireAbsolute: provider.provider !== "fake" }));
    const ids = clip.referenceAssetIds || [];
    for (const id of ids) {
      const image = findProductImageByOwner(Number(id), project.ownerUserId);
      if (!image) continue;
      const signedPath = signAssetUrl(appConfig, `/api/product-images/${image.id}/file`, { ttlMs: DAY_MS });
      urls.push(toPublicUrl(signedPath, { requireAbsolute: provider.provider !== "fake" }));
    }
    return urls.slice(0, config.maxReferenceImages);
  }

  function getFirstFrameUrl(project, clip, provider) {
    const previous = project.clips?.find((candidate) => candidate.index === clip.dependsOnClipIndex);
    if (!previous?.continuityFrame?.asset) return "";
    const signedPath = signVideoPath(videoAssetPath(project.id, "continuity-frame", previous.index));
    return toPublicUrl(signedPath, { requireAbsolute: provider.provider !== "fake" });
  }

  async function downloadMedia(url, result, expected, provider) {
    if (expected === "video" && Buffer.isBuffer(result?.videoBuffer)) return { buffer: result.videoBuffer, contentType: "video/mp4", url };
    if (expected === "image" && Buffer.isBuffer(result?.frameBuffer)) return { buffer: result.frameBuffer, contentType: "image/png", url };
    return downloadProviderMedia(url, {
      allowedHosts: provider.getAllowedHosts ? provider.getAllowedHosts() : [],
      maxBytes: Number(appConfig.video?.maxDownloadBytes || 60 * 1024 * 1024),
      timeoutMs: Number(appConfig.video?.remoteTimeoutMs || 30000),
      fetchImpl,
      expected,
    });
  }

  async function saveAsset(project, variant, mimeType, buffer) {
    if (!storage?.save) throw createProjectError("视频资产存储未初始化", "VIDEO_STORAGE_UNAVAILABLE");
    return storage.save({ ownerUserId: project.ownerUserId, generationId: project.generationId, variant, mimeType, buffer });
  }

  async function persistClipResult(project, clip, result, provider) {
    if (!result.videoUrl && !result.videoBuffer) throw new Error("视频任务完成但没有视频文件");
    return withVideoTempDir(async (tempDir) => {
      const videoPath = path.join(tempDir, `clip-${clip.index}.mp4`);
      const video = await downloadMedia(result.videoUrl, result, "video", provider);
      await fsp.writeFile(videoPath, video.buffer);
      const videoAsset = await saveAsset(project, `clip-${clip.index}`, "video/mp4", video.buffer);

      let frame;
      if (result.nativeLastFrameUrl || result.frameBuffer) {
        frame = await downloadMedia(result.nativeLastFrameUrl, result, "image", provider);
      } else {
        const framePath = path.join(tempDir, `continuity-${clip.index}.jpg`);
        await extractStableLastFrame({ videoPath, outputPath: framePath, appConfig, executor });
        frame = { buffer: await fsp.readFile(framePath), contentType: "image/jpeg", url: "" };
      }
      const continuityFrame = await saveAsset(project, `continuity-frame-${clip.index}`, frame.contentType || "image/jpeg", frame.buffer);
      return {
        outputVideo: { asset: videoAsset, mimeType: "video/mp4", sizeBytes: video.buffer.length },
        continuityFrame: { asset: continuityFrame, mimeType: frame.contentType || "image/jpeg", sizeBytes: frame.buffer.length },
      };
    });
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
      const buffer = await fsp.readFile(outputPath);
      const asset = await saveAsset(project, "final", "video/mp4", buffer);
      return { asset, mimeType: "video/mp4", sizeBytes: buffer.length };
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
    if (!project || !(project.clips || []).length || !(project.clips || []).every((candidate) => candidate.status === "completed")) {
      return project;
    }
    if (project.finalVideo?.asset) {
      return project.status === "completed" ? project : updateProject(project.id, { status: "completed", error: "" });
    }
    try {
      const finalVideo = await assembleFinalVideo(project);
      const completed = updateProject(project.id, { status: "completed", finalVideo, error: "" });
      updateGenerationSnapshot(completed);
      return completed;
    } catch (error) {
      const partial = updateProject(project.id, { status: "partial_failed", error: error.message || "视频拼接失败" });
      updateGenerationSnapshot(partial);
      return partial;
    }
  }

  function nextProjectClip(project) {
    for (const clip of project.clips || []) {
      if (clipIsReady(project, clip)) return getProject(project.id);
      if (["submitting", "running"].includes(clip.status)) return project;
      if (["failed", "uncertain_submission", "cancelled"].includes(clip.status)) return project;
    }
    return project;
  }

  async function submitQueuedClip(project, clip, provider) {
    if (project.model === "g2") {
      if (!keyPool.hasKeys()) {
        updateProject(project.id, { status: "queued", error: "等待可用生成通道" });
        return false;
      }
      const lease = keyPool.acquire();
      if (!lease) return false;
      try {
        updateClip(clip.id, { status: "submitting", error: "" });
        const mode = clip.index === 1 ? (project.mode === "image" ? "reference" : "text") : "keyframe";
        const result = await provider.submitClip({
          apiKey: lease.key,
          prompt: clip.prompt,
          durationSec: clip.durationSec,
          aspectRatio: project.aspectRatio,
          mode,
          referenceUrls: getReferenceUrls(project, clip, provider),
          firstFrameUrl: getFirstFrameUrl(project, clip, provider),
        });
        keyPool.release(lease.slot, {});
        updateClip(clip.id, {
          status: "running",
          provider: provider.provider,
          providerTaskId: result.taskId,
          attempt: clip.attempt + 1,
          continuityMode: mode,
          error: "",
        });
        nextPollAt.set(clip.id, now() + Number(appConfig.video?.agnes?.pollIntervalMs || appConfig.video?.pollIntervalMs || 2000));
        return true;
      } catch (error) {
        keyPool.release(lease.slot, { error: true, statusCode: error.statusCode, rateLimited: error.statusCode === 429 });
        if (error.statusCode === 429) {
          updateClip(clip.id, { status: "queued", error: "生成通道限流，等待重试" });
          updateProject(project.id, { status: "queued", error: "生成通道限流，等待重试" });
          return false;
        }
        throw error;
      }
    }
    updateClip(clip.id, { status: "submitting", error: "" });
    const result = await provider.submitClip({
      prompt: clip.prompt,
      resolution: project.resolution,
      durationSec: clip.durationSec,
      aspectRatio: project.aspectRatio,
      referenceUrls: getReferenceUrls(project, clip, provider),
    });
    updateClip(clip.id, {
      status: "running",
      provider: provider.provider,
      providerTaskId: result.taskId,
      attempt: clip.attempt + 1,
      continuityMode: clip.index === 1 ? project.mode : "image",
      error: "",
    });
    nextPollAt.set(clip.id, now() + Number(appConfig.video?.pollIntervalMs || 2000));
    return true;
  }

  async function pollRunningClip(project, clip, provider) {
    if (!clip.providerTaskId) {
      await markUncertainSubmission(project, clip, "服务重启后发现 submitting 任务没有 provider task id");
      return;
    }
    if (Number(nextPollAt.get(clip.id) || 0) > now()) return;
    let result;
    const pollLease = project.model === "g2" ? keyPool.acquire({ rateLimit: false }) : null;
    if (project.model === "g2" && !pollLease) {
      nextPollAt.set(clip.id, now() + Number(appConfig.video?.agnes?.pollIntervalMs || 2000));
      return;
    }
    try {
      const apiKey = project.model === "g2" ? pollLease.key : undefined;
      result = await provider.getTaskStatus({ taskId: clip.providerTaskId, apiKey });
      if (pollLease) keyPool.release(pollLease.slot, {});
    } catch (error) {
      if (pollLease) keyPool.release(pollLease.slot, { error: true, statusCode: error.statusCode, rateLimited: error.statusCode === 429 });
      if (Number(error.statusCode) === 429) {
        nextPollAt.set(clip.id, now() + Number(appConfig.video?.pollIntervalMs || 2000));
        return;
      }
      nextPollAt.set(clip.id, now() + Number(appConfig.video?.pollIntervalMs || 2000));
      log.warn?.("[video-project] polling failed", { projectId: project.id, clipIndex: clip.index, error: error.message });
      return;
    }
    if (result.status === "running") {
      nextPollAt.set(clip.id, now() + Number(project.model === "g2" ? appConfig.video?.agnes?.pollIntervalMs || 2000 : appConfig.video?.pollIntervalMs || 2000));
      return;
    }
    if (result.status === "failed") {
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
    const updatedClip = updateClip(clip.id, { status: "completed", ...persisted, providerTaskId: "", error: "" });
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
    const fresh = getProject(project.id);
    if (!fresh) return;
    const amount = (fresh.clips || [])
      .filter((candidate) => candidate.index >= clip.index && !["completed"].includes(candidate.status))
      .reduce((sum, candidate) => sum + Number(candidate.creditCost || 0), 0);
    const result = refundVideoCredits({
      userId: fresh.ownerUserId,
      amount,
      refundKey: `video-project:${fresh.id}:${keySuffix}:${clip.index}:${clip.attempt}`,
      reason,
      generationId: fresh.generationId,
      brandId: fresh.brandId,
      trendId: fresh.trendId,
      ideaTitle: fresh.script?.title || "",
      projectId: fresh.id,
    });
    const updated = result.refunded ? updateProject(fresh.id, { refundedCredits: fresh.refundedCredits + result.amount, status: "partial_failed", error: reason }) : getProject(fresh.id);
    if (updated) {
      for (const candidate of updated.clips || []) {
        if (candidate.index > clip.index && !["completed", "failed"].includes(candidate.status)) updateClip(candidate.id, { status: "cancelled", error: "前置镜头失败，尚未执行" });
      }
      updateGenerationSnapshot(getProject(updated.id));
    }
  }

  async function failClip(project, clip, errorMessage) {
    updateClip(clip.id, { status: "failed", error: String(errorMessage || "视频生成失败") });
    await refundRemaining(project, clip, `clip-failed`, errorMessage);
  }

  async function processProjectOnce(projectId) {
    const initial = getProject(projectId);
    if (!initial || TERMINAL_PROJECT_STATUSES.has(initial.status)) return;
    const project = nextProjectClip(initial);
    const active = (project.clips || []).find((clip) => ["submitting", "running"].includes(clip.status));
    if (active) {
      await pollRunningClip(project, active, getProvider(project));
      return;
    }
    const queued = (project.clips || []).find((clip) => clip.status === "queued");
    if (!queued) {
      if ((project.clips || []).every((clip) => clip.status === "completed")) {
        await finalizeCompletedProject(project);
      } else if (project.status === "preparing") updateProject(project.id, { status: "queued" });
      return;
    }
    updateProject(project.id, { status: "running", error: "" });
    const fresh = getProject(project.id);
    const provider = getProvider(fresh);
    try {
      await submitQueuedClip(fresh, queued, provider);
    } catch (error) {
      if (error.code === "VIDEO_PROVIDER_NOT_CONFIGURED" || error.code === "VIDEO_PUBLIC_BASE_URL_REQUIRED") {
        updateClip(queued.id, { status: "queued", error: error.message });
        updateProject(project.id, { status: "queued", error: error.message });
        return;
      }
      if (Number(error.statusCode) === 429) {
        updateClip(queued.id, { status: "queued", error: "供应商限流，等待重试" });
        updateProject(project.id, { status: "queued", error: "供应商限流，等待重试" });
        return;
      }
      if (error.uncertainSubmission || error.code === "ETIMEDOUT" || /timeout|fetch failed|socket/i.test(String(error.message || ""))) {
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
        updateProject(project.id, { status: "partial_failed", error: error.message || "视频任务异常" });
      } finally {
        inFlight.delete(project.id);
      }
    }));
  }

  async function recover() {
    for (const summary of listRecoverableProjects({ limit: 100 })) {
      const project = getProject(summary.id);
      if (!project) continue;
      const submitting = (project.clips || []).find((clip) => clip.status === "submitting" && !clip.providerTaskId);
      if (submitting) await markUncertainSubmission(project, submitting, "服务重启后无法确认供应商是否已接受任务");
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

  function createProject(input = {}) {
    const requestId = String(input.requestId || "").trim();
    if (!requestId) throw createProjectError("缺少视频项目 requestId", "VIDEO_REQUEST_ID_REQUIRED");
    const model = normalizeModelId(input.model || "d2");
    const modelConfig = getVideoModelConfig(model);
    const mode = String(input.mode || "text").trim().toLowerCase();
    if (!modelConfig.supportedModes.includes(mode)) throw createProjectError("视频生成方式不受当前模型支持", "VIDEO_MODE_UNSUPPORTED");
    const referenceAssetIds = toSafeIdList(input.referenceAssetIds, modelConfig.maxReferenceImages);
    if (mode === "image" && !referenceAssetIds.length) throw createProjectError("图生视频至少需要一张参考图", "VIDEO_REFERENCE_REQUIRED");
    const totalDurationSec = normalizeTotalDuration(input.totalDurationSec, 30);
    const durations = segmentVideoDuration(model, totalDurationSec);
    if (!durations.length) throw createProjectError("视频总时长无法按当前模型分段", "VIDEO_DURATION_UNSUPPORTED");
    const resolution = normalizeResolution(model, input.resolution);
    const aspectRatio = resolveVideoAspectRatio(input.aspectRatio, "9:16");
    const estimatedCredits = estimateVideoCredits({ model, resolution, totalDurationSec, clipDurations: durations });
    const existing = findProjectByOwnerAndRequestId(input.ownerUserId, requestId);
    if (existing) {
      const existingProject = getProject(existing.id);
      return {
        project: serializeProject(existingProject),
        user: findUserById(input.ownerUserId),
        generation: existingProject ? findGenerationById(existingProject.generationId) : null,
      };
    }
    if (!input.script || typeof input.script !== "object" || !Array.isArray(input.script.clips) || !input.script.clips.length) {
      throw createProjectError("请先生成并确认视频脚本", "VIDEO_SCRIPT_REQUIRED");
    }
    const projectId = allocateCounter("nextVideoProjectId", 1);
    const generationId = allocateCounter("nextGenerationId", 1);
    const charged = trySpendCreditsWithEvent({
      userId: input.ownerUserId,
      amount: estimatedCredits,
      event: {
        actionType: "videoProject",
        actionLabel: "AI 视频生成",
        brandId: input.brandId,
        brandName: input.brand?.name || "",
        trendId: input.trendId,
        trendTitle: input.trend?.title || "",
        ideaTitle: input.idea?.title || input.script.title || "",
        channelLabel: "AI 视频",
        summary: input.script.creativeConcept || input.idea?.summary || "",
          payload: { requestId, projectId, model, mode, resolution, aspectRatio, totalDurationSec },
      },
    });
    if (!charged?.spent) throw createProjectError("积分不足或扣除失败", "INSUFFICIENT_CREDITS");
    try {
      const script = {
        ...input.script,
        model,
        mode,
        resolution,
        aspectRatio,
        totalDurationSec,
        clips: makeTimeline(durations).map((timeline, index) => ({
          ...(input.script.clips?.[index] || {}),
          ...timeline,
          generationDurationSec: timeline.durationSec,
          dependsOnClipIndex: index > 0 ? index : null,
          continuityMode: index === 0 ? mode : model === "g2" ? "keyframe" : "image",
          referenceAssetIds: buildClipReferenceIds({ model, mode, allIds: referenceAssetIds, clipIndex: index + 1, maxReferenceImages: modelConfig.maxReferenceImages }),
        })),
      };
      const generation = insertGeneration({
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
        createdAt: new Date(now()).toISOString(),
        previewUrl: "",
        summary: script.creativeConcept || input.idea?.summary || "",
        payload: { requestId, projectId, videoModel: model, videoMode: mode, videoStatus: "queued", videoDuration: totalDurationSec, videoAspectRatio: aspectRatio, videoResolution: resolution, script },
      });
      const project = createProjectWithClips({
        id: projectId,
        ownerUserId: input.ownerUserId,
        generationId,
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
        referenceAssetIds,
        visualBible: input.visualBible || {},
        script,
        estimatedCredits,
        chargedCredits: estimatedCredits,
        creditEventId: charged.creditEvent.id,
      }, makeTimeline(durations).map((timeline, index) => ({
        ...timeline,
        clipIndex: index + 1,
        status: index === 0 ? "queued" : "waiting_dependency",
        dependsOnClipIndex: index > 0 ? index : null,
        prompt: getClipPrompt(script, index + 1),
        provider: modelConfig.provider,
        continuityMode: index === 0 ? mode : model === "g2" ? "keyframe" : "image",
        referenceAssetIds: script.clips[index].referenceAssetIds || [],
        continuityState: getClipContinuityState(script, index + 1),
        creditCost: model === "g2" ? Number(modelConfig.pricing[String(timeline.durationSec)] || 0) : timeline.durationSec * Number(modelConfig.pricing[resolution] || 0),
      })));
      updateGenerationSnapshot(project);
      return { project: serializeProject(getProject(project.id)), user: charged.user, generation };
    } catch (error) {
      refundVideoCredits({ userId: input.ownerUserId, amount: estimatedCredits, refundKey: `video-project-create:${requestId}:${projectId}:${generationId}`, reason: error.message, generationId, projectId });
      try {
        deleteGenerationRows(generationId, { deleteReason: "video_project_create_failed" });
      } catch (cleanupError) {
        log.warn?.("[video-project] failed to clean up project creation generation", {
          generationId,
          error: cleanupError.message,
        });
      }
      throw error;
    }
  }

  function getProjectForOwner(projectId, ownerUserId) {
    return serializeProject(getProject(projectId, { ownerUserId }));
  }

  function listActiveProjects(ownerUserId) {
    return listProjectsByOwner(ownerUserId, { activeOnly: true }).map((project) => serializeProject(getProject(project.id)));
  }

  function startProject(projectId, ownerUserId) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) throw createProjectError("视频项目不存在", "VIDEO_PROJECT_NOT_FOUND");
    if (TERMINAL_PROJECT_STATUSES.has(project.status) && project.status !== "failed") return serializeProject(project);
    const next = updateProject(project.id, { status: "queued", error: "" });
    pump().catch((error) => log.warn?.("[video-project] immediate pump failed", { projectId, error: error.message }));
    return serializeProject(next);
  }

  function hasRetryRequest(ownerUserId, requestId) {
    return Boolean(db.prepare(`
      SELECT id FROM credit_events
      WHERE user_id = ? AND action_type = 'videoProjectRetry'
        AND json_extract(payload_json, '$.requestId') = ?
      LIMIT 1
    `).get(Number(ownerUserId), String(requestId || "")));
  }

  function retryClip(projectId, ownerUserId, clipIndex, requestId) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) throw createProjectError("视频项目不存在", "VIDEO_PROJECT_NOT_FOUND");
    const clip = project.clips.find((candidate) => candidate.index === Number(clipIndex));
    if (!clip) throw createProjectError("视频镜头不存在", "VIDEO_CLIP_NOT_FOUND");
    if (hasRetryRequest(ownerUserId, requestId)) return serializeProject(project);
    if (!(["failed", "uncertain_submission", "cancelled"].includes(clip.status) || project.status === "failed" || project.status === "partial_failed")) {
      return serializeProject(project);
    }
    const remainingCost = project.clips.filter((candidate) => candidate.index >= clip.index).reduce((sum, candidate) => sum + candidate.creditCost, 0);
    const charged = trySpendCreditsWithEvent({
      userId: ownerUserId,
      amount: remainingCost,
      event: {
        actionType: "videoProjectRetry",
        actionLabel: "AI 视频失败镜头重试",
        generationId: project.generationId,
        brandId: project.brandId,
        trendId: project.trendId,
        ideaTitle: project.script?.title || "",
        channelLabel: "AI 视频",
        payload: { requestId, projectId, clipIndex: clip.index },
      },
    });
    if (!charged?.spent) throw createProjectError("积分不足，无法重试剩余镜头", "INSUFFICIENT_CREDITS");
    for (const candidate of project.clips) {
      if (candidate.index < clip.index) continue;
      updateClip(candidate.id, {
        status: candidate.index === clip.index && (clip.dependsOnClipIndex == null || project.clips.find((item) => item.index === clip.dependsOnClipIndex)?.status === "completed") ? "queued" : "waiting_dependency",
        providerTaskId: "",
        error: "",
        retryCount: candidate.retryCount + (candidate.index === clip.index ? 1 : 0),
      });
    }
    const next = updateProject(project.id, { status: "queued", error: "", chargedCredits: project.chargedCredits + remainingCost });
    updateGenerationSnapshot(next);
    pump().catch((error) => log.warn?.("[video-project] retry pump failed", { projectId, error: error.message }));
    return serializeProject(getProject(project.id));
  }

  async function serveAsset(projectId, ownerUserId, kind, clipIndex, res) {
    const project = getProject(projectId, { ownerUserId });
    if (!project) return false;
    let asset = null;
    let contentType = "video/mp4";
    if (kind === "final") asset = project.finalVideo?.asset;
    else {
      const clip = project.clips.find((candidate) => candidate.index === Number(clipIndex));
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
    serveAsset,
    serializeProject,
    isActiveStatus: (status) => ACTIVE_PROJECT_STATUSES.has(status),
  };
}

module.exports = {
  ACTIVE_PROJECT_STATUSES,
  TERMINAL_PROJECT_STATUSES,
  createVideoProjectService,
  makeTimeline,
  buildClipReferenceIds,
};
