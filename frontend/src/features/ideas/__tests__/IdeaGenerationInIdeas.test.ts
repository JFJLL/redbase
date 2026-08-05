import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import IdeasView from "../views/IdeasView.vue";
import { useAuthStore } from "@/shared/stores/auth";
import { clearIdeaCreativeSettings, getIdeaSettingsKey, saveIdeaCreativeSettings } from "@/features/generation/ideaCreativeSettings";
import {
  makeBrandDetail,
  makeBrandSummary,
  makeTrend,
} from "@/features/trends/__tests__/insightsTestUtils";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const BRAND_DETAIL = {
  brand: makeBrandDetail([makeTrend(501)]),
};

const BRAND_B_DETAIL = {
  brand: makeBrandDetail([makeTrend(7656)], { id: 3, name: "品牌B" }),
};

const PRODUCT_IMAGES = {
  images: [
    { id: 11, originalName: "product-a.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
    { id: 12, originalName: "product-b.png", url: "/api/product-images/12/file?sig=b", sizeBytes: 1024 },
  ],
};

function saveMomentsSettings(settings: { useProductImages: boolean; selectedProductIds: number[] }): void {
  saveIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0), {
    aspectRatioSelection: "smart",
    visualStylePreset: "auto",
    wechatTemplate: "auto",
    useBrandLogo: false,
    selectedProductIds: settings.selectedProductIds,
    useProductImages: settings.useProductImages,
    styleReference: null,
  });
}

function makeIdeasRouter(): Router {
  const Stub = { template: "<div />" };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: Stub },
      { path: "/ideas", name: "ideas", component: Stub },
      // 与应用路由表一致：/generation 仅作兼容入口，重定向到内容选题并保留 query。
      { path: "/generation", name: "generation", redirect: (to) => ({ name: "ideas", query: to.query }) },
      { path: "/login", name: "login", component: Stub },
    ],
  });
}

