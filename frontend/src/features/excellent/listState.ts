/**
 * Pure helpers for excellent-content board list / refresh request state.
 * TS port of public/js/excellent-list-state.js with identical semantics.
 * The legacy sessionEpoch/loadEpoch pair is replaced by AbortSignal-based
 * cancellation upstream; requestId gating is kept verbatim.
 */
import type { ExcellentBoard, ExcellentListResult, ExcellentNote } from "./types";

export type ExcellentSliceStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface ExcellentBoardSlice {
  items: ExcellentNote[];
  contentSource: string;
  categoryPath: string;
  industryPath: string;
  draftContentSource: string;
  draftCategoryPath: string;
  draftIndustryPath: string;
  status: ExcellentSliceStatus;
  error: string;
  updatedAt: string;
  stale: boolean;
  hasCache: boolean;
  needsUpdate: boolean;
  refreshing: boolean;
  refreshError: string;
  requestId: number;
}

export interface ExcellentRequestFilters {
  board?: string;
  contentSource?: string;
  categoryPath?: string;
  industryPath?: string;
}

export function createExcellentBoardSlice(): ExcellentBoardSlice {
  return {
    items: [],
    contentSource: "all",
    categoryPath: "",
    industryPath: "",
    draftContentSource: "all",
    draftCategoryPath: "",
    draftIndustryPath: "",
    status: "idle",
    error: "",
    updatedAt: "",
    stale: false,
    hasCache: false,
    needsUpdate: false,
    refreshing: false,
    refreshError: "",
    requestId: 0,
  };
}

/**
 * Formal filters describe the currently displayed items.
 * Draft filters are what the user selected but has not applied via "更新内容".
 */
export function excellentFiltersAreDirty(boardSlice: ExcellentBoardSlice | null, board: ExcellentBoard): boolean {
  if (!boardSlice || typeof boardSlice !== "object") return false;
  const formalSource = String(boardSlice.contentSource || "all");
  const draftSource = String(boardSlice.draftContentSource || "all");
  if (formalSource !== draftSource) return true;
  if (board === "ecommerce_hot") {
    return String(boardSlice.industryPath || "") !== String(boardSlice.draftIndustryPath || "");
  }
  return String(boardSlice.categoryPath || "") !== String(boardSlice.draftCategoryPath || "");
}

/**
 * Commit draft filters to formal filters after a successful explicit refresh.
 * requestFilters is the immutable snapshot used for the POST body.
 */
export function commitExcellentDraftFilters(
  slice: ExcellentBoardSlice,
  board: ExcellentBoard,
  requestFilters: ExcellentRequestFilters = {},
): ExcellentBoardSlice {
  if (!slice || typeof slice !== "object") return slice;
  const contentSource = String(requestFilters.contentSource || "all") || "all";
  slice.contentSource = contentSource;
  slice.draftContentSource = contentSource;
  if (board === "ecommerce_hot") {
    const industryPath = String(requestFilters.industryPath || "");
    slice.industryPath = industryPath;
    slice.draftIndustryPath = industryPath;
  } else {
    const categoryPath = String(requestFilters.categoryPath || "");
    slice.categoryPath = categoryPath;
    slice.draftCategoryPath = categoryPath;
  }
  return slice;
}

/**
 * On refresh failure, roll draft dropdown values back to the formal filters
 * so UI never claims the list matches unapplied draft selections.
 */
export function rollbackExcellentDraftFilters(slice: ExcellentBoardSlice, board: ExcellentBoard): ExcellentBoardSlice {
  if (!slice || typeof slice !== "object") return slice;
  slice.draftContentSource = slice.contentSource || "all";
  if (board === "ecommerce_hot") {
    slice.draftIndustryPath = slice.industryPath || "";
  } else {
    slice.draftCategoryPath = slice.categoryPath || "";
  }
  return slice;
}

/**
 * Validate that a refresh response matches the immutable requestFilters snapshot.
 */
export function excellentRefreshResponseMatches(
  result: ExcellentListResult | null | undefined,
  requestFilters: ExcellentRequestFilters = {},
): boolean {
  if (!result || typeof result !== "object") return false;
  if (String(result.board || "") !== String(requestFilters.board || "")) return false;
  if (String(result.contentSource || "all") !== String(requestFilters.contentSource || "all")) return false;
  if (String(requestFilters.board || "") === "ecommerce_hot") {
    return String(result.industryPath || "") === String(requestFilters.industryPath || "");
  }
  return String(result.categoryPath || "") === String(requestFilters.categoryPath || "");
}

/** Whether a list/refresh response may still write into its request slice. */
export function shouldApplyExcellentListResult(requestId: number, sliceRequestId: number): boolean {
  return Number(requestId) === Number(sliceRequestId);
}

