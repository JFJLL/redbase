import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, isAbortError, isUnauthorized } from "@/shared/api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses JSON responses and sends cookies via same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { user: { id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await apiFetch<{ user: { id: string } }>("/api/session");

    expect(data.user.id).toBe("u1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
  });

  it("serializes JSON bodies with a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/auth/login", { method: "POST", body: { phone: "1", password: "2" } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ phone: "1", password: "2" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("appends query parameters and skips empty values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/items", { query: { page: 2, keyword: "", flag: false } });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/items?page=2&flag=false");
  });

  it("throws ApiError carrying the backend error text verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "登录状态已失效" })));

    const error = await apiFetch("/api/session").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("登录状态已失效");
    expect(isUnauthorized(error)).toBe(true);
  });

  it("recognizes abort errors so views can swallow cancelled requests", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });
});
