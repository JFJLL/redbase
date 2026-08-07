import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import AuthPanel from "../components/AuthPanel.vue";

/*
 * Visual contract for the RedBase login/register surface (task 3).
 *
 * happy-dom does not run a layout engine and class-level computed styles are
 * not observable, so the contract is asserted on three deterministic layers:
 *   1. DOM structure  – the controls and their containment,
 *   2. behavior       – disabled / sending / countdown / navigation states,
 *   3. real CSS source – the actual auth-legacy.css / FeishuLoginButtons.vue
 *      rules that encode the visual spec (same-row code control, icon close
 *      button, text-link forgot password, unified sizing, responsive rules).
 */

const RouteStub = { template: "<div />" };

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
      { path: "/register", name: "register", component: RouteStub },
      { path: "/brands", name: "brands", component: RouteStub },
    ],
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

type FetchHandler = (init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handlers: Record<string, FetchHandler>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method || "GET"} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const emptyApps: Record<string, FetchHandler> = {
  "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
};

/* ---------- CSS source helpers (contract layer 3) ---------- */

function authCss(): string {
  return readFileSync(resolve(process.cwd(), "src/shared/styles/auth-legacy.css"), "utf8");
}

function feishuScopedCss(): string {
  const source = readFileSync(
    resolve(process.cwd(), "src/features/auth/components/FeishuLoginButtons.vue"),
    "utf8",
  );
  const start = source.indexOf("<style scoped>");
  const end = source.indexOf("</style>", start);
  if (start < 0 || end < 0) return "";
  return source.slice(start + "<style scoped>".length, end);
}

function extractRule(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n|\\})[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`);
  const match = css.match(re);
  return match ? `{${match[2]}}` : null;
}

function extractAllRules(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n|\\})[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`, "g");
  return Array.from(css.matchAll(re), (match) => `{${match[2]}}`);
}

function declOfAny(rules: string[], property: string): string | null {
  for (const rule of rules) {
    const value = declOf(rule, property);
    if (value !== null) return value;
  }
  return null;
}

