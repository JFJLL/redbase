const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getXingtuPublicVideoCatalog,
  requestOfficialTranscript,
  buildTranscriptLearningAnalysis,
} = require("../src/server/services/xingtu-video-service");
const { handleXingtuVideoRoutes } = require("../src/server/api/xingtu-video-routes");

test("巨量星图公开视频目录返回内容市场提供的官方封面和官方播放直连", () => {
  const items = getXingtuPublicVideoCatalog();
  assert.ok(items.length >= 6);
  assert.equal(items[0].noteType, "video");
  assert.match(items[0].coverUrl, /^https:\/\/p3-star\.byteimg\.com\/img\//);
  assert.match(items[0].playerUrl, /^https:\/\/www\.iesdouyin\.com\/aweme\/v1\/play\//);
  assert.match(items[0].videoUrl, /^https:\/\/www\.douyin\.com\/video\//);
  assert.match(items[0].transcriptUrl, /^https:\/\/www\.xingtu\.cn\/gw\/api\/aggregator\/get_item_high_quality_text/);
  assert.equal(JSON.stringify(items).includes("/api/xingtu/videos/"), false);
  assert.equal(JSON.stringify(items).includes("/data/"), false);
});

test("不再提供本服务的封面和视频媒体转发端点", async () => {
  for (const pathname of [
    "/api/xingtu/videos/7675709137612013818/cover",
    "/api/xingtu/videos/7675709137612013818/media",
  ]) {
    const handled = await handleXingtuVideoRoutes({
      appConfig: {},
      json: () => {
        throw new Error("已移除的媒体路径不应返回 API 内容");
      },
    }, { method: "GET", url: pathname, headers: {} }, {}, pathname);
    assert.equal(handled, false);
  }
});

test("官方视频文稿会规范化并按时间排序，不保存上游原始响应", async () => {
  const transcript = await requestOfficialTranscript("7675709137612013818", {
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        base_resp: { status_code: 0 },
        texts: [
          { start_time: 10000, end_time: 13000, text: "收束结论" },
          { start_time: 0, end_time: 3000, text: "开场钩子" },
          { start_time: 3000, end_time: 8000, text: "过程细节" },
          { start_time: 3000, end_time: 8000, text: "过程细节" },
        ],
      }),
    }),
  });
  assert.equal(transcript.available, true);
  assert.deepEqual(transcript.segments.map((segment) => segment.text), ["开场钩子", "过程细节", "收束结论"]);
  assert.equal("raw" in transcript, false);
});

test("视频学习分析输出方法论与原创提示，而非复刻原文", () => {
  const item = getXingtuPublicVideoCatalog()[0];
  const analysis = buildTranscriptLearningAnalysis({
    item,
    transcript: {
      segments: [
        { startMs: 0, endMs: 3000, text: "第一句建立冲突" },
        { startMs: 4000, endMs: 12000, text: "第二段给出具体过程" },
        { startMs: 13000, endMs: 18000, text: "最后回到结果" },
      ],
    },
  });
  assert.equal(analysis.available, true);
  assert.equal(analysis.structure.length, 3);
  assert.ok(analysis.originalGuidance.some((line) => line.includes("不复用")));
  assert.ok(analysis.disclaimer.includes("官方返回的文稿"));
});

test("无文稿视频仍返回正常的可解释状态", () => {
  const analysis = buildTranscriptLearningAnalysis({ item: getXingtuPublicVideoCatalog()[0], transcript: { segments: [] } });
  assert.equal(analysis.available, false);
  assert.match(analysis.title, /暂无视频文稿/);
});
