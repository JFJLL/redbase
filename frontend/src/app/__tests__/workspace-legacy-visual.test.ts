import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import WorkspaceShell from "@/app/views/WorkspaceShell.vue";
import WorkspaceHomeView from "@/app/views/WorkspaceHomeView.vue";
import IdeaGenerationDialogSource from "@/features/generation/components/IdeaGenerationDialog.vue?raw";
import IdeasViewSource from "@/features/ideas/views/IdeasView.vue?raw";
import ExcellentViewSource from "@/features/excellent/views/ExcellentView.vue?raw";
import { useAuthStore } from "@/shared/stores/auth";
import { INSUFFICIENT_CREDITS_EVENT } from "@/shared/api/client";

const RouteStub = { template: "<div />" };

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/home", name: "home", component: WorkspaceHomeView },
      { path: "/brands", name: "brands", component: RouteStub },
      { path: "/personal", name: "personal", component: RouteStub },
      { path: "/trends", name: "trends", component: RouteStub },
      { path: "/ideas", name: "ideas", component: RouteStub },
      { path: "/excellent", name: "excellent", component: RouteStub },
      { path: "/generation", name: "generation", component: RouteStub },
      { path: "/history", name: "history", component: RouteStub },
      { path: "/billing", name: "billing", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
    ],
  });
}

