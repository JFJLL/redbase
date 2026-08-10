import { describe, expect, it } from "vitest";
import TrendsViewSource from "../views/TrendsView.vue?raw";

function styleRules(source: string): Array<{ selector: string; body: string }> {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  const css = match ? match[1] : "";
  const rules: Array<{ selector: string; body: string }> = [];
  for (const block of css.split("}")) {
    const idx = block.lastIndexOf("{");
    if (idx < 0) continue;
    const selector = block.slice(0, idx).trim();
    const body = block.slice(idx + 1).trim();
    if (!selector || !body) continue;
    rules.push({ selector, body });
  }
  return rules;
}

describe("trends analysis summary layout contract", () => {
  it("never clips .analysis-summary with a generic overflow:hidden rule", () => {
    const rules = styleRules(TrendsViewSource);
    for (const rule of rules) {
      if (rule.body.includes("overflow: hidden") && rule.selector.includes(".analysis-summary")) {
        throw new Error(`analysis-summary is clipped by overflow:hidden in rule: ${rule.selector}`);
      }
    }
    expect(TrendsViewSource).toContain('data-test="analysis-summary"');
  });

  it("lets the summary box grow with its content (visible overflow, auto height)", () => {
    const rules = styleRules(TrendsViewSource);
    const summaryRules = rules.filter((rule) => rule.selector.includes(".analysis-summary"));
    expect(
      summaryRules.some(
        (rule) => rule.body.includes("overflow: visible") && rule.body.includes("height: auto"),
      ),
    ).toBe(true);
  });

  it("keeps normal wrapping rules for long text", () => {
    expect(TrendsViewSource).toContain("overflow-wrap: break-word");
    expect(TrendsViewSource).toContain("line-height: 1.8");
  });

  it("keeps an independently scrolling result window without a hard-coded viewport offset", () => {
    const rules = styleRules(TrendsViewSource);
    const rightPanelRules = rules.filter((rule) => rule.selector.includes(".trend-right-panel"));
    expect(rightPanelRules.some((rule) => rule.body.includes("overflow-y: auto"))).toBe(true);
    expect(TrendsViewSource).toContain('data-test="trend-scroll-panel"');
    expect(TrendsViewSource).toContain("height: trendRightPanelMaxHeight || undefined");
    expect(TrendsViewSource).toContain(":style=\"{ height: trendRightPanelMaxHeight || undefined }\"");
    expect(TrendsViewSource).toContain("window.innerHeight - viewportTop - 24");
    expect(TrendsViewSource).not.toContain("max-height: calc(100vh - 250px)");
    expect(TrendsViewSource).not.toContain(":global(body:has(.trends-panel))");
    expect(TrendsViewSource).not.toContain(":global(html:has(.trends-panel))");
  });

  it("makes the history pane a matching independent scroll surface", () => {
    const rules = styleRules(TrendsViewSource);
    const historyRules = rules.filter((rule) => rule.selector.includes(".history-block"));
    expect(historyRules.some((rule) => rule.body.includes("flex: 1 1 auto"))).toBe(true);
    expect(historyRules.some((rule) => rule.body.includes("overflow-y: auto"))).toBe(true);
    expect(TrendsViewSource).toContain(".trend-left-panel");
  });
});
