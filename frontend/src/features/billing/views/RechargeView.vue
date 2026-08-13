<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import QRCode from "qrcode";
import {
  checkPaymentStatus,
  closeOrder,
  createAlipayOrder,
  fakeSettleUrl,
  fetchOrder,
  fetchOrders,
  fetchPayLink,
  fetchRechargePlans,
  type CreateOrderResponse,
  type PaymentOrder,
  type RechargePlan,
} from "../api";

const route = useRoute();
const router = useRouter();
const plans = ref<RechargePlan[]>([]);
const orders = ref<PaymentOrder[]>([]);
const activeOrder = ref<PaymentOrder | null>(null);
const payUrl = ref("");
const qrCodeContent = ref("");
const qrCodeError = ref("");
const payQrCode = ref("");
const fakeSettle = ref(false);
const loadingPlans = ref(true);
const loadingOrders = ref(false);
const loadingDetail = ref(false);
const creatingPlanId = ref("");
const checkingStatus = ref(false);
const closingOrderNos = ref<string[]>([]);
const closeMessages = ref<Record<string, { tone: "success" | "error"; text: string }>>({});
const copied = ref(false);
const errorMessage = ref("");
const statusMessage = ref("");
let pollTimer: ReturnType<typeof setInterval> | null = null;
let routeLoadVersion = 0;
let checkRequestVersion = 0;
let qrRenderVersion = 0;
let pendingPaymentAccess: CreateOrderResponse | null = null;

const selectedPlanId = computed(() => (typeof route.query.plan === "string" ? route.query.plan : ""));
const activeView = computed(() => (typeof route.query.view === "string" ? route.query.view : "list"));
const routeOrderNo = computed(() => (typeof route.query.outTradeNo === "string" ? route.query.outTradeNo : ""));
const isPayView = computed(() => activeView.value === "pay" && Boolean(routeOrderNo.value));
const isDetailView = computed(() => activeView.value === "detail" && Boolean(routeOrderNo.value));
const isPaidDetail = computed(() => activeOrder.value?.status === "paid");

onMounted(async () => {
  const returnStatus = typeof route.query.status === "string" ? route.query.status : "";
  if (returnStatus && routeOrderNo.value) {
    await router.replace({
      name: "billing",
      query: { view: "detail", outTradeNo: routeOrderNo.value },
    });
  }
  await Promise.all([loadPlans(), loadOrders()]);
  await loadRouteOrder();
});

watch(() => `${activeView.value}:${routeOrderNo.value}`, loadRouteOrder);
watch(qrCodeContent, async (value) => {
  const renderVersion = ++qrRenderVersion;
  const rendered = value
    ? await QRCode.toDataURL(value, { width: 248, margin: 1, errorCorrectionLevel: "M", color: { dark: "#111827", light: "#ffffff" } })
    : "";
  if (renderVersion === qrRenderVersion) payQrCode.value = rendered;
});

onBeforeUnmount(stopPolling);

async function loadPlans(): Promise<void> {
  loadingPlans.value = true;
  try {
    const data = await fetchRechargePlans();
    plans.value = data.plans;
    fakeSettle.value = Boolean(data.fakeSettle);
  } catch (error) {
    setError(error);
  } finally {
    loadingPlans.value = false;
  }
}

async function loadOrders(): Promise<void> {
  loadingOrders.value = true;
  try {
    const data = await fetchOrders();
    orders.value = data.orders;
  } catch (error) {
    setError(error);
  } finally {
    loadingOrders.value = false;
  }
}

