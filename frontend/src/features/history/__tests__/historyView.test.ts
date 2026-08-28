import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import HistoryView from "../views/HistoryView.vue";
import {
  hasExpiredAssetSignature,
  matchesGenerationHistoryFilters,
  normalizeHistoryDateBoundary,
  parseAssetExpiryMs,
} from "../api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/login", name: "login", component: { template: "<div />" } },
      { path: "/ideas", name: "ideas", component: { template: "<div />" } },
    ],
  });
}

const GENERATIONS = [
  {
    id: 1,
    type: "moments",
    cardTitle: "露营朋友圈图",
    brandName: "品牌A",
    brandId: 7,
    trendId: 5,
    trendTitle: "五一露营潮",
    ideaTitle: "露营装备清单",
    channelLabel: "朋友圈",
    createdAt: "2026-07-20T08:00:00.000Z",
    previewUrl: "/api/generated-images/1/file?sig=aaa",
    payload: { caption: "露营去咯", visualDirection: "清新自然", aspectRatio: "3:4" },
  },
  {
    id: 2,
    type: "xhsCarousel",
    cardTitle: "护肤小红书组图",
    brandName: "品牌B",
    brandId: 8,
    trendTitle: "夏日护肤",
    ideaTitle: "晨间流程",
    channelLabel: "小红书",
    createdAt: "2026-07-21T08:00:00.000Z",
    payload: {
      publishTitle: "晨间护肤这样做",
      publishCaption: "收藏这套流程",
      slides: [{ title: "第1页", imageUrl: "/api/generated-images/2/slides/0/file?sig=bbb" }],
    },
  },
  {
    id: 3,
    type: "videoScript",
    cardTitle: "露营咖啡视频脚本",
    brandName: "品牌A",
    brandId: 7,
    trendId: 5,
    trendTitle: "五一露营潮",
    ideaTitle: "户外手冲咖啡指南",
    channelLabel: "视频脚本",
    createdAt: "2026-07-22T08:00:00.000Z",
    previewUrl: "",
    payload: {
      ideaIndex: 0,
      aspectRatio: "9:16",
      videoScript: {
        title: "露营咖啡视频脚本",
        creativeConcept: "用手冲咖啡开启自然之旅",
        totalDurationSec: 30,
        aspectRatio: "9:16",
        globalSubjectReference: "手冲壶与咖啡豆",
        globalStyleReference: "户外晨光色调",
        globalContinuity: "动作连贯",
        audioDirection: { music: "轻快吉他", ambience: "鸟鸣与流水", voiceStyle: "沉静治愈" },
        clips: [
          {
            index: 1,
            startSec: 0,
            endSec: 5,
            durationSec: 5,
            purpose: "开场抓人",
            subjectReference: "手冲壶",
            firstFrame: "清晨阳光照在露营帐篷上",
            lastFrame: "特写手冲壶冒出热气",
            scene: "山林露营地",
            subjectAction: "慢慢倒水",
            cameraMovement: "慢速推近",
            environmentMotion: "微风吹拂",
            lightingAndStyle: "自然晨光",
            audioPrompt: "流水声与鸟鸣",
            prompt: "Cinematic shot of outdoor coffee brewing at sunrise, 4k photorealistic.",
          },
        ],
      },
    },
  },
];

type FetchCall = { url: string; init?: RequestInit };

