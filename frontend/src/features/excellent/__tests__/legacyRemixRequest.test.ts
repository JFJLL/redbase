/**
 * Migrated 1:1 from tests/excellent-remix-request.test.js (legacy
 * public/js/excellent-remix-request.js request-token machinery).
 *
 * Mapping notes:
 * - The legacy token fields (instanceId / sessionEpoch / *RequestId) plus
 *   captureRemixRequestToken/isRemixResponseCurrent were replaced by
 *   AbortSignal scopes (useAbortScope.signalFor: same key aborts the previous
 *   in-flight request; scope disposal aborts everything). Each legacy
 *   rejection case is asserted through the equivalent abort behaviour: the
 *   stale request rejects with AbortError so its response can never be
 *   written, while the newer request resolves with its own payload.
 * - shouldAutoGenerateSmartDirections no longer exists: the Vue view only
 *   calls fetchContentDirections from the user-triggered generateDirections
 *   handler (asserted statically against ExcellentView.vue).
 * - The legacy concurrency-cap queue for slide generation was replaced by a
 *   strictly sequential submit loop; the "sequential submission with a
 *   consistent per-page request body" test covers the still-applicable
 *   request-body/ordering semantics.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectScope, type EffectScope } from "vue";
import { notifyAuthReset, useAbortScope, type AbortScope } from "@/shared/composables/useAbortScope";
import { isAbortError } from "@/shared/api/client";
import { fetchContentDirections, fetchFusionPlan, fetchRemixAnalysis } from "../api";

interface RecordedCall {
  url: string;
  body: Record<string, unknown> | null;
  resolve: (response: Response) => void;
}

const scopes: EffectScope[] = [];

function makeScope(): AbortScope {
  const scope = effectScope();
  scopes.push(scope);
  const abortScope = scope.run(() => useAbortScope());
  if (!abortScope) throw new Error("failed to create abort scope");
  return abortScope;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch mock: every call stays pending until aborted (rejects AbortError)
 *  or explicitly resolved through the recorded call handle. */
function stubPendingFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const record: RecordedCall = {
          url: String(input),
          body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
          resolve,
        };
        calls.push(record);
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    }),
  );
  return calls;
}

const viewSource = readFileSync(
    resolve(process.cwd(), "src/features/excellent/views/ExcellentView.vue"),
  "utf8",
);