async function loadRouteOrder(): Promise<void> {
  const requestedOrderNo = routeOrderNo.value;
  const requestedView = activeView.value;
  const loadVersion = ++routeLoadVersion;
  checkRequestVersion += 1;
  stopPolling();
  activeOrder.value = null;
  payUrl.value = "";
  qrCodeContent.value = "";
  qrCodeError.value = "";
  payQrCode.value = "";
  statusMessage.value = "";
  errorMessage.value = "";
  checkingStatus.value = false;
  closingOrderNos.value = [];
  if (!requestedOrderNo || (requestedView !== "pay" && requestedView !== "detail")) return;
  loadingDetail.value = true;
  errorMessage.value = "";
  try {
    const data = await fetchOrder(requestedOrderNo);
    if (!isCurrentRouteLoad(loadVersion, requestedView, requestedOrderNo)) return;
    activeOrder.value = data.order;
    if (requestedView === "pay" && isOpenOrder(data.order)) {
      const cachedPaymentAccess = pendingPaymentAccess?.order.outTradeNo === data.order.outTradeNo
        ? pendingPaymentAccess
        : null;
      pendingPaymentAccess = null;
      const payData = cachedPaymentAccess || await fetchPayLink(data.order.outTradeNo);
      if (!isCurrentRouteLoad(loadVersion, requestedView, requestedOrderNo)) return;
      payUrl.value = payData.payUrl;
      qrCodeContent.value = payData.qrCode;
      qrCodeError.value = payData.qrCodeError || "";
      startPolling(data.order.outTradeNo);
    }
  } catch (error) {
    if (isCurrentRouteLoad(loadVersion, requestedView, requestedOrderNo)) setError(error);
  } finally {
    if (loadVersion === routeLoadVersion) loadingDetail.value = false;
  }
}

function isCurrentRouteLoad(version: number, view: string, outTradeNo: string): boolean {
  return version === routeLoadVersion && activeView.value === view && routeOrderNo.value === outTradeNo;
}

async function handleCreateOrder(plan: RechargePlan): Promise<void> {
  if (creatingPlanId.value) return;
  creatingPlanId.value = plan.id;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const idempotencyKey = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `order-${Date.now()}`;
    const data = await createAlipayOrder(plan.id, idempotencyKey);
    activeOrder.value = data.order;
    pendingPaymentAccess = data;
    await loadOrders();
    await router.push({ name: "billing", query: { view: "pay", outTradeNo: data.order.outTradeNo } });
  } catch (error) {
    setError(error);
  } finally {
    creatingPlanId.value = "";
  }
}

async function handleCheckPayment(): Promise<void> {
  if (!activeOrder.value) return;
  const requestedOrderNo = activeOrder.value.outTradeNo;
  const requestedLoadVersion = routeLoadVersion;
  const requestVersion = ++checkRequestVersion;
  checkingStatus.value = true;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const data = await checkPaymentStatus(requestedOrderNo);
    if (requestVersion !== checkRequestVersion || !isCurrentRouteLoad(requestedLoadVersion, "pay", requestedOrderNo)) return;
    activeOrder.value = data.order;
    replaceOrder(data.order);
    if (data.order.status === "paid") {
      stopPolling();
      statusMessage.value = "支付成功，积分已经到账。";
      await router.replace({ name: "billing", query: { view: "detail", outTradeNo: data.order.outTradeNo } });
    } else {
      statusMessage.value = `当前状态：${statusLabel(data.order.status)}。完成支付后可再次检测。`;
    }
  } catch (error) {
    if (requestVersion === checkRequestVersion && isCurrentRouteLoad(requestedLoadVersion, "pay", requestedOrderNo)) setError(error);
  } finally {
    if (requestVersion === checkRequestVersion) checkingStatus.value = false;
  }
}

function startPolling(outTradeNo: string): void {
  stopPolling();
  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks += 1;
    try {
      const data = await fetchOrder(outTradeNo);
      if (routeOrderNo.value !== outTradeNo || activeView.value !== "pay") return;
      activeOrder.value = data.order;
      replaceOrder(data.order);
      if (!isOpenOrder(data.order)) {
        stopPolling();
        if (data.order.status === "paid") {
          if (routeOrderNo.value === outTradeNo) {
            await router.replace({ name: "billing", query: { view: "detail", outTradeNo } });
          }
        }
      }
    } catch {
      // Transient polling failures are surfaced only when the user requests an active check.
    }
    if (ticks >= 30) stopPolling();
  }, 3000);
}

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
}

