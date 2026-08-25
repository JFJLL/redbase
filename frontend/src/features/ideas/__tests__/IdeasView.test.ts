import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "../views/IdeasView.vue";
import { MAX_SINGLE_UPLOAD_IMAGE_BYTES } from "@/features/generation/api";
import {
  callsTo,
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeIdea,
  makeTestRouter,
  makeTrend,
  requestBody,
  type FetchHandler,
} from "@/features/trends/__tests__/insightsTestUtils";

const PRODUCT_LIBRARY = {
  images: [
    { id: 11, originalName: "产品图A.png", url: "/api/product-images/11/file?sig=a", sizeBytes: 2048 },
    { id: 12, originalName: "产品图B.png", url: "/api/product-images/12/file?sig=b", sizeBytes: 4096 },
  ],
};

function makeLogo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    originalName: "9c953d46-ce43-4f3a-8b1e-brand-logo.png",
    url: "/api/brands/7/logo/file?sig=x",
    mimeType: "image/png",
    sizeBytes: 1024,
    createdAt: "2026-07-01",
    updatedAt: "2026-07-01",
    ...overrides,
  };
}

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
      return jsonResponse(200, PRODUCT_LIBRARY);
    }
    return undefined;
  };
}

function mountIdeas(handler: FetchHandler) {
  const fetchMock = installFetchMock(handler);
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const router = makeTestRouter();
  const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
  return { wrapper, fetchMock, auth, router };
}

