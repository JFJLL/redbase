/**
 * 任务2：恢复生图能力的行为与请求契约测试（组件级，mock 全局 fetch）。
 * 覆盖：创作设置按 品牌ID:趋势ID:选题序号 键位隔离与恢复、组图每页提示词
 * 随 slide 请求提交、单页失败重试不重复成功页、全部成功只 complete 一次、
 * 4 页图片任务并发轮询（推进 5s 应有 ≥2 个 job 查询在飞）、生成后单页改图
 * 走 POST /api/image-edits、风格参考图进入 style-image 请求体。
 */
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
              { title: "选题一", summary: "内容摘要一", angle: "角度一", brandFit: "结合一", audience: "人群一", hook: "钩子一", tags: [] },
              { title: "选题二", summary: "内容摘要二", angle: "角度二", brandFit: "结合二", audience: "人群二", hook: "钩子二", tags: [] },
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

const PREVIEW_PACK_4 = {
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

type Handler = (init?: RequestInit) => Response;

function makeFlowFetch(overrides: Record<string, Handler> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;
    if (overrides[key]) return overrides[key](init);
    if (key === "GET /api/brands/1") return jsonResponse(200, BRAND_DETAIL);
    if (key === "GET /api/product-images") return jsonResponse(200, PRODUCT_IMAGES);
    if (key === "GET /api/history") return jsonResponse(200, { generations: [] });
    if (key === "GET /api/session") return jsonResponse(200, { user: { id: "u1", credits: 5 } });
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
}

async function mountWithContext(fetchMock: ReturnType<typeof vi.fn>, ideaIndex = "0") {
  vi.stubGlobal("fetch", fetchMock);
  const router = makeRouter();
  await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex } });
  await router.isReady();
  const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, router };
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>, urlPrefix: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((entry) => {
      const init = entry[1] as RequestInit | undefined;
      return (init?.method || "GET").toUpperCase() === "POST" && String(entry[0]).startsWith(urlPrefix);
    })
    .map((entry) => JSON.parse(String((entry[1] as RequestInit).body)) as Record<string, unknown>);
}

function selectValue(wrapper: ReturnType<typeof mount>, selector: string): string {
  return (wrapper.find(selector).element as HTMLSelectElement).value;
}

