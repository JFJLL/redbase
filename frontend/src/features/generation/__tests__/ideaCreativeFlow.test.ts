/**
 * 创作设置与组图流程契约测试（真实入口：IdeasView + IdeaGenerationDialog）。
 * 覆盖：设置按 品牌ID:趋势ID:选题序号 隔离与恢复、组图每页提示词随 slide 请求提交、
 * 单页失败重试不重复成功页、全部成功只 complete 一次、4 页并发轮询、
 * 单页改图走 POST /api/image-edits、风格参考图进 style-image 请求体、
 * 内容选题页产品图开关进入 moments 请求体。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { clearIdeaCreativeSettings, getIdeaSettingsKey, saveIdeaCreativeSettings } from "../ideaCreativeSettings";
import {
  mountIdeasGeneration,
  postCalls,
  jsonResponse,
  type IdeasFlowOptions,
} from "./ideasGenerationHarness";

const BRAND_DETAIL = {
  brand: makeBrandDetail(
    [
      makeTrend(5, {
        ideas: [
          makeIdea({ title: "选题一", summary: "内容摘要", tags: [] }),
          makeIdea({ title: "选题二", summary: "内容摘要二", tags: [] }),
        ],
      }),
    ],
    {
      id: 1,
      name: "测试品牌",
      logo: {
        originalName: "logo.png",
        url: "/api/brands/1/logo/file?sig=x",
        mimeType: "image/png",
        sizeBytes: 1024,
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01",
      },
    },
  ),
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

function baseOptions(overrides: IdeasFlowOptions["overrides"] = () => undefined): IdeasFlowOptions {
  return { brandId: 1, brandDetail: BRAND_DETAIL, productImages: PRODUCT_IMAGES, overrides };
}

async function openIdeaAction(action: "moments" | "wechat" | "xhsCarousel" | "styleImage", options: IdeasFlowOptions = {}) {
  const mounted = await mountIdeasGeneration(
    { ...baseOptions(), ...options, overrides: options.overrides },
    { brandId: "1", trendId: "5", ideaIndex: "0" },
  );
  const buttonName = action === "xhsCarousel" ? "xhs" : action === "styleImage" ? "style" : action;
  await mounted.wrapper.find(`[data-test="idea-generate-${buttonName}-0"]`).trigger("click");
  await flushPromises();
  await flushPromises();
  return mounted;
}

describe("per-idea creative settings & carousel restoration (real entry)", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps creative settings isolated per 品牌ID:趋势ID:选题序号 and restores them on re-entry", async () => {
    const { wrapper, router } = await mountIdeasGeneration(baseOptions(), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    // 展开选题 0 的创作设置并设置一组非默认值。
    await wrapper.find('[data-test="idea-creative-toggle-0"]').trigger("click");
    await flushPromises();
        await wrapper.find('[data-test="idea-creative-style-0"]').trigger("click");
    await wrapper.find('[data-test="idea-creative-style-0-option-editorial"]').trigger("click");
    expect((wrapper.find('[data-test="idea-creative-template-0"]').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find('[data-test="idea-creative-duration-0"]').exists()).toBe(false);
    await wrapper.find('[data-test="idea-ratio-0-1:1"]').trigger("click");

    await wrapper.find('[data-test="idea-use-brand-logo-0"]').setValue(true);
    await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="idea-library-check-0-11"]').setValue(true);
    await wrapper.find('[data-test="idea-library-done-0"]').trigger("click");
    await flushPromises();

    // 切到选题 1：必须是默认值，不得串值。
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "1" } });
    await flushPromises();
    await wrapper.find('[data-test="idea-creative-toggle-1"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="idea-creative-style-1"]').text()).toContain("智能匹配");
    expect(wrapper.find('[data-test="idea-creative-template-1"]').text()).toContain("智能配色");
    expect(wrapper.find('[data-test="idea-ratio-1-smart"]').classes()).toContain("is-selected");
    expect((wrapper.find('[data-test="idea-use-brand-logo-1"]').element as HTMLInputElement).checked).toBe(false);

    // 选题 1 设置另一组值。
    await wrapper.find('[data-test="idea-ratio-1-16:9"]').trigger("click");
    await flushPromises();

    // 回到选题 0：恢复选题 0 自己的设置。
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await flushPromises();
        expect(wrapper.find('[data-test="idea-creative-style-0"]').text()).toContain("杂志编辑感");
    expect(wrapper.find('[data-test="idea-creative-template-0"]').text()).toContain("智能配色");
    expect((wrapper.find('[data-test="idea-creative-template-0"]').element as HTMLButtonElement).disabled).toBe(true);

    expect(wrapper.find('[data-test="idea-ratio-0-1:1"]').classes()).toContain("is-selected");
    expect((wrapper.find('[data-test="idea-use-brand-logo-0"]').element as HTMLInputElement).checked).toBe(true);

    // 再切回选题 1：仍是 16:9。
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "1" } });
    await flushPromises();
    expect(wrapper.find('[data-test="idea-ratio-1-16:9"]').classes()).toContain("is-selected");
  });

  it("submits the edited per-page prompt inside the slide request body", async () => {
    const { wrapper, fetchMock } = await openIdeaAction("xhsCarousel", {
      overrides: (url) => (url.includes("/xhs-carousel/preview") ? jsonResponse(200, PREVIEW_PACK_4) : undefined),
    });

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
    const { wrapper, fetchMock } = await openIdeaAction("xhsCarousel", {
      overrides: (url, init) => {
        const path = String(url).split("?")[0];
        const method = String(init?.method || "GET");
        if (method === "POST" && path.endsWith("/xhs-carousel/preview")) return jsonResponse(200, PREVIEW_PACK_4);
        if (method === "POST" && path.endsWith("/xhs-carousel/slides/1")) {
          slide1Attempts += 1;
          if (slide1Attempts === 1) return jsonResponse(500, { error: "生成通道拥堵" });
          return jsonResponse(202, { slideJob: { slideIndex: 1, jobId: "s1" }, creditEventId: 9, user: { id: "u1" } });
        }
        return undefined;
      },
    });

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();

    const completeUrl = "/api/brands/1/trends/5/ideas/0/xhs-carousel/complete";
    expect(postCalls(fetchMock, completeUrl)).toHaveLength(0);
    expect(wrapper.find('[data-test="xhs-slide-1"]').text()).toContain("生成失败");

    await wrapper.find('[data-test="generate-xhs-slide-1"]').trigger("click");
    await flushPromises();

    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/0")).toHaveLength(1);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/1")).toHaveLength(2);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/2")).toHaveLength(1);
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/3")).toHaveLength(1);
    const completes = postCalls(fetchMock, completeUrl);
    expect(completes).toHaveLength(1);
    expect(completes[0].creditEventId).toBe(9);

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();
    expect(postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/xhs-carousel/slides/")).toHaveLength(5);
    expect(postCalls(fetchMock, completeUrl)).toHaveLength(1);
  });

  it("polls the four slide jobs concurrently — ≥2 distinct jobs in flight within 5s", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, fetchMock } = await mountIdeasGeneration(
        {
          ...baseOptions(
            (url, init) => {
              const path = String(url).split("?")[0];
              const method = String(init?.method || "GET");
              if (method === "POST" && path.endsWith("/xhs-carousel/preview")) return jsonResponse(200, PREVIEW_PACK_4);
              if (method === "POST" && path.includes("/xhs-carousel/slides/")) {
                const index = Number(path.match(/\/slides\/(\d+)$/)?.[1] || 0);
                const jobId = ["job-a", "job-b", "job-c", "job-d"][index];
                return jsonResponse(202, { slideJob: { slideIndex: index, jobId }, creditEventId: 9, user: { id: "u1" } });
              }
              if (method === "GET" && path.startsWith("/api/image-jobs/")) {
                return jsonResponse(200, { status: "pending" });
              }
              return undefined;
            },
          ),
        },
        { brandId: "1", trendId: "5", ideaIndex: "0", action: "xhsCarousel" },
      );
      await vi.advanceTimersByTimeAsync(0);
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

      await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
      await flushPromises();
      const polled = distinctPolledJobs();
      expect(polled.size).toBeGreaterThanOrEqual(2);
      expect(polled).toEqual(new Set(["job-a", "job-b", "job-c", "job-d"]));
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
    const { wrapper, fetchMock } = await openIdeaAction("xhsCarousel", {
      overrides: (url, init) => {
        const path = String(url).split("?")[0];
        const method = String(init?.method || "GET");
        if (method === "POST" && path.endsWith("/xhs-carousel/preview")) return jsonResponse(200, previewOnePage);
        if (method === "POST" && path === "/api/image-edits") {
          return jsonResponse(202, { jobId: "edit-1", user: { id: "u1" } });
        }
        return undefined;
      },
    });

    await wrapper.find('[data-test="generate-xhs-slide-0"]').trigger("click");
    await flushPromises();

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
    const { wrapper, router, fetchMock } = await mountIdeasGeneration(baseOptions(), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    const input = wrapper.find('[data-test="idea-style-input-0"]');
    const file = new File(["style-bytes"], "style-ref.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !wrapper.find('[data-test="idea-style-name-0"]').exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(wrapper.find('[data-test="idea-style-name-0"]').text()).toContain("style-ref.png");

    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "styleImage" } });
    await flushPromises();
    await flushPromises();

    const [styleBody] = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/style-image");
    expect(styleBody).toBeTruthy();
    const references = styleBody.styleReferenceImages as Array<Record<string, unknown>>;
    expect(references).toHaveLength(1);
    expect(references[0].name).toBe("style-ref.png");
    expect(String(references[0].dataUrl)).toMatch(/^data:/);
  });

  it("respects the ideas-page product usage gate in the moments request body", async () => {
    clearIdeaCreativeSettings();
    saveIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0), {
      aspectRatioSelection: "smart",
      visualStylePreset: "auto",
      wechatTemplate: "auto",
      useBrandLogo: false,
      selectedProductIds: [11],
      useProductImages: false,
      styleReference: null,
    });
    const { fetchMock } = await openIdeaAction("moments");

    const [body] = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image");
    expect(body).toBeTruthy();
    expect(body.productImages).toEqual([]);
    expect(body.useBrandLogo).toBe(false);
  });
});
