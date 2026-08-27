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
    trendTitle: "五一露营潮",
    ideaTitle: "户外手冲咖啡指南",
    channelLabel: "视频脚本",
    createdAt: "2026-07-22T08:00:00.000Z",
    previewUrl: "",
    payload: {
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
    return { wrapper, calls };
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

  it("renders videoScript history cards without images and opens video script modal", async () => {
    const { wrapper } = await mountView();
    const scriptCard = wrapper.findAll('[data-test="history-card"]')[2];

    expect(scriptCard.text()).toContain("视频脚本");
    expect(scriptCard.text()).toContain("30 秒");
    expect(scriptCard.text()).toContain("1 个片段");
    expect(scriptCard.text()).toContain("用手冲咖啡开启自然之旅");

    const detailBtn = scriptCard.find('[data-test="history-detail"]');
    expect(detailBtn.text()).toBe("查看脚本");
    await detailBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="video-script-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="video-script-title"]').text()).toBe("露营咖啡视频脚本");
    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(false);
  });

  it("renders video project clip playback, download, failure refund, and retry controls", async () => {
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
        { id: 7701, index: 1, startSec: 0, endSec: 10, durationSec: 10, status: "completed", prompt: "", continuityMode: "text", referenceAssetIds: [], creditCost: 20, attempt: 1, retryCount: 0, videoUrl: "/api/video-projects/77/assets/clip/1?assetExpires=9999999999999&assetSignature=clip-one", error: "" },
        { id: 7702, index: 2, startSec: 10, endSec: 15, durationSec: 5, status: "failed", prompt: "", continuityMode: "image", referenceAssetIds: [], creditCost: 10, attempt: 1, retryCount: 0, error: "供应商暂时不可用" },
      ],
      script: GENERATIONS[2].payload?.videoScript,
    };
    const retryResponse = {
      ...project,
      status: "queued",
      clips: project.clips.map((clip) => clip.index === 2 ? { ...clip, status: "queued", error: "" } : clip),
    };
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/video-projects/77/clips/2/retry" && init?.method === "POST") {
        return jsonResponse(200, { project: retryResponse });
      }
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
    expect(card.find('img[src*="video-projects/77/assets/clip/1"]').exists()).toBe(true);
    await card.find('[data-test="history-detail"]').trigger("click");
    await flushPromises();

    const detail = wrapper.find('[data-test="history-video-project-detail"]');
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain("累计退款 5 积分");
    expect(detail.findAll("video")).toHaveLength(1);
    expect(detail.text()).toContain("供应商暂时不可用");
    await detail.find('.history-video-clip-actions button').trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.url === "/api/video-projects/77/clips/2/retry")).toBe(true);
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
        videoClips: [{ id: 7801, index: 1, durationSec: 10, status: "completed", videoUrl: "/api/video-projects/78/assets/clip/1" }],
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
      clips: failedGeneration.payload.videoClips,
      script: GENERATIONS[2].payload?.videoScript,
    };
    const { wrapper, calls } = await mountView((url, init) => {
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, { generations: [assemblyRetried ? { ...failedGeneration, payload: { ...failedGeneration.payload, videoStatus: "completed", finalVideoUrl: completedProject.finalVideoUrl } } : failedGeneration] });
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
    expect(detail.find('.history-video-clip-actions button').exists()).toBe(false);

    await detail.find('[data-test="history-retry-assembly"]').trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.url === "/api/video-projects/78/retry-assembly" && call.init?.method === "POST")).toBe(true);
    expect(wrapper.find('[data-test="history-assembly-failed"]').exists()).toBe(false);
  });

  it("renders result_processing_failed status and handles 0-credit retry-result action", async () => {
    let retryResultCalled = false;
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
    const completedProject = {
      ...failedProject,
      status: "completed",
      clips: [{ ...failedProject.clips[0], status: "completed", videoUrl: "/api/video-projects/88/assets/clip/1" }],
      finalVideoUrl: "/api/video-projects/88/assets/final",
    };

    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/video-projects/88/clips/1/retry-result" && init?.method === "POST") {
        retryResultCalled = true;
        return jsonResponse(200, { project: completedProject, user: { id: "1", credits: 8 } });
      }
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
              videoStatus: retryResultCalled ? "completed" : failedProject.status,
              refundedCredits: failedProject.refundedCredits,
              finalVideoUrl: retryResultCalled ? completedProject.finalVideoUrl : "",
              videoClips: retryResultCalled ? completedProject.clips : failedProject.clips,
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
    const retryResultBtn = detail.find('[data-test="history-retry-result"]');
    expect(retryResultBtn.exists()).toBe(true);
    expect(retryResultBtn.text()).toContain("重新处理结果 · 0积分");
    expect(detail.find('[data-test="history-retry-clip"]').exists()).toBe(false);

    await retryResultBtn.trigger("click");
    await flushPromises();

    expect(calls.some((call) => call.url === "/api/video-projects/88/clips/1/retry-result")).toBe(true);
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
