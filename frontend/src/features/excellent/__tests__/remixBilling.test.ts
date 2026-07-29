import { describe, expect, it } from "vitest";
import {
  buildDirectionsBillingAttemptKey,
  buildFusionBillingAttemptKey,
  createExcellentRemixState,
  directionsButtonLabel,
  fusionButtonLabel,
  makeRemixBillingRequestId,
  resolveRemixBillingAttempt,
  shouldResetRemixBillingAttempt,
  shouldWarnNextDirectionCharge,
} from "../remixState";

function stateWithDirections() {
  const state = createExcellentRemixState({ noteId: "n1", brandId: 7 });
  state.smartDirections = [{ id: "d1", title: "方向一" }];
  state.directionsStatus = "ready";
  return state;
}

describe("remix billing UI helpers", () => {
  it("labels the directions button by billing state without extra confirm dialogs", () => {
    expect(directionsButtonLabel(null)).toBe("生成内容方向");
    expect(directionsButtonLabel(createExcellentRemixState({}))).toBe("生成内容方向");

    const loading = createExcellentRemixState({});
    loading.directionsStatus = "loading";
    expect(directionsButtonLabel(loading)).toBe("生成中…");

    // 已有方向但仍免费：普通的重新生成文案。
    const freeRegen = stateWithDirections();
    freeRegen.directionsBilling = { nextChargeable: false, charged: false };
    expect(directionsButtonLabel(freeRegen)).toBe("重新生成内容方向");

    // 收费状态：按钮直接标价。
    const charged = stateWithDirections();
    charged.directionsBilling = { nextChargeable: true };
    expect(directionsButtonLabel(charged)).toBe("重新生成内容方向（1积分）");
  });

  it("always prices the fusion button", () => {
    expect(fusionButtonLabel(null)).toBe("生成融合方案（1积分）");
    const loading = createExcellentRemixState({});
    loading.fusionStatus = "loading";
    expect(fusionButtonLabel(loading)).toBe("生成中…");
    const ready = createExcellentRemixState({});
    ready.fusionStatus = "ready";
    expect(fusionButtonLabel(ready)).toBe("生成融合方案（1积分）");
  });

  it("warns only after the 3rd free model success — never on cache, replay or charged results", () => {
    expect(shouldWarnNextDirectionCharge(null)).toBe(false);
    expect(shouldWarnNextDirectionCharge({ nextChargeable: true, charged: false })).toBe(true);
    // 收费成功不再提示“将消耗”。
    expect(shouldWarnNextDirectionCharge({ nextChargeable: true, charged: true })).toBe(false);
    // 缓存返回不得出现任何扣费相关提示。
    expect(shouldWarnNextDirectionCharge({ nextChargeable: true, charged: false, cacheHit: true })).toBe(false);
    expect(shouldWarnNextDirectionCharge({ nextChargeable: true, charged: false, replayed: true })).toBe(false);
    expect(shouldWarnNextDirectionCharge({ nextChargeable: false, charged: false })).toBe(false);
  });

  it("generates server-acceptable unique requestIds", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const id = makeRemixBillingRequestId();
      expect(id).toMatch(/^[a-zA-Z0-9_-]{8,100}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(20);
  });

  it("builds stable direction attempt keys from every billing-relevant input", () => {
    const makeState = () => createExcellentRemixState({
      noteId: "n1",
      board: "xhs_hot",
      brandId: 7,
      learningFocus: ["visual", "hook"],
      contentSource: "buyer",
      categoryPath: "小红书#美妆",
      industryPath: "行业#护肤",
    });
    const state = makeState();
    state.analysisId = "analysis-1";
    const base = buildDirectionsBillingAttemptKey(state);
    state.learningFocus = ["hook", "visual"];
    expect(buildDirectionsBillingAttemptKey(state)).toBe(base);
    state.directionsStatus = "error";
    state.directionsError = "network";
    state.directionsBilling = { charged: true, credits: 1 };
    expect(buildDirectionsBillingAttemptKey(state)).toBe(base);

    for (const mutate of [
      (candidate: ReturnType<typeof makeState>) => { candidate.noteId = "n2"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.board = "ecommerce_hot"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.brandId = 8; },
      (candidate: ReturnType<typeof makeState>) => { candidate.analysisId = "analysis-2"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.learningFocus = ["hook"]; },
      (candidate: ReturnType<typeof makeState>) => { candidate.contentSource = "creator"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.categoryPath = "小红书#母婴"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.industryPath = "行业#母婴"; },
    ]) {
      const candidate = makeState();
      candidate.analysisId = "analysis-1";
      mutate(candidate);
      expect(buildDirectionsBillingAttemptKey(candidate)).not.toBe(base);
    }
  });

  it("changes fusion attempt keys for effective direction inputs but not object property order", () => {
    const makeState = () => createExcellentRemixState({
      noteId: "n1",
      board: "xhs_hot",
      brandId: 7,
      learningFocus: ["visual", "hook"],
      contentSource: "buyer",
      categoryPath: "小红书#美妆",
      industryPath: "行业#护肤",
    });
    const state = makeState();
    state.analysisId = "analysis-1";
    state.smartDirections = [{ id: "d1", title: "方向一", summary: "摘要", nested: { b: 2, a: 1 } }];
    state.selectedSmartDirectionId = "d1";
    const base = buildFusionBillingAttemptKey(state);
    state.smartDirections = [{ id: "d1", title: "方向一", summary: "摘要", nested: { a: 1, b: 2 } }];
    expect(buildFusionBillingAttemptKey(state)).toBe(base);

    state.smartDirections[0].title = "方向二";
    expect(buildFusionBillingAttemptKey(state)).not.toBe(base);

    for (const mutate of [
      (candidate: ReturnType<typeof makeState>) => { candidate.noteId = "n2"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.board = "ecommerce_hot"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.brandId = 8; },
      (candidate: ReturnType<typeof makeState>) => { candidate.analysisId = "analysis-2"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.learningFocus = ["hook"]; },
      (candidate: ReturnType<typeof makeState>) => { candidate.contentSource = "creator"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.categoryPath = "小红书#母婴"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.industryPath = "行业#母婴"; },
      (candidate: ReturnType<typeof makeState>) => { candidate.useTrendContext = true; },
      (candidate: ReturnType<typeof makeState>) => {
        candidate.contentDirectionMode = "custom";
        candidate.customDirection = "新的自定义内容方向";
      },
      (candidate: ReturnType<typeof makeState>) => {
        candidate.contentDirectionMode = "existing_idea";
        candidate.selectedExistingIdea = { scope: "snapshot", analysisId: 9, trendId: 8, ideaIndex: 1 };
      },
    ]) {
      const candidate = makeState();
      candidate.analysisId = "analysis-1";
      candidate.smartDirections = [{ id: "d1", title: "方向一", summary: "摘要", nested: { b: 2, a: 1 } }];
      candidate.selectedSmartDirectionId = "d1";
      mutate(candidate);
      expect(buildFusionBillingAttemptKey(candidate)).not.toBe(base);
    }
  });

  it("reuses one attempt for technical retries and creates a new one for changed input", () => {
    const ids = ["request-A", "request-B"];
    const factory = () => ids.shift() || "request-C";
    const first = resolveRemixBillingAttempt(null, "input-1", true, factory);
    const retry = resolveRemixBillingAttempt(first, "input-1", false, factory);
    expect(retry).toBe(first);
    expect(retry.requestId).toBe("request-A");
    expect(retry.forceRegenerate).toBe(true);

    const changed = resolveRemixBillingAttempt(first, "input-2", false, factory);
    expect(changed.requestId).toBe("request-B");
    expect(changed.forceRegenerate).toBe(false);
  });

  it("resets only terminal request-id states so a corrupt replay can self-heal", () => {
    expect(shouldResetRemixBillingAttempt("REQUEST_ID_CONFLICT")).toBe(true);
    expect(shouldResetRemixBillingAttempt("REPLAY_RESULT_MISSING")).toBe(true);
    expect(shouldResetRemixBillingAttempt("REQUEST_IN_PROGRESS")).toBe(false);
    expect(shouldResetRemixBillingAttempt("NETWORK_ERROR")).toBe(false);
  });
});
