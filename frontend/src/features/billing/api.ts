import { apiFetch } from "@/shared/api/client";

export interface RechargePlan {
  id: string;
  name: string;
  credits: number;
  amountYuan: string;
}

export interface PaymentOrder {
  id: number;
  outTradeNo: string;
  planId: string;
  planName: string;
  planCredits: number;
  amountYuan: string;
  status: "created" | "pending" | "paid" | "closed" | "expired" | "failed";
  provider?: "alipay" | "wxpay";
  createdAt: string;
  expiresAt: string;
  paidAt: string;
}

export interface RechargePlansResponse {
  plans: RechargePlan[];
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
