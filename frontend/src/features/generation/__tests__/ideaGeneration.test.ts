/**
 * 生图能力行为与请求契约测试（真实入口：IdeasView + IdeaGenerationDialog）。
 * 覆盖：品牌/趋势/选题上下文、单图/组图/公众号/风格化请求体、创作设置、
 * 上传删除、轮询中止与失败重试。仅 mock 全局 fetch，不 mock 业务模块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { clearIdeaCreativeSettings } from "../ideaCreativeSettings";
import {
  mountIdeasGeneration,
  jsonResponse,
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
  return {
    brandId: 1,
    brandDetail: BRAND_DETAIL,
    productImages: PRODUCT_IMAGES,
    overrides,
  };
}

async function openIdeaAction(action: "moments" | "wechat" | "xhsCarousel" | "styleImage", options: IdeasFlowOptions = {}) {
  const mounted = await mountIdeasGeneration(
    { ...baseOptions(), ...options, overrides: options.overrides },
    { brandId: "1", trendId: "5", ideaIndex: "0" },
  );
  const buttonName = action === "xhsCarousel" ? "xhs" : action === "styleImage" ? "style" : action;
  const button = `idea-generate-${buttonName}-0`;
  await mounted.wrapper.find(`[data-test="${button}"]`).trigger("click");
  await flushPromises();
  await flushPromises();
  return mounted;
}

function callBody(
  fetchMock: Awaited<ReturnType<typeof mountIdeasGeneration>>["fetchMock"],
  method: string,
  urlPrefix: string,
): unknown {
  const call = fetchMock.mock.calls.find((entry) => {
    const url = String(entry[0]);
    const init = entry[1] as RequestInit | undefined;
    return (init?.method || "GET").toUpperCase() === method && url.startsWith(urlPrefix);
  });
  if (!call) return undefined;
  const body = (call[1] as RequestInit | undefined)?.body;
  return body ? JSON.parse(String(body)) : undefined;
}

describe("idea generation through the real ideas entry", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads brand detail and shows the brand×trend×idea summary", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(baseOptions(), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    const brandCall = fetchMock.mock.calls.find((entry) => String(entry[0]) === "/api/brands/1");
    expect(brandCall).toBeTruthy();
    const summary = wrapper.find('[data-test="idea-context"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("测试品牌");
    expect(summary.text()).toContain("夏日趋势");
    expect(wrapper.find('[data-test="idea-list"]').text()).toContain("选题一");
  });

  it("submits the moments image body with a selected product image and default 3:4 ratio", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(baseOptions(), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });

    // 通过选题卡素材库勾选产品图，再一键生成。
    await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="idea-library-check-0-11"]').setValue(true);
    await wrapper.find('[data-test="idea-library-done-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
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
    let completeCalled = false;
    const { wrapper, fetchMock } = await openIdeaAction("xhsCarousel", {
      overrides: (url) => {
        if (url.includes("/xhs-carousel/preview")) return jsonResponse(200, PREVIEW_PACK_4);
        if (url.includes("/xhs-carousel/complete")) {
          completeCalled = true;
          return jsonResponse(200, { generation: { id: 7 }, user: { id: "u1" } });
        }
        return undefined;
      },
    });

    const previewBody = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/xhs-carousel/preview");
    expect(previewBody).toEqual({ aspectRatio: "3:4", visualStylePreset: "auto" });
    expect(wrapper.find('[data-test="xhs-result"]').exists()).toBe(true);

    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();

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

    const completeBody = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/xhs-carousel/complete") as Record<
      string,
      unknown
    >;
    expect(completeCalled).toBe(true);
    expect(completeBody.creditEventId).toBe(9);
  });

  it("submits the wechat long image body with template and default 9:21 ratio", async () => {
    const { wrapper, fetchMock } = await openIdeaAction("wechat");

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/wechat-long-image") as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ productImages: [], useBrandLogo: false, wechatTemplate: "auto", aspectRatio: "9:21" });
    expect(wrapper.find('[data-test="wechat-result"]').text()).toContain("发布标题");
  });

  it("submits the style image body built from the idea fields", async () => {
    const { wrapper, fetchMock } = await openIdeaAction("styleImage");

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/style-image") as Record<string, unknown>;
    expect(body.title).toBe("选题一");
    expect(body.aspectRatio).toBe("3:4");
    expect(body.useBrandLogo).toBe(false);
    expect(String(body.stylePrompt)).toContain("内容摘要");
    expect(body.styleReferenceImages).toEqual([]);
    expect(wrapper.find('[data-test="style-result"]').exists()).toBe(true);
  });

  it("uploads a product image from the idea card and the next request carries it", async () => {
    let uploaded = false;
    const { wrapper, fetchMock } = await mountIdeasGeneration(
      baseOptions((url, init) => {
        const method = String(init?.method || "GET");
        if (method === "POST" && url === "/api/product-images") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.name).toBe("upload.png");
          expect(String(body.dataUrl)).toContain("data:");
          uploaded = true;
          return jsonResponse(201, {
            image: { id: 22, originalName: "upload.png", url: "/api/product-images/22/file?sig=u", sizeBytes: 1000 },
          });
        }
        return undefined;
      }),
      { brandId: "1", trendId: "5", ideaIndex: "0" },
    );

    // 上传入口只在外层选题卡（唯一素材入口），弹窗内不再有产品图库。
    const input = wrapper.find('[data-test="idea-product-upload-input-0"]');
    const file = new File(["hello-bytes"], "upload.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !uploaded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(uploaded).toBe(true);

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const body = callBody(fetchMock, "POST", "/api/brands/1/trends/5/ideas/0/image") as Record<string, unknown>;
    expect(body.productImages).toEqual([{ id: 22, name: "upload.png" }]);
  });

  it("keeps upload inside the outer idea card and shows the library dialog there", async () => {
    const { wrapper } = await mountIdeasGeneration(
      baseOptions(),
      { brandId: "1", trendId: "5", ideaIndex: "0" },
    );

    await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="product-library-dialog-0"]').exists()).toBe(true);
    wrapper.find('[data-test="idea-library-close-0"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="product-library-dialog-0"]').exists()).toBe(false);
  });

  it("keeps product image upload and delete controls out of the generation dialog", async () => {
    let uploaded = false;
    let deleted = false;
    const { wrapper } = await openIdeaAction("moments", {
      overrides: (url, init) => {
        const method = String(init?.method || "GET");
        if (method === "POST" && url === "/api/product-images") {
          uploaded = true;
          return undefined;
        }
        return undefined;
      },
    });

    // 弹窗只负责生成进度/结果/改图，不再渲染产品图库（上传/选择/删除 UI）。
    expect(wrapper.find('[data-test="product-image-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="product-image-upload"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="product-image-delete-22"]').exists()).toBe(false);
    expect(uploaded).toBe(false);
    expect(deleted).toBe(false);
  });

  it("stops polling when the view unmounts mid-generation", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, fetchMock } = await mountIdeasGeneration(
        {
          ...baseOptions(),
          overrides: (url, init) => {
            const method = String(init?.method || "GET");
            if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
              return jsonResponse(202, { jobId: "job-poll", user: { id: "u1" } });
            }
            if (method === "GET" && url.startsWith("/api/image-jobs/")) {
              return jsonResponse(200, { status: "pending" });
            }
            return undefined;
          },
        },
        { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
      );
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();

      const pollCount = () =>
        fetchMock.mock.calls.filter((entry) => String(entry[0]).startsWith("/api/image-jobs/")).length;
      await vi.advanceTimersByTimeAsync(0);
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

  it("shows the full idea fields plus materials from the selected topic", async () => {
    const { wrapper } = await mountIdeasGeneration(
      baseOptions(),
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
    );

    const cards = wrapper.find('[data-test="idea-list"]');
    expect(cards.text()).toContain("内容摘要");
    expect(cards.text()).toContain("切入角度");
    expect(cards.text()).toContain("品牌结合方式");
    expect(cards.text()).toContain("面向人群");
    expect(cards.text()).toContain("开头钩子");
    expect(wrapper.find('[data-test="idea-use-brand-logo-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-style-upload-0"]').exists()).toBe(true);
    // 弹窗 DOM 不再包含产品图库；图库入口只在外层选题卡。
    expect(wrapper.find('[data-test="product-image-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="idea-product-upload-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-open-library-0"]').exists()).toBe(true);
  });

  it("auto-starts the requested generation from the action query and completes it", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(
      baseOptions(),
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
    );

    const imageCalls = fetchMock.mock.calls.filter((entry) => {
      const url = String(entry[0]);
      const init = entry[1] as RequestInit | undefined;
      return (init?.method || "GET").toUpperCase() === "POST" && url === "/api/brands/1/trends/5/ideas/0/image";
    });
    expect(imageCalls).toHaveLength(1);
    expect(wrapper.find('[data-test="moments-result"]').text()).toContain("生成标题");
  });

  it("shows the queued status while running and recovers from failure with a retry button", async () => {
    let attempts = 0;
    let resolveSubmit!: (response: Response) => void;
    const submitGate = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    const { wrapper } = await mountIdeasGeneration(
      {
        ...baseOptions(
          (url, init) => {
            const method = String(init?.method || "GET");
            if (method === "POST" && url === "/api/brands/1/trends/5/ideas/0/image") {
              attempts += 1;
              if (attempts === 1) return submitGate;
              return jsonResponse(202, { jobId: `m${attempts}`, user: { id: "u1" } });
            }
            if (method === "GET" && url.startsWith("/api/image-jobs/")) {
              if (attempts === 1) return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
              return jsonResponse(200, {
                status: "completed",
                imageConcept: { title: "重试成功", imageUrl: "/api/generated-images/2/file?sig=x" },
                generationId: 2,
                persisted: true,
              });
            }
            return undefined;
          },
        ),
      },
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
    );

    // 票据消费（router.replace）为异步：冲刷后首个提交仍在途，队列状态可见。
    await flushPromises();
    expect(wrapper.find('[data-test="gen-status"]').text()).toContain("队列");
    resolveSubmit(jsonResponse(202, { jobId: "m1", user: { id: "u1" } }));
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-test="gen-error"]').text()).toContain("生成通道拥堵");
    expect(wrapper.find('[data-test="gen-retry"]').exists()).toBe(true);

    await wrapper.find('[data-test="gen-retry"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="moments-result"]').text()).toContain("重试成功");
  });

  it("continues editing a generated moments result with its generationId chain", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(
      {
        ...baseOptions(
          (url, init) => {
            const method = String(init?.method || "GET");
            if (method === "POST" && url === "/api/image-edits") {
              return jsonResponse(202, { jobId: "edit-9", user: { id: "u1" } });
            }
            return undefined;
          },
        ),
      },
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
    );

    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);
    await wrapper.find('[data-test="edit-moments-result"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("把背景换成夜晚咖啡馆");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/image-edits" && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(1);
    expect(body.imageUrl).toBe("/api/generated-images/1/file?sig=z");
    expect(wrapper.find('[data-test="image-edit-status"]').text()).toContain("改图完成");
  });

  it("continues editing a generated wechat result with its generationId chain", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(
      {
        ...baseOptions(
          (url, init) => {
            const method = String(init?.method || "GET");
            if (method === "POST" && url === "/api/image-edits") {
              return jsonResponse(202, { jobId: "edit-w1", user: { id: "u1" } });
            }
            return undefined;
          },
        ),
      },
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "wechat" },
    );

    expect(wrapper.find('[data-test="wechat-result"]').exists()).toBe(true);
    await wrapper.find('[data-test="edit-wechat-result"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("换成秋季暖色排版");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/image-edits" && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(1);
    expect(wrapper.find('[data-test="image-edit-status"]').text()).toContain("改图完成");
  });

  it("closing the generation dialog hands the active job to the global recovery rescan", async () => {
    const { wrapper, fetchMock } = await mountIdeasGeneration(
      baseOptions(),
      { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" },
    );
    expect(wrapper.find('[data-test="moments-result"]').exists()).toBe(true);

    await wrapper.find('[data-test="idea-generation-close"]').trigger("click");
    await flushPromises();

    const activeFetches = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/image-jobs/active");
    expect(activeFetches.length).toBeGreaterThanOrEqual(1);
  });
});
