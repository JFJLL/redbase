import { describe, expect, it } from "vitest";
import PersonalIpViewSource from "../views/PersonalIpView.vue?raw";
import BrandsViewSource from "@/features/brands/views/BrandsView.vue?raw";

describe("personal IP card width contract", () => {
  it("keeps a single personal IP card at normal card width (no full-row span)", () => {
    expect(PersonalIpViewSource).not.toMatch(/only-child/);
    expect(PersonalIpViewSource).not.toContain("grid-column: 1 / -1");
  });

  it("leaves the brand archive single-card full-row decision untouched", () => {
    expect(BrandsViewSource).toContain("grid-column: 1 / -1");
  });

  it("keeps the narrow-screen single column layout", () => {
    expect(PersonalIpViewSource).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });
});
