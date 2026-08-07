/**
 * 外层「选择已上传图片」素材库删除入口测试（真实入口：IdeasView）。
 *
 * 目标：
 * 1. 每张当前账号拥有的产品图都有删除操作。
 * 2. 删除前显示被多少选题引用；取消不发 DELETE、不改列表与选择。
 * 3. 确认成功：恰好一次 DELETE，从图库移除，并清理所有选题键位中的失效引用。
 * 4. 后端失败：图片、选择和所有引用保持不变，显示可理解错误。
 * 5. 删除当前已选素材后，下一次生成请求不携带已删除 ID。
 * 6. 账号中止 / 品牌切换时旧响应或旧 UI 不污染新上下文。
 * 仅 mock 全局 fetch，不 mock 业务模块；删除清理规则复用
 * deleteProductImage / countProductImageReferences / removeProductImageFromAllSettings。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { makeBrandDetail, makeIdea, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { useAuthStore } from "@/shared/stores/auth";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import {
  clearIdeaCreativeSettings,
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
} from "@/features/generation/ideaCreativeSettings";
import {
  installFlowFetch,
  makeIdeasRouter,
  jsonResponse,
  postCalls,
  type IdeasFlowOptions,
} from "@/features/generation/__tests__/ideasGenerationHarness";

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

/** 删除 11 的默认成功契约；可传 handler 覆盖响应。 */
function deleteOverride(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () =>
    jsonResponse(200, { ok: true }),
): IdeasFlowOptions["overrides"] {
  return (url, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "DELETE" && url === "/api/product-images/11") return handler(url, init);
    return undefined;
  };
}

async function mountIdeas(
  options: IdeasFlowOptions = {},
  query: Record<string, string> = {},
): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: ReturnType<typeof makeIdeasRouter>;
  fetchMock: ReturnType<typeof installFlowFetch>;
}> {
  const fetchMock = installFlowFetch(options);
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

function deleteCalls(
  fetchMock: ReturnType<typeof installFlowFetch>,
  imageId = 11,
): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === `/api/product-images/${imageId}` &&
      String((init as RequestInit | undefined)?.method || "GET").toUpperCase() === "DELETE",
  ).length;
}

async function openLibrary(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
  await flushPromises();
}

