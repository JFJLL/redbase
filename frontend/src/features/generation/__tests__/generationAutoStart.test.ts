import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import GenerationView from "../views/GenerationView.vue";
import { clearIdeaCreativeSettings, getIdeaSettingsKey, saveIdeaCreativeSettings } from "../ideaCreativeSettings";

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
      { path: "/login", name: "login", component: { template: "<div />" } },
      { path: "/generation", name: "generation", component: { template: "<div />" } },
    ],
  });
}

const BRAND_DETAIL = {
  brand: {
    id: 1,
    name: "测试品牌",
    profileType: "brand",
    logo: null,
    trends: [
      {
        key: "b1",
        title: "热点趋势",
        description: "",
        items: [
          {
            id: 5,
            title: "夏日趋势",
            summary: "夏日主题",
            ideas: [
              {
                title: "选题一",
                summary: "内容摘要",
                angle: "切入角度",
                brandFit: "结合方式",
                audience: "人群",
                hook: "钩子",
                tags: [],
              },
            ],
          },
        ],
      },
    ],
  },
};

const PRODUCT_IMAGES = {
  images: [
    { id: 11, originalName: "product-a.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
    { id: 12, originalName: "product-b.png", url: "/api/product-images/12/file?sig=b", sizeBytes: 1024 },
  ],
};

function saveMomentsSettings(settings: {
  useProductImages: boolean;
  selectedProductIds: number[];
}): void {
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

/** Fetch mock covering the idea-driven flow; only global fetch is mocked. */
function makeFlowFetch(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;
    if (overrides[key]) return overrides[key](init);
    if (key === "GET /api/brands/1") return jsonResponse(200, BRAND_DETAIL);
    if (key === "GET /api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
    if (key === "GET /api/history") return jsonResponse(200, { generations: [] });
    if (key === "GET /api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
    if (method === "POST" && /\/ideas\/\d+\/image$/.test(key)) {
      return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
    }
    if (method === "POST" && /\/wechat-long-image$/.test(key)) {
      return jsonResponse(202, {
        wechatPack: { title: "长图标题", publishTitle: "发布标题" },
        jobId: "w1",
        user: { id: "u1" },
      });
    }
    if (url.startsWith("/api/image-jobs/")) {
      return jsonResponse(200, {
        status: "completed",
        imageConcept: {
          title: "生成标题",
          caption: "文案",
          visualDirection: "视觉方向",
          style: "风格",
          composition: "构图",
          imageUrl: "/api/generated-images/1/file?sig=z",
        },
        generationId: 1,
        persisted: true,
      });
    }
    throw new Error(`unhandled fetch: ${method} ${url}`);
  });
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>, urlPrefix: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((entry) => {
      const url = String(entry[0]);
      const init = entry[1] as RequestInit | undefined;
      return (init?.method || "GET").toUpperCase() === "POST" && url.startsWith(urlPrefix);
    })
    .map((entry) => {
      const body = (entry[1] as RequestInit | undefined)?.body;
      return body ? (JSON.parse(String(body)) as Record<string, unknown>) : {};
    });
}

async function mountWithQuery(
  fetchMock: ReturnType<typeof vi.fn>,
  query: Record<string, string>,
): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  vi.stubGlobal("fetch", fetchMock);
  const router = makeRouter();
  await router.push({ name: "generation", query });
  await router.isReady();
  const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  await flushPromises();
  return { wrapper, router };
}

describe("GenerationView one-click auto-start ticket and readiness gate", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("auto-starts exactly once with the action and the first POST carries the 2 selected product images", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = makeFlowFetch();
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
    // 一次性票据：POST 发出后 URL 上的 action 已被移除。
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("remounting after completion on the action-less URL does not submit again", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    const router = makeRouter();
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" } });
    await router.isReady();
    vi.stubGlobal("fetch", fetchMock);

    const first = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(first.find('[data-test="moments-result"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    first.unmount();

    // 刷新/重新挂载：URL 已无 action，不得再次自动提交。
    const second = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    second.unmount();
  });

  it("does not re-submit after an auto-start failure, even when remounted", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && url === "/api/brands/1") return jsonResponse(200, BRAND_DETAIL);
      if (method === "GET" && url.split("?")[0] === "/api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
      if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      if (method === "GET" && url.split("?")[0] === "/api/history") return jsonResponse(200, { generations: [] });
      if (method === "GET" && url.split("?")[0] === "/api/session") {
        return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const router = makeRouter();
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" } });
    await router.isReady();
    vi.stubGlobal("fetch", fetchMock);

    const first = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(first.find('[data-test="gen-error"]').text()).toContain("生成通道拥堵");
    // 失败后 URL 上的 action 已被消费，刷新/重挂载不得自动重扣。
    expect(router.currentRoute.value.query.action).toBeUndefined();
    first.unmount();

    const second = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    second.unmount();
  });

  it("includes the selected product images in the first wechat POST as well", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = makeFlowFetch();
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
    const fetchMock = makeFlowFetch();
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
    const fetchMock = makeFlowFetch();
    const { wrapper } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    await wrapper.find('[data-test="generate-moments"]').trigger("click");
    await flushPromises();

    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(1);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("blocks auto-start when the product gallery fails, shows a recoverable error, and resumes after retry", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    let galleryFailures = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && url.split("?")[0] === "/api/product-images") {
        if (galleryFailures > 0) {
          galleryFailures -= 1;
          return jsonResponse(500, { error: "图库服务不可用" });
        }
        return jsonResponse(200, PRODUCT_IMAGES);
      }
      if (method === "GET" && url === "/api/brands/1") return jsonResponse(200, BRAND_DETAIL);
      if (method === "GET" && url.split("?")[0] === "/api/history") return jsonResponse(200, { generations: [] });
      if (method === "GET" && url.split("?")[0] === "/api/session") {
        return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      }
      if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { title: "生成标题", imageUrl: "/api/generated-images/1/file?sig=z" },
          generationId: 1,
          persisted: true,
        });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    // 图库失败：不得静默以空数组自动生成，action 票据未消费，错误可恢复。
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image")).toHaveLength(0);
    expect(wrapper.find('[data-test="product-images-error"]').exists()).toBe(true);
    expect(router.currentRoute.value.query.action).toBe("moments");

    // 重试图库成功后，自动启动恢复且首包产品图非空。
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const path = url.split("?")[0];
      if (method === "GET" && path === "/api/product-images") {
        return jsonResponse(500, { error: "素材库暂时不可用" });
      }
      if (method === "GET" && path === "/api/brands/1") return jsonResponse(200, BRAND_DETAIL);
      if (method === "GET" && path === "/api/history") return jsonResponse(200, { generations: [] });
      if (method === "GET" && path === "/api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      if (method === "POST" && /\/ideas\/\d+\/image$/.test(path)) {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { title: "生成标题", caption: "文案", imageUrl: "/api/generated-images/1/file?sig=z" },
          generationId: 1,
          persisted: true,
        });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    // 图库失败：自动启动被门控，手动按钮一并禁用，尚未产生任何生成 POST。
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(wrapper.find('[data-test="product-images-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="generate-moments"]').attributes("disabled")).toBeDefined();

    // 手动点击（即便按钮禁用被绕过）：0 个 POST，action 票据保留在 URL。
    await wrapper.find('[data-test="generate-moments"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(router.currentRoute.value.query.action).toBe("moments");

    // 图库重试仍失败：防线持续生效，依然 0 个 POST、action 未消费。
    await wrapper.find('[data-test="retry-product-images"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(0);
    expect(router.currentRoute.value.query.action).toBe("moments");
    wrapper.unmount();
  });

  it("generates exactly once with empty productImages when the user disabled product images even if the gallery failed", async () => {
    saveMomentsSettings({ useProductImages: false, selectedProductIds: [11, 12] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const path = url.split("?")[0];
      if (method === "GET" && path === "/api/product-images") {
        return jsonResponse(500, { error: "素材库暂时不可用" });
      }
      if (method === "GET" && path === "/api/brands/1") return jsonResponse(200, BRAND_DETAIL);
      if (method === "GET" && path === "/api/history") return jsonResponse(200, { generations: [] });
      if (method === "GET" && path === "/api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      if (method === "POST" && /\/ideas\/\d+\/image$/.test(path)) {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { title: "生成标题", caption: "文案", imageUrl: "/api/generated-images/1/file?sig=z" },
          generationId: 1,
          persisted: true,
        });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    const posts = postCalls(fetchMock, imageUrl);
    // 用户明确关闭产品图：图库失败不阻塞，恰好 1 次生成且 productImages 为空数组。
    expect(posts).toHaveLength(1);
    expect(posts[0].productImages).toEqual([]);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    // action 票据被消费，后续冲刷不得重复提交。
    expect(router.currentRoute.value.query.action).toBeUndefined();
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    wrapper.unmount();
  });

  it("retry after a generation failure sends exactly one new POST and carries the complete product images", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    let jobFailures = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const path = url.split("?")[0];
      if (method === "GET" && path === "/api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
      if (method === "GET" && path === "/api/brands/1") return jsonResponse(200, BRAND_DETAIL);
      if (method === "GET" && path === "/api/history") return jsonResponse(200, { generations: [] });
      if (method === "GET" && path === "/api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      if (method === "POST" && /\/ideas\/\d+\/image$/.test(path)) {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
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
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const { wrapper, router } = await mountWithQuery(fetchMock, {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    // 自动启动产生第 1 个 POST，任务失败并出现可恢复错误。
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(wrapper.find('[data-test="gen-error"]').text()).toContain("生成通道拥堵");
    expect(wrapper.find('[data-test="gen-retry"]').exists()).toBe(true);

    // 点「重试」：只产生 1 个新 POST，图库就绪时 productImages 完整。
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
    // 稳定后仍只有 2 个 POST（不自动重复），action 已消费。
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(2);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    wrapper.unmount();
  });

  it("does not re-submit when navigating away and back over the action-less URL", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    const router = makeRouter();
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" } });
    await router.isReady();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    const imageUrl = "/api/brands/1/trends/5/ideas/0/image";
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(router.currentRoute.value.query.action).toBeUndefined();

    // 离开选题页再后退回来：URL 已无 action，不得再次自动提交。
    await router.push({ name: "login" });
    await flushPromises();
    await router.back();
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);

    // 前进再后退：同样不重复提交。
    await router.forward();
    await flushPromises();
    await router.back();
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    wrapper.unmount();
  });
});
