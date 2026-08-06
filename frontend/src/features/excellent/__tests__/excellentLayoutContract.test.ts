import { describe, expect, it } from "vitest";
import ExcellentViewSource from "../views/ExcellentView.vue?raw";

describe("excellent card actions layout contract", () => {
  it("fills remaining card height with the body so actions sit on the same baseline", () => {
    expect(ExcellentViewSource).toMatch(/\.excellent-card-body\s*\{[\s\S]*?flex:\s*1/);
  });

  it("renders 查看详情 and 一键仿图文 with equal width", () => {
    expect(ExcellentViewSource).toMatch(
      /\.excellent-card-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("keeps the title two-line clamp and the cover aspect ratio", () => {
    expect(ExcellentViewSource).toMatch(/line-clamp:\s*2/);
    expect(ExcellentViewSource).toContain("aspect-ratio: 3 / 4");
  });
});