/** 覆盖内容选题页 + 生成对话框全链路（仅全局 fetch 被 mock）。 */
function makeFlowFetch(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;
    if (overrides[key]) return overrides[key](init);
    if (key === "GET /api/brands") {
      return jsonResponse(200, { brands: [makeBrandSummary(), makeBrandSummary({ id: 3, name: "品牌B" })] });
    }
    if (key === "GET /api/brands/7") return jsonResponse(200, BRAND_DETAIL);
    if (key === "GET /api/brands/3") return jsonResponse(200, BRAND_B_DETAIL);
    if (key === "GET /api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
    if (key === "GET /api/history") return jsonResponse(200, { generations: [] });
    if (key === "GET /api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
    if (method === "POST" && /\/ideas\/\d+\/image$/.test(key)) {
      return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
    }
    if (method === "POST" && /\/wechat-long-image$/.test(key)) {
      return jsonResponse(202, { wechatPack: { title: "长图标题" }, jobId: "w1", user: { id: "u1" } });
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

async function mountIdeasWith(
  fetchMock: ReturnType<typeof vi.fn>,
  query: Record<string, string> = {},
): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
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
  return { wrapper, router };
}

describe("内容选题内生成（一次性票据 + 素材门控 + 失败恢复）", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("点击一键朋友圈图：对话框内恰好 1 次 POST，action 票据被消费，结果显示在选题页内", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    const fetchMock = makeFlowFetch();
    const { wrapper, router } = await mountIdeasWith(fetchMock);

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const imageUrl = "/api/brands/7/trends/501/ideas/0/image";
    const imagePosts = postCalls(fetchMock, imageUrl);
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0].productImages).toEqual([
      { id: 11, name: "product-a.png" },
      { id: 12, name: "product-b.png" },
    ]);
    // 内容选题页内直接展示结果，不再跳独立生图页。
    expect(router.currentRoute.value.name).toBe("ideas");
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("刷新/重挂载与后退前进：URL 无 action，不再重复 POST", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "7", trendId: "501", ideaIndex: "0", action: "moments" } });
    await router.isReady();
    vi.stubGlobal("fetch", fetchMock);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;

    const first = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    const imageUrl = "/api/brands/7/trends/501/ideas/0/image";
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    first.unmount();

    // 刷新/重挂载：不得再次自动提交。
    const second = mount(IdeasView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    second.unmount();

    // 后退/前进：不得再次自动提交。
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
  });

  it("失败后点重试：恰好新增 1 次 POST；成功页不会被重复生成", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [11, 12] });
    let jobFailures = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const key = `${method} ${url.split("?")[0]}`;
      if (key === "GET /api/brands") return jsonResponse(200, { brands: [makeBrandSummary()] });
      if (key === "GET /api/brands/7") return jsonResponse(200, BRAND_DETAIL);
      if (key === "GET /api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
      if (key === "GET /api/history") return jsonResponse(200, { generations: [] });
      if (key === "GET /api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
      if (method === "POST" && /\/ideas\/\d+\/image$/.test(key)) {
        return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
      }
      if (url.startsWith("/api/image-jobs/")) {
        if (jobFailures > 0) {
          jobFailures -= 1;
          return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
        }
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { title: "重试成功", imageUrl: "/api/generated-images/2/file?sig=x" },
          generationId: 2,
          persisted: true,
        });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    const { wrapper } = await mountIdeasWith(fetchMock);
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const imageUrl = "/api/brands/7/trends/501/ideas/0/image";
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
    wrapper.unmount();
  });

  it("/generation 兼容深链：重定向到内容选题后自动打开对话框并恰好生成 1 次", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    const { wrapper, router } = await mountIdeasWith(fetchMock, {
      brandId: "7",
      trendId: "501",
      ideaIndex: "0",
      action: "moments",
    });

    const imageUrl = "/api/brands/7/trends/501/ideas/0/image";
    const posts = postCalls(fetchMock, imageUrl);
    expect(posts).toHaveLength(1);
    expect(router.currentRoute.value.name).toBe("ideas");
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    // 关闭对话框后 action 已不在 URL，刷新不会重开自动生成。
    await wrapper.find('[data-test="idea-generation-close"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("挂载只执行一次 loadPage（无重复品牌请求），避免并行信号中止吞掉深链自动打开", async () => {
    const fetchMock = makeFlowFetch();
    const { wrapper } = await mountIdeasWith(fetchMock, {
      brandId: "7",
      trendId: "501",
      ideaIndex: "0",
      action: "moments",
    });

    // 回归锚点：2026-08-05 曾有两个 onMounted 并发 loadPage，第二个的
    // signalFor("brands") 会中止第一个在途请求，使 .then(applyDeepLinkGeneration)
    // 在 store 为空时提前执行、深链自动打开失效。现在只允许一次品牌摘要请求。
    const brandSummaryCalls = fetchMock.mock.calls.filter(
      (entry) => String(entry[0]).split("?")[0] === "/api/brands" && String((entry[1] as RequestInit | undefined)?.method || "GET").toUpperCase() === "GET",
    );
    expect(brandSummaryCalls).toHaveLength(1);
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("温 store 场景（先访问选题页再带 action 深链）仍自动打开对话框且只 POST 一次", async () => {
    const fetchMock = makeFlowFetch();
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas" });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;

    const first = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    expect(first.findAll('[data-test="idea-card"]')).toHaveLength(2);
    first.unmount();

    await router.push({
      name: "ideas",
      query: { brandId: "7", trendId: "501", ideaIndex: "0", action: "moments" },
    });
    await flushPromises();
    const second = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    const imageUrl = "/api/brands/7/trends/501/ideas/0/image";
    expect(second.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    expect(router.currentRoute.value.query.action).toBeUndefined();
    second.unmount();
  });

  it("SPA 深链复用：同一 IdeasView 实例停留 /ideas 时经 /generation 进入，同步品牌/趋势、打开对话框并恰好提交 1 次", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas" });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;

    // 用户已停留在内容选题页（品牌 7 / 趋势 501），实例保持挂载。
    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("通勤咖啡自由指南");
    const mountedElement = wrapper.element;

    // 外部 router.push 到 /generation 深链（重定向回 /ideas 且 query 保留）：
    // 路由复用同一个 IdeasView 实例，不得依赖重新挂载。
    await router.push({
      name: "generation",
      query: { brandId: "3", trendId: "7656", ideaIndex: "0", action: "moments" },
    });
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("ideas");
    expect(wrapper.element).toBe(mountedElement);
    expect(wrapper.text()).toContain("品牌B");
    expect(wrapper.text()).toContain("秋日第一杯咖啡"); // makeTrend(7656) 的标题
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);

    const imageUrl = "/api/brands/3/trends/7656/ideas/0/image";
    const posts = postCalls(fetchMock, imageUrl);
    expect(posts).toHaveLength(1);
    expect(posts[0].productImages).toEqual([]);
    expect(router.currentRoute.value.query.action).toBeUndefined();

    // 刷新/重挂载：URL 已无 action，0 新增 POST。
    wrapper.unmount();
    const second = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    second.unmount();

    // 后退/前进：同样 0 新增 POST。
    await router.back();
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.query.action).toBeUndefined();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
    await router.forward();
    await flushPromises();
    await flushPromises();
    expect(postCalls(fetchMock, imageUrl)).toHaveLength(1);
  });

  it.each([
    ["moments", "朋友圈图"],
    ["wechat", "公众号长图"],
    ["xhsCarousel", "小红书组图"],
    ["styleImage", "风格化图"],
  ] as const)(
    "图库加载失败（genKind 未初始化）时对话框仍正确显示动作名称 %s，不默认成朋友圈图",
    async (action, label) => {
      const fetchMock = makeFlowFetch({
        "GET /api/product-images": () => jsonResponse(500, { error: "素材库暂时不可用" }),
      });
      const { wrapper } = await mountIdeasWith(fetchMock);
      const slug = action === "xhsCarousel" ? "xhs" : action === "styleImage" ? "style" : action;
      await wrapper.find(`[data-test="idea-generate-${slug}-0"]`).trigger("click");
      await flushPromises();

      const dialog = wrapper.find('[data-test="idea-generation-dialog"]');
      expect(dialog.exists()).toBe(true);
      // 图库失败 → 自动启动被门控 → genKind 为空；动作名必须来自显式传入的 action。
      expect(dialog.find('[data-test="product-images-error"]').exists()).toBe(true);
      expect(dialog.find('[data-test="idea-generation-action"]').text()).toBe(label);
      wrapper.unmount();
    },
  );

  it.each([
    ["moments", "朋友圈图"],
    ["wechat", "公众号长图"],
    ["xhsCarousel", "小红书组图"],
    ["styleImage", "风格化图"],
  ] as const)(
    "图库加载中（自动启动等待就绪）时对话框仍正确显示动作名称 %s",
    async (action, label) => {
      const fetchMock = makeFlowFetch({
        "GET /api/product-images": () => new Promise<Response>(() => {}) as unknown as Response,
      });
      const { wrapper } = await mountIdeasWith(fetchMock);
      const slug = action === "xhsCarousel" ? "xhs" : action === "styleImage" ? "style" : action;
      await wrapper.find(`[data-test="idea-generate-${slug}-0"]`).trigger("click");
      await flushPromises();

      const dialog = wrapper.find('[data-test="idea-generation-dialog"]');
      expect(dialog.exists()).toBe(true);
      expect(dialog.find('[data-test="idea-generation-action"]').text()).toBe(label);
      wrapper.unmount();
    },
  );

  it("Escape 关闭生成对话框，并恢复打开前的焦点", async () => {
    saveMomentsSettings({ useProductImages: true, selectedProductIds: [] });
    const fetchMock = makeFlowFetch();
    vi.stubGlobal("fetch", fetchMock);
    const router = makeIdeasRouter();
    await router.push({ name: "ideas" });
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    // attachTo document.body：happy-dom 只有挂载到 document 的元素才能获得焦点。
    const wrapper = mount(IdeasView, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    await flushPromises();

    const trigger = wrapper.find('[data-test="idea-generate-moments-0"]');
    (trigger.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(trigger.element);

    await trigger.trigger("click");
    await flushPromises();
    const dialog = wrapper.find('[data-test="idea-generation-dialog"]');
    expect(dialog.exists()).toBe(true);
    // 打开后焦点进入对话框内部。
    expect(dialog.element.contains(document.activeElement)).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();

    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
});
