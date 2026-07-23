/**
 * Pure request-token helpers for excellent remix modal isolation.
 * Ensures async responses never write across notes, brands, or modal instances.
 */

export function createRemixRequestCounters() {
  return {
    analysisRequestId: 0,
    brandRequestId: 0,
    directionsRequestId: 0,
    trendRequestId: 0,
    fusionRequestId: 0,
    productImagesRequestId: 0,
  };
}

/**
 * Capture a snapshot of identity + request ids at the moment a request starts.
 */
export function captureRemixRequestToken(state, requestKey, requestId) {
  if (!state) return null;
  return {
    instanceId: Number(state.instanceId) || 0,
    sessionEpoch: Number(state.sessionEpoch ?? state.requestEpoch) || 0,
    noteId: String(state.noteId || ""),
    board: state.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot",
    brandId: state.brandId == null || state.brandId === "" ? null : Number(state.brandId),
    requestKey: requestKey || "",
    requestId: Number(requestId) || 0,
  };
}

/**
 * Bump one request counter on state and return the new id.
 */
export function nextRemixRequestId(state, requestKey) {
  if (!state || !requestKey) return 0;
  const next = (Number(state[requestKey]) || 0) + 1;
  state[requestKey] = next;
  return next;
}

/**
 * Whether an async response is still allowed to write into the live modal state.
 *
 * @param {object|null} state live excellentRemixState
 * @param {object|null} token captureRemixRequestToken result
 * @param {{ requireBrand?: boolean, brandId?: number|null }} [options]
 */
export function isRemixResponseCurrent(state, token, options = {}) {
  if (!state || !token) return false;
  if (Number(state.instanceId) !== Number(token.instanceId)) return false;
  if (Number(state.sessionEpoch ?? state.requestEpoch) !== Number(token.sessionEpoch)) return false;
  if (String(state.noteId || "") !== String(token.noteId || "")) return false;
  const stateBoard = state.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const tokenBoard = token.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  if (stateBoard !== tokenBoard) return false;

  if (token.requestKey) {
    if (Number(state[token.requestKey]) !== Number(token.requestId)) return false;
  }

  if (options.requireBrand || token.brandId != null) {
    const expectedBrand =
      options.brandId != null ? Number(options.brandId) : token.brandId != null ? Number(token.brandId) : null;
    if (expectedBrand == null || !Number.isFinite(expectedBrand)) return false;
    if (Number(state.brandId) !== Number(expectedBrand)) return false;
  }

  return true;
}

/**
 * Analysis has reached a terminal state where smart directions may start.
 */
export function isRemixAnalysisSettled(state) {
  const status = state?.analysisStatus;
  return status === "ready" || status === "degraded" || status === "error";
}

/**
 * Whether smart directions should auto-fire once after analysis + brand are ready.
 */
export function shouldAutoGenerateSmartDirections(state) {
  if (!state) return false;
  if (state.contentDirectionMode !== "smart") return false;
  if (state.directionsAutoTriggered) return false;
  if (!state.brandId) return false;
  if (state.loadingBrand) return false;
  if (!isRemixAnalysisSettled(state)) return false;
  if (state.directionsStatus === "loading" || state.directionsStatus === "ready") return false;
  return true;
}