describe("GenerationView per-idea creative settings & carousel restoration", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps creative settings isolated per 品牌ID:趋势ID:选题序号 and restores them on re-entry", async () => {
    const fetchMock = makeFlowFetch();
    const { wrapper, router } = await mountWithContext(fetchMock);

    // 选题 0：设置一组非默认值。
    await wrapper.find('[data-test="aspect-ratio-select"]').setValue("1:1");
    await wrapper.find('[data-test="xhs-style-select"]').setValue("editorial");
    await wrapper.find('[data-test="wechat-template-select"]').setValue("tutorial");
    await wrapper.find('[data-test="use-brand-logo"]').setValue(true);
    await wrapper.find('[data-test="product-image-check-11"]').setValue(true);
    await flushPromises();

    // 切到选题 1：必须是默认值，不得串值。
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "1" } });
    await flushPromises();
    expect(selectValue(wrapper, '[data-test="aspect-ratio-select"]')).toBe("smart");
    expect(selectValue(wrapper, '[data-test="xhs-style-select"]')).toBe("auto");
    expect(selectValue(wrapper, '[data-test="wechat-template-select"]')).toBe("auto");
    expect((wrapper.find('[data-test="use-brand-logo"]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.find('[data-test="product-image-check-11"]').element as HTMLInputElement).checked).toBe(false);

    // 选题 1 设置另一组值。
    await wrapper.find('[data-test="aspect-ratio-select"]').setValue("16:9");
    await flushPromises();

    // 回到选题 0：恢复选题 0 自己的设置。
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await flushPromises();
    expect(selectValue(wrapper, '[data-test="aspect-ratio-select"]')).toBe("1:1");
    expect(selectValue(wrapper, '[data-test="xhs-style-select"]')).toBe("editorial");
    expect(selectValue(wrapper, '[data-test="wechat-template-select"]')).toBe("tutorial");
    expect((wrapper.find('[data-test="use-brand-logo"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.find('[data-test="product-image-check-11"]').element as HTMLInputElement).checked).toBe(true);

    // 再切回选题 1：仍是 16:9。
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "1" } });
    await flushPromises();
    expect(selectValue(wrapper, '[data-test="aspect-ratio-select"]')).toBe("16:9");
  });

  it("submits the edited per-page prompt inside the slide request body", async () => {
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/preview": () => jsonResponse(200, PREVIEW_PACK_4),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0": () =>
        jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "s0" }, creditEventId: 9, user: { id: "u1" } }),
    });
    const { wrapper } = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-xhs"]').trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="xhs-slide-prompt-0"]').setValue("自定义首页提示词：突出清凉感");
    await wrapper.find('[data-test="generate-xhs-slide-0"]').trigger("click");
    await flushPromises();

    const [slideBody] = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0");
    expect(slideBody).toBeTruthy();
    const slide = slideBody.slide as Record<string, unknown>;
    expect(slide.prompt).toBe("自定义首页提示词：突出清凉感");
    expect(slideBody.visualStylePreset).toBe("auto");
    expect(slideBody.aspectRatio).toBe("3:4");
  });

  it("retries only the failed page, never regenerates completed pages, completes exactly once", async () => {
    let slide1Attempts = 0;
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/preview": () => jsonResponse(200, PREVIEW_PACK_4),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0": () =>
        jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "s0" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/1": () => {
        slide1Attempts += 1;
        if (slide1Attempts === 1) return jsonResponse(500, { error: "生成通道拥堵" });
        return jsonResponse(202, { slideJob: { slideIndex: 1, jobId: "s1" }, creditEventId: 9, user: { id: "u1" } });
      },
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/2": () =>
        jsonResponse(202, { slideJob: { slideIndex: 2, jobId: "s2" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/3": () =>
        jsonResponse(202, { slideJob: { slideIndex: 3, jobId: "s3" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/complete": () =>
        jsonResponse(200, { generation: { id: 7 }, user: { id: "u1" } }),
    });
    const { wrapper } = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-xhs"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();

    // 第 1 页失败，其余 3 页成功：complete 不得被调用。
    const completeUrl = "/api/brands/1/trends/5/ideas/0/xhs-carousel/complete";
    expect(postCalls(fetchMock, completeUrl)).toHaveLength(0);
    expect(wrapper.find('[data-test="xhs-slide-1"]').text()).toContain("生成失败");

    // 单页重试：只重发第 1 页，不得重新生成已成功页。
    await wrapper.find('[data-test="generate-xhs-slide-1"]').trigger("click");
    await flushPromises();

    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0")).toHaveLength(1);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/1")).toHaveLength(2);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/2")).toHaveLength(1);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/3")).toHaveLength(1);
    // 全部成功后只 complete 一次（携带 creditEventId）。
    const completes = postCalls(fetchMock, completeUrl);
    expect(completes).toHaveLength(1);
    expect(completes[0].creditEventId).toBe(9);

    // 再点一键生成：所有页已有图，不得追加 slide 请求，也不得再次 complete。
    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/")).toHaveLength(5);
    expect(postCalls(fetchMock, completeUrl)).toHaveLength(1);
  });

  it("polls the four slide jobs concurrently — ≥2 distinct jobs in flight within 5s", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = makeFlowFetch({
        "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/preview": () => jsonResponse(200, PREVIEW_PACK_4),
        "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0": () =>
          jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "job-a" }, creditEventId: 9, user: { id: "u1" } }),
        "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/1": () =>
          jsonResponse(202, { slideJob: { slideIndex: 1, jobId: "job-b" }, creditEventId: 9, user: { id: "u1" } }),
        "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/2": () =>
          jsonResponse(202, { slideJob: { slideIndex: 2, jobId: "job-c" }, creditEventId: 9, user: { id: "u1" } }),
        "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/3": () =>
          jsonResponse(202, { slideJob: { slideIndex: 3, jobId: "job-d" }, creditEventId: 9, user: { id: "u1" } }),
        // 图片任务保持 pending：轮询会持续进行。
        "GET /api/image-jobs/job-a": () => jsonResponse(200, { status: "pending" }),
        "GET /api/image-jobs/job-b": () => jsonResponse(200, { status: "pending" }),
        "GET /api/image-jobs/job-c": () => jsonResponse(200, { status: "pending" }),
        "GET /api/image-jobs/job-d": () => jsonResponse(200, { status: "pending" }),
      });
      const { wrapper } = await mountWithContext(fetchMock);
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();

      await wrapper.find('[data-test="generate-xhs"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
      await flushPromises();

      const distinctPolledJobs = () =>
        new Set(
          fetchMock.mock.calls
            .map((entry) => String(entry[0]))
            .filter((url) => url.startsWith("/api/image-jobs/"))
            .map((url) => url.split("/").pop()),
        );

      // 推进 5s：若为串行实现，只会反复轮询第一个 job。
      await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
      await flushPromises();
      const polled = distinctPolledJobs();
      expect(polled.size).toBeGreaterThanOrEqual(2);
      // 实际应为 4 页同时在飞。
      expect(polled).toEqual(new Set(["job-a", "job-b", "job-c", "job-d"]));
      // 每个 job 至少完成了两轮查询（起始一轮 + 5s 后一轮）。
      const pollsForJobA = fetchMock.mock.calls.filter((entry) =>
        String(entry[0]).startsWith("/api/image-jobs/job-a"),
      ).length;
      expect(pollsForJobA).toBeGreaterThanOrEqual(2);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits a generated slide through POST /api/image-edits with the per-page edit prompt", async () => {
    const previewOnePage = {
      carouselPack: { title: "组图标题", aspectRatio: "3:4", slides: [{ title: "P1", visualDirection: "V1" }] },
      user: { id: "u1", credits: 5 },
    };
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/preview": () => jsonResponse(200, previewOnePage),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0": () =>
        jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "s0" }, creditEventId: 9, user: { id: "u1" } }),
      "POST /api/brands/1/trends/5/ideas/0/xhs-carousel/complete": () =>
        jsonResponse(200, { generation: { id: 7 }, user: { id: "u1" } }),
      "POST /api/image-edits": () => jsonResponse(202, { jobId: "edit-1", user: { id: "u1" } }),
    });
    const { wrapper } = await mountWithContext(fetchMock);

    await wrapper.find('[data-test="generate-xhs"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-xhs-slide-0"]').trigger("click");
    await flushPromises();

    // 出图后出现改图输入框；填提示词继续改图。
    await wrapper.find('[data-test="xhs-slide-edit-prompt-0"]').setValue("把背景换成海边");
    await wrapper.find('[data-test="edit-xhs-slide-0"]').trigger("click");
    await flushPromises();

    const [editBody] = postCalls(fetchMock, "/api/image-edits");
    expect(editBody).toBeTruthy();
    expect(editBody.prompt).toBe("把背景换成海边");
    expect(editBody.imageUrl).toBe("/api/generated-images/1/file?sig=z");
    expect(editBody.aspectRatio).toBe("3:4");
  });

  it("uploads a style reference image and sends it in the style-image request body", async () => {
    const fetchMock = makeFlowFetch({
      "POST /api/brands/1/trends/5/ideas/0/style-image": () => jsonResponse(202, { jobId: "st1", user: { id: "u1" } }),
    });
    const { wrapper } = await mountWithContext(fetchMock);

    const input = wrapper.find('[data-test="style-reference-input"]');
    const file = new File(["style-bytes"], "style-ref.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !wrapper.find('[data-test="style-reference-name"]').exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(wrapper.find('[data-test="style-reference-name"]').text()).toContain("style-ref.png");

    await wrapper.find('[data-test="generate-style"]').trigger("click");
    await flushPromises();

    const [styleBody] = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/style-image");
    expect(styleBody).toBeTruthy();
    const references = styleBody.styleReferenceImages as Array<Record<string, unknown>>;
    expect(references).toHaveLength(1);
    expect(references[0].name).toBe("style-ref.png");
    expect(String(references[0].dataUrl)).toMatch(/^data:/);
  });
});
