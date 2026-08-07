/**
 * 一键生成一次性票据 + 就绪门控测试（真实入口：IdeasView + IdeaGenerationDialog）。
 * 覆盖：自动启动恰好一次、刷新/重挂载不重复提交、失败后不重扣、
 * 产品图库门控与重试、手动入口、积分与 URL 票据语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { clearIdeaCreativeSettings, getIdeaSettingsKey, saveIdeaCreativeSettings } from "../ideaCreativeSettings";
import {
  installFlowFetch,
  makeIdeasRouter,
  postCalls,
  jsonResponse,
  type IdeasFlowOptions,
} from "./ideasGenerationHarness";

const BRAND_DETAIL = {
  brand: makeBrandDetail(
    [makeTrend(5, { ideas: [makeIdea({ title: "选题一", summary: "内容摘要", tags: [] })] })],
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

function saveMomentsSettings(settings: { useProductImages: boolean; selectedProductIds: number[] }): void {
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

async function mountWithQuery(
  fetchMock: ReturnType<typeof installFlowFetch>,
  query: Record<string, string>,
  reuse?: { router: ReturnType<typeof makeIdeasRouter> },
) {
  vi.stubGlobal("fetch", fetchMock);
  const router = reuse?.router ?? makeIdeasRouter();
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
  return { wrapper, router };
}

describe("one-click auto-start ticket and readiness gate (real ideas entry)", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("auto-starts exactly once with the action and the first POST carries the 2 selected product images", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = installFlowFetch(baseOptions());
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imagePosts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image");
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0].productImages).toEqual([
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ]);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("remounting after completion on the action-less URL does not submit again", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = installFlowFetch(baseOptions());
    const router = makeIdeasRouter();
    const first = await mountWithQuery(
      fetchMock,
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
      { router },
    );
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(first.wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    first.wrapper.unmount();

    const second = await mountWithQuery(fetchMock, {}, { router });
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    second.wrapper.unmount();
  });

  it("does not re-submit after an auto-start failure, even when remounted", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = installFlowFetch(
      baseOptions(
        (url, init) => {
          const method = String(init?.method || "GET");
          if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
            return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
          }
          if (method === "GET" && url.startsWith("/api/image-jobs/")) {
            return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
          }
          return undefined;
        },
      ),
    );
    const router = makeIdeasRouter();
    const first = await mountWithQuery(
      fetchMock,
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
      { router },
    );
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(first.wrapper.find('[data-test="gen-error"]').text()).toContain("生成通道拥堵");
    expect(router.currentRoute.value.query.action).toBeUndefined();
    first.wrapper.unmount();

    const second = await mountWithQuery(fetchMock, {}, { router });
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    second.wrapper.unmount();
  });

  it("includes the selected product images in the first wechat POST as well", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = installFlowFetch(baseOptions());
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "wechat",
    });

    const wechatPosts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/wechat-long-image");
    expect(wechatPosts).toHaveLength(1);
    expect(wechatPosts[0].productImages).toEqual([
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ]);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    wrapper.unmount();
  });

  it("submits an empty productImages array when useProductImages is off", async () => {
    saveMomentsSettings({ useProductImages: false, selectedProductIds: [11, 12] });
    const fetchMock = installFlowFetch(baseOptions());
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imagePosts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image");
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0].productImages).toEqual([]);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    wrapper.unmount();
  });

  it("still generates manually when entering without an action", async () => {
    const fetchMock = installFlowFetch(baseOptions());
    const { wrapper } = await mountWithQuery(fetchMock, { brandId: "1", trendId: "5", ideaIndex: "0" });

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();

    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("blocks auto-start when the product gallery fails, shows a recoverable error, and resumes after retry", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    // 图库只在内容选题页（唯一素材入口）加载：一次失败，重试后成功。
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
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(0);
    expect(wrapper.find('[data-test="product-images-error"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBe("moments");

    await wrapper.find('[data-test="retry-product-images"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const imagePosts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image");
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0].productImages).toEqual([
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ]);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    wrapper.unmount();
  });

  it("manual generation while the library failed posts nothing and keeps the action ticket", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = installFlowFetch(
      baseOptions((url, init) => {
        if (String(init?.method || "GET") === "GET" && url.split("?")[0] === "/api/product-images") {
          return jsonResponse(500, { error: "素材库暂时不可用" });
        }
        return undefined;
      }),
    );
    const { wrapper, router } = await mountWithQuery(fetchMock, { brandId: "1", trendId: "5", ideaIndex: "0" });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(wrapper.find('[data-test="product-images-error"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBe("moments");

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(router.currentRoute.value.query.action).toBe("moments");

    await wrapper.find('[data-test="retry-product-images"]').trigger("click");
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(router.currentRoute.value.query.action).toBe("moments");
    wrapper.unmount();
  });

  it("generates exactly once with empty productImages when the user disabled product images even if the gallery failed", async () => {
    saveMomentsSettings({ useProductImages: false, selectedProductIds: [11, 12] });
    const fetchMock = installFlowFetch(
      baseOptions((url, init) => {
        if (String(init?.method || "GET") === "GET" && url.split("?")[0] === "/api/product-images") {
          return jsonResponse(500, { error: "素材库暂时不可用" });
        }
        return undefined;
      }),
    );
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    const posts = postCalls(fetchMock, imageUrl);
    expect(posts).toHaveLength(1);
    expect(posts[0].productImages).toEqual([]);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    wrapper.unmount();
  });

  it("retry after a generation failure sends exactly one new POST and carries the complete product images", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    let jobFailures = 1;
    const fetchMock = installFlowFetch(
      baseOptions((url, init) => {
        const method = String(init?.method || "GET");
        if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
          return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
        }
        if (method === "GET" && url.startsWith("/api/image-jobs/")) {
          if (jobFailures > 0) {
            jobFailures -= 1;
            return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
          }
          return jsonResponse(200, {
            status: "completed",
            imageConcept: { title: "重试成功", caption: "文案", imageUrl: "/api/generated-images/2/file?sig=x" },
            generationId: 2,
            persisted: true,
          });
        }
        return undefined;
      }),
    );
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(wrapper.find('[data-test="gen-error"]').text()).toContain("生成通道拥堵");
    expect(wrapper.find('[data-test="gen-retry"]').exists()).toBe(true);

    await wrapper.find('[data-test="gen-retry"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const posts = postCalls(fetchMock, imageUrl);
    expect(posts).toHaveLength(2);
    expect(posts[1].productImages).toEqual([
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ]);
    expect(wrapper.find('[data-test="moments-result"]').text()).toContain("重试成功");
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(2);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    wrapper.unmount();
  });

  it("does not re-submit when navigating away and back over the action-less URL", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = installFlowFetch(baseOptions());
    const router = makeIdeasRouter();
    const { wrapper } = await mountWithQuery(
      fetchMock,
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
      { router },
    );

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(router.currentRoute.value.query.action).toBeUndefined();

    await router.push({ name: "login" });
    await flushPromises();
    await router.back();
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);

    await router.forward();
    await flushPromises();
    await router.back();
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    wrapper.unmount();
  });
});
