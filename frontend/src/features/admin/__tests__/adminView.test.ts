import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import AdminDashboardView from "../views/AdminDashboardView.vue";
import AdminMediaPreview from "../components/AdminMediaPreview.vue";
import { computeDateParams } from "../dateRange";

async function waitForStableUi(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushPromises();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("async admin panel did not stabilize before timeout");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const MOCK_OVERVIEW = {
  generatedAt: "2026-08-28T10:00:00.000Z",
  range: { from: "2026-08-22T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z", timezone: "Asia/Shanghai" },
  comparisonRange: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-22T00:00:00.000Z" },
  coverage: {
    trackingStartedAt: "2026-08-01T00:00:00.000Z",
    isPartial: false,
    notes: [],
  },
  kpis: {
    dau: { value: 120, prevValue: 100, deltaPercent: 20, sampleSize: 7 },
    newUsers: { value: 45, prevValue: 30, deltaPercent: 50 },
    effectiveCreators: { value: 38, prevValue: 25, deltaPercent: 52 },
    payingUsers: { value: 12, prevValue: 8, deltaPercent: 50 },
    revenueYuan: { value: 1280.0, prevValue: 980.0, deltaPercent: 30.6 },
    outputs: { value: 320, prevValue: 250, deltaPercent: 28 },
    netCredits: { value: 850, prevValue: 700, deltaPercent: 21.4 },
    aiSuccessRate: { value: 96.5, prevValue: 94.0, deltaPercent: 2.7, sampleSize: 400 },
  },
  trends: {
    dauSeries: [{ date: "2026-08-28", value: 120 }],
    newUsersSeries: [{ date: "2026-08-28", value: 45 }],
    creatorsSeries: [{ date: "2026-08-28", value: 38 }],
    revenueSeries: [{ date: "2026-08-28", value: 1280 }],
    outputsSeries: [{ date: "2026-08-28", value: 320 }],
  },
  featureDistribution: [
    { feature: "style_image", label: "风格图", count: 150, usersCount: 25 },
    { feature: "video_project", label: "AI 视频", count: 80, usersCount: 18 },
  ],
};

const MOCK_USERS_DATA = {
  total: 2,
  page: 1,
  pageSize: 20,
  items: [
    { id: 1, name: "管理员", phone: "13800000001", accountType: "yimei", credits: 500, brandCount: 2, generationCount: 3, consumedTokens: 100, grantedTokens: 600, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: 2, name: "小美", phone: "13900000002", accountType: "customer", credits: 300, brandCount: 1, generationCount: 2, consumedTokens: 1100, grantedTokens: 1400, createdAt: "2026-02-01T00:00:00.000Z" },
  ],
};

const MOCK_CREDIT_EVENTS_DATA = {
  total: 2,
  page: 1,
  pageSize: 20,
  items: [
    { id: 1, userId: 1, actionType: "moments", actionLabel: "生成内容", creditDelta: -2, creditCost: 2, createdAt: "2026-08-28T08:00:00.000Z", summary: "生成朋友圈图" },
    { id: 2, userId: 2, actionType: "adminAddCredits", actionLabel: "管理员加额度", creditDelta: 30, creditCost: 0, createdAt: "2026-08-28T09:00:00.000Z", summary: "活动补贴" },
  ],
};

type FetchCall = { url: string; init?: RequestInit };
const mountedWrappers: Array<{ unmount: () => void }> = [];

describe("AdminDashboardView", () => {
  afterEach(() => {
    while (mountedWrappers.length) mountedWrappers.pop()?.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.location.hash = "";
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
        if (url === "/api/session") return jsonResponse(200, { user: { id: 1, name: "管理员", isAdmin: true } });
        if (url.startsWith("/api/admin/analytics/overview")) return jsonResponse(200, MOCK_OVERVIEW);
        if (url.startsWith("/api/admin/data/users")) return jsonResponse(200, MOCK_USERS_DATA);
        if (url.startsWith("/api/admin/data/brands")) return jsonResponse(200, { total: 0, page: 1, pageSize: 20, items: [] });
        if (url.startsWith("/api/admin/data/generations")) return jsonResponse(200, { total: 0, page: 1, pageSize: 20, items: [] });
        if (url.startsWith("/api/admin/data/credit-events")) return jsonResponse(200, MOCK_CREDIT_EVENTS_DATA);
        if (url.startsWith("/api/admin/data/payment-orders")) return jsonResponse(200, { total: 0, page: 1, pageSize: 20, items: [] });
        if (url.startsWith("/api/admin/data/video-projects")) return jsonResponse(200, { total: 0, page: 1, pageSize: 20, items: [] });
        throw new Error("unhandled fetch: " + url);
      }),
    );
    const wrapper = mount(AdminDashboardView, { global: { plugins: [createPinia()] } });
    mountedWrappers.push(wrapper);
    await waitForStableUi(() => wrapper.find(".panel-content").exists()
      || wrapper.find('[data-test="credit-form"]').exists()
      || wrapper.find('[data-test="admin-error"]').exists());
    return { wrapper, calls };
  }

  it("loads session + overview and renders KPI stats cards", async () => {
    const { wrapper, calls } = await mountView();

    expect(calls.some((call) => call.url === "/api/session")).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/admin/analytics/overview"))).toBe(true);
    expect(wrapper.find('[data-test="kpi-dau"]').text()).toContain("120");
    expect(wrapper.find('[data-test="kpi-revenue"]').text()).toContain("1,280");
  });

  it("switches section via navigation and updates URL hash", async () => {
    const { wrapper } = await mountView();

    await wrapper.find('[data-test="nav-management"]').trigger("click");
    await waitForStableUi(() => wrapper.find('[data-test="credit-form"]').exists());

    expect(window.location.hash).toBe("#management");
    expect(wrapper.find('[data-test="credit-form"]').exists()).toBe(true);
  });

  it("management tab allows credit adjustment form submission", async () => {
    window.location.hash = "#management";
    vi.stubGlobal("alert", vi.fn());
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/admin/users/2/credits" && init?.method === "POST") {
        return jsonResponse(200, { user: { id: 2 } });
      }
      return undefined;
    });

    await wrapper.find('[data-test="credit-user-search"]').setValue("小美");
    await wrapper.find('[data-test="credit-user-search"]').trigger("focus");
    await flushPromises();

    await wrapper.find('[data-credit-user-id="2"]').trigger("click");
    await wrapper.find('[data-test="credit-amount"]').setValue("30");
    await wrapper.find('[data-test="credit-note"]').setValue("活动补贴");
    await wrapper.find('[data-test="credit-form"]').trigger("submit");
    await flushPromises();

    const creditCall = calls.find((call) => call.url === "/api/admin/users/2/credits");
    expect(creditCall).toBeTruthy();
    expect(creditCall!.init?.method).toBe("POST");
    expect(JSON.parse(String(creditCall!.init?.body))).toEqual({ amount: 30, note: "活动补贴" });
  });

  it("refuses to delete the current admin and confirms before deleting others", async () => {
    window.location.hash = "#management";
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    const { wrapper, calls } = await mountView();

    const deleteButtons = wrapper.findAll('[data-test="delete-user"]');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(2);

    await deleteButtons[0].trigger("click");
    expect(alertMock).toHaveBeenCalledWith("不能删除当前登录的管理员账号。");

    await deleteButtons[1].trigger("click");
    expect(confirmMock).toHaveBeenCalled();
    expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);
  });

  it("shows the 403 error text verbatim when the account is not an admin", async () => {
    const { wrapper } = await mountView((url) => {
      if (url === "/api/session") return jsonResponse(200, { user: { id: 2, isAdmin: false } });
      return undefined;
    });

    expect(wrapper.find('[data-test="admin-error"]').text()).toContain("当前账号没有管理后台权限");
  });

  it("renders MediaPreview with video for mp4, img for image, and placeholder for purged", () => {
    const imgWrapper = mount(AdminMediaPreview, {
      props: { mediaUrl: "https://example.com/pic.png", mediaType: "image", assetStatus: "available" },
    });
    expect(imgWrapper.find("img").exists()).toBe(true);
    expect(imgWrapper.find("video").exists()).toBe(false);

    const vidWrapper = mount(AdminMediaPreview, {
      props: { mediaUrl: "https://example.com/clip.mp4", mediaType: "video", assetStatus: "available" },
    });
    expect(vidWrapper.find("video").exists()).toBe(true);
    expect(vidWrapper.find("img").exists()).toBe(false);

    const purgedWrapper = mount(AdminMediaPreview, {
      props: { mediaUrl: "", assetStatus: "purged" },
    });
    expect(purgedWrapper.text()).toContain("媒体文件已按保留策略清理");
    expect(purgedWrapper.find("video").exists()).toBe(false);
    expect(purgedWrapper.find("img").exists()).toBe(false);
  });

  it("sends a custom inclusive end date as the next exclusive day", () => {
    expect(computeDateParams({ preset: "custom", customFrom: "2026-08-01", customTo: "2026-08-31" })).toMatchObject({
      from: "2026-08-01",
      to: "2026-09-01",
    });
  });

  it("shows the historical partial-coverage warning returned by a panel", async () => {
    const partialOverview = {
      ...MOCK_OVERVIEW,
      coverage: { ...MOCK_OVERVIEW.coverage, isPartial: true, notes: ["启动回填失败"] },
    };
    const { wrapper } = await mountView((url) => {
      if (url.startsWith("/api/admin/analytics/overview")) return jsonResponse(200, partialOverview);
      return undefined;
    });
    expect(wrapper.text()).toContain("历史回填部分覆盖");
  });

  it("renders the complete D2/G2 correctness metric set", async () => {
    window.location.hash = "#ai";
    const aiPayload = {
      generatedAt: "2026-08-29T00:00:00.000Z",
      range: MOCK_OVERVIEW.range,
      coverage: MOCK_OVERVIEW.coverage,
      summary: { totalRequests: 2, completedCount: 1, failedCount: 1, successRate: 50, retryRate: 50, p50LatencyMs: 5000, p95LatencyMs: 8000 },
      breakdown: [], errorStages: [], topErrorCodes: [],
      videoComparison: [{
        model: "g2", mode: "text", resolution: "720p", aspectRatio: "9:16", totalDurationSec: 10,
        projectCount: 2, matureCount: 2, activeCount: 0, waitingConfigCount: 0, completionRate: 50,
        firstSuccessRate: 50, autoRetryRate: 50, manualRetryRate: 0, rescueRate: 100,
         p50DurationMs: 5000, p95DurationMs: 8000, grossCredits: 4, refundCredits: 1, netCredits: 3,
         clipP50DurationMs: 2500, clipP95DurationMs: 4000,
        avgNetCredits: 1.5, netCreditsPerSuccessSecond: 0.3, vendorCost: null, vendorCostLabel: "未配置",
      }],
    };
    const { wrapper } = await mountView((url) => {
      if (url.startsWith("/api/admin/analytics/ai")) return jsonResponse(200, aiPayload);
      return undefined;
    });
    expect(wrapper.text()).toContain("首次成功率");
    expect(wrapper.text()).toContain("自动/人工重试率");
    expect(wrapper.text()).toContain("Gross / Refund / Net");
  });
});
