import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "../views/IdeasView.vue";
import IdeasViewSource from "../views/IdeasView.vue?raw";
import type { TrendIdea } from "@/features/trends/model/types";
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

function completeIdea(): TrendIdea {
  return makeIdea({
    title: "完整生成选题",
    contentAssets: {
      moments: { title: "朋友圈标题A", caption: "朋友圈文案A" },
      xhsCarousel: {
        title: "小红书标题A",
        publishTitle: "小红书标题A",
        caption: "小红书文案A",
        publishCaption: "小红书文案A",
        slides: [{}, {}, {}, {}],
      },
      wechatLongImage: { intro: "公众号长图简介" },
    },
  });
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

function baseHandler(trend = makeTrend(501, { ideas: [makeIdea({ title: "未生成选题" }), completeIdea()] })): FetchHandler {
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

  it("renders complete publish copy on complete cards and an explicit incomplete state on skeleton cards", async () => {
    const mounted = mountIdeas(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const cards = wrapper.findAll('[data-test="idea-card"]');
    expect(cards).toHaveLength(2);

    const incomplete = cards[0]!.text();
    // 骨架选题不再以“自动补齐”占位冒充正常完成态：明确标识数据不完整并提供重生成入口。
    expect(cards[0]!.find('[data-test="idea-assets-incomplete"]').exists()).toBe(true);
    expect(incomplete).toContain("缺少完整内容资产");
    expect(incomplete).toContain("重新生成选题");
    expect(incomplete).not.toContain("首次生成时自动补齐");

    const complete = cards[1]!.text();
    expect(complete).toContain("朋友圈标题：");
    expect(complete).toContain("朋友圈文案：");
    expect(complete).toContain("小红书标题：");
    expect(complete).toContain("小红书文案：");
    expect(complete).toContain("朋友圈标题A");
    expect(complete).toContain("小红书文案A");
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
      "一键风格化图1 积分",
    ]);
  });

  it("lays out the four action buttons as equal-width grid cells", () => {
    expect(IdeasViewSource).toMatch(
      /\.idea-actions\s*\{[\s\S]*?display:\s*grid[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("never renders the legacy auto-fill placeholder as a normal state", () => {
    expect(IdeasViewSource).not.toContain("首次生成时自动补齐");
    expect(IdeasViewSource).toContain('data-test="idea-assets-incomplete"');
  });
});
