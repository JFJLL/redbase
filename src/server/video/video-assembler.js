const fsp = require("fs/promises");
const path = require("path");
const { resolveFfmpegBinary, defaultExecutor } = require("./video-frame-extractor");

function escapeConcatPath(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

async function assembleVideoClips({ clipPaths = [], outputPath, appConfig, executor = defaultExecutor } = {}) {
  if (!Array.isArray(clipPaths) || !clipPaths.length || !outputPath) {
    throw new Error("至少需要一个视频 Clip 才能拼接成片");
  }
  const ffmpegPath = resolveFfmpegBinary(appConfig);
  const listPath = `${outputPath}.concat.txt`;
  await fsp.writeFile(listPath, clipPaths.map((item) => `file '${escapeConcatPath(path.resolve(item))}'`).join("\n"), "utf8");
  let firstError;
  try {
    try {
      await executor(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", outputPath]);
    } catch (error) {
      firstError = error;
      await executor(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", "-y", outputPath,
      ]);
    }
    const stat = await fsp.stat(outputPath);
    if (!stat.size) throw firstError || new Error("拼接后视频为空");
    return { outputPath, ffmpegPath, usedFallback: Boolean(firstError) };
  } finally {
    await fsp.rm(listPath, { force: true }).catch(() => {});
  }
}

module.exports = {
  escapeConcatPath,
  assembleVideoClips,
};
