import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import RechargeView from "../views/RechargeView.vue";

function makeRouter(initialPath = "/billing"): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/billing", name: "billing", component: RechargeView }],
  });
  router.push(initialPath);
  return router;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

type FetchHandler = (init?: RequestInit) => Response;

function stubFetch(handlers: Record<string, FetchHandler>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method || "GET"} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PLAN = { id: "p1", name: "测试套餐 10 积分", credits: 10, amountYuan: "0.01" };
const PENDING_ORDER = {
  id: 1,
  outTradeNo: "redbase_order123",
  planId: "p1",
  planName: "测试套餐 10 积分",
  planCredits: 10,
  amountYuan: "0.01",
  status: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
  expiresAt: "2026-08-04T00:30:00.000Z",
  paidAt: "",
};

describe("RechargeView", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountView(initialPath = "/billing") {
    const router = makeRouter(initialPath);
    await router.isReady();
    const wrapper = mount(RechargeView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it("hides the recharge surface when no plans are configured", async () => {
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.find("[data-test=recharge-empty]").exists()).toBe(true);
    expect(wrapper.findAll("[data-test=recharge-plan]")).toHaveLength(0);
  });

  it("intercepts plan click with notice modal when user has an active pending order", async () => {
    const closedOrder = { ...PENDING_ORDER, status: "closed" };
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER] }),
      "POST /api/payments/alipay/orders/redbase_order123/close": () => jsonResponse(200, { order: closedOrder }),
    });
    const { wrapper } = await mountView();

    await wrapper.find("[data-test=recharge-plan] button").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-test=pending-order-modal]").exists()).toBe(true);
    expect(wrapper.text()).toContain("您还有未完成的订单");

    await wrapper.find("[data-test=modal-confirm-cancel]").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-test=pending-order-modal]").exists()).toBe(false);
    expect(wrapper.find("[data-test=checkout-screen]").exists()).toBe(true);
  });

  it("creates an Alipay order and reveals the pay link plus fake settle actions in test mode", async () => {
    const qrDataUrl = "data:image/png;base64,cXItY29kZQ==";
    const qrcode = await import("qrcode");
    vi.spyOn(qrcode.default, "toDataURL").mockImplementation(async () => qrDataUrl);
    const fetchMock = stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: true }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "GET /api/payments/orders/redbase_order123": () => jsonResponse(200, { order: PENDING_ORDER }),
      "POST /api/payments/alipay/orders": () =>
        jsonResponse(201, { order: PENDING_ORDER, payUrl: "https://pay.example/?out_trade_no=redbase_order123", qrCode: "https://qr.alipay.test/redbase_order123" }),
      "POST /api/payments/alipay/orders/redbase_order123/pay-link": () =>
        jsonResponse(200, { order: PENDING_ORDER, payUrl: "https://pay.example/?out_trade_no=redbase_order123", qrCode: "https://qr.alipay.test/redbase_order123" }),
    });
    const { wrapper, router } = await mountView();

    expect(wrapper.findAll("[data-test=recharge-plan]")).toHaveLength(1);

    await wrapper.find("[data-test=recharge-plan] button").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-test=checkout-screen]").exists()).toBe(true);
    await wrapper.find("[data-test=checkout-submit-btn]").trigger("click");
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/payments/alipay/orders");
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body.planId).toBe("p1");
    expect(String(body.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    expect(router.currentRoute.value.query.view).toBe("pay");
    expect(router.currentRoute.value.query.outTradeNo).toBe("redbase_order123");
    expect(wrapper.find("[data-test=alipay-pay-link]").attributes("href")).toBe(
      "https://pay.example/?out_trade_no=redbase_order123",
    );
    expect(wrapper.find("[data-test=payment-screen]").exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find("[data-test=payment-qrcode]").attributes("src")).toBe(qrDataUrl);
    expect(qrcode.default.toDataURL).toHaveBeenCalledWith("https://qr.alipay.test/redbase_order123", expect.any(Object));
  });

  it("renders the paid status for settled orders", async () => {
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () =>
        jsonResponse(200, { orders: [{ ...PENDING_ORDER, status: "paid", paidAt: "2026-08-04T00:01:00.000Z" }] }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.find("[data-test=payment-order] .status-dot").text()).toBe("已支付");
    expect(wrapper.findAll("[data-test=fake-settle-link]")).toHaveLength(0);
  });

  it("updates a list row immediately after cancelling a pending order", async () => {
    const closedOrder = { ...PENDING_ORDER, status: "closed" };
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER] }),
      "POST /api/payments/alipay/orders/redbase_order123/close": () => jsonResponse(200, { order: closedOrder }),
    });
    const { wrapper } = await mountView();
    await wrapper.find(".text-action--muted").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test=payment-order] .status-dot").text()).toBe("已关闭");
    expect(wrapper.find(".text-action--muted").exists()).toBe(false);
  });

  it("keeps concurrent cancellation results isolated per order", async () => {
    const secondOrder = { ...PENDING_ORDER, id: 2, outTradeNo: "redbase_order456", planName: "套餐二" };
    const closedFirst = { ...PENDING_ORDER, status: "closed" };
    const closedSecond = { ...secondOrder, status: "closed" };
    let resolveFirst: ((response: Response) => void) | undefined;
    let resolveSecond: ((response: Response) => void) | undefined;
    const firstClose = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondClose = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER, secondOrder] }),
      "POST /api/payments/alipay/orders/redbase_order123/close": () => firstClose as unknown as Response,
      "POST /api/payments/alipay/orders/redbase_order456/close": () => secondClose as unknown as Response,
    });
    const { wrapper } = await mountView();
    const cancelButtons = wrapper.findAll(".text-action--muted");

    await cancelButtons[0].trigger("click");
    await cancelButtons[1].trigger("click");
    expect(wrapper.text()).toContain("取消中...");

    resolveSecond?.(jsonResponse(200, { order: closedSecond }));
    await flushPromises();
    resolveFirst?.(jsonResponse(200, { order: closedFirst }));
    await flushPromises();

    const rows = wrapper.findAll("[data-test=payment-order]");
    expect(rows[0].find(".status-dot").text()).toBe("已关闭");
    expect(rows[1].find(".status-dot").text()).toBe("已关闭");
  });

  it("shows concurrent cancellation errors beside their own orders", async () => {
    const secondOrder = { ...PENDING_ORDER, id: 2, outTradeNo: "redbase_order456", planName: "套餐二" };
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER, secondOrder] }),
      "POST /api/payments/alipay/orders/redbase_order123/close": () => jsonResponse(502, { error: "订单一关闭失败" }),
      "POST /api/payments/alipay/orders/redbase_order456/close": () => jsonResponse(502, { error: "订单二关闭失败" }),
    });
    const { wrapper } = await mountView();
    const cancelButtons = wrapper.findAll(".text-action--muted");

    await Promise.all([cancelButtons[0].trigger("click"), cancelButtons[1].trigger("click")]);
    await flushPromises();

    const rows = wrapper.findAll("[data-test=payment-order]");
    expect(rows[0].find("[role=alert]").text()).toBe("订单一关闭失败");
    expect(rows[1].find("[role=alert]").text()).toBe("订单二关闭失败");
  });

  it("checks provider status from the payment screen and renders the paid detail state", async () => {
    const paidOrder = { ...PENDING_ORDER, status: "paid", paidAt: "2026-08-04T00:01:00.000Z" };
    let currentOrder = PENDING_ORDER;
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER] }),
      "GET /api/payments/orders/redbase_order123": () => jsonResponse(200, { order: currentOrder }),
      "POST /api/payments/alipay/orders/redbase_order123/pay-link": () =>
        jsonResponse(200, { order: PENDING_ORDER, payUrl: "https://pay.example/redbase_order123", qrCode: "https://qr.alipay.test/redbase_order123" }),
      "POST /api/payments/alipay/orders/redbase_order123/check": () => {
        currentOrder = paidOrder;
        return jsonResponse(200, { order: paidOrder });
      },
    });

    const { wrapper, router } = await mountView("/billing?view=pay&outTradeNo=redbase_order123");
    expect(wrapper.find("[data-test=payment-screen]").exists()).toBe(true);

    await wrapper.find("[data-test=check-payment-status]").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.view).toBe("detail");
    expect(wrapper.find("[data-test=paid-order-detail]").exists()).toBe(true);
  });

  it("shows the PC payment fallback when Alipay precreate is unavailable", async () => {
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "GET /api/payments/orders/redbase_order123": () => jsonResponse(200, { order: PENDING_ORDER }),
      "POST /api/payments/alipay/orders": () => jsonResponse(201, {
        order: PENDING_ORDER,
        payUrl: "https://pay.example/redbase_order123",
        qrCode: "",
        qrCodeError: "支付宝扫码支付暂不可用，请点击“打开支付宝付款”完成支付。",
      }),
    });
    const { wrapper } = await mountView();

    await wrapper.find("[data-test=recharge-plan] button").trigger("click");
    await flushPromises();
    await wrapper.find("[data-test=checkout-submit-btn]").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-test=payment-qrcode]").exists()).toBe(false);
    expect(wrapper.find(".payment-qr-error").text()).toContain("扫码支付暂不可用");
    expect(wrapper.find("[data-test=alipay-pay-link]").attributes("href")).toBe("https://pay.example/redbase_order123");
  });

  it("clears payment errors after returning to the recharge center", async () => {
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER] }),
      "GET /api/payments/orders/redbase_order123": () => jsonResponse(200, { order: PENDING_ORDER }),
      "POST /api/payments/alipay/orders/redbase_order123/pay-link": () =>
        jsonResponse(200, { order: PENDING_ORDER, payUrl: "https://pay.example/redbase_order123", qrCode: "https://qr.alipay.test/redbase_order123" }),
      "POST /api/payments/alipay/orders/redbase_order123/check": () =>
        jsonResponse(502, { error: "支付状态查询失败，请稍后重试" }),
    });
    const { wrapper } = await mountView("/billing?view=pay&outTradeNo=redbase_order123");
    await wrapper.find("[data-test=check-payment-status]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=alert]").exists()).toBe(true);
    await wrapper.find(".billing-back").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
  });

  it("highlights the business plan selected from the account center", async () => {
    const monthlyPlan = {
      id: "business-monthly",
      name: "单月版",
      credits: 1000,
      amountYuan: "3500.00",
    };
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN, monthlyPlan], fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });

    const { wrapper, router } = await mountView("/billing?plan=business-monthly");
    const selected = wrapper.find('[data-plan-id="business-monthly"]');

    expect(selected.classes()).toContain("billing-plan-card--selected");
    expect(selected.find("[data-test=selected-plan-label]").text()).toBe("推荐选择");

    await router.push("/billing?plan=p1");
    await flushPromises();
    expect(wrapper.find('[data-plan-id="p1"]').classes()).toContain("billing-plan-card--selected");
    expect(wrapper.find('[data-plan-id="business-monthly"]').classes()).not.toContain("billing-plan-card--selected");
  });

  it("supports selecting WeChat Pay on the checkout view and renders green WeChat payment screen", async () => {
    const wxOrder = { ...PENDING_ORDER, outTradeNo: "redbase_wx123", provider: "wxpay" as const };
    const fetchMock = stubFetch({
      "GET /api/billing/recharge-plans": () =>
        jsonResponse(200, { plans: [PLAN], fakeSettle: true, providers: { alipay: true, wxpay: true } }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/payments/wxpay/orders": () =>
        jsonResponse(201, { order: wxOrder, payUrl: "", qrCode: "weixin://wxpay/bizpayurl?pr=fake123" }),
      "GET /api/payments/orders/redbase_wx123": () => jsonResponse(200, { order: wxOrder }),
      "POST /api/payments/wxpay/orders/redbase_wx123/pay-link": () =>
        jsonResponse(200, { order: wxOrder, payUrl: "", qrCode: "weixin://wxpay/bizpayurl?pr=fake123" }),
    });
    const { wrapper, router } = await mountView();

    await wrapper.find("[data-test=recharge-plan] button").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-test=checkout-screen]").exists()).toBe(true);
    expect(wrapper.find("[data-test=payment-method-selector]").exists()).toBe(true);

    await wrapper.find('[data-provider="wxpay"]').trigger("click");
    await wrapper.find("[data-test=checkout-submit-btn]").trigger("click");
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/payments/wxpay/orders");
    expect(createCall).toBeTruthy();
    expect(router.currentRoute.value.query.outTradeNo).toBe("redbase_wx123");
    expect(wrapper.text()).toContain("微信支付");
    expect(wrapper.find(".payment-brandbar--wxpay").exists()).toBe(true);
    expect(wrapper.find("[data-test=alipay-pay-link]").exists()).toBe(false);
  });
});
