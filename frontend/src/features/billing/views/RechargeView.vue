<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import QRCode from "qrcode";
import {
  checkPaymentStatus,
  createOrderWithQuote,
  fakeSettleUrl,
  fetchLedger,
  fetchOrders,
  fetchRechargePlans,
  fetchWalletOverview,
  getLedgerExportUrl,
  requestBillingQuote,
  type ActiveSubscription,
  type BillingOverview,
  type BillingQuote,
  type CreateOrderResponse,
  type LedgerRow,
  type PaymentOrder,
  type PlanAction,
  type RechargePlan,
  type ScheduledSubscription,
  type TopupPack,
} from "../api";

const route = useRoute();

// State
const activeTab = ref<"plans" | "topups" | "ledger" | "orders">("plans");
const activeCycle = ref<"monthly" | "annual">("monthly");

const loadingOverview = ref(true);
const loadingCatalog = ref(true);
const loadingLedger = ref(false);
const loadingOrders = ref(false);

const overview = ref<BillingOverview | null>(null);
const plans = ref<RechargePlan[]>([]);
const topups = ref<TopupPack[]>([]);
const ledgerRows = ref<LedgerRow[]>([]);
const orders = ref<PaymentOrder[]>([]);
const fakeSettle = ref(false);
const providers = ref<{ alipay?: boolean; wxpay?: boolean }>({ alipay: true, wxpay: false });

// Ledger Filter & Search
const ledgerFilter = ref<"all" | "spend" | "grant" | "expire">("all");
const ledgerQuery = ref("");

// Checkout state
const checkoutOpen = ref(false);
const quoteLoading = ref(false);
const currentQuote = ref<BillingQuote | null>(null);
const selectedProvider = ref<"alipay" | "wxpay">("alipay");
const acknowledgeChecked = ref(false);
const submittingOrder = ref(false);
const activeOrderResponse = ref<CreateOrderResponse | null>(null);
const payQrCodeDataUrl = ref("");
const paymentSuccess = ref(false);
const checkoutErrorMessage = ref("");

// Info Modals
const rulesModalOpen = ref(false);
const balanceModalOpen = ref(false);
const changesModalOpen = ref(false);
const scheduledModalOpen = ref(false);
const orderDetailModalOpen = ref(false);
const selectedOrder = ref<PaymentOrder | null>(null);

// Toast
const toastMessage = ref("");
const toastVisible = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// Order Polling
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Computed
const totalBalance = computed(() => overview.value?.wallet?.totalAvailable ?? 0);
const periodBalance = computed(() => overview.value?.wallet?.periodBalance ?? 0);
const permanentBalance = computed(() => overview.value?.wallet?.permanentBalance ?? 0);
const legacyBalance = computed(() => overview.value?.wallet?.legacyBalance ?? 0);

const currentSub = computed<ActiveSubscription | null>(() => overview.value?.subscription ?? null);
const scheduledSub = computed<ScheduledSubscription | null>(() => overview.value?.scheduled ?? null);

const currentPlanTag = computed(() => {
  if (currentSub.value) {
    const cycleName = currentSub.value.cycle === "annual" ? "年付" : "月付";
    return `${currentSub.value.planName} · ${cycleName}`;
  }
  if (overview.value?.scenario === "expired") return "套餐已到期";
  return "未开通套餐";
});

const periodDenominator = computed(() => {
  if (!currentSub.value) return "暂无当期额度";
  return `/ ${formatNumber(currentSub.value.currentPeriodGrant)} 积分`;
});

const periodGrant = computed(() => currentSub.value?.currentPeriodGrant ?? 1);

const periodProgressPercent = computed(() => {
  if (!currentSub.value || currentSub.value.currentPeriodGrant <= 0) return 0;
  const pct = (periodBalance.value / currentSub.value.currentPeriodGrant) * 100;
  return Math.min(100, Math.max(0, pct));
});

const periodExpiryText = computed(() => {
  if (!currentSub.value) return "开通套餐后按期发放";
  return `${formatTime(currentSub.value.currentPeriodEnd)} 到期`;
});

const periodExpiryHint = computed(() => {
  if (!currentSub.value) return "";
  const diffMs = new Date(currentSub.value.currentPeriodEnd).getTime() - Date.now();
  const days = Math.ceil(diffMs / 86400000);
  return days > 0 ? `${days} 天后` : "已到期";
});

const subscriptionDescription = computed(() => {
  if (currentSub.value) {
    const cycleName = currentSub.value.cycle === "annual" ? "年付" : "月付";
    const detail = currentSub.value.cycle === "annual" ? "积分每月发放，服务期尚未结束。" : "手动续费，不自动扣款。";
    return `当前服务：${currentSub.value.planName} · ${cycleName}，至 ${formatTime(currentSub.value.serviceEnd)}。${detail}`;
  }
  if (overview.value?.scenario === "expired") {
    return "当前套餐已结束，永久积分仍可继续使用。";
  }
  return "尚未开通周期套餐，也可直接购买加油包。";
});

const planStateTip = computed(() => {
  if (!currentSub.value) {
    return "开通后从付款时间开始计算服务期；永久积分始终独立保留。";
  }
  const cycleName = currentSub.value.cycle === "annual" ? "年付" : "月付";
  return `当前为${currentSub.value.planName} · ${cycleName}。同周期升级立即生效；续费、降档或付款周期切换在已购服务结束后生效。`;
});

const ledgerExpiringSoon = computed(() => {
  if (!currentSub.value) return 0;
  const diffMs = new Date(currentSub.value.currentPeriodEnd).getTime() - Date.now();
  return diffMs <= 7 * 86400000 && diffMs > 0 ? periodBalance.value : 0;
});

const ledgerUsed = computed(() => currentSub.value?.usedCredits ?? 0);

// Number / Money Formatters
function formatNumber(val: number | string | undefined | null): string {
  const n = Number(val || 0);
  return n.toLocaleString("zh-CN");
}

function formatYuan(fen: number | undefined | null, decimals: number | null = null): string {
  const f = Number(fen || 0);
  const d = decimals !== null ? decimals : f % 100 !== 0 ? 2 : 0;
  return (f / 100).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getActionForPlan(planId: string): PlanAction {
  const key = `${planId}_${activeCycle.value}`;
  if (overview.value?.planActions && overview.value.planActions[key]) {
    return overview.value.planActions[key];
  }
  return {
    type: "activate",
    label: overview.value?.scenario === "expired" ? "重新开通" : "立即开通",
    note: "支付成功后生效，开启新的服务期",
  };
}

function isCurrentPlan(planId: string): boolean {
  return Boolean(currentSub.value && currentSub.value.planId === planId && currentSub.value.cycle === activeCycle.value);
}

function isScheduledPlan(planId: string): boolean {
  return Boolean(scheduledSub.value && scheduledSub.value.planId === planId && scheduledSub.value.cycle === activeCycle.value);
}

function toast(msg: string): void {
  toastMessage.value = msg;
  toastVisible.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastVisible.value = false;
  }, 3200);
}

// Actions & Navigation
function selectTab(tab: "plans" | "topups" | "ledger" | "orders"): void {
  activeTab.value = tab;
  if (tab === "ledger") loadLedger();
  if (tab === "orders") loadOrders();
}

function setCycle(cycle: "monthly" | "annual"): void {
  activeCycle.value = cycle;
}

async function openPlanCheckout(planId: string): Promise<void> {
  if (scheduledSub.value && !isScheduledPlan(planId)) {
    scheduledModalOpen.value = true;
    return;
  }
  if (isScheduledPlan(planId)) {
    scheduledModalOpen.value = true;
    return;
  }
  await startCheckout("plan", planId, activeCycle.value);
}

async function openTopupCheckout(topupId: string): Promise<void> {
  await startCheckout("topup", topupId);
}

async function startCheckout(kind: "plan" | "topup", itemId: string, cycle?: "monthly" | "annual"): Promise<void> {
  quoteLoading.value = true;
  checkoutErrorMessage.value = "";
  acknowledgeChecked.value = false;
  paymentSuccess.value = false;
  activeOrderResponse.value = null;
  payQrCodeDataUrl.value = "";
  currentQuote.value = null;
  checkoutOpen.value = true;

  try {
    const res = await requestBillingQuote(kind, itemId, cycle);
    currentQuote.value = res.quote;
  } catch (err: any) {
    checkoutErrorMessage.value = err?.message || "获取套餐报价失败，请重试";
  } finally {
    quoteLoading.value = false;
  }
}

