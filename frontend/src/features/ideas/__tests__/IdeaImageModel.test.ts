import { afterEach, describe, expect, it } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "../views/IdeasView.vue";
import {
  getIdeaCreativeSettings,
  saveIdeaCreativeSettings,
  clearIdeaCreativeSettings,
} from "@/features/generation/ideaCreativeSettings";
import {
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeTestRouter,
  makeTrend,
  type FetchHandler,
} from "@/features/trends/__tests__/insightsTestUtils";
import { mount } from "@vue/test-utils";

function baseHandler(): FetchHandler {
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail([makeTrend(501)]) });
    }
    if (method === "GET" && url === "/api/product-images") {
      return jsonResponse(200, { images: [] });
    }
    return undefined;
  };
}

describe("Idea Image Model Settings and Cost Display", () => {
  afterEach(() => {
    clearIdeaCreativeSettings();
  });

  it("defaults to image2 and persists image2.5 correctly", () => {
    const defaultSettings = getIdeaCreativeSettings("test:key:0");
    expect(defaultSettings.imageModel).toBe("image2");

    saveIdeaCreativeSettings("test:key:0", {
      ...defaultSettings,
      imageModel: "image2.5",
    });

    const saved = getIdeaCreativeSettings("test:key:0");
    expect(saved.imageModel).toBe("image2.5");

    // Invalid value falls back to image2
    saveIdeaCreativeSettings("test:key:0", {
      ...defaultSettings,
      imageModel: "unknown-model",
    });
    const sanitized = getIdeaCreativeSettings("test:key:0");
    expect(sanitized.imageModel).toBe("image2");
  });

  it("dynamically updates action button cost badges when image model changes", async () => {
    installFetchMock(baseHandler());
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 20 };
    auth.sessionLoaded = true;

    const router = makeTestRouter();
    await router.push("/ideas?brandId=7&trendId=501");
    await router.isReady();

    const wrapper = mount(IdeasView, {
      global: {
        plugins: [pinia, router],
      },
    });

    await flushPromises();

    // Default model image2: costs are 1, 1, 4, 1
    const momentsBtn = wrapper.find('[data-test="idea-generate-moments-0"]');
    const wechatBtn = wrapper.find('[data-test="idea-generate-wechat-0"]');
    const xhsBtn = wrapper.find('[data-test="idea-generate-xhs-0"]');
    const scriptBtn = wrapper.find('[data-test="idea-generate-script-0"]');

    expect(momentsBtn.text()).toContain("1 积分");
    expect(wechatBtn.text()).toContain("1 积分");
    expect(xhsBtn.text()).toContain("4 积分");
    expect(scriptBtn.text()).toContain("1 积分");

    // Open creative settings panel
    const openSettingsBtn = wrapper.find('[data-test="idea-creative-toggle-0"]');
    await openSettingsBtn.trigger("click");
    await flushPromises();

    // Verify model select exists with testId
    const modelSelect = wrapper.find('[data-test="idea-creative-model-0"]');
    expect(modelSelect.exists()).toBe(true);
    expect(modelSelect.text()).toBe("image2");

    // Switch model to image2.5
    await modelSelect.trigger("click");
    await flushPromises();

    const option25 = wrapper.find('[data-test="idea-creative-model-0-option-image2.5"]');
    expect(option25.exists()).toBe(true);
    await option25.trigger("click");
    await flushPromises();

    // Now costs should reflect image2.5 pricing: moments 2, wechat 2, xhs 8, script stays 1
    expect(wrapper.find('[data-test="idea-generate-moments-0"]').text()).toContain("2 积分");
    expect(wrapper.find('[data-test="idea-generate-wechat-0"]').text()).toContain("2 积分");
    expect(wrapper.find('[data-test="idea-generate-xhs-0"]').text()).toContain("8 积分");
    expect(wrapper.find('[data-test="idea-generate-script-0"]').text()).toContain("1 积分");

    // Switch back to image2
    await modelSelect.trigger("click");
    await flushPromises();
    const option2 = wrapper.find('[data-test="idea-creative-model-0-option-image2"]');
    await option2.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="idea-generate-moments-0"]').text()).toContain("1 积分");
    expect(wrapper.find('[data-test="idea-generate-wechat-0"]').text()).toContain("1 积分");
    expect(wrapper.find('[data-test="idea-generate-xhs-0"]').text()).toContain("4 积分");
    expect(wrapper.find('[data-test="idea-generate-script-0"]').text()).toContain("1 积分");
  });

  it("passes model 'image2.5' in request body when image2.5 is selected", async () => {
    let postedBody: Record<string, any> | null = null;
    const handler: FetchHandler = (url, init) => {
      const method = String(init?.method || "GET");
      if (method === "POST" && url.includes("/image")) {
        postedBody = JSON.parse(String(init?.body || "{}"));
        return jsonResponse(200, { jobId: "job-25", user: { credits: 18 } });
      }
      return baseHandler()(url, init);
    };

    installFetchMock(handler);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 20 };
    auth.sessionLoaded = true;

    const router = makeTestRouter();
    await router.push("/ideas?brandId=7&trendId=501");
    await router.isReady();

    const wrapper = mount(IdeasView, {
      global: {
        plugins: [pinia, router],
      },
    });
    await flushPromises();

    // Open settings and pick image2.5
    await wrapper.find('[data-test="idea-creative-toggle-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="idea-creative-model-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="idea-creative-model-0-option-image2.5"]').trigger("click");
    await flushPromises();

    // Click generate moments image
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();

    expect((postedBody as any)?.model).toBe("image2.5");
  });
});