describe("HistoryView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountView(overrides?: (url: string, init?: RequestInit) => Response | undefined) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000" };
    auth.sessionLoaded = true;

    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const custom = overrides?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
        if (url.startsWith("/api/history")) return jsonResponse(200, { generations: GENERATIONS });
        throw new Error("unhandled fetch: " + url);
      }),
    );
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, calls, router };
  }

  it("renders history cards with type labels, signed image URLs, and 30-day retention note", async () => {
    const { wrapper, calls } = await mountView();

    expect(calls.some((call) => call.url.startsWith("/api/history"))).toBe(true);
    const cards = wrapper.findAll('[data-test="history-card"]');
    expect(cards).toHaveLength(3);
    expect(wrapper.text()).toContain("朋友圈图文");
    expect(wrapper.text()).toContain("小红书组图");
    expect(wrapper.text()).toContain("视频脚本");
    expect(wrapper.text()).toContain("查看所有生成过的图片、标题和文案，统一回看并复用已产出的内容资产。");
    expect(wrapper.text()).toContain("历史生成图片会保存 30 天，请及时下载。");
    expect(wrapper.find('img[src="/api/generated-images/1/file?sig=aaa"]').exists()).toBe(true);
    expect(wrapper.find('img[src="/api/generated-images/2/slides/0/file?sig=bbb"]').exists()).toBe(true);
  });

  it("renders videoScript history cards without images and exposes start-video inside the script modal", async () => {
    const videoProjectCreateResponse = {
      project: {
        id: 901,
        generationId: 901,
        brandId: 7,
        trendId: 5,
        ideaIndex: 0,
        model: "d2",
        mode: "text",
        resolution: "720p",
        aspectRatio: "9:16",
        totalDurationSec: 30,
        status: "queued",
        referenceAssetIds: [],
        visualBible: {},
        estimatedCredits: 30,
        chargedCredits: 30,
        refundedCredits: 0,
        finalVideoUrl: "",
        clips: GENERATIONS[2].payload?.videoScript?.clips?.map((clip, index) => ({
          id: 9100 + index,
          index: (index + 1),
          startSec: clip.startSec,
          endSec: clip.endSec,
          durationSec: clip.durationSec,
          status: "queued",
          prompt: clip.prompt,
          continuityMode: "text",
          referenceAssetIds: [],
          creditCost: 30,
          attempt: 1,
          retryCount: 0,
          error: "",
        })) || [],
        script: GENERATIONS[2].payload?.videoScript,
      },
      user: { id: "1", credits: 8 },
    };
    const { wrapper, calls, router } = await mountView((url, init) => {
      if (url === "/api/brands/7/trends/5/ideas/0/video-project" && init?.method === "POST") {
        return jsonResponse(200, videoProjectCreateResponse);
      }
      return undefined;
    });
    const scriptCard = wrapper.findAll('[data-test="history-card"]')[2];

    expect(scriptCard.text()).toContain("视频脚本");
    expect(scriptCard.text()).toContain("30 秒");
    expect(scriptCard.text()).toContain("1 个片段");
    expect(scriptCard.text()).toContain("用手冲咖啡开启自然之旅");
    expect(scriptCard.find('[data-test="history-video-continue"]').exists()).toBe(false);

    const detailBtn = scriptCard.find('[data-test="history-detail"]');
    expect(detailBtn.text()).toBe("查看脚本");
    await detailBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="video-script-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="video-script-title"]').text()).toBe("露营咖啡视频脚本");
    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(false);

    const startVideoBtn = wrapper.find('[data-test="video-script-start"]');
    expect(startVideoBtn.exists()).toBe(true);
    expect(startVideoBtn.text()).toContain("一键生成整段视频");
    await startVideoBtn.trigger("click");
    await flushPromises();

    const createCall = calls.find(
      (call) => call.url === "/api/brands/7/trends/5/ideas/0/video-project" && call.init?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
      videoScriptGenerationId: 3,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 30,
      referenceAssetIds: [],
    });
    // 详情弹窗关闭，页面停留在历史生成路由上，不再跳转 ideas。
    expect(router.currentRoute.value.name).not.toBe("ideas");
    expect(wrapper.find('[data-test="video-script-result"]').exists()).toBe(false);
  });

  it("renders video project clip playback, download, and keeps the left media area for every clip (including pending/failed)", async () => {
    const project = {
      id: 77,
      generationId: 177,
      brandId: 7,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 15,
      status: "partial_failed",
      referenceAssetIds: [],
      visualBible: {},
      estimatedCredits: 30,
      chargedCredits: 30,
      refundedCredits: 5,
      finalVideoUrl: "",
      clips: [
        { id: 7701, index: 1, startSec: 0, endSec: 10, durationSec: 10, status: "completed", prompt: "镜头一原提示词", continuityMode: "text", referenceAssetIds: [], creditCost: 20, attempt: 1, retryCount: 0, videoUrl: "/api/video-projects/77/assets/clip/1?assetExpires=9999999999999&assetSignature=clip-one", posterUrl: "/api/video-projects/77/assets/poster/1?assetExpires=9999999999999&assetSignature=poster-one", error: "" },
        { id: 7702, index: 2, startSec: 10, endSec: 15, durationSec: 5, status: "failed", prompt: "镜头二原提示词", continuityMode: "image", referenceAssetIds: [], creditCost: 10, attempt: 1, retryCount: 0, error: "供应商暂时不可用", posterUrl: "/api/video-projects/77/assets/poster/2?assetExpires=9999999999999&assetSignature=poster-two" },
      ],
      script: GENERATIONS[2].payload?.videoScript,
    };
    const { wrapper, calls } = await mountView((url) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, {
          generations: [{
            id: 77,
            type: "videoProject",
            cardTitle: "露营咖啡视频",
            brandName: "品牌A",
            brandId: 7,
            trendTitle: "五一露营潮",
            ideaTitle: "户外手冲咖啡指南",
            channelLabel: "AI 视频",
            createdAt: "2026-07-23T08:00:00.000Z",
            previewUrl: "",
            payload: {
              projectId: project.id,
              videoModel: project.model,
              videoMode: project.mode,
              videoResolution: project.resolution,
              videoDuration: project.totalDurationSec,
              videoAspectRatio: project.aspectRatio,
              videoStatus: project.status,
              refundedCredits: project.refundedCredits,
              finalVideoUrl: project.finalVideoUrl,
              videoClips: project.clips,
              script: project.script,
            },
          }],
        });
      }
      return undefined;
    });

    const card = wrapper.find('[data-test="history-card"]');
    expect(card.text()).toContain("AI 视频");
    expect(card.text()).toContain("部分失败");
    const cardPreview = card.find('video[src*="video-projects/77/assets/clip/1"]');
    expect(cardPreview.exists()).toBe(true);
    expect(cardPreview.attributes("preload")).toBe("metadata");
    expect(cardPreview.attributes("poster")).toContain("video-projects/77/assets/poster/1");
    await card.find('[data-test="history-detail"]').trigger("click");
    await flushPromises();

    const detail = wrapper.find('[data-test="history-video-project-detail"]');
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain("累计退款 5 积分");
    // finalVideoUrl 为空时，最终成片区域展示占位，剪辑区域展开。
    expect(detail.findAll(".history-video-player")).toHaveLength(0);
    expect(detail.find(".history-video-placeholder.large").exists()).toBe(true);
    expect(detail.text()).toContain("供应商暂时不可用");
    expect(detail.text()).toContain("查看每段进度并调整提示词");
    // 单段重试按钮已移除，回到「查看脚本」弹窗统一触发。
    expect(detail.find('[data-test="history-retry-clip"]').exists()).toBe(false);
    expect(detail.find('[data-test="history-retry-result"]').exists()).toBe(false);
    expect(detail.findAll(".history-video-clip-body")).toHaveLength(2);
    // 即使失败/未生成，左侧视频区域也保留（首帧 + 进度浮层）。
    expect(detail.findAll(".history-video-clip-media")).toHaveLength(2);
    expect(detail.findAll(".history-clip-poster")).toHaveLength(1);
    expect(detail.findAll(".history-clip-placeholder")).toHaveLength(0);
    const failedClipBody = detail.findAll(".history-video-clip-body")[1];
    expect(failedClipBody.classes()).not.toContain("is-prompt-only");
    expect(failedClipBody.find(".history-video-prompt-editor").exists()).toBe(true);
    expect(failedClipBody.find(".history-clip-poster-overlay").text()).toContain("生成失败");
    expect(detail.find(".history-video-clip-media .history-clip-player").attributes("preload")).toBe("metadata");
    expect(detail.find(".history-video-clip-media .history-clip-player").attributes("poster")).toContain("video-projects/77/assets/poster/1");
    expect(detail.find(".history-video-clip-editor .history-video-prompt-editor").exists()).toBe(true);
    expect(detail.findAll('[data-test="history-clip-prompt"]')).toHaveLength(2);
    // 没成功生成视频的剪辑不显示「下载本段」按钮。
    expect(detail.findAll(".history-video-clip-actions a")).toHaveLength(1);
    // 确保没有触发单段重试请求。
    expect(calls.some((call) => call.url === "/api/video-projects/77/clips/2/retry")).toBe(false);
  });

  it("renders assembly_failed separately and retries assembly without clip billing", async () => {
    let assemblyRetried = false;
    const failedGeneration = {
      id: 78,
      type: "videoProject",
      cardTitle: "露营咖啡视频",
      brandName: "品牌A",
      brandId: 7,
      trendTitle: "五一露营潮",
      ideaTitle: "户外手冲咖啡指南",
      channelLabel: "AI 视频",
      createdAt: "2026-07-23T08:00:00.000Z",
      previewUrl: "",
      payload: {
        projectId: 78,
        videoModel: "d2",
        videoMode: "text",
        videoResolution: "720p",
        videoDuration: 10,
        videoAspectRatio: "9:16",
        videoStatus: "assembly_failed",
        refundedCredits: 0,
        finalVideoUrl: "",
        videoClips: [{ id: 7801, index: 1, durationSec: 10, status: "completed", prompt: "产品特写", creditCost: 20, error: "G2 状态查询限流，系统正在自动重试（第 1 次）", videoUrl: "/api/video-projects/78/assets/clip/1" }],
        script: GENERATIONS[2].payload?.videoScript,
      },
    };
    const completedProject = {
      id: 78,
      model: "d2",
      mode: "text",
      resolution: "720p",
      totalDurationSec: 10,
      aspectRatio: "9:16",
      status: "completed",
      refundedCredits: 0,
      finalVideoUrl: "/api/video-projects/78/assets/final",
      finalPosterUrl: "/api/video-projects/78/assets/final-poster",
      clips: failedGeneration.payload.videoClips,
      script: GENERATIONS[2].payload?.videoScript,
    };
    const { wrapper, calls } = await mountView((url, init) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, { generations: [assemblyRetried ? { ...failedGeneration, payload: { ...failedGeneration.payload, videoStatus: "completed", finalVideoUrl: completedProject.finalVideoUrl, finalPosterUrl: completedProject.finalPosterUrl } } : failedGeneration] });
      }
      if (url === "/api/video-projects/78/retry-assembly" && init?.method === "POST") {
        assemblyRetried = true;
        return jsonResponse(200, { project: completedProject });
      }
      return undefined;
    });

    const card = wrapper.find('[data-test="history-card"]');
    await card.find('[data-test="history-detail"]').trigger("click");
    await flushPromises();
    const detail = wrapper.find('[data-test="history-video-project-detail"]');
    expect(detail.find('[data-test="history-assembly-failed"]').text()).toContain("视频片段均已生成完成");
    expect(detail.find('[data-test="history-retry-assembly"]').text()).toContain("0积分");
    // 单段重试按钮已移除；只剩下载链接 + 成片重试。
    expect(detail.find('[data-test="history-retry-clip"]').exists()).toBe(false);
    expect(detail.find('[data-test="history-retry-result"]').exists()).toBe(false);
    expect(detail.findAll(".history-video-clip-body")).toHaveLength(1);
    expect(detail.text()).not.toContain("状态查询限流");
    expect(detail.findAll("video")).toHaveLength(1);
    expect(detail.find(".history-clip-player").exists()).toBe(true);

    await detail.find('[data-test="history-retry-assembly"]').trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.url === "/api/video-projects/78/retry-assembly" && call.init?.method === "POST")).toBe(true);
    expect(wrapper.find('[data-test="history-assembly-failed"]').exists()).toBe(false);
    const completedDetail = wrapper.find('[data-test="history-video-project-detail"]');
    expect(completedDetail.findAll("video")).toHaveLength(1);
    expect(completedDetail.find(".history-video-player").exists()).toBe(true);
    expect(completedDetail.find(".history-video-player").attributes("poster")).toContain("final-poster");
    expect(completedDetail.find(".history-clip-player").exists()).toBe(false);
  });

  it("renders result_processing_failed status with placeholder media and no per-clip retry buttons", async () => {
    const failedProject = {
      id: 88,
      generationId: 188,
      brandId: 7,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "result_processing_failed",
      referenceAssetIds: [],
      visualBible: {},
      estimatedCredits: 20,
      chargedCredits: 20,
      refundedCredits: 0,
      finalVideoUrl: "",
      clips: [
        {
          id: 8801,
          index: 1,
          startSec: 0,
          endSec: 10,
          durationSec: 10,
          status: "result_processing_failed",
          prompt: "",
          continuityMode: "text",
          referenceAssetIds: [],
          creditCost: 20,
          attempt: 1,
          retryCount: 0,
          error: "生成结果暂未保存成功",
        },
      ],
      script: GENERATIONS[2].payload?.videoScript,
    };
    const { wrapper } = await mountView((url) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, {
          generations: [{
            id: 88,
            type: "videoProject",
            cardTitle: "露营咖啡视频",
            brandName: "品牌A",
            brandId: 7,
            trendTitle: "五一露营潮",
            ideaTitle: "户外手冲咖啡指南",
            channelLabel: "AI 视频",
            createdAt: "2026-07-23T08:00:00.000Z",
            previewUrl: "",
            payload: {
              projectId: failedProject.id,
              videoModel: failedProject.model,
              videoMode: failedProject.mode,
              videoResolution: failedProject.resolution,
              videoDuration: failedProject.totalDurationSec,
              videoAspectRatio: failedProject.aspectRatio,
              videoStatus: failedProject.status,
              refundedCredits: failedProject.refundedCredits,
              finalVideoUrl: failedProject.finalVideoUrl,
              videoClips: failedProject.clips,
              script: failedProject.script,
            },
          }],
        });
      }
      return undefined;
    });

    const card = wrapper.find('[data-test="history-card"]');
    expect(card.text()).toContain("结果处理失败");

    await card.find('[data-test="history-detail"]').trigger("click");
    await flushPromises();

    const detail = wrapper.find('[data-test="history-video-project-detail"]');
    expect(detail.text()).toContain("结果处理失败");
    // 单段重试/重处理按钮已移除，回到「查看脚本」弹窗统一触发。
    expect(detail.find('[data-test="history-retry-result"]').exists()).toBe(false);
    expect(detail.find('[data-test="history-retry-clip"]').exists()).toBe(false);
    // 失败信息以提示条形式呈现，并保留左侧视频占位。
    expect(detail.find(".history-video-clip-error").text()).toContain("生成结果暂未保存成功");
    expect(detail.findAll(".history-video-clip-media")).toHaveLength(1);
    expect(detail.findAll(".history-clip-placeholder")).toHaveLength(1);
    expect(detail.find(".history-clip-placeholder").text()).toContain("准备中");
    // 没有生成视频，自然也没有下载链接。
    expect(detail.findAll(".history-video-clip-actions a")).toHaveLength(0);
  });


  it("sends DELETE /api/history/:id after confirm and removes the card from store", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/history/1" && init?.method === "DELETE") {
        return jsonResponse(200, { ok: true, deletedGenerationId: 1 });
      }
      return undefined;
    });

    await wrapper.findAll('[data-test="history-delete"]')[0].trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalledWith("确定删除「露营朋友圈图」吗？删除后将无法找回。");
    const deleteCall = calls.find((call) => call.url === "/api/history/1");
    expect(deleteCall?.init?.method).toBe("DELETE");
    expect(wrapper.findAll('[data-test="history-card"]')).toHaveLength(2);
  });

  it("deduplicates precursor videoScript when videoProject exists with sourceVideoScriptGenerationId", async () => {
    const generationsWithVideo = [
      ...GENERATIONS, // id 1 (moments), id 2 (xhsCarousel), id 3 (videoScript)
      {
        id: 300,
        type: "videoProject",
        channelLabel: "AI 视频",
        brandId: 7,
        trendId: 5,
        cardTitle: "由脚本生成的视频项目",
        createdAt: "2026-05-03T10:05:00.000Z",
        previewUrl: "",
        summary: "视频项目摘要",
        payload: {
          projectId: 3001,
          sourceVideoScriptGenerationId: 3, // supersedes generation id 3
          videoModel: "d2",
          videoStatus: "completed",
          videoDuration: 30,
          videoAspectRatio: "9:16",
          videoScript: GENERATIONS[2].payload?.videoScript,
        },
      },
    ];
    const { wrapper } = await mountView((url) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, { generations: generationsWithVideo });
      }
      return undefined;
    });
    const cards = wrapper.findAll('[data-test="history-card"]');
    // id 1 (moments), id 2 (xhsCarousel), id 300 (videoProject) -> total 3 cards (id 3 videoScript is omitted)
    expect(cards).toHaveLength(3);
    const cardTexts = cards.map((c) => c.text());
    expect(cardTexts.some((t) => t.includes("由脚本生成的视频项目"))).toBe(true);
    expect(cardTexts.some((t) => t.includes("AI 视频"))).toBe(true);
    // Only one card should mention the video script title
    const scriptMentionCards = cardTexts.filter((t) => t.includes("用手冲咖啡开启自然之旅") || t.includes("由脚本生成的视频项目"));
    expect(scriptMentionCards).toHaveLength(1);
  });

  it("renders '生成中' label with loading spinner animation for queued/running video project", async () => {
    const queuedProjectGeneration = {
      id: 301,
      type: "videoProject",
      channelLabel: "AI 视频",
      brandId: 7,
      trendId: 5,
      cardTitle: "正在生成的视频",
      createdAt: "2026-05-03T12:00:00.000Z",
      previewUrl: "",
      summary: "生成中摘要",
      payload: {
        projectId: 3002,
        videoModel: "g2",
        videoStatus: "queued",
        videoDuration: 30,
        videoAspectRatio: "9:16",
        videoClips: [{ id: 1, index: 1, durationSec: 10, status: "queued" }],
      },
    };
    const { wrapper } = await mountView((url) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, { generations: [queuedProjectGeneration] });
      }
      return undefined;
    });
    const statusTag = wrapper.find('[data-test="history-video-status-tag"]');
    expect(statusTag.exists()).toBe(true);
    expect(statusTag.classes()).toContain("is-generating-tag");
    expect(statusTag.text()).toContain("G2 · 生成中");
    expect(statusTag.find(".history-spinner-xs").exists()).toBe(true);
    const placeholder = wrapper.find(".history-video-placeholder");
    expect(placeholder.exists()).toBe(true);
    expect(placeholder.text()).toContain("生成中");
    expect(placeholder.find(".history-video-spinner").exists()).toBe(true);
  });

  it("filters items locally and does not trigger /api/history requests on filter input", async () => {
    const { wrapper, calls } = await mountView();
    const historyCallsBefore = calls.filter((c) => c.url.startsWith("/api/history")).length;

    await wrapper.find('[data-test="history-type"]').setValue("moments");
    await flushPromises();

    const visible = wrapper.findAll('[data-test="history-card"]');
    expect(visible).toHaveLength(1);
    expect(visible[0].text()).toContain("露营朋友圈图");

    const historyCallsAfter = calls.filter((c) => c.url.startsWith("/api/history")).length;
    expect(historyCallsAfter).toBe(historyCallsBefore);
  });

  it("filters items locally exactly like the legacy matcher", () => {
    const item = GENERATIONS[0];
    expect(matchesGenerationHistoryFilters(item, { q: "露营", brandId: "", type: "", from: "", to: "" })).toBe(true);
    expect(matchesGenerationHistoryFilters(item, { q: "护肤", brandId: "", type: "", from: "", to: "" })).toBe(false);
    expect(matchesGenerationHistoryFilters(item, { q: "", brandId: "7", type: "moments", from: "", to: "" })).toBe(true);
    expect(
      matchesGenerationHistoryFilters(item, { q: "", brandId: "", type: "", from: "2026-07-21", to: "" }),
    ).toBe(false);
    expect(normalizeHistoryDateBoundary("2026-07-21", "to")).toBe("2026-07-21T23:59:59.999Z");
    expect(normalizeHistoryDateBoundary("2026-07-21", "from")).toBe("2026-07-21T00:00:00.000Z");
  });

  it("parses signed URL expiry and detects expired asset signatures", () => {
    expect(parseAssetExpiryMs("/api/generated-images/1/file?assetExpires=1000&assetSignature=s")).toBe(1000);
    expect(parseAssetExpiryMs("/api/generated-images/1/file?sig=aaa")).toBe(0);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?assetExpires=1000&assetSignature=s", 2000)).toBe(true);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?assetExpires=9999999999999&assetSignature=s", 2000)).toBe(false);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?sig=aaa", 2000)).toBe(false);
  });

  it("refreshes history store when an expired signed image fails, then replaces the src", async () => {
    vi.useFakeTimers();
    try {
      const EXPIRED_URL = "/api/generated-images/1/file?assetExpires=1000&assetSignature=expired-sig";
      const FRESH_URL = "/api/generated-images/1/file?assetExpires=9999999999999&assetSignature=fresh-sig";
      let historyCalls = 0;
      const { wrapper } = await mountView((url) => {
        if (url.startsWith("/api/history")) {
          historyCalls += 1;
          const previewUrl = historyCalls === 1 ? EXPIRED_URL : FRESH_URL;
          return jsonResponse(200, { generations: [{ ...GENERATIONS[0], previewUrl }] });
        }
        return undefined;
      });

      expect(historyCalls).toBe(1);
      const expiredImg = wrapper.find('img[src="' + EXPIRED_URL + '"]');
      expect(expiredImg.exists()).toBe(true);

      await expiredImg.trigger("error");
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();

      expect(historyCalls).toBe(2);
      expect(wrapper.find('img[src="' + FRESH_URL + '"]').exists()).toBe(true);

      await wrapper.find('img[src="' + FRESH_URL + '"]').trigger("error");
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();
      expect(historyCalls).toBe(2);
      expect(wrapper.find('[data-test="history-image-error"]').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HistoryView detail workbench (restored legacy contract)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const DETAIL_GENERATIONS = [
    {
      id: 1,
      type: "moments",
      cardTitle: "露营朋友圈图",
      brandName: "品牌A",
      brandId: 7,
      channelLabel: "朋友圈",
      ideaTitle: "露营装备清单",
      createdAt: "2026-07-20T08:00:00.000Z",
      previewUrl: "/api/generated-images/1/file?sig=aaa",
      payload: { caption: "露营去咯", visualDirection: "清新自然", aspectRatio: "3:4", editHistory: [] },
    },
    {
      id: 2,
      type: "xhsCarousel",
      cardTitle: "护肤小红书组图",
      brandName: "品牌B",
      brandId: 8,
      channelLabel: "小红书",
      ideaTitle: "晨间流程",
      createdAt: "2026-07-21T08:00:00.000Z",
      previewUrl: "/api/generated-images/2/0/file?sig=bbb",
      payload: {
        publishTitle: "晨间护肤这样做",
        publishCaption: "收藏这套流程",
        aspectRatio: "3:4",
        slides: [
          {},
          { title: "第2页", imageUrl: "/api/generated-images/2/1/file?sig=ccc" },
          {},
          { title: "第4页", imageUrl: "/api/generated-images/2/3/file?sig=eee" },
        ],
        editHistory: [
          {
            id: "edit-1",
            imageUrl: "/api/generated-images/2/edit-1/file?sig=ddd",
            title: "改图一",
            createdAt: "2026-07-21T09:00:00.000Z",
            sourceSlideIndex: 3,
          },
          {
            id: "edit-2",
            imageUrl: "/api/generated-images/2/edit-2/file?sig=fff",
            title: "改图二",
            createdAt: "2026-07-21T10:00:00.000Z",
          },
        ],
      },
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountDetail() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", credits: 8 };
    auth.sessionLoaded = true;

    const counts = { historyCalls: 0, sessionCalls: 0 };
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      if (url.startsWith("/api/history")) {
        counts.historyCalls += 1;
        return jsonResponse(200, { generations: DETAIL_GENERATIONS });
      }
      if (url === "/api/session") {
        counts.sessionCalls += 1;
        return jsonResponse(200, { user: { id: "1", credits: 8 } });
      }
      if (method === "POST" && url === "/api/image-edits") {
        return jsonResponse(202, { jobId: "job-1", user: { id: "1", credits: 7 } });
      }
      if (method === "GET" && url === "/api/image-jobs/job-1") {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { imageUrl: "/api/generated-images/99/edit/file?sig=new", title: "改图新结果" },
          generationId: 99,
          persisted: true,
        });
      }
      throw new Error("unhandled fetch: " + method + " " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, counts };
  }

  it("keeps the original-image edit form permanently visible with asset info and a two-column layout", async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[0].trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("收起改图");
    expect(wrapper.find('button[data-test="history-edit-open"]').exists()).toBe(false);

    const header = wrapper.find('[data-test="history-asset-header"]');
    expect(header.exists()).toBe(true);
    expect(header.text()).toContain("露营装备清单");
    expect(header.text()).toContain("朋友圈文案：");
    expect(header.text()).toContain("露营去咯");
    expect(header.text()).toContain("视觉方向：");
    expect(header.text()).toContain("清新自然");

    const grid = wrapper.find('[data-test="history-detail-grid"]');
    expect(grid.exists()).toBe(true);
    const preview = wrapper.find('[data-test="history-detail-preview"] img');
    expect(preview.attributes("src")).toBe("/api/generated-images/1/file?sig=aaa");
    const form = wrapper.find('[data-test="history-edit-open"]');
    expect(form.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(Array.from(grid.element.children)).toHaveLength(2);
  });

  it("renders only real carousel pages as tabs and edits with the original sourceIndex", async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="history-slide-tab-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-slide-tab-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-slide-tab-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="history-slide-tab-2"]').exists()).toBe(false);

    await wrapper.find('[data-test="history-slide-tab-3"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="history-detail-preview"] img').attributes("src")).toBe(
      "/api/generated-images/2/3/file?sig=eee",
    );
    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(true);

    await wrapper.find('[data-test="image-edit-prompt"]').setValue("改第四页构图");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(2);
    expect(body.slideIndex).toBe(3);
    expect(body.imageUrl).toBe("/api/generated-images/2/3/file?sig=eee");
  });

  it("shows an inline edit panel per history record that submits generationId/parentEditId/slideIndex", async () => {
    const { wrapper, counts } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    const record = wrapper.find('[data-test="history-edit-history-item-edit-1"]');
    expect(record.exists()).toBe(true);
    expect(record.text()).toContain("改图一");
    expect(record.find('[data-test="history-edit-history-time"]').text()).not.toBe("");

    await record.trigger("click");
    await flushPromises();
    expect(record.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-edit-open"] [data-test="image-edit-panel"]').exists()).toBe(false);

    await record.find('[data-test="image-edit-prompt"]').setValue("再改一版");
    await record.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      generationId: 2,
      parentEditId: "edit-1",
      slideIndex: 3,
      imageUrl: "/api/generated-images/2/edit-1/file?sig=ddd",
    });

    expect(counts.sessionCalls).toBeGreaterThanOrEqual(1);
    expect(counts.historyCalls).toBeGreaterThanOrEqual(2);
  });
});
