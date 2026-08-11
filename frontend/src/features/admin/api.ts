/**
 * Admin API wrappers. Paths and payloads mirror public/admin.js and
 * src/server/api/admin-routes.js.
 */
import { apiFetch } from "@/shared/api/client";
import type { SessionUser } from "@/shared/types/api";

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

/** POST /api/admin/users/:id/credits — amount is forwarded verbatim (string ok). */
export function addUserCredits(
  userId: number | string,
  body: { amount: string | number; note: string },
  signal?: AbortSignal,
): Promise<{ user: SessionUser; overview: AdminOverview }> {
  return apiFetch(`/api/admin/users/${userId}/credits`, { method: "POST", body, signal });
}

export function deleteAdminUser(
  userId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; deletedUserId: number; overview: AdminOverview }> {
  return apiFetch(`/api/admin/users/${userId}`, { method: "DELETE", signal });
}

export function deleteAdminGeneration(
  generationId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; deletedGenerationId: number; overview: AdminOverview }> {
  return apiFetch(`/api/admin/generations/${generationId}`, { method: "DELETE", signal });
}

export function formatNumber(value: unknown): string {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString("zh-CN") : "0";
}

export function formatDate(value: unknown): string {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}
