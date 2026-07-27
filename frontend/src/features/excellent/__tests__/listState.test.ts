import { describe, expect, it } from "vitest";
import {
  applyExcellentListError,
  applyExcellentListResult,
  applyExcellentRefreshError,
  applyExcellentRefreshResult,
  commitExcellentDraftFilters,
  createExcellentBoardSlice,
  excellentContentCacheKey,
  excellentFiltersAreDirty,
  excellentRefreshResponseMatches,
  rollbackExcellentDraftFilters,
} from "../listState";

describe("excellent list state", () => {
  it("detects dirty draft filters per board", () => {
    const slice = createExcellentBoardSlice();
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(false);

    slice.draftContentSource = "buyer";
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(true);

    slice.draftContentSource = "all";
    slice.draftCategoryPath = "小红书#美妆";
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(true);
    // Category drafts do not affect the ecommerce board.
    expect(excellentFiltersAreDirty(slice, "ecommerce_hot")).toBe(false);

    slice.draftIndustryPath = "行业#美妆";
    expect(excellentFiltersAreDirty(slice, "ecommerce_hot")).toBe(true);
  });

  it("commits and rolls back draft filters", () => {
    const slice = createExcellentBoardSlice();
    commitExcellentDraftFilters(slice, "xhs_hot", { contentSource: "buyer", categoryPath: "小红书#美妆" });
    expect(slice.contentSource).toBe("buyer");
    expect(slice.categoryPath).toBe("小红书#美妆");
    expect(slice.draftCategoryPath).toBe("小红书#美妆");

    slice.draftContentSource = "all";
    slice.draftCategoryPath = "";
    rollbackExcellentDraftFilters(slice, "xhs_hot");
    expect(slice.draftContentSource).toBe("buyer");
    expect(slice.draftCategoryPath).toBe("小红书#美妆");
  });

  it("validates refresh responses against the request snapshot", () => {
    const filters = { board: "xhs_hot", contentSource: "all", categoryPath: "小红书#美妆" };
    expect(
      excellentRefreshResponseMatches({ board: "xhs_hot", contentSource: "all", categoryPath: "小红书#美妆" }, filters),
    ).toBe(true);
    expect(
      excellentRefreshResponseMatches({ board: "xhs_hot", contentSource: "all", categoryPath: "" }, filters),
    ).toBe(false);
    expect(excellentRefreshResponseMatches(null, filters)).toBe(false);
  });

  it("ignores stale responses via requestId gating", () => {
    const slice = createExcellentBoardSlice();
    slice.requestId = 2;
    const stale = applyExcellentListResult({ slice, requestId: 1, result: { items: [{ noteId: "n1" }] } });
    expect(stale.applied).toBe(false);
    expect(slice.items).toHaveLength(0);
  });

  it("keeps old items and sets the exact refresh error copy", () => {
    const slice = createExcellentBoardSlice();
    slice.requestId = 1;
    applyExcellentRefreshResult({
      slice,
      requestId: 1,
      result: { items: [{ noteId: "n1" }], updatedAt: "2026-07-01T00:00:00.000Z" },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(slice.status).toBe("ready");
    expect(slice.stale).toBe(false);

    applyExcellentRefreshError({
      slice,
      requestId: 1,
      error: new Error("优秀内容暂时无法更新，请稍后重试。"),
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(slice.items).toHaveLength(1);
    expect(slice.status).toBe("ready");
    expect(slice.refreshError).toBe("更新失败，当前仍展示上一次保存的数据。");
  });

  it("surfaces backend error text verbatim when there is no cache", () => {
    const slice = createExcellentBoardSlice();
    slice.requestId = 1;
    applyExcellentListError({
      slice,
      requestId: 1,
      error: new Error("优秀内容暂时不可用，请稍后重试。"),
      preserveItems: true,
      hadItems: false,
    });
    expect(slice.status).toBe("error");
    expect(slice.error).toBe("优秀内容暂时不可用，请稍后重试。");
  });

  it("builds stable cache keys", () => {
    expect(excellentContentCacheKey("xhs_hot", "all", "小红书#美妆")).toBe("xhs_hot::all::小红书#美妆");
    expect(excellentContentCacheKey(undefined, undefined, undefined)).toBe("xhs_hot::all::");
  });
});
