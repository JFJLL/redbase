/**
 * Migrated 1:1 from tests/trend-request-id-regression.test.js (legacy
 * public/app.js trend request-id helpers and public/js/api-client.js).
 *
 * Mapping notes:
 * - getTrendAnalysisRequestKey / getOrCreateTrendAnalysisRequestId /
 *   clearTrendAnalysisRequestId + the module-level trendAnalysisRequestIds Map
 *   → insights store actions getOrCreateAnalysisRequestId /
 *   clearAnalysisRequestId over state.trendAnalysisRequestIds
 *   (frontend/src/features/trends/stores/insights.ts).
 * - shouldResetTrendAnalysisRequestId → same-named pure function in
 *   frontend/src/features/trends/model/trendBuckets.ts. It now types errors
 *   as ApiError (the only error shape the new client throws with a status),
 *   so the terminal-status cases construct ApiError instances instead of
 *   bare `{ status }` literals — the status semantics are asserted verbatim.
 * - Legacy api-client request() exposing `error.status` → apiFetch throwing
 *   ApiError with `.status` and the backend error text verbatim
 *   (frontend/src/shared/api/client.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ApiError, apiFetch } from "@/shared/api/client";
import { shouldResetTrendAnalysisRequestId } from "../model/trendBuckets";
import { useInsightsStore } from "../stores/insights";

describe("trend request id regression (legacy contract)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("trend retries reuse an ambiguous request ID and rotate only after terminal client failures", () => {
    const insights = useInsightsStore();

    const first = insights.getOrCreateAnalysisRequestId(7, "traffic");
    expect(insights.getOrCreateAnalysisRequestId(7, "traffic")).toBe(first);
    expect(shouldResetTrendAnalysisRequestId(new TypeError("socket closed"))).toBe(false);
    expect(shouldResetTrendAnalysisRequestId(new ApiError(408, null, "timeout"))).toBe(false);
    expect(shouldResetTrendAnalysisRequestId(new ApiError(409, null, "conflict"))).toBe(false);
    expect(shouldResetTrendAnalysisRequestId(new ApiError(500, null, "server"))).toBe(false);
    expect(shouldResetTrendAnalysisRequestId(new ApiError(504, null, "gateway"))).toBe(false);
    expect(insights.getOrCreateAnalysisRequestId(7, "traffic")).toBe(first);

    const validationFailure = new ApiError(422, null, "invalid");
    expect(shouldResetTrendAnalysisRequestId(validationFailure)).toBe(true);
    if (shouldResetTrendAnalysisRequestId(validationFailure)) {
      insights.clearAnalysisRequestId(7, "traffic");
    }
    expect(insights.getOrCreateAnalysisRequestId(7, "traffic")).not.toBe(first);
  });

  it("API client exposes HTTP status so retry policy can distinguish terminal responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "模型请求失败" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(apiFetch("/api/brands/7/analyses", { method: "POST" })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError && error.message === "模型请求失败" && error.status === 500,
    );
  });
});
