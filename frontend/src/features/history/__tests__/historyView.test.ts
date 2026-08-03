import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import HistoryView from "../views/HistoryView.vue";
import { matchesGenerationHistoryFilters, normalizeHistoryDateBoundary } from "../api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/login", name: "login", component: { template: "<div />" } },
    ],
  });
}

const GENERATIONS = [
  {
    id: 1,
    type: "moments",
    cardTitle: "露营朋友圈图",
    brandName: "品牌A",
    brandId: 7,
    trendTitle: "五一露营潮",
    ideaTitle: "露营装备清单",
    channelLabel: "朋友圈",
    createdAt: "2026-07-20T08:00:00.000Z",
    previewUrl: "/api/generated-images/1/file?sig=aaa",
    payload: { caption: "露营去咯", visualDirection: "清新自然", aspectRatio: "3:4" },
  },
  {
    id: 2,
    type: "xhsCarousel",
    cardTitle: "护肤小红书组图",
    brandName: "品牌B",
    brandId: 8,
    trendTitle: "夏日护肤",
    ideaTitle: "晨间流程",
    channelLabel: "小红书",
    createdAt: "2026-07-21T08:00:00.000Z",
    payload: {
      publishTitle: "晨间护肤这样做",
      publishCaption: "收藏这套流程",
      slides: [{ title: "第1页", imageUrl: "/api/generated-images/2/slides/0/file?sig=bbb" }],
    },
  },
];

type FetchCall = { url: string; init?: RequestInit };

describe("HistoryView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountView(overrides?: (url: string, init?: RequestInit) => Response | undefined) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const custom = overrides?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
        if (url.startsWith("/api/history")) return jsonResponse(200, { generations: GENERATIONS });
        throw new Error(`unhandled fetch: ${url}`);
      }),
    );
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    return { wrapper, calls };
  }

  it("renders history cards with type labels and signed image URLs untouched", async () => {
    const { wrapper, calls } = await mountView();

    expect(calls.some((call) => call.url === "/api/history")).toBe(true);
    const cards = wrapper.findAll('[data-test="history-card"]');
    expect(cards).toHaveLength(2);
    expect(wrapper.text()).toContain("朋友圈图文");
    expect(wrapper.text()).toContain("小红书组图");
    expect(wrapper.text()).toContain("查看所有生成过的图片、标题和文案，统一回看并复用已产出的内容资产。");
    expect(wrapper.text()).toContain("历史生成图片会保存七天，请及时下载。");
    expect(wrapper.text()).not.toContain("30 天内的生成记录");
    // Signed URLs from the backend are used verbatim.
    expect(wrapper.find('img[src="/api/generated-images/1/file?sig=aaa"]').exists()).toBe(true);
    expect(wrapper.find('img[src="/api/generated-images/2/slides/0/file?sig=bbb"]').exists()).toBe(true);
  });

  it("sends DELETE /api/history/:id after confirm and removes the card", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/history/1" && init?.method === "DELETE") {
        return jsonResponse(200, { ok: true, deletedGenerationId: 1 });
      }
      return undefined;
    });

    await wrapper.findAll('[data-test="history-delete"]')[0].trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalledWith("确定删除「露营朋友圈图」吗？删除后将无法找回。");
    const deleteCall = calls.find((call) => call.url === "/api/history/1");
    expect(deleteCall?.init?.method).toBe("DELETE");
    expect(wrapper.findAll('[data-test="history-card"]')).toHaveLength(1);
  });

  it("keeps the card and alerts with the backend error verbatim when deletion fails", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { wrapper } = await mountView((url, init) => {
      if (url === "/api/history/1" && init?.method === "DELETE") {
        return jsonResponse(500, { error: "数据库繁忙，请稍后再试" });
      }
      return undefined;
    });

    await wrapper.findAll('[data-test="history-delete"]')[0].trigger("click");
    await flushPromises();

    expect(alertMock).toHaveBeenCalledWith("删除失败：数据库繁忙，请稍后再试");
    expect(wrapper.findAll('[data-test="history-card"]')).toHaveLength(2);
  });

  it("passes filters as query params when reloading", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, calls } = await mountView();
      await wrapper.find('[data-test="history-type"]').setValue("moments");
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();
      expect(calls.some((call) => call.url === "/api/history?type=moments")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters items locally exactly like the legacy matcher", () => {
    const item = GENERATIONS[0];
    expect(matchesGenerationHistoryFilters(item, { q: "露营", brandId: "", type: "", from: "", to: "" })).toBe(true);
    expect(matchesGenerationHistoryFilters(item, { q: "护肤", brandId: "", type: "", from: "", to: "" })).toBe(false);
    expect(matchesGenerationHistoryFilters(item, { q: "", brandId: "7", type: "moments", from: "", to: "" })).toBe(true);
    expect(
      matchesGenerationHistoryFilters(item, { q: "", brandId: "", type: "", from: "2026-07-21", to: "" }),
    ).toBe(false);
    expect(normalizeHistoryDateBoundary("2026-07-21", "to")).toBe("2026-07-21T23:59:59.999Z");
    expect(normalizeHistoryDateBoundary("2026-07-21", "from")).toBe("2026-07-21T00:00:00.000Z");
  });
});
