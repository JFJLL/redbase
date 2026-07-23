const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/excellent-remix-state.js"), "utf8");
const sandbox = { module: { exports: {} }, exports: {} };
const transformed = source
  .replace(/export const /g, "const ")
  .replace(/export function /g, "function ")
  .concat(
    `\nmodule.exports = {
  createExcellentRemixState,
  REMIX_CONTENT_MODES,
  REMIX_ASSET_MODES,
  toggleLearningFocus,
  markFusionStale,
  hasValidContentDirection,
  canSubmitExcellentRemix,
  resolveAssetFlags,
  buildFusionRequestBody,
  filterExistingIdeas,
  buildExistingIdeaKey,
  parseExistingIdeaKey,
  buildExistingIdeaRef,
  defaultLearningFocusForAnalysis,
  isPlatformDefaultVisual,
  MAX_REMIX_PRODUCT_IMAGES,
  DEFAULT_LEARNING_FOCUS,
  MIN_CUSTOM_DIRECTION_CHARS,
  MAX_CUSTOM_DIRECTION_CHARS,
};\n`,
  );
vm.runInNewContext(transformed, { module: sandbox.module, exports: sandbox.exports });
const {
  createExcellentRemixState,
  REMIX_CONTENT_MODES,
  REMIX_ASSET_MODES,
  toggleLearningFocus,
  markFusionStale,
  hasValidContentDirection,
  canSubmitExcellentRemix,
  resolveAssetFlags,
  buildFusionRequestBody,
  filterExistingIdeas,
  buildExistingIdeaKey,
  parseExistingIdeaKey,
  buildExistingIdeaRef,
  defaultLearningFocusForAnalysis,
  isPlatformDefaultVisual,
  MAX_REMIX_PRODUCT_IMAGES,
  DEFAULT_LEARNING_FOCUS,
} = sandbox.module.exports;

test("default remix state: smart mode, no trend, no assets, structure+hook focus", () => {
  const state = createExcellentRemixState({ noteId: "n1", brandId: 1, instanceId: 9 });
  assert.equal(state.contentDirectionMode, REMIX_CONTENT_MODES.SMART);
  assert.equal(state.useTrendContext, false);
  assert.equal(state.assetMode, REMIX_ASSET_MODES.NONE);
  assert.equal(state.useBrandLogo, false);
  assert.equal(state.productImageIds.length, 0);
  assert.equal(state.learningFocus.join(","), DEFAULT_LEARNING_FOCUS.join(","));
  assert.equal(state.instanceId, 9);
  assert.equal(state.analysisRequestId, 0);
  assert.equal(state.directionsAutoTriggered, false);
});

test("input changes mark fusion stale", () => {
  const state = createExcellentRemixState({ noteId: "n1" });
  state.fusionPlan = { carouselPack: { slides: [1, 2, 3, 4] } };
  state.fusionStatus = "ready";
  const next = markFusionStale(state);
  assert.equal(next.fusionStatus, "stale");
});

test("content direction validation for three modes", () => {
  const state = createExcellentRemixState({ noteId: "n1" });
  assert.equal(hasValidContentDirection(state), false);
  state.smartDirections = [{ id: "structure_transfer", title: "t", contentThesis: "c" }];
  state.selectedSmartDirectionId = "structure_transfer";
  assert.equal(hasValidContentDirection(state), true);

  state.contentDirectionMode = REMIX_CONTENT_MODES.EXISTING_IDEA;
  assert.equal(hasValidContentDirection(state), false);
  state.selectedExistingIdea = { scope: "current", trendId: 1, ideaIndex: 0 };
  assert.equal(hasValidContentDirection(state), true);

  state.contentDirectionMode = REMIX_CONTENT_MODES.CUSTOM;
  state.customDirection = "短";
  assert.equal(hasValidContentDirection(state), false);
  state.customDirection = "这是一个足够长的自定义内容方向描述";
  assert.equal(hasValidContentDirection(state), true);
});

test("submit requires ready fusion plan with 4 slides", () => {
  const state = createExcellentRemixState({ noteId: "n1", brandId: 1 });
  state.analysisStatus = "degraded";
  state.smartDirections = [{ id: "theme_transfer" }];
  state.selectedSmartDirectionId = "theme_transfer";
  state.fusionStatus = "ready";
  state.fusionPlan = { carouselPack: { slides: [1, 2, 3] } };
  assert.equal(canSubmitExcellentRemix(state, true), false);
  state.fusionPlan = { carouselPack: { slides: [1, 2, 3, 4] } };
  assert.equal(canSubmitExcellentRemix(state, true), true);
});

test("asset flags default none and cap product images", () => {
  const state = createExcellentRemixState({ noteId: "n1" });
  let flags = resolveAssetFlags(state);
  assert.equal(flags.useBrandLogo, false);
  assert.equal(flags.productImageIds.length, 0);
  state.assetMode = REMIX_ASSET_MODES.PRODUCT;
  state.productImageIds = [1, 2, 3, 4];
  assert.equal(resolveAssetFlags(state).productImageIds.length, MAX_REMIX_PRODUCT_IMAGES);
  state.assetMode = REMIX_ASSET_MODES.NONE;
  state.useBrandLogo = true;
  state.productImageIds = [9];
  flags = resolveAssetFlags(state);
  assert.equal(flags.useBrandLogo, false);
  assert.equal(flags.productImageIds.length, 0);
});

test("learning focus toggle and fusion request body includes taxonomy", () => {
  const focus = toggleLearningFocus(["structure"], "hook", true);
  assert.equal(focus.join(","), "structure,hook");
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
  assert.equal(body.brandId, 8);
  assert.equal(body.contentMode, "custom");
  assert.equal(body.useTrendContext, false);
  assert.equal(body.trendId, null);
  assert.equal(body.customDirection, "自定义方向内容足够长");
  assert.equal(body.contentSource, "professional");
  assert.equal(body.categoryPath, "内容类目#母婴");
});

test("existing idea search is flat and filters by text including snapshot names", () => {
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
  assert.equal(filterExistingIdeas(ideas, "转奶").length, 1);
  assert.equal(filterExistingIdeas(ideas, "三月复盘").length, 1);
});

test("existing idea key encodes scope and analysisId", () => {
  const key = buildExistingIdeaKey({ scope: "snapshot", analysisId: 9, trendId: 301, ideaIndex: 1 });
  assert.equal(key, "snapshot:9:301:1");
  const parsed = parseExistingIdeaKey(key);
  assert.equal(parsed.scope, "snapshot");
  assert.equal(parsed.analysisId, 9);
  assert.equal(parsed.trendId, 301);
  assert.equal(parsed.ideaIndex, 1);
  const state = createExcellentRemixState({ noteId: "n1" });
  state.contentDirectionMode = REMIX_CONTENT_MODES.EXISTING_IDEA;
  state.selectedExistingIdea = parsed;
  const ref = buildExistingIdeaRef(state);
  assert.equal(ref.scope, "snapshot");
  assert.equal(ref.analysisId, 9);
});

test("metadata_only defaults and platform visual detection", () => {
  const focus = defaultLearningFocusForAnalysis({ analysisMode: "metadata_only" });
  assert.equal(focus.join(","), "structure,hook");
  assert.equal(isPlatformDefaultVisual({ analysisMode: "metadata_only" }), true);
  assert.equal(
    isPlatformDefaultVisual({
      analysisMode: "multimodal",
      meta: { multimodalUsed: true },
      visualLanguage: { source: "reference_image" },
    }),
    false,
  );
});
