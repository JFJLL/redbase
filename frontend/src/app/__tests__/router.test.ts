import { describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createAppRouter } from "@/app/router";
import { useAuthStore } from "@/shared/stores/auth";

describe("workspace router (frozen route table)", () => {
  it("exposes every business route the agents implement", () => {
    const router = createAppRouter();
    const names = router.getRoutes().map((route) => route.name).filter(Boolean);

    for (const expected of [
      "login",
      "register",
      "home",
      "brands",
      "personal",
      "trends",
      "ideas",
      "excellent",
      "generation",
      "history",
      "not-found",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("resolves business tabs under the /app/ history base", () => {
    const router = createAppRouter();
    expect(router.resolve({ name: "brands" }).href).toBe("/app/brands");
    expect(router.resolve({ name: "trends" }).href).toBe("/app/trends");
    expect(router.resolve({ name: "excellent" }).href).toBe("/app/excellent");
  });

  it("guards workspace children behind requiresAuth", () => {
    const router = createAppRouter();
    const brands = router.resolve({ name: "brands" });
    const shellRecord = brands.matched[0];
    expect(shellRecord?.meta.requiresAuth).toBe(true);
  });

  it("redirects /generation to /ideas preserving the deep-link query", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "u1", name: "测试", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ user: { id: "u1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const router = createAppRouter();
    await router.push({
      name: "generation",
      query: { brandId: "7", trendId: "501", ideaIndex: "0", action: "moments" },
    });
    await router.isReady();

    expect(router.currentRoute.value.name).toBe("ideas");
    expect(router.currentRoute.value.query).toEqual({
      brandId: "7",
      trendId: "501",
      ideaIndex: "0",
      action: "moments",
    });
    expect(router.currentRoute.value.redirectedFrom?.name).toBe("generation");
    vi.unstubAllGlobals();
  });
});
