import "./landing.css";
import "./auth-legacy.css";
import { AUTH_MODAL_HTML, BUSINESS_MODAL_HTML, LANDING_HTML } from "./template";

// Lightweight landing entry — MUST NOT import Vue, Pinia, or any workspace
// module. The Core agent owns everything under src/landing/.

function renderLanding(root: HTMLElement): void {
  const page = document.createElement("div");
  page.className = "page page-landing is-active";
  page.dataset.page = "landing";
  page.innerHTML = LANDING_HTML;

  const businessModal = document.createElement("div");
  businessModal.className = "modal-mask";
  businessModal.id = "businessQuoteModal";
  businessModal.innerHTML = BUSINESS_MODAL_HTML;

  const authModal = document.createElement("div");
  authModal.className = "modal-mask";
  authModal.id = "authModal";
  authModal.innerHTML = AUTH_MODAL_HTML;

  root.replaceChildren(page, businessModal, authModal);
  bindLandingExperience(page);
  bindAuthModal(authModal);
  bindBusinessQuoteModal(businessModal);
  showAuthRedirectError();
  void redirectAuthenticatedUser();
}

// Interactions ported from public/app.js bindLandingExperience().
function bindLandingExperience(landingPage: HTMLElement): void {
  const heroCopy: Record<string, [string, string]> = {
    trend: ["值得跟进的内容机会", "从趋势信号中筛选与品牌真正相关的方向"],
    excellent: ["可以学习的优秀内容", "查看热门内容并提取结构与表达方式"],
    idea: ["可以直接执行的内容方向", "把品牌、趋势和内容参考变成结构化选题"],
    generate: ["可以继续生产的图文资产", "从选题进入多类型内容生成与历史记录"],
  };
  const heroPanelTitle = landingPage.querySelector<HTMLElement>("#heroPanelTitle");
  const heroPanelSub = landingPage.querySelector<HTMLElement>("#heroPanelSub");

  landingPage.querySelectorAll<HTMLElement>("[data-hero-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = button.dataset.heroTab || "";
      landingPage.querySelectorAll<HTMLElement>("[data-hero-tab]").forEach((item) => {
        const isActive = item.dataset.heroTab === selected;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-selected", String(isActive));
      });
      landingPage.querySelectorAll<HTMLElement>("[data-hero-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.heroPanel === selected);
      });
      if (heroPanelTitle) heroPanelTitle.textContent = heroCopy[selected]?.[0] || "";
      if (heroPanelSub) heroPanelSub.textContent = heroCopy[selected]?.[1] || "";
    });
  });

  const profileData: Record<string, Array<[string, string]>> = {
    brand: [
      ["定位", "高品质家庭健康品牌"],
      ["人群", "家庭健康决策者"],
      ["目标", "建立价格价值感"],
    ],
    personal: [
      ["人设", "品牌策略与内容专家"],
      ["受众", "市场与内容从业者"],
      ["目标", "持续输出专业观点"],
    ],
  };
  const profilePreview = landingPage.querySelector<HTMLElement>("#landingProfilePreview");
  landingPage.querySelectorAll<HTMLElement>("[data-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      landingPage
        .querySelectorAll<HTMLElement>("[data-profile]")
        .forEach((item) => item.classList.toggle("active", item === button));
      if (!profilePreview) return;
      profilePreview.replaceChildren(
        ...(profileData[button.dataset.profile || ""] || []).map(([label, value]) => {
          const row = document.createElement("div");
          const strong = document.createElement("strong");
          strong.textContent = label;
          row.append(strong, document.createTextNode(value));
          return row;
        }),
      );
    });
  });

  landingPage.querySelectorAll<HTMLElement>(".faq-question").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest("article");
      const isOpen = item?.classList.toggle("open") || false;
      button.setAttribute("aria-expanded", String(isOpen));
    });
  });

  const navInner = landingPage.querySelector<HTMLElement>("#landingNavInner");
  const menuButton = landingPage.querySelector<HTMLElement>("#landingMenuButton");
  menuButton?.addEventListener("click", () => {
    const isOpen = navInner?.classList.toggle("mobile-open") || false;
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });

  const navLinks = [...landingPage.querySelectorAll<HTMLAnchorElement>(".nav-links a")];
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      navInner?.classList.remove("mobile-open");
      menuButton?.setAttribute("aria-expanded", "false");
    });
  });

  landingPage.querySelectorAll<HTMLElement>("[data-auth-open]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const modal = document.getElementById("authModal");
      if (!modal) return;
      setAuthModalTab(modal, link.dataset.authOpen === "login" ? "login" : "register");
      modal.classList.add("is-open");
      modal.querySelector<HTMLInputElement>(".auth-form.auth-form-active input")?.focus();
    });
  });

  const revealItems = landingPage.querySelectorAll<HTMLElement>(".landing-reveal");
  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.1 },
    );
    revealItems.forEach((item) => revealObserver.observe(item));

    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) =>
            link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`),
          );
        });
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    landingPage.querySelectorAll("main section[id]").forEach((section) => sectionObserver.observe(section));
  } else {
    revealItems.forEach((item) => item.classList.add("visible"));
  }
}

type LandingAuthMode = "login" | "register";

function setAuthModalTab(modal: HTMLElement, mode: LandingAuthMode): void {
  modal.querySelectorAll<HTMLElement>("[data-auth-tab]").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.authTab === mode);
  });
  modal.querySelectorAll<HTMLFormElement>(".auth-form").forEach((form) => {
    const active = form.id === `${mode}Form`;
    form.classList.toggle("auth-form-active", active);
    form.hidden = !active;
  });
  modal.querySelectorAll<HTMLElement>(".auth-form-error").forEach((error) => {
    error.hidden = true;
    error.textContent = "";
  });
}

async function landingAuthRequest(path: string, body: Record<string, string>): Promise<{ user?: unknown }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as { error?: string; user?: unknown } | null;
  if (!response.ok) {
    throw new Error(String(payload?.error || `请求失败（${response.status}）`));
  }
  return payload || {};
}

function showLandingAuthError(form: HTMLFormElement, error: unknown): void {
  const node = form.querySelector<HTMLElement>(".auth-form-error");
  if (!node) return;
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}

function bindAuthModal(modal: HTMLElement): void {
  const closeButton = modal.querySelector<HTMLButtonElement>("#closeAuthModal");
  const registerForm = modal.querySelector<HTMLFormElement>("#registerForm");
  const loginForm = modal.querySelector<HTMLFormElement>("#loginForm");
  const feishuActions = modal.querySelector<HTMLElement>("#feishuLoginActions");
  const feishuButton = modal.querySelector<HTMLButtonElement>("#feishuLoginButton");
  const feishuMenu = modal.querySelector<HTMLElement>("#feishuAppMenu");
  const feishuDivider = modal.querySelector<HTMLElement>("#feishuAuthDivider");
  let feishuApps: Array<{ key: string; name: string }> = [];

  const close = () => modal.classList.remove("is-open");
  const setBusy = (form: HTMLFormElement, busy: boolean, idleText: string, busyText: string) => {
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
  };

  closeButton?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelectorAll<HTMLElement>("[data-auth-tab]").forEach((tab) => {
    tab.addEventListener("click", () => setAuthModalTab(modal, tab.dataset.authTab === "login" ? "login" : "register"));
  });

  void fetch("/api/auth/feishu/apps", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) return { apps: [] };
      return (await response.json().catch(() => ({ apps: [] }))) as { apps?: Array<{ key: string; name: string }> };
    })
    .then((payload) => {
      feishuApps = Array.isArray(payload.apps) ? payload.apps : [];
      if (!feishuApps.length) return;
      if (feishuActions) feishuActions.hidden = false;
      if (feishuDivider) feishuDivider.hidden = false;
      if (feishuApps.length > 1 && feishuMenu) {
        feishuMenu.replaceChildren(
          ...feishuApps.map((app) => {
            const option = document.createElement("button");
            option.className = "feishu-app-option";
            option.type = "button";
            option.dataset.feishuApp = app.key;
            option.textContent = app.name;
            return option;
          }),
        );
      }
    })
    .catch(() => undefined);

  feishuButton?.addEventListener("click", () => {
    if (feishuApps.length === 1) {
      window.location.href = `/api/auth/feishu/start?app=${encodeURIComponent(feishuApps[0].key)}`;
      return;
    }
    if (feishuMenu) feishuMenu.hidden = !feishuMenu.hidden;
  });
  feishuActions?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-feishu-app]");
    if (!target) return;
    const appKey = target.dataset.feishuApp || "";
    window.location.href = `/api/auth/feishu/start?app=${encodeURIComponent(appKey)}`;
  });

  registerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = Object.fromEntries(new FormData(registerForm).entries());
    setBusy(registerForm, true, "注册并进入工作台", "注册中...");
    try {
      await landingAuthRequest("/api/auth/register", {
        phone: String(formData.phone || ""),
        name: String(formData.name || ""),
        password: String(formData.password || ""),
      });
      window.location.href = "/app/";
    } catch (error) {
      showLandingAuthError(registerForm, error);
      setBusy(registerForm, false, "注册并进入工作台", "注册中...");
    }
  });

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = Object.fromEntries(new FormData(loginForm).entries());
    setBusy(loginForm, true, "登录 RedBase", "登录中...");
    try {
      await landingAuthRequest("/api/auth/login", {
        phone: String(formData.phone || ""),
        password: String(formData.password || ""),
      });
      window.location.href = "/app/";
    } catch (error) {
      showLandingAuthError(loginForm, error);
      setBusy(loginForm, false, "登录 RedBase", "登录中...");
    }
  });

  setAuthModalTab(modal, "register");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) close();
  });
}

function bindBusinessQuoteModal(modal: HTMLElement): void {
  const closeBtn = modal.querySelector<HTMLButtonElement>("#closeBusinessQuoteModal");
  const open = () => {
    modal.classList.add("is-open");
    closeBtn?.focus();
  };
  const close = () => modal.classList.remove("is-open");

  document.querySelectorAll<HTMLElement>("[data-business-quote-open]").forEach((button) => {
    button.addEventListener("click", open);
  });
  closeBtn?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      close();
    }
  });
}

// Feishu OAuth callbacks redirect back to "/?authError=..." — keep the legacy
// error copy verbatim.
function showAuthRedirectError(): void {
  const url = new URL(window.location.href);
  const error = url.searchParams.get("authError");
  if (!error) return;

  const messages: Record<string, string> = {
    feishu_config: "飞书登录暂未配置，请联系管理员。",
    feishu_denied: "你已取消飞书授权。",
    feishu_profile: "飞书账号信息不完整，请联系管理员。",
    feishu_tenant: "当前飞书账号不属于已授权企业。",
    feishu_failed: "飞书登录失败，请稍后重试。",
  };
  window.alert(messages[error] || "登录失败，请稍后重试。");
  url.searchParams.delete("authError");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

async function redirectAuthenticatedUser(): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.has("authError") || window.location.pathname !== "/") return;
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (response.ok) window.location.replace("/app/");
  } catch {
    // The landing page remains usable when the session check is unavailable.
  }
}

const root = document.getElementById("landing-root");
if (root) {
  renderLanding(root);
}
