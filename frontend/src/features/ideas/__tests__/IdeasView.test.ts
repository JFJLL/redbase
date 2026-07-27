import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "../views/IdeasView.vue";
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

function baseHandler(): FetchHandler {
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail([makeTrend(501)]) });
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
    // 内容资产未补齐时的占位提示
    expect(cards[0].text()).toContain("趋势和选题已生成。朋友圈、小红书和公众号的完整发布文案会在你首次生成对应内容时自动补齐。");
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

  it("jumps to the generation view with brand/trend/idea context", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.findAll('[data-test="go-generation"]')[0].trigger("click");
    await flushPromises();

    expect(mounted.router.currentRoute.value.name).toBe("generation");
    expect(mounted.router.currentRoute.value.query).toEqual({
      brandId: "7",
      trendId: "501",
      ideaIndex: "0",
    });
  });
});