describe("outer library delete entry (选择已上传图片)", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
    // 两张产品图被两个不同选题键位引用（键位 0 引用 11+12，键位 1 引用 11）。
    saveIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0), {
      aspectRatioSelection: "smart",
      visualStylePreset: "auto",
      wechatTemplate: "auto",
      useBrandLogo: false,
      selectedProductIds: [11, 12],
      useProductImages: true,
      styleReference: null,
    });
    saveIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 1), {
      aspectRatioSelection: "smart",
      visualStylePreset: "auto",
      wechatTemplate: "auto",
      useBrandLogo: false,
      selectedProductIds: [11],
      useProductImages: true,
      styleReference: null,
    });
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a delete entry for every owned image in the outer library", async () => {
    const { wrapper } = await mountIdeas(baseOptions(), { brandId: "1", trendId: "5", ideaIndex: "0" });
    await openLibrary(wrapper);

    expect(wrapper.find('[data-test="idea-library-delete-0-11"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-library-delete-0-12"]').exists()).toBe(true);
  });

  it("cancel sends no DELETE and keeps the image, selection and every idea reference", async () => {
    const { wrapper, fetchMock } = await mountIdeas(baseOptions(deleteOverride()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();

    const confirm = wrapper.find('[data-test="library-delete-confirm"]');
    expect(confirm.exists()).toBe(true);
    expect(confirm.find('[data-test="library-delete-impact"]').text()).toContain("2");

    await wrapper.find('[data-test="library-delete-cancel"]').trigger("click");
    await flushPromises();

    expect(deleteCalls(fetchMock)).toBe(0);
    expect(wrapper.find('[data-test="idea-library-check-0-11"]').exists()).toBe(true);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0)).selectedProductIds).toEqual([11, 12]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 1)).selectedProductIds).toEqual([11]);
  });

  it("confirm sends exactly one DELETE, removes the image and cleans every idea reference", async () => {
    const { wrapper, fetchMock } = await mountIdeas(baseOptions(deleteOverride()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="library-delete-confirm-action"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(deleteCalls(fetchMock)).toBe(1);
    expect(wrapper.find('[data-test="idea-library-check-0-11"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="idea-library-check-0-12"]').exists()).toBe(true);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0)).selectedProductIds).toEqual([12]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 1)).selectedProductIds).toEqual([]);
    expect(wrapper.find('[data-test="library-message"]').text()).toContain("已删除");
    // 当前选题卡选中态同步为剩余图片。
    expect(wrapper.find('[data-test="idea-product-upload-0"]').text()).toContain("已选择 1 张");
  });

  it("delete failure keeps the image, selection and all references with a visible error", async () => {
    const { wrapper, fetchMock } = await mountIdeas(
      baseOptions(deleteOverride(() => jsonResponse(500, { error: "后端拒绝删除" }))),
      { brandId: "1", trendId: "5", ideaIndex: "0" },
    );
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="library-delete-confirm-action"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(deleteCalls(fetchMock)).toBe(1);
    expect(wrapper.find('[data-test="library-message"]').text()).toContain("删除失败");
    const checkbox = wrapper.find('[data-test="idea-library-check-0-11"]');
    expect(checkbox.exists()).toBe(true);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 0)).selectedProductIds).toEqual([11, 12]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(1, 5, 1)).selectedProductIds).toEqual([11]);
  });

  it("a deleted image is never used by the next generation request", async () => {
    const { wrapper, fetchMock } = await mountIdeas(baseOptions(deleteOverride()), {
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
    });
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-check-0-11"]').setValue(true);
    await wrapper.find('[data-test="idea-library-check-0-12"]').setValue(true);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="library-delete-confirm-action"]').trigger("click");
    await flushPromises();
    await flushPromises();
    await wrapper.find('[data-test="idea-library-done-0"]').trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const posts = postCalls(fetchMock, "/api/brands/1/trends/5/ideas/0/image");
    expect(posts).toHaveLength(1);
    expect(posts[0].productImages).toEqual([{ id: 12, name: "product-b.png" }]);
  });

  it("account reset during an in-flight delete never applies the stale result", async () => {
    const { wrapper, fetchMock } = await mountIdeas(
      baseOptions((url, init) => {
        const method = String(init?.method || "GET").toUpperCase();
        if (method === "DELETE" && url === "/api/product-images/11") {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal ?? null;
            if (signal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return undefined;
      }),
      { brandId: "1", trendId: "5", ideaIndex: "0" },
    );
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="library-delete-confirm-action"]').trigger("click");
    await flushPromises();

    // DELETE 已发出且在途：账号切换触发 abort。
    notifyAuthReset();
    await flushPromises();
    await flushPromises();

    expect(deleteCalls(fetchMock)).toBe(1);
    // 旧响应未落地：图片仍保留在素材库，也没有成功清理消息。
    expect(wrapper.find('[data-test="idea-library-check-0-11"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="library-message"]').exists()).toBe(false);
  });

  it("switching the brand closes the library and any pending delete dialog", async () => {
    const { wrapper, router } = await mountIdeas(
      baseOptions((url) => {
        if (url === "/api/brands/999") {
          return jsonResponse(200, {
            brand: { id: 999, name: "新品牌", profileType: "brand", logo: null, trends: [] },
          });
        }
        return undefined;
      }),
      { brandId: "1", trendId: "5", ideaIndex: "0" },
    );
    await openLibrary(wrapper);
    await wrapper.find('[data-test="idea-library-delete-0-11"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="library-delete-confirm"]').exists()).toBe(true);

    await router.push({ name: "ideas", query: { brandId: "999", trendId: "5", ideaIndex: "0" } });
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-test="product-library-dialog-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="library-delete-confirm"]').exists()).toBe(false);
  });
});
