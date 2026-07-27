import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import AdminDashboardView from "../views/AdminDashboardView.vue";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const OVERVIEW = {
  stats: {
    userCount: 2,
    brandCount: 3,
    generationCount: 5,
    totalConsumedTokens: 1200,
    currentCreditsTotal: 800,
  },
  users: [
    {
      id: 1,
      name: "管理员",
      phone: "13800000001",
      accountType: "yimei",
      currentCredits: 500,
      consumedTokens: 100,
      grantedTokens: 600,
      generationCount: 3,
      brandCount: 2,
      lastActiveAt: "2026-07-20T08:00:00.000Z",
    },
    {
      id: 2,
      name: "小美",
      phone: "13900000002",
      accountType: "customer",
      currentCredits: 300,
      consumedTokens: 1100,
      grantedTokens: 1400,
      generationCount: 2,
      brandCount: 1,
      lastActiveAt: "2026-07-21T08:00:00.000Z",
    },
  ],
  brands: [],
  usageEvents: [],
  generations: [],
};

type FetchCall = { url: string; init?: RequestInit };

describe("AdminDashboardView", () => {
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
        if (url === "/api/session") return jsonResponse(200, { user: { id: 1, name: "管理员", isAdmin: true } });
        if (url === "/api/admin/overview") return jsonResponse(200, OVERVIEW);
        throw new Error(`unhandled fetch: ${url}`);
      }),
    );
    const wrapper = mount(AdminDashboardView, { global: { plugins: [createPinia()] } });
    await flushPromises();
    return { wrapper, calls };
  }

  it("loads session + overview in parallel and renders stats and user rows", async () => {
    const { wrapper, calls } = await mountView();

    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining(["/api/session", "/api/admin/overview"]));
    expect(wrapper.find('[data-test="admin-stats"]').text()).toContain("用户数");
    expect(wrapper.find('[data-test="admin-stats"]').text()).toContain("1,200");

    const rows = wrapper.findAll('[data-test="admin-user-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("管理员");
    expect(rows[0].text()).toContain("易美");
    expect(rows[1].text()).toContain("小美");
    expect(rows[1].text()).toContain("客户");
  });

  it("filters the user table by name/phone search", async () => {
    const { wrapper } = await mountView();

    await wrapper.find('[data-test="user-search"]').setValue("139 0000");
    const rows = wrapper.findAll('[data-test="admin-user-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("小美");
  });

  it("posts the credit adjustment body {amount, note} for the picked user", async () => {
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/admin/users/2/credits" && init?.method === "POST") {
        return jsonResponse(200, { user: { id: 2 }, overview: OVERVIEW });
      }
      return undefined;
    });

    await wrapper.find('[data-test="credit-user-search"]').setValue("小美");
    await wrapper.find('[data-credit-user-id="2"]').trigger("click");
    await wrapper.find('[data-test="credit-amount"]').setValue("30");
    await wrapper.find('[data-test="credit-note"]').setValue("活动补贴");
    await wrapper.find('[data-test="credit-form"]').trigger("submit");
    await flushPromises();

    const creditCall = calls.find((call) => call.url === "/api/admin/users/2/credits");
    expect(creditCall).toBeTruthy();
    expect(creditCall!.init?.method).toBe("POST");
    expect(JSON.parse(String(creditCall!.init?.body))).toEqual({ amount: "30", note: "活动补贴" });
  });

  it("alerts when submitting the credit form without picking a user", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { wrapper, calls } = await mountView();

    await wrapper.find('[data-test="credit-amount"]').setValue("30");
    await wrapper.find('[data-test="credit-form"]').trigger("submit");
    await flushPromises();

    expect(alertMock).toHaveBeenCalledWith("请先搜索并选择要加额度的用户。");
    expect(calls.some((call) => call.url.includes("/credits"))).toBe(false);
  });

  it("surfaces the backend error verbatim when the credit adjustment fails", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { wrapper } = await mountView((url, init) => {
      if (url === "/api/admin/users/2/credits" && init?.method === "POST") {
        return jsonResponse(400, { error: "请输入大于 0 的加额度数量" });
      }
      return undefined;
    });

    await wrapper.find('[data-test="credit-user-search"]').setValue("小美");
    await wrapper.find('[data-credit-user-id="2"]').trigger("click");
    await wrapper.find('[data-test="credit-form"]').trigger("submit");
    await flushPromises();

    expect(alertMock).toHaveBeenCalledWith("请输入大于 0 的加额度数量");
  });

  it("refuses to delete the current admin and confirms before deleting others", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    const { wrapper, calls } = await mountView();

    const deleteButtons = wrapper.findAll('[data-test="delete-user"]');
    await deleteButtons[0].trigger("click");
    expect(alertMock).toHaveBeenCalledWith("不能删除当前登录的管理员账号。");

    await deleteButtons[1].trigger("click");
    expect(confirmMock).toHaveBeenCalled();
    expect(String(confirmMock.mock.calls[0])).toContain("确定删除用户「小美」吗？");
    // Cancelled confirm — no DELETE issued.
    expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);
  });

  it("shows the 403 error text verbatim when the account is not an admin", async () => {
    const { wrapper } = await mountView((url) => {
      if (url === "/api/admin/overview") {
        return jsonResponse(403, { error: "当前账号没有管理后台权限" });
      }
      return undefined;
    });

    expect(wrapper.find('[data-test="admin-error"]').text()).toBe("当前账号没有管理后台权限");
    expect(wrapper.findAll('[data-test="admin-user-row"]')).toHaveLength(0);
  });
});