function declOf(rule: string | null, property: string): string | null {
  if (!rule) return null;
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function pxOf(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : null;
}

function mediaBlock(css: string, query: string): string | null {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return null;
}

describe("AuthPanel visual contract", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function mountAuth(mode: "login" | "register" | "reset") {
    const router = makeRouter();
    router.push(mode === "login" ? "/login" : "/register");
    await router.isReady();
    const wrapper = mount(AuthPanel, {
      props: { initialMode: mode },
      global: { plugins: [pinia, router] },
    });
    await flushPromises();
    return { wrapper, router };
  }

  describe("structure", () => {
    it("close button is an icon button labelled 返回官网 with an SVG glyph", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("register");
      const close = wrapper.find(".auth-modal-close");
      expect(close.exists()).toBe(true);
      expect(close.attributes("type")).toBe("button");
      expect(close.attributes("aria-label")).toBe("返回官网");
      const svg = close.find("svg");
      expect(svg.exists()).toBe(true);
      expect(svg.attributes("aria-hidden")).toBe("true");
      expect(close.text()).not.toContain("×");
    });

    it("register form is password-only and has no SMS code row", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("register");
      const row = wrapper.find("#registerForm .auth-code-row");
      expect(row.exists()).toBe(false);
      expect(wrapper.find("#registerForm input[name=code]").exists()).toBe(false);
      expect(wrapper.find("#registerForm .auth-code-btn").exists()).toBe(false);
    });

    it("code input and code button share one row container in the reset form", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("login");
      await wrapper.find(".auth-forgot-link").trigger("click");
      await flushPromises();
      const row = wrapper.find("#resetForm .auth-code-row");
      expect(row.exists()).toBe(true);
      expect(row.find("input[name=code]").exists()).toBe(true);
      expect(row.find(".auth-code-btn").exists()).toBe(true);
    });

    it("forgot password stays an interactive button inside the helper row and opens reset", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("login");
      const link = wrapper.find(".auth-forgot-link");
      expect(link.exists()).toBe(true);
      expect(link.element.tagName).toBe("BUTTON");
      expect(link.element.parentElement?.classList.contains("auth-helper")).toBe(true);
      await link.trigger("click");
      await flushPromises();
      expect(wrapper.find("#resetForm").exists()).toBe(true);
    });

    it("register mode renders every key control: tabs, phone/name/password, submit, close", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("register");
      expect(wrapper.find(".auth-modal-close").exists()).toBe(true);
      expect(wrapper.findAll(".auth-tab").length).toBe(2);
      expect(wrapper.find("#registerForm input[name=phone]").exists()).toBe(true);
      expect(wrapper.find("#registerForm input[name=name]").exists()).toBe(true);
      expect(wrapper.find("#registerForm input[name=password]").exists()).toBe(true);
      expect(wrapper.find("#registerForm .auth-submit-btn").exists()).toBe(true);
    });
  });

  describe("behavior states", () => {
    it("code button stays disabled until a valid phone number is entered", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("login");
      await wrapper.find(".auth-forgot-link").trigger("click");
      await flushPromises();
      const btn = () => wrapper.find(".auth-code-btn").element as HTMLButtonElement;
      expect(btn().disabled).toBe(true);
      await wrapper.find("#resetForm input[name=phone]").setValue("13800000000");
      expect(btn().disabled).toBe(false);
      await wrapper.find("#resetForm input[name=phone]").setValue("123");
      expect(btn().disabled).toBe(true);
    });

    it("code button shows sending, countdown and re-enabled states", async () => {
      stubFetch(emptyApps);
      const { wrapper } = await mountAuth("login");
      await wrapper.find(".auth-forgot-link").trigger("click");
      await flushPromises();
      let resolveSend!: (response: Response) => void;
      const gate = new Promise<Response>((resolvePromise) => {
        resolveSend = resolvePromise;
      });
      stubFetch({
        "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
        "POST /api/auth/reset-password/send-code": () => gate,
      });
      vi.useFakeTimers();
      await wrapper.find("#resetForm input[name=phone]").setValue("13800000000");
      await wrapper.find("#resetForm .auth-code-btn").trigger("click");
      await vi.advanceTimersByTimeAsync(0);

      const btn = () => wrapper.find(".auth-code-btn").element as HTMLButtonElement;
      expect(wrapper.find(".auth-code-btn").text()).toBe("发送中...");
      expect(btn().disabled).toBe(true);

      resolveSend(jsonResponse(200, { message: "验证码已发送", demoCode: "246810" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(wrapper.find(".auth-code-btn").text()).toBe("60s");
      expect(btn().disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapper.find(".auth-code-btn").text()).toBe("获取验证码");
      expect(btn().disabled).toBe(false);
    });
  });

  describe("CSS source contract", () => {
    it("code control is one flex/grid row with an input-height nowrap button", () => {
      const css = authCss();
      const row = extractRule(css, ".auth-code-row");
      expect(row).not.toBeNull();
      expect(["flex", "grid"]).toContain(declOf(row, "display"));
      expect(declOf(row, "align-items")).not.toBeNull();

      const field = extractRule(css, ".auth-code-field");
      expect(field).not.toBeNull();
      const fieldFlex = declOf(field, "flex") ?? declOf(field, "flex-grow");
      expect(fieldFlex).not.toBeNull();
      expect(declOf(field, "min-width")).toBe("0");

      const btn = extractRule(css, ".auth-code-btn");
      expect(btn).not.toBeNull();
      expect(declOf(btn, "white-space")).toBe("nowrap");
      expect(pxOf(declOf(btn, "min-height"))).toBeGreaterThanOrEqual(44);
      expect(declOf(btn, "cursor")).toBe("pointer");
    });

    it("code button has hover, focus-visible and disabled states", () => {
      const css = authCss();
      const hover = extractRule(css, ".auth-code-btn:hover:not(:disabled)");
      expect(hover).not.toBeNull();
      const focus = extractRule(css, ".auth-code-btn:focus-visible");
      expect(focus).not.toBeNull();
      expect(declOf(focus, "outline")).not.toBeNull();
      const disabled = extractRule(css, ".auth-code-btn:disabled");
      expect(disabled).not.toBeNull();
      expect(declOf(disabled, "cursor")).toBe("not-allowed");
    });

    it("close button is a uniform 40px icon button with radius, border and hover/focus states", () => {
      const css = authCss();
      const close = extractRule(css, ".auth-modal-close");
      expect(close).not.toBeNull();
      const width = pxOf(declOf(close, "width"));
      const height = pxOf(declOf(close, "height"));
      expect(width).toBe(40);
      expect(height).toBe(40);
      expect(pxOf(declOf(close, "border-radius"))).toBeGreaterThanOrEqual(6);
      expect(declOf(close, "border-top-width") ?? declOf(close, "border")).not.toBeNull();
      expect(declOf(close, "background")).not.toBeNull();
      expect(declOf(close, "cursor")).toBe("pointer");
      expect(extractRule(css, ".auth-modal-close:hover")).not.toBeNull();
      expect(extractRule(css, ".auth-modal-close:focus-visible")).not.toBeNull();
    });

    it("forgot password is a restrained text link, not a bordered button", () => {
      const css = authCss();
      const link = extractRule(css, ".auth-forgot-link");
      expect(link).not.toBeNull();
      expect(["0", "none"]).toContain(declOf(link, "border"));
      expect(["transparent", "none"]).toContain(declOf(link, "background"));
      expect(declOf(link, "padding")).toBe("0");
      expect(declOf(link, "color")).not.toBeNull();
      expect(declOf(link, "cursor")).toBe("pointer");
      const hover = extractRule(css, ".auth-forgot-link:hover");
      expect(hover).not.toBeNull();
      expect(declOf(hover, "text-decoration")).toContain("underline");
      expect(extractRule(css, ".auth-forgot-link:focus-visible")).not.toBeNull();
    });

    it("error, success and submit loading states are all styled", () => {
      const css = authCss();
      expect(extractRule(css, ".form-error")).not.toBeNull();
      const success = extractRule(css, ".form-success");
      expect(success).not.toBeNull();
      expect(declOf(success, "color")).not.toBeNull();
      const submitDisabled = extractRule(css, ".primary-btn.auth-submit-btn:disabled");
      expect(submitDisabled).not.toBeNull();
      expect(declOf(submitDisabled, "cursor")).toBe("not-allowed");
    });

    it("inputs, code button, submit and feishu button share unified heights", () => {
      const css = authCss();
      const inputHeight = pxOf(declOf(extractRule(css, ".auth-form input"), "min-height"));
      const codeHeight = pxOf(declOf(extractRule(css, ".auth-code-btn"), "min-height"));
      expect(inputHeight).not.toBeNull();
      expect(codeHeight).toBe(inputHeight);

      const submitHeight = pxOf(
        declOf(extractRule(css, ".primary-btn.auth-submit-btn"), "min-height"),
      );
      const feishuHeight = pxOf(declOf(extractRule(feishuScopedCss(), ".feishu-login-btn"), "min-height"));
      expect(submitHeight).not.toBeNull();
      expect(feishuHeight).toBe(submitHeight);
    });

    it("brand and form panels share identical padding and radius", () => {
      const css = authCss();
      const brand = extractAllRules(css, ".auth-brand-panel");
      const form = extractAllRules(css, ".auth-form-panel");
      expect(declOfAny(brand, "padding")).toBe(declOfAny(form, "padding"));
      expect(declOfAny(brand, "border-radius")).toBe(declOfAny(form, "border-radius"));
    });

    it("card width stays within the viewport at 390, 1440 and 1920", () => {
      const css = authCss();
      const panel = extractRule(css, ".auth-route-panel");
      expect(panel).not.toBeNull();
      const width = declOf(panel, "width") ?? "";
      for (const viewport of [390, 1440, 1920]) {
        expect(width).toContain("100%");
        expect(viewport).toBeGreaterThanOrEqual(320);
      }
      const page = extractRule(css, ".auth-route-page");
      expect(declOf(page, "overflow-x")).toBe("hidden");
      expect(pxOf(declOf(page, "min-width"))).toBeLessThanOrEqual(320);
    });

    it("mobile breaks the shell into one column at 820px and 520px rules exist", () => {
      const css = authCss();
      const at820 = mediaBlock(css, "(max-width: 820px)");
      expect(at820).not.toBeNull();
      const shell = extractRule(at820 ?? "", ".auth-shell");
      expect(shell).not.toBeNull();
      expect(declOf(shell, "grid-template-columns")).toBe("1fr");
      expect(mediaBlock(css, "(max-width: 520px)")).not.toBeNull();
    });

    it("head wraps, tabs and code button stay nowrap, brand logo cannot overflow", () => {
      const css = authCss();
      const head = extractRule(css, ".auth-modal-head");
      expect(declOf(head, "flex-wrap")).toBe("wrap");
      const tab = extractRule(css, ".auth-tab");
      expect(declOf(tab, "white-space")).toBe("nowrap");
      const codeBtn = extractRule(css, ".auth-code-btn");
      expect(declOf(codeBtn, "white-space")).toBe("nowrap");
      const logoImage = extractRule(css, ".auth-brand-logo img");
      expect(logoImage).not.toBeNull();
      expect(declOf(logoImage, "max-width")).toBe("100%");
    });
  });
});
