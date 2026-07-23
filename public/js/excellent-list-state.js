/**
 * Pure helpers for excellent-content board list / refresh request state.
 * Safe to unit-test without DOM.
 */

/**
 * Whether a list/refresh response may write into its request slice.
 * Independent of which board is currently active in the UI.
 */
export function shouldApplyExcellentListResult({
  requestId,
  sliceRequestId,
  sessionEpoch,
  loadEpoch,
} = {}) {
  if (sessionEpoch !== loadEpoch) return false;
  if (Number(requestId) !== Number(sliceRequestId)) return false;
  return true;
}

/**
 * Apply a successful cache-only list payload onto the request slice.
 * Always updates the slice that issued the request (even if the UI board changed).
 * Returns { applied: boolean, isActive: boolean } for callers that only render when active.
 */
export function applyExcellentListResult({
  slice,
  requestId,
  sessionEpoch,
  loadEpoch,
  result,
  activeBoard,
  requestBoard,
} = {}) {
  if (!slice || typeof slice !== "object") {
    return { applied: false, isActive: false };
  }
  if (
    !shouldApplyExcellentListResult({
      requestId,
      sliceRequestId: slice.requestId,
      sessionEpoch,
      loadEpoch,
    })
  ) {
    return { applied: false, isActive: false };
  }

  const items = Array.isArray(result?.items) ? result.items : [];
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

/**
 * Apply a successful explicit refresh payload. Replaces items; clears refreshError.
 */
export function applyExcellentRefreshResult({
  slice,
  requestId,
  sessionEpoch,
  loadEpoch,
  result,
  activeBoard,
  requestBoard,
} = {}) {
  if (!slice || typeof slice !== "object") {
    return { applied: false, isActive: false };
  }
  if (
    !shouldApplyExcellentListResult({
      requestId,
      sliceRequestId: slice.requestId,
      sessionEpoch,
      loadEpoch,
    })
  ) {
    return { applied: false, isActive: false };
  }

  const items = Array.isArray(result?.items) ? result.items : [];
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

/**
 * Apply a failed list request onto the request slice.
 * Clears loading so a switched-away board never sticks on "loading".
 */
export function applyExcellentListError({
  slice,
  requestId,
  sessionEpoch,
  loadEpoch,
  error,
  preserveItems = true,
  hadItems = false,
  activeBoard,
  requestBoard,
} = {}) {
  if (!slice || typeof slice !== "object") {
    return { applied: false, isActive: false };
  }
  if (
    !shouldApplyExcellentListResult({
      requestId,
      sliceRequestId: slice.requestId,
      sessionEpoch,
      loadEpoch,
    })
  ) {
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

/**
 * Apply a failed explicit refresh. Keeps old items; sets refreshError.
 */
export function applyExcellentRefreshError({
  slice,
  requestId,
  sessionEpoch,
  loadEpoch,
  error,
  activeBoard,
  requestBoard,
} = {}) {
  if (!slice || typeof slice !== "object") {
    return { applied: false, isActive: false };
  }
  if (
    !shouldApplyExcellentListResult({
      requestId,
      sliceRequestId: slice.requestId,
      sessionEpoch,
      loadEpoch,
    })
  ) {
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

/**
 * Build a stable cache key for board/source/taxonomy isolation.
 */
export function excellentContentCacheKey(board, contentSource, taxonomyPath) {
  return `${String(board || "xhs_hot")}::${String(contentSource || "all")}::${String(taxonomyPath || "")}`;
}
