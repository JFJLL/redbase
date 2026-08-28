import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import {
  clearIdeaCreativeSettings,
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
} from "../ideaCreativeSettings";
import {
  installFlowFetch,
  makeIdeasRouter,
  jsonResponse,
  postCalls,
  type IdeasFlowOptions,
} from "./ideasGenerationHarness";
import type { VideoScript } from "../api";

const FIXTURE_SCRIPT: VideoScript = {
  title: "夏日清凉特调手冲咖啡",
  creativeConcept: "以冰手冲为视觉中心，展现夏日消暑与咖啡香气的碰撞",
  totalDurationSec: 10,
  aspectRatio: "9:16",
  globalSubjectReference: "手冲器具与透明玻璃杯中的冰块咖啡",
  globalStyleReference: "清爽明亮的夏日自然采光",
  globalContinuity: "动作流畅推进，光影统一",
  audioDirection: {
    music: "轻快Lo-Fi爵士节奏",
    ambience: "冰块碰撞声与咖啡滴落声",
    voiceStyle: "治愈温柔的日常独白",
  },
  clips: [
    {
      index: 1,
      startSec: 0,
      endSec: 10,
      durationSec: 10,
      purpose: "开场抓人",
      referenceAssets: [],
      subjectReference: "晶莹剔透的老冰块",
      firstFrame: "冰块落入透明玻璃杯中的慢动作特写",
      lastFrame: "杯壁泛起细密水汽",
      scene: "阳光洒进原木风厨房",
      subjectAction: "冰块旋转，水滴滑落",
      cameraMovement: "低角度平滑微距推近",
      environmentMotion: "晨光在水汽间折射",
      lightingAndStyle: "自然晨光侧逆光",
      audioPrompt: "清脆冰块撞击声",
      voiceover: "夏天最动听的声音",
      dialogue: "",
      onScreenText: "夏日第一杯冰手冲",
      transition: "匹配剪辑至咖啡滴落",
      continuity: "光影方向一致",
      prompt: "Cinematic close-up shot of ice cube dropping into crystal glass, condensation on glass, morning sunlight, 4k photorealistic, 60fps.",
    },
  ],
};

const BRAND_DETAIL = {
  brand: makeBrandDetail(
    [
      makeTrend(5, {
        title: "夏日咖啡趋势",
        ideas: [
          makeIdea({
            title: "夏日清凉特调手冲咖啡",
            summary: "从冰手冲场景切入，讲解夏日风味搭配",
            angle: "消暑清爽手冲",
            brandFit: "结合品牌浅烘豆单",
            audience: "咖啡爱好者",
            hook: "夏天最动听的声音",
            tags: ["夏日咖啡", "手冲指南"],
          }),
        ],
      }),
    ],
    { id: 1, name: "红磨坊咖啡" },
  ),
};

