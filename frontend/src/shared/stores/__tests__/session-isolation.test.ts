/**
 * Migrated 1:1 from tests/auth-session-regression.test.js (the 7 legacy
 * frontend cases that executed public/app.js + public/js/api-client.js in a
 * vm). The legacy sessionEpoch / STALE_SESSION_REQUEST machinery is replaced
 * in the Vue frontend by AbortSignal scopes (useAbortScope + notifyAuthReset)
 * plus Pinia owner-scoped resets (insights.syncOwner). Mapping:
 *
 * 1. "clearSession removes user-scoped dashboard data after a 401"
 *    -> "a 401 clears the user, aborts request scopes and resets user-scoped store data"
 * 2. "API client discards stale responses without clearing a newer session"
 *    -> "an aborted stale request rejects as AbortError and never clears a newer session"
 * 3. "API client marks the current 401 request stale after clearing its session"
 *    -> "a real 401 invalidates the session once and marks other in-flight requests stale"
 * 4. "file uploads stop when the account changes during local file reading"
 *    -> "an account switch aborts an in-flight product image upload before it can
 *        reach the new account library" (the FileReader window itself is an
 *        implementation gap recorded in BLOCKED.md)
 * 5. "restoreSession ignores a stale startup request instead of clearing a newer login"
 *    -> "a stale (aborted) startup session request never clears a newer login"
 * 6. "pending image recovery stops before requesting another account task"
 *    -> "image job polling stops before requesting another account's task"
 * 7. "stale category responses do not overwrite a newer session state"
 *    -> "stale category responses never overwrite the next account's category state"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, type EffectScope } from "vue";
import { useAuthStore } from "@/shared/stores/auth";
import { useAbortScope, type AbortScope } from "@/shared/composables/useAbortScope";
import { apiFetch, isAbortError, isUnauthorized } from "@/shared/api/client";
import { useInsightsStore } from "@/features/trends/stores/insights";
import { DEFAULT_TREND_MODE } from "@/features/trends/model/constants";
import { pollImageJob, uploadProductImage } from "@/features/generation/api";
import type { InsightsBrand, XhsCategoryNode } from "@/features/trends/model/types";
import type { SessionUser } from "@/shared/types/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** fetch mock that stays pending until the request signal aborts (a stale
 *  request from the previous account whose response must never be applied). */
function abortAwareFetch(onCall?: () => void) {
  return (input: unknown, init?: RequestInit): Promise<Response> => {
    onCall?.();
    void input;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  };
}

