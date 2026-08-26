const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getXingtuPublicVideoCatalog,
  requestOfficialResource,
  requestOfficialTranscript,
  buildTranscriptLearningAnalysis,
} = require("../src/server/services/xingtu-video-service");
const { handleXingtuVideoRoutes } = require("../src/server/api/xingtu-video-routes");

test("巨量星图公开视频目录仅返回同源媒体代理元数据，不包含本地媒体文件", () => {
  const items = getXingtuPublicVideoCatalog();
  assert.ok(items.length >= 6);
  assert.equal(items[0].noteType, "video");
  assert.match(items[0].playerUrl, /^\/api\/xingtu\/videos\/\d+\/media$/);
  assert.match(items[0].coverUrl, /^\/api\/xingtu\/videos\/\d+\/cover$/);
  assert.match(items[0].videoUrl, /^https:\/\/www\.douyin\.com\/video\//);
  assert.match(items[0].transcriptUrl, /^https:\/\/www\.xingtu\.cn\/gw\/api\/aggregator\/get_item_high_quality_text/);
  assert.equal(JSON.stringify(items).includes("/data/"), false);
  assert.equal(JSON.stringify(items).includes("iesdouyin.com"), false);
});

test("公共封面和媒体端点返回对应响应", async () => {
  const requestedPaths = [
    "/api/xingtu/videos/invalid/cover",
    "/api/xingtu/videos/invalid/media",
  ];
  for (const pathname of requestedPaths) {
    const result = { status: 0, payload: null };
    const handled = await handleXingtuVideoRoutes({
      appConfig: {},
      json: (_res, status, payload) => {
        result.status = status;
        result.payload = payload;
      },
      unauthorized: () => {
        throw new Error("公共媒体端点不应触发应用鉴权");
      },
      badRequest: () => {
        throw new Error("无效目录项应返回未找到，而不是参数错误");
      },
    }, {
      method: "GET",
      url: pathname,
      headers: {},
    }, {}, pathname);
    assert.equal(handled, true);
    assert.equal(result.status, 404);
    assert.match(result.payload.error, /未找到该视频/);
  }
});

test("公共封面端点返回稳定 SVG 或图片", async () => {
  const result = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead: (status, headers) => {
      result.status = status;
      result.headers = headers;
    },
    end: (body) => {
      result.body = Buffer.from(body || "").toString("utf8");
    },
  };
  const handled = await handleXingtuVideoRoutes({
    appConfig: {},
    json: () => {
      throw new Error("已知视频封面不应走 JSON 错误分支");
    },
    unauthorized: () => {
      throw new Error("公共封面端点不应触发应用鉴权");
    },
  }, {
    method: "GET",
    url: "/api/xingtu/videos/7675709137612013818/cover",
    headers: {},
  }, res, "/api/xingtu/videos/7675709137612013818/cover");
  assert.equal(handled, true);
  assert.equal(result.status, 200);
});

test("媒体重定向逐跳重建请求头，绝不把会话凭据传给 CDN", async () => {
  const calls = [];
  await requestOfficialResource("https://www.xingtu.cn/media/example", {
    cookie: "synthetic_session=1",
    range: "bytes=0-1023",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return { status: 302, ok: false, headers: new Headers({ location: "https://v3.douyinvod.com/media/example" }) };
      }
      return { status: 206, ok: true, headers: new Headers(), body: null };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Cookie, "synthetic_session=1");
  assert.equal(calls[0].init.headers.Range, "bytes=0-1023");
  assert.equal("Cookie" in calls[1].init.headers, false);
  assert.equal(calls[1].init.headers.Range, "bytes=0-1023");
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
