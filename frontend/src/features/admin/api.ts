import { apiFetch } from "@/shared/api/client";
import type { SessionUser } from "@/shared/types/api";
import type {
  OverviewResponse,
  UsersResponse,
  FeaturesResponse,
  AiResponse,
  FinanceResponse,
  SystemResponse,
  PaginatedResult,
  AdminUserItem,
  AdminBrandItem,
  AdminGenerationItem,
  AdminCreditEventItem,
  AdminPaymentOrderItem,
  AdminVideoProjectItem,
  AdminVideoProjectDetail,
} from "./types";
export * from "./types";
export * from "./dateRange";
export * from "./metrics";

export interface AdminStats {
  userCount?: number;
  brandCount?: number;
  generationCount?: number;
  totalConsumedTokens?: number;
  totalGrantedTokens?: number;
  currentCreditsTotal?: number;
  [key: string]: unknown;
}

export interface AdminUserRow {
  id: number;
  name?: string;
  phone?: string;
  accountType?: string;
  department?: string;
  isAdmin?: boolean;
  createdAt?: string;
  currentCredits?: number;
  brandCount?: number;
  generationCount?: number;
  consumedTokens?: number;
  grantedTokens?: number;
  lastActiveAt?: string;
  [key: string]: unknown;
}

export interface AdminBrandRow {
  id: number;
  ownerUserId?: number;
  name?: string;
  industry?: string;
  audience?: string;
  description?: string;
  product?: string;
  goal?: string;
  knowledgeBase?: string;
  assetTags?: string[];
  logoName?: string;
  hasLogo?: boolean;
  analysisCount?: number;
  trendCount?: number;
  createdAt?: string;
  user?: { id: number; name?: string; phone?: string } | null;
  [key: string]: unknown;
}

export interface AdminUsageEvent {
  id: number;
  userId?: number;
  userName?: string;
  userPhone?: string;
  actionType?: string;
  actionLabel?: string;
  tokenDelta?: number;
  tokenCost?: number;
  createdAt?: string;
  adminUserName?: string;
  brandName?: string;
  ideaTitle?: string;
  channelLabel?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface AdminGenerationRow {
  id: number;
  type?: string;
  cardTitle?: string;
  ideaTitle?: string;
  trendTitle?: string;
  brandName?: string;
  channelLabel?: string;
  summary?: string;
  createdAt?: string;
  previewUrl?: string;
  tokenCost?: number;
  payload?: Record<string, unknown>;
  user?: { id: number; name?: string; phone?: string } | null;
  [key: string]: unknown;
}

export interface AdminOverview {
  stats?: AdminStats;
  users?: AdminUserRow[];
  brands?: AdminBrandRow[];
  usageEvents?: AdminUsageEvent[];
  generations?: AdminGenerationRow[];
  [key: string]: unknown;
}

export function fetchSession(signal?: AbortSignal): Promise<{ user: SessionUser }> {
  return apiFetch("/api/session", { signal });
}

export function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
  return apiFetch("/api/admin/overview", { signal });
}

function buildQueryString(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function fetchOverviewAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<OverviewResponse> {
  return apiFetch(`/api/admin/analytics/overview${buildQueryString(params)}`, { signal });
}

export function fetchUsersAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<UsersResponse> {
  return apiFetch(`/api/admin/analytics/users${buildQueryString(params)}`, { signal });
}

export function fetchFeaturesAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<FeaturesResponse> {
  return apiFetch(`/api/admin/analytics/features${buildQueryString(params)}`, { signal });
}

export function fetchAiAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<AiResponse> {
  return apiFetch(`/api/admin/analytics/ai${buildQueryString(params)}`, { signal });
}

export function fetchFinanceAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<FinanceResponse> {
  return apiFetch(`/api/admin/analytics/finance${buildQueryString(params)}`, { signal });
}

export function fetchSystemAnalytics(params?: Record<string, string>, signal?: AbortSignal): Promise<SystemResponse> {
  return apiFetch(`/api/admin/analytics/system${buildQueryString(params)}`, { signal });
}

export function fetchDataUsers(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminUserItem>> {
  return apiFetch(`/api/admin/data/users${buildQueryString(params as any)}`, { signal });
}

export function fetchDataBrands(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminBrandItem>> {
  return apiFetch(`/api/admin/data/brands${buildQueryString(params as any)}`, { signal });
}

export function fetchDataGenerations(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminGenerationItem>> {
  return apiFetch(`/api/admin/data/generations${buildQueryString(params as any)}`, { signal });
}

export function fetchDataCreditEvents(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminCreditEventItem>> {
  return apiFetch(`/api/admin/data/credit-events${buildQueryString(params as any)}`, { signal });
}

export function fetchDataPaymentOrders(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminPaymentOrderItem>> {
  return apiFetch(`/api/admin/data/payment-orders${buildQueryString(params as any)}`, { signal });
}

export function fetchDataVideoProjects(params?: Record<string, unknown>, signal?: AbortSignal): Promise<PaginatedResult<AdminVideoProjectItem>> {
  return apiFetch(`/api/admin/data/video-projects${buildQueryString(params as any)}`, { signal });
}

export function fetchVideoProjectDetail(projectId: number, signal?: AbortSignal): Promise<{ project: AdminVideoProjectDetail }> {
  return apiFetch(`/api/admin/data/video-projects/${projectId}`, { signal });
}

/** POST /api/admin/users/:id/credits — amount is forwarded verbatim (string ok). */
export function addUserCredits(
  userId: number | string,
  body: { amount: string | number; note: string },
  signal?: AbortSignal,
): Promise<{ user: SessionUser; overview?: AdminOverview }> {
  return apiFetch(`/api/admin/users/${userId}/credits`, { method: "POST", body, signal });
}

export function deleteAdminUser(
  userId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; deletedUserId: number; overview?: AdminOverview }> {
  return apiFetch(`/api/admin/users/${userId}`, { method: "DELETE", signal });
}

export function deleteAdminGeneration(
  generationId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; deletedGenerationId: number; overview?: AdminOverview }> {
  return apiFetch(`/api/admin/generations/${generationId}`, { method: "DELETE", signal });
}
