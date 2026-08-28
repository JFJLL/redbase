import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import AdminDashboardView from "../views/AdminDashboardView.vue";
import AdminMediaPreview from "../components/AdminMediaPreview.vue";

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

describe("AdminDashboardView", () => {
  afterEach(() => {
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
    await flushPromises();
    await flushPromises();
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
    await flushPromises();
    await flushPromises();

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
});
