import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { clearIdeaCreativeSettings } from "../ideaCreativeSettings";
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
  totalDurationSec: 30,
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
      endSec: 5,
      durationSec: 5,
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
    {
      index: 2,
      startSec: 5,
      endSec: 12,
      durationSec: 7,
      purpose: "产品萃取亮点",
      referenceAssets: [],
      subjectReference: "手冲壶与咖啡滤杯",
      firstFrame: "细水流在咖啡粉表面画圈",
      lastFrame: "金黄色咖啡油脂膨胀",
      scene: "咖啡制作吧台",
      subjectAction: "平稳注水，咖啡粉膨胀起泡",
      cameraMovement: "俯视45度慢速环绕",
      environmentMotion: "热气微弱升腾与咖啡滴落",
      lightingAndStyle: "暖调光泽感",
      audioPrompt: "水流注水声与滴滤声",
      voiceover: "让香气在冰块上慢慢释放",
      dialogue: "",
      onScreenText: "",
      transition: "快速横摇",
      continuity: "水流动作连贯",
      prompt: "Macro shot of hot water pouring over ground coffee bloom, golden crema bubbling, slow rotation camera, professional studio lighting, 8k resolution.",
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
  return {
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
          user: { id: "1", credits: 4 },
        });
      }
      return undefined;
    },
  };
}

describe("video script generation flow", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders exact button text 一键生成脚本 with 1 credit cost", async () => {
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
    expect(scriptButton.text()).toContain("一键生成脚本");
    expect(scriptButton.text()).toContain("1 积分");
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

    // 验证弹窗打开
    const dialog = wrapper.find('[data-test="idea-video-script-dialog"]');
    expect(dialog.exists()).toBe(true);

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
    expect(result.text()).toContain("30 秒");
    expect(result.text()).toContain("2 个片段");
    expect(result.text()).toContain("这里只生成供 AI 视频模型使用的分镜与提示词，不会直接生成视频。");

    // 验证分镜列表
    const clipRows = result.findAll('[data-test^="video-clip-row-"]');
    expect(clipRows).toHaveLength(2);
    expect(clipRows[0].text()).toContain("开场抓人");
    expect(clipRows[0].text()).toContain("00:00 - 00:05 (5s)");

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
});
