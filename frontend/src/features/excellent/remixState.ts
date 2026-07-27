/**
 * Pure state helpers for the excellent remix flow (content-direction v3).
 * TS port of public/js/excellent-remix-state.js with identical semantics.
 */
import type { ExcellentBoard, ExistingIdea, FusionPlan, RemixAnalysis, SmartDirection } from "./types";

export const REMIX_CONTENT_MODES = Object.freeze({
  SMART: "smart",
  EXISTING_IDEA: "existing_idea",
  CUSTOM: "custom",
} as const);

export type RemixContentMode = (typeof REMIX_CONTENT_MODES)[keyof typeof REMIX_CONTENT_MODES];

export const REMIX_ASSET_MODES = Object.freeze({
  NONE: "none",
  LOGO: "logo",
  PRODUCT: "product",
  LOGO_AND_PRODUCT: "logo_and_product",
} as const);

export type RemixAssetMode = (typeof REMIX_ASSET_MODES)[keyof typeof REMIX_ASSET_MODES];

/** Default learning focus avoids claiming reference visual understanding without multimodal. */
export const DEFAULT_LEARNING_FOCUS: readonly string[] = Object.freeze(["structure", "hook"]);
export const MAX_REMIX_PRODUCT_IMAGES = 2;
export const MIN_CUSTOM_DIRECTION_CHARS = 5;
export const MAX_CUSTOM_DIRECTION_CHARS = 500;

export type RemixStageStatus = "idle" | "loading" | "ready" | "degraded" | "error" | "stale";

export interface ExcellentRemixState {
  noteId: string;
  board: ExcellentBoard;
  contentSource: string;
  categoryPath: string;
  industryPath: string;
  brandId: number | string | null;
  learningFocus: string[];
  contentDirectionMode: RemixContentMode;
  smartDirections: SmartDirection[];
  selectedSmartDirectionId: string;
  existingIdeas: ExistingIdea[];
  existingIdeaQuery: string;
  selectedExistingIdea: ExistingIdea | null;
  customDirection: string;
  // Trend context UI removed; always keep closed for fusion requests.
  useTrendContext: boolean;
  analysis: RemixAnalysis | null;
  analysisStatus: RemixStageStatus;
  analysisError: string;
  analysisId: string;
  directionsStatus: RemixStageStatus;
  directionsError: string;
  fusionPlan: FusionPlan | null;
  fusionStatus: RemixStageStatus;
  fusionError: string;
  assetMode: RemixAssetMode;
  useBrandLogo: boolean;
  productImageIds: number[];
}

export interface RemixStateSeed {
  noteId?: string;
  board?: string;
  contentSource?: string;
  categoryPath?: string;
  industryPath?: string;
  brandId?: number | string | null;
  learningFocus?: string[];
}

export function createExcellentRemixState(seed: RemixStateSeed = {}): ExcellentRemixState {
  return {
    noteId: String(seed.noteId || ""),
    board: seed.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot",
    contentSource: String(seed.contentSource || "all"),
    categoryPath: String(seed.categoryPath || ""),
    industryPath: String(seed.industryPath || ""),
    brandId: seed.brandId ?? null,
    learningFocus: Array.isArray(seed.learningFocus) ? [...seed.learningFocus] : [...DEFAULT_LEARNING_FOCUS],
    contentDirectionMode: REMIX_CONTENT_MODES.SMART,
    smartDirections: [],
    selectedSmartDirectionId: "",
    existingIdeas: [],
    existingIdeaQuery: "",
    selectedExistingIdea: null,
    customDirection: "",
    useTrendContext: false,
    analysis: null,
    analysisStatus: "idle",
    analysisError: "",
    analysisId: "",
    directionsStatus: "idle",
    directionsError: "",
    fusionPlan: null,
    fusionStatus: "idle",
    fusionError: "",
    assetMode: REMIX_ASSET_MODES.NONE,
    useBrandLogo: false,
    productImageIds: [],
  };
}

