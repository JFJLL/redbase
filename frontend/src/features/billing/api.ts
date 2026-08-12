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
  createdAt: string;
  expiresAt: string;
  paidAt: string;
}

export interface RechargePlansResponse {
  plans: RechargePlan[];
  fakeSettle: boolean;
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

export function fetchOrders(signal?: AbortSignal): Promise<{ orders: PaymentOrder[] }> {
  return apiFetch<{ orders: PaymentOrder[] }>("/api/payments/orders", { signal });
}

export function fetchOrder(outTradeNo: string, signal?: AbortSignal): Promise<{ order: PaymentOrder }> {
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/orders/${encodeURIComponent(outTradeNo)}`, { signal });
}

export function fetchPayLink(outTradeNo: string): Promise<CreateOrderResponse> {
  return apiFetch<CreateOrderResponse>(`/api/payments/alipay/orders/${encodeURIComponent(outTradeNo)}/pay-link`, {
    method: "POST",
  });
}

export function checkPaymentStatus(outTradeNo: string): Promise<{ order: PaymentOrder }> {
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/alipay/orders/${encodeURIComponent(outTradeNo)}/check`, {
    method: "POST",
  });
}

export function closeOrder(outTradeNo: string): Promise<{ order: PaymentOrder }> {
  return apiFetch<{ order: PaymentOrder }>(`/api/payments/alipay/orders/${encodeURIComponent(outTradeNo)}/close`, {
    method: "POST",
  });
}

export function fakeSettleUrl(outTradeNo: string): string {
  return `/api/payments/fake/alipay/settle?outTradeNo=${encodeURIComponent(outTradeNo)}`;
}
