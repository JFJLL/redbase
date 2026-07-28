import { describe, expect, it } from "vitest";
import {
  createExcellentRemixState,
  directionsButtonLabel,
  fusionButtonLabel,
  makeRemixBillingRequestId,
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
});