export function toggleLearningFocus(focusList: string[], value: string, checked: boolean): string[] {
  const current = Array.isArray(focusList) ? focusList : [];
  if (checked) return [...new Set([...current, value])];
  return current.filter((item) => item !== value);
}

/** A ready fusion plan becomes stale whenever any upstream input changes. */
export function markFusionStale(state: ExcellentRemixState): void {
  if (!state) return;
  if (state.fusionPlan || state.fusionStatus === "ready") {
    state.fusionStatus = "stale";
    state.fusionError = "";
  }
}

export function filterExistingIdeas(ideas: ExistingIdea[], query: string): ExistingIdea[] {
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

export function getSelectedSmartDirection(state: ExcellentRemixState | null): SmartDirection | null {
  if (!state) return null;
  return (state.smartDirections || []).find((item) => item.id === state.selectedSmartDirectionId) || null;
}

export function buildExistingIdeaKey(idea: ExistingIdea | null): string {
  if (!idea) return "";
  const scope = idea.scope === "snapshot" ? "snapshot" : "current";
  const analysisId = idea.analysisId == null || idea.analysisId === "" ? 0 : Number(idea.analysisId);
  return `${scope}:${analysisId}:${Number(idea.trendId)}:${Number(idea.ideaIndex)}`;
}

export function parseExistingIdeaKey(raw: string): {
  scope: "snapshot" | "current";
  analysisId: number | null;
  trendId: number;
  ideaIndex: number;
} | null {
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

export function hasValidContentDirection(state: ExcellentRemixState | null): boolean {
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

export function canGenerateFusionPlan(state: ExcellentRemixState | null, brandReady: boolean): boolean {
  return Boolean(
    state &&
      brandReady &&
      state.brandId &&
      (state.analysisStatus === "ready" || state.analysisStatus === "degraded") &&
      hasValidContentDirection(state) &&
      state.fusionStatus !== "loading",
  );
}

export function canSubmitExcellentRemix(state: ExcellentRemixState | null, brandReady: boolean): boolean {
  return Boolean(
    state &&
      canGenerateFusionPlan(state, brandReady) &&
      state.fusionStatus === "ready" &&
      state.fusionPlan?.carouselPack?.slides?.length === 4,
  );
}

export function resolveAssetFlags(state: ExcellentRemixState): { useBrandLogo: boolean; productImageIds: number[] } {
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

export interface ExistingIdeaRef {
  scope: "snapshot" | "current";
  analysisId: number | null;
  trendId: number;
  ideaIndex: number;
}

export function buildExistingIdeaRef(state: ExcellentRemixState | null): ExistingIdeaRef | null {
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

export function buildFusionRequestBody(state: ExcellentRemixState): Record<string, unknown> {
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
    useTrendContext: false,
    trendId: null,
    sourceAnalysisId: state.analysisId || (state.analysis?.analysisId as string) || "",
  };
}

export function buildGenerationPayload(state: ExcellentRemixState, fusionPlan: FusionPlan): Record<string, unknown> & {
  useBrandLogo: boolean;
  productImageIds: number[];
  contentMode: RemixContentMode;
  existingIdeaRef: ExistingIdeaRef | null;
  ideaTitle: string;
  trendTitle: string;
} {
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

export function defaultLearningFocusForAnalysis(analysis: RemixAnalysis | null): string[] {
  if (analysis?.analysisMode === "multimodal" && analysis?.meta?.multimodalUsed) {
    return ["structure", "visual", "hook"];
  }
  return [...DEFAULT_LEARNING_FOCUS];
}

export function isPlatformDefaultVisual(analysis: RemixAnalysis | null): boolean {
  if (!analysis) return true;
  if (analysis.analysisMode === "metadata_only") return true;
  if (analysis.visualLanguage?.source === "platform_default") return true;
  return !analysis.meta?.multimodalUsed;
}
