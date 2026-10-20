import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import RechargeView from "../views/RechargeView.vue";
import type { PaymentOrder } from "../api";

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

  it("handles stale pending legacy order without quoteId or cycle: displays 待支付, no /月, enables cancel", async () => {
    const staleLegacyOrder = {
      id: 10,
      outTradeNo: "rb_stale_legacy_001",
      planId: "business-monthly",
      planName: "单月版",
      planCredits: 1000,
      amountYuan: "35.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-06-01T10:00:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [staleLegacyOrder] }),
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    const tableText = wrapper.find(".table-scroll table").text();
    expect(tableText).toContain("单月版");
    expect(tableText).toContain("1,000 积分");
    expect(tableText).not.toContain("1,000 积分 / 月");
    expect(tableText).toContain("未支付");
    expect(tableText).not.toContain("首期已发放");
    expect(wrapper.find(".status").text()).toBe("待支付");

    // Cancel button in table row
    const cancelBtn = wrapper.find(".text-button.danger");
    expect(cancelBtn.exists()).toBe(true);
    expect(cancelBtn.text()).toBe("取消");

    // Open detail modal
    const detailBtn = wrapper.find(".table-scroll table tbody .text-button");
    await detailBtn.trigger("click");
    await flushPromises();

    const dialogText = wrapper.find(".dialog").text();
    // Must NOT hardcode '已支付'
    expect(dialogText).toContain("待支付");
    expect(dialogText).not.toContain("升级差价订单");
    expect(dialogText).toContain("1,000 积分");
    expect(dialogText).not.toContain("1,000 积分 / 月");
    expect(wrapper.find(".dialog .button.danger").exists()).toBe(true);
    expect(wrapper.find(".dialog .button.danger").text()).toBe("取消订单");
  });

  it("cancels pending order and updates list & detail to authoritative closed state", async () => {
    const pendingOrder = {
      id: 11,
      outTradeNo: "rb_cancel_test_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "pending",
      provider: "alipay",
      cycle: "monthly",
      createdAt: "2026-10-18T10:00:00.000Z",
    };

    let ordersList = [pendingOrder];
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: ordersList }),
      "POST /api/payments/alipay/orders/rb_cancel_test_001/close": () => {
        ordersList = [{ ...pendingOrder, status: "closed" }];
        return jsonResponse(200, {
          order: ordersList[0],
          providerClosed: true,
        });
      },
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    expect(wrapper.find(".status").text()).toBe("待支付");
    const cancelBtn = wrapper.find(".text-button.danger");
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find(".status").text()).toBe("已取消");
    expect(wrapper.find(".text-button.danger").exists()).toBe(false);
    expect(wrapper.text()).toContain("订单已取消");
  });

  it("handles order already paid on cancel: updates to paid with audit_required and refreshes wallet", async () => {
    const pendingOrder: PaymentOrder = {
      id: 12,
      outTradeNo: "rb_cancel_paid_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-10-18T10:00:00.000Z",
      expiresAt: "2026-10-18T10:30:00.000Z",
      paidAt: "",
    };

    let walletRefreshed = false;
    let ordersList = [pendingOrder];
    stubFetch({
      "GET /api/billing/wallet": () => {
        walletRefreshed = true;
        return jsonResponse(200, MOCK_WALLET);
      },
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: ordersList }),
      "POST /api/payments/alipay/orders/rb_cancel_paid_001/close": () => {
        ordersList = [
          {
            ...pendingOrder,
            status: "paid",
            paidAt: "2026-10-20T10:00:00.000Z",
            fulfillmentStatus: "audit_required",
          },
        ];
        return jsonResponse(200, {
          order: ordersList[0],
          paidOnClose: true,
        });
      },
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    walletRefreshed = false;
    const cancelBtn = wrapper.find(".text-button.danger");
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find(".status").text()).toBe("已支付 · 待核查");
    expect(walletRefreshed).toBe(true);
    expect(wrapper.text()).toContain("订单待核查，请勿重复付款；可在订单记录查看进度或联系客服。");
    expect(wrapper.find(".text-button.danger").exists()).toBe(false);
  });

  it("handles cancel 400 already-paid error by fetching authoritative order and updating state", async () => {
    const pendingOrder: PaymentOrder = {
      id: 13,
      outTradeNo: "rb_cancel_400_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-10-18T10:00:00.000Z",
      expiresAt: "2026-10-18T10:30:00.000Z",
      paidAt: "",
    };

    let ordersList = [pendingOrder];
    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: ordersList }),
      "POST /api/payments/alipay/orders/rb_cancel_400_001/close": () => {
        ordersList = [
          {
            ...pendingOrder,
            status: "paid",
            paidAt: "2026-10-20T10:00:00.000Z",
            fulfillmentStatus: "scheduled",
          },
        ];
        return jsonResponse(400, { error: "订单已支付，不能关闭" });
      },
      "GET /api/payments/orders/rb_cancel_400_001": () =>
        jsonResponse(200, {
          order: ordersList[0],
        }),
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    const cancelBtn = wrapper.find(".text-button.danger");
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find(".status").text()).toBe("已支付 · 待生效");
    expect(wrapper.text()).toContain("新套餐已预约，将于当前服务结束后生效。");
    expect(wrapper.find(".text-button.danger").exists()).toBe(false);
  });

  it("retains pending status when cancellation fails with network or 500 error", async () => {
    const pendingOrder = {
      id: 14,
      outTradeNo: "rb_cancel_fail_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-10-18T10:00:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [pendingOrder] }),
      "POST /api/payments/alipay/orders/rb_cancel_fail_001/close": () =>
        jsonResponse(500, { error: "支付宝服务暂时不可用" }),
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    const cancelBtn = wrapper.find(".text-button.danger");
    await cancelBtn.trigger("click");
    await flushPromises();

    expect(wrapper.find(".status").text()).toBe("待支付");
    expect(wrapper.text()).toContain("支付宝服务暂时不可用");
    expect(wrapper.find(".text-button.danger").exists()).toBe(true);
  });

  it("handles 409 conflict during order creation: hides payment button, shows error and navigates directly to blocking order", async () => {
    const mockQuote = {
      quoteId: "quot_conflict_123",
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
      meta: {},
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    const blockingOrder = {
      id: 88,
      outTradeNo: "rb_block_order_999",
      planId: "business",
      planName: "业务版",
      planCredits: 1500,
      amountYuan: "2999.00",
      status: "pending",
      provider: "alipay",
      cycle: "monthly",
      createdAt: "2026-10-19T06:00:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/billing/quote": () => jsonResponse(200, { quote: mockQuote }),
      "POST /api/payments/alipay/orders": () =>
        jsonResponse(409, {
          error: "当前账户已有进行中或待生效的套餐订单，请先完成、生效或取消原订单",
          pendingOrder: blockingOrder,
        }),
    });
    const { wrapper } = await mountView();

    const cards = wrapper.findAll(".plan-card");
    await cards[2].find(".plan-cta").trigger("click");
    await flushPromises();

    const checkbox = wrapper.find('.acknowledge input[type="checkbox"]');
    await checkbox.setValue(true);
    await flushPromises();

    const payButton = wrapper.find(".payment-button");
    await payButton.trigger("click");
    await flushPromises();

    // Error is shown in checkout dialog
    expect(wrapper.text()).toContain("已有进行中或待生效的套餐订单");
    // The payment button is completely hidden!
    expect(wrapper.find(".checkout-footer").exists()).toBe(false);

    // Action button to open blocking order is present
    const navigateBtn = wrapper.findAll(".dialog-body .button.primary").find(b => b.text().includes("查看进行中订单"));
    expect(navigateBtn?.exists()).toBe(true);

    // Click to navigate to blocking order
    await navigateBtn?.trigger("click");
    await flushPromises();

    // Orders tab is selected and Order Detail modal is open with blocking order
    expect(wrapper.find(".dialog h2").text()).toBe("订单详情");
    expect(wrapper.find(".dialog").text()).toContain("rb_block_order_999");
    expect(wrapper.find(".dialog").text()).toContain("待支付");
    expect(wrapper.find(".dialog .button.danger").exists()).toBe(true);
    expect(wrapper.find(".dialog .button.danger").text()).toBe("取消订单");
  });

  it("handles idempotent 200 return with paid/processing and does not jump to fake success", async () => {
    const mockQuote = {
      quoteId: "quot_proc_123",
      kind: "plan",
      itemId: "pro",
      itemName: "专业版",
      action: "renew",
      cycle: "monthly",
      amountFen: 99900,
      issuedNow: 400,
      startAt: "2026-10-16T06:00:00.000Z",
      endAt: "2026-10-23T06:00:00.000Z",
      periodEndAt: "2026-10-23T06:00:00.000Z",
      scheduled: false,
      meta: {},
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    const processingOrder = {
      id: 95,
      outTradeNo: "rb_proc_order_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "paid",
      fulfillmentStatus: "processing",
      provider: "alipay",
      createdAt: "2026-10-20T06:00:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/billing/quote": () => jsonResponse(200, { quote: mockQuote }),
      "POST /api/payments/alipay/orders": () =>
        jsonResponse(200, {
          order: processingOrder,
          payUrl: "",
          qrCode: "",
        }),
    });
    const { wrapper } = await mountView();

    const cards = wrapper.findAll(".plan-card");
    await cards[1].find(".plan-cta").trigger("click");
    await flushPromises();

    const checkbox = wrapper.find('.acknowledge input[type="checkbox"]');
    await checkbox.setValue(true);
    await flushPromises();

    const payButton = wrapper.find(".payment-button");
    await payButton.trigger("click");
    await flushPromises();

    // Shows processing view
    expect(wrapper.text()).toContain("支付已确认 · 权益处理中");
    expect(wrapper.text()).not.toContain("套餐已开通");
    expect(wrapper.find(".checkout-footer").exists()).toBe(false);
  });

  it("prevents stale async quote from overwriting newly opened checkout", async () => {
    let resolveQuoteA: (val: any) => void;
    const quoteAPromise = new Promise((res) => {
      resolveQuoteA = res;
    });

    const mockQuoteB = {
      quoteId: "quot_b_123",
      kind: "plan",
      itemId: "pro",
      itemName: "专业版",
      action: "renew",
      cycle: "monthly",
      amountFen: 99900,
      issuedNow: 400,
      startAt: "2026-10-16T06:00:00.000Z",
      endAt: "2026-10-23T06:00:00.000Z",
      periodEndAt: "2026-10-23T06:00:00.000Z",
      scheduled: false,
      meta: {},
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/billing/quote": (init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.itemId === "light") {
          return quoteAPromise as any;
        }
        return jsonResponse(200, { quote: mockQuoteB });
      },
    });
    const { wrapper } = await mountView();

    // Open Plan A (light) - slow
    const cards = wrapper.findAll(".plan-card");
    await cards[0].find(".plan-cta").trigger("click");
    expect(wrapper.text()).toContain("正在生成权威服务端报价");

    // Close modal
    await wrapper.find(".dialog-head .close-button").trigger("click");
    await flushPromises();

    // Open Plan B (pro) - fast
    await cards[1].find(".plan-cta").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("确认续费套餐");
    expect(wrapper.find(".checkout-price").text()).toContain("999");

    // Now resolve slow quote A
    resolveQuoteA!(jsonResponse(200, {
      quote: {
        quoteId: "quot_a_stale",
        kind: "plan",
        itemId: "light",
        itemName: "轻量版",
        amountFen: 29900,
      },
    }));
    await flushPromises();

    // Plan B must NOT have been overwritten!
    expect(wrapper.text()).toContain("确认续费套餐");
    expect(wrapper.find(".checkout-price").text()).toContain("999");
    expect(wrapper.find(".dialog").text()).not.toContain("轻量版");
    expect(wrapper.find(".dialog").text()).toContain("专业版");
  });

  it("prevents concurrent cancellation across orders with global busy guard", async () => {
    let resolveClose1: (val: any) => void;
    const closePromise1 = new Promise((res) => {
      resolveClose1 = res;
    });

    const order1 = {
      id: 21,
      outTradeNo: "rb_concur_001",
      planId: "pro",
      planName: "专业版",
      planCredits: 400,
      amountYuan: "999.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    const order2 = {
      id: 22,
      outTradeNo: "rb_concur_002",
      planId: "business",
      planName: "业务版",
      planCredits: 1500,
      amountYuan: "2999.00",
      status: "pending",
      provider: "alipay",
      createdAt: "2026-10-18T10:00:00.000Z",
    };

    let order2CloseCalled = false;

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [order1, order2] }),
      "POST /api/payments/alipay/orders/rb_concur_001/close": () => closePromise1 as any,
      "POST /api/payments/alipay/orders/rb_concur_002/close": () => {
        order2CloseCalled = true;
        return jsonResponse(200, { order: { ...order2, status: "closed" } });
      },
    });
    const { wrapper } = await mountView();

    const tabs = wrapper.findAll(".tab");
    await tabs[3].trigger("click");
    await flushPromises();

    const cancelButtons = wrapper.findAll(".text-button.danger");
    expect(cancelButtons).toHaveLength(2);

    // Trigger cancel on order 1
    await cancelButtons[0].trigger("click");
    await flushPromises();

    // While order 1 is in-flight, order 2's cancel button MUST be disabled
    expect((cancelButtons[1].element as HTMLButtonElement).disabled).toBe(true);

    // Try clicking order 2's cancel button
    await cancelButtons[1].trigger("click");
    await flushPromises();
    expect(order2CloseCalled).toBe(false);

    // Now finish order 1's close
    resolveClose1!(jsonResponse(200, { order: { ...order1, status: "closed" } }));
    await flushPromises();

    expect(wrapper.text()).toContain("订单已取消");
  });

  it("prevents stale async createOrder response from overwriting newly opened checkout", async () => {
    let resolveCreateOrderA: (val: any) => void;
    const createOrderAPromise = new Promise((res) => {
      resolveCreateOrderA = res;
    });

    const mockQuoteA = {
      quoteId: "quot_a_submit",
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
      meta: {},
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    const mockQuoteB = {
      quoteId: "quot_b_submit",
      kind: "plan",
      itemId: "pro",
      itemName: "专业版",
      action: "renew",
      cycle: "monthly",
      amountFen: 99900,
      issuedNow: 400,
      startAt: "2026-10-16T06:00:00.000Z",
      endAt: "2026-10-23T06:00:00.000Z",
      periodEndAt: "2026-10-23T06:00:00.000Z",
      scheduled: false,
      meta: {},
      expiresAt: "2026-10-16T06:15:00.000Z",
    };

    stubFetch({
      "GET /api/billing/wallet": () => jsonResponse(200, MOCK_WALLET),
      "GET /api/billing/recharge-plans": () => jsonResponse(200, { plans: MOCK_PLANS, topups: MOCK_TOPUPS, fakeSettle: false }),
      "GET /api/payments/orders": () => jsonResponse(200, { orders: [] }),
      "POST /api/billing/quote": (init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.itemId === "business") {
          return jsonResponse(200, { quote: mockQuoteA });
        }
        return jsonResponse(200, { quote: mockQuoteB });
      },
      "POST /api/payments/alipay/orders": () => createOrderAPromise as any,
    });
    const { wrapper } = await mountView();

    // Open Plan A (business)
    const cards = wrapper.findAll(".plan-card");
    await cards[2].find(".plan-cta").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("确认升级套餐");

    // Acknowledge and submit Plan A
    const checkbox = wrapper.find('.acknowledge input[type="checkbox"]');
    await checkbox.setValue(true);
    await flushPromises();

    const payButton = wrapper.find(".payment-button");
    await payButton.trigger("click");
    await flushPromises();

    // Now close checkout dialog while createOrder is still pending
    await wrapper.find(".dialog-head .close-button").trigger("click");
    await flushPromises();

    // Open Plan B (pro)
    await cards[1].find(".plan-cta").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("确认续费套餐");
    expect(wrapper.find(".checkout-price").text()).toContain("999");
    expect(wrapper.find(".qr-payment-area").exists()).toBe(false);

    // Now resolve the late createOrder response for Plan A
    resolveCreateOrderA!(jsonResponse(200, {
      order: {
        id: 999,
        outTradeNo: "rb_stale_a_trade",
        planId: "business",
        planName: "业务版",
        planCredits: 1500,
        amountYuan: "466.67",
        status: "created",
      },
      payUrl: "https://openapi.alipay.com/gateway.do?trade_no=stale",
      qrCode: "https://qr.alipay.com/stale",
    }));
    await flushPromises();

    // Plan B checkout must NOT be polluted by Plan A's QR code or order!
    expect(wrapper.text()).toContain("确认续费套餐");
    expect(wrapper.find(".checkout-price").text()).toContain("999");
    expect(wrapper.find(".qr-payment-area").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("rb_stale_a_trade");
  });
});
