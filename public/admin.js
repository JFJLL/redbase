const STORAGE_KEY = "redbase.sessionToken";

const state = {
  sessionToken: localStorage.getItem(STORAGE_KEY) || "",
  currentAdmin: null,
  overview: null,
  brandUserId: "all",
  usageUserId: "all",
  generationUserId: "all",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeImageSrc(value) {
  const src = String(value || "");
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) return src;
  return "";
}

function authenticatedImageSrc(value) {
  const src = safeImageSrc(value);
  if (!src || !state.sessionToken || !src.startsWith("/api/") || src.includes("token=")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}token=${encodeURIComponent(state.sessionToken)}`;
}

async function request(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.sessionToken) {
    headers["X-Session-Token"] = state.sessionToken;
  }

  const response = await fetch(url, {
    headers,
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
    }
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

async function init() {
  bindEvents();
  if (!state.sessionToken) {
    showAuth();
    return;
  }
  await loadOverview();
}

function bindEvents() {
  document.getElementById("adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById("adminLoginError");
    errorBox.textContent = "";
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.sessionToken = result.sessionToken;
      localStorage.setItem(STORAGE_KEY, state.sessionToken);
      await loadOverview();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });

  document.getElementById("adminLogoutButton").addEventListener("click", async () => {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn(error.message);
    }
    clearSession();
    showAuth();
  });

  document.getElementById("refreshAdminButton").addEventListener("click", () => loadOverview());
  document.getElementById("usageUserFilter").addEventListener("change", (event) => {
    state.usageUserId = event.target.value;
    renderUsageRows();
  });
  document.getElementById("brandUserFilter").addEventListener("change", (event) => {
    state.brandUserId = event.target.value;
    renderBrandArchiveList();
  });
  document.getElementById("generationUserFilter").addEventListener("change", (event) => {
    state.generationUserId = event.target.value;
    renderGenerationList();
  });
  document.getElementById("creditForm").addEventListener("submit", submitCreditForm);
  document.getElementById("adminUserRows").addEventListener("click", handleUserRowAction);

  const modal = document.getElementById("generationModal");
  document.getElementById("closeGenerationModal").addEventListener("click", closeGenerationModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeGenerationModal();
  });
}

async function handleUserRowAction(event) {
  const deleteButton = event.target.closest("[data-delete-user]");
  if (!deleteButton) return;

  const userId = Number(deleteButton.dataset.deleteUser);
  const user = (state.overview?.users || []).find((item) => item.id === userId);
  if (!user) return;
  if (state.currentAdmin?.id === userId) {
    alert("不能删除当前登录的管理员账号。");
    return;
  }

  const message = [
    `确定删除用户「${user.name}」吗？`,
    `手机号：${user.phone}`,
    `这会删除该用户的品牌档案、生成记录、额度流水、登录状态和已上传产品图文件。`,
    `当前额度 ${formatNumber(user.currentCredits)}，生成次数 ${formatNumber(user.generationCount)}，品牌数 ${formatNumber(user.brandCount)}。`,
  ].join("\n");
  if (!confirm(message)) return;

  try {
    const result = await request(`/api/admin/users/${userId}`, { method: "DELETE" });
    state.overview = result.overview;
    if (state.brandUserId === String(userId)) state.brandUserId = "all";
    if (state.usageUserId === String(userId)) state.usageUserId = "all";
    if (state.generationUserId === String(userId)) state.generationUserId = "all";
    renderAll();
  } catch (error) {
    alert(error.message);
  }
}

async function submitCreditForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await request(`/api/admin/users/${payload.userId}/credits`, {
      method: "POST",
      body: JSON.stringify({
        amount: payload.amount,
        note: payload.note,
      }),
    });
    state.overview = result.overview;
    form.reset();
    renderAll();
  } catch (error) {
    alert(error.message);
  }
}

async function loadOverview() {
  try {
    const [session, overview] = await Promise.all([request("/api/session"), request("/api/admin/overview")]);
    state.currentAdmin = session.user;
    state.overview = overview;
    showShell();
    renderAll();
  } catch (error) {
    document.getElementById("adminLoginError").textContent = error.message;
    showAuth();
  }
}

function clearSession() {
  state.sessionToken = "";
  state.currentAdmin = null;
  state.overview = null;
  localStorage.removeItem(STORAGE_KEY);
}

function showAuth() {
  document.getElementById("adminAuth").classList.remove("is-hidden");
  document.getElementById("adminShell").classList.add("is-hidden");
}

function showShell() {
  document.getElementById("adminAuth").classList.add("is-hidden");
  document.getElementById("adminShell").classList.remove("is-hidden");
  document.getElementById("adminUserName").textContent = state.currentAdmin?.name || "管理员";
}

function renderAll() {
  renderStats();
  renderFilters();
  renderUsers();
  renderBrandArchiveList();
  renderUsageRows();
  renderGenerationList();
}

function renderStats() {
  const stats = state.overview?.stats || {};
  const cards = [
    ["用户数", stats.userCount],
    ["品牌数", stats.brandCount],
    ["生成次数", stats.generationCount],
    ["总消耗使用额度", stats.totalConsumedTokens],
    ["当前总额度", stats.currentCreditsTotal],
  ];
  document.getElementById("adminStats").innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <div class="stat-label">${escapeHtml(label)}</div>
          <div class="stat-value">${formatNumber(value)}</div>
        </article>
      `,
    )
    .join("");
}

