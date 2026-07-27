import { describe, expect, it } from "vitest";
import { createAppRouter } from "@/app/router";

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
});
