/**
 * Migrated 1:1 from tests/excellent-image-nav.test.js (legacy
 * public/js/excellent-image-nav.js, now frontend/src/features/excellent/imageNav.ts).
 * Assertions are kept verbatim.
 */
import { describe, expect, it } from "vitest";
import {
  canGoNext,
  canGoPrevious,
  clampImageIndex,
  getNextImageIndex,
  getPreviousImageIndex,
} from "../imageNav";

describe("excellent image nav (legacy contract)", () => {
  it("clampImageIndex handles empty and out-of-range", () => {
    expect(clampImageIndex(3, 0)).toBe(0);
    expect(clampImageIndex(-1, 5)).toBe(0);
    expect(clampImageIndex(99, 5)).toBe(4);
    expect(clampImageIndex(2, 5)).toBe(2);
  });

  it("previous stays at first image", () => {
    expect(getPreviousImageIndex(0, 8)).toBe(0);
    expect(canGoPrevious(0, 8)).toBe(false);
    expect(getPreviousImageIndex(3, 8)).toBe(2);
    expect(canGoPrevious(3, 8)).toBe(true);
  });

  it("next stays at last image", () => {
    expect(getNextImageIndex(7, 8)).toBe(7);
    expect(canGoNext(7, 8)).toBe(false);
    expect(getNextImageIndex(3, 8)).toBe(4);
    expect(canGoNext(3, 8)).toBe(true);
  });

  it("empty image array does not throw", () => {
    expect(getPreviousImageIndex(0, 0)).toBe(0);
    expect(getNextImageIndex(0, 0)).toBe(0);
    expect(canGoPrevious(0, 0)).toBe(false);
    expect(canGoNext(0, 0)).toBe(false);
  });
});
