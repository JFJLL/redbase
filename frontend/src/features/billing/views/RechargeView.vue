<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import {
  createAlipayOrder,
  fakeSettleUrl,
  fetchOrder,
  fetchOrders,
  fetchRechargePlans,
  closeOrder,
  type PaymentOrder,
  type RechargePlan,
} from "../api";

const route = useRoute();
const selectedPlanId = computed(() => (typeof route.query.plan === "string" ? route.query.plan : ""));
const plans = ref<RechargePlan[]>([]);
const orders = ref<PaymentOrder[]>([]);
const fakeSettle = ref(false);
const loadingPlans = ref(true);
const loadingOrders = ref(false);
const creatingPlanId = ref("");
const errorMessage = ref("");
const pendingPayUrl = ref("");
const returnNotice = ref("");
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  const queryStatus = typeof route.query.status === "string" ? route.query.status : "";
  const queryOutTradeNo = typeof route.query.outTradeNo === "string" ? route.query.outTradeNo : "";
  if (queryOutTradeNo && queryStatus) {
    returnNotice.value = `支付状态：${statusLabel(queryStatus)}（订单 ${queryOutTradeNo.slice(0, 18)}…）`;
  }
  await Promise.all([loadPlans(), loadOrders()]);
});

onBeforeUnmount(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});

async function loadPlans(): Promise<void> {
  loadingPlans.value = true;
  errorMessage.value = "";
  try {
    const data = await fetchRechargePlans();
    plans.value = data.plans;
    fakeSettle.value = Boolean(data.fakeSettle);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
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
    if (!(error instanceof Error && error.name === "ApiError" && (error as { status?: number }).status === 401)) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    loadingOrders.value = false;
  }
}

async function handleCreateOrder(plan: RechargePlan): Promise<void> {
  creatingPlanId.value = plan.id;
  errorMessage.value = "";
  pendingPayUrl.value = "";
  try {
    const idempotencyKey = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `order-${Date.now()}`;
    const data = await createAlipayOrder(plan.id, idempotencyKey);
    pendingPayUrl.value = data.payUrl;
    await loadOrders();
    startPolling(data.order.outTradeNo);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingPlanId.value = "";
  }
}

function startPolling(outTradeNo: string): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks += 1;
    try {
      const data = await fetchOrder(outTradeNo);
      const latest = data.order;
      if (latest.status === "paid" || latest.status === "closed" || latest.status === "expired" || latest.status === "failed") {
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
        pendingPayUrl.value = "";
      }
      await loadOrders();
    } catch {
      // Keep polling; a transient network error must not kill the flow.
    }
    if (ticks >= 20 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 2000);
}

async function handleCloseOrder(order: PaymentOrder): Promise<void> {
  errorMessage.value = "";
  try {
    await closeOrder(order.outTradeNo);
    await loadOrders();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "已创建",
    pending: "待支付",
    paid: "已支付",
    closed: "已关闭",
    expired: "已过期",
    failed: "失败",
    invalid: "验证失败",
  };
  return labels[status] || status;
}

function isOpenOrder(order: PaymentOrder): boolean {
  return order.status === "created" || order.status === "pending";
}
</script>