function renderFilters() {
  const users = state.overview?.users || [];
  const options = [`<option value="all">全部用户</option>`]
    .concat(users.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} · ${escapeHtml(user.phone)}</option>`))
    .join("");
  document.getElementById("usageUserFilter").innerHTML = options;
  document.getElementById("usageUserFilter").value = state.usageUserId;
  document.getElementById("brandUserFilter").innerHTML = options;
  document.getElementById("brandUserFilter").value = state.brandUserId;
  document.getElementById("generationUserFilter").innerHTML = options;
  document.getElementById("generationUserFilter").value = state.generationUserId;
  document.getElementById("creditUserSelect").innerHTML = users
    .map((user) => `<option value="${user.id}">${escapeHtml(user.name)} · ${escapeHtml(user.phone)} · 当前 ${formatNumber(user.currentCredits)} 额度</option>`)
    .join("");
}

function renderUsers() {
  const users = state.overview?.users || [];
  document.getElementById("adminUserRows").innerHTML = users.length
    ? users
        .map(
          (user) => `
            <tr>
              <td>
                <div class="strong">${escapeHtml(user.name)}</div>
                <div class="muted">${escapeHtml(user.phone)}</div>
              </td>
              <td>
                <span class="badge">${escapeHtml(user.accountType === "yimei" ? "易美" : "客户")}</span>
                ${user.department ? `<div class="muted">${escapeHtml(user.department)}</div>` : ""}
              </td>
              <td class="strong">${formatNumber(user.currentCredits)}</td>
              <td class="token-negative">${formatNumber(user.consumedTokens)}</td>
              <td class="token-positive">${formatNumber(user.grantedTokens)}</td>
              <td>${formatNumber(user.generationCount)}</td>
              <td>${formatNumber(user.brandCount)}</td>
              <td>${formatDate(user.lastActiveAt || user.createdAt)}</td>
              <td>
                <button class="danger-btn small-action" data-delete-user="${user.id}" type="button">删除</button>
              </td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="9" class="muted">暂无用户。</td></tr>`;
}

function renderBrandArchiveList() {
  const brands = filterByUser(state.overview?.brands || [], state.brandUserId);
  const root = document.getElementById("brandArchiveList");
  if (!root) return;
  if (!brands.length) {
    root.innerHTML = `<div class="muted">暂无品牌档案。</div>`;
    return;
  }

  root.innerHTML = brands
    .map(
      (brand) => `
        <article class="admin-brand-card">
          <div class="admin-brand-head">
            <div>
              <div class="generation-meta">
                <span class="badge">${escapeHtml(brand.industry || "未分类")}</span>
                ${brand.hasLogo ? `<span class="badge">已上传 Logo</span>` : `<span class="badge">未上传 Logo</span>`}
              </div>
              <h3>${escapeHtml(brand.name || "未命名品牌")}</h3>
              <div class="muted">${escapeHtml(brand.user?.name || "-")} · ${escapeHtml(brand.user?.phone || "")}</div>
            </div>
            <div class="muted">趋势 ${formatNumber(brand.trendCount)} · 分析 ${formatNumber(brand.analysisCount)}</div>
          </div>
          <div class="admin-brand-grid">
            <div><strong>目标受众</strong><p>${escapeHtml(brand.audience || "-")}</p></div>
            <div><strong>品牌 Logo</strong><p>${escapeHtml(brand.logoName || "未上传")}</p></div>
            <div><strong>品牌介绍</strong><p>${escapeHtml(brand.description || "-")}</p></div>
            <div><strong>产品介绍</strong><p>${escapeHtml(brand.product || "-")}</p></div>
            <div><strong>运营目标</strong><p>${escapeHtml(brand.goal || "-")}</p></div>
            <div><strong>品牌资料库</strong><p>${escapeHtml(brand.knowledgeBase || "-")}</p></div>
          </div>
          ${
            Array.isArray(brand.assetTags) && brand.assetTags.length
              ? `<div class="admin-brand-tags">${brand.assetTags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}</div>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

function renderUsageRows() {
  const events = filterByUser(state.overview?.usageEvents || [], state.usageUserId);
  document.getElementById("usageRows").innerHTML = events.length
    ? events
        .map((event) => {
          const delta = Number(event.tokenDelta || 0);
          return `
            <tr>
              <td>${formatDate(event.createdAt)}</td>
              <td>
                <div class="strong">${escapeHtml(event.userName || "-")}</div>
                <div class="muted">${escapeHtml(event.userPhone || "")}</div>
              </td>
              <td>
                <div class="strong">${escapeHtml(event.actionLabel || event.actionType)}</div>
                ${event.adminUserName ? `<div class="muted">操作人：${escapeHtml(event.adminUserName)}</div>` : ""}
              </td>
              <td class="${delta >= 0 ? "token-positive" : "token-negative"}">${delta >= 0 ? "+" : ""}${formatNumber(delta)}</td>
              <td>
                ${event.channelLabel ? `<span class="badge">${escapeHtml(event.channelLabel)}</span>` : ""}
                <div>${escapeHtml(event.brandName || event.summary || "-")}</div>
                ${event.trendTitle ? `<div class="muted">${escapeHtml(event.trendTitle)}</div>` : ""}
                ${event.ideaTitle ? `<div class="muted">${escapeHtml(event.ideaTitle)}</div>` : ""}
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">暂无流水。</td></tr>`;
}

function renderGenerationList() {
  const generations = filterByUser(state.overview?.generations || [], state.generationUserId);
  const root = document.getElementById("generationList");
  if (!generations.length) {
    root.innerHTML = `<div class="muted">暂无生成内容。</div>`;
    return;
  }

  root.innerHTML = generations
    .map((item) => {
      const preview = getGenerationPreview(item);
      return `
        <article class="generation-card">
          <div class="generation-preview">${preview ? `<img src="${authenticatedImageSrc(preview)}" alt="${escapeHtml(item.cardTitle)}" />` : ""}</div>
          <div>
            <div class="generation-meta">
              <span class="badge">${escapeHtml(item.channelLabel)}</span>
              <span class="badge">${formatNumber(item.tokenCost)} 使用额度</span>
            </div>
            <h3 class="generation-title">${escapeHtml(item.cardTitle || item.ideaTitle || "生成内容")}</h3>
            <div class="generation-copy">
              ${escapeHtml(item.user?.name || "-")} · ${escapeHtml(item.brandName)} · ${formatDate(item.createdAt)}
            </div>
            <div class="generation-copy">${escapeHtml(item.summary || item.ideaTitle || "")}</div>
            <button class="link-btn" data-generation-id="${item.id}" type="button">查看内容详情</button>
          </div>
        </article>
      `;
    })
    .join("");

  root.querySelectorAll("[data-generation-id]").forEach((button) => {
    button.addEventListener("click", () => openGenerationModal(Number(button.dataset.generationId)));
  });
}

function openGenerationModal(id) {
  const item = (state.overview?.generations || []).find((generation) => generation.id === id);
  if (!item) return;
  document.getElementById("generationModalKicker").textContent = `${item.channelLabel} · ${formatNumber(item.tokenCost)} 使用额度`;
  document.getElementById("generationModalTitle").textContent = item.cardTitle || item.ideaTitle || "内容详情";
  document.getElementById("generationDetail").innerHTML = renderGenerationDetail(item);
  document.getElementById("generationModal").classList.add("is-open");
}

function closeGenerationModal() {
  document.getElementById("generationModal").classList.remove("is-open");
}

function renderGenerationDetail(item) {
  const payload = item.payload || {};
  const imageHtml = renderDetailImages(item);
  const contentHtml = renderPayloadContent(item, payload);
  return `
    <div class="detail-grid">
      <section class="detail-block">
        <h3>基础信息</h3>
        <p><strong>用户：</strong>${escapeHtml(item.user?.name || "-")} ${escapeHtml(item.user?.phone || "")}</p>
        <p><strong>品牌：</strong>${escapeHtml(item.brandName)}</p>
        <p><strong>趋势：</strong>${escapeHtml(item.trendTitle)}</p>
        <p><strong>选题：</strong>${escapeHtml(item.ideaTitle)}</p>
        <p><strong>时间：</strong>${formatDate(item.createdAt)}</p>
      </section>
      <section class="detail-block">
        <h3>消耗</h3>
        <p><strong>本次生成消耗：</strong>${formatNumber(item.tokenCost)} 使用额度</p>
        <p><strong>流水 ID：</strong>${escapeHtml(item.usageEventId || "-")}</p>
        <p><strong>类型：</strong>${escapeHtml(item.type)}</p>
      </section>
      ${imageHtml}
      ${contentHtml}
      <section class="detail-block">
        <h3>完整 Payload</h3>
        <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
      </section>
    </div>
  `;
}

function renderDetailImages(item) {
  const payload = item.payload || {};
  if (item.type === "xhsCarousel") {
    const slides = Array.isArray(payload.slides) ? payload.slides : [];
    return `
      <section class="detail-block">
        <h3>生成图片</h3>
        <div class="detail-image-grid">
          ${slides.map((slide) => `<img src="${authenticatedImageSrc(slide.previewUrl || slide.imageUrl)}" alt="${escapeHtml(slide.title || "")}" />`).join("")}
        </div>
      </section>
    `;
  }
  const image = authenticatedImageSrc(payload.previewUrl || payload.imageUrl || item.previewUrl);
  return `
    <section class="detail-block">
      <h3>生成图片</h3>
      ${image ? `<img class="detail-main-image" src="${image}" alt="${escapeHtml(item.cardTitle)}" />` : `<p class="muted">暂无图片地址。</p>`}
    </section>
  `;
}

function renderPayloadContent(item, payload) {
  if (item.type === "moments") {
    return `
      <section class="detail-block">
        <h3>朋友圈内容</h3>
        <p><strong>朋友圈文案：</strong>${escapeHtml(payload.caption || "")}</p>
        <p><strong>视觉方向：</strong>${escapeHtml(payload.visualDirection || "")}</p>
        <p><strong>风格：</strong>${escapeHtml(payload.style || "")}</p>
        <p><strong>构图：</strong>${escapeHtml(payload.composition || "")}</p>
        <p><strong>Prompt：</strong>${escapeHtml(payload.prompt || "")}</p>
      </section>
    `;
  }

  if (item.type === "wechat") {
    return `
      <section class="detail-block">
        <h3>公众号长图内容</h3>
        <p><strong>发布标题：</strong>${escapeHtml(payload.publishTitle || "")}</p>
        <p><strong>导语：</strong>${escapeHtml(payload.intro || "")}</p>
        <p><strong>长图定位：</strong>${escapeHtml(payload.positioning || "")}</p>
        <p><strong>CTA：</strong>${escapeHtml(payload.cta || "")}</p>
        <p><strong>Prompt：</strong>${escapeHtml(payload.prompt || "")}</p>
      </section>
    `;
  }

  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  return `
    <section class="detail-block">
      <h3>小红书组图内容</h3>
      <p><strong>发布标题：</strong>${escapeHtml(payload.publishTitle || "")}</p>
      <p><strong>发布文案：</strong>${escapeHtml(payload.publishCaption || "")}</p>
      <p><strong>组图说明：</strong>${escapeHtml(payload.caption || "")}</p>
      <ol>
        ${slides.map((slide) => `<li><strong>${escapeHtml(slide.pageLabel || "")} ${escapeHtml(slide.title || "")}</strong>：${escapeHtml(slide.copy || "")}</li>`).join("")}
      </ol>
    </section>
  `;
}

function filterByUser(items, userId) {
  if (userId === "all") return items;
  return items.filter((item) => Number(item.userId || item.ownerUserId || item.user?.id) === Number(userId));
}

function getGenerationPreview(item) {
  if (item.previewUrl) return item.previewUrl;
  const slides = Array.isArray(item.payload?.slides) ? item.payload.slides : [];
  return slides[0]?.previewUrl || slides[0]?.imageUrl || "";
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "0";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

init();