async function handleCloseOrder(order: PaymentOrder): Promise<void> {
  if (isClosingOrder(order.outTradeNo)) return;
  const requestedOrderNo = order.outTradeNo;
  const requestedView = activeView.value;
  const requestedLoadVersion = routeLoadVersion;
  setClosingOrder(order.outTradeNo, true);
  setCloseMessage(order.outTradeNo, null);
  if (requestedView !== "list") errorMessage.value = "";
  try {
    const data = await closeOrder(order.outTradeNo);
    const routeStillMatches = closeRouteStillMatches(requestedLoadVersion, requestedView, requestedOrderNo);
    if (!routeStillMatches) return;
    if (requestedView !== "list") activeOrder.value = data.order;
    replaceOrder(data.order);
    setCloseMessage(order.outTradeNo, { tone: "success", text: "已取消" });
  } catch (error) {
    const routeStillMatches = closeRouteStillMatches(requestedLoadVersion, requestedView, requestedOrderNo);
    if (routeStillMatches) {
      if (requestedView === "list") {
        setCloseMessage(order.outTradeNo, {
          tone: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      } else {
        setError(error);
      }
    }
  } finally {
    setClosingOrder(order.outTradeNo, false);
  }
}

function closeRouteStillMatches(loadVersion: number, view: string, outTradeNo: string): boolean {
  return view === "list"
    ? loadVersion === routeLoadVersion && activeView.value === "list"
    : isCurrentRouteLoad(loadVersion, view, outTradeNo);
}

function isClosingOrder(outTradeNo: string): boolean {
  return closingOrderNos.value.includes(outTradeNo);
}

function setClosingOrder(outTradeNo: string, closing: boolean): void {
  closingOrderNos.value = closing
    ? Array.from(new Set([...closingOrderNos.value, outTradeNo]))
    : closingOrderNos.value.filter((item) => item !== outTradeNo);
}

function setCloseMessage(
  outTradeNo: string,
  message: { tone: "success" | "error"; text: string } | null,
): void {
  const next = { ...closeMessages.value };
  if (message) next[outTradeNo] = message;
  else delete next[outTradeNo];
  closeMessages.value = next;
}

async function openOrderDetail(order: PaymentOrder): Promise<void> {
  activeOrder.value = order;
  await router.push({ name: "billing", query: { view: "detail", outTradeNo: order.outTradeNo } });
}

async function continuePayment(order: PaymentOrder): Promise<void> {
  activeOrder.value = order;
  await router.push({ name: "billing", query: { view: "pay", outTradeNo: order.outTradeNo } });
}

async function backToBilling(): Promise<void> {
  stopPolling();
  activeOrder.value = null;
  payUrl.value = "";
  qrCodeContent.value = "";
  qrCodeError.value = "";
  payQrCode.value = "";
  statusMessage.value = "";
  errorMessage.value = "";
  await router.push({ name: "billing" });
}

async function copyPayUrl(): Promise<void> {
  if (!payUrl.value) return;
  await navigator.clipboard.writeText(payUrl.value);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1600);
}

function replaceOrder(order: PaymentOrder): void {
  const index = orders.value.findIndex((item) => item.outTradeNo === order.outTradeNo);
  if (index >= 0) orders.value.splice(index, 1, order);
  else orders.value.unshift(order);
}

function setError(error: unknown): void {
  if (error instanceof Error && error.name === "ApiError" && (error as { status?: number }).status === 401) return;
  errorMessage.value = error instanceof Error ? error.message : String(error);
}

function statusLabel(status: string): string {
  return ({ created: "待支付", pending: "待支付", paid: "已支付", closed: "已关闭", expired: "已过期", failed: "失败" } as Record<string, string>)[status] || status;
}

function statusTone(status: string): string {
  if (status === "paid") return "success";
  if (status === "created" || status === "pending") return "pending";
  return "muted";
}

function isOpenOrder(order: PaymentOrder): boolean {
  return order.status === "created" || order.status === "pending";
}

function formatDate(value: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}
</script>

<template>
  <section class="billing-panel">
    <button v-if="isPayView || isDetailView" type="button" class="billing-back" @click="backToBilling">← 返回充值中心</button>

    <p v-if="errorMessage" class="billing-alert billing-alert--error" role="alert">{{ errorMessage }}</p>
    <p v-if="statusMessage" class="billing-alert" role="status">{{ statusMessage }}</p>

    <div v-if="loadingDetail && (isPayView || isDetailView)" class="billing-loading" role="status">正在加载订单...</div>

    <template v-else-if="isPayView && activeOrder">
      <section class="payment-screen" data-test="payment-screen">
        <header class="payment-brandbar">
          <span class="alipay-mark">支</span>
          <div><strong>支付宝</strong><small>ALIPAY</small></div>
        </header>
        <div class="payment-grid">
          <div class="payment-summary">
            <span class="payment-eyebrow">应付金额</span>
            <strong class="payment-amount">¥{{ activeOrder.amountYuan }} <small>CNY</small></strong>
            <div class="payment-actions">
              <a class="payment-primary" :href="payUrl" target="_blank" rel="noopener" data-test="alipay-pay-link">打开支付宝付款</a>
              <button type="button" class="payment-secondary" :disabled="!payUrl" @click="copyPayUrl">{{ copied ? "已复制" : "复制支付链接" }}</button>
            </div>
            <p>将在新窗口打开支付宝电脑网站。完成支付后，请返回本页检测支付状态。</p>
          </div>
          <div class="payment-check-panel">
            <img v-if="payQrCode" class="payment-qrcode" :src="payQrCode" alt="支付宝付款二维码" data-test="payment-qrcode" />
            <div v-else class="payment-qr-loading" :class="{ 'payment-qr-error': qrCodeError }" role="status">{{ qrCodeError || "正在生成付款二维码..." }}</div>
            <strong>{{ qrCodeError ? "请使用支付宝网页付款" : "请使用支付宝扫码付款" }}</strong>
            <small>系统同时接收支付宝异步通知；你也可以主动检测。</small>
            <button type="button" class="payment-check" :disabled="checkingStatus" data-test="check-payment-status" @click="handleCheckPayment">
              {{ checkingStatus ? "检测中..." : "↻ 检测支付状态" }}
            </button>
          </div>
        </div>
        <footer class="payment-meta">
          <span><small>状态</small><b>{{ statusLabel(activeOrder.status) }}</b></span>
          <span><small>商品</small><b>{{ activeOrder.planName }}</b></span>
          <span><small>积分</small><b>{{ activeOrder.planCredits }}</b></span>
          <span><small>订单号</small><b>{{ activeOrder.outTradeNo }}</b></span>
        </footer>
      </section>
    </template>

    <template v-else-if="isDetailView && activeOrder">
      <section v-if="isPaidDetail" class="paid-success" data-test="paid-order-detail">
        <div class="paid-check">✓</div>
        <h1>支付完成</h1>
        <p>订单已支付并完成积分入账</p>
        <button type="button" class="success-return-btn" @click="backToBilling">返回充值中心</button>
      </section>

      <div class="order-detail-layout" :class="{ 'order-detail-layout--paid': isPaidDetail }">
        <div class="order-detail-main">
          <section class="detail-card">
            <h2>商品信息</h2>
            <dl><dt>套餐名称</dt><dd>{{ activeOrder.planName }}</dd><dt>类型</dt><dd>一次性</dd><dt>到账积分</dt><dd>{{ activeOrder.planCredits }} 积分</dd></dl>
          </section>
          <section class="detail-card">
            <div class="detail-card-head">
              <h2>订单信息</h2>
              <button v-if="isOpenOrder(activeOrder)" type="button" class="danger-btn" :disabled="isClosingOrder(activeOrder.outTradeNo)" @click="handleCloseOrder(activeOrder)">{{ isClosingOrder(activeOrder.outTradeNo) ? "关闭中..." : "关闭订单" }}</button>
            </div>
            <dl><dt>订单号</dt><dd>{{ activeOrder.outTradeNo }}</dd><dt>创建时间</dt><dd>{{ formatDate(activeOrder.createdAt) }}</dd><template v-if="activeOrder.paidAt"><dt>支付时间</dt><dd>{{ formatDate(activeOrder.paidAt) }}</dd></template></dl>
          </section>
          <section v-if="isOpenOrder(activeOrder)" class="detail-card detail-payment-method">
            <h2>支付方式</h2><span class="alipay-inline"><b>支</b> 支付宝支付</span>
          </section>
        </div>
        <aside v-if="isOpenOrder(activeOrder)" class="detail-checkout">
          <h2>订单总额</h2>
          <div><span>{{ activeOrder.planName }}</span><b>¥{{ activeOrder.amountYuan }}</b></div>
          <small>总计</small><strong class="detail-total"><span>¥{{ activeOrder.amountYuan }}</span><small>CNY</small></strong>
          <button type="button" class="checkout-btn" @click="continuePayment(activeOrder)">继续支付</button>
        </aside>
      </div>
    </template>

    <template v-else>
      <div class="billing-head">
        <div><span class="billing-kicker">Credits</span><h1 class="billing-title">积分充值</h1><p class="billing-subtitle">选择适合你的积分套餐，通过支付宝安全支付，到账后立即可用。</p></div>
      </div>

      <div v-if="loadingPlans" class="billing-loading" role="status">正在加载套餐...</div>
      <div v-else-if="plans.length === 0" class="billing-empty" data-test="recharge-empty"><h2>充值暂未开放</h2><p>当前未配置充值套餐，请稍后再试。</p></div>
      <div v-else class="billing-plans-grid">
        <article v-for="plan in plans" :key="plan.id" class="billing-plan-card" :class="{ 'billing-plan-card--selected': plan.id === selectedPlanId }" :data-plan-id="plan.id" data-test="recharge-plan">
          <span v-if="plan.id === selectedPlanId" class="billing-plan-selected" data-test="selected-plan-label">推荐选择</span>
          <div class="billing-plan-icon">{{ plan.id.includes("annual") ? "年" : "月" }}</div>
          <h2>{{ plan.name }}</h2><p class="billing-plan-credits"><strong>{{ plan.credits }}</strong> 积分</p><p class="billing-plan-price"><span>¥</span>{{ plan.amountYuan }}</p>
          <button type="button" class="primary-btn billing-plan-action" :disabled="Boolean(creatingPlanId)" @click="handleCreateOrder(plan)">{{ creatingPlanId === plan.id ? "正在创建订单..." : "立即充值" }}</button>
        </article>
      </div>

      <section class="billing-orders" aria-label="我的充值订单">
        <div class="billing-orders-head"><div><span class="billing-kicker">Orders</span><h2>充值订单</h2></div><button type="button" class="billing-refresh" :disabled="loadingOrders" @click="loadOrders">{{ loadingOrders ? "刷新中..." : "↻ 刷新" }}</button></div>
        <p v-if="orders.length === 0" class="billing-orders-empty">暂无充值订单。</p>
        <div v-else class="billing-table-wrap">
          <table class="billing-table"><thead><tr><th>订单号</th><th>套餐</th><th>订单金额</th><th>订单状态</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody><tr v-for="order in orders" :key="order.outTradeNo" data-test="payment-order"><td><button type="button" class="order-link" @click="openOrderDetail(order)">{{ order.outTradeNo }}</button></td><td><strong>{{ order.planName }}</strong><small>{{ order.planCredits }} 积分</small></td><td>¥{{ order.amountYuan }}</td><td><span class="status-dot" :data-tone="statusTone(order.status)">{{ statusLabel(order.status) }}</span></td><td>{{ formatDate(order.createdAt) }}</td><td><div class="table-actions"><button type="button" class="text-action" @click="openOrderDetail(order)">查看详情</button><button v-if="isOpenOrder(order)" type="button" class="text-action text-action--muted" :disabled="isClosingOrder(order.outTradeNo)" @click="handleCloseOrder(order)">{{ isClosingOrder(order.outTradeNo) ? "取消中..." : "取消" }}</button><a v-if="fakeSettle && isOpenOrder(order)" :href="fakeSettleUrl(order.outTradeNo)" target="_blank" rel="noopener" data-test="fake-settle-link">测试结算</a><small v-if="closeMessages[order.outTradeNo]" class="close-result" :data-tone="closeMessages[order.outTradeNo].tone" :role="closeMessages[order.outTradeNo].tone === 'error' ? 'alert' : 'status'">{{ closeMessages[order.outTradeNo].text }}</small></div></td></tr></tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.billing-panel{width:100%;max-width:none;color:var(--workspace-text)}
.billing-back{margin:0 0 18px;padding:0;border:0;background:transparent;color:var(--workspace-brand-ink);font:inherit;font-weight:700;cursor:pointer}
.billing-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:4px 0 8px}
.billing-kicker{display:block;margin-bottom:6px;color:var(--workspace-brand);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.billing-title{margin:0;font-family:var(--workspace-font-heading);font-size:2rem;letter-spacing:-.04em}.billing-subtitle{margin:9px 0 0;color:var(--workspace-text-muted);font-size:14px;line-height:1.7}
.billing-alert{margin:0 0 16px;padding:12px 15px;border:1px solid #f0d9a4;border-radius:10px;background:#fffaf0;color:#805a13}.billing-alert--error{border-color:#f4c8c8;background:#fff5f5;color:#a43b3b}
.billing-loading,.billing-empty{margin-top:24px;padding:48px;border:1px solid var(--workspace-border);border-radius:14px;background:#fff;text-align:center}
.billing-plans-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,320px));gap:18px;margin-top:28px}.billing-plan-card{position:relative;padding:24px;border:1px solid var(--workspace-border);border-radius:16px;background:#fff;box-shadow:0 8px 28px rgba(91,67,67,.05);transition:.18s ease}.billing-plan-card:hover,.billing-plan-card--selected{border-color:rgba(216,68,68,.42);box-shadow:0 14px 32px rgba(138,68,68,.1);transform:translateY(-2px)}
.billing-plan-selected{position:absolute;top:16px;right:16px;padding:5px 9px;border-radius:999px;background:#fff0ed;color:var(--workspace-brand);font-size:11px;font-weight:800}.billing-plan-icon{display:grid;width:42px;height:42px;place-items:center;border-radius:12px;background:#f7e8e4;color:var(--workspace-brand);font-weight:900}.billing-plan-card h2{margin:18px 0 0;font-size:18px}.billing-plan-credits{margin:10px 0 0;color:var(--workspace-brand-ink)}.billing-plan-credits strong{font-size:22px}.billing-plan-price{margin:14px 0 20px;font-size:26px;font-weight:800;letter-spacing:-.03em}.billing-plan-price span{margin-right:2px;font-size:15px}.billing-plan-action{width:100%;min-height:42px;border-radius:10px}
.billing-orders{margin-top:52px}.billing-orders-head{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:16px}.billing-orders-head h2{margin:0;font-size:22px}.billing-refresh{min-height:38px;padding:0 14px;border:1px solid var(--workspace-border);border-radius:9px;background:#fff;color:var(--workspace-text);font:inherit;font-weight:700;cursor:pointer}
.billing-table-wrap{width:100%;overflow:auto;border:1px solid var(--workspace-border);border-radius:14px;background:#fff}.billing-table{width:100%;min-width:900px;border-collapse:collapse}.billing-table th,.billing-table td{padding:15px 18px;border-bottom:1px solid #eee8e6;text-align:left;vertical-align:middle}.billing-table th{background:#faf7f5;color:#766d6f;font-size:12px;font-weight:800}.billing-table tbody tr:last-child td{border-bottom:0}.billing-table td{font-size:13px}.billing-table td:nth-child(2){display:grid;gap:3px}.billing-table td small{color:var(--workspace-text-muted)}.order-link,.text-action{padding:0;border:0;background:transparent;color:var(--workspace-brand-ink);font:inherit;font-weight:700;cursor:pointer}.status-dot{display:inline-flex;align-items:center;gap:7px}.status-dot:before{width:7px;height:7px;border-radius:50%;background:#9b9395;content:""}.status-dot[data-tone="pending"]:before{background:#e14e4e}.status-dot[data-tone="success"]:before{background:#24a565}.table-actions{display:flex;align-items:center;gap:12px;white-space:nowrap}.text-action--muted{color:#8e8587}.table-actions a{color:var(--workspace-brand-ink);font-weight:700;text-decoration:none}.billing-orders-empty{padding:32px;border:1px dashed var(--workspace-border);border-radius:12px;color:var(--workspace-text-muted);text-align:center}
.close-result[data-tone="success"]{color:#248657}.close-result[data-tone="error"]{max-width:220px;color:#b83e3e;white-space:normal}
  .payment-screen{overflow:hidden;border:1px solid #d9e0ec;border-radius:18px;background:#fff;box-shadow:0 24px 60px rgba(45,62,95,.12)}.payment-brandbar{display:flex;align-items:center;gap:13px;padding:20px 28px;background:linear-gradient(120deg,#3184f5,#1863d4);color:#fff}.alipay-mark{display:grid;width:52px;height:52px;place-items:center;border-radius:12px;background:#fff;color:#1684df;font-size:30px;font-weight:900}.payment-brandbar div{display:grid}.payment-brandbar strong{font-size:24px}.payment-brandbar small{font-size:11px;font-weight:800}.payment-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,.8fr)}.payment-summary,.payment-check-panel{min-height:360px;padding:38px}.payment-summary{border-right:1px solid #e3e7ef}.payment-eyebrow{color:#8290a5;font-size:13px}.payment-amount{display:block;margin:8px 0 26px;font-size:40px;letter-spacing:-.04em}.payment-amount small{font-size:18px}.payment-actions{display:flex;gap:12px}.payment-primary,.payment-secondary,.payment-check{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:10px;font:inherit;font-weight:800;cursor:pointer}.payment-primary{background:#1672df;color:#fff;text-decoration:none}.payment-secondary,.payment-check{border:1px solid #dce2ec;background:#f8faff;color:#253044}.payment-summary p{max-width:480px;margin-top:30px;color:#657086;line-height:1.7}.payment-check-panel{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.payment-qrcode{width:248px;max-width:100%;height:auto;margin-bottom:18px;border:10px solid #fff;border-radius:12px;box-shadow:0 10px 30px rgba(36,71,118,.12)}.payment-qr-loading{display:grid;width:248px;max-width:100%;min-height:248px;place-items:center;margin-bottom:18px;border-radius:12px;background:#f5f8fc;color:#7c8799}.payment-check-panel>strong{font-size:20px}.payment-check-panel>small{margin:9px 0 20px;color:#7c8799}.payment-meta{display:grid;grid-template-columns:.7fr 1fr .7fr 2fr;gap:18px;padding:18px 28px;border-top:1px solid #e3e7ef;background:#fbfcff}.payment-meta span{display:grid;gap:4px}.payment-meta small{color:#8792a4}.payment-meta b{overflow-wrap:anywhere}
  .payment-qr-error{padding:20px;border:1px solid #f2c8c8;background:#fff6f6;color:#a43b3b;line-height:1.6}
.paid-success{display:flex;flex-direction:column;align-items:center;padding:48px 24px;margin-bottom:20px;border:1px solid var(--workspace-border);border-radius:16px;background:#fff;text-align:center}.paid-check{display:grid;width:86px;height:86px;place-items:center;border-radius:50%;background:#2fb61e;color:#fff;font-size:52px;font-weight:900}.paid-success h1{margin:20px 0 4px}.paid-success p{margin:0 0 22px;color:var(--workspace-text-muted)}.success-return-btn{min-height:42px;padding:0 20px;border:1px solid rgba(216,68,68,.18);border-radius:10px;background:#d84444;color:#fff;font:inherit;font-weight:800;box-shadow:0 8px 20px rgba(216,68,68,.18);cursor:pointer}.success-return-btn:hover{background:#c83b3b;transform:translateY(-1px)}
.order-detail-layout{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(320px,.8fr);gap:20px}.order-detail-layout--paid{grid-template-columns:1fr}.order-detail-main{display:grid;gap:16px}.detail-card{padding:24px;border:1px solid var(--workspace-border);border-radius:14px;background:#fff}.detail-card h2,.detail-checkout h2{margin:0 0 22px;font-size:18px}.detail-card-head{display:flex;align-items:center;justify-content:space-between}.detail-card dl{display:grid;grid-template-columns:150px 1fr;gap:12px;margin:0}.detail-card dt{color:#92909a}.detail-card dd{margin:0;overflow-wrap:anywhere}.danger-btn{padding:8px 14px;border:0;border-radius:999px;background:#d84444;color:#fff;font:inherit;font-weight:700;cursor:pointer}.detail-payment-method{display:grid;gap:10px}.alipay-inline{display:flex;align-items:center;gap:10px}.alipay-inline b{display:grid;width:34px;height:34px;place-items:center;border-radius:8px;background:#1684df;color:#fff}.detail-checkout{align-self:start;padding:24px;border-radius:14px;background:#222c3b;color:#fff}.detail-checkout>div{display:flex;justify-content:space-between;margin-bottom:38px}.detail-checkout>small{color:#94a0b2}.detail-checkout>strong{display:block;margin:6px 0 18px;font-size:30px}.checkout-btn{width:100%;min-height:42px;border:0;border-radius:8px;background:#1672df;color:#fff;font:inherit;font-weight:800;cursor:pointer}
.detail-checkout{min-width:0;overflow:hidden}.detail-checkout>div{gap:12px}.detail-checkout>div span{min-width:0;overflow-wrap:anywhere}.detail-total{display:flex!important;flex-wrap:wrap;align-items:baseline;gap:0 8px;font-size:clamp(24px,7vw,30px)!important}.detail-total small{font-size:.55em}.checkout-btn{padding:0 12px;white-space:normal}
@media(max-width:900px){.billing-head{display:grid}.billing-plans-grid{grid-template-columns:1fr}.payment-grid,.order-detail-layout{grid-template-columns:1fr}.payment-summary{border-right:0;border-bottom:1px solid #e3e7ef}.payment-meta{grid-template-columns:1fr 1fr}.detail-checkout{order:-1}}
@media(max-width:600px){.payment-summary,.payment-check-panel{min-height:auto;padding:26px 20px}.payment-actions{display:grid}.payment-meta{grid-template-columns:1fr}.detail-card{padding:19px}.detail-card dl{grid-template-columns:1fr;gap:5px}.detail-card dd{margin-bottom:10px}.billing-table-wrap{border-radius:10px}}
</style>
