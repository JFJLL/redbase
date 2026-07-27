import { describe, expect, it } from "vitest";
import {
  buildExistingIdeaKey,
  buildFusionRequestBody,
  buildGenerationPayload,
  canGenerateFusionPlan,
  canSubmitExcellentRemix,
  createExcellentRemixState,
  DEFAULT_LEARNING_FOCUS,
  filterExistingIdeas,
  hasValidContentDirection,
  markFusionStale,
  parseExistingIdeaKey,
  REMIX_ASSET_MODES,
  REMIX_CONTENT_MODES,
  resolveAssetFlags,
  toggleLearningFocus,
} from "../remixState";
import type { FusionPlan } from "../types";

function readyState() {
  const state = createExcellentRemixState({
    noteId: "note-1",
    board: "xhs_hot",
    contentSource: "buyer",
    categoryPath: "小红书#美妆",
    brandId: 7,
  });
  state.analysisStatus = "ready";
  state.analysisId = "an-9";
  state.smartDirections = [{ id: "d1", title: "方向一" }];
  state.selectedSmartDirectionId = "d1";
  return state;
}

const fourSlidePlan: FusionPlan = {
  carouselPack: {
    publishTitle: "四页方案",
    slides: [{ title: "1" }, { title: "2" }, { title: "3" }, { title: "4" }],
  },
};

describe("excellent remix state", () => {
  it("builds the fusion request body exactly like the legacy module (smart mode)", () => {
    const state = readyState();
    expect(buildFusionRequestBody(state)).toEqual({
      board: "xhs_hot",
      contentSource: "buyer",
      categoryPath: "小红书#美妆",
      industryPath: "",
      brandId: 7,
      learningFocus: [...DEFAULT_LEARNING_FOCUS],
      contentMode: "smart",
      smartDirection: { id: "d1", title: "方向一" },
      existingIdeaRef: null,
      customDirection: "",
      useTrendContext: false,
      trendId: null,
      sourceAnalysisId: "an-9",
    });
  });

  it("builds the fusion request body for custom and existing-idea modes", () => {
    const state = readyState();
    state.contentDirectionMode = REMIX_CONTENT_MODES.CUSTOM;
    state.customDirection = "  写一个五一露营主题的干货攻略  ";
    expect(buildFusionRequestBody(state)).toMatchObject({
      contentMode: "custom",
      smartDirection: null,
      customDirection: "写一个五一露营主题的干货攻略",
    });

    state.contentDirectionMode = REMIX_CONTENT_MODES.EXISTING_IDEA;
    state.selectedExistingIdea = { scope: "snapshot", analysisId: 3, trendId: 11, ideaIndex: 2 };
    expect(buildFusionRequestBody(state)).toMatchObject({
      contentMode: "existing_idea",
      existingIdeaRef: { scope: "snapshot", analysisId: 3, trendId: 11, ideaIndex: 2 },
      customDirection: "",
    });
  });

  it("tracks the fusion status flow: ready -> stale after input change -> blocks submit", () => {
    const state = readyState();
    expect(canGenerateFusionPlan(state, true)).toBe(true);
    expect(canSubmitExcellentRemix(state, true)).toBe(false);

    state.fusionPlan = fourSlidePlan;
    state.fusionStatus = "ready";
    expect(canSubmitExcellentRemix(state, true)).toBe(true);

    // Any upstream input change marks the plan stale and blocks submission.
    state.learningFocus = toggleLearningFocus(state.learningFocus, "visual", true);
    markFusionStale(state);
    expect(state.fusionStatus).toBe("stale");
    expect(canSubmitExcellentRemix(state, true)).toBe(false);

    // A 3-slide plan is never submittable.
    state.fusionStatus = "ready";
    state.fusionPlan = { carouselPack: { slides: [{}, {}, {}] } };
    expect(canSubmitExcellentRemix(state, true)).toBe(false);
  });

  it("validates content directions per mode", () => {
    const state = readyState();
    expect(hasValidContentDirection(state)).toBe(true);
    state.selectedSmartDirectionId = "missing";
    expect(hasValidContentDirection(state)).toBe(false);

    state.contentDirectionMode = REMIX_CONTENT_MODES.CUSTOM;
    state.customDirection = "太短";
    expect(hasValidContentDirection(state)).toBe(false);
    state.customDirection = "长度刚好满足最小限制";
    expect(hasValidContentDirection(state)).toBe(true);
  });

  it("resolves asset flags and generation payload", () => {
    const state = readyState();
    state.assetMode = REMIX_ASSET_MODES.LOGO_AND_PRODUCT;
    state.useBrandLogo = true;
    state.productImageIds = [1, 2, 3];
    expect(resolveAssetFlags(state)).toEqual({ useBrandLogo: true, productImageIds: [1, 2] });

    state.fusionPlan = fourSlidePlan;
    const payload = buildGenerationPayload(state, fourSlidePlan);
    expect(payload.ideaTitle).toBe("四页方案");
    expect(payload.trendTitle).toBe("");
    expect(payload.useBrandLogo).toBe(true);
    expect(payload.productImageIds).toEqual([1, 2]);
  });

  it("round-trips existing idea keys and filters ideas", () => {
    const key = buildExistingIdeaKey({ scope: "snapshot", analysisId: 5, trendId: 9, ideaIndex: 1 });
    expect(key).toBe("snapshot:5:9:1");
    expect(parseExistingIdeaKey(key)).toEqual({ scope: "snapshot", analysisId: 5, trendId: 9, ideaIndex: 1 });
    expect(parseExistingIdeaKey("bad")).toBeNull();

    const ideas = [
      { ideaTitle: "露营装备清单", trendId: 1, ideaIndex: 0 },
      { ideaTitle: "护肤晨间流程", trendId: 2, ideaIndex: 0 },
    ];
    expect(filterExistingIdeas(ideas, "露营")).toHaveLength(1);
    expect(filterExistingIdeas(ideas, "")).toHaveLength(2);
  });
});
