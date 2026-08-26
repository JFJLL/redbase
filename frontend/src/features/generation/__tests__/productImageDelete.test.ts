import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import ProductImagePanel from "../components/ProductImagePanel.vue";
import {
  clearIdeaCreativeSettings,
  getIdeaCreativeSettings,
  saveIdeaCreativeSettings,
  getIdeaSettingsKey,
} from "../ideaCreativeSettings";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const IMAGES = [
  { id: 11, originalName: "产品图A.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
  { id: 12, originalName: "产品图B.png", url: "/api/product-images/12/file?sig=b", sizeBytes: 1024 },
];

describe("ProductImagePanel delete confirmation and cross-idea reference cleanup", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    clearIdeaCreativeSettings();
    saveIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0), {
      aspectRatioSelection: "smart",
      visualStylePreset: "auto",
      wechatTemplate: "auto",
      useBrandLogo: false,
      selectedProductIds: [11, 12],
      videoReferenceImageIds: [11],
      useProductImages: true,
      styleReference: null,
    });
    saveIdeaCreativeSettings(getIdeaSettingsKey(7, 502, 1), {
      aspectRatioSelection: "smart",
      visualStylePreset: "auto",
      wechatTemplate: "auto",
      useBrandLogo: false,
      selectedProductIds: [11],
      videoReferenceImageIds: [11],
      useProductImages: true,
      styleReference: null,
    });
  });

  afterEach(() => {
    clearIdeaCreativeSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountPanel(selectedIds: number[] = [11]) {
    calls = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const method = String(init?.method || "GET");
      if (method === "GET" && url.split("?")[0] === "/api/product-images") {
        return jsonResponse(200, { images: IMAGES });
      }
      if (method === "DELETE" && url === "/api/product-images/11") {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div />" } },
        { path: "/login", name: "login", component: { template: "<div />" } },
      ],
    });
    const wrapper = mount(ProductImagePanel, {
      props: { selectedIds },
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();
    return wrapper;
  }

  it("cancel keeps the image, the selection and every idea setting reference", async () => {
    const wrapper = await mountPanel();

    await wrapper.find('[data-test="product-image-delete-11"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="product-delete-confirm"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="product-delete-impact"]').text()).toContain("2");

    await wrapper.find('[data-test="product-delete-cancel"]').trigger("click");
    await flushPromises();

    expect(calls.some((call) => call.url === "/api/product-images/11" && call.init?.method === "DELETE")).toBe(false);
    expect(wrapper.find('[data-test="product-image-check-11"]').exists()).toBe(true);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0)).selectedProductIds).toEqual([11, 12]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0)).videoReferenceImageIds).toEqual([11]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 502, 1)).selectedProductIds).toEqual([11]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 502, 1)).videoReferenceImageIds).toEqual([11]);
  });

  it("confirm deletes the image and cleans the reference from every idea settings key", async () => {
    const wrapper = await mountPanel();

    await wrapper.find('[data-test="product-image-delete-11"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="product-delete-confirm-action"]').trigger("click");
    await flushPromises();

    expect(calls.some((call) => call.url === "/api/product-images/11" && call.init?.method === "DELETE")).toBe(true);
    expect(wrapper.find('[data-test="product-image-check-11"]').exists()).toBe(false);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0)).selectedProductIds).toEqual([12]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 501, 0)).videoReferenceImageIds).toEqual([]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 502, 1)).selectedProductIds).toEqual([]);
    expect(getIdeaCreativeSettings(getIdeaSettingsKey(7, 502, 1)).videoReferenceImageIds).toEqual([]);
  });
});
