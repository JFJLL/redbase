/**
 * Migrated 1:1 from tests/excellent-remix-state.test.js (legacy
 * public/js/excellent-remix-state.js, now frontend/src/features/excellent/remixState.ts).
 *
 * Mapping notes for removed legacy fields:
 * - instanceId / analysisRequestId / directionsAutoTriggered belonged to the
 *   legacy request-token machinery (excellent-remix-request.js). In the Vue
 *   implementation stale responses are cancelled through AbortSignal scopes,
 *   so the state object no longer carries request tokens. Their observable
 *   contract ("nothing auto-starts when the modal opens") is asserted via the
 *   idle analysis/directions status and empty smartDirections instead.
 * - The legacy view module (public/js/excellent-remix-view.js) became
 *   views/ExcellentView.vue; the module-link test imports the SFC instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildExistingIdeaKey,
  buildFusionRequestBody,
  buildExistingIdeaRef,
  canSubmitExcellentRemix,
  createExcellentRemixState,
  DEFAULT_LEARNING_FOCUS,
  defaultLearningFocusForAnalysis,
  filterExistingIdeas,
  hasValidContentDirection,
  isPlatformDefaultVisual,
  markFusionStale,
  MAX_REMIX_PRODUCT_IMAGES,
  parseExistingIdeaKey,
  REMIX_ASSET_MODES,
  REMIX_CONTENT_MODES,
  resolveAssetFlags,
  toggleLearningFocus,
} from "../remixState";

describe("excellent remix state (legacy contract)", () => {
  it("default remix state: smart mode, no trend, no assets, structure+hook focus", () => {
    const state = createExcellentRemixState({ noteId: "n1", brandId: 1 });
    expect(state.contentDirectionMode).toBe(REMIX_CONTENT_MODES.SMART);
    expect(state.useTrendContext).toBe(false);
    expect(state.assetMode).toBe(REMIX_ASSET_MODES.NONE);
    expect(state.useBrandLogo).toBe(false);
    expect(state.productImageIds.length).toBe(0);
    expect(state.learningFocus.join(",")).toBe(DEFAULT_LEARNING_FOCUS.join(","));
    expect(state.noteId).toBe("n1");
    expect(state.brandId).toBe(1);
    // Legacy instanceId=9 / analysisRequestId=0 / directionsAutoTriggered=false:
    // request tokens are replaced by AbortSignal; the equivalent observable
    // contract is that nothing has started or auto-triggered on creation.
    expect(state.analysisStatus).toBe("idle");
    expect(state.directionsStatus).toBe("idle");
    expect(state.smartDirections.length).toBe(0);
  });

  it("input changes mark fusion stale", () => {
    const state = createExcellentRemixState({ noteId: "n1" });
    state.fusionPlan = { carouselPack: { slides: [{}, {}, {}, {}] } };
    state.fusionStatus = "ready";
    markFusionStale(state);
    expect(state.fusionStatus).toBe("stale");
  });

  it("content direction validation for three modes", () => {
    const state = createExcellentRemixState({ noteId: "n1" });
    expect(hasValidContentDirection(state)).toBe(false);
    state.smartDirections = [{ id: "structure_transfer", title: "t", contentThesis: "c" }];
    state.selectedSmartDirectionId = "structure_transfer";
    expect(hasValidContentDirection(state)).toBe(true);

    state.contentDirectionMode = REMIX_CONTENT_MODES.EXISTING_IDEA;
    expect(hasValidContentDirection(state)).toBe(false);
    state.selectedExistingIdea = { scope: "current", trendId: 1, ideaIndex: 0 };
    expect(hasValidContentDirection(state)).toBe(true);

    state.contentDirectionMode = REMIX_CONTENT_MODES.CUSTOM;
    state.customDirection = "短";
    expect(hasValidContentDirection(state)).toBe(false);
    state.customDirection = "这是一个足够长的自定义内容方向描述";
    expect(hasValidContentDirection(state)).toBe(true);
  });

  it("submit requires ready fusion plan with 4 slides", () => {
    const state = createExcellentRemixState({ noteId: "n1", brandId: 1 });
    state.analysisStatus = "degraded";
    state.smartDirections = [{ id: "theme_transfer" }];
    state.selectedSmartDirectionId = "theme_transfer";
    state.fusionStatus = "ready";
    state.fusionPlan = { carouselPack: { slides: [{}, {}, {}] } };
    expect(canSubmitExcellentRemix(state, true)).toBe(false);
    state.fusionPlan = { carouselPack: { slides: [{}, {}, {}, {}] } };
    expect(canSubmitExcellentRemix(state, true)).toBe(true);
  });

  it("asset flags default none and cap product images", () => {
    const state = createExcellentRemixState({ noteId: "n1" });
    let flags = resolveAssetFlags(state);
    expect(flags.useBrandLogo).toBe(false);
    expect(flags.productImageIds.length).toBe(0);
    state.assetMode = REMIX_ASSET_MODES.PRODUCT;
    state.productImageIds = [1, 2, 3, 4];
    expect(resolveAssetFlags(state).productImageIds.length).toBe(MAX_REMIX_PRODUCT_IMAGES);
    state.assetMode = REMIX_ASSET_MODES.NONE;
    state.useBrandLogo = true;
    state.productImageIds = [9];
    flags = resolveAssetFlags(state);
    expect(flags.useBrandLogo).toBe(false);
    expect(flags.productImageIds.length).toBe(0);
  });

  it("learning focus toggle and fusion request body includes taxonomy", () => {
    const focus = toggleLearningFocus(["structure"], "hook", true);
    expect(focus.join(",")).toBe("structure,hook");
    const state = createExcellentRemixState({
      noteId: "n1",
      brandId: 8,
      board: "ecommerce_hot",
      contentSource: "professional",
      categoryPath: "内容类目#母婴",
      industryPath: "",
    });
    state.learningFocus = focus;
    state.contentDirectionMode = REMIX_CONTENT_MODES.CUSTOM;
    state.customDirection = "自定义方向内容足够长";
    state.analysisId = "aid";
    const body = buildFusionRequestBody(state);
    expect(body.brandId).toBe(8);
    expect(body.contentMode).toBe("custom");
    expect(body.useTrendContext).toBe(false);
    expect(body.trendId).toBeNull();
    expect(body.customDirection).toBe("自定义方向内容足够长");
    expect(body.contentSource).toBe("professional");
    expect(body.categoryPath).toBe("内容类目#母婴");
  });

  it("existing idea search is flat and filters by text including snapshot names", () => {
    const ideas = [
      {
        ideaTitle: "转奶节奏",
        ideaSummary: "便便观察",
        trendTitle: "母婴热",
        audience: "妈妈",
        scene: "夜间",
        brandFit: "温和",
        scope: "current",
        analysisName: "",
      },
      {
        ideaTitle: "办公效率",
        ideaSummary: "表格",
        trendTitle: "职场",
        audience: "白领",
        scene: "工位",
        brandFit: "无",
        scope: "snapshot",
        analysisName: "三月复盘",
      },
    ];
    expect(filterExistingIdeas(ideas, "转奶").length).toBe(1);
    expect(filterExistingIdeas(ideas, "三月复盘").length).toBe(1);
  });

  it("existing idea key encodes scope and analysisId", () => {
    const key = buildExistingIdeaKey({ scope: "snapshot", analysisId: 9, trendId: 301, ideaIndex: 1 });
    expect(key).toBe("snapshot:9:301:1");
    const parsed = parseExistingIdeaKey(key);
    expect(parsed?.scope).toBe("snapshot");
    expect(parsed?.analysisId).toBe(9);
    expect(parsed?.trendId).toBe(301);
    expect(parsed?.ideaIndex).toBe(1);
    const state = createExcellentRemixState({ noteId: "n1" });
    state.contentDirectionMode = REMIX_CONTENT_MODES.EXISTING_IDEA;
    state.selectedExistingIdea = parsed;
    const ref = buildExistingIdeaRef(state);
    expect(ref?.scope).toBe("snapshot");
    expect(ref?.analysisId).toBe(9);
  });

  it("metadata_only defaults and platform visual detection", () => {
    const focus = defaultLearningFocusForAnalysis({ analysisMode: "metadata_only" });
    expect(focus.join(",")).toBe("structure,hook");
    expect(isPlatformDefaultVisual({ analysisMode: "metadata_only" })).toBe(true);
    expect(
      isPlatformDefaultVisual({
        analysisMode: "multimodal",
        meta: { multimodalUsed: true },
        visualLanguage: { source: "reference_image" },
      }),
    ).toBe(false);
  });

  it("excellent remix view module links without undefined exports", async () => {
    // Legacy: excellent-remix-view.js linked against excellent-remix-state.js
    // and exported render functions. New equivalent: the ExcellentView SFC
    // (which imports remixState) compiles and exports a mountable component,
    // and its template still renders the remix modal and brand product picker.
    const viewModule = await import("../views/ExcellentView.vue");
    expect(viewModule.default).toBeTruthy();
    expect(typeof viewModule.default).toBe("object");
    const viewSource = readFileSync(
            resolve(process.cwd(), "src/features/excellent/views/ExcellentView.vue"),
      "utf8",
    );
    expect(viewSource).toMatch(/remixOpen && remix/);
    expect(viewSource).toMatch(/productImageIds/);
  });
});