export interface ApplyListArgs {
  slice: ExcellentBoardSlice;
  requestId: number;
  result?: ExcellentListResult | null;
  activeBoard?: string;
  requestBoard?: string;
}

/**
 * Apply a successful cache-only list payload onto the request slice.
 * Always updates the slice that issued the request (even if the UI board changed).
 */
export function applyExcellentListResult({ slice, requestId, result, activeBoard, requestBoard }: ApplyListArgs): {
  applied: boolean;
  isActive: boolean;
} {
  if (!slice || typeof slice !== "object") return { applied: false, isActive: false };
  if (!shouldApplyExcellentListResult(requestId, slice.requestId)) {
    return { applied: false, isActive: false };
  }

  const items = result && Array.isArray(result.items) ? result.items : [];
  slice.items = items;
  slice.updatedAt = result?.updatedAt || "";
  slice.stale = Boolean(result?.stale);
  slice.hasCache = result?.hasCache === true || items.length > 0;
  slice.needsUpdate = result?.needsUpdate === true || !slice.hasCache;
  slice.status = items.length ? "ready" : "empty";
  slice.error = "";
  // Cache-only read must not clear a prior refreshError until user refreshes again.

  const isActive = String(activeBoard || "") === String(requestBoard || "");
  return { applied: true, isActive };
}

/** Apply a successful explicit refresh payload. Replaces items; clears refreshError. */
export function applyExcellentRefreshResult({ slice, requestId, result, activeBoard, requestBoard }: ApplyListArgs): {
  applied: boolean;
  isActive: boolean;
} {
  if (!slice || typeof slice !== "object") return { applied: false, isActive: false };
  if (!shouldApplyExcellentListResult(requestId, slice.requestId)) {
    return { applied: false, isActive: false };
  }

  const items = result && Array.isArray(result.items) ? result.items : [];
  slice.items = items;
  slice.updatedAt = result?.updatedAt || "";
  slice.stale = false;
  slice.hasCache = items.length > 0 || result?.hasCache === true;
  slice.needsUpdate = !slice.hasCache;
  slice.status = items.length ? "ready" : "empty";
  slice.error = "";
  slice.refreshError = "";
  slice.refreshing = false;

  const isActive = String(activeBoard || "") === String(requestBoard || "");
  return { applied: true, isActive };
}

export interface ApplyErrorArgs {
  slice: ExcellentBoardSlice;
  requestId: number;
  error?: { message?: string } | null;
  preserveItems?: boolean;
  hadItems?: boolean;
  activeBoard?: string;
  requestBoard?: string;
}

/**
 * Apply a failed list request onto the request slice.
 * Clears loading so a switched-away board never sticks on "loading".
 */
export function applyExcellentListError({
  slice,
  requestId,
  error,
  preserveItems = true,
  hadItems = false,
  activeBoard,
  requestBoard,
}: ApplyErrorArgs): { applied: boolean; isActive: boolean } {
  if (!slice || typeof slice !== "object") return { applied: false, isActive: false };
  if (!shouldApplyExcellentListResult(requestId, slice.requestId)) {
    return { applied: false, isActive: false };
  }

  if (preserveItems && hadItems) {
    slice.status = "ready";
    slice.error = error?.message || "优秀内容加载失败";
  } else {
    slice.status = "error";
    slice.error = error?.message || "优秀内容加载失败";
  }

  const isActive = String(activeBoard || "") === String(requestBoard || "");
  return { applied: true, isActive };
}

/** Apply a failed explicit refresh. Keeps old items; sets refreshError. */
export function applyExcellentRefreshError({
  slice,
  requestId,
  error,
  activeBoard,
  requestBoard,
}: ApplyErrorArgs): { applied: boolean; isActive: boolean } {
  if (!slice || typeof slice !== "object") return { applied: false, isActive: false };
  if (!shouldApplyExcellentListResult(requestId, slice.requestId)) {
    return { applied: false, isActive: false };
  }

  slice.refreshing = false;
  const hadItems = (slice.items || []).length > 0;
  if (hadItems) {
    slice.status = "ready";
    slice.refreshError = "更新失败，当前仍展示上一次保存的数据。";
  } else {
    slice.status = slice.status === "loading" ? "empty" : slice.status || "empty";
    slice.refreshError = error?.message || "更新失败，请稍后重试。";
  }

  const isActive = String(activeBoard || "") === String(requestBoard || "");
  return { applied: true, isActive };
}

/** Build a stable cache key for board/source/taxonomy isolation. */
export function excellentContentCacheKey(board?: string, contentSource?: string, taxonomyPath?: string): string {
  return `${String(board || "xhs_hot")}::${String(contentSource || "all")}::${String(taxonomyPath || "")}`;
}
