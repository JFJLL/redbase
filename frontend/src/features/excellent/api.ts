/**
 * API wrappers for the excellent-content feature. Paths, query params and
 * request bodies mirror public/js/excellent-remix-api.js and public/app.js.
 */
import { apiFetch } from "@/shared/api/client";
import type { SessionUser } from "@/shared/types/api";
import type {
  BrandSummary,
  CarouselPack,
  ContentSourceOption,
  ExcellentBoard,
  ExcellentDetailResult,
  ExcellentListResult,
  ExistingIdea,
  FusionPlan,
  ProductImage,
  RemixAnalysis,
  RemixBillingInfo,
  SmartDirection,
  TaxonomyResult,
} from "./types";

export interface ExcellentQueryFilters {
  board: ExcellentBoard;
  contentSource: string;
  categoryPath?: string;
  industryPath?: string;
}

function taxonomyQuery(filters: ExcellentQueryFilters): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {
    board: filters.board,
    contentSource: filters.contentSource || "all",
  };
  if (filters.board === "ecommerce_hot") {
    if (filters.industryPath) query.industryPath = filters.industryPath;
  } else if (filters.categoryPath) {
    query.categoryPath = filters.categoryPath;
  }
  return query;
}

export function fetchContentSources(signal?: AbortSignal): Promise<{ contentSources: ContentSourceOption[] }> {
  return apiFetch("/api/excellent-contents/content-sources", { signal });
}

export function fetchExcellentTaxonomy(board: ExcellentBoard, signal?: AbortSignal): Promise<TaxonomyResult> {
  return apiFetch("/api/excellent-contents/taxonomy", { query: { board }, signal });
}

/** Cache-only list read; never triggers a Pgy fetch. */
export function fetchExcellentContents(filters: ExcellentQueryFilters, signal?: AbortSignal): Promise<ExcellentListResult> {
  return apiFetch("/api/excellent-contents", { query: taxonomyQuery(filters), signal });
}

/** Explicit refresh — the only path that calls Pgy upstream. */
export function refreshExcellentContents(
  filters: ExcellentQueryFilters,
  signal?: AbortSignal,
): Promise<ExcellentListResult> {
  return apiFetch("/api/excellent-contents/refresh", {
    method: "POST",
    body: {
      board: filters.board,
      contentSource: filters.contentSource || "all",
      categoryPath: filters.board === "ecommerce_hot" ? "" : filters.categoryPath || "",
      industryPath: filters.board === "ecommerce_hot" ? filters.industryPath || "" : "",
    },
    signal,
  });
}

export function fetchExcellentContentDetail(
  noteId: string,
  filters: ExcellentQueryFilters,
  signal?: AbortSignal,
): Promise<ExcellentDetailResult> {
  return apiFetch(`/api/excellent-contents/${encodeURIComponent(noteId)}/detail`, {
    query: taxonomyQuery(filters),
    signal,
  });
}

export function fetchRemixAnalysis(
  noteId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ analysis: RemixAnalysis }> {
  return apiFetch(`/api/excellent-contents/${encodeURIComponent(noteId)}/remix-analysis`, {
    method: "POST",
    body,
    signal,
  });
}

export function fetchContentDirections(
  noteId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  directions?: SmartDirection[];
  billing?: RemixBillingInfo;
  user?: SessionUser;
  [key: string]: unknown;
}> {
  return apiFetch(`/api/excellent-contents/${encodeURIComponent(noteId)}/content-directions`, {
    method: "POST",
    body,
    signal,
  });
}

export function fetchFusionPlan(
  noteId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ fusionPlan: FusionPlan; billing?: RemixBillingInfo; user?: SessionUser }> {
  return apiFetch(`/api/excellent-contents/${encodeURIComponent(noteId)}/fusion-plan`, {
    method: "POST",
    body,
    signal,
  });
}

export function fetchBrands(signal?: AbortSignal): Promise<{ brands: BrandSummary[] }> {
  return apiFetch("/api/brands", { signal });
}

export function fetchBrandRemixIdeas(
  brandId: number | string,
  signal?: AbortSignal,
): Promise<{ brandId: number; ideas: ExistingIdea[] }> {
  return apiFetch(`/api/brands/${Number(brandId)}/excellent-remix-ideas`, { signal });
}

export function fetchBrandProductImages(
  brandId: number | string,
  signal?: AbortSignal,
): Promise<{ images: ProductImage[]; [key: string]: unknown }> {
  return apiFetch(`/api/product-images?brandId=${Number(brandId)}&includeUnassigned=1`, { signal });
}

export interface RemixPreviewResult {
  carouselPack?: CarouselPack;
  carouselGroupId?: string;
  user?: SessionUser;
  [key: string]: unknown;
}

export function previewExcellentRemix(
  brandId: number | string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RemixPreviewResult> {
  return apiFetch(`/api/brands/${Number(brandId)}/excellent-remix-preview`, { method: "POST", body, signal });
}

export interface RemixSlideResult {
  slideJob?: { jobId?: string };
  creditEventId?: number | null;
  user?: SessionUser;
  [key: string]: unknown;
}

export function generateExcellentRemixSlide(
  brandId: number | string,
  slideIndex: number,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RemixSlideResult> {
  return apiFetch(`/api/brands/${Number(brandId)}/excellent-remix/slides/${Number(slideIndex)}`, {
    method: "POST",
    body,
    signal,
  });
}

export function completeExcellentRemix(
  brandId: number | string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ generation?: Record<string, unknown>; user?: SessionUser }> {
  return apiFetch(`/api/brands/${Number(brandId)}/excellent-remix/complete`, { method: "POST", body, signal });
}