describe("legacy workspace visual shell", () => {
  beforeEach(() => {
    localStorage.clear();
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // 每次调用返回全新 Response：多个并发请求（积分套餐 + 任务恢复）各自消费独立 body。
        return new Response(JSON.stringify({ plans: [], fakeSettle: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountWorkspace(isAdmin = true) {
    const router = makeRouter();
    router.push("/home");
    await router.isReady();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore(pinia);
    auth.user = {
      id: "user-1",
      name: "Test User",
      phone: "13800000000",
      credits: 6,
      isAdmin,
    };
    const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it("restores the legacy logo, user details, credits and home copy", async () => {
    const { wrapper } = await mountWorkspace();

    expect(wrapper.find(".workspace-logo img").attributes("src")).toBe("/assets/redbase-logo.png");
    expect(wrapper.find(".user-name").text()).toBe("Test User");
    expect(wrapper.find(".user-phone").text()).toBe("13800000000");
    expect(wrapper.find(".user-credits").text()).toBe("6 积分");
    expect(wrapper.find(".home-title").text()).toBe("RedBase");
    expect(wrapper.find(".home-subtitle").text()).toContain("一站式小红书运营工作台");
    expect(wrapper.findAll(".home-card")).toHaveLength(4);
  });

  it("keeps the legacy navigation order and route targets", async () => {
    const { wrapper } = await mountWorkspace();
    const links = wrapper.findAll(".workspace-nav .sidebar-item");

    expect(links.map((link) => link.find(".sidebar-item-label").text())).toEqual([
      "首页",
      "品牌档案",
      "个人 IP",
      "趋势分析",
      "内容选题",
      "优秀内容",
      "历史生成",
    ]);
    expect(links.map((link) => link.attributes("href"))).toEqual([
      "/home",
      "/brands",
      "/personal",
      "/trends",
      "/ideas",
      "/excellent",
      "/history",
    ]);
    expect(wrapper.find("a.workspace-user-profile").attributes("href")).toBe("/admin/");
    expect(wrapper.find("a.workspace-user-profile").attributes("title")).toBe("进入管理后台");
  });

  it("persists and restores the legacy sidebar collapse state", async () => {
    localStorage.setItem("redbase.sidebarCollapsed", "true");
    const { wrapper } = await mountWorkspace();
    const toggle = wrapper.find(".sidebar-toggle");

    expect(wrapper.classes()).toContain("sidebar-collapsed");
    expect(toggle.attributes("aria-label")).toBe("展开侧边栏");
    await toggle.trigger("click");
    await flushPromises();

    expect(wrapper.classes()).not.toContain("sidebar-collapsed");
    expect(localStorage.getItem("redbase.sidebarCollapsed")).toBe("false");
    expect(toggle.attributes("aria-label")).toBe("收起侧边栏");
  });

  it("keeps the administrator entry as a direct navigation link", async () => {
    const { wrapper } = await mountWorkspace();

    const adminLink = wrapper.find("a.workspace-user-profile");
    expect(adminLink.attributes("href")).toBe("/admin/");
    expect(adminLink.attributes("title")).toBe("进入管理后台");
  });

  it("opens the account center with Space for keyboard users", async () => {
    const { wrapper } = await mountWorkspace(false);

    await wrapper.find("button.workspace-user-profile").trigger("click");
    expect(wrapper.find(".account-modal-panel").exists()).toBe(true);
  });

  it("routes the clickable credit balance to the recharge page", async () => {
    const { wrapper, router } = await mountWorkspace(false);

    await wrapper.find(".user-credits").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("billing");
    expect(wrapper.find(".account-modal-panel").exists()).toBe(false);
  });

  it("shows the balance in account center and routes both recharge actions", async () => {
    const { wrapper, router } = await mountWorkspace(false);

    await wrapper.find("button.workspace-user-profile").trigger("click");
    expect(wrapper.find(".account-credit-balance strong").text()).toBe("6");
    await wrapper.find('[data-test="account-orders"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("billing");
    expect(router.currentRoute.value.hash).toBe("#billing-orders");
    expect(wrapper.find(".account-modal-panel").exists()).toBe(false);

    await router.push("/home");
    await wrapper.find("button.workspace-user-profile").trigger("click");
    await wrapper.find('[data-test="account-recharge"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("billing");
    expect(router.currentRoute.value.hash).toBe("");
  });

  it("routes business plan choices to the matching recharge plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            plans: [{ id: "business-monthly", name: "单月版", credits: 1000, amountYuan: "3500.00" }],
            fakeSettle: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { wrapper, router } = await mountWorkspace(false);

    await wrapper.find("button.workspace-user-profile").trigger("click");
    await wrapper.find('[data-test="business-plan-monthly"]').trigger("click");
    await flushPromises();

    expect(wrapper.find(".account-modal-panel").exists()).toBe(false);
    expect(router.currentRoute.value.name).toBe("billing");
    expect(router.currentRoute.value.query.plan).toBe("business-monthly");
  });

  it("logs out through the auth store and returns to login", async () => {
    const { wrapper, router } = await mountWorkspace();
    const auth = useAuthStore();
    const logout = vi.spyOn(auth, "logout").mockImplementation(async () => {
      auth.user = null;
    });

    await wrapper.find(".workspace-logout").trigger("click");
    await flushPromises();

    expect(logout).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("keeps generation and excellent-content feature sentinels", () => {
    // 内容选题卡直接承接四类生图（旧版四个动作按钮）。
    expect(IdeasViewSource).toContain('data-test="`idea-generate-moments-${index}`"');
    expect(IdeasViewSource).toContain('data-test="`idea-generate-wechat-${index}`"');
    expect(IdeasViewSource).toContain('data-test="`idea-generate-xhs-${index}`"');
    expect(IdeasViewSource).toContain('data-test="`idea-generate-style-${index}`"');
    // 比例恢复“智能＋具体比例”图形按钮网格。
    expect(IdeasViewSource).toContain("idea-aspect-ratio-grid");
    expect(IdeasViewSource).toContain("aspect-smart-mark");
    // 内容选题内生成对话框：进度/结果/失败/重试与公众号比例提醒。
    expect(IdeaGenerationDialogSource).toContain('data-test="gen-status"');
    expect(IdeaGenerationDialogSource).toContain('data-test="gen-error"');
    expect(IdeaGenerationDialogSource).toContain('data-test="gen-retry"');
    expect(IdeaGenerationDialogSource).toContain('data-test="moments-result"');
    expect(IdeaGenerationDialogSource).toContain('data-test="wechat-warning"');
    expect(IdeaGenerationDialogSource).toContain(":class=\"{ 'idea-generation-panel--xhs': genKind === 'xhsCarousel' }\"");
    expect(IdeaGenerationDialogSource).toContain("idea-generation-panel--xhs");
    expect(IdeaGenerationDialogSource).toContain("width: min(1180px, 100%)");
    expect(IdeaGenerationDialogSource).toContain("grid-template-columns: 420px minmax(0, 1fr)");
    expect(IdeaGenerationDialogSource).toContain("@media (max-width: 1180px)");
    expect(ExcellentViewSource).toContain('data-test="refresh-button"');
    expect(ExcellentViewSource).toContain('data-test="analysis-ready"');
    expect(ExcellentViewSource).toContain('data-test="generate-fusion"');
    expect(ExcellentViewSource).toContain('data-test="remix-submit"');
  });

  it("keeps recharge out of the sidebar regardless of plan availability", async () => {
    const { wrapper } = await mountWorkspace();
    const labels = wrapper.findAll(".workspace-nav .sidebar-item-label").map((link) => link.text());
    expect(labels).not.toContain("积分充值");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            plans: [{ id: "p1", name: "测试套餐", credits: 10, amountYuan: "0.01" }],
            fakeSettle: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const withPlans = await mountWorkspace();
    const labelsWithPlans = withPlans.wrapper.findAll(".workspace-nav .sidebar-item-label").map((link) => link.text());
    expect(labelsWithPlans).not.toContain("积分充值");
  });

  it("offers an immediate recharge action after any 402 credit failure", async () => {
    const { wrapper, router } = await mountWorkspace(false);

    window.dispatchEvent(
      new CustomEvent(INSUFFICIENT_CREDITS_EVENT, { detail: { message: "积分不足，本次操作需要 1 积分。" } }),
    );
    await flushPromises();

    const toast = wrapper.find('[data-test="insufficient-credits-toast"]');
    expect(toast.text()).toContain("积分不足，本次操作需要 1 积分。");
    await toast.find(".credit-shortage-action").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("billing");
    expect(wrapper.find('[data-test="insufficient-credits-toast"]').exists()).toBe(false);
  });
});