<template>
  <section class="billing-panel">
    <div class="billing-head">
      <h1 class="billing-title">积分充值</h1>
      <p class="billing-subtitle">选择套餐，通过支付宝电脑网站支付完成充值，积分实时到账。</p>
    </div>

    <p v-if="returnNotice" class="billing-notice" role="status">{{ returnNotice }}</p>
    <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>

    <div v-if="loadingPlans" class="billing-loading" role="status">加载中...</div>

    <div v-else-if="plans.length === 0" class="billing-empty" data-test="recharge-empty">
      <h2>充值暂未开放</h2>
      <p>当前未配置充值套餐，请稍后再试。</p>
    </div>

    <div v-else class="billing-plans-grid">
      <article
        v-for="plan in plans"
        :key="plan.id"
        class="billing-plan-card"
        :class="{ 'billing-plan-card--selected': plan.id === selectedPlanId }"
        :data-plan-id="plan.id"
        data-test="recharge-plan"
      >
        <span v-if="plan.id === selectedPlanId" class="billing-plan-selected" data-test="selected-plan-label">已选择</span>
        <h2 class="billing-plan-name">{{ plan.name }}</h2>
        <p class="billing-plan-credits">{{ plan.credits }} 积分</p>
        <p class="billing-plan-price">¥{{ plan.amountYuan }}</p>
        <button
          type="button"
          class="primary-btn billing-plan-action"
          :disabled="creatingPlanId === plan.id"
          @click="handleCreateOrder(plan)"
        >
          {{ creatingPlanId === plan.id ? "创建中..." : "立即充值" }}
        </button>
      </article>
    </div>

    <a
      v-if="pendingPayUrl"
      class="billing-pay-link"
      :href="pendingPayUrl"
      target="_blank"
      rel="noopener"
      data-test="alipay-pay-link"
    >
      已生成支付链接，点击前往支付宝支付
    </a>

    <section class="billing-orders" aria-label="我的充值订单">
      <div class="billing-orders-head">
        <h2>我的充值订单</h2>
        <button type="button" class="billing-refresh" :disabled="loadingOrders" @click="loadOrders">
          {{ loadingOrders ? "刷新中..." : "刷新" }}
        </button>
      </div>
      <p v-if="orders.length === 0" class="billing-orders-empty">暂无充值订单。</p>
      <div v-else class="billing-order-list">
        <article v-for="order in orders" :key="order.outTradeNo" class="billing-order-row" data-test="payment-order">
          <div class="billing-order-main">
            <strong>{{ order.planName }}</strong>
            <span class="billing-order-no">{{ order.outTradeNo }}</span>
            <span class="billing-order-status" :data-status="order.status">{{ statusLabel(order.status) }}</span>
          </div>
          <div class="billing-order-meta">
            <span>¥{{ order.amountYuan }} / {{ order.planCredits }} 积分</span>
            <span>{{ new Date(order.createdAt).toLocaleString("zh-CN", { hour12: false }) }}</span>
          </div>
          <div class="billing-order-actions">
            <a
              v-if="fakeSettle && isOpenOrder(order)"
              class="billing-fake-settle"
              :href="fakeSettleUrl(order.outTradeNo)"
              target="_blank"
              rel="noopener"
              data-test="fake-settle-link"
            >
              测试结算
            </a>
            <button
              v-if="isOpenOrder(order)"
              type="button"
              class="billing-close"
              @click="handleCloseOrder(order)"
            >
              关闭订单
            </button>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.billing-panel {
  width: 100%;
  max-width: 980px;
}

.billing-title {
  margin: 0;
  color: var(--workspace-text);
  font-family: var(--workspace-font-heading);
  font-size: 1.8rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.billing-subtitle {
  margin: 8px 0 0;
  color: var(--workspace-text-muted);
  font-size: 0.92rem;
  line-height: 1.6;
}

.billing-notice {
  margin: 16px 0 0;
  padding: 10px 14px;
  border-radius: var(--workspace-radius);
  background: #fff7ed;
  color: #92500f;
  font-size: 13px;
}

.billing-plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--workspace-grid-gap);
  margin-top: 24px;
}

.billing-plan-card {
  position: relative;
  padding: 20px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.billing-plan-card--selected {
  border-color: var(--workspace-brand);
  box-shadow: 0 10px 24px rgba(216, 68, 68, 0.12);
}

.billing-plan-selected {
  position: absolute;
  top: 12px;
  right: 12px;
  padding: 3px 8px;
  border-radius: 999px;
  background: #fff0ed;
  color: var(--workspace-brand);
  font-size: 12px;
  font-weight: 700;
}

.billing-plan-name {
  margin: 0;
  color: var(--workspace-text);
  font-size: 1.05rem;
}

.billing-plan-credits {
  margin: 10px 0 0;
  color: var(--workspace-brand-ink);
  font-weight: 700;
}

.billing-plan-price {
  margin: 6px 0 16px;
  color: var(--workspace-text-muted);
  font-size: 1.2rem;
  font-weight: 700;
}

.billing-plan-action {
  width: 100%;
}

.billing-pay-link {
  display: inline-block;
  margin-top: 18px;
  color: var(--workspace-brand-ink);
  font-weight: 700;
}

.billing-orders {
  margin-top: 34px;
}

.billing-orders-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.billing-orders-head h2 {
  margin: 0;
  font-size: 1.15rem;
}

.billing-refresh,
.billing-close {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--workspace-border);
  border-radius: 6px;
  background: #fff;
  color: var(--workspace-text);
  cursor: pointer;
}

.billing-order-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.billing-order-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--workspace-radius);
  background: var(--workspace-surface);
}

.billing-order-main {
  display: grid;
  gap: 3px;
}

.billing-order-no {
  color: var(--workspace-text-muted);
  font-size: 12px;
}

.billing-order-status {
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff0ed;
  color: #db4b4e;
  font-size: 12px;
  font-weight: 700;
}

.billing-order-status[data-status="paid"] {
  background: #eaf7ef;
  color: #1e7d43;
}

.billing-order-meta {
  display: grid;
  gap: 3px;
  color: var(--workspace-text-muted);
  font-size: 12px;
}

.billing-order-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.billing-fake-settle {
  padding: 6px 10px;
  border-radius: 6px;
  background: #f3e7e2;
  color: #a13a3a;
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
}

.billing-orders-empty {
  color: var(--workspace-text-muted);
  font-size: 13px;
}
</style>
