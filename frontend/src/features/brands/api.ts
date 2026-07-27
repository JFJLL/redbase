import { apiFetch } from "@/shared/api/client";

// Brand / personal-IP profile API. Endpoints, field names and payload shapes
// mirror public/app.js and src/server/api/brand-routes.js exactly.

export interface BrandLogo {
  originalName: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandSummary {
  id: number;
  ownerUserId: number;
  name: string;
  industry: string;
  audience: string;
  description: string;
  profileType: "brand" | "personal";
  contentPillars: string[];
  personaStyle: string;
  materialCount: number;
  logo: BrandLogo | null;
  assetTags: string[];
  trendCount: number;
  analysisCount: number;
}

export interface BrandDetail extends Omit<BrandSummary, "trendCount" | "analysisCount"> {
  product: string;
  goal: string;
  knowledgeBase: string;
  analyses: Array<{ id: number; name: string; timestamp: string }>;
  trends: Array<{ key: string; title: string; items: unknown[] }>;
}

export interface GenerationRecord {
  id: number;
  brandId: number;
  [key: string]: unknown;
}

/** Payload for POST /api/brands and PUT /api/brands/:id. All values are the
 *  raw form strings — the backend normalizes contentPillars itself. */
export interface ProfileFormPayload {
  profileType: "brand" | "personal";
  name: string;
  industry: string;
  audience: string;
  description: string;
  product: string;
  knowledgeBase: string;
  goal: string;
  contentPillars: string;
  personaStyle: string;
  logoName?: string;
  logoDataUrl?: string;
}

export function fetchBrandSummaries(signal?: AbortSignal): Promise<{ brands: BrandSummary[] }> {
  return apiFetch<{ brands: BrandSummary[] }>("/api/brands", { query: { summary: 1 }, signal });
}

export function fetchBrandDetail(brandId: number, signal?: AbortSignal): Promise<{ brand: BrandDetail }> {
  return apiFetch<{ brand: BrandDetail }>(`/api/brands/${brandId}`, { signal });
}

export function createBrand(payload: ProfileFormPayload): Promise<{ brand: BrandDetail }> {
  return apiFetch<{ brand: BrandDetail }>("/api/brands", { method: "POST", body: payload });
}

export function updateBrand(brandId: number, payload: ProfileFormPayload): Promise<{ brand: BrandDetail }> {
  return apiFetch<{ brand: BrandDetail }>(`/api/brands/${brandId}`, { method: "PUT", body: payload });
}

export function deleteBrand(
  brandId: number,
  deleteGenerations: boolean,
): Promise<{ ok: boolean; deletedGenerationIds: number[] }> {
  return apiFetch<{ ok: boolean; deletedGenerationIds: number[] }>(`/api/brands/${brandId}`, {
    method: "DELETE",
    body: { deleteGenerations },
  });
}

/** GET /api/history — used by the delete dialog to count a brand's
 *  generation records, same as the legacy loadBrands() bootstrap. */
export function fetchGenerationHistory(signal?: AbortSignal): Promise<{ generations: GenerationRecord[] }> {
  return apiFetch<{ generations: GenerationRecord[] }>("/api/history", { signal });
}
