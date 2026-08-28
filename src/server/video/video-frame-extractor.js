const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function resolveFfmpegBinary(appConfig = {}) {
  const configured = [appConfig.video?.ffmpegPath, appConfig.video?.ffmpegOverride, process.env.VIDEO_FFMPEG_PATH, process.env.FFMPEG_PATH]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  if (configured) return configured;
  try {
    // ffmpeg-static is optional during unit tests and is resolved only when a
    // real frame/assembly operation is requested.
    return require("ffmpeg-static");
  } catch (_error) {
    return "ffmpeg";
  }
}

async function defaultExecutor(binary, args, options = {}) {
  return execFileAsync(binary, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, ...options });
}

async function createVideoTempDir(prefix = "redbase-video-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}${crypto.randomUUID()}-`));
}

async function extractFrameAtOffset({ videoPath, outputPath, offsetSeconds, ffmpegPath, executor = defaultExecutor }) {
  await executor(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-sseof", `-${Number(offsetSeconds).toFixed(3)}`,
    "-i", videoPath,
    "-frames:v", "1",
    "-y", outputPath,
  ]);
  return outputPath;
}

async function extractStableLastFrame({ videoPath, outputPath, appConfig, executor = defaultExecutor } = {}) {
  if (!videoPath || !outputPath) throw new Error("videoPath and outputPath are required");
  const ffmpegPath = resolveFfmpegBinary(appConfig);
  const attempts = [0.3, 0.5, 0];
  let lastError;
  for (const offsetSeconds of attempts) {
    try {
      if (offsetSeconds > 0) {
        await extractFrameAtOffset({ videoPath, outputPath, offsetSeconds, ffmpegPath, executor });
      } else {
        await executor(ffmpegPath, [
          "-hide_banner",
          "-loglevel", "error",
          "-sseof", "-0.01",
          "-i", videoPath,
          "-frames:v", "1",
          "-y", outputPath,
        ]);
      }
      const stat = await fsp.stat(outputPath);
      if (stat.size > 0) return { outputPath, offsetSeconds, ffmpegPath };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法提取视频尾帧");
}

async function extractFirstFrame({ videoPath, outputPath, appConfig, executor = defaultExecutor } = {}) {
  if (!videoPath || !outputPath) throw new Error("videoPath and outputPath are required");
  const ffmpegPath = resolveFfmpegBinary(appConfig);
  const attempts = [0, 0.04, 0.1];
  let lastError;
  for (const offsetSeconds of attempts) {
    try {
      await executor(ffmpegPath, [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", Number(offsetSeconds).toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        "-y", outputPath,
      ]);
      const stat = await fsp.stat(outputPath);
      if (stat.size > 0) return { outputPath, offsetSeconds, ffmpegPath };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法提取视频首帧");
}

async function withVideoTempDir(work, options = {}) {
  const tempDir = options.tempDir || await createVideoTempDir(options.prefix);
  try {
    return await work(tempDir);
  } finally {
    if (!options.tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  defaultExecutor,
  resolveFfmpegBinary,
  createVideoTempDir,
  extractFrameAtOffset,
  extractFirstFrame,
  extractStableLastFrame,
  withVideoTempDir,
};
