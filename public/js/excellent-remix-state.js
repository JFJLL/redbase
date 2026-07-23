/** Pure state helpers for excellent remix modal (content-direction v3). */

export const REMIX_CONTENT_MODES = Object.freeze({
  SMART: "smart",
  EXISTING_IDEA: "existing_idea",
  CUSTOM: "custom",
});

export const REMIX_ASSET_MODES = Object.freeze({
  NONE: "none",
  LOGO: "logo",
  PRODUCT: "product",
  LOGO_AND_PRODUCT: "logo_and_product",
});

/** Default learning focus avoids claiming reference visual understanding without multimodal. */
export const DEFAULT_LEARNING_FOCUS = Object.freeze(["structure", "hook"]);
export const MAX_REMIX_PRODUCT_IMAGES = 2;
export const MIN_CUSTOM_DIRECTION_CHARS = 5;
export const MAX_CUSTOM_DIRECTION_CHARS = 500;

export function createExcellentRemixState(seed = {}) {
  return {
    noteId: String(seed.noteId || ""),
    board: seed.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot",
    contentSource: String(seed.contentSource || "all"),
    categoryPath: String(seed.categoryPath || ""),
    industryPath: String(seed.industryPath || ""),
    brandId: seed.brandId ?? null,
    instanceId: Number(seed.instanceId) || 0,
    sessionEpoch: Number(seed.sessionEpoch) || 0,
    learningFocus: Array.isArray(seed.learningFocus)
      ? [...seed.learningFocus]
      : [...DEFAULT_LEARNING_FOCUS],
    contentDirectionMode: REMIX_CONTENT_MODES.SMART,
    smartDirections: [],
    selectedSmartDirectionId: "",
    existingIdeas: [],
    existingIdeaQuery: "",
    selectedExistingIdea: null,
    customDirection: "",
    useTrendContext: false,
    trendRecommendations: [],
    selectedTrendId: null,
    trendRecommendMessage: "",
    analysis: null,
    analysisStatus: "idle", // idle | loading | ready | degraded | error
    analysisError: "",
    analysisId: "",
    directionsStatus: "idle",
    directionsError: "",
    directionsAutoTriggered: false,
    fusionPlan: null,
    fusionStatus: "idle", // idle | loading | ready | error | stale
    fusionError: "",
    assetMode: REMIX_ASSET_MODES.NONE,
    useBrandLogo: false,
    productImageIds: [],
    brandProductImages: [],
    brandProductImagesStatus: "idle",
    productPickerOpen: false,
    loadingBrand: false,
    sections: {
      assetsCollapsed: true,
      trendCollapsed: false,
    },
    // sessionEpoch alias kept for older call sites; real isolation uses instanceId + request ids.
    requestEpoch: Number(seed.sessionEpoch || seed.requestEpoch) || 0,
    analysisRequestId: 0,
    brandRequestId: 0,
    directionsRequestId: 0,
    trendRequestId: 0,
    fusionRequestId: 0,
    productImagesRequestId: 0,
  };
}

export function cloneRemixState(state) {
  if (!state) return null;
  return {
    ...state,
    learningFocus: [...(state.learningFocus || [])],
    smartDirections: [...(state.smartDirections || [])],
    existingIdeas: [...(state.existingIdeas || [])],
    productImageIds: [...(state.productImageIds || [])],
    brandProductImages: [...(state.brandProductImages || [])],
    trendRecommendations: [...(state.trendRecommendations || [])],
    selectedExistingIdea: state.selectedExistingIdea ? { ...state.selectedExistingIdea } : null,
    analysis: state.analysis ? { ...state.analysis } : null,
    fusionPlan: state.fusionPlan ? { ...state.fusionPlan } : null,
    sections: { ...(state.sections || {}) },
  };
}

export function toggleLearningFocus(focusList, value, checked) {
  const current = Array.isArray(focusList) ? focusList : [];
  if (checked) return [...new Set([...current, value])];
  return current.filter((item) => item !== value);
}

export function markFusionStale(state) {
  if (!state) return state;
  if (state.fusionPlan || state.fusionStatus === "ready") {
    return { ...state, fusionStatus: "stale", fusionError: "" };
  }
  return state;
}

export function invalidateAfterInputChange(state, fields = {}) {
  let next = { ...state, ...fields };
  next = markFusionStale(next);
  return next;
}