describe("excellent remix request scoping (legacy contract)", () => {
  afterEach(() => {
    while (scopes.length) scopes.pop()?.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cross-note async response is rejected", async () => {
    // Legacy: token captured for note-a fails isRemixResponseCurrent once the
    // modal shows note-b. New: opening another note reuses the same scope
    // key, aborting note-a's analysis request before it can resolve.
    const calls = stubPendingFetch();
    const scope = makeScope();
    const staleRequest = fetchRemixAnalysis("note-a", { brandId: 11 }, scope.signalFor("remix-analysis"));
    const currentRequest = fetchRemixAnalysis("note-b", { brandId: 11 }, scope.signalFor("remix-analysis"));

    const staleOutcome = await staleRequest.catch((error: unknown) => error);
    expect(isAbortError(staleOutcome)).toBe(true);

    expect(calls.length).toBe(2);
    expect(calls[0].url).toContain("/api/excellent-contents/note-a/remix-analysis");
    expect(calls[1].url).toContain("/api/excellent-contents/note-b/remix-analysis");
    calls[1].resolve(jsonResponse({ analysis: { analysisId: "b" } }));
    const current = await currentRequest;
    expect(current.analysis.analysisId).toBe("b");
  });

  it("closed modal (scope disposed) rejects writes", async () => {
    // Legacy: isRemixResponseCurrent(null, token) === false. New: closing the
    // modal disposes the scope, aborting the in-flight request so its
    // response can never be written into a dead modal state.
    stubPendingFetch();
    const scope = effectScope();
    const abortScope = scope.run(() => useAbortScope());
    if (!abortScope) throw new Error("failed to create abort scope");
    const pending = fetchRemixAnalysis("note-a", { brandId: 11 }, abortScope.signalFor("remix-analysis"));
    scope.stop();
    const outcome = await pending.catch((error: unknown) => error);
    expect(isAbortError(outcome)).toBe(true);
  });

  it("modal instance mismatch rejects writes from the previous instance", async () => {
    // Legacy: instanceId 1 token rejected against instanceId 2 state. New:
    // each modal instance owns its own scope; disposing instance 1 aborts its
    // request while instance 2's request resolves untouched.
    const calls = stubPendingFetch();
    const firstInstance = effectScope();
    const firstScope = firstInstance.run(() => useAbortScope());
    if (!firstScope) throw new Error("failed to create abort scope");
    const staleRequest = fetchRemixAnalysis("note-a", { brandId: 11 }, firstScope.signalFor("remix-analysis"));

    const secondScope = makeScope();
    const currentRequest = fetchRemixAnalysis("note-a", { brandId: 11 }, secondScope.signalFor("remix-analysis"));

    firstInstance.stop();
    const staleOutcome = await staleRequest.catch((error: unknown) => error);
    expect(isAbortError(staleOutcome)).toBe(true);

    calls[1].resolve(jsonResponse({ analysis: { analysisId: "second-instance" } }));
    const current = await currentRequest;
    expect(current.analysis.analysisId).toBe("second-instance");
  });

  it("fast brand switch rejects old brand directions", async () => {
    // Legacy: directions token for brand 11 rejected after switch to brand
    // 22; brand-22 token accepted. New: the brand switch re-requests
    // directions under the same key, aborting the brand-11 request.
    const calls = stubPendingFetch();
    const scope = makeScope();
    const staleRequest = fetchContentDirections(
      "note-a",
      { brandId: 11 },
      scope.signalFor("remix-directions"),
    );
    const currentRequest = fetchContentDirections(
      "note-a",
      { brandId: 22 },
      scope.signalFor("remix-directions"),
    );

    const staleOutcome = await staleRequest.catch((error: unknown) => error);
    expect(isAbortError(staleOutcome)).toBe(true);

    expect(calls[0].body?.brandId).toBe(11);
    expect(calls[1].body?.brandId).toBe(22);
    calls[1].resolve(jsonResponse({ directions: [{ id: "structure_transfer", title: "brand-22" }] }));
    const current = await currentRequest;
    expect(current.directions?.[0]?.title).toBe("brand-22");
  });

  it("stale request is rejected after a newer request", async () => {
    // Legacy: nextRemixRequestId bump invalidated the older fusion token.
    // New: issuing a newer fusion request under the same key aborts the
    // older one before it can settle.
    const calls = stubPendingFetch();
    const scope = makeScope();
    const staleRequest = fetchFusionPlan("note-a", { brandId: 11 }, scope.signalFor("remix-fusion"));
    const currentRequest = fetchFusionPlan("note-a", { brandId: 11 }, scope.signalFor("remix-fusion"));

    const staleOutcome = await staleRequest.catch((error: unknown) => error);
    expect(isAbortError(staleOutcome)).toBe(true);

    calls[1].resolve(jsonResponse({ fusionPlan: { contentThesis: "newer" } }));
    const current = await currentRequest;
    expect(current.fusionPlan.contentThesis).toBe("newer");
  });

  it("smart directions never auto-generate; user must click generate", () => {
    // Legacy: shouldAutoGenerateSmartDirections always false. New: the view
    // calls fetchContentDirections exactly once — inside the user-triggered
    // generateDirections handler bound to @click — never from a watcher,
    // lifecycle hook or analysis completion path.
    const directionCallSites = viewSource.match(/fetchContentDirections/g) ?? [];
    // import statement + the single call inside generateDirections
    expect(directionCallSites.length).toBe(2);
    const handlerSites = viewSource.match(/generateDirections/g) ?? [];
    // function declaration + the @click binding, nothing else triggers it
    expect(handlerSites.length).toBe(2);
    expect(viewSource).toMatch(/@click="generateDirections"/);
    expect(/watch\([^)]*generateDirections/.test(viewSource)).toBe(false);
    expect(/onMounted\([^)]*generateDirections/.test(viewSource)).toBe(false);
  });

  it("slides are submitted sequentially with a consistent per-page request body", () => {
    // Replaces the legacy concurrency-cap queue semantics: the Vue submit
    // flow awaits generateExcellentRemixSlide inside a plain for loop (one
    // slide at a time, in order) and sends the same body shape for every
    // page, all bound to the same abort signal.
    const loopMatch = viewSource.match(
      /for \(let slideIndex = 0; slideIndex < \(pack\.slides \|\| \[\]\)\.length; slideIndex \+= 1\) \{[\s\S]*?\n    \}/,
    );
    expect(loopMatch, "sequential slide submit loop must exist").not.toBeNull();
    const loop = loopMatch?.[0] ?? "";
    expect(loop).toMatch(/await generateExcellentRemixSlide\(/);
    for (const field of [
      "carouselPack: pack",
      "carouselGroupId",
      "slide,",
      "productImages",
      "useBrandLogo",
      "aspectRatio",
      "contentMode: genPayload.contentMode",
      "existingIdeaRef: genPayload.existingIdeaRef",
      "ideaTitle: genPayload.ideaTitle",
      "trendTitle: genPayload.trendTitle",
    ]) {
      expect(loop.includes(field), `slide request body must include ${field}`).toBe(true);
    }
    // each page waits for its own image job before the next page starts
    expect(loop).toMatch(/await pollImageJob\(/);
    // no parallel fan-out: the view never submits slides via Promise.all
    expect(/Promise\.all\([^)]*generateExcellentRemixSlide/.test(viewSource)).toBe(false);
  });
});

// Guard against the account-switch path regressing (mirrors the legacy
// sessionEpoch reset): notifyAuthReset must abort scope-tracked requests.
describe("excellent remix requests on auth reset", () => {
  afterEach(() => {
    while (scopes.length) scopes.pop()?.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("auth reset aborts an in-flight remix request", async () => {
    stubPendingFetch();
    const scope = makeScope();
    const pending = fetchRemixAnalysis("note-a", { brandId: 11 }, scope.signalFor("remix-analysis"));
    notifyAuthReset();
    const outcome = await pending.catch((error: unknown) => error);
    expect(isAbortError(outcome)).toBe(true);
  });
});
