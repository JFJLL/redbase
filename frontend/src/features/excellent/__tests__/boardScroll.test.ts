import { afterEach, describe, expect, it } from "vitest";
import {
  EXCELLENT_BOARD_SCROLL_PREFIX,
  restoreBoardScrollPosition,
  saveBoardScrollPosition,
} from "../boardScroll";

describe("board scroll position memory (per-board isolation)", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("round-trips a saved position per board", () => {
    saveBoardScrollPosition("xhs_hot", 320);
    expect(restoreBoardScrollPosition("xhs_hot")).toBe(320);
  });

  it("keeps boards isolated and ignores non-finite values", () => {
    saveBoardScrollPosition("xhs_hot", 120);
    saveBoardScrollPosition("ecommerce_hot", 999);
    expect(restoreBoardScrollPosition("xhs_hot")).toBe(120);
    expect(restoreBoardScrollPosition("ecommerce_hot")).toBe(999);

    saveBoardScrollPosition("xhs_hot", Number.NaN);
    expect(restoreBoardScrollPosition("xhs_hot")).toBe(120);
    sessionStorage.removeItem(`${EXCELLENT_BOARD_SCROLL_PREFIX}xhs_hot`);
    expect(restoreBoardScrollPosition("xhs_hot")).toBe(0);
  });
});