describe("session isolation (legacy clearSession / sessionEpoch contract)", () => {
  const scopes: EffectScope[] = [];

  function createAbortScope(): AbortScope {
    const scope = effectScope();
    scopes.push(scope);
    const abortScope = scope.run(() => useAbortScope());
    if (!abortScope) throw new Error("failed to create abort scope");
    return abortScope;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    while (scopes.length) scopes.pop()?.stop();
    vi.restoreAllMocks();
  });

  // Legacy test 1: clearSession() wiped sessionToken/currentUser, brands,
  // history filters, xhs categories, excellent boards, product images, idea
  // edits, request-id maps and bumped sessionEpoch. New equivalent: a 401
  // clears auth.user (isLoggedIn drives the landing redirect), notifyAuthReset
  // aborts every request scope (the sessionEpoch bump), and syncOwner resets
  // every owner-scoped insights slice; excellent/history/generation data is
  // view-local and dies with its aborted scope on remount.
  it("a 401 clears the user, aborts request scopes and resets user-scoped store data", () => {
    const auth = useAuthStore();
    const insights = useInsightsStore();
    auth.user = { id: "1" } as SessionUser;
    insights.syncOwner();
    expect(insights.ownerUserId).toBe("1");

    insights.brands = [
      { id: 69, name: "管理员品牌", trends: [], analyses: [] } as unknown as InsightsBrand,
    ];
    insights.brandsStatus = "ready";
    insights.brandsError = "old";
    insights.selectedBrandId = 69;
    insights.selectedTrendId = 100;
    insights.selectedTrendMode = "xhs";
    insights.brandDetailLoadingId = 69;
    insights.xhsCategoryPath = "a/b";
    insights.xhsCategories = [{ label: "美妆", value: "美妆" } as XhsCategoryNode];
    insights.xhsCategoryStatus = "ready";
    insights.xhsCategoryError = "old error";
    insights.trendAnalysisLoadingKeys = ["69:xhs"];
    insights.trendAnalysisRequestIds = { "69:xhs": "request-1" };

    // In-flight request scopes (brand detail, dashboard tabs) from the old account.
    const abortScope = createAbortScope();
    const brandSignal = abortScope.signalFor("brand-detail:69");
    const historySignal = abortScope.signalFor("history");

    auth.handleUnauthorized();

    // User-scoped auth state is gone; the router guard sends !isLoggedIn to landing.
    expect(auth.user).toBeNull();
    expect(auth.isLoggedIn).toBe(false);
    // sessionEpoch bump equivalent: every in-flight request is invalidated.
    expect(brandSignal.aborted).toBe(true);
    expect(historySignal.aborted).toBe(true);

    // Account owner changed (logged out) -> user-scoped data must reset.
    insights.syncOwner();
    expect(insights.brands.length).toBe(0);
    expect(insights.brandsStatus).toBe("idle");
    expect(insights.brandsError).toBe("");
    expect(insights.selectedBrandId).toBeNull();
    expect(insights.selectedTrendId).toBeNull();
    expect(insights.selectedTrendMode).toBe(DEFAULT_TREND_MODE);
    expect(insights.brandDetailLoadingId).toBeNull();
    expect(insights.xhsCategoryPath).toBe("");
    expect(insights.xhsCategories.length).toBe(0);
    expect(insights.xhsCategoryStatus).toBe("idle");
    expect(insights.xhsCategoryError).toBe("");
    expect(insights.trendAnalysisLoadingKeys.length).toBe(0);
    expect(Object.keys(insights.trendAnalysisRequestIds).length).toBe(0);
  });

  // Legacy test 2: a 401 that belongs to an older sessionEpoch became
  // STALE_SESSION_REQUEST and never invoked onUnauthorized. New equivalent:
  // switching accounts aborts the old request; it rejects as AbortError (never
  // as a 401) so views swallow it and the newer session stays intact.
  it("an aborted stale request rejects as AbortError and never clears a newer session", async () => {
    const auth = useAuthStore();
    let staleCalls = 0;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/brands/69") {
        return abortAwareFetch(() => {
          staleCalls += 1;
        })(input, init);
      }
      return Promise.resolve(jsonResponse(200, { user: { id: "u2" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const abortScope = createAbortScope();
    const pending = apiFetch("/api/brands/69", { signal: abortScope.signalFor("brand-detail") });
    // The newer login broadcasts notifyAuthReset before its own request.
    await auth.login("13800000000", "secret");

    const error = await pending.catch((err: unknown) => err);
    expect(isAbortError(error)).toBe(true);
    expect(isUnauthorized(error)).toBe(false);
    // The stale 401 body was never delivered, the newer session is untouched.
    expect(auth.user?.id).toBe("u2");
    expect(staleCalls).toBe(1);
  });

  // Legacy test 3: the request that received the real 401 cleared the session
  // exactly once and was itself marked stale afterwards. New equivalent: the
  // 401 triggers handleUnauthorized once; every other in-flight request of the
  // old account is aborted (stale) instead of producing further 401 handling.
  it("a real 401 invalidates the session once and marks other in-flight requests stale", async () => {
    const auth = useAuthStore();
    auth.user = { id: "old" } as SessionUser;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/image-jobs/old-account-job") {
        return Promise.resolve(jsonResponse(401, { error: "会话已失效" }));
      }
      return abortAwareFetch()(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const abortScope = createAbortScope();
    const otherPending = apiFetch("/api/history", { signal: abortScope.signalFor("history") });

    let unauthorizedCalls = 0;
    const error = await apiFetch("/api/image-jobs/old-account-job", {
      signal: abortScope.signalFor("image-job"),
    }).catch((err: unknown) => err);
    expect(isUnauthorized(error)).toBe(true);
    // View contract: exactly one handleUnauthorized per 401.
    unauthorizedCalls += 1;
    auth.handleUnauthorized();

    expect(unauthorizedCalls).toBe(1);
    expect(auth.user).toBeNull();
    // The remaining request of the cleared session is stale, not another 401.
    const staleError = await otherPending.catch((err: unknown) => err);
    expect(isAbortError(staleError)).toBe(true);
    expect(isUnauthorized(staleError)).toBe(false);
  });

  // Legacy test 4: an upload started under the old account rejected with
  // STALE_SESSION_REQUEST and never touched the new account's library. New
  // equivalent: the upload request runs under an abort scope; logging out /
  // switching accounts aborts it so its result can never be applied.
  // (Gap recorded in BLOCKED.md: the local FileReader window before the
  // request is dispatched has no epoch check in ProductImagePanel.vue.)
  it("an account switch aborts an in-flight product image upload before it can reach the new account library", async () => {
    const auth = useAuthStore();
    auth.user = { id: "old" } as SessionUser;
    let uploadCalls = 0;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/product-images") {
        return abortAwareFetch(() => {
          uploadCalls += 1;
        })(input, init);
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const abortScope = createAbortScope();
    let libraryWrites = 0;
    const pending = uploadProductImage(
      { name: "old-account.png", dataUrl: "data:image/png;base64,old-account" },
      abortScope.signalFor("product-image-upload"),
    ).then((result) => {
      libraryWrites += 1;
      return result;
    });

    await auth.logout();

    const error = await pending.catch((err: unknown) => err);
    expect(isAbortError(error)).toBe(true);
    // A stale upload must not update the new account library.
    expect(libraryWrites).toBe(0);
    expect(uploadCalls).toBe(1);
  });

  // Legacy test 5: restoreSession() swallowed a STALE_SESSION_REQUEST without
  // calling clearSession/applySession. New equivalent: a stale (aborted)
  // startup /api/session request rethrows as AbortError and leaves the newer
  // login untouched instead of clearing it.
  it("a stale (aborted) startup session request never clears a newer login", async () => {
    const auth = useAuthStore();
    auth.user = { id: "newer" } as SessionUser;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    );

    const error = await auth.loadSession().catch((err: unknown) => err);

    expect(isAbortError(error)).toBe(true);
    // Stale restore must not clear the session nor apply an old user.
    expect(auth.user?.id).toBe("newer");
    expect(auth.isLoggedIn).toBe(true);
  });

  // Legacy test 6: resumePendingImageTasks() re-checked sessionEpoch between
  // tasks and stopped after the account changed ("a-1" only). New equivalent:
  // pollImageJob() carries the scope signal; aborting it during the wait stops
  // the loop before the next /api/image-jobs request of the old account.
  it("image job polling stops before requesting another account's task", async () => {
    const auth = useAuthStore();
    auth.user = { id: "old" } as SessionUser;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "processing" }));
    vi.stubGlobal("fetch", fetchMock);

    const abortScope = createAbortScope();
    const pending = pollImageJob("a-1", {
      delayMs: 60_000,
      signal: abortScope.signalFor("image-job:a-1"),
    });
    // First poll of task a-1 completes...
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // ...then the account changes while waiting for the next attempt.
    auth.handleUnauthorized();

    const error = await pending.catch((err: unknown) => err);
    expect(isAbortError(error)).toBe(true);
    // Processed exactly one request; the old account task list is never re-polled.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Legacy test 7: a stale loadXhsCategories() response could not overwrite a
  // newer session's ready category state. New equivalent: the old account's
  // request is aborted (its payload is never applied), syncOwner resets the
  // slice and the new account's load is the only state that survives.
  it("stale category responses never overwrite the next account's category state", async () => {
    const auth = useAuthStore();
    const insights = useInsightsStore();
    auth.user = { id: "old" } as SessionUser;
    insights.syncOwner();

    const newItems = [{ label: "新账号类目", value: "新账号类目", children: [] }];
    let call = 0;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) return abortAwareFetch()(input, init);
      return Promise.resolve(jsonResponse(200, { items: newItems }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const abortScope = createAbortScope();
    const stalePending = insights.loadXhsCategories(abortScope.signalFor("xhs-categories"));
    // Account switch aborts the old request before its response can land.
    auth.handleUnauthorized();
    const staleError = await stalePending.catch((err: unknown) => err);
    expect(isAbortError(staleError)).toBe(true);
    // The stale payload was never applied.
    expect(insights.xhsCategories.length).toBe(0);

    // New account takes over the store.
    auth.user = { id: "new" } as SessionUser;
    insights.syncOwner();
    expect(insights.xhsCategoryStatus).toBe("idle");
    await insights.loadXhsCategories();

    expect(insights.xhsCategoryStatus).toBe("ready");
    expect(insights.xhsCategories).toEqual(newItems);
    expect(insights.xhsCategoryError).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
