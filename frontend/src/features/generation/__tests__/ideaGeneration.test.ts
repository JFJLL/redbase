import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import GenerationView from "../views/GenerationView.vue";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { clearIdeaCreativeSettings } from "../ideaCreativeSettings";

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
    logo: { originalName: "logo.png", url: "/api/brands/1/logo/file?sig=x" },
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
  images: [{ id: 11, originalName: "product.png", url: "/api/product-images/11/file?sig=y", sizeBytes: 2048 }],
};

/** Fetch mock covering all idea-driven generation endpoints. Business modules
 *  are never mocked — only the global fetch, per the task constraints. */
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

async function mountWithContext(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const router = makeRouter();
  await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
  await router.isReady();
  const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

function callBody(fetchMock: ReturnType<typeof vi.fn>, method: string, urlPrefix: string): unknown {
  const call = fetchMock.mock.calls.find((entry) => {
    const url = String(entry[0]);
    const init = entry[1] as RequestInit | undefined;
    return (init?.method || "GET").toUpperCase() === method && url.startsWith(urlPrefix);
  });
  if (!call) return undefined;
  const body = (call[1] as RequestInit | undefined)?.body;
  return body ? JSON.parse(String(body)) : undefined;
}

describe("GenerationView idea context", () => {
  beforeEach(() => {
    // 创作设置按键位记忆是模块级 store，测试间必须清空避免串值。
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads brand detail from the route query and shows the brand×trend×idea summary", async () => {
    const fetchMock = makeFlowFetch();
    const wrapper = await mountWithContext(fetchMock);

    const brandCall = fetchMock.mock.calls.find((entry) => String(entry[0]) === "/api/brands/1");
    expect(brandCall).toBeTruthy();

    const summary = wrapper.find('[data-test="idea-context"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("测试品牌");
    expect(summary.text()).toContain("夏日趋势");
    expect(summary.text()).toContain("选题一");
  });

  it("submits the moments image body with a selected product image and default 3:4 ratio", async () => {
    const fetchMock = makeFlowFetch();
    const wrapper = await mountWithContext(fetchMock);

    // Product panel is mounted and its list loaded; pick one image.
    await wrapper.find('[data-test="product-image-check-11"]').setValue(true);
    await flushPromises();

    await wrapper.find('[data-test="generate-moments"]').trigger("click");
    await flushPromises();

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/image") as Record<string, unknown>;
    expect(body).toEqual({
      productImages: [{ id: 11, name: "product.png" }],
      useBrandLogo: false,
      aspectRatio: "3:4",
    });
    expect(wrapper.find('[data-test="moments-result"]').text()).toContain("生成标题");
  });

  it("runs the full xhs carousel preview→slides→complete flow", async () => {
    const previewPack = {
      carouselPack: {
        title: "组图标题",
        aspectRatio: "3:4",
        slides: [
          { title: "P1", visualDirection: "V1" },
          { title: "P2", visualDirection: "V2" },
          { title: "P3", visualDirection: "V3" },
          { title: "P4", visualDirection: "V4" },
        ],
      },
      user: { id: "u1", credits: 5 },
    };
    let completeCalled = false;
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/preview": () => jsonResponse(200, previewPack),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0": () =>
        jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "s0" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/1": () =>
        jsonResponse(202, { slideJob: { slideIndex: 1, jobId: "s1" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/2": () =>
        jsonResponse(202, { slideJob: { slideIndex: 2, jobId: "s2" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/3": () =>
        jsonResponse(202, { slideJob: { slideIndex: 3, jobId: "s3" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/complete": () => {
        completeCalled = true;
        return jsonResponse(200, { generation: { id: 7 }, user: { id: "u1" } });
      },
    });
    const wrapper = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-xhs"]').trigger("click");
    await flushPromises();

    // Preview body carries the resolved aspect ratio + visual style preset.
    const previewBody = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/xhs-carousel/preview");
    expect(previewBody).toEqual({ aspectRatio: "3:4", visualStylePreset: "auto" });
    expect(wrapper.find('[data-test="xhs-result"]').exists()).toBe(true);

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();

    // Each slide POSTed with carouselPack + slide + aspect ratio.
    for (let index = 0; index < 4; index += 1) {
      const slideBody = callBody(
        fetchMock,
        "POST",
        `/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/${index}`,
      ) as Record<string, unknown>;
      expect(slideBody).toBeTruthy();
      expect(slideBody.aspectRatio).toBe("3:4");
      expect(slideBody.visualStylePreset).toBe("auto");
      expect(slideBody.useBrandLogo).toBe(false);
    }

    // Completion fires once all four slides carry images.
    const completeBody = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/xhs-carousel/complete") as Record<
      string,
      unknown
    >;
    expect(completeCalled).toBe(true);
    expect(completeBody.creditEventId).toBe(9);
  });

  it("submits the wechat long image body with template and default 9:21 ratio", async () => {
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/wechat-long-image": () =>
        jsonResponse(200, {
          wechatPack: { title: "长图标题", publishTitle: "发布标题", intro: "导语", outline: ["一", "二"] },
          jobId: "w1",
          user: { id: "u1" },
        }),
    });
    const wrapper = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-wechat"]').trigger("click");
    await flushPromises();

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/wechat-long-image") as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ productImages: [], useBrandLogo: false, wechatTemplate: "auto", aspectRatio: "9:21" });
    expect(wrapper.find('[data-test="wechat-result"]').text()).toContain("发布标题");
  });

  it("submits the style image body built from the idea fields", async () => {
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/style-image": () => jsonResponse(202, { jobId: "st1", user: { id: "u1" } }),
    });
    const wrapper = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-style"]').trigger("click");
    await flushPromises();

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/style-image") as Record<string, unknown>;
    expect(body.title).toBe("选题一");
    expect(body.aspectRatio).toBe("3:4");
    expect(body.useBrandLogo).toBe(false);
    expect(String(body.stylePrompt)).toContain("内容摘要");
    expect(body.styleReferenceImages).toEqual([]);
  });

  it("uploads and deletes product images", async () => {
    let uploaded = false;
    let deleted = false;
    const fetchMock = makeFlowFetch({
      "POST /api/product-images": (init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.name).toBe("upload.png");
        expect(String(body.dataUrl)).toContain("data:");
        uploaded = true;
        return jsonResponse(201, {
          image: { id: 22, originalName: "upload.png", url: "/api/product-images/22/file?sig=u", sizeBytes: 1000 },
        });
      },
      "DELETE /api/product-images/22": () => {
        deleted = true;
        return jsonResponse(200, { ok: true });
      },
    });
    const wrapper = await mountWithContext(fetchMock);

    const input = wrapper.find('[data-test="product-image-upload"]');
    const file = new File(["hello-bytes"], "upload.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");

    for (let attempt = 0; attempt < 30 && !uploaded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(uploaded).toBe(true);

    await wrapper.find('[data-test="product-image-delete-22"]').trigger("click");
    await flushPromises();
    expect(deleted).toBe(true);
  });

  it("stops polling when the view unmounts mid-generation", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = makeFlowFetch({
        "POST /api/brands/1/trends/5/ideas/0/image": () => jsonResponse(202, { jobId: "job-poll", user: { id: "u1" } }),
      });
      // image-jobs stays pending so polling keeps looping.
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || "GET").toUpperCase();
        if (url === "/api/brands/1" && method === "GET") return jsonResponse(200, BRAND_DETAIL);
        if (url.split("?")[0] === "/api/product-images" && method === "GET") return jsonResponse(200, PRODUCT_IMAGES);
        if (url.startsWith("/api/brands/1/trends/5/ideas/0/image") && method === "POST") {
          return jsonResponse(202, { jobId: "job-poll", user: { id: "u1" } });
        }
        if (url.startsWith("/api/image-jobs/")) return jsonResponse(200, { status: "pending" });
        throw new Error(`unhandled fetch: ${method} ${url}`);
      });

      vi.stubGlobal("fetch", fetchMock);
      const router = makeRouter();
      await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
      await router.isReady();
      const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();

      await wrapper.find('[data-test="generate-moments"]').trigger("click");
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();

      const pollCount = () =>
        fetchMock.mock.calls.filter((entry) => String(entry[0]).startsWith("/api/image-jobs/")).length;
      expect(pollCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
      await flushPromises();
      expect(pollCount()).toBe(2);

      wrapper.unmount();
      await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 10);
      expect(pollCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
