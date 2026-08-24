import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "../views/IdeasView.vue";
import IdeasViewSource from "../views/IdeasView.vue?raw";
import {
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeIdea,
  makeTestRouter,
  makeTrend,
  type FetchHandler,
} from "@/features/trends/__tests__/insightsTestUtils";

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

function baseHandler(trend = makeTrend(501, { ideas: [makeIdea({ title: "选题一" }), makeIdea({ title: "选题二" })] })): FetchHandler {
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail([trend]) });
    }
    return undefined;
  };
}

describe("ideas card layout contract", () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps idea cards focused on visible topic fields without content-asset status or previews", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const cards = wrapper.findAll('[data-test="idea-card"]');
    expect(cards).toHaveLength(2);

    for (const card of cards) {
      expect(card.find('[data-test="idea-assets-incomplete"]').exists()).toBe(false);
      expect(card.text()).not.toContain("缺少完整内容资产");
      expect(card.text()).not.toContain("朋友圈标题：");
      expect(card.text()).not.toContain("小红书文案：");
    }
  });

  it("keeps the four generation action buttons wired to their kinds", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const buttons = wrapper.findAll('[data-test="idea-card"]').at(0)!.findAll(".idea-actions > button");
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.text())).toEqual([
      "一键朋友圈图1 积分",
      "一键公众号长图1 积分",
      "一键小红书组图4 积分",
      "一键生成脚本1 积分",
    ]);
  });

  it("lays out the four action buttons as equal-width grid cells", () => {
    expect(IdeasViewSource).toMatch(
      /\.idea-actions\s*\{[\s\S]*?display:\s*grid[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("does not render content-asset completeness UI on idea cards", () => {
    expect(IdeasViewSource).not.toContain("首次生成时自动补齐");
    expect(IdeasViewSource).not.toContain('data-test="idea-assets-incomplete"');
    expect(IdeasViewSource).not.toContain("朋友圈标题：");
    expect(IdeasViewSource).not.toContain("小红书文案：");
  });
});
