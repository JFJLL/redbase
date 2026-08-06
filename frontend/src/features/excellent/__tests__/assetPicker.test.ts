import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import ExcellentView from "../views/ExcellentView.vue";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const LIST_ITEMS = [
  { noteId: "n1", title: "露营装备清单", imageUrls: ["/img/a.jpg"], metrics: { readCount: 10 } },
];

const BRAND_IMAGES = [
  { id: 11, name: "品牌实拍A.png", url: "/api/product-images/11/file?sig=a" },
];

const UNASSIGNED_IMAGES = [
  { id: 22, name: "未归属图B.png", url: "/api/product-images/22/file?sig=b" },
];

const FUSION_PLAN = {
  fusionPlan: {
    contentThesis: "产品图融合测试",
    carouselPack: {
      title: "融合组图",
      publishTitle: "发布标题",
      slides: [{ title: "S1" }, { title: "S2" }, { title: "S3" }, { title: "S4" }],
    },
  },
};

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/login", name: "login", component: { template: "<div />" } },
    ],
  });
}

async function waitMacrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
  }
}

describe("excellent remix asset picker (unassigned claim + in-modal upload)", () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openPicker(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    calls = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const response = await handler(url, init);
      if (!response) throw new Error(`unhandled fetch: ${url}`);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(ExcellentView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();

    await wrapper.find('[data-test="excellent-card"] button').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="remix-open-product-picker"]').trigger("click");
    await flushPromises();
    return wrapper;
  }

  function baseHandler(url: string, init?: RequestInit): Response | undefined {
    const method = String(init?.method || "GET");
    if (url.startsWith("/api/excellent-contents/content-sources")) {
      return jsonResponse(200, { contentSources: [{ value: "buyer", label: "买手推荐" }] });
    }
    if (url.startsWith("/api/excellent-contents/taxonomy")) {
      return jsonResponse(200, { tree: { items: [] } });
    }
    if (url.startsWith("/api/excellent-contents?")) {
      return jsonResponse(200, {
        board: "xhs_hot",
        contentSource: "all",
        categoryPath: "",
        items: LIST_ITEMS,
        updatedAt: "2026-07-01T08:00:00.000Z",
        hasCache: true,
      });
    }
    if (url === "/api/brands") {
      return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }, { id: 8, name: "品牌B" }] });
    }
    if (url.includes("/excellent-remix-ideas")) {
      return jsonResponse(200, { brandId: url.includes("/brands/8/") ? 8 : 7, ideas: [] });
    }
    if (method === "GET" && url.startsWith("/api/product-images?brandId=7")) {
      return jsonResponse(200, {
        brandId: 7,
        images: BRAND_IMAGES,
        unassignedImages: UNASSIGNED_IMAGES,
      });
    }
    if (method === "GET" && url.startsWith("/api/product-images?brandId=8")) {
      return jsonResponse(200, { brandId: 8, images: [], unassignedImages: [] });
    }
    if (method === "POST" && /\/product-images\/\d+\/claim$/.test(url)) {
      return jsonResponse(200, { image: UNASSIGNED_IMAGES[0], brandId: 7 });
    }
    if (url === "/api/excellent-contents/n1/remix-analysis" && method === "POST") {
      return jsonResponse(200, { analysis: { analysisId: "asset-analysis" } });
    }
    if (url === "/api/excellent-contents/n1/fusion-plan" && method === "POST") {
      return jsonResponse(200, FUSION_PLAN);
    }
    if (url === "/api/brands/7/excellent-remix-preview" && method === "POST") {
      return jsonResponse(200, {
        carouselGroupId: "asset-group",
        carouselPack: { ...FUSION_PLAN.fusionPlan.carouselPack, carouselGroupId: "asset-group" },
        user: { id: "1", credits: 8 },
      });
    }
    const slideMatch = url.match(/^\/api\/brands\/7\/excellent-remix\/slides\/(\d+)$/);
    if (slideMatch && method === "POST") {
      return jsonResponse(202, {
        slideJob: { slideIndex: Number(slideMatch[1]), jobId: `asset-job-${slideMatch[1]}` },
        user: { id: "1", credits: 8 },
      });
    }
    if (/^\/api\/image-jobs\/asset-job-\d+$/.test(url) && method === "GET") {
      return jsonResponse(200, {
        status: "completed",
        imageConcept: { imageUrl: "/api/generated-images/88/file?sig=asset" },
      });
    }
    if (url === "/api/brands/7/excellent-remix/complete" && method === "POST") {
      return jsonResponse(200, { generation: { id: 88 }, user: { id: "1", credits: 8 } });
    }
    return undefined;
  }

  async function submitRemixAfterPicker(wrapper: Awaited<ReturnType<typeof openPicker>>): Promise<Array<Record<string, unknown>>> {
    await wrapper.find('[data-test="remix-product-picker"] .excellent-modal-header button').trigger("click");
    await wrapper.find('input[type="radio"][value="custom"]').setValue();
    await wrapper.find('[data-test="custom-direction"]').setValue("使用刚刚选择的产品实拍图生成内容");
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await waitMacrotasks();
    await wrapper.find('[data-test="remix-submit"]').trigger("click");
    await waitMacrotasks();
    return calls
      .filter((call) => /\/excellent-remix\/slides\/\d+$/.test(call.url))
      .map((call) => JSON.parse(String(call.init?.body || "{}")) as Record<string, unknown>);
  }

  it("shows unassigned images with a claim action that posts owner-scoped brandId", async () => {
    const wrapper = await openPicker(baseHandler);

    expect(wrapper.find('[data-test="remix-product-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remix-brand-image-11"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remix-unassigned-image-22"]').exists()).toBe(true);

    await wrapper.find('[data-test="claim-unassigned-22"]').trigger("click");
    await flushPromises();

    const claim = calls.find((call) => call.url === "/api/product-images/22/claim");
    expect(claim).toBeTruthy();
    expect(JSON.parse(String(claim?.init?.body || "{}"))).toEqual({ brandId: 7 });
    // 认领后重新拉取，未归属列表清空。
    const pickerFetches = calls.filter((call) => call.url.startsWith("/api/product-images?brandId=7"));
    expect(pickerFetches.length).toBeGreaterThanOrEqual(2);

    const slideBodies = await submitRemixAfterPicker(wrapper);
    expect(slideBodies).toHaveLength(4);
    for (const body of slideBodies) {
      expect(body.productImages).toEqual([{ id: 22 }]);
    }
  });

  it("uploads inside the picker with brandId so the image lands in the current brand scope", async () => {
    const wrapper = await openPicker((url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/product-images") {
        return jsonResponse(201, { image: { id: 33, name: "新上传.png", url: "/api/product-images/33/file?sig=c" } });
      }
      return baseHandler(url, init);
    });

    const file = new File(["x"], "新上传.png", { type: "image/png" });
    const input = wrapper.find('[data-test="remix-product-upload"]');
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await waitMacrotasks();

    const upload = calls.find((call) => call.url === "/api/product-images" && String(call.init?.method) === "POST");
    expect(upload).toBeTruthy();
    const body = JSON.parse(String(upload?.init?.body || "{}")) as Record<string, unknown>;
    expect(body.brandId).toBe(7);

    const slideBodies = await submitRemixAfterPicker(wrapper);
    expect(slideBodies).toHaveLength(4);
    for (const slideBody of slideBodies) {
      expect(slideBody.productImages).toEqual([{ id: 33 }]);
    }
  });

  it("unauthorized claim surfaces an error and never mutates the selection", async () => {
    const wrapper = await openPicker((url, init) => {
      if (url === "/api/product-images/22/claim") {
        return jsonResponse(401, { error: "请先登录" });
      }
      return baseHandler(url, init);
    });

    await wrapper.find('[data-test="claim-unassigned-22"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="remix-unassigned-image-22"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remix-picker-message"]').exists()).toBe(false);
  });

  it("ignores a late claim response after the remix target switches to another brand", async () => {
    let resolveClaim!: (response: Response) => void;
    const pendingClaim = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });
    const wrapper = await openPicker((url, init) => {
      if (url === "/api/product-images/22/claim") return pendingClaim;
      return baseHandler(url, init);
    });

    void wrapper.find('[data-test="claim-unassigned-22"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="remix-brand"]').setValue("8");
    await flushPromises();

    resolveClaim(jsonResponse(200, { image: UNASSIGNED_IMAGES[0], brandId: 7 }));
    await waitMacrotasks();

    await wrapper.find('[data-test="remix-open-product-picker"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="remix-product-picker"]').text()).toContain("已选 0");
    expect(wrapper.find('[data-test="remix-brand-image-22"]').exists()).toBe(false);
  });
});
