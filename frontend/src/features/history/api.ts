/**
 * History feature: API wrappers and pure filter helpers ported from
 * public/app.js (loadGenerationHistory / matchesGenerationHistoryFilters).
 */
import { apiFetch } from "@/shared/api/client";
import type { VideoScript } from "@/features/generation/api";

export const HISTORY_TYPE_LABELS = new Map<string, string>([
  ["moments", "朋友圈图文"],
  ["wechat", "公众号长图"],
  ["xhsCarousel", "小红书组图"],
  ["videoScript", "视频脚本"],
  ["styleImage", "一键风格化"],
  ["imageEdit", "历史改图"],
]);

export const KNOWN_ASPECT_RATIOS = new Set([
  "1:1",
  "1:2",
  "2:1",
  "1:3",
  "3:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "21:9",
  "9:21",
  "16:9",
]);

export interface GenerationHistoryFilters {
  q: string;
  brandId: string;
  type: string;
  from: string;
  to: string;
}

export function createEmptyGenerationHistoryFilters(): GenerationHistoryFilters {
  return { q: "", brandId: "", type: "", from: "", to: "" };
}

export interface HistorySlide {
  title?: string;
  imageUrl?: string;
  previewUrl?: string;
  [key: string]: unknown;
}

export interface HistoryPayload {
  videoScript?: VideoScript;
  caption?: string;
  visualDirection?: string;
  publishTitle?: string;
  publishCaption?: string;
  intro?: string;
  title?: string;
  aspectRatio?: string;
  slides?: HistorySlide[];
  editHistory?: unknown[];
  [key: string]: unknown;
}

export interface GenerationHistoryItem {
  id: number;
  type: string;
  cardTitle?: string;
  summary?: string;
  trendTitle?: string;
  brandName?: string;
  brandId?: number | string;
  ideaTitle?: string;
  channelLabel?: string;
  createdAt?: string;
  previewUrl?: string;
  payload?: HistoryPayload;
  [key: string]: unknown;
}

export interface HistoryBrand {
  id: number | string;
  name?: string;
  [key: string]: unknown;
}

export function fetchBrands(signal?: AbortSignal): Promise<{ brands: HistoryBrand[] }> {
  return apiFetch("/api/brands", { signal });
}

export function fetchGenerationHistory(
  filters: Partial<GenerationHistoryFilters> = {},
  signal?: AbortSignal,
): Promise<{ generations: GenerationHistoryItem[] }> {
  const query: Record<string, string | undefined> = {};
  for (const key of ["q", "brandId", "type", "from", "to"] as const) {
    const value = filters[key];
    if (value) query[key] = value;
  }
  return apiFetch("/api/history", { query, signal });
}

export function deleteGeneration(
  generationId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; deletedGenerationId: number }> {
  return apiFetch(`/api/history/${generationId}`, { method: "DELETE", signal });
}

export function normalizeHistoryText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function normalizeHistoryDateBoundary(value: string, mode: "from" | "to"): string {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return mode === "to" ? `${input}T23:59:59.999Z` : `${input}T00:00:00.000Z`;
  }
  return input;
}

export function matchesGenerationHistoryFilters(
  item: GenerationHistoryItem | null,
  filters: GenerationHistoryFilters,
): boolean {
  if (!item) return false;
  if (filters.brandId && String(item.brandId) !== String(filters.brandId)) return false;
  if (filters.type && item.type !== filters.type) return false;

  const query = normalizeHistoryText(filters.q);
  if (query) {
    const haystack = [item.cardTitle, item.summary, item.trendTitle, item.brandName, item.ideaTitle]
      .map(normalizeHistoryText)
      .join(" ");
    if (!haystack.includes(query)) return false;
  }

  const createdAt = String(item.createdAt || "");
  const from = normalizeHistoryDateBoundary(filters.from, "from");
  const to = normalizeHistoryDateBoundary(filters.to, "to");
  if (from && createdAt < from) return false;
  if (to && createdAt > to) return false;

  return true;
}

/** Signed URLs come from the backend as-is; only obvious protocols pass through. */
export function safeImageSrc(value: unknown): string {
  const src = String(value || "");
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) return src;
  return "";
}

/** Expiry timestamp carried by backend-signed asset URLs (0 when absent). */
export function parseAssetExpiryMs(url: unknown): number {
  try {
    const parsed = new URL(String(url || ""), "http://redbase.local");
    const raw = Number(parsed.searchParams.get("assetExpires") || 0);
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

/** True only when the signed URL carries an expiry that has already passed. */
export function hasExpiredAssetSignature(url: unknown, nowMs = Date.now()): boolean {
  const expiresAt = parseAssetExpiryMs(url);
  return expiresAt > 0 && expiresAt <= nowMs;
}

export function getGenerationPrimaryImageUrl(item: GenerationHistoryItem | null): string {
  if (item?.previewUrl) return item.previewUrl;
  const rawSlides = item?.payload?.slides;
  const slides = Array.isArray(rawSlides) ? rawSlides : [];
  const slide = slides.find((candidate) => safeImageSrc(candidate.imageUrl || candidate.previewUrl));
  return String(slide?.imageUrl || slide?.previewUrl || "");
}
