import { apiFetch } from "@/shared/api/client";

export interface RechargePlan {
  id: string;
  name: string;
  credits: number;
  amountYuan: string;
  monthlyFen?: number;
  annualFen?: number;
  label?: string;
  desc?: string;
  icon?: string;
  featured?: boolean;
  rank?: number;
}

export interface TopupPack {
  id: string;
  name: string;
  desc: string;
  credits: number;
  amountFen: number;
  icon?: string;
  featured?: boolean;
}

export interface PlanAction {
  type: "activate" | "renew" | "upgrade" | "downgrade" | "interval";
  label: string;
  note: string;
}

export interface WalletBalances {
  totalAvailable: number;
  periodBalance: number;
  permanentBalance: number;
  legacyBalance: number;
}

export interface ActiveSubscription {
  id: number;
  planId: string;
  planName: string;
  cycle: "monthly" | "annual";
  serviceStart: string;
  serviceEnd: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  currentPeriodGrant: number;
  usedCredits: number;
  nextGrantAt: string | null;
}

export interface ScheduledSubscription {
  id: number;
  orderId: number;
  planId: string;
  planName: string;
  cycle: "monthly" | "annual";
  startAt: string;
  endAt: string;
  amountFen: number;
  monthlyCredits: number;
}

export interface BillingOverview {
  wallet: WalletBalances;
  subscription: ActiveSubscription | null;
  scheduled: ScheduledSubscription | null;
  scenario: "new" | "monthly" | "annual" | "expired";
  planActions: Record<string, PlanAction>;
}

export interface BillingQuote {
  quoteId: string;
  kind: "plan" | "topup";
  itemId: string;
  itemName: string;
  action: "activate" | "renew" | "upgrade" | "downgrade" | "interval" | "topup";
  cycle: "monthly" | "annual" | null;
  amountFen: number;
  issuedNow: number;
  startAt: string;
  endAt: string | null;
  periodEndAt: string | null;
  scheduled: boolean;
  meta: Record<string, any>;
  expiresAt: string;
}

export interface LedgerRow {
  id: number;
  time: string;
  label: string;
  delta: number;
  source: string;
  note: string;
  type: "grant" | "spend" | "expire";
}

export interface PaymentOrder {
  id: number;
  outTradeNo: string;
  planId: string;
  planName: string;
  planCredits: number;
  amountFen?: number;
  amountYuan: string;
  status: "created" | "pending" | "paid" | "closed" | "expired" | "failed";
  provider?: "alipay" | "wxpay";
  createdAt: string;
  expiresAt: string;
  paidAt: string;
  quoteId?: string;
  fulfillmentStatus?: string;
  fulfilledAt?: string;
  cycle?: string;
  orderKind?: string;
  orderAction?: string;
  issuedNow?: number;
  serviceStart?: string;
  serviceEnd?: string;
  periodEnd?: string;
}

export interface RechargePlansResponse {
  plans: RechargePlan[];
  topups?: TopupPack[];
  v2Catalog?: {
    plans: RechargePlan[];
    topups: TopupPack[];
    version: string;
  };
  fakeSettle: boolean;
  providers?: {
    alipay?: boolean;
    wxpay?: boolean;
  };
}

export interface CreateOrderResponse {
  order: PaymentOrder;
  payUrl: string;
  qrCode: string;
  qrCodeError?: string;
}

export function fetchWalletOverview(signal?: AbortSignal): Promise<BillingOverview> {
  return apiFetch<BillingOverview>("/api/billing/wallet", { signal });
}

export function requestBillingQuote(
  kind: "plan" | "topup",
  itemId: string,
  cycle?: "monthly" | "annual",
  signal?: AbortSignal
): Promise<{ quote: BillingQuote }> {
  return apiFetch<{ quote: BillingQuote }>("/api/billing/quote", {
    method: "POST",
    body: { kind, itemId, cycle },
    signal,
  });
}