const PRODUCT_IMAGES = {
  images: [
    { id: 11, originalName: "埃塞豆包装.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
  ],
};

function baseOptions(): IdeasFlowOptions {
  const options: IdeasFlowOptions = {
    brandId: 1,
    brandDetail: BRAND_DETAIL,
    productImages: PRODUCT_IMAGES,
    overrides: (url, init) => {
      const path = String(url).split("?")[0];
      const method = String(init?.method || "GET");
      if (method === "POST" && path.endsWith("/video-script")) {
        return jsonResponse(200, {
          videoScript: FIXTURE_SCRIPT,
          generation: {
            id: 88,
            type: "videoScript",
            cardTitle: "夏日清凉特调手冲咖啡",
            channelLabel: "视频脚本",
            createdAt: "2026-08-24T12:00:00.000Z",
            previewUrl: "",
            payload: { videoScript: FIXTURE_SCRIPT },
          },
          user: { id: "1", credits: options.videoScriptUserCredits ?? 4 },
        });
      }
      return undefined;
    },
  };
  return options;
}

async function openVideoDialog(options: IdeasFlowOptions = baseOptions()) {
  const fetchMock = installFlowFetch(options);
  vi.stubGlobal("fetch", fetchMock);
  const router = makeIdeasRouter();
  await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", credits: 5 };
  auth.sessionLoaded = true;
  const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  await flushPromises();
  await wrapper.find('[data-test="idea-generate-script-0"]').trigger("click");
  await flushPromises();
  await flushPromises();
  return { wrapper, fetchMock, auth };
}

describe("video script generation flow", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not auto-charge on open and renders the explicit 1-credit script action", async () => {
    const fetchMock = installFlowFetch(baseOptions());
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 5 };
    auth.sessionLoaded = true;

    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    const scriptButton = wrapper.find('[data-test="idea-generate-script-0"]');
    expect(scriptButton.exists()).toBe(true);
    await scriptButton.trigger("click");
    await flushPromises();
    await flushPromises();

    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.find('[data-test="video-script-preparation"]').exists()).toBe(true);
    expect(dialog.text()).toContain("AI 视频创作");
    expect(dialog.text()).toContain("生成脚本并进入下一步 · 1积分");
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(0);
  });

  it("defaults to the promoted G2 custom dropdown and guides users through all three steps", async () => {
    const { wrapper, fetchMock } = await openVideoDialog();
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    const modelSelect = dialog.find('[data-test="video-model-select"]');

    expect((modelSelect.element as HTMLSelectElement).value).toBe("g2");
    expect(dialog.findAll(".studio-select-trigger")).toHaveLength(5);
    expect(dialog.find('[data-test="video-studio-stepper"]').text()).toContain("选择模型与参数");
    expect(dialog.find('[data-test="video-step-1"]').attributes("aria-current")).toBe("step");
    expect(dialog.text()).not.toContain("预计 2 积分");

    await dialog.find('[data-test="video-model-select-trigger"]').trigger("click");
    const g2Option = dialog.find('[data-test="video-model-select-option-g2"]');
    expect(g2Option.text()).toContain("G2");
    expect(g2Option.text()).toContain("限时特惠");
    expect(dialog.find('[data-test="video-model-select-option-d2"]').exists()).toBe(true);
    expect(dialog.find(".studio-select-arrow").exists()).toBe(true);

    await dialog.find('[data-test="video-duration-select"]').setValue("10");
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const request = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")[0];
    expect(request.model).toBe("g2");
    expect(request.videoDuration).toBe("10");
    expect(dialog.find('[data-test="video-step-2"]').attributes("aria-current")).toBe("step");
    expect(dialog.find('[data-test="video-step-script-panel"]').exists()).toBe(true);

    await dialog.find('[data-test="video-step-next"]').trigger("click");
    expect(dialog.find('[data-test="video-step-production-panel"]').exists()).toBe(true);
    await dialog.find('[data-test="video-step-previous"]').trigger("click");
    expect(dialog.find('[data-test="video-step-script-panel"]').exists()).toBe(true);
  });

  it("generates structured video script and renders results without model or platform options", async () => {
    const fetchMock = installFlowFetch(baseOptions());
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 5 };
    auth.sessionLoaded = true;

    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    // 点击生成脚本
    await wrapper.find('[data-test="idea-generate-script-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    // 验证弹窗打开，但打开本身不产生付费脚本请求
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(0);

    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    // 验证没有模型或平台选择器（不可修改产品决策）
    expect(dialog.text()).not.toContain("可灵");
    expect(dialog.text()).not.toContain("海螺");
    expect(dialog.text()).not.toContain("Runway");
    expect(dialog.text()).not.toContain("抖音");
    expect(dialog.text()).not.toContain("快手");

    // 验证后端请求参数
    const scriptCalls = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script");
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0].requestId).toBeTruthy();
    expect(scriptCalls[0].aspectRatioSelection).toBe("smart");

    // 验证生成结果渲染
    const result = dialog.find('[data-test="video-script-result"]');
    expect(result.exists()).toBe(true);
    expect(result.find('[data-test="video-script-title"]').text()).toBe("夏日清凉特调手冲咖啡");
    expect(result.text()).toContain("10 秒");
    expect(result.text()).toContain("1 个片段");
    expect(result.text()).toContain("这里只生成供 AI 视频模型使用的分镜与提示词，不会直接生成视频。");

    // 验证分镜列表
    const clipRows = result.findAll('[data-test^="video-clip-row-"]');
    expect(clipRows).toHaveLength(1);
    expect(clipRows[0].text()).toContain("开场抓人");
    expect(clipRows[0].text()).toContain("00:00 - 00:10 (10s)");

    // 展开分镜详情
    await clipRows[0].find('[data-test="toggle-clip-expand-0"]').trigger("click");
    await flushPromises();
    const clipDetails = result.find('[data-test="clip-details-0"]');
    expect(clipDetails.exists()).toBe(true);
    expect(clipDetails.text()).toContain("首帧描述");
    expect(clipDetails.text()).toContain("冰块落入透明玻璃杯中的慢动作特写");
    expect(clipDetails.find('[data-test="clip-prompt-text-0"]').text()).toContain(
      "Cinematic close-up shot of ice cube dropping",
    );

    // 验证积分扣除同步
    expect(auth.user?.credits).toBe(4);
  });

  it("derives model controls from the public capability response", async () => {
    const options = baseOptions();
    const originalOverride = options.overrides;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      if (String(init?.method || "GET") === "GET" && path === "/api/video-models/capabilities") {
        return jsonResponse(200, {
          models: [{
            id: "studio-x",
            displayName: "Studio X",
            provider: "test-provider",
            supportedModes: ["text"],
            resolutions: ["1080p"],
            aspectRatios: ["16:9"],
            totalDurationOptions: [10],
            clipDurationRules: { min: 4, max: 10 },
            preferredClipDurations: [10],
            maxReferenceImages: 3,
            pricing: { "1080p": 7 },
            pricingUnit: "per_second",
          }],
        });
      }
      return originalOverride?.(url, init);
    };

    const fetchMock = installFlowFetch(options);
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 5 };
    auth.sessionLoaded = true;

    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    await wrapper.find('[data-test="idea-generate-script-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="idea-video-script-dialog"] [data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect((dialog.find('[data-test="video-model-select"]').element as HTMLSelectElement).value).toBe("studio-x");
    expect(dialog.find('[data-test="video-model-select"] option[value="d2"]').exists()).toBe(false);
    expect((dialog.find('[data-test="video-resolution-select"]').element as HTMLSelectElement).value).toBe("1080p");
    expect(dialog.find('[data-test="video-mode-select"] option').exists()).toBe(true);
    expect(dialog.find('[data-test="video-mode-select"] option[value="image"]').exists()).toBe(false);

    const scriptCalls = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script");
    expect(scriptCalls[0].model).toBe("studio-x");
    expect(scriptCalls[0].resolution).toBe("1080p");
  });

  it("blocks image-to-video script generation until an independent reference is selected", async () => {
    const key = getIdeaSettingsKey(1, 5, 0);
    saveIdeaCreativeSettings(key, {
      ...getIdeaCreativeSettings(key),
      videoMode: "image",
      videoReferenceImageIds: [],
    });

    const fetchMock = installFlowFetch(baseOptions());
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 5 };
    auth.sessionLoaded = true;

    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    await wrapper.find('[data-test="idea-generate-script-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    const prepareButton = dialog.find('[data-test="video-script-generate-after-reference"]');
    expect(prepareButton.exists()).toBe(true);
    expect((prepareButton.element as HTMLButtonElement).disabled).toBe(true);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(0);
    expect(dialog.text()).toContain("这里只影响本次视频创作，不会修改当前图片生成设置");
  });

  it("restores the filtered active project without generating another script or project", async () => {
    const activeProject = {
      id: 701,
      generationId: 702,
      scriptGenerationId: 703,
      brandId: 1,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "image",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "running",
      referenceAssetIds: [11],
      visualBible: {},
      script: { ...FIXTURE_SCRIPT, totalDurationSec: 10 },
      estimatedCredits: 20,
      chargedCredits: 20,
      refundedCredits: 0,
      clips: [{ id: 704, index: 1, startSec: 0, endSec: 10, durationSec: 10, status: "running", prompt: "", continuityMode: "image", referenceAssetIds: [11], creditCost: 20, attempt: 1, retryCount: 0 }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    const options = baseOptions();
    const originalOverride = options.overrides;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      const method = String(init?.method || "GET");
      if (method === "GET" && path === "/api/video-projects/active") return jsonResponse(200, { projects: [activeProject] });
      if (method === "GET" && path === "/api/video-projects/701") return jsonResponse(200, { project: activeProject });
      return originalOverride?.(url, init);
    };

    const { wrapper, fetchMock } = await openVideoDialog(options);
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.find('[data-test="video-project-status"]').exists()).toBe(true);
    expect(dialog.text()).toContain("生成中");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/video-projects/active?brandId=1&trendId=5&ideaIndex=0"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/video-projects/701"))).toBe(true);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(0);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-project")).toHaveLength(0);
    expect((dialog.find('[data-test="video-mode-select"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((dialog.find('[data-test="video-duration-select"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((dialog.find('[data-test="video-aspect-select"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((dialog.find('[data-test="video-resolution-select"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((dialog.find('[data-test="video-model-select"]').element as HTMLSelectElement).disabled).toBe(true);
    expect((dialog.find('[data-test="video-reference-picker"] input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true);
    expect(dialog.find('[data-test="video-script-regenerate"]').exists()).toBe(false);
    expect(dialog.find('[data-test="video-project-controls-locked"]').text()).toContain("参数已锁定");
  });

  it("clears the image reference error when switching to text mode", async () => {
    const key = getIdeaSettingsKey(1, 5, 0);
    saveIdeaCreativeSettings(key, {
      ...getIdeaCreativeSettings(key),
      videoMode: "image",
      videoReferenceImageIds: [],
    });
    const { wrapper } = await openVideoDialog();
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.find('[data-test="video-script-reference-required"]').exists()).toBe(true);
    await dialog.find('[data-test="video-mode-select"]').setValue("text");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-reference-required"]').exists()).toBe(false);
    expect(dialog.find('[data-test="video-script-preparation"]').exists()).toBe(true);
  });

  it("sends no product or video references in text mode and restores image references after switching back", async () => {
    const key = getIdeaSettingsKey(1, 5, 0);
    saveIdeaCreativeSettings(key, {
      ...getIdeaCreativeSettings(key),
      videoMode: "image",
      videoReferenceImageIds: [11],
    });
    const { wrapper, fetchMock } = await openVideoDialog();
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    await dialog.find('[data-test="video-mode-select"]').setValue("text");
    await flushPromises();
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const scriptCall = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")[0];
    expect(scriptCall.mode).toBe("text");
    expect(scriptCall.videoReferenceImageIds).toEqual([]);
    expect(scriptCall.productImages).toEqual([]);
    expect(scriptCall.useProductImages).toBe(false);

    await dialog.find('[data-test="video-mode-select"]').setValue("image");
    await flushPromises();
    const referenceCheckbox = dialog.find('[data-test="video-reference-picker"] input[type="checkbox"]');
    expect((referenceCheckbox.element as HTMLInputElement).checked).toBe(true);
  });

  it("uses a fresh request id after a refunded script failure so retry can charge once", async () => {
    const options = baseOptions();
    const originalOverride = options.overrides;
    let scriptAttempt = 0;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      const method = String(init?.method || "GET");
      if (method === "POST" && path.endsWith("/video-script") && scriptAttempt++ === 0) {
        return jsonResponse(400, {
          error: "视频脚本生成失败：模型服务异常，已退还积分。",
          code: "VIDEO_SCRIPT_REQUEST_TERMINAL",
        });
      }
      return originalOverride?.(url, init);
    };

    const { wrapper, fetchMock } = await openVideoDialog(options);
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(dialog.find('[data-test="video-script-retry"]').exists()).toBe(true);
    const firstRequestId = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")[0].requestId;

    await dialog.find('[data-test="video-script-retry"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const scriptCalls = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script");
    expect(scriptCalls).toHaveLength(2);
    expect(scriptCalls[1].requestId).toBeTruthy();
    expect(scriptCalls[1].requestId).not.toBe(firstRequestId);
    expect(dialog.find('[data-test="video-script-result"]').exists()).toBe(true);
  });

  it("does not mark the script stale when only resolution changes, and shows the real price", async () => {
    const { wrapper, fetchMock } = await openVideoDialog();
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    await dialog.find('[data-test="video-step-next"]').trigger("click");
    await flushPromises();
    const realVideoButton = dialog.find('[data-test="generate-real-video"]');
    expect(realVideoButton.text()).toMatch(/生成真实视频 · \d+积分/);
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(false);
    await dialog.find('[data-test="video-resolution-select"]').setValue("1080p");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(false);
    expect((realVideoButton.element as HTMLButtonElement).disabled).toBe(false);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(1);
  });

  it("keeps the global balance in sync after project charge, refund, and paid retry", async () => {
    vi.useFakeTimers();
    let sessionCredits = 100;
    let projectPollCount = 0;
    const queuedProject = {
      id: 900,
      generationId: 901,
      scriptGenerationId: 88,
      brandId: 1,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "queued",
      referenceAssetIds: [],
      visualBible: {},
      script: { ...FIXTURE_SCRIPT, totalDurationSec: 10, clips: [{ ...FIXTURE_SCRIPT.clips[0], endSec: 10, durationSec: 10 }] },
      estimatedCredits: 20,
      chargedCredits: 20,
      refundedCredits: 0,
      clips: [{ id: 902, index: 1, startSec: 0, endSec: 10, durationSec: 10, status: "queued", prompt: "", continuityMode: "text", referenceAssetIds: [], creditCost: 20, attempt: 0, retryCount: 0 }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    const refundedProject = {
      ...queuedProject,
      status: "partial_failed",
      refundedCredits: 20,
      clips: [{ ...queuedProject.clips[0], status: "failed", error: "provider failed" }],
    };
    const completedProject = {
      ...refundedProject,
      status: "completed",
      clips: [{ ...refundedProject.clips[0], status: "completed", error: "" }],
      finalVideoUrl: "/api/video-projects/900/assets/final",
    };
    const options = baseOptions();
    options.videoScriptUserCredits = 100;
    const originalOverride = options.overrides;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      const method = String(init?.method || "GET");
      if (method === "GET" && path === "/api/session") return jsonResponse(200, { user: { id: "1", credits: sessionCredits } });
      if (method === "GET" && path === "/api/video-projects/active") return jsonResponse(200, { projects: [] });
      if (method === "POST" && path === "/api/brands/1/trends/5/ideas/0/video-project") {
        return jsonResponse(200, { project: queuedProject, user: { id: "1", credits: 80 } });
      }
      if (method === "GET" && path === "/api/video-projects/900") {
        projectPollCount += 1;
        return jsonResponse(200, { project: projectPollCount === 1 ? queuedProject : projectPollCount === 2 ? refundedProject : completedProject });
      }
      if (method === "POST" && path === "/api/video-projects/900/clips/1/retry") {
        return jsonResponse(200, { project: { ...refundedProject, status: "queued", clips: [{ ...refundedProject.clips[0], status: "queued", error: "" }] }, user: { id: "1", credits: 80 } });
      }
      return originalOverride?.(url, init);
    };

    const { wrapper, auth } = await openVideoDialog(options);
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(auth.user?.credits).toBe(100);

    await dialog.find('[data-test="video-step-next"]').trigger("click");
    await flushPromises();
    await dialog.find('[data-test="generate-real-video"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(auth.user?.credits).toBe(80);

    await vi.advanceTimersByTimeAsync(2500);
    await flushPromises();
    expect(auth.user?.credits).toBe(100);
    expect(dialog.find('.clip-retry-btn').exists()).toBe(true);

    await dialog.find('.clip-retry-btn').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(auth.user?.credits).toBe(80);
  });

  it("marks model, mode, duration, ratio, and reference changes as script-stale", async () => {
    const { wrapper } = await openVideoDialog();
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    await dialog.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();
    await flushPromises();

    await dialog.find('[data-test="video-model-select"]').setValue("d2");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(true);

    await dialog.find('[data-test="video-mode-select"]').setValue("image");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(true);
    await dialog.find('[data-test="video-duration-select"]').setValue("10");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(true);
    await dialog.find('[data-test="video-aspect-select"]').setValue("16:9");
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(true);
    const reference = dialog.find('.video-reference-option input');
    expect(reference.exists()).toBe(true);
    await reference.setValue(true);
    await flushPromises();
    expect(dialog.find('[data-test="video-script-settings-stale"]').exists()).toBe(true);
  });

  it("shows assembly_failed as a free assembly action and never offers retry for completed clips", async () => {
    const failedProject = {
      id: 801,
      generationId: 802,
      scriptGenerationId: 803,
      brandId: 1,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "assembly_failed",
      referenceAssetIds: [],
      visualBible: {},
      script: { ...FIXTURE_SCRIPT, totalDurationSec: 10 },
      estimatedCredits: 20,
      chargedCredits: 20,
      refundedCredits: 0,
      clips: [{ id: 804, index: 1, startSec: 0, endSec: 10, durationSec: 10, status: "completed", prompt: "", continuityMode: "text", referenceAssetIds: [], creditCost: 20, attempt: 1, retryCount: 0 }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    const options = baseOptions();
    const originalOverride = options.overrides;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      if (String(init?.method || "GET") === "GET" && path === "/api/video-projects/active") return jsonResponse(200, { projects: [failedProject] });
      return originalOverride?.(url, init);
    };
    const { wrapper } = await openVideoDialog(options);
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.find('[data-test="assembly-failed"]').text()).toContain("视频片段均已生成完成");
    expect(dialog.find('[data-test="retry-assembly"]').text()).toContain("0积分");
    expect(dialog.find('.clip-retry-btn').exists()).toBe(false);
  });

  it("renders processing_result and result_processing_failed states and provides 0-credit retry-result", async () => {
    vi.useFakeTimers();
    let retryResultCalled = false;
    let pollCount = 0;

    const resultProcessingProject = {
      id: 950,
      generationId: 951,
      scriptGenerationId: 88,
      brandId: 1,
      trendId: 5,
      ideaIndex: 0,
      model: "d2",
      mode: "text",
      resolution: "720p",
      aspectRatio: "9:16",
      totalDurationSec: 10,
      status: "running",
      referenceAssetIds: [],
      visualBible: {},
      script: { ...FIXTURE_SCRIPT, totalDurationSec: 10, clips: [{ ...FIXTURE_SCRIPT.clips[0], endSec: 10, durationSec: 10 }] },
      estimatedCredits: 20,
      chargedCredits: 20,
      refundedCredits: 0,
      clips: [{
        id: 952,
        index: 1,
        startSec: 0,
        endSec: 10,
        durationSec: 10,
        status: "processing_result",
        prompt: "",
        continuityMode: "text",
        referenceAssetIds: [],
        creditCost: 20,
        attempt: 1,
        retryCount: 0,
        resultProcessingFailureCount: 1,
      }],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };

    const resultFailedProject = {
      ...resultProcessingProject,
      status: "result_processing_failed",
      clips: [{
        ...resultProcessingProject.clips[0],
        status: "result_processing_failed",
        error: "视频模型已生成完成，但生成结果暂未保存成功。",
      }],
    };

    const completedProject = {
      ...resultProcessingProject,
      status: "completed",
      clips: [{
        ...resultProcessingProject.clips[0],
        status: "completed",
        videoUrl: "/api/video-projects/950/assets/clip/1",
      }],
      finalVideoUrl: "/api/video-projects/950/assets/final",
    };

    const options = baseOptions();
    options.videoScriptUserCredits = 80;
    const originalOverride = options.overrides;
    options.overrides = (url, init) => {
      const path = String(url).split("?")[0];
      const method = String(init?.method || "GET");
      if (method === "GET" && path === "/api/video-projects/active") {
        return jsonResponse(200, { projects: [resultFailedProject] });
      }
      if (method === "GET" && path === "/api/video-projects/950") {
        pollCount += 1;
        return jsonResponse(200, { project: retryResultCalled ? completedProject : resultFailedProject });
      }
      if (method === "POST" && path === "/api/video-projects/950/clips/1/retry-result") {
        retryResultCalled = true;
        return jsonResponse(200, { project: completedProject, user: { id: "1", credits: 80 } });
      }
      return originalOverride?.(url, init);
    };

    const { wrapper, auth, fetchMock } = await openVideoDialog(options);
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');

    // 1. Reopening dialog restores active result_processing_failed project without charging
    expect(dialog.find('[data-test="video-project-status"]').exists()).toBe(true);
    expect(dialog.text()).toContain("生成结果暂未保存成功");
    expect(auth.user?.credits).toBe(5); // initial mock auth credits preserved
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-script")).toHaveLength(0);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/video-project")).toHaveLength(0);

    // 2. Button shows 重新处理结果 · 0积分, no paid retry button
    const retryResultBtn = dialog.find('[data-test="retry-result-btn"]');
    expect(retryResultBtn.exists()).toBe(true);
    expect(retryResultBtn.text()).toBe("重新处理结果 · 0积分");
    expect(dialog.find('[data-test="clip-retry-btn"]').exists()).toBe(false);

    // 3. Click retry-result -> 0 credits deducted
    await retryResultBtn.trigger("click");
    await flushPromises();
    await flushPromises();

    const retryCalls = postCalls(fetchMock, "/api/video-projects/950/clips/1/retry-result");
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0].requestId).toBeTruthy();
    expect(dialog.text()).toContain("已完成");
  });

});
