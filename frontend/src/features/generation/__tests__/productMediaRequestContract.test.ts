/**
 * 发布前产品素材请求契约测试（真实入口：IdeasView + IdeaGenerationDialog）。
 *
 * 目标：
 * 1. 小红书组图 preview 只准备方案、complete 只归档，二者不携带 productImages；
 *    每个真实 slides/:index POST 必须携带内容选题外层选择的产品图 {id,name}。
 * 2. useProductImages=false 时，每个 slide POST 的 productImages 均为 []。
 * 3. 图库加载失败且开关开启时，0 preview、0 slide、0 扣费，action 票据保留。
 * 4. 风格化图只携带独立 styleReferenceImages，普通产品图不会被意外混入。
 * 仅 mock 全局 fetch，不 mock 业务模块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import { clearIdeaCreativeSettings, getIdeaSettingsKey, saveIdeaCreativeSettings } from "../ideaCreativeSettings";
import {
  installFlowFetch,
  makeIdeasRouter,
  jsonResponse,
  postCalls,
  postUrls,
  type IdeasFlowOptions,
} from "./ideasGenerationHarness";

const BRAND_DETAIL = {
  brand: makeBrandDetail(
    [
      makeTrend(5, {
        title: "夏日趋势",
        ideas: [
          makeIdea({
            title: "选题一",
            summary: "内容摘要",
            angle: "切入角度",
            brandFit: "结合方式",
            audience: "人群",
            hook: "钩子",
            tags: [],
          }),
        ],
      }),
    ],
    { id: 1, name: "测试品牌" },
  ),
};

const PRODUCT_IMAGES = {
  images: [
    { id: 11, originalName: "product-a.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
    { id: 12, originalName: "product-b.png", url: "/api/product-images/12/file?sig=b", sizeBytes: 1024 },
  ],
};

function baseOptions(overrides: IdeasFlowOptions["overrides"] = () => undefined): IdeasFlowOptions {
  return { brandId: 1, brandDetail: BRAND_DETAIL, productImages: PRODUCT_IMAGES, overrides };
}

function saveIdea0Settings(settings: { useProductImages: boolean; selectedProductIds: number[] }): void {
  saveIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0), {
    aspectRatioSelection: "smart",
    visualStylePreset: "auto",
    wechatTemplate: "auto",
    useBrandLogo: false,
    selectedProductIds: settings.selectedProductIds,
    useProductImages: settings.useProductImages,
    styleReference: null,
  });
}

async function mountIdeas(
  fetchMock: ReturnType<typeof installFlowFetch>,
  query: Record<string, string>,
): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: ReturnType<typeof makeIdeasRouter>;
  fetchMock: ReturnType<typeof installFlowFetch>;
}> {
  vi.stubGlobal("fetch", fetchMock);
  const router = makeIdeasRouter();
  await router.push({ name: "ideas", query });
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  await flushPromises();
  return { wrapper, router, fetchMock };
}

async function selectProductImages(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-test="idea-library-check-0-11"]').setValue(true);
  await wrapper.find('[data-test="idea-library-check-0-12"]').setValue(true);
  await wrapper.find('[data-test="idea-library-done-0"]').trigger("click");
  await flushPromises();
}

const XHS_PREFIX = "/api/brands/1/trends/5/ideas/0/xhs-carousel/";

describe("product media request contract (xhs carousel and style image)", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("every real slide POST carries the outer-selected product images while preview and complete stay product-free", async () => {
    const { wrapper, fetchMock } = await mountIdeas(installFlowFetch(baseOptions()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    // 产品图只在内容选题外层选择（唯一素材入口）。
    await selectProductImages(wrapper);

    await wrapper.find('[data-test="idea-generate-xhs-0"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.find('[data-test="xhs-result"]').exists()).toBe(true);
    // preview 阶段不应产生任何逐页生图请求。
    expect(postUrls(fetchMock, `${XHS_PREFIX}slides/`)).toHaveLength(0);

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const expected = [
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ];
    for (let index = 0; index < 4; index += 1) {
      const slidePosts = postCalls(fetchMock, `${XHS_PREFIX}slides/${index}`);
      expect(slidePosts).toHaveLength(1);
      expect(slidePosts[0].productImages).toEqual(expected);
    }
    expect(postUrls(fetchMock, `${XHS_PREFIX}slides/`)).toHaveLength(4);

    // preview 只准备方案：严格相等证明不携带 productImages。
    const previewPosts = postCalls(fetchMock, `${XHS_PREFIX}preview`);
    expect(previewPosts).toHaveLength(1);
    expect(previewPosts[0]).toEqual({ aspectRatio: "3:4", visualStylePreset: "auto" });

    // complete 只归档：不携带 productImages。
    const completePosts = postCalls(fetchMock, `${XHS_PREFIX}complete`);
    expect(completePosts).toHaveLength(1);
    expect(completePosts[0]).not.toHaveProperty("productImages");
    expect(completePosts[0].creditEventId).toBe(9);
  });

  it("sends an empty productImages array on every slide POST when the switch is off", async () => {
    saveIdea0Settings({ useProductImages: false, selectedProductIds: [11, 12] });
    const { wrapper, fetchMock } = await mountIdeas(installFlowFetch(baseOptions()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "xhsCarousel",
    });

    await flushPromises();
    await flushPromises();
    expect(wrapper.find('[data-test="xhs-result"]').exists()).toBe(true);
    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const slidePosts = postCalls(fetchMock, `${XHS_PREFIX}slides/`);
    expect(slidePosts).toHaveLength(4);
    for (const body of slidePosts) {
      expect(body.productImages).toEqual([]);
    }
    const previewPosts = postCalls(fetchMock, `${XHS_PREFIX}preview`);
    expect(previewPosts[0]).toEqual({ aspectRatio: "3:4", visualStylePreset: "auto" });
    const completePosts = postCalls(fetchMock, `${XHS_PREFIX}complete`);
    expect(completePosts[0]).not.toHaveProperty("productImages");
  });

  it("gallery failure with the switch on blocks preview and slides with zero debit and keeps the action ticket", async () => {
    saveIdea0Settings({ useProductImages: true, selectedProductIds: [11, 12] });
    let galleryFailures = 1;
    const fetchMock = installFlowFetch(
      baseOptions((url, init) => {
        if (String(init?.method || "GET") === "GET" && url.split("?")[0] === "/api/product-images") {
          if (galleryFailures > 0) {
            galleryFailures -= 1;
            return jsonResponse(500, { error: "图库服务不可用" });
          }
          return jsonResponse(200, PRODUCT_IMAGES);
        }
        return undefined;
      }),
    );
    const { wrapper, router } = await mountIdeas(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "xhsCarousel",
    });

    // 图库失败 + 开关开启：0 preview、0 slide、0 complete（无扣费），票据保留。
    expect(postCalls(fetchMock, `${XHS_PREFIX}preview`)).toHaveLength(0);
    expect(postUrls(fetchMock, `${XHS_PREFIX}slides/`)).toHaveLength(0);
    expect(postUrls(fetchMock, `${XHS_PREFIX}complete`)).toHaveLength(0);
    expect(wrapper.find('[data-test="product-images-error"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBe("xhsCarousel");

    // 重新加载成功后自动启动：恰好 1 次 preview；逐页生成 4 个 slide。
    await wrapper.find('[data-test="retry-product-images"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, `${XHS_PREFIX}preview`)).toHaveLength(1);
    expect(router.currentRoute.value.query.action).toBeUndefined();

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(postUrls(fetchMock, `${XHS_PREFIX}slides/`)).toHaveLength(4);
  });

  it("style-image carries only styleReferenceImages even when product images are selected", async () => {
    const { wrapper, router, fetchMock } = await mountIdeas(installFlowFetch(baseOptions()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    // 外层同时选择普通产品图 + 独立风格参考图。
    await selectProductImages(wrapper);
    const input = wrapper.find('[data-test="idea-style-input-0"]');
    const file = new File(["style-bytes"], "style.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !wrapper.find('[data-test="idea-style-name-0"]').exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(wrapper.find('[data-test="idea-style-name-0"]').text()).toContain("style.png");

    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "styleImage" } });
    await flushPromises();
    await flushPromises();

    const stylePosts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/style-image");
    expect(stylePosts).toHaveLength(1);
    expect(stylePosts[0].styleReferenceImages).toEqual([
      { name: "style.png", dataUrl: expect.stringContaining("data:") },
    ]);
    expect(stylePosts[0]).not.toHaveProperty("productImages");
  });
});