export function filterExistingIdeas(ideas, query) {
  const list = Array.isArray(ideas) ? ideas : [];
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return list;
  return list.filter((idea) => {
    const hay = [
      idea.ideaTitle,
      idea.ideaSummary,
      idea.trendTitle,
      idea.audience,
      idea.scene,
      idea.brandFit,
      idea.analysisName,
      idea.scope,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function getSelectedSmartDirection(state) {
  if (!state) return null;
  return (state.smartDirections || []).find((item) => item.id === state.selectedSmartDirectionId) || null;
}

export function buildExistingIdeaKey(idea) {
  if (!idea) return "";
  const scope = idea.scope === "snapshot" ? "snapshot" : "current";
  const analysisId = idea.analysisId == null || idea.analysisId === "" ? 0 : Number(idea.analysisId);
  return `${scope}:${analysisId}:${Number(idea.trendId)}:${Number(idea.ideaIndex)}`;
}

export function parseExistingIdeaKey(raw) {
  const parts = String(raw || "").split(":");
  if (parts.length < 4) return null;
  const [scopeRaw, analysisRaw, trendRaw, ideaRaw] = parts;
  const scope = scopeRaw === "snapshot" ? "snapshot" : "current";
  const analysisId = Number(analysisRaw);
  const trendId = Number(trendRaw);
  const ideaIndex = Number(ideaRaw);
  if (!Number.isFinite(trendId) || !Number.isInteger(ideaIndex) || ideaIndex < 0) return null;
  return {
    scope,
    analysisId: scope === "snapshot" && Number.isFinite(analysisId) && analysisId > 0 ? analysisId : null,
    trendId,
    ideaIndex,
  };
}

export function hasValidContentDirection(state) {
  if (!state) return false;
  if (state.contentDirectionMode === REMIX_CONTENT_MODES.SMART) {
    return Boolean(getSelectedSmartDirection(state));
  }
  if (state.contentDirectionMode === REMIX_CONTENT_MODES.EXISTING_IDEA) {
    const idea = state.selectedExistingIdea;
    return Boolean(idea && idea.trendId != null && idea.ideaIndex != null);
  }
  const custom = String(state.customDirection || "").trim();
  return custom.length >= MIN_CUSTOM_DIRECTION_CHARS && custom.length <= MAX_CUSTOM_DIRECTION_CHARS;
}

export function canGenerateFusionPlan(state, brandReady) {
  return Boolean(
    state &&
      brandReady &&
      state.brandId &&
      (state.analysisStatus === "ready" || state.analysisStatus === "degraded") &&
      hasValidContentDirection(state) &&
      state.fusionStatus !== "loading",
  );
}

export function canSubmitExcellentRemix(state, brandReady) {
  return Boolean(
    canGenerateFusionPlan(state, brandReady) &&
      state.fusionStatus === "ready" &&
      state.fusionPlan?.carouselPack?.slides?.length === 4,
  );
}

export function resolveAssetFlags(state) {
  const mode = state?.assetMode || REMIX_ASSET_MODES.NONE;
  if (mode === REMIX_ASSET_MODES.NONE) {
    return { useBrandLogo: false, productImageIds: [] };
  }
  if (mode === REMIX_ASSET_MODES.LOGO) {
    return { useBrandLogo: Boolean(state.useBrandLogo), productImageIds: [] };
  }
  if (mode === REMIX_ASSET_MODES.PRODUCT) {
    return {
      useBrandLogo: false,
      productImageIds: [...(state.productImageIds || [])].slice(0, MAX_REMIX_PRODUCT_IMAGES),
    };
  }
  return {
    useBrandLogo: Boolean(state.useBrandLogo),
    productImageIds: [...(state.productImageIds || [])].slice(0, MAX_REMIX_PRODUCT_IMAGES),
  };
}

export function buildExistingIdeaRef(state) {
  if (state?.contentDirectionMode !== REMIX_CONTENT_MODES.EXISTING_IDEA || !state.selectedExistingIdea) {
    return null;
  }
  const idea = state.selectedExistingIdea;
  return {
    scope: idea.scope === "snapshot" ? "snapshot" : "current",
    analysisId: idea.analysisId == null || idea.analysisId === "" ? null : Number(idea.analysisId),
    trendId: Number(idea.trendId),
    ideaIndex: Number(idea.ideaIndex),
  };
}

export function buildFusionRequestBody(state) {
  const direction = getSelectedSmartDirection(state);
  return {
    board: state.board,
    contentSource: state.contentSource,
    categoryPath: state.categoryPath,
    industryPath: state.industryPath,
    brandId: Number(state.brandId),
    learningFocus: [...(state.learningFocus || [])],
    contentMode: state.contentDirectionMode,
    smartDirection: state.contentDirectionMode === REMIX_CONTENT_MODES.SMART ? direction : null,
    existingIdeaRef: buildExistingIdeaRef(state),
    customDirection:
      state.contentDirectionMode === REMIX_CONTENT_MODES.CUSTOM ? String(state.customDirection || "").trim() : "",
    useTrendContext: Boolean(state.useTrendContext),
    trendId: state.useTrendContext ? state.selectedTrendId : null,
    sourceAnalysisId: state.analysisId || state.analysis?.analysisId || "",
  };
}

export function buildGenerationPayload(state, fusionPlan) {
  const assets = resolveAssetFlags(state);
  return {
    carouselPack: fusionPlan.carouselPack,
    contentMode: state.contentDirectionMode,
    existingIdeaRef: buildExistingIdeaRef(state),
    // Client may send labels for UX only; server re-resolves authoritative titles.
    ideaTitle: fusionPlan.carouselPack?.publishTitle || fusionPlan.contentThesis || "",
    trendTitle: fusionPlan.trendUsed ? fusionPlan.trendTitle || "" : "",
    useBrandLogo: assets.useBrandLogo,
    productImageIds: assets.productImageIds,
  };
}

export function defaultLearningFocusForAnalysis(analysis) {
  if (analysis?.analysisMode === "multimodal" && analysis?.meta?.multimodalUsed) {
    return ["structure", "visual", "hook"];
  }
  return [...DEFAULT_LEARNING_FOCUS];
}

export function isPlatformDefaultVisual(analysis) {
  if (!analysis) return true;
  if (analysis.analysisMode === "metadata_only") return true;
  if (analysis.visualLanguage?.source === "platform_default") return true;
  return !analysis.meta?.multimodalUsed;
}
