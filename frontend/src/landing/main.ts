import "./landing.css";
import { BUSINESS_MODAL_HTML, LANDING_HTML } from "./template";

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

  root.replaceChildren(page, businessModal);
  bindLandingExperience(page);
  bindBusinessQuoteModal(businessModal);
  showAuthRedirectError();
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

const root = document.getElementById("landing-root");
if (root) {
  renderLanding(root);
}
