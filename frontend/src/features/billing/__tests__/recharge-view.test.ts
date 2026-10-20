import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import RechargeView from "../views/RechargeView.vue";

function makeRouter(initialPath = "/billing") {
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
    if (!handler) {
      const urlBase = String(input).split("?")[0];
      const baseKey = `${init?.method || "GET"} ${urlBase}`;
      if (handlers[baseKey]) return handlers[baseKey](init);
      throw new Error(`unexpected fetch: ${key}`);
    }
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const MOCK_WALLET = {
  wallet: {
    totalAvailable: 420,
    periodBalance: 120,
    permanentBalance: 300,
    legacyBalance: 100,
  },
  subscription: {
    id: 1,
    planId: "pro",
    planName: "专业版",
    cycle: "monthly",
    serviceStart: "2026-09-23T06:00:00.000Z",
    serviceEnd: "2026-10-23T06:00:00.000Z",
    currentPeriodStart: "2026-09-23T06:00:00.000Z",
    currentPeriodEnd: "2026-10-23T06:00:00.000Z",
    currentPeriodGrant: 400,
    usedCredits: 280,
    nextGrantAt: null,
  },
  scheduled: null,
  scenario: "monthly",
  planActions: {
    light_monthly: { type: "downgrade", label: "更换套餐", note: "当前服务到期后生效" },
    pro_monthly: { type: "renew", label: "续费套餐", note: "衔接当前服务，本期积分不重置" },
    business_monthly: { type: "upgrade", label: "升级套餐", note: "补差价立即生效，原到期日不变" },
  },
};

const MOCK_PLANS = [
  { id: "light", name: "轻量版", label: "轻量创作", desc: "个人运营", monthlyFen: 29900, annualFen: 299000, credits: 100, featured: false, amountYuan: "299.00" },
  { id: "pro", name: "专业版", label: "持续创作", desc: "持续运营", monthlyFen: 99900, annualFen: 999000, credits: 400, featured: true, amountYuan: "999.00" },
  { id: "business", name: "业务版", label: "高频创作", desc: "多项目", monthlyFen: 299900, annualFen: 2999000, credits: 1500, featured: false, amountYuan: "2999.00" },
];

const MOCK_TOPUPS = [
  { id: "fuel-small", name: "小额加油包", desc: "偶尔创作", credits: 25, amountFen: 9900 },
  { id: "fuel-standard", name: "标准加油包", desc: "灵活补充", credits: 80, amountFen: 29900, featured: true },
  { id: "fuel-large", name: "大额加油包", desc: "预留充足空间", credits: 300, amountFen: 99900 },
];

describe("RechargeView V2", () => {
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

  it("renders V2 header, breadcrumbs, and wallet balance breakdown", async () => {
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.find(".page-title").text()).toBe("套餐与积分");
    expect(wrapper.find("#total-balance").text()).toBe("420");
    expect(wrapper.find("#period-balance").text()).toBe("120");
    expect(wrapper.find("#permanent-balance").text()).toBe("300");
    expect(wrapper.find("#wallet-plan-tag").text()).toBe("专业版 · 月付");
    expect(wrapper.find(".subscription-status").text()).toContain("当前服务：专业版 · 月付");
  });

  it("renders 3 V2 plan cards and toggles between monthly and annual payment cycles", async () => {
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });
    const { wrapper } = await mountView();

    const cards = wrapper.findAll(".plan-card");
    expect(cards).toHaveLength(3);
    expect(cards[0].find("h3").text()).toBe("轻量版");
    expect(cards[1].find("h3").text()).toBe("专业版");
    expect(cards[2].find("h3").text()).toBe("业务版");

    expect(cards[0].find(".price-number").text()).toBe("299");
    expect(cards[1].find(".price-number").text()).toBe("999");
    expect(cards[2].find(".price-number").text()).toBe("2,999");

    const cycleButtons = wrapper.findAll(".cycle-button");
    await cycleButtons[1].trigger("click");
    await flushPromises();

    expect(cards[0].find(".price-number").text()).toBe("2,990");
    expect(cards[1].find(".price-number").text()).toBe("9,990");
    expect(cards[2].find(".price-number").text()).toBe("29,990");
  });

  it("renders 3 permanent booster packs on the topups tab", async () => {
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[1].trigger("click");
    await flushPromises();

    const topupCards = wrapper.findAll(".topup-card");
    expect(topupCards).toHaveLength(3);
    expect(topupCards[0].find("h3").text()).toBe("小额加油包");
    expect(topupCards[0].find(".topup-credit-hero strong").text()).toBe("25");
    expect(topupCards[1].find("h3").text()).toBe("标准加油包");
    expect(topupCards[1].find(".topup-credit-hero strong").text()).toBe("80");
    expect(topupCards[2].find("h3").text()).toBe("大额加油包");
    expect(topupCards[2].find(".topup-credit-hero strong").text()).toBe("300");
  });

  it("opens rules, balance breakdown, and change rules modals", async () => {
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
    });
    const { wrapper } = await mountView();

    await wrapper.find(".button-rules").trigger("click");
    expect(wrapper.text()).toContain("积分消耗规则");
    await wrapper.find(".close-button").trigger("click");

    await wrapper.find(".wallet-total .text-button").trigger("click");
    expect(wrapper.text()).toContain("我的积分账户");
    expect(wrapper.text()).toContain("历史保留积分");
    await wrapper.find(".close-button").trigger("click");

    await wrapper.find(".subscription-status .text-button").trigger("click");
    expect(wrapper.text()).toContain("套餐如何续费、升级或更换？");
  });

  it("loads quote and performs payment checkout flow with acknowledge guard", async () => {
    const mockQuote = {
      quoteId: "quot_test_123",
      kind: "plan",
      itemId: "business",
      itemName: "业务版",
      action: "upgrade",
      cycle: "monthly",
      amountFen: 46667,
      issuedNow: 257,
      startAt: "2026-10-16T06:00:00.000Z",
      endAt: "2026-10-23T06:00:00.000Z",
      periodEndAt: "2026-10-23T06:00:00.000Z",
      scheduled: false,
      meta: {
        planCredits: 1500,
        upgradeDetails: {
          oldPlanName: "专业版",
          oldFullTermPrice: 99900,
          targetFullTermPrice: 299900,
          serviceDaysLeft: 7,
          serviceDaysTotal: 30,
          periodDaysLeft: 7,
          periodDaysTotal: 30,
        },
      },
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: true }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/billing/quote": () => jsonResponse(200, { quote: mockQuote }),
      "POST /api/payments/alipay/orders": () =>
        jsonResponse(201, {
          order: {
            id: 99,
            outTradeNo: "rb_test_out_001",
            planId: "business",
            planName: "业务版",
            planCredits: 1500,
            amountYuan: "466.67",
            status: "created",
          },
          payUrl: "https://openapi.alipay.com/gateway.do?trade_no=test",
          qrCode: "https://qr.alipay.com/test",
        }),
    });
    const { wrapper } = await mountView();

    const cards = wrapper.findAll(".plan-card");
    await cards[2].find(".plan-cta").trigger("click");
    await flushPromises();

    expect(wrapper.find("#checkout-title").text()).toBe("确认升级套餐");
    expect(wrapper.find(".checkout-price").text()).toContain("466.67");
    expect(wrapper.text()).toContain("+257 积分");

    const payButton = wrapper.find(".payment-button");
    expect((payButton.element as HTMLButtonElement).disabled).toBe(true);

    const checkbox = wrapper.find('.acknowledge input[type="checkbox"]');
    await checkbox.setValue(true);
    await flushPromises();
    expect((payButton.element as HTMLButtonElement).disabled).toBe(false);

    await payButton.trigger("click");
    await flushPromises();

    expect(wrapper.find(".qr-payment-area").exists()).toBe(true);
    expect(wrapper.text()).toContain("请使用支付宝扫码完成付款");
  });

  it("loads and displays filtered ledger and orders tab", async () => {
    const mockLedger = [
      { id: 1, time: "2026.10.16 10:28", label: "小红书标准组图", delta: -4, source: "本期积分", note: "4 张", type: "spend" },
      { id: 2, time: "2026.10.01 09:20", label: "大额加油包到账", delta: 300, source: "永久积分", note: "不设到期日", type: "grant" },
    ];
    const mockOrders = [
      { id: 1, outTradeNo: "rb_ord_001", planName: "标准加油包", planCredits: 80, amountYuan: "299.00", status: "paid", provider: "alipay", orderKind: "topup" },
    ];

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/billing/ledger": () => jsonResponse(200, { rows: mockLedger, total: 2 }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: mockOrders }),
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[2].trigger("click");
    await flushPromises();

    expect(wrapper.find(".table-scroll table").text()).toContain("小红书标准组图");
    expect(wrapper.find(".table-scroll table").text()).toContain("大额加油包到账");

    await tabs[3].trigger("click");
    await flushPromises();

    expect(wrapper.find(".table-scroll table").text()).toContain("标准加油包");
    expect(wrapper.find(".table-scroll table").text()).toContain("rb_ord_001");
    expect(wrapper.find(".status").text()).toBe("已支付");
  });
});