export function createOrderWithQuote(
  provider: "alipay" | "wxpay",
  quoteId: string,
  idempotencyKey: string
): Promise<CreateOrderResponse> {
  const endpoint = provider === "wxpay" ? "/api/payments/wxpay/orders" : "/api/payments/alipay/orders";
  return apiFetch<CreateOrderResponse>(endpoint, {
    method: "POST",
    body: { quoteId, idempotencyKey },
  });
}

export function fetchLedger(
  params?: { filter?: string; query?: string },
  signal?: AbortSignal
): Promise<{ rows: LedgerRow[]; total: number }> {
  const search = new URLSearchParams();
  if (params?.filter) search.set("filter", params.filter);
  if (params?.query) search.set("query", params.query);
  const qs = search.toString();
  return apiFetch<{ rows: LedgerRow[]; total: number }>(`/api/billing/ledger${qs ? `?${qs}` : ""}`, { signal });
}

export function getLedgerExportUrl(filter?: string, query?: string): string {
  const search = new URLSearchParams();
  if (filter) search.set("filter", filter);
  if (query) search.set("query", query);
  const qs = search.toString();
  return `/api/billing/ledger/export${qs ? `?${qs}` : ""}`;
}

export function fetchRechargePlans(signal?: AbortSignal): Promise<RechargePlansResponse> {
  return apiFetch<RechargePlansResponse>("/api/billing/recharge-plans", { signal });
}

export function createAlipayOrder(planId: string, idempotencyKey: string): Promise<CreateOrderResponse> {
  return apiFetch<CreateOrderResponse>("/api/payments/alipay/orders", {
    method: "POST",
    body: { planId, idempotencyKey },
  });
}

export function createWxpayOrder(planId: string, idempotencyKey: string): Promise<CreateOrderResponse> {
  return apiFetch<CreateOrderResponse>("/api/payments/wxpay/orders", {
    method: "POST",
    body: { planId, idempotencyKey },
  });
}

export function createPaymentOrder(
  provider: "alipay" | "wxpay",
  planId: string,
  idempotencyKey: string,
): Promise<CreateOrderResponse> {
  const endpoint = provider === "wxpay" ? "/api/payments/wxpay/orders" : "/api/payments/alipay/orders";
  return apiFetch<CreateOrderResponse>(endpoint, {
    method: "POST",
    body: { planId, idempotencyKey },
  });
}

export function fetchOrders(signal?: AbortSignal): Promise<{ orders: PaymentOrder[] }> {
  return apiFetch<{ orders: PaymentOrder[] }>("/api/payments/orders", { signal });
}

export function fetchOrder(outTradeNo: string, signal?: AbortSignal): Promise<{ order: PaymentOrder }> {
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/orders/${encodeURIComponent(outTradeNo)}`, { signal });
}

export function fetchPayLink(outTradeNo: string, provider: "alipay" | "wxpay" = "alipay"): Promise<CreateOrderResponse> {
  const providerSlug = provider === "wxpay" ? "wxpay" : "alipay";
  return apiFetch<CreateOrderResponse>(`/api/payments/${providerSlug}/orders/${encodeURIComponent(outTradeNo)}/pay-link`, {
    method: "POST",
  });
}

export function checkPaymentStatus(outTradeNo: string, provider: "alipay" | "wxpay" = "alipay"): Promise<{ order: PaymentOrder }> {
  const providerSlug = provider === "wxpay" ? "wxpay" : "alipay";
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/${providerSlug}/orders/${encodeURIComponent(outTradeNo)}/check`, {
    method: "POST",
  });
}

export function closeOrder(outTradeNo: string, provider: "alipay" | "wxpay" = "alipay"): Promise<{ order: PaymentOrder }> {
  const providerSlug = provider === "wxpay" ? "wxpay" : "alipay";
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/${providerSlug}/orders/${encodeURIComponent(outTradeNo)}/close`, {
    method: "POST",
  });
}

export function fakeSettleUrl(outTradeNo: string, provider: "alipay" | "wxpay" = "alipay"): string {
  const providerSlug = provider === "wxpay" ? "wxpay" : "alipay";
  return `/api/payments/fake/${providerSlug}/settle?outTradeNo=${encodeURIComponent(outTradeNo)}`;
}
