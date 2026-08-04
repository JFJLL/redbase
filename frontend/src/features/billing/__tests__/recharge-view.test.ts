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

  async function mountView() {
    const router = makeRouter();
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

  it("creates an Alipay order and reveals the pay link plus fake settle actions in test mode", async () => {
    const fetchMock = stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: true }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [PENDING_ORDER] }),
      "GET /api/payments/orders/redbase_order123": () => jsonResponse(200, { order: PENDING_ORDER }),
      "POST /api/payments/alipay/orders": () =>
        jsonResponse(201, { order: PENDING_ORDER, payUrl: "https://pay.example/?out_trade_no=redbase_order123" }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.findAll("[data-test=recharge-plan]")).toHaveLength(1);
    expect(wrapper.findAll("[data-test=fake-settle-link]")).toHaveLength(1);

    await wrapper.find("[data-test=recharge-plan] button").trigger("click");
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/payments/alipay/orders");
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body.planId).toBe("p1");
    expect(String(body.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    expect(wrapper.find("[data-test=alipay-pay-link]").attributes("href")).toBe(
      "https://pay.example/?out_trade_no=redbase_order123",
    );
    expect(wrapper.find("[data-test=payment-order]").exists()).toBe(true);
  });

  it("renders the paid status for settled orders", async () => {
    stubFetch({
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: [PLAN], fakeSettle: false }),
      "GET /api/payments/orders": () =>
        jsonResponse(200, { orders: [{ ...PENDING_ORDER, status: "paid", paidAt: "2026-08-04T00:01:00.000Z" }] }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.find("[data-test=payment-order] .billing-order-status").text()).toBe("已支付");
    expect(wrapper.findAll("[data-test=fake-settle-link]")).toHaveLength(0);
  });
});
