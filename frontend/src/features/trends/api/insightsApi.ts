// 趋势分析 / 内容选题的后端接口封装。路径、方法与请求体字段与旧前端
// public/app.js 中的 request(...) 调用保持一致（后端 src/server/api/trend-routes.js）。
import { apiFetch } from "@/shared/api/client";
import type {
  AnalysisDeleteResponse,
  BrandDetailResponse,
  BrandListResponse,
  IdeaUpdateResponse,
  RegenerateIdeasResponse,
  TrendAnalysisResponse,
  XhsCategoryTreeResponse,
} from "../model/types";

export function fetchBrandSummaries(signal?: AbortSignal): Promise<BrandListResponse> {
  return apiFetch<BrandListResponse>("/api/brands?summary=1", { signal });
}

export function fetchBrandDetail(brandId: number, signal?: AbortSignal): Promise<BrandDetailResponse> {
  return apiFetch<BrandDetailResponse>(`/api/brands/${brandId}`, { signal });
}

export function fetchXhsCategories(signal?: AbortSignal): Promise<XhsCategoryTreeResponse> {
  return apiFetch<XhsCategoryTreeResponse>("/api/trends/xhs/categories", { signal });
}

export function runTrendAnalysis(
  brandId: number,
  payload: { requestId: string; bucketKey: string; xhsCategoryPath: string },
  signal?: AbortSignal,
): Promise<TrendAnalysisResponse> {
  return apiFetch<TrendAnalysisResponse>(`/api/brands/${brandId}/analyses`, {
    method: "POST",
    body: payload,
    signal,
  });
}

export function deleteAnalysis(
  brandId: number,
  analysisId: number,
  signal?: AbortSignal,
): Promise<AnalysisDeleteResponse> {
  return apiFetch<AnalysisDeleteResponse>(`/api/brands/${brandId}/analyses/${analysisId}`, {
    method: "DELETE",
    signal,
  });
}

export function regenerateTrendIdeas(
  brandId: number,
  trendId: number,
  customPrompt: string,
  signal?: AbortSignal,
): Promise<RegenerateIdeasResponse> {
  return apiFetch<RegenerateIdeasResponse>(`/api/brands/${brandId}/trends/${trendId}/ideas/regenerate`, {
    method: "POST",
    body: { customPrompt },
    signal,
  });
}

export function updateTrendIdea(
  brandId: number,
  trendId: number,
  ideaIndex: number,
  payload: { title: string; summary: string; angle: string; brandFit: string; audience: string; hook: string },
  signal?: AbortSignal,
): Promise<IdeaUpdateResponse> {
  return apiFetch<IdeaUpdateResponse>(`/api/brands/${brandId}/trends/${trendId}/ideas/${ideaIndex}`, {
    method: "PATCH",
    body: payload,
    signal,
  });
}