async function submitPayment(): Promise<void> {
  if (!currentQuote.value || submittingOrder.value || !acknowledgeChecked.value) return;
  submittingOrder.value = true;
  checkoutErrorMessage.value = "";
  try {
    const idem = `rb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await createOrderWithQuote(selectedProvider.value, currentQuote.value.quoteId, idem);
    activeOrderResponse.value = res;

    // Generate QR code
    const qrPayload = res.qrCode || res.payUrl;
    if (qrPayload) {
      try {
        payQrCodeDataUrl.value = await QRCode.toDataURL(qrPayload, {
          width: 200,
          margin: 1,
          color: { dark: "#120f10", light: "#ffffff" },
        });
      } catch {
        payQrCodeDataUrl.value = "";
      }
    }

    // Start polling status
    startOrderPolling(res.order.outTradeNo);
  } catch (err: any) {
    checkoutErrorMessage.value = err?.message || "创建支付订单失败，请重试";
  } finally {
    submittingOrder.value = false;
  }
}

function startOrderPolling(outTradeNo: string): void {
  stopOrderPolling();
  let pollCount = 0;
  pollTimer = setInterval(async () => {
    pollCount++;
    try {
      const res = await checkPaymentStatus(outTradeNo, selectedProvider.value);
      if (res.order.status === "paid") {
        stopOrderPolling();
        paymentSuccess.value = true;
        await refreshAllData();
        toast("支付成功，权益已自动入账！");
      } else if (res.order.status === "closed" || res.order.status === "expired" || res.order.status === "failed") {
        stopOrderPolling();
        checkoutErrorMessage.value = `订单状态：${res.order.status}`;
      }
    } catch {
      // silent poll catch
    }
    if (pollCount > 100) stopOrderPolling();
  }, 2500);
}

function stopOrderPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function closeCheckoutDialog(): void {
  stopOrderPolling();
  checkoutOpen.value = false;
  currentQuote.value = null;
  activeOrderResponse.value = null;
  paymentSuccess.value = false;
}

function viewOrderDetail(order: PaymentOrder): void {
  selectedOrder.value = order;
  orderDetailModalOpen.value = true;
}

function exportLedgerCsv(): void {
  const url = getLedgerExportUrl(ledgerFilter.value, ledgerQuery.value);
  window.open(url, "_blank");
  toast("已生成积分明细导出下载。");
}

async function loadLedger(): Promise<void> {
  loadingLedger.value = true;
  try {
    const res = await fetchLedger({ filter: ledgerFilter.value, query: ledgerQuery.value });
    ledgerRows.value = res.rows;
  } catch (err) {
    console.error("Failed to load ledger:", err);
  } finally {
    loadingLedger.value = false;
  }
}

async function loadOrders(): Promise<void> {
  loadingOrders.value = true;
  try {
    const res = await fetchOrders();
    orders.value = res.orders;
  } catch (err) {
    console.error("Failed to load orders:", err);
  } finally {
    loadingOrders.value = false;
  }
}

async function refreshAllData(): Promise<void> {
  try {
    const [ov, cat] = await Promise.all([fetchWalletOverview(), fetchRechargePlans()]);
    overview.value = ov;
    plans.value = cat.plans;
    topups.value = cat.topups || [];
    fakeSettle.value = cat.fakeSettle;
    providers.value = cat.providers || { alipay: true, wxpay: false };
    if (cat.providers?.alipay) selectedProvider.value = "alipay";
    else if (cat.providers?.wxpay) selectedProvider.value = "wxpay";
  } catch (err) {
    console.error("Failed to refresh data:", err);
  }
  if (activeTab.value === "ledger") loadLedger();
  if (activeTab.value === "orders") loadOrders();
}

onMounted(async () => {
  await refreshAllData();
  loadingOverview.value = false;
  loadingCatalog.value = false;

  // Check route hash or query to activate tab
  if (route.hash === "#billing-orders" || route.hash === "#orders" || route.query.tab === "orders") {
    selectTab("orders");
  } else if (route.hash === "#topups" || route.query.tab === "topups") {
    selectTab("topups");
  } else if (route.hash === "#ledger" || route.query.tab === "ledger") {
    selectTab("ledger");
  }

  // If direct plan query was passed, e.g. ?plan=pro
  const requestedPlan = String(route.query.plan || "");
  if (requestedPlan && plans.value.some((p) => p.id === requestedPlan)) {
    openPlanCheckout(requestedPlan);
  }
});

onBeforeUnmount(() => {
  stopOrderPolling();
  if (toastTimer) clearTimeout(toastTimer);
});

watch(ledgerFilter, () => {
  loadLedger();
});

let ledgerSearchTimer: ReturnType<typeof setTimeout> | null = null;
function onLedgerSearchInput(e: Event): void {
  ledgerQuery.value = (e.target as HTMLInputElement).value;
  if (ledgerSearchTimer) clearTimeout(ledgerSearchTimer);
  ledgerSearchTimer = setTimeout(() => {
    loadLedger();
  }, 300);
}
</script>

<template>
  <div class="billing-view-root">
    <!-- SVG Sprite Definitions from V2 Prototype -->
    <svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
      <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-down" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 3v4m8-4v4M4 10h16m-12 5h3m3 0h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-bolt" viewBox="0 0 24 24"><path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
      <symbol id="i-infinity" viewBox="0 0 24 24"><path d="M12 12c-2-3-4-5-6-5a5 5 0 0 0 0 10c2 0 4-2 6-5s4-5 6-5a5 5 0 0 1 0 10c-2 0-4-2-6-5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
      <symbol id="i-wallet" viewBox="0 0 24 24"><path d="M19 7V4H6a3 3 0 0 0-3 3v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H6a3 3 0 0 1-3-3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 12h-6v5h6m-3-2.5h.01" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6m0-10h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-spark" viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm8-1v4m-2-2h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
      <symbol id="i-leaf" viewBox="0 0 24 24"><path d="M20 3C9 3 3 5 4 12c1 7 13 11 16-9ZM4 21 15 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
      <symbol id="i-list" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 8h6m-6 4h6m-6 4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-receipt" viewBox="0 0 24 24"><path d="M5 3h14v19l-4-2-3 2-3-2-4 2V3Zm4 5h6m-6 4h6m-6 4h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="1" fill="currentColor"/><path d="m3 17 6-6 4 4 3-3 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
      <symbol id="i-trend" viewBox="0 0 24 24"><path d="m3 16 6-6 4 4 8-10m-6 0h6v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-pen" viewBox="0 0 24 24"><path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15l-1 5Zm8 0h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3 10a9 9 0 1 1 1 8M3 4v6h6m3-3v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    </svg>

    <div class="page-content">
      <!-- Topline & Breadcrumbs -->
      <div class="topline">
        <div class="breadcrumbs">
          <span>工作台</span>
          <span>/</span>
          <span>个人中心</span>
          <span>/</span>
          <b>套餐与积分</b>
        </div>
      </div>

      <!-- Page Header -->
      <header class="page-header">
        <div>
          <h1 class="page-title">套餐与积分</h1>
          <p class="page-subtitle">周期套餐更划算，加油包更灵活。选择适合你的创作节奏。</p>
        </div>
        <button type="button" class="button button-rules" @click="rulesModalOpen = true">
          <svg class="ico sm"><use href="#i-info"/></svg>积分消耗规则
        </button>
      </header>

      <!-- Wallet Section -->
      <section class="wallet" aria-label="我的积分账户">
        <div class="wallet-cell wallet-total">
          <div class="wallet-cell-head">
            <span class="eyebrow"><svg class="ico sm"><use href="#i-wallet"/></svg>当前可用积分</span>
            <span class="tag" id="wallet-plan-tag">{{ currentPlanTag }}</span>
          </div>
          <div class="balance">
            <strong class="num" id="total-balance">{{ formatNumber(totalBalance) }}</strong>
            <small>积分</small>
          </div>
          <div class="wallet-foot">
            <span>本期积分 + 永久积分</span>
            <button type="button" class="text-button" @click="balanceModalOpen = true">
              账户详情<svg class="ico sm"><use href="#i-arrow"/></svg>
            </button>
          </div>
        </div>

        <div class="wallet-cell">
          <div class="wallet-cell-head">
            <span class="eyebrow"><svg class="ico sm"><use href="#i-calendar"/></svg>本期积分</span>
            <span class="small muted" style="font-size:10px">优先使用</span>
          </div>
          <div class="balance">
            <strong class="num" id="period-balance">{{ formatNumber(periodBalance) }}</strong>
            <span class="balance-denominator" id="period-denominator">{{ periodDenominator }}</span>
          </div>
          <div class="quota-track" role="progressbar" aria-label="本期剩余积分" :aria-valuenow="periodBalance" :aria-valuemax="periodGrant">
            <span id="period-track" :style="{ width: periodProgressPercent + '%' }"></span>
          </div>
          <div class="wallet-foot" style="margin-top:0">
            <span id="period-expiry">{{ periodExpiryText }}</span>
            <span id="period-expiry-hint" style="color:#a47745">{{ periodExpiryHint }}</span>
          </div>
        </div>

        <div class="wallet-cell wallet-permanent">
          <div class="wallet-cell-head">
            <span class="eyebrow"><svg class="ico sm"><use href="#i-infinity"/></svg>永久积分</span>
            <span class="tag neutral" style="padding:2px 7px;font-size:10px">不过期</span>
          </div>
          <div class="balance">
            <strong class="num" id="permanent-balance">{{ formatNumber(permanentBalance) }}</strong>
            <small>积分</small>
          </div>
          <div class="permanent-note">不设到期日，套餐到期后仍可使用</div>
          <div class="wallet-foot">
            <span>含加油包与历史保留积分</span>
            <button type="button" class="text-button" @click="selectTab('topups')">
              购买加油包<svg class="ico sm"><use href="#i-arrow"/></svg>
            </button>
          </div>
        </div>
      </section>

      <!-- Wallet Rule Banner -->
      <div class="wallet-rule">
        <span class="wallet-rule-left">
          <svg class="ico sm"><use href="#i-shield"/></svg>优先使用即将到期的积分，最后使用永久积分。
        </span>
        <button type="button" class="text-button" @click="selectTab('ledger')">
          查看积分明细<svg class="ico sm"><use href="#i-arrow"/></svg>
        </button>
      </div>

      <!-- Subscription Status Strip -->
      <div class="subscription-status">
        <span id="subscription-description">{{ subscriptionDescription }}</span>
        <button type="button" class="text-button" @click="changesModalOpen = true">
          套餐变更说明<svg class="ico sm"><use href="#i-arrow"/></svg>
        </button>
      </div>

      <!-- Pending Banner -->
      <div v-if="scheduledSub" class="pending-banner" id="pending-banner">
        <span>
          <svg class="ico sm"><use href="#i-check"/></svg> 已购买待生效：<b>{{ scheduledSub.planName }}</b>，{{ formatTime(scheduledSub.startAt) }} 生效。现有权益不变。
        </span>
        <button type="button" class="text-button" @click="scheduledModalOpen = true">查看安排</button>
      </div>

      <!-- Tabs Navigation -->
      <div class="tabs" role="tablist" aria-label="套餐与积分页面">
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="activeTab === 'plans'"
          :tabindex="activeTab === 'plans' ? 0 : -1"
          @click="selectTab('plans')"
        >
          <svg class="ico"><use href="#i-calendar"/></svg>周期套餐
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="activeTab === 'topups'"
          :tabindex="activeTab === 'topups' ? 0 : -1"
          @click="selectTab('topups')"
        >
          <svg class="ico"><use href="#i-bolt"/></svg>积分加油包<span class="tab-note">不过期</span>
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          :aria-selected="activeTab === 'ledger'"
          :tabindex="activeTab === 'ledger' ? 0 : -1"
          @click="selectTab('ledger')"
        >
          <svg class="ico"><use href="#i-list"/></svg>积分明细
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          id="billing-orders"
          :aria-selected="activeTab === 'orders'"
          :tabindex="activeTab === 'orders' ? 0 : -1"
          @click="selectTab('orders')"
        >
          <svg class="ico"><use href="#i-receipt"/></svg>订单记录
        </button>
      </div>

      <!-- Panel: Plans -->
      <section v-if="activeTab === 'plans'" class="tab-panel" role="tabpanel">
        <div class="section-head">
          <div>
            <h2>把每一次灵感，变成持续的创作</h2>
            <p>按购买日计算周期，不是自然月月底清零。</p>
          </div>
          <div class="billing-toggle-wrap">
            <div class="billing-toggle" role="group" aria-label="付款周期">
              <button
                type="button"
                class="cycle-button"
                :class="{ active: activeCycle === 'monthly' }"
                :aria-pressed="activeCycle === 'monthly'"
                @click="setCycle('monthly')"
              >
                月付
              </button>
              <button
                type="button"
                class="cycle-button"
                :class="{ active: activeCycle === 'annual' }"
                :aria-pressed="activeCycle === 'annual'"
                @click="setCycle('annual')"
              >
                年付
              </button>
            </div>
            <span class="save-badge">年付享优惠</span>
          </div>
        </div>

        <!-- Plans Grid -->
        <div class="plans-grid">
          <article
            v-for="plan in plans"
            :key="plan.id"
            class="plan-card"
            :class="{ featured: plan.featured }"
            :aria-label="plan.name"
          >
            <span v-if="plan.featured" class="recommend">推荐选择</span>
            <div class="plan-name-row">
              <div class="plan-name">
                <span class="plan-mark"><svg class="ico"><use :href="`#i-${plan.icon || 'spark'}`"/></svg></span>
                <h3>{{ plan.name }}</h3>
              </div>
              <span class="plan-tag" :class="{ current: isCurrentPlan(plan.id) }">
                {{ isCurrentPlan(plan.id) ? "当前套餐" : plan.label || "创作版" }}
              </span>
            </div>
            <p class="plan-desc">{{ plan.desc || "创作运营方案" }}</p>

            <div class="price-row">
              <span class="price-currency">¥</span>
              <strong class="price-number num">
                {{ formatYuan(activeCycle === 'annual' ? plan.annualFen : plan.monthlyFen) }}
              </strong>
              <span class="price-unit">/ {{ activeCycle === "annual" ? "年" : "月" }}</span>
            </div>
            <div class="price-caption">
              {{ activeCycle === "annual" ? "一次支付全年费用 · 积分按月发放" : "单次购买一个月 · 不自动续费" }}
            </div>

            <div class="quota-block">
              <div class="quota-big num">{{ formatNumber(plan.credits) }}<span>积分 / 月</span></div>
              <div class="quota-desc">
                <svg class="ico"><use href="#i-calendar"/></svg>
                {{ activeCycle === "annual" ? "每月发放，共 12 期 · 当期有效" : "当期有效，到期不结转" }}
              </div>
            </div>

            <p class="plan-use-label">积分全部用于单一用途时</p>
            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>标准单图约 <b>{{ formatNumber(plan.credits) }} 张</b></div>
            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>或四张标准组图约 <b>{{ formatNumber(Math.floor(plan.credits / 4)) }} 组</b></div>
            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>趋势、选题与图片共享额度</div>

            <div class="plan-bottom">
              <button
                type="button"
                class="button plan-cta"
                :class="plan.featured ? 'primary' : 'subtle'"
                :disabled="Boolean(scheduledSub && !isScheduledPlan(plan.id))"
                @click="openPlanCheckout(plan.id)"
              >
                {{ isScheduledPlan(plan.id) ? "查看已购安排" : getActionForPlan(plan.id).label }}
                <svg class="ico sm"><use href="#i-arrow"/></svg>
              </button>
              <p class="plan-bottom-note">
                {{ scheduledSub && !isScheduledPlan(plan.id) ? "已有待生效订单，请先查看已购安排" : getActionForPlan(plan.id).note }}
              </p>
            </div>
          </article>
        </div>

        <p class="usage-caption">
          <svg class="ico"><use href="#i-info"/></svg>
          <span>图片数量为积分全部用于该用途的估算，非叠加额度。进阶模型和高分辨率按实际规则扣分。</span>
        </p>

        <div class="common-benefits">
          <strong>所有套餐均享完整创作能力</strong>
          <div class="benefit-items">
            <span><svg class="ico"><use href="#i-trend"/></svg>趋势分析</span>
            <span><svg class="ico"><use href="#i-pen"/></svg>内容选题</span>
            <span><svg class="ico"><use href="#i-image"/></svg>图片生成</span>
            <span><svg class="ico"><use href="#i-spark"/></svg>智能改图</span>
            <span><svg class="ico"><use href="#i-history"/></svg>历史复用</span>
          </div>
        </div>

        <div class="next-period-tip">
          <svg class="ico"><use href="#i-info"/></svg>
          <span>{{ planStateTip }} <button type="button" class="text-button" @click="changesModalOpen = true">了解变更规则 →</button></span>
        </div>
      </section>

      <!-- Panel: Topups -->
      <section v-if="activeTab === 'topups'" class="tab-panel" role="tabpanel">
        <div class="section-head">
          <div>
            <h2>灵感不等下个月，随时为创作加油</h2>
            <p>偶尔创作，或临时超量。一次购买，按需使用。</p>
          </div>
          <span class="tag neutral"><svg class="ico sm"><use href="#i-infinity"/></svg>永久有效 · 无需会员</span>
        </div>

        <div class="topup-intro">
          <svg class="ico sm"><use href="#i-shield"/></svg>加油包立即到账，不改变套餐周期；周期积分用完后，自动使用永久积分。
        </div>

        <div class="plans-grid">
          <article
            v-for="pack in topups"
            :key="pack.id"
            class="plan-card topup-card"
            :class="{ featured: pack.featured }"
            :aria-label="pack.name"
          >
            <span v-if="pack.featured" class="recommend">灵活之选</span>
            <div class="plan-name-row">
              <div class="plan-name">
                <span class="plan-mark"><svg class="ico"><use :href="`#i-${pack.icon || 'bolt'}`"/></svg></span>
                <h3>{{ pack.name }}</h3>
              </div>
              <span class="plan-tag">不过期</span>
            </div>
            <p class="plan-desc">{{ pack.desc }}</p>

            <div class="topup-credit-hero">
              <strong class="num">{{ formatNumber(pack.credits) }}</strong>
              <span>永久积分</span>
            </div>
            <div class="price-row">
              <span class="price-currency">¥</span>
              <strong class="price-number num">{{ formatYuan(pack.amountFen) }}</strong>
              <span class="price-unit">/ 一次性</span>
            </div>
            <div class="price-caption">按需补充，一次购买即可使用</div>

            <div class="quota-block">
              <div class="quota-desc" style="margin:0;color:#795e47">
                <svg class="ico"><use href="#i-infinity"/></svg>不设到期日，用完为止
              </div>
            </div>

            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>购买后立即到账</div>
            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>套餐到期后仍可使用</div>
            <div class="plan-feature"><svg class="ico"><use href="#i-check"/></svg>优先使用当期积分，再用加油包</div>

            <div class="plan-bottom">
              <button
                type="button"
                class="button plan-cta"
                :class="pack.featured ? 'primary' : 'subtle'"
                @click="openTopupCheckout(pack.id)"
              >
                购买加油包<svg class="ico sm"><use href="#i-plus"/></svg>
              </button>
              <p class="plan-bottom-note">无需会员 · 不改变套餐周期</p>
            </div>
          </article>
        </div>

        <div class="compare-box">
          <div class="compare-top">
            <div>
              <h3>按创作节奏选择，不必为了积分续费</h3>
              <p>持续创作，选择周期套餐；临时补充，选择加油包。</p>
            </div>
            <div class="compare-options">
              <div class="compare-option"><span>周期套餐</span><strong>按期发放 · 当期有效</strong></div>
              <div class="compare-option active"><span>积分加油包</span><strong>一次到账 · 不设到期日</strong></div>
            </div>
          </div>
          <div class="compare-bottom">
            <svg class="ico sm"><use href="#i-shield"/></svg>加油包不改变已购套餐；套餐到期后，永久积分仍可独立使用。
          </div>
        </div>
      </section>

      <!-- Panel: Ledger -->
      <section v-if="activeTab === 'ledger'" class="tab-panel" role="tabpanel">
        <div class="section-head">
          <div>
            <h2>每一笔积分，都清清楚楚</h2>
            <p>分别记录发放、使用与到期，保留完整来源。</p>
          </div>
          <button type="button" class="button" @click="exportLedgerCsv">
            <svg class="ico sm"><use href="#i-download"/></svg>导出明细
          </button>
        </div>

        <div class="ledger-summary">
          <div class="ledger-stat">
            <span>当前可用积分</span>
            <strong class="num">{{ formatNumber(totalBalance) }}</strong>
          </div>
          <div class="ledger-stat">
            <span>本期已使用</span>
            <strong class="num">{{ formatNumber(ledgerUsed) }}</strong>
          </div>
          <div class="ledger-stat">
            <span>7 天内到期</span>
            <strong class="num" style="color:#ab7452">{{ formatNumber(ledgerExpiringSoon) }}</strong>
          </div>
        </div>

        <div class="table-surface">
          <div class="table-toolbar">
            <div class="filter-group" role="group" aria-label="流水类型">
              <button
                type="button"
                class="filter"
                :class="{ active: ledgerFilter === 'all' }"
                :aria-pressed="ledgerFilter === 'all'"
                @click="ledgerFilter = 'all'"
              >
                全部
              </button>
              <button
                type="button"
                class="filter"
                :class="{ active: ledgerFilter === 'spend' }"
                :aria-pressed="ledgerFilter === 'spend'"
                @click="ledgerFilter = 'spend'"
              >
                使用
              </button>
              <button
                type="button"
                class="filter"
                :class="{ active: ledgerFilter === 'grant' }"
                :aria-pressed="ledgerFilter === 'grant'"
                @click="ledgerFilter = 'grant'"
              >
                入账
              </button>
              <button
                type="button"
                class="filter"
                :class="{ active: ledgerFilter === 'expire' }"
                :aria-pressed="ledgerFilter === 'expire'"
                @click="ledgerFilter = 'expire'"
              >
                到期
              </button>
            </div>
            <label class="search-wrap">
              <svg class="ico sm"><use href="#i-search"/></svg>
              <input
                :value="ledgerQuery"
                placeholder="搜索任务或积分来源"
                aria-label="搜索积分明细"
                @input="onLedgerSearchInput"
              />
            </label>
          </div>

          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>积分变化</th>
                  <th>积分来源</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in ledgerRows" :key="r.id">
                  <td>{{ r.time }}</td>
                  <td class="primary-cell">{{ r.label }}</td>
                  <td class="delta num" :class="r.delta > 0 ? 'positive' : 'negative'">
                    {{ r.delta > 0 ? '+' : '−' }}{{ formatNumber(Math.abs(r.delta)) }}
                  </td>
                  <td>
                    <span class="tag" :class="{ neutral: r.source === '永久积分' }" style="padding:3px 7px;font-size:10px">
                      {{ r.source }}
                    </span>
                  </td>
                  <td>{{ r.note }}</td>
                </tr>
                <tr v-if="ledgerRows.length === 0">
                  <td colspan="5" class="table-empty">
                    {{ loadingLedger ? "正在加载流水记录…" : "暂无匹配的积分流水。开通套餐或购买加油包后，可在这里查看。" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="table-foot">
            <span>共 {{ ledgerRows.length }} 笔积分流水</span>
          </div>
        </div>
      </section>

      <!-- Panel: Orders -->
      <section v-if="activeTab === 'orders'" class="tab-panel" role="tabpanel">
        <div class="section-head">
          <div>
            <h2>订单记录</h2>
            <p>套餐、到账积分与付款状态，一处查看。</p>
          </div>
          <button type="button" class="button" @click="loadOrders">
            <svg class="ico sm"><use href="#i-refresh"/></svg>刷新记录
          </button>
        </div>

        <div class="table-surface">
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>商品 / 订单号</th>
                  <th>金额</th>
                  <th>积分发放</th>
                  <th>支付方式</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in orders" :key="o.outTradeNo">
                  <td class="primary-cell">
                    <strong>{{ o.planName }}</strong>
                    <small>{{ o.outTradeNo }}</small>
                  </td>
                  <td class="num" style="font-weight:600;color:#49352b">
                    ¥{{ o.amountYuan || formatYuan(o.amountFen) }}
                  </td>
                  <td>
                    <span>
                      {{ o.orderKind === 'topup' ? `${formatNumber(o.planCredits)} 永久积分` : o.orderAction === 'upgrade' ? `本期补发 ${formatNumber(o.issuedNow)} 积分` : `${formatNumber(o.planCredits)} 积分 / 月` }}
                    </span>
                    <small>
                      {{ o.status === 'closed' ? '未发放' : o.orderKind === 'topup' ? '一次到账 · 不过期' : o.fulfillmentStatus === 'scheduled' ? '服务衔接 · 到期后发放' : o.orderAction === 'upgrade' ? '已补发 · 原到期日不变' : o.cycle === 'annual' ? '按月发放 · 共 12 期' : '首期已发放' }}
                    </small>
                  </td>
                  <td>{{ o.provider === 'wxpay' ? '微信支付' : '支付宝' }}</td>
                  <td>
                    <span class="status" :class="{ closed: o.status === 'closed' || o.status === 'expired' }">
                      {{ o.status === 'paid' ? '已支付' : o.status === 'closed' ? '已取消' : o.status === 'expired' ? '已过期' : '待支付' }}
                    </span>
                  </td>
                  <td>
                    <button type="button" class="text-button" @click="viewOrderDetail(o)">查看详情</button>
                  </td>
                </tr>
                <tr v-if="orders.length === 0">
                  <td colspan="6" class="table-empty">
                    {{ loadingOrders ? "正在加载订单记录…" : "暂无订单。购买套餐或加油包后，订单会出现在这里。" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="table-foot">
            <span>共 {{ orders.length }} 笔订单</span>
            <span>点击详情查看发放与到期规则</span>
          </div>
        </div>
      </section>

      <!-- FAQ Section -->
      <section v-if="activeTab === 'plans' || activeTab === 'topups'" class="faq">
        <div class="faq-heading">
          <h3>关于积分，你可能还想知道</h3>
          <button type="button" class="text-button" @click="rulesModalOpen = true">
            查看扣分规则<svg class="ico sm"><use href="#i-arrow"/></svg>
          </button>
        </div>
        <div class="faq-grid">
          <details>
            <summary>周期套餐和加油包有什么区别？</summary>
            <p>周期套餐适合持续创作，当期未用完的积分到期失效，不结转。加油包一次到账，不设到期日；即使没有有效套餐，也可继续使用。</p>
          </details>
          <details>
            <summary>年付积分是一次发完吗？</summary>
            <p>不是。年付一次支付 12 个月的服务费，按月发放积分，共 12 期。每期积分独立到期，不累积到下个月，也不能提前支取未来额度。</p>
          </details>
          <details>
            <summary>原来已经购买的积分会过期吗？</summary>
            <p>不会。此前按永久规则获得的剩余积分，保留原有有效性，在账户中显示为“历史保留积分”。仅新购买的周期套餐适用到期规则。</p>
          </details>
          <details>
            <summary>怎样扣分？生成失败会扣积分吗？</summary>
            <p>先使用最早到期的可用积分，再使用永久积分。任务成功后结算，系统原因失败释放预占积分。</p>
          </details>
          <details>
            <summary>续费会让本期没用完的积分延期吗？</summary>
            <p>不会。续费只衔接已购服务期，本期剩余积分仍按原时间到期。年付服务期结束与每月积分到期是两个日期，续费不会把下一次月度发放当作年付服务到期。</p>
          </details>
          <details>
            <summary>套餐没到期，可以升级或更换吗？</summary>
            <p>同一付款周期内升级：补差价后立即生效，本期按剩余时长补发增量积分，保留现有余额和到期日。降档或月付、年付切换：当前已购服务期结束后生效，不覆盖已付费权益。详情会在结算前再次展示。</p>
          </details>
          <details>
            <summary>会自动续费或自动扣款吗？</summary>
            <p>本方案第一版采用手动购买，不自动续费，也不自动扣款。付款前会展示明确的生效和到期时间。</p>
          </details>
        </div>
      </section>

      <!-- Footer -->
      <footer class="page-footer">
        <span>REDBASE / 为品牌持续创造好内容</span>
        <span><svg class="ico"><use href="#i-shield"/></svg>周期套餐与积分账户 · 安全可信</span>
      </footer>
    </div>

    <!-- Checkout Dialog -->
    <div v-if="checkoutOpen" class="dialog-backdrop" @click.self="closeCheckoutDialog">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <div class="dialog-head">
          <div>
            <h2 id="checkout-title">
              {{ currentQuote?.kind === 'topup' ? '确认购买加油包' : currentQuote?.action === 'upgrade' ? '确认升级套餐' : currentQuote?.action === 'renew' ? '确认续费套餐' : currentQuote?.action === 'downgrade' ? '确认到期更换' : currentQuote?.action === 'interval' ? '确认套餐与付款周期变更' : overview?.scenario === 'expired' ? '确认重新开通' : '确认开通套餐' }}
            </h2>
            <p>{{ currentQuote?.action === 'upgrade' ? '确认升级补款、增量积分与原到期日。' : '核对生效时间、发放方式与有效期，再完成付款。' }}</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭结算" @click="closeCheckoutDialog">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>

        <!-- Loading Quote State -->
        <div v-if="quoteLoading" class="dialog-body" style="text-align:center;padding:40px">
          <p>正在生成权威服务端报价…</p>
        </div>

        <!-- Error State -->
        <div v-else-if="checkoutErrorMessage && !activeOrderResponse" class="dialog-body">
          <div class="important-note" style="background:#fff2f0;border-color:#ffccc7;color:#cf1322">
            <svg class="ico"><use href="#i-info"/></svg>
            <span>{{ checkoutErrorMessage }}</span>
          </div>
          <button type="button" class="button" style="width:100%;margin-top:16px" @click="closeCheckoutDialog">返回</button>
        </div>

        <!-- Payment Success View -->
        <div v-else-if="paymentSuccess" class="dialog-body success-body">
          <div class="success-circle"><svg class="ico"><use href="#i-check"/></svg></div>
          <h3>{{ currentQuote?.kind === 'topup' ? '加油包已到账' : currentQuote?.action === 'upgrade' ? '套餐已升级' : currentQuote?.scheduled ? '已购买，待生效' : '套餐已开通' }}</h3>
          <p v-if="currentQuote?.kind === 'topup'">
            {{ formatNumber(currentQuote.issuedNow) }} 永久积分已加入账户。<br>当前套餐与本期积分保持不变。
          </p>
          <p v-else-if="currentQuote?.action === 'upgrade'">
            {{ currentQuote.itemName }}已生效，本期补发 {{ formatNumber(currentQuote.issuedNow) }} 积分。<br>原有余额保留，到期时间不变。
          </p>
          <p v-else-if="currentQuote?.scheduled">
            {{ currentQuote.itemName }}已安排在当前服务到期后启用。<br>本期积分、永久积分及当前已购权益均不变。
          </p>
          <p v-else>
            {{ currentQuote?.itemName }}已生效，首期 {{ formatNumber(currentQuote?.issuedNow) }} 积分已到账。
          </p>

          <div class="success-facts">
            <div v-if="currentQuote?.action === 'upgrade'">
              <span>本次升级补款</span><b>¥{{ formatYuan(currentQuote.amountFen, 2) }}</b>
            </div>
            <div v-if="currentQuote?.action === 'upgrade'">
              <span>本期积分到期</span><b>{{ formatTime(currentQuote.periodEndAt) }}</b>
            </div>
            <div>
              <span>当前总可用积分</span><b>{{ formatNumber(totalBalance) }} 积分</b>
            </div>
          </div>

          <div class="success-actions">
            <button type="button" class="button" @click="closeCheckoutDialog(); selectTab('orders')">查看订单</button>
            <button type="button" class="button primary" @click="closeCheckoutDialog()">返回套餐与积分</button>
          </div>
        </div>

        <!-- Payment Form or QR View -->
        <div v-else-if="currentQuote" class="dialog-body">
          <div class="checkout-product">
            <div class="checkout-product-left">
              <span class="plan-mark"><svg class="ico"><use :href="`#i-${currentQuote.kind === 'topup' ? 'bolt' : 'spark'}`"/></svg></span>
              <div>
                <h3>{{ currentQuote.itemName }}{{ currentQuote.cycle ? ` · ${currentQuote.cycle === 'annual' ? '年付' : '月付'}` : '' }}</h3>
                <p>{{ formatNumber(currentQuote.meta?.credits || currentQuote.meta?.planCredits || currentQuote.issuedNow) }} {{ currentQuote.kind === 'topup' ? '永久积分' : `积分 / 月${currentQuote.cycle === 'annual' ? ' · 按月发放' : ''}` }}</p>
              </div>
            </div>
            <strong class="checkout-price num">
              <small v-if="currentQuote.action === 'upgrade'" class="price-label">本次补款</small>
              <small>¥</small>{{ formatYuan(currentQuote.amountFen, currentQuote.action === 'upgrade' ? 2 : null) }}
            </strong>
          </div>

          <!-- Specifications dl -->
          <dl class="checkout-specs">
            <template v-if="currentQuote.kind === 'topup'">
              <dt>到账方式</dt><dd>支付成功后，立即到账 {{ formatNumber(currentQuote.issuedNow) }} 积分</dd>
              <dt>有效期</dt><dd><b>不设到期日，用完为止</b></dd>
              <dt>会员要求</dt><dd>无需有效套餐，随时可用</dd>
              <dt>已有权益</dt><dd>不改变当前套餐、积分与到期日</dd>
            </template>
            <template v-else-if="currentQuote.action === 'upgrade'">
              <dt>套餐变更</dt><dd>{{ currentQuote.meta?.upgradeDetails?.oldPlanName }} → <b>{{ currentQuote.itemName }}</b>（{{ currentQuote.cycle === 'annual' ? '年付' : '月付' }}不变）</dd>
              <dt>生效时间</dt><dd><b>支付成功后立即生效</b></dd>
              <dt>服务到期</dt><dd>{{ formatTime(currentQuote.endAt) }}（保持不变）</dd>
              <dt>本期补发</dt><dd><b>+{{ formatNumber(currentQuote.issuedNow) }} 积分</b>，{{ formatTime(currentQuote.periodEndAt) }} 到期</dd>
              <dt>升级后可用</dt><dd>本期 {{ formatNumber(periodBalance) }} → <b>{{ formatNumber(periodBalance + currentQuote.issuedNow) }} 积分</b>；永久积分不变</dd>
              <dt>后续额度</dt><dd>{{ currentQuote.cycle === 'annual' ? '本年付服务后续每月' : '续费后的完整周期每月' }} {{ formatNumber(currentQuote.meta?.planCredits) }} 积分</dd>
            </template>
            <template v-else>
              <dt>生效时间</dt><dd><b>{{ currentQuote.scheduled ? `${formatTime(currentQuote.startAt)}（当前服务结束后）` : '支付成功后立即生效' }}</b></dd>
              <dt>服务期限</dt><dd>{{ formatTime(currentQuote.startAt) }} — {{ formatTime(currentQuote.endAt) }}</dd>
              <dt>积分发放</dt><dd>{{ currentQuote.cycle === 'annual' ? `每月 ${formatNumber(currentQuote.meta?.planCredits)} 积分，共 12 期` : `生效时一次发放 ${formatNumber(currentQuote.meta?.planCredits)} 积分` }}</dd>
              <dt>首期到期</dt><dd>{{ formatTime(currentQuote.periodEndAt) }}，到期不结转</dd>
              <dt>已有积分</dt><dd>{{ !currentSub ? '永久积分保留，独立使用' : '本期积分与永久积分均保持不变' }}</dd>
            </template>
          </dl>

          <!-- Important note box -->
          <div class="important-note">
            <svg class="ico"><use :href="currentQuote.kind === 'topup' ? '#i-infinity' : currentQuote.action === 'upgrade' ? '#i-trend' : '#i-clock'"/></svg>
            <span v-if="currentQuote.kind === 'topup'">本次到账为永久积分。即使套餐到期，仍可继续使用；有本期积分时优先使用本期积分。</span>
            <span v-else-if="currentQuote.action === 'upgrade'">本次只支付剩余服务期的升级差价。不清空、不重发已有积分，本期仅按剩余时长补发增量；积分与服务结束时间均不延期。</span>
            <span v-else-if="currentQuote.scheduled">现在支付，{{ formatTime(currentQuote.startAt) }} 启用新套餐。在此之前继续使用当前套餐，本期积分不会被覆盖或延期。</span>
            <span v-else>从本次付款开始计算服务期。{{ currentQuote.cycle === 'annual' ? '全年费用一次支付，积分按月发放，不一次发完全年额度。' : '首期积分立即到账，当期未用完的积分到期失效。' }}</span>
          </div>

          <!-- Upgrade Details Collapsible -->
          <details v-if="currentQuote.action === 'upgrade' && currentQuote.meta?.upgradeDetails" class="checkout-details">
            <summary>查看差价与补发说明<svg class="ico sm"><use href="#i-down"/></svg></summary>
            <div class="order-detail-list">
              <div><span>原套餐整期价格</span><b>¥{{ formatYuan(currentQuote.meta.upgradeDetails.oldFullTermPrice) }}</b></div>
              <div><span>目标套餐整期价格</span><b>¥{{ formatYuan(currentQuote.meta.upgradeDetails.targetFullTermPrice) }}</b></div>
              <div><span>服务期剩余 / 总时长</span><b>{{ currentQuote.meta.upgradeDetails.serviceDaysLeft?.toFixed(0) }} / {{ currentQuote.meta.upgradeDetails.serviceDaysTotal?.toFixed(0) }} 天</b></div>
              <div><span>本次升级补款</span><b>¥{{ formatYuan(currentQuote.amountFen, 2) }}</b></div>
              <div><span>本期剩余 / 总时长</span><b>{{ currentQuote.meta.upgradeDetails.periodDaysLeft?.toFixed(0) }} / {{ currentQuote.meta.upgradeDetails.periodDaysTotal?.toFixed(0) }} 天</b></div>
              <div><span>本期补发增量</span><b>{{ formatNumber(currentQuote.issuedNow) }} 积分</b></div>
            </div>
            <p>补款 = 两档整期价格差 × 剩余服务时长占比，金额四舍五入到分。补发 = 两档月度额度差 × 本期剩余时长占比，积分向上取整。两项分别计算，不进行人民币与积分兑换。</p>
          </details>

          <!-- Active Order Payment Area (QR Code & Status) -->
          <div v-if="activeOrderResponse" class="qr-payment-area">
            <div class="qr-container">
              <img v-if="payQrCodeDataUrl" :src="payQrCodeDataUrl" alt="支付二维码" class="qr-image" />
              <div v-else class="qr-loading">生成支付二维码中…</div>
            </div>
            <p class="qr-hint">请使用{{ selectedProvider === 'wxpay' ? '微信' : '支付宝' }}扫码完成付款</p>
            <div v-if="activeOrderResponse.payUrl" class="qr-action-row">
              <a :href="activeOrderResponse.payUrl" target="_blank" rel="noopener noreferrer" class="button">
                在新窗口打开支付页面
              </a>
            </div>
            <div v-if="fakeSettle" class="test-settle-row">
              <a :href="fakeSettleUrl(activeOrderResponse.order.outTradeNo, selectedProvider)" target="_blank" class="text-button">
                [测试环境] 模拟支付完成
              </a>
            </div>
          </div>

          <!-- Payment Methods & Acknowledge (Before order is created) -->
          <template v-else>
            <p class="payment-title">支付方式</p>
            <div class="payment-methods">
              <label class="payment-option" :class="{ selected: selectedProvider === 'alipay' }">
                <span class="pay-mark alipay">支</span>
                <span>支付宝</span>
                <input type="radio" v-model="selectedProvider" value="alipay" name="provider" />
              </label>
              <label class="payment-option" :class="{ selected: selectedProvider === 'wxpay' }">
                <span class="pay-mark wechat">微</span>
                <span>微信支付</span>
                <input type="radio" v-model="selectedProvider" value="wxpay" name="provider" />
              </label>
            </div>

            <label class="acknowledge">
              <input type="checkbox" v-model="acknowledgeChecked" />
              <span>
                我已了解{{ currentQuote.kind === 'topup' ? '加油包不设到期日' : currentQuote.action === 'upgrade' ? '本次升级补款、积分补发与到期规则' : currentQuote.scheduled ? '本次提前付款、服务到期后生效' : '套餐生效时间与积分到期规则' }}；确认付款后将生成支付订单。
              </span>
            </label>
          </template>
        </div>

        <!-- Dialog Footer -->
        <div v-if="currentQuote && !paymentSuccess" class="checkout-footer">
          <div class="total-row">
            <span>
              {{ currentQuote.action === 'upgrade' ? '本次升级补款' : '本次应付' }}
              <span class="saving">
                {{ currentQuote.scheduled ? '提前购买 · 不覆盖当前服务' : currentQuote.kind === 'topup' ? '购买后立即到账' : currentQuote.action === 'upgrade' ? '只收剩余服务期差价' : '付款成功后立即生效' }}
              </span>
            </span>
            <strong class="num">
              <small>¥</small>{{ formatYuan(currentQuote.amountFen, currentQuote.action === 'upgrade' ? 2 : null) }}
            </strong>
          </div>
          <button
            v-if="!activeOrderResponse"
            type="button"
            class="button primary payment-button"
            :disabled="!acknowledgeChecked || submittingOrder"
            @click="submitPayment"
          >
            <svg class="ico sm"><use href="#i-lock"/></svg>
            {{ submittingOrder ? '正在创建订单…' : `确认支付 ¥${formatYuan(currentQuote.amountFen, currentQuote.action === 'upgrade' ? 2 : null)}` }}
          </button>
        </div>
      </div>
    </div>

    <!-- Rules Dialog -->
    <div v-if="rulesModalOpen" class="dialog-backdrop" @click.self="rulesModalOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <h2>积分消耗规则</h2>
            <p>同一操作，所有套餐使用相同扣分规则。</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭" @click="rulesModalOpen = false">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>
        <div class="dialog-body">
          <div class="table-surface">
            <table class="rule-table">
              <thead>
                <tr><th>图片生成 / 编辑</th><th>1K</th><th>2K</th><th>4K</th></tr>
              </thead>
              <tbody>
                <tr><td>标准模型 · 单张</td><td>1 分</td><td>2 分</td><td>3 分</td></tr>
                <tr><td>进阶模型 · 单张</td><td>2 分</td><td>3 分</td><td>4 分</td></tr>
                <tr><td>四张组图</td><td colspan="3">所选单张积分消耗 × 4</td></tr>
              </tbody>
            </table>
          </div>
          <div class="table-surface" style="margin-top:15px">
            <table class="rule-table">
              <thead>
                <tr><th>其他创作操作</th><th>每次消耗</th></tr>
              </thead>
              <tbody>
                <tr><td>热点趋势分析（单维度）</td><td>1 积分</td></tr>
                <tr><td>内容选题重写</td><td>1 积分</td></tr>
                <tr><td>视频脚本生成</td><td>1 积分</td></tr>
              </tbody>
            </table>
          </div>
          <div class="important-note" style="margin-top:16px">
            <svg class="ico"><use href="#i-shield"/></svg>
            <span>先扣最早到期的积分，最后扣永久积分。系统原因失败按原来源释放预占；跨到期任务的补偿规则由正式计费系统处理。</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Balance Breakdown Modal -->
    <div v-if="balanceModalOpen" class="dialog-backdrop" @click.self="balanceModalOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <h2>我的积分账户</h2>
            <p>有效余额与来源一目了然。</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭" @click="balanceModalOpen = false">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>
        <div class="dialog-body">
          <div class="balance-lot">
            <div class="lot-head">
              <div>
                <h3><svg class="ico sm"><use href="#i-calendar"/></svg> 本期积分</h3>
                <p>{{ currentSub ? `${currentSub.planName} · ${formatTime(currentSub.currentPeriodStart)} — ${formatTime(currentSub.currentPeriodEnd)}` : '当前没有有效的周期套餐' }}</p>
              </div>
              <strong class="num">{{ formatNumber(periodBalance) }}</strong>
            </div>
            <div class="lot-details">
              <span>{{ currentSub ? `${formatTime(currentSub.currentPeriodEnd)} 到期，不结转` : '开通后获得首期积分' }}</span>
              <span class="tag amber">优先使用</span>
            </div>
            <p v-if="currentSub">本期已发 {{ formatNumber(currentSub.currentPeriodGrant) }} 积分，已用 {{ formatNumber(currentSub.usedCredits) }} 积分。{{ currentSub.cycle === 'annual' ? `年付服务至 ${formatTime(currentSub.serviceEnd)}。` : '' }}</p>
          </div>

          <div class="balance-lot">
            <div class="lot-head">
              <div>
                <h3><svg class="ico sm"><use href="#i-bolt"/></svg> 加油包积分</h3>
                <p>来自已购买的加油包</p>
              </div>
              <strong class="num">{{ formatNumber(permanentBalance - legacyBalance) }}</strong>
            </div>
            <div class="lot-details">
              <span>不设到期日</span>
              <span>周期积分使用完后扣减</span>
            </div>
          </div>

          <div class="balance-lot">
            <div class="lot-head">
              <div>
                <h3><svg class="ico sm"><use href="#i-history"/></svg> 历史保留积分</h3>
                <p>旧规则下已获得的剩余积分</p>
              </div>
              <strong class="num">{{ formatNumber(legacyBalance) }}</strong>
            </div>
            <div class="lot-details">
              <span>保留原有永久有效规则</span>
              <span class="tag neutral">不过期</span>
            </div>
          </div>

          <button type="button" class="button primary" style="width:100%;margin-top:8px" @click="balanceModalOpen = false; selectTab('ledger')">
            查看积分流水<svg class="ico sm"><use href="#i-arrow"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Change Rules Modal -->
    <div v-if="changesModalOpen" class="dialog-backdrop" @click.self="changesModalOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <h2>套餐如何续费、升级或更换？</h2>
            <p>不覆盖已购权益，不把月度积分到期当作年付服务到期。</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭" @click="changesModalOpen = false">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>
        <div class="dialog-body">
          <div class="change-rule-row">
            <span class="plan-mark"><svg class="ico"><use href="#i-leaf"/></svg></span>
            <div>
              <h3>未开通 / 已到期：立即开通 / 重新开通</h3>
              <p>支付成功后开始新的服务期，首期积分立即到账。已有永久积分不受影响。</p>
            </div>
          </div>
          <div class="change-rule-row">
            <span class="plan-mark"><svg class="ico"><use href="#i-calendar"/></svg></span>
            <div>
              <h3>同档、同周期：续费套餐</h3>
              <p>在当前已付费服务期结束后衔接一份新服务，本期积分及有效期不变。年付续费从这一年服务结束后开始。</p>
            </div>
          </div>
          <div class="change-rule-row">
            <span class="plan-mark"><svg class="ico"><use href="#i-trend"/></svg></span>
            <div>
              <h3>同周期升档：补差价，立即升级</h3>
              <p>按剩余服务时长计算补款；本期按剩余时长补发增量积分，现有积分、已用记录及到期日不变。年付后续尚未发放的月份使用新档位额度。</p>
            </div>
          </div>
          <div class="change-rule-row">
            <span class="plan-mark"><svg class="ico"><use href="#i-history"/></svg></span>
            <div>
              <h3>降档 / 月付年付切换：到期后生效</h3>
              <p>可以提前购买，完整保留当前已付费服务，结束后再启用新套餐。本方案手动购买，支付时会明确列出新服务的开始和结束时间。</p>
            </div>
          </div>
          <div class="important-note">
            <svg class="ico"><use href="#i-shield"/></svg>
            <span>每个账户只保留一个待生效套餐订单。已有安排时，先处理该订单再做新的续费或变更，避免重复购买。</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Scheduled Sub Modal -->
    <div v-if="scheduledModalOpen" class="dialog-backdrop" @click.self="scheduledModalOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <h2>已购套餐安排</h2>
            <p>新服务开始前，当前已付费权益保持不变。</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭" @click="scheduledModalOpen = false">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>
        <div v-if="scheduledSub" class="dialog-body">
          <div class="checkout-product">
            <div>
              <h3>{{ scheduledSub.planName }} · {{ scheduledSub.cycle === 'annual' ? '年付' : '月付' }}</h3>
              <p>{{ formatNumber(scheduledSub.monthlyCredits) }} 积分 / 月</p>
            </div>
            <span class="tag green">已支付 · 待生效</span>
          </div>
          <div class="order-detail-list">
            <div><span>实际支付</span><b>¥{{ formatYuan(scheduledSub.amountFen) }}</b></div>
            <div><span>新服务开始</span><b>{{ formatTime(scheduledSub.startAt) }}</b></div>
            <div><span>新服务结束</span><b>{{ formatTime(scheduledSub.endAt) }}</b></div>
            <div><span>当前可用积分</span><b>{{ formatNumber(totalBalance) }} 积分</b></div>
          </div>
          <div class="important-note">
            <svg class="ico"><use href="#i-info"/></svg>
            <span>已有一个待生效套餐，不重复收取续费或变更费用。如需调整请联系客服。</span>
          </div>
          <button type="button" class="button" style="width:100%;margin-top:15px" @click="scheduledModalOpen = false; selectTab('orders')">
            查看订单
          </button>
        </div>
      </div>
    </div>

    <!-- Order Detail Modal -->
    <div v-if="orderDetailModalOpen" class="dialog-backdrop" @click.self="orderDetailModalOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <h2>订单详情</h2>
            <p>查看订单信息与履约规则。</p>
          </div>
          <button type="button" class="close-button" aria-label="关闭" @click="orderDetailModalOpen = false">
            <svg class="ico"><use href="#i-close"/></svg>
          </button>
        </div>
        <div v-if="selectedOrder" class="dialog-body">
          <div class="checkout-product">
            <div>
              <h3>{{ selectedOrder.planName }}</h3>
              <p>{{ selectedOrder.orderAction === 'upgrade' ? '升级差价订单' : selectedOrder.fulfillmentStatus === 'scheduled' ? '已购买，等待生效' : '已支付' }}</p>
            </div>
            <strong class="checkout-price num"><small>¥</small>{{ selectedOrder.amountYuan || formatYuan(selectedOrder.amountFen) }}</strong>
          </div>
          <div class="order-detail-list">
            <div><span>订单号</span><b style="font-size:10px">{{ selectedOrder.outTradeNo }}</b></div>
            <div><span>创建时间</span><b>{{ formatTime(selectedOrder.createdAt) }}</b></div>
            <div><span>支付方式</span><b>{{ selectedOrder.provider === 'wxpay' ? '微信支付' : '支付宝' }}</b></div>
            <div><span>额度</span><b>{{ selectedOrder.orderKind === 'topup' ? `${formatNumber(selectedOrder.planCredits)} 永久积分` : selectedOrder.orderAction === 'upgrade' ? `本期补发 ${formatNumber(selectedOrder.issuedNow)} 积分` : `${formatNumber(selectedOrder.planCredits)} 积分 / 月` }}</b></div>
            <div v-if="selectedOrder.serviceStart"><span>服务开始</span><b>{{ formatTime(selectedOrder.serviceStart) }}</b></div>
            <div v-if="selectedOrder.serviceEnd"><span>服务结束</span><b>{{ formatTime(selectedOrder.serviceEnd) }}</b></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast Notification -->
    <div class="toast" :class="{ show: toastVisible }" role="status" aria-live="polite">
      <svg class="ico sm"><use href="#i-info"/></svg>
      <span>{{ toastMessage }}</span>
    </div>
  </div>
</template>

<style scoped>
.billing-view-root {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  color: var(--workspace-text, #120f10);
  font-family: var(--font-family-base, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
}

/* Typography & SVGs */
.ico {
  width: 16px;
  height: 16px;
  vertical-align: -2px;
  flex-shrink: 0;
}
.ico.sm {
  width: 13px;
  height: 13px;
}
.num {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums;
}

/* Buttons */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid var(--workspace-border-strong, rgba(18,16,17,.12));
  border-radius: var(--workspace-radius, 8px);
  background: #fff;
  color: var(--workspace-text, #120f10);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s ease;
}
.button:hover {
  border-color: rgba(216,68,68,.3);
  color: var(--workspace-brand, #d84444);
}
.button.primary {
  border-color: var(--workspace-brand, #d84444);
  background: var(--workspace-brand, #d84444);
  color: #fff;
}
.button.primary:hover {
  background: var(--workspace-brand-hover, #c83b3b);
}
.button.subtle {
  border-color: rgba(18,16,17,.1);
  background: #fff;
  color: var(--workspace-text, #120f10);
}
.button.subtle:hover {
  background: #faf7f5;
}
.button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.text-button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  color: var(--workspace-brand, #d84444);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.text-button:hover {
  text-decoration: underline;
}

/* Tags */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff0ed;
  color: var(--workspace-brand, #d84444);
  font-size: 11px;
  font-weight: 600;
}
.tag.neutral {
  background: #f0ece9;
  color: #63544d;
}
.tag.green {
  background: #e9f5f0;
  color: #2b735f;
}
.tag.amber {
  background: #fff6e8;
  color: #94651e;
}

/* Topline & Header */
.topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
}
.breadcrumbs b {
  color: var(--workspace-text, #120f10);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.page-title {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0 0 6px 0;
}
.page-subtitle {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}

/* Wallet Section */
.wallet {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 14px;
}
.wallet-cell {
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: var(--workspace-radius, 8px);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 14px rgba(80,44,44,.02);
}
.wallet-cell-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  font-weight: 500;
}
.balance {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 10px;
}
.balance strong {
  font-size: 34px;
  font-weight: 800;
  line-height: 1;
  color: #120f10;
}
.balance small {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
}
.balance-denominator {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
}
.quota-track {
  width: 100%;
  height: 6px;
  background: #eee8e4;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 10px;
}
.quota-track span {
  display: block;
  height: 100%;
  background: var(--workspace-brand, #d84444);
  border-radius: 999px;
  transition: width 0.3s ease;
}
.permanent-note {
  font-size: 11px;
  color: #8c786d;
  margin-bottom: 10px;
}
.wallet-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
}

/* Alert Strips */
.wallet-rule,
.subscription-status,
.pending-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-radius: var(--workspace-radius, 8px);
  font-size: 12px;
  margin-bottom: 12px;
}
.wallet-rule {
  background: #fbf8f5;
  border: 1px solid rgba(18,16,17,.06);
  color: #53453e;
}
.wallet-rule-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.subscription-status {
  background: #fff8f6;
  border: 1px solid rgba(216,68,68,.12);
  color: #633f38;
}
.pending-banner {
  background: #f0f9f5;
  border: 1px solid rgba(54,125,105,.2);
  color: #245e4e;
}

/* Tabs */
.tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  margin: 18px 0 22px;
  padding-bottom: 2px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--workspace-text-muted, #6f6368);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: -3px;
}
.tab[aria-selected="true"] {
  color: var(--workspace-brand, #d84444);
  border-bottom-color: var(--workspace-brand, #d84444);
}
.tab-note {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: #f0ece9;
  color: #63544d;
}

/* Section Head */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.section-head h2 {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 4px 0;
}
.section-head p {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}

/* Cycle Toggle */
.billing-toggle-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.billing-toggle {
  display: inline-flex;
  background: #f0ece9;
  padding: 3px;
  border-radius: 999px;
}
.cycle-button {
  border: 0;
  background: transparent;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: #63544d;
  cursor: pointer;
}
.cycle-button.active {
  background: #fff;
  color: #120f10;
  box-shadow: 0 2px 6px rgba(0,0,0,.06);
}
.save-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--workspace-brand, #d84444);
  background: #fff0ed;
  padding: 3px 8px;
  border-radius: 999px;
}

/* Plans Grid */
.plans-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-bottom: 20px;
}
.plan-card {
  position: relative;
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 24px rgba(80,44,44,.03);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.plan-card.featured {
  border-color: rgba(216,68,68,.3);
  box-shadow: 0 10px 28px rgba(216,68,68,.06);
}
.recommend {
  position: absolute;
  top: -10px;
  right: 20px;
  font-size: 11px;
  font-weight: 700;
  background: var(--workspace-brand, #d84444);
  color: #fff;
  padding: 2px 10px;
  border-radius: 999px;
}
.plan-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.plan-name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plan-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: #fff0ed;
  color: var(--workspace-brand, #d84444);
}
.plan-name h3 {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}
.plan-tag {
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  background: #f4efeb;
  padding: 2px 7px;
  border-radius: 4px;
}
.plan-tag.current {
  background: #fff0ed;
  color: var(--workspace-brand, #d84444);
  font-weight: 600;
}
.plan-desc {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0 0 16px 0;
  min-height: 34px;
}
.price-row {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-bottom: 4px;
}
.price-currency {
  font-size: 18px;
  font-weight: 700;
  color: #120f10;
}
.price-number {
  font-size: 32px;
  font-weight: 800;
  color: #120f10;
}
.price-unit {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
}
.price-caption {
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  margin-bottom: 16px;
}
.quota-block {
  background: #fdfbf9;
  border: 1px solid rgba(18,16,17,.06);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.quota-big {
  font-size: 20px;
  font-weight: 800;
  color: #120f10;
  margin-bottom: 4px;
}
.quota-big span {
  font-size: 12px;
  font-weight: normal;
  color: var(--workspace-text-muted, #6f6368);
  margin-left: 4px;
}
.quota-desc {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
}
.plan-use-label {
  font-size: 11px;
  font-weight: 600;
  color: #8c786d;
  margin: 0 0 8px 0;
}
.plan-feature {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--workspace-text-body, #4b4244);
  margin-bottom: 6px;
}
.plan-feature svg {
  color: #2b735f;
}
.plan-bottom {
  margin-top: auto;
  padding-top: 16px;
}
.plan-cta {
  width: 100%;
}
.plan-bottom-note {
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  text-align: center;
  margin: 6px 0 0 0;
  min-height: 16px;
}

.usage-caption {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0 0 16px 0;
}
.common-benefits {
  background: #fbf8f5;
  border: 1px solid rgba(18,16,17,.06);
  border-radius: 8px;
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  font-size: 13px;
}
.benefit-items {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--workspace-text-body, #4b4244);
  font-size: 12px;
}
.benefit-items span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.next-period-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #63544d;
  background: #fdfbf9;
  border: 1px solid rgba(18,16,17,.06);
  border-radius: 8px;
  padding: 12px 16px;
}

/* Topup Tab */
.topup-intro {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #fef8ee;
  border: 1px solid rgba(148,101,30,.15);
  color: #795318;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 12px;
  margin-bottom: 20px;
}
.topup-credit-hero {
  margin: 10px 0 14px;
}
.topup-credit-hero strong {
  font-size: 32px;
  font-weight: 800;
  color: #120f10;
}
.topup-credit-hero span {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
  margin-left: 6px;
}
.compare-box {
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: 12px;
  overflow: hidden;
  margin-top: 24px;
}
.compare-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(18,16,17,.06);
}
.compare-top h3 {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 4px 0;
}
.compare-top p {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}
.compare-options {
  display: flex;
  gap: 12px;
}
.compare-option {
  padding: 8px 14px;
  border-radius: 8px;
  background: #f8f5f2;
  font-size: 12px;
}
.compare-option span {
  display: block;
  color: var(--workspace-text-muted, #6f6368);
}
.compare-option strong {
  color: #120f10;
}
.compare-option.active {
  background: #fff0ed;
  border: 1px solid rgba(216,68,68,.18);
}
.compare-option.active span {
  color: #a44848;
}
.compare-option.active strong {
  color: var(--workspace-brand, #d84444);
}
.compare-bottom {
  padding: 10px 24px;
  background: #fdfbf9;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Ledger Tab */
.ledger-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 18px;
}
.ledger-stat {
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: 8px;
  padding: 14px 18px;
}
.ledger-stat span {
  display: block;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin-bottom: 4px;
}
.ledger-stat strong {
  font-size: 24px;
  font-weight: 800;
}

/* Tables */
.table-surface {
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: 8px;
  overflow: hidden;
}
.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(18,16,17,.06);
}
.filter-group {
  display: flex;
  gap: 4px;
  background: #f4efeb;
  padding: 2px;
  border-radius: 6px;
}
.filter {
  border: 0;
  background: transparent;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: #63544d;
  border-radius: 4px;
  cursor: pointer;
}
.filter.active {
  background: #fff;
  color: #120f10;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,.04);
}
.search-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #f8f5f2;
  border: 1px solid rgba(18,16,17,.08);
  border-radius: 6px;
  padding: 4px 10px;
}
.search-wrap input {
  border: 0;
  background: transparent;
  font-size: 12px;
  outline: none;
  width: 180px;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
th {
  background: #fdfbf9;
  padding: 10px 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--workspace-text-muted, #6f6368);
  border-bottom: 1px solid rgba(18,16,17,.06);
}
td {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(18,16,17,.04);
  color: var(--workspace-text-body, #4b4244);
}
.primary-cell strong {
  display: block;
  color: #120f10;
}
.primary-cell small {
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
}
td small {
  display: block;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
}
.delta {
  font-weight: 700;
}
.delta.positive {
  color: #2b735f;
}
.delta.negative {
  color: #4b4244;
}
.status {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: #e9f5f0;
  color: #2b735f;
}
.status.closed {
  background: #f4efeb;
  color: #8c786d;
}
.table-empty {
  text-align: center;
  padding: 36px 16px;
  color: var(--workspace-text-muted, #6f6368);
}
.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  background: #fdfbf9;
}

/* FAQ */
.faq {
  margin: 36px 0 24px;
}
.faq-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.faq-heading h3 {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}
.faq-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
details {
  background: #fff;
  border: 1px solid var(--workspace-border, rgba(18,16,17,.08));
  border-radius: 8px;
  padding: 14px 16px;
}
summary {
  font-size: 13px;
  font-weight: 600;
  color: #120f10;
  cursor: pointer;
  user-select: none;
}
details p {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  line-height: 1.6;
  margin: 10px 0 0 0;
}

/* Page Footer */
.page-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 0 36px;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  border-top: 1px solid rgba(18,16,17,.06);
}

/* Dialog / Modals */
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(18,16,17,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: 16px;
}
.dialog {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 520px;
  box-shadow: 0 20px 48px rgba(0,0,0,.15);
  max-height: 90vh;
  overflow-y: auto;
}
.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid rgba(18,16,17,.06);
}
.dialog-head h2 {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 4px 0;
}
.dialog-head p {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}
.close-button {
  border: 0;
  background: transparent;
  color: var(--workspace-text-muted, #6f6368);
  cursor: pointer;
  padding: 4px;
}
.dialog-body {
  padding: 20px 24px;
}
.checkout-product {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fbf8f5;
  padding: 14px 18px;
  border-radius: 8px;
  margin-bottom: 16px;
}
.checkout-product-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.checkout-product h3 {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 2px 0;
}
.checkout-product p {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}
.checkout-price {
  font-size: 24px;
  font-weight: 800;
  color: #120f10;
  text-align: right;
}
.checkout-price small {
  font-size: 14px;
}
.price-label {
  display: block;
  font-size: 11px;
  font-weight: normal;
  color: var(--workspace-brand, #d84444);
}
.checkout-specs {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 8px 16px;
  font-size: 12px;
  margin: 0 0 16px 0;
}
.checkout-specs dt {
  color: var(--workspace-text-muted, #6f6368);
}
.checkout-specs dd {
  margin: 0;
  color: var(--workspace-text, #120f10);
}
.important-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: #fff8f6;
  border: 1px solid rgba(216,68,68,.12);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  color: #633f38;
  margin-bottom: 16px;
  line-height: 1.5;
}
.checkout-details {
  margin-bottom: 16px;
  font-size: 12px;
  border-radius: 6px;
  background: #fdfbf9;
  padding: 10px 14px;
  border: 1px solid rgba(18,16,17,.06);
}
.checkout-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--workspace-brand, #d84444);
}
.order-detail-list {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  font-size: 12px;
}
.order-detail-list div {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px dashed rgba(18,16,17,.06);
  padding-bottom: 4px;
}
.order-detail-list span {
  color: var(--workspace-text-muted, #6f6368);
}
.payment-title {
  font-size: 12px;
  font-weight: 600;
  color: #120f10;
  margin: 0 0 8px 0;
}
.payment-methods {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 16px;
}
.payment-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid rgba(18,16,17,.1);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.payment-option.selected {
  border-color: var(--workspace-brand, #d84444);
  background: #fff8f6;
}
.payment-option input {
  margin-left: auto;
}
.pay-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
}
.pay-mark.alipay {
  background: #1677ff;
}
.pay-mark.wechat {
  background: #07c160;
}
.acknowledge {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  cursor: pointer;
  line-height: 1.4;
}
.acknowledge input {
  margin-top: 2px;
}
.checkout-footer {
  padding: 16px 24px;
  border-top: 1px solid rgba(18,16,17,.06);
  background: #fdfbf9;
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}
.total-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.total-row > span {
  font-size: 13px;
  color: var(--workspace-text-body, #4b4244);
}
.total-row .saving {
  display: block;
  font-size: 11px;
  color: var(--workspace-brand, #d84444);
}
.total-row strong {
  font-size: 26px;
  font-weight: 800;
  color: #120f10;
}
.payment-button {
  width: 100%;
  min-height: 44px;
  font-size: 15px;
}

/* QR Payment Area */
.qr-payment-area {
  text-align: center;
  padding: 16px 0;
}
.qr-container {
  display: inline-block;
  padding: 8px;
  background: #fff;
  border: 1px solid rgba(18,16,17,.1);
  border-radius: 8px;
  margin-bottom: 8px;
}
.qr-image {
  display: block;
  width: 180px;
  height: 180px;
}
.qr-loading {
  width: 180px;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
}
.qr-hint {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0 0 12px 0;
}
.qr-action-row {
  margin-bottom: 8px;
}
.test-settle-row {
  margin-top: 8px;
}

/* Success View */
.success-body {
  text-align: center;
  padding: 30px 24px;
}
.success-circle {
  width: 52px;
  height: 52px;
  background: #e9f5f0;
  color: #2b735f;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.success-circle svg {
  width: 28px;
  height: 28px;
}
.success-body h3 {
  font-size: 20px;
  font-weight: 800;
  margin: 0 0 8px 0;
}
.success-body p {
  font-size: 13px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0 0 18px 0;
  line-height: 1.5;
}
.success-facts {
  background: #fdfbf9;
  border: 1px solid rgba(18,16,17,.06);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 20px;
  text-align: left;
  font-size: 12px;
}
.success-facts div {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
}
.success-facts span {
  color: var(--workspace-text-muted, #6f6368);
}
.success-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* Balance lot in breakdown */
.balance-lot {
  background: #fbf8f5;
  border: 1px solid rgba(18,16,17,.06);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 12px;
}
.lot-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 8px;
}
.lot-head h3 {
  font-size: 14px;
  font-weight: 700;
  margin: 0 0 2px 0;
}
.lot-head p {
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
}
.lot-head strong {
  font-size: 22px;
  font-weight: 800;
  color: #120f10;
}
.lot-details {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--workspace-text-muted, #6f6368);
}
.balance-lot > p {
  font-size: 11px;
  color: #8c786d;
  margin: 6px 0 0 0;
}

/* Change Rule Row */
.change-rule-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.change-rule-row h3 {
  font-size: 13px;
  font-weight: 700;
  margin: 0 0 4px 0;
}
.change-rule-row p {
  font-size: 12px;
  color: var(--workspace-text-muted, #6f6368);
  margin: 0;
  line-height: 1.5;
}

/* Rule Table */
.rule-table {
  width: 100%;
  font-size: 12px;
}
.rule-table th, .rule-table td {
  padding: 8px 12px;
}

/* Toast */
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: #120f10;
  color: #fff;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transform: translateY(10px);
  transition: all 0.2s ease;
  pointer-events: none;
  z-index: 1000;
}
.toast.show {
  opacity: 1;
  transform: translateY(0);
}

/* Responsive */
@media (max-width: 900px) {
  .wallet, .plans-grid, .faq-grid {
    grid-template-columns: 1fr;
  }
  .common-benefits {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .benefit-items {
    flex-wrap: wrap;
  }
  .compare-top {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
