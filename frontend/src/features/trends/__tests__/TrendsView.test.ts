import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import TrendsView from "../views/TrendsView.vue";
import { useInsightsStore } from "../stores/insights";
import {
  XHS_CATEGORY_TREE,
  callsTo,
  flushMicrotasks,
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeTestRouter,
  makeTrend,
  makeTrendItems,
  requestBody,
  type FetchHandler,
} from "./insightsTestUtils";

function setupApp() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const router = makeTestRouter();
  return { pinia, auth, router };
}

function mountTrends(handler: FetchHandler) {
  const fetchMock = installFetchMock(handler);
  const { pinia, auth, router } = setupApp();
  const wrapper = mount(TrendsView, { global: { plugins: [pinia, router] } });
  return { wrapper, fetchMock, auth, router };
}

/** 基础接口：品牌摘要 + 品牌详情 + 小红书类目。 */
function baseHandler(detailItems = [makeTrend(501)]): FetchHandler {
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail(detailItems) });
    }
    if (method === "GET" && url === "/api/trends/xhs/categories") {
      return jsonResponse(200, XHS_CATEGORY_TREE);
    }
    return undefined;
  };
}

describe("TrendsView", () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders trend cards with the real backend fields (evidence, reason, score, tags)", async () => {
    const mounted = mountTrends(baseHandler());
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    const card = wrapper.find('[data-test="trend-card"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("秋日第一杯咖啡");
    expect(card.text()).toContain("生活方式");
    expect(card.text()).toContain("秋季限定风味讨论量上升");
    expect(card.text()).toContain("88/100");
    expect(card.text()).toContain("#秋天");
    expect(card.text()).toContain("与品牌人群和场景高度重合");

    const evidenceLink = card.find('[data-test="trend-evidence"] a');
    expect(evidenceLink.attributes("href")).toBe("https://example.com/note/1");
    expect(evidenceLink.text()).toContain("证据笔记：秋天的咖啡馆");

    // 历史分析列表渲染真实字段
    expect(wrapper.find('[data-test="history-list"]').text()).toContain("红磨坊咖啡 - 小红书热点话题");
    expect(wrapper.find('[data-test="history-list"]').text()).toContain("2026-07-20 10:00");
  });

  it("POSTs the legacy analysis request body { requestId, bucketKey, xhsCategoryPath }", async () => {
    const analysisBrand = makeBrandDetail(makeTrendItems(10));
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/brands/7/analyses") {
        return jsonResponse(200, {
          brand: analysisBrand,
          user: { id: "1", name: "测试用户", phone: "13800000000", credits: 4 },
          warnings: [],
          replayed: false,
        });
      }
      return baseHandler([])(url, init);
    };
    const mounted = mountTrends(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="run-analysis"]').trigger("click");
    await flushPromises();

    const calls = callsTo(mounted.fetchMock, "/api/brands/7/analyses", "POST");
    expect(calls).toHaveLength(1);
    const body = requestBody(calls[0][1]);
    expect(body.bucketKey).toBe("xhs");
    expect(body.xhsCategoryPath).toBe("");
    expect(typeof body.requestId).toBe("string");
    expect(String(body.requestId).length).toBeGreaterThan(0);

    // 结果应用：10 条趋势卡片 + 积分刷新
    expect(wrapper.findAll('[data-test="trend-card"]')).toHaveLength(10);
    expect(mounted.auth.user?.credits).toBe(4);
  });

  it("keeps polling on 409 (in-progress) and stops the poll when unmounted", async () => {
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/brands/7/analyses") {
        return jsonResponse(409, { error: "这个趋势维度正在生成中，请等待当前请求完成。" });
      }
      return baseHandler([])(url, init);
    };
    const mounted = mountTrends(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    vi.useFakeTimers();
    await wrapper.find('[data-test="run-analysis"]').trigger("click");
    await flushMicrotasks();
    await wrapper.vm.$nextTick();

    expect(callsTo(mounted.fetchMock, "/api/brands/7/analyses", "POST")).toHaveLength(1);
    // 进行中状态：按钮生成中 + 展示后端 409 原文
    expect(wrapper.find('[data-test="run-analysis"]').text()).toContain("生成中");
    expect(wrapper.find('[data-test="analysis-notice"]').text()).toBe(
      "这个趋势维度正在生成中，请等待当前请求完成。",
    );

    // 轮询继续：5 秒后用同一 requestId 复取
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    const secondCalls = callsTo(mounted.fetchMock, "/api/brands/7/analyses", "POST");
    expect(secondCalls).toHaveLength(2);
    expect(requestBody(secondCalls[0][1]).requestId).toBe(requestBody(secondCalls[1][1]).requestId);

    // 卸载后轮询必须停止，busy key 被清理
    const store = useInsightsStore();
    wrapper.unmount();
    wrapper = null;
    await vi.advanceTimersByTimeAsync(60000);
    await flushMicrotasks();
    expect(callsTo(mounted.fetchMock, "/api/brands/7/analyses", "POST")).toHaveLength(2);
    expect(store.trendAnalysisLoadingKeys).toHaveLength(0);
  });

  it("shows the backend error text verbatim when the analysis fails", async () => {
    const errorText = "积分不足，本次操作需要 1 积分，当前剩余 0 积分。";
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "POST" && url === "/api/brands/7/analyses") {
        return jsonResponse(402, { error: errorText });
      }
      return baseHandler([])(url, init);
    };
    const mounted = mountTrends(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    await wrapper.find('[data-test="run-analysis"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="analysis-error"]').text()).toBe(errorText);
    // 失败后按钮恢复可点击
    expect(wrapper.find('[data-test="run-analysis"]').attributes("disabled")).toBeUndefined();
  });

  it("handles 401 by clearing the session and redirecting to login", async () => {
    const handler: FetchHandler = (url, init) => {
      if (String(init?.method || "GET") === "GET" && url === "/api/brands?summary=1") {
        return jsonResponse(401, { error: "登录状态已失效" });
      }
      return undefined;
    };
    const mounted = mountTrends(handler);
    wrapper = mounted.wrapper;
    await flushPromises();
    await flushPromises();

    expect(mounted.auth.user).toBeNull();
    expect(mounted.router.currentRoute.value.name).toBe("login");
  });
});
