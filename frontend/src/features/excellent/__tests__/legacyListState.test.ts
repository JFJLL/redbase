/**
 * Migrated 1:1 from tests/excellent-list-state.test.js (legacy
 * public/js/excellent-list-state.js, now frontend/src/features/excellent/listState.ts).
 *
 * Mapping notes:
 * - The legacy sessionEpoch/loadEpoch parameters were removed from the pure
 *   apply* helpers: cross-session staleness is now cancelled upstream through
 *   AbortSignal scopes (useAbortScope + notifyAuthReset). The legacy
 *   "session epoch mismatch does not write slice" case is therefore asserted
 *   through an aborted request that can never reach the apply helpers, plus
 *   the unchanged requestId gate.
 * - The legacy "app.js filter change handlers only mutate draft and never
 *   auto-load" DOM-wiring case is asserted against views/ExcellentView.vue.
 * - "server startup does not auto-warm excellent content boards" stayed in
 *   tests/excellent-list-state.test.js (it only reads src/server + scripts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectScope } from "vue";
import { notifyAuthReset, useAbortScope } from "@/shared/composables/useAbortScope";
import { isAbortError } from "@/shared/api/client";
import { fetchExcellentContents } from "../api";
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
  shouldApplyExcellentListResult,
  type ExcellentBoardSlice,
} from "../listState";

function makeSlice(overrides: Partial<ExcellentBoardSlice> = {}): ExcellentBoardSlice {
  return {
    ...createExcellentBoardSlice(),
    status: "loading",
    requestId: 1,
    ...overrides,
  };
}

const viewSource = readFileSync(
    resolve(process.cwd(), "src/features/excellent/views/ExcellentView.vue"),
  "utf8",
);

describe("excellent list state (legacy contract)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("xhs result still writes xhs slice after switch to ecommerce", () => {
    const xhsSlice = makeSlice({ requestId: 3, status: "loading" });
    const ecomSlice = makeSlice({
      requestId: 1,
      status: "ready",
      items: [{ noteId: "ecom-1" }],
    });

    const applied = applyExcellentListResult({
      slice: xhsSlice,
      requestId: 3,
      result: {
        items: [{ noteId: "xhs-1" }, { noteId: "xhs-2" }],
        updatedAt: "2026-07-23T00:00:00.000Z",
        stale: false,
      },
      activeBoard: "ecommerce_hot",
      requestBoard: "xhs_hot",
    });

    expect(applied.applied).toBe(true);
    expect(applied.isActive).toBe(false);
    expect(xhsSlice.status).toBe("ready");
    expect(xhsSlice.items.length).toBe(2);
    expect(xhsSlice.items[0].noteId).toBe("xhs-1");
    // ecommerce UI slice must not be touched by xhs result
    expect(ecomSlice.items[0].noteId).toBe("ecom-1");
    expect(ecomSlice.status).toBe("ready");
  });

  it("stale requestId does not overwrite newer board request", () => {
    const slice = makeSlice({ requestId: 5, status: "loading", items: [{ noteId: "new" }] });
    const applied = applyExcellentListResult({
      slice,
      requestId: 4,
      result: { items: [{ noteId: "old" }], updatedAt: "t", stale: false },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(applied.applied).toBe(false);
    expect(slice.items[0].noteId).toBe("new");
    expect(slice.status).toBe("loading");
  });

  it("session switch (epoch mismatch equivalent) does not write slice", async () => {
    // Legacy: sessionEpoch !== loadEpoch made apply* a no-op. New equivalent:
    // the account switch aborts the in-flight board request via
    // notifyAuthReset, so the apply helper is never reached and the slice
    // stays untouched.
    const slice = makeSlice({ requestId: 2, status: "loading" });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const scope = effectScope();
    const abortScope = scope.run(() => useAbortScope());
    if (!abortScope) throw new Error("failed to create abort scope");
    const pending = fetchExcellentContents(
      { board: "xhs_hot", contentSource: "all" },
      abortScope.signalFor("board-xhs_hot"),
    ).then((result) =>
      applyExcellentListResult({
        slice,
        requestId: 2,
        result,
        activeBoard: "xhs_hot",
        requestBoard: "xhs_hot",
      }),
    );

    notifyAuthReset();
    const error = await pending.catch((err: unknown) => err);
    expect(isAbortError(error)).toBe(true);
    expect(slice.status).toBe("loading");
    expect(slice.items.length).toBe(0);
    scope.stop();
  });

  it("error clears loading so board never stays loading forever", () => {
    const slice = makeSlice({ requestId: 2, status: "loading" });
    const applied = applyExcellentListError({
      slice,
      requestId: 2,
      error: new Error("network"),
      preserveItems: false,
      hadItems: false,
      activeBoard: "ecommerce_hot",
      requestBoard: "xhs_hot",
    });
    expect(applied.applied).toBe(true);
    expect(applied.isActive).toBe(false);
    expect(slice.status).toBe("error");
    expect(slice.error).toMatch(/network|失败/);
  });

  it("error with preserveItems keeps ready items", () => {
    const slice = makeSlice({
      requestId: 2,
      status: "loading",
      items: [{ noteId: "cached" }],
    });
    const applied = applyExcellentListError({
      slice,
      requestId: 2,
      error: new Error("down"),
      preserveItems: true,
      hadItems: true,
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(applied.applied).toBe(true);
    expect(applied.isActive).toBe(true);
    expect(slice.status).toBe("ready");
    expect(slice.items[0].noteId).toBe("cached");
  });

  it("refresh result replaces items; refresh error keeps old items", () => {
    const slice = makeSlice({
      requestId: 3,
      status: "ready",
      items: [{ noteId: "old" }],
      refreshing: true,
    });
    const ok = applyExcellentRefreshResult({
      slice,
      requestId: 3,
      result: {
        items: [{ noteId: "new" }],
        updatedAt: "2026-07-23T12:00:00.000Z",
        hasCache: true,
      },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(ok.applied).toBe(true);
    expect(slice.items[0].noteId).toBe("new");
    expect(slice.refreshing).toBe(false);
    expect(slice.refreshError).toBe("");

    slice.requestId = 4;
    slice.refreshing = true;
    slice.items = [{ noteId: "keep" }];
    const failed = applyExcellentRefreshError({
      slice,
      requestId: 4,
      error: new Error("down"),
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(failed.applied).toBe(true);
    expect(slice.items[0].noteId).toBe("keep");
    expect(slice.refreshing).toBe(false);
    expect(slice.refreshError).toMatch(/更新失败/);
  });

  it("list empty result marks needsUpdate", () => {
    const slice = makeSlice({ requestId: 1, status: "loading" });
    applyExcellentListResult({
      slice,
      requestId: 1,
      result: { items: [], hasCache: false, needsUpdate: true, updatedAt: "" },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(slice.status).toBe("empty");
    expect(slice.hasCache).toBe(false);
    expect(slice.needsUpdate).toBe(true);
    expect(slice.items.length).toBe(0);
  });

  it("shouldApplyExcellentListResult gates requestId (epoch gate replaced by AbortSignal)", () => {
    expect(shouldApplyExcellentListResult(1, 1)).toBe(true);
    expect(shouldApplyExcellentListResult(1, 2)).toBe(false);
  });

  it("excellentContentCacheKey isolates board source and taxonomy", () => {
    expect(excellentContentCacheKey("xhs_hot", "professional", "内容类目#美妆")).toBe(
      "xhs_hot::professional::内容类目#美妆",
    );
    expect(excellentContentCacheKey("xhs_hot", "all", "")).not.toBe(
      excellentContentCacheKey("ecommerce_hot", "all", ""),
    );
  });

  it("later filter result overwrites earlier filter for same board", () => {
    const slice = makeSlice({ requestId: 10, status: "loading" });
    applyExcellentListResult({
      slice,
      requestId: 10,
      result: { items: [{ noteId: "final-filter" }], updatedAt: "t2", stale: false },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    expect(slice.items[0].noteId).toBe("final-filter");
    expect(slice.status).toBe("ready");
  });

  it("category change only dirties draftCategoryPath", () => {
    const slice = makeSlice({
      items: [{ noteId: "keep-1" }],
      categoryPath: "",
      contentSource: "all",
      draftCategoryPath: "",
      draftContentSource: "all",
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    // Simulate taxonomy change handler: only draftCategoryPath mutates.
    slice.draftCategoryPath = "内容类目#美妆";
    expect(slice.categoryPath).toBe("");
    expect(slice.contentSource).toBe("all");
    expect(slice.draftContentSource).toBe("all");
    expect(slice.items[0].noteId).toBe("keep-1");
    expect(slice.updatedAt).toBe("2026-07-23T00:00:00.000Z");
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(true);
  });

  it("industry change only dirties draftIndustryPath", () => {
    const slice = makeSlice({
      items: [{ noteId: "ecom-keep" }],
      industryPath: "",
      contentSource: "all",
      draftIndustryPath: "",
      draftContentSource: "all",
    });
    slice.draftIndustryPath = "所属行业#美妆";
    expect(slice.industryPath).toBe("");
    expect(slice.contentSource).toBe("all");
    expect(slice.items[0].noteId).toBe("ecom-keep");
    expect(excellentFiltersAreDirty(slice, "ecommerce_hot")).toBe(true);
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(false);
  });

  it("content source change only dirties draftContentSource", () => {
    const slice = makeSlice({
      items: [{ noteId: "a" }],
      contentSource: "all",
      draftContentSource: "all",
      categoryPath: "内容类目#美妆",
      draftCategoryPath: "内容类目#美妆",
    });
    slice.draftContentSource = "professional";
    expect(slice.contentSource).toBe("all");
    expect(slice.categoryPath).toBe("内容类目#美妆");
    expect(slice.draftCategoryPath).toBe("内容类目#美妆");
    expect(slice.items.length).toBe(1);
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(true);
  });

  it("draft filter changes do not clear items or formal filters", () => {
    const slice = makeSlice({
      items: Array.from({ length: 8 }, (_, i) => ({ noteId: `n${i}` })),
      categoryPath: "",
      contentSource: "all",
      draftCategoryPath: "",
      draftContentSource: "all",
      updatedAt: "t0",
      status: "ready",
    });
    slice.draftCategoryPath = "内容类目#穿搭";
    slice.draftContentSource = "kol";
    expect(slice.items.length).toBe(8);
    expect(slice.categoryPath).toBe("");
    expect(slice.contentSource).toBe("all");
    expect(slice.updatedAt).toBe("t0");
    expect(slice.status).toBe("ready");
  });

  it("commitExcellentDraftFilters promotes draft to formal on success", () => {
    const slice = makeSlice({
      items: [{ noteId: "old" }],
      categoryPath: "",
      contentSource: "all",
      draftCategoryPath: "内容类目#美妆",
      draftContentSource: "professional",
    });
    const requestFilters = {
      board: "xhs_hot",
      categoryPath: "内容类目#美妆",
      industryPath: "",
      contentSource: "professional",
    };
    applyExcellentRefreshResult({
      slice,
      requestId: 1,
      result: {
        items: Array.from({ length: 8 }, (_, i) => ({ noteId: `new-${i}` })),
        updatedAt: "2026-07-23T12:00:00.000Z",
        hasCache: true,
      },
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    commitExcellentDraftFilters(slice, "xhs_hot", requestFilters);
    expect(slice.categoryPath).toBe("内容类目#美妆");
    expect(slice.contentSource).toBe("professional");
    expect(slice.draftCategoryPath).toBe("内容类目#美妆");
    expect(slice.draftContentSource).toBe("professional");
    expect(slice.items.length).toBe(8);
    expect(slice.items[0].noteId).toBe("new-0");
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(false);
  });

  it("refresh failure keeps old items and formal filters; rolls draft back", () => {
    const slice = makeSlice({
      requestId: 2,
      status: "ready",
      items: [{ noteId: "old-1" }, { noteId: "old-2" }],
      categoryPath: "",
      contentSource: "all",
      draftCategoryPath: "内容类目#美妆",
      draftContentSource: "kol",
      updatedAt: "2026-07-20T00:00:00.000Z",
      refreshing: true,
    });
    applyExcellentRefreshError({
      slice,
      requestId: 2,
      error: new Error("pgy down"),
      activeBoard: "xhs_hot",
      requestBoard: "xhs_hot",
    });
    rollbackExcellentDraftFilters(slice, "xhs_hot");
    expect(slice.items[0].noteId).toBe("old-1");
    expect(slice.items.length).toBe(2);
    expect(slice.categoryPath).toBe("");
    expect(slice.contentSource).toBe("all");
    expect(slice.updatedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(slice.draftCategoryPath).toBe("");
    expect(slice.draftContentSource).toBe("all");
    expect(slice.refreshError).toMatch(/更新失败，当前仍展示上一次保存的数据/);
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(false);
  });

  it("ecommerce refresh commit and rollback use industry draft fields", () => {
    const slice = makeSlice({
      industryPath: "所属行业#数码",
      contentSource: "all",
      draftIndustryPath: "所属行业#美妆",
      draftContentSource: "buyer",
      items: [{ noteId: "e1" }],
    });
    expect(excellentFiltersAreDirty(slice, "ecommerce_hot")).toBe(true);
    commitExcellentDraftFilters(slice, "ecommerce_hot", {
      board: "ecommerce_hot",
      industryPath: "所属行业#美妆",
      contentSource: "buyer",
    });
    expect(slice.industryPath).toBe("所属行业#美妆");
    expect(slice.draftIndustryPath).toBe("所属行业#美妆");
    expect(slice.contentSource).toBe("buyer");
    expect(slice.draftContentSource).toBe("buyer");
    expect(excellentFiltersAreDirty(slice, "ecommerce_hot")).toBe(false);

    slice.draftIndustryPath = "所属行业#其他";
    rollbackExcellentDraftFilters(slice, "ecommerce_hot");
    expect(slice.draftIndustryPath).toBe("所属行业#美妆");
    expect(slice.industryPath).toBe("所属行业#美妆");
  });

  it("excellentRefreshResponseMatches requires board source and taxonomy", () => {
    const filters = {
      board: "xhs_hot",
      contentSource: "all",
      categoryPath: "内容类目#美妆",
      industryPath: "",
    };
    expect(
      excellentRefreshResponseMatches(
        { board: "xhs_hot", contentSource: "all", categoryPath: "内容类目#美妆", industryPath: "" },
        filters,
      ),
    ).toBe(true);
    expect(
      excellentRefreshResponseMatches(
        { board: "ecommerce_hot", contentSource: "all", categoryPath: "内容类目#美妆" },
        filters,
      ),
    ).toBe(false);
    expect(
      excellentRefreshResponseMatches(
        { board: "xhs_hot", contentSource: "kol", categoryPath: "内容类目#美妆" },
        filters,
      ),
    ).toBe(false);
    expect(
      excellentRefreshResponseMatches(
        { board: "xhs_hot", contentSource: "all", categoryPath: "" },
        filters,
      ),
    ).toBe(false);
  });

  it("filters dirty detection is false when draft equals formal", () => {
    const slice = makeSlice({
      categoryPath: "内容类目#美妆",
      contentSource: "professional",
      draftCategoryPath: "内容类目#美妆",
      draftContentSource: "professional",
    });
    expect(excellentFiltersAreDirty(slice, "xhs_hot")).toBe(false);
  });

  it("view filter change handlers only mutate draft and never auto-load", () => {
    // Legacy asserted the app.js change handlers; the Vue equivalent is that
    // the three filter <select> elements bind draft fields via v-model only
    // (no @change / no load call) and refresh uses the immutable snapshot.
    expect(viewSource.includes("applyExcellentFiltersAndLoad")).toBe(false);
    for (const [model, testId] of [
      ["slice.draftContentSource", "filter-source"],
      ["slice.draftCategoryPath", "filter-category"],
      ["slice.draftIndustryPath", "filter-industry"],
    ]) {
      const tagMatch = viewSource.match(new RegExp(`<CustomSelect[^>]*test-id="${testId}"[^>]*/>`));
      expect(tagMatch, `select ${testId} must exist`).not.toBeNull();
      const tag = tagMatch?.[0] ?? "";
      expect(tag.includes(`v-model="${model}"`)).toBe(true);
      // change handlers must not call list/load/refresh
      expect(tag.includes("@")).toBe(false);
    }
    // refresh uses draft snapshot and commits/rolls back explicitly
    expect(viewSource).toMatch(/const requestFilters = draftFilters\(board\)/);
    expect(viewSource).toMatch(/commitExcellentDraftFilters\(boardSlice, board, requestFilters\)/);
    expect(viewSource).toMatch(/rollbackExcellentDraftFilters\(boardSlice, board\)/);
    expect(viewSource).toMatch(/draftContentSource/);
  });

  it("scroll rule: dirty formal change means top; same filter keeps position", () => {
    // Pure semantics used by the refresh flow
    const same = makeSlice({
      categoryPath: "",
      draftCategoryPath: "",
      contentSource: "all",
      draftContentSource: "all",
    });
    expect(excellentFiltersAreDirty(same, "xhs_hot")).toBe(false);
    const dirty = makeSlice({
      categoryPath: "",
      draftCategoryPath: "内容类目#美妆",
      contentSource: "all",
      draftContentSource: "all",
    });
    expect(excellentFiltersAreDirty(dirty, "xhs_hot")).toBe(true);
  });
});
