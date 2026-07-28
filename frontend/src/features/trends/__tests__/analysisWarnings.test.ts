// 任务2：趋势 warnings（迁移自 origin/master public/app.js 的
// notifyTrendAnalysisWarnings）。四个场景：普通成功不提示、降级成功提示、
// 409 轮询后降级成功提示、warning message 去重。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import TrendsView from "../views/TrendsView.vue";
import type { TrendAnalysisWarning } from "../model/types";
import {
  XHS_CATEGORY_TREE,
  callsTo,
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeTestRouter,
  makeTrendItems,
  type FetchHandler,
} from "./insightsTestUtils";

function mountTrends(handler: FetchHandler) {
  const fetchMock = installFetchMock(handler);
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const router = makeTestRouter();
  const wrapper = mount(TrendsView, { global: { plugins: [pinia, router] } });
  return { wrapper, fetchMock };
}

function analysisSuccessBody(warnings: TrendAnalysisWarning[]) {
  return {
    brand: makeBrandDetail(makeTrendItems(10)),
    user: { id: "1", name: "测试用户", credits: 4 },
    warnings,
    replayed: false,
  };
}

/** 品牌摘要 + 详情 + 类目 + 可编程的分析 POST 响应序列。 */
function warningHandler(analysisResponses: Array<() => Response>): FetchHandler {
  let call = 0;
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail([]) });
    }
    if (method === "GET" && url === "/api/trends/xhs/categories") {
      return jsonResponse(200, XHS_CATEGORY_TREE);
    }
    if (method === "POST" && url === "/api/brands/7/analyses") {
      const next = analysisResponses[Math.min(call, analysisResponses.length - 1)];
      call += 1;
      return next();
    }
    return undefined;
  };
}

async function runAnalysis(wrapper: ReturnType<typeof mount>) {
  await flushPromises();
  await wrapper.find('[data-test="run-analysis"]').trigger("click");
  await flushPromises();
}

describe("趋势分析 warnings 非阻断提示", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("普通成功：无 warning 时不渲染提示，结果正常应用", async () => {
    const { wrapper } = mountTrends(warningHandler([() => jsonResponse(200, analysisSuccessBody([]))]));
    await runAnalysis(wrapper);

    expect(wrapper.find('[data-test="analysis-warning"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="analysis-error"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="trend-card"]').length).toBe(10);
  });

  it("降级成功：结果仍应用、不弹失败框，提示说明降级条数并展示 message", async () => {
    const warnings: TrendAnalysisWarning[] = [
      { code: "TREND_ITEM_DEGRADED", message: "第 3 条证据待验证", trendIndex: 2 },
      { code: "TREND_ITEM_FALLBACK", message: "第 7 条使用降级内容", trendIndex: 6 },
    ];
    const { wrapper } = mountTrends(warningHandler([() => jsonResponse(200, analysisSuccessBody(warnings))]));
    await runAnalysis(wrapper);

    // 结果正常渲染，无失败提示（不阻断、不退款语义：user.credits 已按扣费返回并被应用）。
    expect(wrapper.findAll('[data-test="trend-card"]').length).toBe(10);
    expect(wrapper.find('[data-test="analysis-error"]').exists()).toBe(false);
    const warning = wrapper.find('[data-test="analysis-warning"]');
    expect(warning.exists()).toBe(true);
    expect(warning.find('[data-test="analysis-warning-summary"]').text()).toBe(
      "已返回 10 条趋势，其中 2 条为待验证/降级内容。",
    );
    const messages = warning.findAll('[data-test="analysis-warning-message"]').map((node) => node.text());
    expect(messages).toEqual(["第 3 条证据待验证", "第 7 条使用降级内容"]);
  });

  it("409 轮询后降级成功：最终成功同样展示 warnings", async () => {
    vi.useFakeTimers();
    const warnings: TrendAnalysisWarning[] = [
      { code: "TREND_ITEM_DEGRADED", message: "生成中降级了 1 条", trendIndex: 0 },
    ];
    const { wrapper, fetchMock } = mountTrends(
      warningHandler([
        () => jsonResponse(409, { error: "同一请求仍在生成中，请稍候。" }),
        () => jsonResponse(200, analysisSuccessBody(warnings)),
      ]),
    );
    await runAnalysis(wrapper);

    // 第一次拿到 409：只有进行中提示，没有 warning 块。
    expect(wrapper.find('[data-test="analysis-notice"]').text()).toBe("同一请求仍在生成中，请稍候。");
    expect(wrapper.find('[data-test="analysis-warning"]').exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();

    expect(callsTo(fetchMock, "/api/brands/7/analyses").length).toBe(2);
    expect(wrapper.find('[data-test="analysis-error"]').exists()).toBe(false);
    const warning = wrapper.find('[data-test="analysis-warning"]');
    expect(warning.exists()).toBe(true);
    expect(warning.find('[data-test="analysis-warning-summary"]').text()).toBe(
      "已返回 10 条趋势，其中 1 条为待验证/降级内容。",
    );
    expect(warning.findAll('[data-test="analysis-warning-message"]').map((node) => node.text())).toEqual([
      "生成中降级了 1 条",
    ]);
  });

  it("warning 去重：相同 message 只展示一次，message 缺失回落到 code", async () => {
    const warnings: TrendAnalysisWarning[] = [
      { code: "TREND_ITEM_DEGRADED", message: "证据待验证", trendIndex: 1 },
      { code: "TREND_ITEM_DEGRADED", message: "证据待验证", trendIndex: 4 },
      { code: "TREND_ITEM_FALLBACK", message: "证据待验证", trendIndex: 8 },
      { code: "EVIDENCE_POOL_THIN" },
    ];
    const { wrapper } = mountTrends(warningHandler([() => jsonResponse(200, analysisSuccessBody(warnings))]));
    await runAnalysis(wrapper);

    const warning = wrapper.find('[data-test="analysis-warning"]');
    expect(warning.exists()).toBe(true);
    // 三条降级 warning 带 trendIndex（1/4/8 去重后 3 条），概要按条目数统计。
    expect(warning.find('[data-test="analysis-warning-summary"]').text()).toBe(
      "已返回 10 条趋势，其中 3 条为待验证/降级内容。",
    );
    // message 文本去重后只剩两项：重复的“证据待验证”合并，无 message 的回落到 code。
    expect(warning.findAll('[data-test="analysis-warning-message"]').map((node) => node.text())).toEqual([
      "证据待验证",
      "EVIDENCE_POOL_THIN",
    ]);
  });
});