describe("IdeasView", () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the idea context and every idea field from the backend", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const context = wrapper.find('[data-test="idea-context"]');
    expect(context.text()).toContain("红磨坊咖啡 × 秋日第一杯咖啡");
    expect(context.text()).toContain("热点适配原因：与品牌人群和场景高度重合");
    expect(context.text()).toContain("品牌资料库：当前未补充品牌资料库。");
    expect(context.text()).toContain("咖啡");

    const cards = wrapper.findAll('[data-test="idea-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain("通勤咖啡自由指南");
    expect(cards[0].text()).toContain("内容摘要：从办公室场景讲清手冲的性价比");
    expect(cards[0].text()).toContain("切入角度：职场人省钱又讲究的一杯");
    expect(cards[0].text()).toContain("品牌结合方式：结合品牌豆单与冲煮器具做场景种草");
    expect(cards[0].text()).toContain("面向人群：一线城市上班族");
    expect(cards[0].text()).toContain("开头钩子：工位上的第一口秋天");
    expect(cards[0].text()).toContain("#咖啡日常");
    expect(cards[0].find('[data-test="idea-assets-incomplete"]').exists()).toBe(false);
    expect(cards[0].text()).not.toContain("缺少完整内容资产");
    expect(cards[0].text()).not.toContain("朋友圈标题：");
    expect(cards[0].text()).not.toContain("小红书文案：");
  });

  it("regenerates ideas with the custom prompt and applies trend + credits from the response", async () => {
    const regeneratedTrend = makeTrend(501, {
      customPrompt: "更高级一些",
      ideas: [makeIdea({ title: "重新生成的选题 A" }), makeIdea({ title: "重新生成的选题 B" })],
    });
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/brands/7/trends/501/ideas/regenerate") {
        return jsonResponse(200, {
          trend: regeneratedTrend,
          user: { id: "1", name: "测试用户", phone: "13800000000", credits: 4 },
        });
      }
      return baseHandler()(url, init);
    };
    const mounted = mountIdeas(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="custom-idea-prompt"]').setValue("  更高级一些  ");
    await wrapper.find('[data-test="regenerate-ideas"]').trigger("click");
    await flushPromises();

    const calls = callsTo(mounted.fetchMock, "/api/brands/7/trends/501/ideas/regenerate", "POST");
    expect(calls).toHaveLength(1);
    expect(requestBody(calls[0][1])).toEqual({ customPrompt: "更高级一些" });

    expect(wrapper.find('[data-test="idea-prompt-meta"]').text()).toBe(
      "已按你的补充提示词重新生成。当前额外要求：更高级一些",
    );
    expect(wrapper.text()).toContain("重新生成的选题 A");
    expect(mounted.auth.user?.credits).toBe(4);
  });

  it("shows the backend regenerate error text verbatim in the prompt meta", async () => {
    const errorText = "积分不足，本次操作需要 1 积分，当前剩余 0 积分。";
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/brands/7/trends/501/ideas/regenerate") {
        return jsonResponse(402, { error: errorText });
      }
      return baseHandler()(url, init);
    };
    const mounted = mountIdeas(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="regenerate-ideas"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="idea-prompt-meta"]').text()).toBe(`生成失败：${errorText}`);
    expect(wrapper.find('[data-test="regenerate-ideas"]').attributes("disabled")).toBeUndefined();
  });

  it("saves an edited idea via PATCH with all six editable fields", async () => {
    const updatedTrend = makeTrend(501, {
      ideas: [makeIdea({ title: "改后的标题" }), makeIdea({ title: "秋日咖啡拍照攻略" })],
    });
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "PATCH" && url === "/api/brands/7/trends/501/ideas/0") {
        return jsonResponse(200, { trend: updatedTrend, idea: updatedTrend.ideas[0] });
      }
      return baseHandler()(url, init);
    };
    const mounted = mountIdeas(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.findAll('[data-test="edit-idea"]')[0].trigger("click");
    await wrapper.find('input[name="title"]').setValue("改后的标题");
    await wrapper.find("form.idea-edit-form").trigger("submit");
    await flushPromises();

    const calls = callsTo(mounted.fetchMock, "/api/brands/7/trends/501/ideas/0", "PATCH");
    expect(calls).toHaveLength(1);
    expect(requestBody(calls[0][1])).toEqual({
      title: "改后的标题",
      summary: "从办公室场景讲清手冲的性价比",
      angle: "职场人省钱又讲究的一杯",
      brandFit: "结合品牌豆单与冲煮器具做场景种草",
      audience: "一线城市上班族",
      hook: "工位上的第一口秋天",
    });
    expect(wrapper.text()).toContain("改后的标题");
  });

  it("opens the in-page generation dialog with brand/trend/idea context and the target action", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();

    // 内容选题直接承接生成：不再跳独立生图页。
    expect(mounted.router.currentRoute.value.name).toBe("ideas");
    const query = mounted.router.currentRoute.value.query;
    expect(query.brandId).toBe("7");
    expect(query.trendId).toBe("501");
    expect(query.ideaIndex).toBe("0");
    // action 一次性票据：对话框自动启动后即被消费（此处允许已消费或未消费两种中间态，
    // 「恰好一次 POST」由 IdeaGenerationInIdeas 集成测试精确断言）。
    expect(["moments", undefined]).toContain(query.action);
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
  });

  it("keeps deep-link brandId/trendId context after a fresh store load (refresh/return)", async () => {
    // 品牌列表的第一位不是深链目标品牌：loadBrands 的 syncOwner 首次会重置
    // 选中态，若 query 上下文在列表就绪后没有重新套用，页面会错误选中第一品牌。
    const handler: FetchHandler = (url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/brands?summary=1") {
        return jsonResponse(200, {
          brands: [makeBrandSummary({ id: 99, name: "第一顺位品牌" }), makeBrandSummary({ id: 7, name: "红磨坊咖啡" })],
        });
      }
      if (method === "GET" && url === "/api/brands/7") {
        return jsonResponse(200, { brand: makeBrandDetail([makeTrend(501)]) });
      }
      if (method === "GET" && url === "/api/product-images") {
        return jsonResponse(200, PRODUCT_LIBRARY);
      }
      return undefined;
    };
    const fetchMock = installFetchMock(handler);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    const router = makeTestRouter();
    await router.push("/ideas?brandId=7&trendId=501");
    await router.isReady();
    wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    const context = wrapper.find('[data-test="idea-context"]');
    expect(context.text()).toContain("红磨坊咖啡 × 秋日第一杯咖啡");
    expect(context.text()).not.toContain("第一顺位品牌");
    expect(wrapper.findAll('[data-test="idea-card"]')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("renders the ready status, context tags, and every per-idea generation control from 图4", async () => {
    const brand = makeBrandDetail([makeTrend(501)], {
      logo: makeLogo(),
      knowledgeBase: "咖啡豆单与冲煮器具",
      assetTags: ["大健康", "品牌认知", "种草转化", "产品卖点", "内容运营"],
    });
    const mounted = mountIdeas((url, init) => {
      if (String(init?.method || "GET") === "GET" && url === "/api/brands/7") {
        return jsonResponse(200, { brand });
      }
      return baseHandler()(url, init);
    });
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const context = wrapper.find('[data-test="idea-context"]');
    expect(wrapper.find('[data-test="idea-status-dot"]').exists()).toBe(true);
    for (const tag of ["大健康", "品牌认知", "种草转化", "产品卖点", "内容运营"]) {
      expect(context.text()).toContain(tag);
    }
    expect(context.text()).toContain("热点适配原因：与品牌人群和场景高度重合");
    expect(context.text()).toContain("品牌资料库：咖啡豆单与冲煮器具");

    const card = wrapper.findAll('[data-test="idea-card"]')[0];
    const logoControl = card.find('[data-test="idea-logo-control-0"]');
    expect(logoControl.text()).toContain("使用品牌 Logo");
    expect(logoControl.text()).toContain("本次不使用 Logo");
    expect(logoControl.text()).not.toContain("9c953d46-ce43");
    expect(logoControl.text()).toContain("更换 Logo");

    const product = card.find('[data-test="idea-product-upload-0"]');
    expect(product.text()).toContain("未选择产品图");
    expect(product.text()).toContain("最多 10 张，共 30.0MB；当前 0 张");
    expect(product.text()).toContain("上传产品图");
    expect(product.text()).toContain("选择已上传图片");
    expect(product.text()).toContain("使用这些产品图生成图片");

    const style = card.find('[data-test="idea-style-upload-0"]');
    expect(style.text()).toContain("未选择参考图");
    expect(style.text()).toContain("只能上传 1 张，10.0MB 内");

    const settings = card.find('[data-test="idea-creative-settings-0"]');
    expect(settings.text()).toContain("创作设置");
    expect(settings.text()).toContain("生成前可选调整");
    expect(settings.text()).toContain("调整设置");
    expect(settings.text()).not.toContain("小红书：智能匹配");
    expect(settings.find(".idea-creative-settings-icon").exists()).toBe(false);

    await card.find('[data-test="idea-creative-toggle-0"]').trigger("click");
    expect(settings.text()).toContain("收起设置");
    expect(settings.text()).toContain("按生成类型单独设置");

    expect(settings.text()).toContain("各项仅影响对应生成入口，互不叠加");
    expect(settings.text()).toContain("小红书组图 · 视觉路线");
    expect(settings.text()).toContain("公众号长图 · 版式模板");
    expect(settings.text()).toContain("视频脚本 · 时长");
    expect(settings.text()).toContain("图片通用设置");
    expect(settings.text()).toContain("统一影响朋友圈、公众号长图和小红书组图");
  });

  it("opens the dialog from each of the four cost buttons with the correct action and cost label", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const expectations: Array<[string, string, string, string, string]> = [
      ["idea-generate-moments-0", "moments", "1 积分", "idea-generation-dialog", "idea-generation-close"],
      ["idea-generate-wechat-0", "wechat", "1 积分", "idea-generation-dialog", "idea-generation-close"],
      ["idea-generate-xhs-0", "xhsCarousel", "4 积分", "idea-generation-dialog", "idea-generation-close"],
      ["idea-generate-script-0", "videoScript", "1 积分", "idea-video-script-dialog", "video-script-dialog-close"],
    ];
    for (const [selector, action, cost, dialogTestId, closeTestId] of expectations) {
      const button = wrapper.find(`[data-test="${selector}"]`);
      expect(button.text()).toContain(cost);
      await button.trigger("click");
      await flushPromises();
      expect(mounted.router.currentRoute.value.name).toBe("ideas");
      const query = mounted.router.currentRoute.value.query;
      expect(query.brandId).toBe("7");
      expect(query.trendId).toBe("501");
      expect(query.ideaIndex).toBe("0");
      expect([action, undefined]).toContain(query.action);
      expect(wrapper.find(`[data-test="${dialogTestId}"]`).exists()).toBe(true);
      await wrapper.find(`[data-test="${closeTestId}"]`).trigger("click");
      await flushPromises();
    }
  });

  it("uploads a product image for an idea and auto-selects it with the usage checkbox enabled", async () => {
    let uploaded = false;
    const mounted = mountIdeas((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "POST" && url === "/api/product-images") {
        uploaded = true;
        return jsonResponse(201, {
          image: { id: 22, originalName: "上传的新品.png", url: "/api/product-images/22/file?sig=u", sizeBytes: 1000 },
        });
      }
      return baseHandler()(url, init);
    });
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const input = wrapper.find('[data-test="idea-product-upload-input-0"]');
    const file = new File(["bytes"], "上传的新品.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !uploaded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(uploaded).toBe(true);

    const product = wrapper.findAll('[data-test="idea-card"]')[0].find('[data-test="idea-product-upload-0"]');
    expect(product.text()).toContain("已选择 1 张");
    const useCheck = product.find('[data-test="idea-use-product-images-0"]').element as HTMLInputElement;
    expect(useCheck.disabled).toBe(false);
    expect(useCheck.checked).toBe(true);
  });

  it("selects library images per idea via the library dialog and keeps ideas isolated", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="idea-open-library-0"]').trigger("click");
    const dialog = wrapper.find('[data-test="product-library-dialog-0"]');
    expect(dialog.exists()).toBe(true);
    await dialog.find('[data-test="idea-library-check-0-11"]').setValue(true);
    await flushPromises();
    await wrapper.find('[data-test="idea-library-done-0"]').trigger("click");
    await flushPromises();

    const cards = wrapper.findAll('[data-test="idea-card"]');
    expect(cards[0].find('[data-test="idea-product-upload-0"]').text()).toContain("已选择 1 张");
    expect(cards[1].find('[data-test="idea-product-upload-1"]').text()).toContain("未选择产品图");
  });

  it("accepts a style reference under 10MB and rejects oversized uploads with the limit copy", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const input = wrapper.find('[data-test="idea-style-input-0"]');
    const file = new File(["style"], "风格参考.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !wrapper.find('[data-test="idea-style-name-0"]').exists(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(wrapper.find('[data-test="idea-style-name-0"]').text()).toContain("风格参考.png");

    const oversized = new File([new Uint8Array(MAX_SINGLE_UPLOAD_IMAGE_BYTES + 1)], "太大.png", {
      type: "image/png",
    });
    Object.defineProperty(input.element, "files", { value: [oversized], configurable: true });
    await input.trigger("change");
    expect(wrapper.find('[data-test="idea-style-error-0"]').text()).toContain("最多上传 10MB");
  });

  it("expands creative settings, persists the ratio per idea key, and restores it on re-entry", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

        expect(wrapper.find('[data-test="idea-creative-settings-0"]').text()).toContain("生成前可选调整");

    await wrapper.find('[data-test="idea-creative-toggle-0"]').trigger("click");
    await wrapper.find('[data-test="idea-ratio-0-1:1"]').trigger("click");
    await wrapper.find('[data-test="idea-creative-style-0"]').trigger("click");
    await wrapper.find('[data-test="idea-creative-style-0-option-editorial"]').trigger("click");
    await flushPromises();

    // 比例网格选中态：智能＋具体比例按钮，选中 1:1。
    expect(wrapper.find('[data-test="idea-ratio-0-smart"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-ratio-0-1:1"]').classes()).toContain("is-selected");

    // 重新进入（返回/刷新场景）：同一品牌:趋势:选题键位恢复自己的设置。
    wrapper.unmount();
    const second = mountIdeas(baseHandler());
    wrapper = second.wrapper;
    await flushPromises();
    await flushPromises();
    await wrapper.find('[data-test="idea-creative-toggle-0"]').trigger("click");
    expect(wrapper.find('[data-test="idea-ratio-0-1:1"]').classes()).toContain("is-selected");
    expect(wrapper.find('[data-test="idea-creative-style-0"]').text()).toContain("杂志编辑感");
  });

  it("replaces the brand logo through the per-idea logo control", async () => {
    const nextBrand = makeBrandDetail([makeTrend(501)], {
      logo: makeLogo({ originalName: "新品牌logo.png" }),
    });
    let logoPosted = false;
    const mounted = mountIdeas((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "POST" && url === "/api/brands/7/logo") {
        logoPosted = true;
        return jsonResponse(200, { brand: nextBrand });
      }
      return baseHandler()(url, init);
    });
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const input = wrapper.find('[data-test="idea-logo-input-0"]');
    const file = new File(["logo-bytes"], "新品牌logo.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let attempt = 0; attempt < 30 && !logoPosted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }
    expect(logoPosted).toBe(true);
    const calls = callsTo(mounted.fetchMock, "/api/brands/7/logo", "POST");
    expect(calls).toHaveLength(1);
    const body = requestBody(calls[0][1]);
    expect(body.logoName).toBe("新品牌logo.png");
    expect(String(body.logoDataUrl)).toMatch(/^data:/);
    expect(wrapper.find('[data-test="idea-logo-id-0"]').text()).toContain("新品牌logo.png");
  });

  it("shows the stored logo filename only when this idea enables logo usage", async () => {
    const existingLogo = makeLogo({ originalName: "已上传品牌logo.png" });
    const mounted = mountIdeas((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/brands/7") {
        return jsonResponse(200, {
          brand: makeBrandDetail([makeTrend(501)], { logo: existingLogo }),
        });
      }
      return baseHandler()(url, init);
    });
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const checkbox = wrapper.find('[data-test="idea-use-brand-logo-0"]');
    await checkbox.setValue(false);
    expect(wrapper.find('[data-test="idea-logo-id-0"]').text()).toBe("本次不使用 Logo");
    expect(wrapper.find('[data-test="idea-logo-id-0"]').text()).not.toContain("已上传品牌logo.png");

    await checkbox.setValue(true);
    expect(wrapper.find('[data-test="idea-logo-id-0"]').text()).toContain("已上传品牌logo.png");
  });
});
