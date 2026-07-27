import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the session from GET /api/session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { user: { id: "u1", phone: "138", isAdmin: true } })),
    );
    const auth = useAuthStore();

    const user = await auth.loadSession();

    expect(user?.id).toBe("u1");
    expect(auth.isLoggedIn).toBe(true);
    expect(auth.isAdmin).toBe(true);
    expect(auth.sessionLoaded).toBe(true);
  });

  it("treats 401 as logged-out without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "登录状态已失效" })));
    const auth = useAuthStore();

    const user = await auth.loadSession();

    expect(user).toBeNull();
    expect(auth.isLoggedIn).toBe(false);
    expect(auth.sessionLoaded).toBe(true);
  });

  it("login posts credentials to /api/auth/login and stores the user", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { user: { id: "u2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = useAuthStore();

    await auth.login("13800000000", "secret");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/login");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(auth.user?.id).toBe("u2");
  });

  it("logout clears the user even when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const auth = useAuthStore();
    auth.user = { id: "u3" };

    await expect(auth.logout()).rejects.toThrow("network down");
    expect(auth.user).toBeNull();
  });
});
