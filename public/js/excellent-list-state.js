/**
 * Pure helpers for excellent-content board list request state.
 * Safe to unit-test without DOM.
 */

/**
 * Whether a list response may write into its request slice.
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
 * Apply a successful list payload onto the request slice.
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
  slice.status = items.length ? "ready" : "empty";
  if (result?.stale && result?.lastError) {
    slice.error = "当前展示最近一次成功数据，暂时未能更新。";
  } else {
    slice.error = "";
  }

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
    slice.stale = true;
    slice.error = "当前展示最近一次成功数据，暂时未能更新。";
  } else {
    slice.status = "error";
    slice.error = error?.message || "优秀内容加载失败";
  }

  const isActive = String(activeBoard || "") === String(requestBoard || "");
  return { applied: true, isActive };
}

/**
 * Build a stable cache key for SWR fresh-check isolation.
 */
export function excellentContentCacheKey(board, contentSource, taxonomyPath) {
  return `${String(board || "xhs_hot")}::${String(contentSource || "all")}::${String(taxonomyPath || "")}`;
}
