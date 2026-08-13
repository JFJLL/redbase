import {
  DEFAULT_TREND_BUCKETS,
  DEFAULT_TREND_MODE,
  IMAGE_TASK_MAX_CONCURRENCY,
  LEGACY_TREND_BUCKET_KEYS,
  MAX_BRAND_PROFILE_CHARS,
  MAX_SELECTED_PRODUCT_IMAGES,
  MAX_SELECTED_PRODUCT_IMAGE_BYTES,
  MAX_SINGLE_UPLOAD_IMAGE_BYTES,
  PENDING_IMAGE_TASKS_KEY,
  SIDEBAR_COLLAPSED_KEY,
} from "./js/config.js";
import { state } from "./js/state.js";
import { configureApiClient, isStaleSessionRequest, pollImageJob, request } from "./js/api-client.js";
import {
  authenticatedImageSrc,
  escapeHtml,
  fileToDataUrl,
  formatFileSize,
  formatImageName,
  productImageSrc,
  safeImageSrc,
  showToast,
} from "./js/dom-utils.js";
import {
  canGoNext,
  canGoPrevious,
  clampImageIndex,
  getNextImageIndex,
  getPreviousImageIndex,
} from "./js/excellent-image-nav.js";
import {
  applyExcellentListError,
  applyExcellentListResult,
  applyExcellentRefreshError,
  applyExcellentRefreshResult,
  commitExcellentDraftFilters,
  excellentContentCacheKey,
  excellentFiltersAreDirty,
  excellentRefreshResponseMatches,
  rollbackExcellentDraftFilters,
} from "./js/excellent-list-state.js";
import {
  createExcellentRemixState,
  REMIX_CONTENT_MODES,
  REMIX_ASSET_MODES,
  MAX_REMIX_PRODUCT_IMAGES,
  toggleLearningFocus,
  invalidateAfterInputChange,
  canGenerateFusionPlan,
  canSubmitExcellentRemix,
  buildFusionRequestBody,
  buildGenerationPayload,
  buildExistingIdeaKey,
  parseExistingIdeaKey,
  defaultLearningFocusForAnalysis,
  isPlatformDefaultVisual,
} from "./js/excellent-remix-state.js";
import {
  captureRemixRequestToken,
  nextRemixRequestId,
  isRemixResponseCurrent,
} from "./js/excellent-remix-request.js";
import {
  fetchRemixAnalysis,
  fetchContentDirections,
  fetchFusionPlan,
  fetchBrandRemixIdeas,
  fetchBrandProductImages,
  claimProductImageToBrand,
  previewExcellentRemix,
  generateExcellentRemixSlide,
  completeExcellentRemix,
} from "./js/excellent-remix-api.js";
import {
  renderExcellentRemixBodyHtml,
  renderBrandProductPickerHtml,
} from "./js/excellent-remix-view.js";

let sessionEpoch = 0;
let excellentRemixInstanceSequence = 0;

function assertSessionEpoch(expectedEpoch) {
  if (expectedEpoch === sessionEpoch) return;
  const error = new Error("请求已因登录状态变化而取消");
  error.code = "STALE_SESSION_REQUEST";
  throw error;
}

configureApiClient({
  onUnauthorized: clearSession,
  getRequestContext: () => sessionEpoch,
  isRequestContextCurrent: (requestEpoch) => requestEpoch === sessionEpoch,
});

let openBrandEditor = () => {};
let pendingBrandDeleteId = null;
let historyFilterTimer = null;
let feishuLoginApps = [];
let historyImageSignatureRefreshInFlight = null;
const dashboardScrollPositions = new Map();
const retriedHistoryImagePaths = new Set();
const brandDetailRequests = new Map();
const trendAnalysisRequestIds = new Map();
const WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY = "redbase:wechat-aspect-ratio-warning-disabled";
const IMAGE_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"];
const KNOWN_ASPECT_RATIOS = new Set(["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "21:9", "9:21", "16:9"]);
const SMART_ASPECT_RATIO_DEFAULTS = Object.freeze({ moments: "3:4", wechat: "9:21", xhsCarousel: "3:4", styleImage: "3:4" });
const XHS_CREATIVE_STYLE_OPTIONS = Object.freeze([
  { value: "auto", label: "智能匹配", description: "根据选题内容自动选择更合适的视觉路线" },
  { value: "lifestyle", label: "真实生活方式", description: "自然光、真实使用场景与轻松抓拍感" },
  { value: "editorial", label: "杂志编辑感", description: "克制高级，适合审美与品牌内容" },
  { value: "native_note", label: "原生笔记感", description: "便签、圈画和真实记录，弱化广告感" },
  { value: "knowledge", label: "专业知识卡", description: "步骤清晰，适合教程、科普与方法论" },
  { value: "checklist", label: "清单攻略型", description: "编号、清单和收藏提示，适合攻略避坑" },
  { value: "review", label: "产品测评型", description: "细节特写、对比和真实使用证据" },
  { value: "mood", label: "情绪氛围型", description: "少文字、电影感，适合故事与情绪表达" },
  { value: "collage", label: "拼贴灵感型", description: "多图拼贴、纸张肌理和灵感板气质" },
  { value: "minimal_brand", label: "极简品牌型", description: "单主体、统一品牌色与精致留白" },
]);
const WECHAT_TEMPLATE_OPTIONS = Object.freeze([
  { value: "auto", label: "智能匹配", description: "根据文章主题自动选择长图结构" },
  { value: "editorial", label: "深度观点", description: "行业洞察、品牌观点与趋势解读" },
  { value: "tutorial", label: "干货教程", description: "步骤方法、操作指南和科普内容" },
  { value: "report", label: "行业报告", description: "数据卡片、趋势拆解和专业结论" },
  { value: "story", label: "品牌故事", description: "人物、时间线和品牌幕后内容" },
  { value: "product", label: "产品说明", description: "从真实痛点与场景解释产品价值" },
  { value: "minimal", label: "极简长图", description: "少字强观点，适合封面式传播" },
]);

const HISTORY_TYPE_LABELS = new Map([
  ["moments", "朋友圈图文"],
  ["wechat", "公众号长图"],
  ["xhsCarousel", "小红书组图"],
  ["styleImage", "一键风格化"],
  ["imageEdit", "历史改图"],
]);

async function init() {
  bindLandingEntry();
  bindLandingExperience();
  bindSidebarControls();
  bindAccountCenterModal();
  bindSidebarTabs();
  bindTabJump();
  bindBrandModal();
  bindPersonalMaterialForm();
  bindBrandDeleteModal();
  bindImageModal();
  bindProductImageLibraryModal();
  bindAuthModal();
  bindBusinessQuoteModal();
  bindAnalysisButton();
  bindXhsCategorySelector();
  bindExcellentContentLibrary();
  bindIdeaPromptActions();
  bindHistoryFilters();
  bindLogout();
  showAuthRedirectError();
  await restoreSession();
}

async function uploadProductImage(file) {
  const uploadEpoch = sessionEpoch;
  const dataUrl = await fileToDataUrl(file);
  assertSessionEpoch(uploadEpoch);
  const result = await request("/api/product-images", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      dataUrl,
    }),
  });
  upsertProductImageLibrary(result.image);
  return result;
}

async function uploadBrandLogo(brandId, file) {
  const uploadEpoch = sessionEpoch;
  const dataUrl = await fileToDataUrl(file);
  assertSessionEpoch(uploadEpoch);
  const result = await request(`/api/brands/${brandId}/logo`, {
    method: "POST",
    body: JSON.stringify({
      logoName: file.name,
      logoDataUrl: dataUrl,
    }),
  });
  replaceBrand(result.brand);
  return result.brand;
}

async function loadProductImages() {
  if (!state.sessionToken) return;
  const result = await request("/api/product-images");
  state.productImageLibrary = result.images || [];
}

async function deleteProductImageAsset(imageId) {
  await request(`/api/product-images/${imageId}`, { method: "DELETE" });
  state.productImageLibrary = state.productImageLibrary.filter((image) => image.id !== imageId);
  for (const [key, value] of Object.entries(state.productImages)) {
    const nextImages = normalizeSelectedProductImages(value).filter((image) => image.id !== imageId);
    if (!nextImages.length) {
      delete state.productImages[key];
    } else {
      state.productImages[key] = {
        ...value,
        images: nextImages,
        useImage: value?.useImage !== false,
      };
    }
  }
}

function upsertProductImageLibrary(image) {
  if (!image) return;
  state.productImageLibrary = [image, ...state.productImageLibrary.filter((item) => item.id !== image.id)];
}

function normalizeSelectedProductImages(selection) {
  if (!selection) return [];
  if (Array.isArray(selection.images)) {
    return selection.images.filter(Boolean);
  }
  if (selection.id || selection.dataUrl || selection.url) {
    return [selection];
  }
  return [];
}

function getProductSelection(ideaIndex) {
  const key = getIdeaProductKey(ideaIndex);
  const current = state.productImages[key];
  const images = normalizeSelectedProductImages(current);
  return {
    images,
    useImage: images.length > 0 && current?.useImage !== false,
  };
}

function setProductSelection(ideaIndex, images, useImage = true) {
  const key = getIdeaProductKey(ideaIndex);
  const nextImages = dedupeSelectedProductImages(images);
  if (!nextImages.length) {
    delete state.productImages[key];
    return;
  }
  state.productImages[key] = {
    images: nextImages,
    useImage,
  };
}

function dedupeSelectedProductImages(images) {
  const seen = new Set();
  return (images || []).filter((image) => {
    const key = image.id ? `id:${image.id}` : `name:${image.fileName || image.name || ""}:${image.url || image.dataUrl || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addProductImageForIdea(ideaIndex, image) {
  if (!image) return;
  const selection = getProductSelection(ideaIndex);
  if (selection.images.some((item) => Number(item.id) === Number(image.id))) return;
  if (!canAddProductImages(ideaIndex, [image])) return;
  setProductSelection(
    ideaIndex,
    [
      ...selection.images,
      {
        id: image.id,
        fileName: image.originalName || image.fileName || image.name || "产品图",
        url: image.url,
        dataUrl: image.dataUrl,
        sizeBytes: Number(image.sizeBytes || image.size || 0),
      },
    ],
    true,
  );
}

function toggleProductImageForIdea(ideaIndex, image) {
  const selection = getProductSelection(ideaIndex);
  const exists = selection.images.some((item) => Number(item.id) === Number(image.id));
  if (exists) {
    setProductSelection(
      ideaIndex,
      selection.images.filter((item) => Number(item.id) !== Number(image.id)),
      selection.useImage,
    );
    return;
  }
  if (!canAddProductImages(ideaIndex, [image])) return;
  addProductImageForIdea(ideaIndex, image);
}

function isProductImageSelectedForIdea(ideaIndex, imageId) {
  return getProductSelection(ideaIndex).images.some((image) => Number(image.id) === Number(imageId));
}

function getImageSizeBytes(image) {
  return Number(image?.sizeBytes || image?.file?.size || image?.size || 0);
}

function getSelectionTotalBytes(images) {
  return (images || []).reduce((sum, image) => sum + getImageSizeBytes(image), 0);
}

function canAddProductImages(ideaIndex, candidates) {
  const selection = getProductSelection(ideaIndex);
  const existingKeys = new Set(selection.images.map((image) => (image.id ? `id:${image.id}` : `raw:${image.fileName || image.name}:${image.dataUrl || image.url || ""}`)));
  const nextCandidates = (candidates || []).filter((image) => {
    const key = image.id ? `id:${image.id}` : `raw:${image.fileName || image.name}:${image.dataUrl || image.url || ""}`;
    return !existingKeys.has(key);
  });
  const nextCount = selection.images.length + nextCandidates.length;
  if (nextCount > MAX_SELECTED_PRODUCT_IMAGES) {
    alert(`产品参考图最多选择 ${MAX_SELECTED_PRODUCT_IMAGES} 张。请删除已有图片后重新上传或选择。`);
    return false;
  }
  const nextBytes = getSelectionTotalBytes(selection.images) + getSelectionTotalBytes(nextCandidates);
  if (nextBytes > MAX_SELECTED_PRODUCT_IMAGE_BYTES) {
    alert(`产品参考图总大小最多 ${formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES)}。当前选择约 ${formatFileSize(getSelectionTotalBytes(selection.images))}，新增后会超过上限，请压缩图片或删除已有图片后重新上传。`);
    return false;
  }
  return true;
}

function validateProductUploadFiles(ideaIndex, files) {
  const oversizedFile = (files || []).find((file) => file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES);
  if (oversizedFile) {
    alert(`单张产品参考图最多上传 ${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)}。${oversizedFile.name} 过大，请压缩图片后重新上传。`);
    return false;
  }
  const candidates = (files || []).map((file) => ({ file, sizeBytes: file.size, fileName: file.name }));
  return canAddProductImages(ideaIndex, candidates);
}

function validateSingleReferenceFile(file, label) {
  if (!file) return false;
  if (file.size > MAX_SINGLE_UPLOAD_IMAGE_BYTES) {
    alert(`${label}最多上传 ${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)}。请压缩图片后重新上传。`);
    return false;
  }
  return true;
}

function readPendingImageTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_IMAGE_TASKS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((task) => task && typeof task === "object" && task.id) : [];
  } catch (error) {
    return [];
  }
}

function writePendingImageTasks(tasks) {
  localStorage.setItem(PENDING_IMAGE_TASKS_KEY, JSON.stringify(tasks.slice(0, 30)));
}

function addPendingImageTask(task) {
  if (!task?.id || !state.currentUser?.id) return;
  const tasks = readPendingImageTasks().filter((item) => item.id !== task.id);
  writePendingImageTasks([
    {
      ...task,
      userId: state.currentUser.id,
      createdAt: task.createdAt || Date.now(),
    },
    ...tasks,
  ]);
}

function removePendingImageTask(taskId) {
  writePendingImageTasks(readPendingImageTasks().filter((task) => task.id !== taskId));
}

function getCurrentUserPendingImageTasks() {
  const userId = state.currentUser?.id;
  if (!userId) return [];
  return readPendingImageTasks().filter((task) => task.userId === userId);
}

function updatePendingImageTask(taskId, updates) {
  writePendingImageTasks(readPendingImageTasks().map((task) => (task.id === taskId ? { ...task, ...updates } : task)));
}

async function resumePendingImageTasks() {
  if (state.resumingImageTasks || !state.sessionToken || !state.currentUser) return;
  const resumeEpoch = sessionEpoch;
  const tasks = getCurrentUserPendingImageTasks();
  if (!tasks.length) return;

  state.resumingImageTasks = true;
  showToast(`发现 ${tasks.length} 个未完成图片任务，正在后台恢复。`);
  try {
    for (const task of tasks) {
      if (resumeEpoch !== sessionEpoch) return;
      await resumePendingImageTask(task);
    }
  } finally {
    if (resumeEpoch === sessionEpoch) {
      state.resumingImageTasks = false;
    }
  }
}

async function resumePendingImageTask(task) {
  try {
    if (task.type === "xhsCarousel") {
      await resumeXhsCarouselTask(task);
      return;
    }

    if (!task.jobId) {
      removePendingImageTask(task.id);
      return;
    }
    await pollImageJob(task.jobId);
    await refreshGenerationHistoryAfterGeneration();
    removePendingImageTask(task.id);
    showToast("一个历史图片任务已恢复完成。");
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    removePendingImageTask(task.id);
    showToast(`历史图片任务恢复失败：${error.message}`);
  }
}

async function resumeXhsCarouselTask(task) {
  const slideJobs = Array.isArray(task.slideJobs) ? task.slideJobs : [];
  const pack = task.carouselPack || {};
  if (!task.brandId || !task.trendId || task.ideaIndex == null || !slideJobs.length) {
    removePendingImageTask(task.id);
    return;
  }

  const generatedSlides = Array.isArray(pack.slides) ? [...pack.slides] : [];
  for (const slideJob of slideJobs) {
    if (!slideJob?.jobId) continue;
    const slideIndex = Number(slideJob.slideIndex);
    if (generatedSlides[slideIndex]?.imageUrl || generatedSlides[slideIndex]?.previewUrl) continue;
    const imageConcept = await pollImageJob(slideJob.jobId);
    generatedSlides[slideIndex] = {
      ...(generatedSlides[slideIndex] || {}),
      previewUrl: imageConcept.imageUrl || imageConcept.previewUrl,
      imageUrl: imageConcept.imageUrl || imageConcept.previewUrl,
    };
    updatePendingImageTask(task.id, { carouselPack: { ...pack, slides: generatedSlides } });
  }

  const carouselPack = { ...pack, slides: generatedSlides };
  const completeResult = await request(
    `/api/brands/${task.brandId}/trends/${task.trendId}/ideas/${task.ideaIndex}/xhs-carousel/complete`,
    {
      method: "POST",
      body: JSON.stringify({ carouselPack, creditEventId: task.creditEventId }),
    },
  );
  updateCurrentUser(completeResult.user);
  await refreshGenerationHistoryAfterGeneration();
  removePendingImageTask(task.id);
  showToast("一个历史小红书组图任务已恢复完成。");
}

function bindSidebarControls() {
  const toggleButton = document.getElementById("sidebarToggleButton");
  if (!toggleButton) return;

  toggleButton.addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    saveSidebarState();
    renderSidebarState();
  });

  renderSidebarState();
}

function saveSidebarState() {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(state.sidebarCollapsed));
}

function renderSidebarState() {
  const dashboard = document.querySelector(".page-dashboard");
  const toggleButton = document.getElementById("sidebarToggleButton");
  if (!dashboard || !toggleButton) return;

  dashboard.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  toggleButton.title = state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  const label = toggleButton.querySelector(".sidebar-toggle-label");
  const icon = toggleButton.querySelector(".sidebar-toggle-icon");
  if (label) label.textContent = state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  if (icon) {
    icon.textContent = state.sidebarCollapsed ? "›" : "‹";
    icon.dataset.icon = icon.textContent;
  }
}

function bindAccountCenterModal() {
  const modal = document.getElementById("accountCenterModal");
  const openButton = document.getElementById("accountCenterButton");
  const closeButton = document.getElementById("closeAccountCenterModal");
  if (!modal) return;

  openButton?.addEventListener("click", () => {
    renderAccountCenter();
    modal.classList.add("is-open");
  });
  closeButton?.addEventListener("click", closeAccountCenterModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeAccountCenterModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeAccountCenterModal();
    }
  });
}

function closeAccountCenterModal() {
  document.getElementById("accountCenterModal")?.classList.remove("is-open");
}

function renderAccountCenter() {
  const account = document.getElementById("accountCenterAccount");
  const expiry = document.getElementById("accountCenterExpiry");
  const packageName = document.getElementById("accountCenterPackage");
  const credits = document.getElementById("accountCenterCredits");
  const sidebarCredits = document.getElementById("sidebarCreditLink");
  const user = state.currentUser;
  if (!account || !expiry || !packageName) return;

  account.textContent = firstTextValue(user?.phone, user?.name) || "-";
  expiry.textContent = getAccountPackageExpiry(user);
  packageName.textContent = getAccountPackageName(user);
  const creditText = Number.isFinite(Number(user?.credits)) ? `${Number(user.credits)}` : "-";
  if (credits) credits.textContent = creditText;
  if (sidebarCredits) sidebarCredits.textContent = `${creditText} 积分`;
}

function showRechargeToast(message) {
  document.querySelectorAll(".credit-shortage-toast").forEach((item) => item.remove());
  const notice = document.createElement("div");
  notice.className = "credit-shortage-toast";
  notice.setAttribute("role", "alert");
  notice.innerHTML = `<span>${escapeHtml(message || "当前积分不足，请先充值后再继续。")}</span><a href="/app/billing">立即充值</a>`;
  document.body.appendChild(notice);
}

window.addEventListener("redbase:insufficient-credits", (event) => {
  showRechargeToast(event.detail?.message);
});

function getAccountPackageName(user) {
  const subscription = user?.subscription || {};
  const packageInfo = user?.package || {};
  const planInfo = user?.plan || {};
  const directPlan = typeof user?.plan === "string" ? user.plan : "";
  const directPackage = typeof user?.package === "string" ? user.package : "";
  const name = firstTextValue(
    user?.packageName,
    user?.planName,
    user?.currentPackage,
    directPackage,
    directPlan,
    subscription.packageName,
    subscription.planName,
    packageInfo.name,
    packageInfo.title,
    planInfo.name,
    planInfo.title,
  );
  return name || "未开通";
}

function getAccountPackageExpiry(user) {
  const subscription = user?.subscription || {};
  const packageInfo = user?.package || {};
  const planInfo = user?.plan || {};
  const rawExpiry = firstTextValue(
    user?.packageExpiry,
    user?.packageExpiresAt,
    user?.planExpiry,
    user?.planExpiresAt,
    user?.subscriptionExpiry,
    user?.subscriptionExpiresAt,
    subscription.expiresAt,
    subscription.expiry,
    subscription.endDate,
    packageInfo.expiresAt,
    packageInfo.expiry,
    planInfo.expiresAt,
    planInfo.expiry,
  );
  return rawExpiry ? formatAccountDate(rawExpiry) : "-";
}

function firstTextValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

function formatAccountDate(value) {
  const text = String(value || "").trim();
  const timestamp = /^\d+$/.test(text) ? Number(text) : NaN;
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp > 100000000000 ? timestamp : timestamp * 1000)
    : new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function bindLandingEntry() {
  document.querySelectorAll("[data-auth-open]").forEach((node) => {
    node.addEventListener("click", () => {
      openAuthModal(node.dataset.authOpen || "register");
      if (node.dataset.dashboardTab) {
        state.currentTab = node.dataset.dashboardTab;
      }
    });
  });
}

function bindLandingExperience() {
  const landingPage = document.querySelector(".page-landing");
  if (!landingPage) return;

  const heroCopy = {
    trend: ["值得跟进的内容机会", "从趋势信号中筛选与品牌真正相关的方向"],
    excellent: ["可以学习的优秀内容", "查看热门内容并提取结构与表达方式"],
    idea: ["可以直接执行的内容方向", "把品牌、趋势和内容参考变成结构化选题"],
    generate: ["可以继续生产的图文资产", "从选题进入多类型内容生成与历史记录"],
  };
  const heroPanelTitle = document.getElementById("heroPanelTitle");
  const heroPanelSub = document.getElementById("heroPanelSub");

  landingPage.querySelectorAll("[data-hero-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = button.dataset.heroTab;
      landingPage.querySelectorAll("[data-hero-tab]").forEach((item) => {
        const isActive = item.dataset.heroTab === selected;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-selected", String(isActive));
      });
      landingPage.querySelectorAll("[data-hero-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.heroPanel === selected);
      });
      if (heroPanelTitle) heroPanelTitle.textContent = heroCopy[selected]?.[0] || "";
      if (heroPanelSub) heroPanelSub.textContent = heroCopy[selected]?.[1] || "";
    });
  });

  const profileData = {
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
  const profilePreview = document.getElementById("landingProfilePreview");
  landingPage.querySelectorAll("[data-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      landingPage.querySelectorAll("[data-profile]").forEach((item) => item.classList.toggle("active", item === button));
      if (!profilePreview) return;
      profilePreview.replaceChildren(
        ...(profileData[button.dataset.profile] || []).map(([label, value]) => {
          const row = document.createElement("div");
          const strong = document.createElement("strong");
          strong.textContent = label;
          row.append(strong, document.createTextNode(value));
          return row;
        }),
      );
    });
  });

  landingPage.querySelectorAll(".faq-question").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest("article");
      const isOpen = item?.classList.toggle("open") || false;
      button.setAttribute("aria-expanded", String(isOpen));
    });
  });

  const navInner = document.getElementById("landingNavInner");
  const menuButton = document.getElementById("landingMenuButton");
  menuButton?.addEventListener("click", () => {
    const isOpen = navInner?.classList.toggle("mobile-open") || false;
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });

  const navLinks = [...landingPage.querySelectorAll(".nav-links a")];
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      navInner?.classList.remove("mobile-open");
      menuButton?.setAttribute("aria-expanded", "false");
    });
  });

  const revealItems = landingPage.querySelectorAll(".landing-reveal");
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
          navLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`));
        });
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    landingPage.querySelectorAll("main section[id]").forEach((section) => sectionObserver.observe(section));
  } else {
    revealItems.forEach((item) => item.classList.add("visible"));
  }
}

function bindSidebarTabs() {
  document.querySelectorAll(".sidebar-item").forEach((item) => {
    item.addEventListener("click", () => switchTab(item.dataset.tab));
  });
}

function bindTabJump() {
  document.querySelectorAll("[data-tab-jump]").forEach((node) => {
    node.addEventListener("click", () => switchTab(node.dataset.tabJump));
  });
}

function createEmptyGenerationHistoryFilters() {
  return { q: "", brandId: "", type: "", from: "", to: "" };
}

function bindBrandModal() {
  const modal = document.getElementById("brandModal");
  const openBtn = document.getElementById("openBrandModal");
  const openPersonalBtn = document.getElementById("openPersonalModal");
  const closeBtn = document.getElementById("closeBrandModal");
  const cancelBtn = document.getElementById("cancelBrandModal");
  const form = document.getElementById("brandForm");
  const logoInput = document.getElementById("brandLogoInput");
  const logoPreview = document.getElementById("brandLogoPreview");
  const logoUploadText = document.getElementById("brandLogoUploadText");
  const modalKicker = document.getElementById("brandModalKicker");
  const modalTitle = document.getElementById("brandModalTitle");
  const modalDescription = document.getElementById("brandModalDescription");
  const submitButton = document.getElementById("brandSubmitButton");
  const personalFields = document.getElementById("personalProfileFields");
  const nameLabel = document.getElementById("profileNameLabel");
  const industryLabel = document.getElementById("profileIndustryLabel");
  const descriptionLabel = document.getElementById("profileDescriptionLabel");
  const productField = document.getElementById("profileProductField");
  const productLabel = document.getElementById("profileProductLabel");
  const knowledgeLabel = document.getElementById("profileKnowledgeLabel");
  const logoLabel = document.getElementById("profileLogoLabel");
  const goalLabel = document.getElementById("profileGoalLabel");
  let pendingLogo = null;
  let editingBrandId = null;
  let activeProfileType = "brand";

  const setLogoPreview = (brand = null) => {
    if (!logoPreview) return;
    if (brand?.logo?.url) {
      const assetLabel = activeProfileType === "personal" ? "个人头像" : "品牌 Logo";
      logoPreview.innerHTML = `
        <span>当前${assetLabel}：${escapeHtml(formatImageName(brand.logo.originalName || assetLabel, 38))}</span>
        <img src="${authenticatedImageSrc(brand.logo.url)}" alt="${escapeHtml(brand.logo.originalName || assetLabel)}" />
      `;
      return;
    }
    logoPreview.textContent =
      activeProfileType === "personal"
        ? "可选上传个人头像，仅用于识别档案与辅助视觉风格，不会作为品牌 Logo 植入图片。"
        : "可选上传，后续生图时可作为产品 Logo 使用。";
  };
  const setBrandModalMode = (brand = null, requestedType = "brand") => {
    editingBrandId = brand?.id || null;
    activeProfileType = brand?.profileType === "personal" || requestedType === "personal" ? "personal" : "brand";
    const isPersonal = activeProfileType === "personal";
    pendingLogo = null;
    form.reset();
    form.elements.profileType.value = activeProfileType;
    form.elements.product.required = !isPersonal;
    personalFields?.classList.toggle("is-hidden", !isPersonal);
    productField?.classList.toggle("is-optional-profile-field", isPersonal);
    if (logoInput) logoInput.value = "";
    if (modalKicker) modalKicker.textContent = isPersonal ? "个人 IP 档案" : editingBrandId ? "品牌资产维护" : "品牌资产录入";
    if (modalTitle) modalTitle.textContent = editingBrandId ? `编辑${isPersonal ? "个人 IP" : "品牌"}` : `新增${isPersonal ? "个人 IP" : "品牌"}`;
    if (modalDescription) {
      modalDescription.textContent = isPersonal
        ? "填写真实定位、目标受众、内容支柱和表达风格，后续可随时修改。"
        : editingBrandId
          ? "更新品牌定位、产品信息和资料库，后续 AI 分析会使用最新内容。"
          : "填写品牌信息，帮助 AI 更好地理解你的需求";
    }
    if (submitButton) submitButton.textContent = editingBrandId ? "保存修改" : `创建${isPersonal ? "个人 IP" : "品牌"}`;
    if (nameLabel) nameLabel.textContent = isPersonal ? "IP 名称 / 昵称" : "品牌名称";
    if (industryLabel) industryLabel.textContent = isPersonal ? "内容领域" : "行业分类";
    if (descriptionLabel) descriptionLabel.textContent = isPersonal ? "人设与定位" : "品牌介绍";
    if (productLabel) productLabel.textContent = isPersonal ? "专长 / 服务（可选）" : "产品介绍";
    if (knowledgeLabel) knowledgeLabel.textContent = isPersonal ? "补充背景资料" : "品牌资料库";
    if (logoLabel) logoLabel.textContent = isPersonal ? "个人头像" : "品牌 Logo";
    if (goalLabel) goalLabel.textContent = isPersonal ? "账号目标" : "运营目标";
    form.elements.name.placeholder = isPersonal ? "请输入昵称或 IP 名称" : "请输入品牌名称";
    form.elements.industry.placeholder = isPersonal ? "如：职场成长、创业、育儿" : "如：美妆、食品、科技";
    form.elements.description.placeholder = isPersonal ? "描述你的经历、专业身份、差异化定位与希望建立的认知" : "描述品牌定位、品牌故事、核心价值等";
    form.elements.product.placeholder = isPersonal ? "可选：描述课程、咨询或其他服务；没有可留空" : "描述主要产品/服务、卖点、使用场景等";
    form.elements.knowledgeBase.placeholder = isPersonal ? "补充履历、专业背景、内容边界和不能编造的信息。" : "补充品牌故事、成分说明、视觉风格、核心卖点、竞品差异、适用场景等，供内容生成和生图参考。";
    form.elements.goal.placeholder = isPersonal ? "例如建立专业影响力、积累精准粉丝、获得咨询线索" : "描述小红书账号的运营目标，例如提升品牌知名度、增加销量、建立用户社区等";
    if (logoUploadText) logoUploadText.textContent = brand?.logo ? `更换${isPersonal ? "头像" : " Logo"}` : `选择${isPersonal ? "头像" : " Logo 图片"}`;
    setLogoPreview(brand);
    if (!brand) return;
    form.elements.name.value = brand.name || "";
    form.elements.industry.value = brand.industry || "";
    form.elements.audience.value = brand.audience || "";
    form.elements.description.value = brand.description || "";
    form.elements.product.value = brand.product || "";
    form.elements.knowledgeBase.value = brand.knowledgeBase || "";
    form.elements.goal.value = brand.goal || "";
    form.elements.contentPillars.value = Array.isArray(brand.contentPillars) ? brand.contentPillars.join("，") : "";
    form.elements.personaStyle.value = brand.personaStyle || "";
  };
  const open = (brand = null, requestedType = "brand") => {
    setBrandModalMode(brand, requestedType);
    modal.classList.add("is-open");
  };
  openBrandEditor = open;
  const close = () => {
    modal.classList.remove("is-open");
  };

  openBtn.addEventListener("click", () => open(null, "brand"));
  openPersonalBtn?.addEventListener("click", () => open(null, "personal"));
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  logoInput?.addEventListener("change", async () => {
    const readEpoch = sessionEpoch;
    const file = logoInput.files?.[0];
    if (!file) {
      pendingLogo = null;
      setLogoPreview(state.brands.find((brand) => brand.id === editingBrandId));
      if (logoUploadText) logoUploadText.textContent = editingBrandId ? "更换 Logo" : "选择 Logo 图片";
      return;
    }
    const assetLabel = activeProfileType === "personal" ? "个人头像" : "品牌 Logo";
    if (!validateSingleReferenceFile(file, assetLabel)) {
      logoInput.value = "";
      pendingLogo = null;
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      assertSessionEpoch(readEpoch);
      pendingLogo = {
        name: file.name,
        dataUrl,
      };
      if (logoUploadText) logoUploadText.textContent = "重新选择 Logo";
      if (logoPreview) {
        logoPreview.innerHTML = `
          <span>已选择：${escapeHtml(formatImageName(file.name, 38))}</span>
          <img src="${escapeHtml(pendingLogo.dataUrl)}" alt="${escapeHtml(file.name)}" />
        `;
      }
    } catch (error) {
      if (isStaleSessionRequest(error)) return;
      pendingLogo = null;
      alert(`${assetLabel}读取失败：${error.message}`);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    const profileSize = getBrandProfileInputSize(payload);
    if (profileSize.total > MAX_BRAND_PROFILE_CHARS) {
      const subjectLabel = activeProfileType === "personal" ? "个人 IP" : "品牌";
      alert(
        `当前${subjectLabel}档案共 ${profileSize.total} 字，超过上限 ${MAX_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_BRAND_PROFILE_CHARS} 字。请删减档案内容后再保存。`,
      );
      return;
    }
    if (pendingLogo) {
      payload.logoName = pendingLogo.name;
      payload.logoDataUrl = pendingLogo.dataUrl;
    }

    try {
      setBusy(true);
      const result = await request(editingBrandId ? `/api/brands/${editingBrandId}` : "/api/brands", {
        method: editingBrandId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      if (editingBrandId) {
        replaceBrand(result.brand);
      } else {
        replaceBrand(result.brand);
        state.selectedBrandId = result.brand.id;
        state.selectedTrendId = null;
      }
      form.reset();
      pendingLogo = null;
      editingBrandId = null;
      setLogoPreview();
      if (logoUploadText) logoUploadText.textContent = "选择 Logo 图片";
      close();
      renderAll();
      switchTab(result.brand.profileType === "personal" ? "personal" : "brands");
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(false);
    }
  });
}

function getBrandProfileInputSize(payload) {
  const fields = ["name", "industry", "audience", "description", "product", "goal", "knowledgeBase", "contentPillars", "personaStyle"];
  return {
    total: fields.reduce((sum, key) => sum + String(payload?.[key] || "").trim().length, 0),
  };
}

function resetPersonalMaterialForm() {
  const form = document.getElementById("personalMaterialForm");
  if (!form) return;
  form.reset();
  form.elements.id.value = "";
  document.getElementById("savePersonalMaterial").textContent = "添加素材";
  document.getElementById("cancelMaterialEdit")?.classList.add("is-hidden");
}

function bindPersonalMaterialForm() {
  const form = document.getElementById("personalMaterialForm");
  const cancelButton = document.getElementById("cancelMaterialEdit");
  const list = document.getElementById("personalMaterialList");
  if (!form || !list) return;

  cancelButton?.addEventListener("click", resetPersonalMaterialForm);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const brandId = Number(state.selectedPersonalProfileId);
    if (!brandId) {
      showToast("请先选择一个个人 IP 档案");
      return;
    }
    const payload = Object.fromEntries(new FormData(form).entries());
    const materialId = Number(payload.id || 0);
    delete payload.id;
    payload.brandId = brandId;
    payload.tags = String(payload.tags || "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    try {
      const result = await request(materialId ? `/api/personal-materials/${materialId}` : "/api/personal-materials", {
        method: materialId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      const index = state.creatorMaterials.findIndex((item) => Number(item.id) === Number(result.item.id));
      if (index >= 0) state.creatorMaterials[index] = result.item;
      else state.creatorMaterials.unshift(result.item);
      resetPersonalMaterialForm();
      syncPersonalMaterialCounts();
      renderPersonalIps();
      showToast(materialId ? "素材已更新" : "素材已添加");
    } catch (error) {
      showToast(`素材保存失败：${error.message}`, 8000);
    }
  });

  list.addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-material-edit]");
    if (editButton) {
      const item = state.creatorMaterials.find((entry) => Number(entry.id) === Number(editButton.dataset.materialEdit));
      if (!item) return;
      form.elements.id.value = item.id;
      form.elements.kind.value = item.kind || "experience";
      form.elements.title.value = item.title || "";
      form.elements.content.value = item.content || "";
      form.elements.tags.value = Array.isArray(item.tags) ? item.tags.join("，") : "";
      document.getElementById("savePersonalMaterial").textContent = "保存修改";
      cancelButton?.classList.remove("is-hidden");
      form.elements.content.focus();
      return;
    }
    const deleteButton = event.target.closest("[data-material-delete]");
    if (!deleteButton) return;
    const item = state.creatorMaterials.find((entry) => Number(entry.id) === Number(deleteButton.dataset.materialDelete));
    if (!item || !confirm(`确定删除素材「${item.title || "未命名素材"}」吗？`)) return;
    try {
      await request(`/api/personal-materials/${item.id}`, { method: "DELETE" });
      state.creatorMaterials = state.creatorMaterials.filter((entry) => Number(entry.id) !== Number(item.id));
      if (Number(form.elements.id.value) === Number(item.id)) resetPersonalMaterialForm();
      syncPersonalMaterialCounts();
      renderPersonalIps();
      showToast("素材已删除");
    } catch (error) {
      showToast(`素材删除失败：${error.message}`, 8000);
    }
  });
}

function syncPersonalMaterialCounts() {
  state.brands = state.brands.map((brand) => {
    if (brand.profileType !== "personal") return brand;
    const materialCount = state.creatorMaterials.filter((item) => Number(item.brandId) === Number(brand.id)).length;
    return { ...brand, materialCount };
  });
}

async function loadCreatorMaterials() {
  if (!state.sessionToken || state.creatorMaterialsStatus === "loading") return;
  const loadEpoch = sessionEpoch;
  state.creatorMaterialsStatus = "loading";
  state.creatorMaterialsError = "";
  renderPersonalIps();
  try {
    const result = await request("/api/personal-materials");
    assertSessionEpoch(loadEpoch);
    state.creatorMaterials = Array.isArray(result.items) ? result.items : [];
    state.creatorMaterialsStatus = "ready";
    syncPersonalMaterialCounts();
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    state.creatorMaterialsStatus = "error";
    state.creatorMaterialsError = error.message || "素材加载失败";
  }
  renderPersonalIps();
}

function bindBrandDeleteModal() {
  const modal = document.getElementById("brandDeleteModal");
  const closeBtn = document.getElementById("closeBrandDeleteModal");
  const cancelBtn = document.getElementById("cancelBrandDeleteModal");
  const confirmBtn = document.getElementById("confirmBrandDelete");
  const checkbox = document.getElementById("deleteBrandGenerations");
  const close = () => {
    pendingBrandDeleteId = null;
    modal?.classList.remove("is-open");
  };
  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  confirmBtn?.addEventListener("click", async () => {
    if (!pendingBrandDeleteId) return;
    await confirmDeleteBrand(pendingBrandDeleteId, Boolean(checkbox?.checked));
    close();
  });
}

function bindImageModal() {
  const modal = document.getElementById("imageModal");
  const closeBtn = document.getElementById("closeImageModal");
  const close = () => modal.classList.remove("is-open");
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
}

function bindProductImageLibraryModal() {
  const modal = document.getElementById("productImageLibraryModal");
  const closeBtn = document.getElementById("closeProductImageLibraryModal");
  const finishBtn = document.getElementById("finishProductImageLibraryModal");
  const grid = document.getElementById("productImageLibraryGrid");
  const close = () => closeProductImageLibrary();

  closeBtn.addEventListener("click", close);
  finishBtn?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  document.querySelectorAll("[data-product-library-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.productImageLibrarySort = button.dataset.productLibrarySort || "recentUsed";
      renderProductImageLibraryModal();
    });
  });

  grid.addEventListener("click", async (event) => {
    const selectButton = event.target.closest("[data-library-select-image]");
    if (selectButton) {
      const imageId = Number(selectButton.dataset.librarySelectImage);
      const image = state.productImageLibrary.find((item) => item.id === imageId);
      if (!image || state.productImagePickerIdeaIndex == null) return;
      toggleProductImageForIdea(state.productImagePickerIdeaIndex, image);
      renderProductImageLibraryModal();
      renderIdeas();
      return;
    }

    const deleteButton = event.target.closest("[data-library-delete-image]");
    if (deleteButton) {
      const imageId = Number(deleteButton.dataset.libraryDeleteImage);
      if (!imageId) return;
      if (!confirm(getProductImageDeleteMessage(imageId))) return;
      try {
        await deleteProductImageAsset(imageId);
        renderProductImageLibraryModal();
        renderIdeas();
      } catch (error) {
        alert(`删除失败：${error.message}`);
      }
    }
  });
}

function openProductImageLibrary(ideaIndex) {
  state.productImagePickerIdeaIndex = ideaIndex;
  renderProductImageLibraryModal();
  document.getElementById("productImageLibraryModal").classList.add("is-open");
}

function closeProductImageLibrary() {
  state.productImagePickerIdeaIndex = null;
  document.getElementById("productImageLibraryModal").classList.remove("is-open");
}

function selectProductImageForIdea(ideaIndex, image) {
  addProductImageForIdea(ideaIndex, image);
}

function getSortedProductImageLibrary() {
  const images = [...state.productImageLibrary];
  if (state.productImageLibrarySort === "recentUploaded") {
    return images.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.id - a.id);
  }
  return images.sort(
    (a, b) =>
      String(b.lastUsedAt || b.createdAt || "").localeCompare(String(a.lastUsedAt || a.createdAt || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")) ||
      b.id - a.id,
  );
}

function getProductImageUsage(imageId) {
  const currentKey = state.productImagePickerIdeaIndex == null ? "" : getIdeaProductKey(state.productImagePickerIdeaIndex);
  const matchedKeys = Object.entries(state.productImages)
    .filter(([, selection]) => normalizeSelectedProductImages(selection).some((image) => Number(image?.id) === Number(imageId)))
    .map(([key]) => key);
  return {
    count: matchedKeys.length,
    isCurrent: Boolean(currentKey && matchedKeys.includes(currentKey)),
  };
}

function getProductImageDeleteMessage(imageId) {
  const usage = getProductImageUsage(imageId);
  if (usage.isCurrent) {
    const extra = usage.count > 1 ? `，同时还被另外 ${usage.count - 1} 个选题使用` : "";
    return `这张图片正在被当前选题作为产品参考图${extra}。删除后会清除相关选题的当前选择，且不会再出现在已上传图片中。确定删除吗？`;
  }
  if (usage.count > 0) {
    return `这张图片正在被 ${usage.count} 个选题作为产品参考图。删除后这些选题会清除当前选择，且不会再出现在已上传图片中。确定删除吗？`;
  }
  return "确定删除这张产品图吗？删除后不会再出现在已上传图片中。";
}

function renderProductImageLibraryModal() {
  const grid = document.getElementById("productImageLibraryGrid");
  const description = document.getElementById("productImageLibraryDescription");
  const selection = state.productImagePickerIdeaIndex == null ? { images: [] } : getProductSelection(state.productImagePickerIdeaIndex);
  const selectedCount = selection.images.length;
  const selectedBytes = getSelectionTotalBytes(selection.images);
  const sortedImages = getSortedProductImageLibrary();
  const sortLabel = state.productImageLibrarySort === "recentUploaded" ? "最近上传" : "最近使用";
  description.textContent = state.productImageLibrary.length
    ? `已保存 ${state.productImageLibrary.length} 张产品图，当前按${sortLabel}排序。当前选题已选 ${selectedCount}/${MAX_SELECTED_PRODUCT_IMAGES} 张，约 ${formatFileSize(selectedBytes)}/${formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES)}。`
    : "还没有保存过产品图，先在当前选题中上传一张。";
  document.querySelectorAll("[data-product-library-sort]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.productLibrarySort === state.productImageLibrarySort);
  });

  if (!state.productImageLibrary.length) {
    grid.innerHTML = `<div class="product-library-empty">暂无已上传产品图。</div>`;
    return;
  }

  grid.innerHTML = sortedImages
    .map(
      (image) => {
        const selected =
          state.productImagePickerIdeaIndex != null && isProductImageSelectedForIdea(state.productImagePickerIdeaIndex, image.id);
        return `
        <article class="product-library-card ${selected ? "is-selected" : ""}">
          <button class="product-library-image" data-library-select-image="${image.id}" type="button">
            <img src="${productImageSrc(image)}" alt="${escapeHtml(image.originalName)}" />
          </button>
          <div class="product-library-meta">
            <strong>${escapeHtml(image.originalName)}</strong>
            <span>${escapeHtml(formatFileSize(image.sizeBytes))}</span>
          </div>
          <div class="product-library-actions">
            <button class="primary-btn small-btn" data-library-select-image="${image.id}" type="button">${selected ? "取消选择" : "选择"}</button>
            <button class="secondary-btn small-btn" data-library-delete-image="${image.id}" type="button">删除</button>
          </div>
        </article>
      `;
      },
    )
    .join("");
}

function bindAuthModal() {
  const modal = document.getElementById("authModal");
  const closeBtn = document.getElementById("closeAuthModal");
  const registerForm = document.getElementById("registerForm");
  const loginForm = document.getElementById("loginForm");
  const feishuLoginActions = document.getElementById("feishuLoginActions");
  const feishuLoginButton = document.getElementById("feishuLoginButton");
  const feishuAppMenu = document.getElementById("feishuAppMenu");

  closeBtn.addEventListener("click", () => modal.classList.remove("is-open"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.classList.remove("is-open");
    }
  });

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setAuthTab(tab.dataset.authTab));
  });

  loadFeishuLoginApps(feishuAppMenu);
  feishuLoginActions?.addEventListener("click", (event) => {
    const appOption = event.target.closest("[data-feishu-app]");
    if (appOption) {
      startFeishuLogin(appOption.dataset.feishuApp);
      return;
    }
    if (event.target.closest("#feishuLoginButton")) {
      handleFeishuLoginClick(feishuAppMenu);
    }
  });

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(registerForm).entries());
    try {
      const result = await request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applySession(result.user);
      registerForm.reset();
      document.getElementById("authModal").classList.remove("is-open");
      if (!(await loadBrands())) return;
      switchPage("dashboard");
      switchTab(state.currentTab || "brands");
      resumePendingImageTasks();
    } catch (error) {
      if (isStaleSessionRequest(error)) return;
      alert(error.message);
    }
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(loginForm).entries());
    try {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applySession(result.user);
      document.getElementById("authModal").classList.remove("is-open");
      if (!(await loadBrands())) return;
      switchPage("dashboard");
      switchTab(state.currentTab || "brands");
      resumePendingImageTasks();
    } catch (error) {
      if (isStaleSessionRequest(error)) return;
      alert(error.message);
    }
  });
}

async function loadFeishuLoginApps(menu) {
  try {
    const result = await request("/api/auth/feishu/apps");
    feishuLoginApps = Array.isArray(result.apps) ? result.apps : [];
    renderFeishuAppMenu(menu);
  } catch (error) {
    feishuLoginApps = [];
    console.warn("[feishu-auth] app list unavailable", error);
  }
}

function renderFeishuAppMenu(menu) {
  if (!menu || feishuLoginApps.length <= 1) return;
  menu.innerHTML = feishuLoginApps
    .map((app) => {
      const key = escapeHtml(app.key || "");
      const name = escapeHtml(app.name || "飞书企业");
      return `
          <button class="feishu-app-option" type="button" data-feishu-app="${key}">
            <span>${name}</span>
          </button>
        `;
    })
    .join("");
}

function handleFeishuLoginClick(menu) {
  if (feishuLoginApps.length <= 1) {
    startFeishuLogin(feishuLoginApps[0]?.key || "");
    return;
  }
  if (menu) {
    menu.hidden = !menu.hidden;
  }
}

function startFeishuLogin(appKey = "") {
  const normalizedAppKey = String(appKey || "").trim();
  const query = normalizedAppKey ? `?app=${encodeURIComponent(normalizedAppKey)}` : "";
  window.location.href = `/api/auth/feishu/start${query}`;
}

function showAuthRedirectError() {
  const url = new URL(window.location.href);
  const error = url.searchParams.get("authError");
  if (!error) return;

  const messages = {
    feishu_config: "飞书登录暂未配置，请联系管理员。",
    feishu_denied: "你已取消飞书授权。",
    feishu_profile: "飞书账号信息不完整，请联系管理员。",
    feishu_tenant: "当前飞书账号不属于已授权企业。",
    feishu_failed: "飞书登录失败，请稍后重试。",
  };
  alert(messages[error] || "登录失败，请稍后重试。");
  url.searchParams.delete("authError");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function bindBusinessQuoteModal() {
  const modal = document.getElementById("businessQuoteModal");
  if (!modal) return;

  const closeBtn = document.getElementById("closeBusinessQuoteModal");
  const openButtons = document.querySelectorAll("[data-business-quote-open]");
  const open = () => {
    modal.classList.add("is-open");
    closeBtn?.focus();
  };
  const close = () => modal.classList.remove("is-open");

  openButtons.forEach((button) => {
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

function bindXhsCategorySelector() {
  const select = document.getElementById("xhsCategorySelect");
  if (!select) return;
  select.addEventListener("change", () => {
    state.xhsCategoryPath = select.value;
  });
}

function bindAnalysisButton() {
  document.getElementById("runTrendAnalysis").addEventListener("click", async () => {
    const analysisEpoch = sessionEpoch;
    const brandId = Number(state.selectedBrandId);
    const bucketKey = normalizeTrendBucketKey(state.selectedTrendMode || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE;
    if (!brandId || isTrendAnalysisLoading(brandId, bucketKey)) return;
    setTrendAnalysisBusy(brandId, bucketKey, true);
    try {
      const brand = await ensureBrandDetailLoaded(brandId);
      if (!brand) return;
      const requestId = getOrCreateTrendAnalysisRequestId(brand.id, bucketKey);
      const result = await request(`/api/brands/${brand.id}/analyses`, {
        method: "POST",
        body: JSON.stringify({
          requestId,
          bucketKey,
          xhsCategoryPath: bucketKey === "xhs" ? state.xhsCategoryPath || "" : "",
        }),
      });
      const generatedBucket = getTrendBucketsForBrand(result.brand).find((bucket) => bucket.key === bucketKey);
      if (!generatedBucket || generatedBucket.items?.length !== 10) {
        throw new Error("服务端未返回完整的 10 条趋势，本次结果未应用。");
      }
      notifyTrendAnalysisWarnings(result.warnings, generatedBucket.items.length);
      const mergedBrand = mergeGeneratedTrendResult(result.brand, bucketKey);
      updateCurrentUser(result.user);
      replaceBrand(mergedBrand);
      if (Number(state.selectedBrandId) === Number(brand.id) && state.selectedTrendMode === bucketKey) {
        state.selectedTrendId = getTrendBucketsForBrand(mergedBrand).find((bucket) => bucket.key === bucketKey)?.items?.[0]?.id ?? null;
      }
      renderAll();
      clearTrendAnalysisRequestId(brand.id, bucketKey);
    } catch (error) {
      if (isStaleSessionRequest(error)) return;
      if (shouldResetTrendAnalysisRequestId(error)) {
        clearTrendAnalysisRequestId(brandId, bucketKey);
      }
      alert(formatTrendAnalysisError(error));
    } finally {
      if (analysisEpoch === sessionEpoch) {
        setTrendAnalysisBusy(brandId, bucketKey, false);
      }
    }
  });
}

// Non-blocking notice for degraded/unverified trend items. A degraded batch is
// still a success — never raise the failure dialog for it.
function notifyTrendAnalysisWarnings(warnings, itemCount = 10) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return;
  const degradedIndexes = new Set(
    list
      .filter((warning) => ["TREND_ITEM_DEGRADED", "TREND_ITEM_FALLBACK"].includes(warning?.code) && Number.isInteger(warning?.trendIndex))
      .map((warning) => warning.trendIndex),
  );
  const message = degradedIndexes.size
    ? `已返回 ${itemCount} 条趋势，其中 ${degradedIndexes.size} 条为待验证/降级内容。`
    : `已返回 ${itemCount} 条趋势（${list.map((warning) => String(warning?.message || warning?.code || "提示")).slice(0, 2).join("；")}）。`;
  showToast(message, 8000);
}

function getTrendAnalysisRequestKey(brandId, bucketKey) {
  return `${Number(brandId) || 0}:${normalizeTrendBucketKey(bucketKey || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE}`;
}

function getOrCreateTrendAnalysisRequestId(brandId, bucketKey) {
  const key = getTrendAnalysisRequestKey(brandId, bucketKey);
  const existing = trendAnalysisRequestIds.get(key);
  if (existing) return existing;
  const requestId = window.crypto?.randomUUID?.() || `trend-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  trendAnalysisRequestIds.set(key, requestId);
  return requestId;
}

function clearTrendAnalysisRequestId(brandId, bucketKey) {
  trendAnalysisRequestIds.delete(getTrendAnalysisRequestKey(brandId, bucketKey));
}

function shouldResetTrendAnalysisRequestId(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500 && status !== 408 && status !== 409;
}

function formatTrendAnalysisError(error) {
  const message = String(error?.message || "");
  if (message.includes("热点搜索服务") || message.includes("热点来源暂时不可用")) {
    return [
      "热点搜索服务暂时不可用，请稍后重试。",
      "",
      "服务器这次没有拿到可核验的趋势来源，结果不会保存，也不会扣积分。",
      "",
      "请稍后再次点击当前维度的生成按钮；其他维度不受影响。",
    ].join("\n");
  }
  if (message.includes("contentAssets") || message.includes("内容资产")) {
    return [
      "当前维度的趋势和选题已经开始生成，但模型没有按结构完整返回内容资产，本次结果未保存。",
      "",
      message,
      "",
      "请稍后再次点击当前维度的生成按钮。主流程现在只生成当前维度，不会再分批补齐 120 个选题。",
    ].join("\n");
  }
  if (message.includes("未返回可用趋势结果") || message.includes("未能获取到可用热点") || message.includes("文本模型暂时不可用")) {
    return [
      "本次分析未能获取到可用热点，请稍后重试。",
      "",
      "这次没有拿到当前维度可用的趋势、选题和内容资产包。",
      "",
      "你的品牌资料和积分状态没有损坏，请稍后再次点击当前维度的生成按钮。",
    ].join("\n");
  }
  return message || "AI 热点分析失败，请稍后再次点击当前维度的生成按钮重新生成。";
}

function bindIdeaPromptActions() {
  document.getElementById("regenerateIdeasButton").addEventListener("click", async () => {
    const brand = getSelectedBrand();
    const trend = getSelectedTrend();
    if (!brand || !trend) {
      alert("请先选择品牌或个人 IP，并生成热点趋势。");
      return;
    }

    const customPrompt = document.getElementById("customIdeaPrompt").value.trim();
    const button = document.getElementById("regenerateIdeasButton");
    const meta = document.getElementById("ideaPromptMeta");
    button.disabled = true;
    button.textContent = "生成中...";
    meta.textContent = "正在把你的补充提示词追加到系统提示词中并重新生成选题...";

    try {
      const result = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/regenerate`, {
        method: "POST",
        body: JSON.stringify({ customPrompt }),
      });
      updateCurrentUser(result.user);
      replaceTrend(brand.id, result.trend);
      state.selectedTrendId = result.trend.id;
      renderIdeas();
      meta.textContent = customPrompt
        ? `已按你的补充提示词重新生成。当前额外要求：${customPrompt}`
        : "已恢复为默认系统提示词生成。";
    } catch (error) {
      meta.textContent = `生成失败：${error.message}`;
    } finally {
      button.disabled = false;
      button.innerHTML = "<span>重新生成选题</span><small>1 积分</small>";
    }
  });
}

function bindLogout() {
  document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn(error.message);
    }
    clearSession();
  });
}

async function restoreSession() {
  try {
    const result = await request("/api/session");
    applySession(result.user);
    if (!(await loadBrands())) return;
    switchPage("dashboard");
    switchTab(state.currentTab);
    resumePendingImageTasks();
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    clearSession();
    switchPage("landing");
    renderUser();
  }
}

function applySession(user) {
  sessionEpoch += 1;
  state.sessionToken = "cookie";
  state.currentUser = user;
  renderUser();
}

function updateCurrentUser(user) {
  if (!user) return;
  state.currentUser = user;
  renderUser();
}

function clearSession() {
  sessionEpoch += 1;
  state.sessionToken = "";
  state.currentUser = null;
  state.brands = [];
  state.creatorMaterials = [];
  state.creatorMaterialsStatus = "idle";
  state.creatorMaterialsError = "";
  state.selectedPersonalProfileId = null;
  state.generationHistory = [];
  state.generationHistoryFilters = {
    q: "",
    brandId: "",
    type: "",
    from: "",
    to: "",
  };
  state.generationHistoryNeedsLatest = false;
  state.selectedBrandId = null;
  state.selectedTrendId = null;
  state.selectedTrendMode = DEFAULT_TREND_MODE;
  state.brandDetailLoadingId = null;
  state.xhsCategoryPath = "";
  state.xhsCategories = [];
  state.xhsCategoryStatus = "idle";
  state.xhsCategoryError = "";
  state.excellentContentBoard = "xhs_hot";
  state.excellentContentBoards = {
    xhs_hot: createExcellentBoardSlice("xhs_hot"),
    ecommerce_hot: createExcellentBoardSlice("ecommerce_hot"),
  };
  state.excellentIndustryTaxonomy = [];
  state.excellentIndustryStatus = "idle";
  state.excellentIndustryError = "";
  state.excellentContents = [];
  state.excellentContentFilters = {
    categoryPath: "",
    industryPath: "",
    source: "xhs_hot",
    contentSource: "all",
  };
  state.excellentContentStatus = "idle";
  state.excellentContentError = "";
  state.excellentContentUpdatedAt = "";
  state.excellentContentStale = false;
  state.excellentContentRequestId = 0;
  state.excellentDetail = {
    noteId: "",
    board: "xhs_hot",
    loading: false,
    error: "",
    item: null,
    activeImageIndex: 0,
    requestId: 0,
  };
  state.trendAnalysisLoadingKeys = [];
  state.productImages = {};
  state.productImageLibrary = [];
  state.productImagePickerIdeaIndex = null;
  state.brandLogoUsage = {};
  state.editingIdeas = {};
  state.styleReferences = {};
  state.resumingImageTasks = false;
  brandDetailRequests.clear();
  if (typeof closeExcellentContentDetail === "function") closeExcellentContentDetail();
  if (typeof closeExcellentRemix === "function") closeExcellentRemix();
  dashboardScrollPositions.clear();
  retriedHistoryImagePaths.clear();
  historyImageSignatureRefreshInFlight = null;
  if (historyFilterTimer) {
    clearTimeout(historyFilterTimer);
    historyFilterTimer = null;
  }
  document.querySelectorAll("[id$='Modal'].is-open").forEach((modal) => {
    if (modal.id !== "authModal") modal.classList.remove("is-open");
  });
  trendAnalysisRequestIds.clear();
  state.aspectRatios = {};
  state.creativeStylePresets = {};
  state.wechatTemplates = {};
  state.openCreativeSettingsKey = "";
  renderUser();
  renderAll();
  switchPage("landing");
  closeAccountCenterModal();
}

function openAuthModal(tab) {
  setAuthTab(tab);
  document.getElementById("authModal").classList.add("is-open");
}

function setAuthTab(tab) {
  document.querySelectorAll(".auth-tab").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.authTab === tab);
  });
  document.querySelectorAll(".auth-form").forEach((node) => {
    const isTarget = (tab === "register" && node.id === "registerForm") || (tab === "login" && node.id === "loginForm");
    node.classList.toggle("auth-form-active", isTarget);
  });
}

function setBusy(loading) {
  state.loading = loading;
  renderTrendAnalysisButton();
  renderXhsCategorySelector();
}

function getTrendAnalysisLoadingKey(brandId, bucketKey) {
  return `${Number(brandId) || 0}:${normalizeTrendBucketKey(bucketKey || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE}`;
}

function isTrendAnalysisLoading(brandId, bucketKey) {
  return state.trendAnalysisLoadingKeys.includes(getTrendAnalysisLoadingKey(brandId, bucketKey));
}

function setTrendAnalysisBusy(brandId, bucketKey, loading) {
  const key = getTrendAnalysisLoadingKey(brandId, bucketKey);
  state.trendAnalysisLoadingKeys = loading
    ? [...new Set([...state.trendAnalysisLoadingKeys, key])]
    : state.trendAnalysisLoadingKeys.filter((item) => item !== key);
  renderTrendAnalysisButton();
  renderXhsCategorySelector();
}

function getSelectedTrendBucketLabel() {
  return getDefaultTrendBucket(state.selectedTrendMode)?.title || "当前维度";
}

function renderTrendAnalysisButton() {
  const button = document.getElementById("runTrendAnalysis");
  if (button) {
    const label = getSelectedTrendBucketLabel();
    const brand = getSelectedBrand();
    const waitingForBrand = Boolean(brand && !isBrandDetailLoaded(brand));
    const bucketKey = normalizeTrendBucketKey(state.selectedTrendMode || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE;
    const analysisLoading = Boolean(brand && isTrendAnalysisLoading(brand.id, bucketKey));
    button.disabled = state.loading || waitingForBrand || analysisLoading;
    if (waitingForBrand) {
      button.innerHTML = `<span>加载品牌详情中...</span><small>稍后可生成</small>`;
    } else if (analysisLoading) {
      button.innerHTML = `<span>${escapeHtml(label)}生成中...</span>`;
    } else if (state.loading) {
      button.innerHTML = `<span>处理中...</span>`;
    } else {
      button.innerHTML = `<span>生成${escapeHtml(label)}</span><small>消耗 1 积分</small>`;
    }
  }
}

async function loadBrands() {
  if (!state.sessionToken) return;
  const loadEpoch = sessionEpoch;
  try {
    setBusy(true);
    brandDetailRequests.clear();
    state.brandDetailLoadingId = null;
    const [brandResult, historyResult, productImageResult] = await Promise.all([
      request("/api/brands?summary=1"),
      request("/api/history"),
      request("/api/product-images"),
    ]);
    state.brands = (brandResult.brands || []).map(markBrandSummary);
    const personalProfiles = state.brands.filter((brand) => brand.profileType === "personal");
    if (!personalProfiles.some((brand) => Number(brand.id) === Number(state.selectedPersonalProfileId))) {
      state.selectedPersonalProfileId = personalProfiles[0]?.id || null;
    }
    state.generationHistory = historyResult.generations;
    state.productImageLibrary = productImageResult.images || [];
    if (state.brands.length) {
      if (!state.brands.some((brand) => brand.id === state.selectedBrandId)) {
        state.selectedBrandId = state.brands[0].id;
      }
      state.selectedTrendId = null;
    } else {
      state.selectedBrandId = null;
      state.selectedTrendId = null;
    }
    renderAll();
    ensureBrandDetailLoaded(state.selectedBrandId).catch((error) => {
      if (isStaleSessionRequest(error)) return;
      showToast(`品牌详情加载失败：${error.message}`, 8000);
    });
    loadXhsCategories();
    // Prefetch excellent content in the background; never block workspace entry.
    prefetchExcellentContents().catch(() => {});
    return true;
  } catch (error) {
    if (isStaleSessionRequest(error)) return false;
    throw new Error(`加载失败：${error.message}`);
  } finally {
    if (loadEpoch === sessionEpoch) setBusy(false);
  }
}

async function loadXhsCategories() {
  if (!state.sessionToken) return;
  state.xhsCategoryStatus = "loading";
  state.xhsCategoryError = "";
  renderXhsCategorySelector();
  try {
    applyXhsCategoryResult(await request("/api/trends/xhs/categories"));
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    applyXhsCategoryResult({ error });
  }
  renderXhsCategorySelector();
}

function markBrandSummary(brand) {
  return {
    ...brand,
    knowledgeBase: "",
    trends: [],
    analyses: [],
    _detailLoaded: false,
  };
}

function countBrandTrends(brand) {
  return getTrendBucketsForBrand(brand).reduce((sum, bucket) => sum + (bucket.items?.length || 0), 0);
}

function markBrandDetail(brand, previous = {}) {
  const next = {
    ...previous,
    ...brand,
    _detailLoaded: true,
  };
  next.trends = Array.isArray(next.trends) ? next.trends : [];
  next.analyses = Array.isArray(next.analyses) ? next.analyses : [];
  next.trendCount = countBrandTrends(next);
  next.analysisCount = next.analyses.length;
  return next;
}

function isBrandDetailLoaded(brand) {
  return Boolean(brand?._detailLoaded);
}

function syncSelectedTrendSelection(brand = getSelectedBrand()) {
  if (!brand || !isBrandDetailLoaded(brand)) {
    state.selectedTrendId = null;
    return;
  }
  if (!getTrendBucketsForBrand(brand).some((bucket) => bucket.key === state.selectedTrendMode)) {
    state.selectedTrendMode = firstTrendBucket(brand)?.key ?? DEFAULT_TREND_MODE;
  }
  const currentBucket = getCurrentTrendBucket(brand);
  if (!currentBucket?.items?.some((trend) => Number(trend.id) === Number(state.selectedTrendId))) {
    state.selectedTrendId = currentBucket?.items?.[0]?.id ?? null;
  }
}

async function ensureBrandDetailLoaded(brandId = state.selectedBrandId) {
  const id = Number(brandId || 0);
  if (!id || !state.sessionToken) return null;
  const current = state.brands.find((brand) => Number(brand.id) === id);
  if (isBrandDetailLoaded(current)) return current;

  if (Number(state.selectedBrandId) === id) {
    state.brandDetailLoadingId = id;
    renderAll();
  }

  if (!brandDetailRequests.has(id)) {
    const detailRequest = request(`/api/brands/${id}`)
      .then((result) => {
        if (!state.brands.some((brand) => Number(brand.id) === id)) return null;
        replaceBrand(result.brand);
        const nextBrand = state.brands.find((brand) => Number(brand.id) === id) || null;
        if (Number(state.selectedBrandId) === id) {
          syncSelectedTrendSelection(nextBrand);
        }
        return nextBrand;
      })
      .finally(() => {
        brandDetailRequests.delete(id);
        if (Number(state.brandDetailLoadingId) === id) {
          state.brandDetailLoadingId = null;
        }
        if (Number(state.selectedBrandId) === id) {
          renderAll();
        }
      });
    brandDetailRequests.set(id, detailRequest);
  }

  return brandDetailRequests.get(id);
}

function applyXhsCategoryResult(result) {
  if (result?.error) {
    state.xhsCategories = [];
    state.xhsCategoryPath = "";
    state.xhsCategoryStatus = "error";
    state.xhsCategoryError = result.error.message || "小红书内容类目暂时不可用";
    renderExcellentTaxonomyOptions();
    return;
  }

  state.xhsCategories = Array.isArray(result?.items) ? result.items : [];
  state.xhsCategoryStatus = state.xhsCategories.length ? "ready" : "empty";
  state.xhsCategoryError = "";
  const validValues = new Set(flattenXhsCategoryOptions(state.xhsCategories).map((item) => item.value));
  if (state.xhsCategoryPath && !validValues.has(state.xhsCategoryPath)) {
    state.xhsCategoryPath = "";
  }
  const xhsBoard = getExcellentBoardState("xhs_hot");
  // Invalid taxonomy options only clear draft selection; formal filters stay tied to cached items.
  if (xhsBoard.draftCategoryPath && !validValues.has(xhsBoard.draftCategoryPath)) {
    xhsBoard.draftCategoryPath = "";
  }
  renderExcellentTaxonomyOptions();
}

function replaceBrand(nextBrand) {
  const previous = state.brands.find((brand) => Number(brand.id) === Number(nextBrand.id)) || {};
  const normalized = markBrandDetail(nextBrand, previous);
  state.brands = state.brands.some((brand) => Number(brand.id) === Number(nextBrand.id))
    ? state.brands.map((brand) => (Number(brand.id) === Number(nextBrand.id) ? normalized : brand))
    : [normalized, ...state.brands];
}

function mergeGeneratedTrendResult(nextBrand, generatedBucketKey) {
  const previous = state.brands.find((brand) => Number(brand.id) === Number(nextBrand?.id));
  if (!isBrandDetailLoaded(previous)) return nextBrand;
  const previousByKey = new Map(getTrendBucketsForBrand(previous).map((bucket) => [bucket.key, bucket]));
  const incomingByKey = new Map(getTrendBucketsForBrand(nextBrand).map((bucket) => [bucket.key, bucket]));
  const trends = DEFAULT_TREND_BUCKETS.map((bucket) => {
    if (bucket.key === generatedBucketKey) return incomingByKey.get(bucket.key) || previousByKey.get(bucket.key) || { ...bucket, items: [] };
    const previousBucket = previousByKey.get(bucket.key);
    const incomingBucket = incomingByKey.get(bucket.key);
    return previousBucket?.items?.length ? previousBucket : incomingBucket || previousBucket || { ...bucket, items: [] };
  });
  const analysesById = new Map();
  for (const analysis of [...(nextBrand?.analyses || []), ...(previous?.analyses || [])]) {
    const key = String(analysis?.id ?? `${analysis?.name || ""}-${analysis?.timestamp || ""}`);
    if (!analysesById.has(key)) analysesById.set(key, analysis);
  }
  return {
    ...nextBrand,
    trends,
    analyses: [...analysesById.values()].sort((left, right) => String(right?.timestamp || "").localeCompare(String(left?.timestamp || ""))),
  };
}

async function deleteBrand(brandId) {
  const brand = state.brands.find((item) => item.id === brandId);
  if (!brand) return;
  openBrandDeleteModal(brand);
}

function openBrandDeleteModal(brand) {
  const modal = document.getElementById("brandDeleteModal");
  const title = document.getElementById("brandDeleteTitle");
  const description = document.getElementById("brandDeleteDescription");
  const checkbox = document.getElementById("deleteBrandGenerations");
  const hint = document.getElementById("deleteBrandGenerationsHint");
  const generationCount = state.generationHistory.filter((item) => Number(item.brandId) === Number(brand.id)).length;
  pendingBrandDeleteId = brand.id;
  if (title) title.textContent = `删除「${brand.name}」`;
  if (description) {
    description.textContent = "删除后该品牌档案、趋势分析和内容选题会被移除；历史生成记录默认保留。";
  }
  if (checkbox) {
    checkbox.checked = false;
    checkbox.disabled = generationCount === 0;
  }
  if (hint) {
    hint.textContent = generationCount
      ? `当前品牌有 ${generationCount} 条历史生成记录；勾选后会同步删除对应数据库记录和图片文件。`
      : "当前品牌没有可删除的历史生成记录。";
  }
  modal?.classList.add("is-open");
}

async function confirmDeleteBrand(brandId, deleteGenerations) {
  try {
    setBusy(true);
    const deletedBrand = state.brands.find((item) => item.id === brandId);
    const result = await request(`/api/brands/${brandId}`, {
      method: "DELETE",
      body: JSON.stringify({ deleteGenerations }),
    });
    state.brands = state.brands.filter((item) => item.id !== brandId);
    if (deletedBrand?.profileType === "personal") {
      state.creatorMaterials = state.creatorMaterials.filter((item) => Number(item.brandId) !== Number(brandId));
      if (Number(state.selectedPersonalProfileId) === Number(brandId)) {
        state.selectedPersonalProfileId =
          state.brands.find((item) => item.profileType === "personal")?.id ?? null;
        resetPersonalMaterialForm();
      }
    }
    if (Array.isArray(result.deletedGenerationIds) && result.deletedGenerationIds.length) {
      const deletedIds = new Set(result.deletedGenerationIds.map(Number));
      state.generationHistory = state.generationHistory.filter((item) => !deletedIds.has(Number(item.id)));
    }
    if (state.selectedBrandId === brandId) {
      state.selectedBrandId = state.brands[0]?.id ?? null;
      const nextBrand = getSelectedBrand();
      state.selectedTrendMode = firstTrendBucket(nextBrand)?.key ?? DEFAULT_TREND_MODE;
      state.selectedTrendId = firstTrendBucket(nextBrand)?.items?.[0]?.id ?? null;
    }
    renderAll();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function replaceTrend(brandId, nextTrend) {
  state.brands = state.brands.map((brand) => {
    if (brand.id !== brandId) return brand;
    return {
      ...brand,
      trends: (brand.trends || []).map((bucket) => ({
        ...bucket,
        items: bucket.items.map((trend) => (trend.id === nextTrend.id ? nextTrend : trend)),
      })),
    };
  });
}

function cloneTrend(trend) {
  return {
    ...trend,
    tags: Array.isArray(trend.tags) ? [...trend.tags] : [],
    ideas: Array.isArray(trend.ideas)
      ? trend.ideas.map((idea) => ({
          ...idea,
          tags: Array.isArray(idea.tags) ? [...idea.tags] : [],
        }))
      : [],
  };
}

function cloneTrendBucket(bucket) {
  return {
    ...bucket,
    items: Array.isArray(bucket.items) ? bucket.items.map(cloneTrend) : [],
  };
}

function normalizeTrendBucketKey(key) {
  const value = String(key || "");
  return LEGACY_TREND_BUCKET_KEYS[value] || value;
}

function getDefaultTrendBucket(key) {
  return DEFAULT_TREND_BUCKETS.find((bucket) => bucket.key === normalizeTrendBucketKey(key)) || null;
}

const PERSONAL_TREND_BUCKET_DESCRIPTIONS = {
  xhs: "从小红书站内高讨论、高收藏、高互动内容里筛选适合个人 IP 真诚参与的话题方向。",
  traffic: "从可核验的标题结构、叙事节奏、场景表达和互动设计中找到个人内容的传播机会。",
  news: "从近期新闻、行业动态和职业趋势中找到适合个人经验与观点切入的内容机会。",
  social: "从大众情绪、生活方式变化和公共讨论中找到适合个人经历与观点表达的切口。",
  track: "聚焦个人 IP 所在领域、同类创作者和受众决策链路里的专业内容机会。",
  crowd: "聚焦目标读者正在经历的身份变化、真实场景、困惑与内容需求。",
};

function getTrendBucketDescription(bucket, brand = getSelectedBrand()) {
  const fallback = getDefaultTrendBucket(bucket?.key);
  if (brand?.profileType === "personal") {
    return PERSONAL_TREND_BUCKET_DESCRIPTIONS[normalizeTrendBucketKey(bucket?.key)] || "适合当前个人 IP 参与和表达的话题方向。";
  }
  return fallback?.description || bucket?.description || "适合当前品牌借势的热点方向。";
}

function sortTrendItemsForDisplay(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      item,
      index,
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : -1,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }, index) => ({ ...item, rank: index + 1 }));
}

function getTrendBucketsForBrand(brand) {
  const bucketsByKey = new Map(
    DEFAULT_TREND_BUCKETS.map((bucket) => [
      bucket.key,
      {
        ...bucket,
        items: [],
      },
    ]),
  );

  for (const bucket of brand?.trends || []) {
    const key = normalizeTrendBucketKey(bucket.key);
    const base = bucketsByKey.get(key);
    if (!base) continue;
    bucketsByKey.set(key, {
      ...base,
      // Historical snapshots may predate the server-side score ordering. Keep
      // every display and selection path consistent without mutating storage.
      items: sortTrendItemsForDisplay(bucket.items),
    });
  }

  return DEFAULT_TREND_BUCKETS.map((bucket) => bucketsByKey.get(bucket.key));
}

function firstTrendBucket(brand) {
  const buckets = getTrendBucketsForBrand(brand);
  return buckets.find((bucket) => bucket.items?.length) || buckets[0] || null;
}

function getAnalysisBucketKey(analysis) {
  const name = String(analysis?.name || "");
  return DEFAULT_TREND_BUCKETS.find((bucket) => name.includes(bucket.title))?.key || "";
}

function restoreAnalysisSnapshot(analysisId) {
  const brand = getSelectedBrand();
  if (!brand) return;

  const analysis = (brand.analyses || []).find((item) => item.id === analysisId);
  if (!analysis) {
    alert("未找到对应的历史分析。");
    return;
  }

  if (!Array.isArray(analysis.trendSnapshot) || analysis.trendSnapshot.length === 0) {
    alert("这条历史分析没有保存趋势快照，暂时无法恢复查看。请重新生成一次分析。");
    return;
  }

  const analysisBucketKey = getAnalysisBucketKey(analysis);
  const trendSnapshot = analysisBucketKey
    ? analysis.trendSnapshot.filter((bucket) => normalizeTrendBucketKey(bucket.key) === analysisBucketKey)
    : analysis.trendSnapshot;
  if (analysisBucketKey && !trendSnapshot.length) {
    alert("这条历史分析没有当前维度的趋势快照，请重新生成一次该维度分析。");
    return;
  }

  state.brands = state.brands.map((item) => {
    if (item.id !== brand.id) return item;
    return {
      ...item,
      trends: trendSnapshot.map(cloneTrendBucket),
    };
  });

  state.selectedTrendMode = analysisBucketKey || firstTrendBucket(getSelectedBrand())?.key || DEFAULT_TREND_MODE;
  state.selectedTrendId = getCurrentTrendBucket(getSelectedBrand())?.items?.[0]?.id ?? null;
  renderAll();
  switchTab("trends");
}

function getDashboardScrollKey(tab = state.currentTab) {
  return `dashboard:${tab || "brands"}`;
}

function getDashboardScrollSnapshot() {
  const contentArea = document.querySelector(".content-area");
  const scroller = document.scrollingElement || document.documentElement;
  return {
    windowY: window.scrollY || scroller?.scrollTop || 0,
    contentTop: contentArea?.scrollTop || 0,
  };
}

function saveDashboardScrollPosition(tab = state.currentTab) {
  if (state.currentPage !== "dashboard" || !tab) return;
  dashboardScrollPositions.set(getDashboardScrollKey(tab), getDashboardScrollSnapshot());
}

function applyDashboardScrollSnapshot(snapshot = {}) {
  const top = Number(snapshot.windowY || 0);
  const contentTop = Number(snapshot.contentTop || 0);
  const contentArea = document.querySelector(".content-area");
  if (contentArea) contentArea.scrollTop = contentTop;
  window.scrollTo({ top, left: 0, behavior: "auto" });
}

function restoreDashboardScrollPosition(tab = state.currentTab) {
  if (state.currentPage !== "dashboard" || !tab) return;
  const snapshot = dashboardScrollPositions.get(getDashboardScrollKey(tab)) || { windowY: 0, contentTop: 0 };
  applyDashboardScrollSnapshot(snapshot);
  window.requestAnimationFrame(() => applyDashboardScrollSnapshot(snapshot));
}

async function deleteAnalysisSnapshot(analysisId) {
  const brand = getSelectedBrand();
  if (!brand) return;

  const analysis = (brand.analyses || []).find((item) => Number(item.id) === Number(analysisId));
  if (!analysis) {
    alert("未找到对应的历史分析。");
    return;
  }

  if (!confirm(`确定删除「${analysis.name}」吗？删除后这条历史分析和其中保存的话题快照将无法恢复。`)) return;

  try {
    setBusy(true);
    const result = await request(`/api/brands/${brand.id}/analyses/${analysisId}`, { method: "DELETE" });
    replaceBrand(result.brand);
    const nextBrand = getSelectedBrand();
    const currentBucket = getCurrentTrendBucket(nextBrand);
    if (!currentBucket?.items?.some((trend) => Number(trend.id) === Number(state.selectedTrendId))) {
      state.selectedTrendMode = firstTrendBucket(nextBrand)?.key ?? DEFAULT_TREND_MODE;
      state.selectedTrendId = firstTrendBucket(nextBrand)?.items?.[0]?.id ?? null;
    }
    renderAll();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function switchPage(page) {
  if (state.currentPage === "dashboard") {
    saveDashboardScrollPosition(state.currentTab);
  }
  state.currentPage = page;
  document.querySelectorAll(".page").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.page === page);
  });
  if (page === "dashboard") {
    restoreDashboardScrollPosition(state.currentTab);
  }
}

function switchTab(tab) {
  if (state.currentPage === "dashboard" && tab !== state.currentTab) {
    saveDashboardScrollPosition(state.currentTab);
  }
  state.currentTab = tab;
  document.querySelectorAll(".sidebar-item").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tabPanel === tab);
  });
  restoreDashboardScrollPosition(tab);
  if (tab === "history") {
    refreshGenerationHistoryOnHistoryTab();
  }
  if (tab === "personal") {
    renderPersonalIps();
  }
  if (tab === "excellent") {
    const slice = getExcellentBoardState();
    if (state.excellentContentBoard === "ecommerce_hot") {
      loadExcellentIndustryTaxonomy().catch(() => {});
    } else if (state.xhsCategoryStatus === "idle" || state.xhsCategoryStatus === "error") {
      // Ensure content category options are available for 小红书热门.
      loadXhsCategories().catch(() => {});
    }
    if (slice.status === "idle") {
      loadExcellentContents().catch((error) => {
        if (!isStaleSessionRequest(error)) {
          const active = getExcellentBoardState();
          active.error = error.message || "加载失败";
          active.status = "error";
          syncExcellentActiveBoardMirrors();
          renderExcellentContents();
        }
      });
    } else {
      renderExcellentContents();
    }
  }
}

function renderUser() {
  const userName = document.getElementById("userName");
  const userPhone = document.getElementById("userPhone");
  const userAvatar = document.getElementById("userAvatar");

  if (!state.currentUser) {
    userName.textContent = "未登录";
    userPhone.textContent = "请先登录账号";
    userAvatar.textContent = "R";
    renderAccountCenter();
    return;
  }

  userName.textContent = state.currentUser.name;
  const credits = Number(state.currentUser.credits ?? 0);
  userPhone.innerHTML = `${escapeHtml(state.currentUser.phone)}<br><span class="credit-pill">${credits} 积分</span>`;
  userAvatar.textContent = state.currentUser.name.slice(0, 1).toUpperCase();
  renderAccountCenter();
}

function getSelectedBrand() {
  return state.brands.find((item) => item.id === state.selectedBrandId) ?? state.brands[0] ?? null;
}

function getSelectedTrend() {
  const brand = getSelectedBrand();
  if (!brand) return null;
  for (const bucket of getTrendBucketsForBrand(brand)) {
    const found = (bucket.items || []).find((item) => item.id === state.selectedTrendId);
    if (found) return found;
  }
  return getCurrentTrendBucket(brand)?.items?.[0] ?? null;
}

function getCurrentTrendBucket(brand = getSelectedBrand()) {
  if (!brand) return null;
  const buckets = getTrendBucketsForBrand(brand);
  return buckets.find((bucket) => bucket.key === state.selectedTrendMode) ?? buckets[0] ?? null;
}

function flattenXhsCategoryOptions(items, result = [], parentLabels = []) {
  (items || []).forEach((item) => {
    const labels = [...parentLabels, item?.label].filter(Boolean);
    if (item?.value) result.push({ label: labels.join(" / "), value: item.value });
    if (Array.isArray(item?.children)) flattenXhsCategoryOptions(item.children, result, labels);
  });
  return result;
}

function renderXhsCategoryOptions(items) {
  return flattenXhsCategoryOptions(items)
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");
}

function renderXhsCategorySelector() {
  const select = document.getElementById("xhsCategorySelect");
  const status = document.getElementById("xhsCategoryStatus");
  if (!select || !status) return;
  const wrapper = select.closest(".xhs-category-control");
  const isXhsBucket = normalizeTrendBucketKey(state.selectedTrendMode || DEFAULT_TREND_MODE) === "xhs";
  if (wrapper) {
    wrapper.hidden = !isXhsBucket;
    wrapper.style.display = isXhsBucket ? "" : "none";
  }
  if (!isXhsBucket) {
    select.disabled = true;
    status.textContent = "";
    return;
  }

  select.innerHTML = `<option value="">全部内容类目</option>${renderXhsCategoryOptions(state.xhsCategories)}`;
  select.value = state.xhsCategoryPath || "";
  const brand = getSelectedBrand();
  select.disabled = state.loading || Boolean(brand && isTrendAnalysisLoading(brand.id, "xhs")) || state.xhsCategoryStatus !== "ready";

  if (state.xhsCategoryStatus === "loading") {
    status.textContent = "正在加载类目...";
  } else if (state.xhsCategoryStatus === "error") {
    status.textContent = state.xhsCategoryError || "小红书内容类目暂时不可用";
  } else if (state.xhsCategoryStatus === "empty") {
    status.textContent = "暂无可选类目";
  } else {
    const selectedCategory = flattenXhsCategoryOptions(state.xhsCategories).find((item) => item.value === state.xhsCategoryPath);
    status.textContent = selectedCategory ? `当前类目：${selectedCategory.label}` : "全部内容类目";
  }
}

function renderAll() {
  renderBrands();
  renderPersonalIps();
  renderBrandChips();
  renderTrendModeTabs();
  renderTrendAnalysisButton();
  renderXhsCategorySelector();
  renderHistory();
  renderAnalysisSummary();
  renderTrends();
  renderIdeas();
  renderGenerationHistory();
  renderExcellentContents();
}

function renderBrands() {
  const root = document.getElementById("brandList");
  const brands = state.brands.filter((brand) => brand.profileType !== "personal");
  if (!brands.length) {
    root.innerHTML = `<article class="brand-card"><div class="brand-description">你还没有品牌档案。登录后先新增品牌，就可以开始热点分析和内容选题。</div></article>`;
    return;
  }

  root.innerHTML = brands
    .map(
      (brand) => `
        <article class="brand-card">
          <div class="brand-card-head">
            <div>
              <div class="brand-meta">
                <h3>${escapeHtml(brand.name)}</h3>
                <span class="brand-tag">${escapeHtml(brand.industry)}</span>
              </div>
              <div class="brand-description">
                <strong>目标受众：</strong>${escapeHtml(brand.audience)}<br /><br />
                ${escapeHtml(brand.description)}
              </div>
              <div class="panel-subtitle">趋势 ${Number(brand.trendCount || 0)} 条 · 分析 ${Number(brand.analysisCount || 0)} 次</div>
              ${
                brand.knowledgeBase
                  ? `
                <div class="brand-kb-box">
                  <strong>品牌资料库</strong>
                  <div>${escapeHtml(brand.knowledgeBase)}</div>
                </div>
              `
                  : ""
              }
            </div>
          </div>
          <div class="brand-actions">
            <button class="primary-btn small-btn" data-brand-action="trends" data-brand-id="${brand.id}" type="button">AI趋势分析</button>
            <button class="secondary-btn" data-brand-edit="${brand.id}" type="button">编辑</button>
            <button class="secondary-btn danger-btn" data-brand-delete="${brand.id}" type="button">删除</button>
          </div>
        </article>
      `,
    )
    .join("");

  root.onclick = async (event) => {
    const editButton = event.target.closest("[data-brand-edit]");
    if (editButton && root.contains(editButton)) {
      const brand = await ensureBrandDetailLoaded(Number(editButton.dataset.brandEdit));
      if (brand) openBrandEditor(brand);
      return;
    }

    const deleteButton = event.target.closest("[data-brand-delete]");
    if (deleteButton && root.contains(deleteButton)) {
      deleteBrand(Number(deleteButton.dataset.brandDelete));
      return;
    }

    const button = event.target.closest("[data-brand-id]");
    if (!button || !root.contains(button)) return;

    const selectedBrandId = Number(button.dataset.brandId);
    const nextTab = button.dataset.brandAction || "brands";
    state.selectedBrandId = selectedBrandId;
    syncSelectedTrendSelection(getSelectedBrand());
    switchTab(nextTab);
    renderAll();
    ensureBrandDetailLoaded(selectedBrandId).catch((error) => {
      showToast(`品牌详情加载失败：${error.message}`, 8000);
    });
  };
}

function renderPersonalIps() {
  const profileRoot = document.getElementById("personalProfileList");
  if (!profileRoot) return;

  const profiles = state.brands.filter((brand) => brand.profileType === "personal");
  if (!profiles.some((brand) => Number(brand.id) === Number(state.selectedPersonalProfileId))) {
    state.selectedPersonalProfileId = profiles[0]?.id || null;
  }

  if (!profiles.length) {
    profileRoot.innerHTML = `<article class="brand-card"><div class="brand-description">你还没有个人 IP 档案。点击右上角“新增个人 IP”，就可以开始趋势分析和内容选题。</div></article>`;
  } else {
    profileRoot.innerHTML = profiles
      .map((brand) => {
        const pillars = Array.isArray(brand.contentPillars) ? brand.contentPillars : [];
        return `
          <article class="brand-card personal-profile-card">
            <div class="personal-profile-card-head">
              <div class="personal-avatar">
                ${
                  brand.logo?.url
                    ? `<img src="${authenticatedImageSrc(brand.logo.url)}" alt="${escapeHtml(brand.name)}" />`
                    : escapeHtml(String(brand.name || "IP").slice(0, 1).toUpperCase())
                }
              </div>
              <div>
                <div class="brand-meta">
                  <h3>${escapeHtml(brand.name)}</h3>
                  <span class="brand-tag personal-tag">个人 IP</span>
                </div>
                <p>${escapeHtml(brand.industry)} · ${escapeHtml(brand.audience)}</p>
              </div>
            </div>
            <div class="brand-description">${escapeHtml(brand.description)}</div>
            ${
              pillars.length
                ? `<div class="personal-pillars">${pillars.map((pillar) => `<span>${escapeHtml(pillar)}</span>`).join("")}</div>`
                : `<div class="personal-card-note">尚未设置内容支柱</div>`
            }
            ${brand.personaStyle ? `<div class="personal-style"><strong>表达风格：</strong>${escapeHtml(brand.personaStyle)}</div>` : ""}
            <div class="personal-profile-stats">
              <span>趋势 ${Number(brand.trendCount || 0)} 条</span>
              <span>分析 ${Number(brand.analysisCount || 0)} 次</span>
            </div>
            <div class="brand-actions">
              <button class="primary-btn small-btn" data-personal-action="trends" data-personal-id="${brand.id}" type="button">AI 趋势分析</button>
              <button class="secondary-btn" data-personal-edit="${brand.id}" type="button">编辑档案</button>
              <button class="secondary-btn danger-btn" data-personal-delete="${brand.id}" type="button">删除</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  profileRoot.onclick = async (event) => {
    const editButton = event.target.closest("[data-personal-edit]");
    if (editButton) {
      const brand = await ensureBrandDetailLoaded(Number(editButton.dataset.personalEdit));
      if (brand) openBrandEditor(brand);
      return;
    }
    const deleteButton = event.target.closest("[data-personal-delete]");
    if (deleteButton) {
      deleteBrand(Number(deleteButton.dataset.personalDelete));
      return;
    }
    const actionButton = event.target.closest("[data-personal-action]");
    if (actionButton) {
      const brandId = Number(actionButton.dataset.personalId);
      state.selectedPersonalProfileId = brandId;
      state.selectedBrandId = brandId;
      syncSelectedTrendSelection(getSelectedBrand());
      switchTab(actionButton.dataset.personalAction || "personal");
      renderAll();
      ensureBrandDetailLoaded(brandId).catch((error) => showToast(`个人 IP 详情加载失败：${error.message}`, 8000));
      return;
    }
  };
}

function renderBrandChips() {
  const root = document.getElementById("trendBrandChips");
  root.innerHTML = state.brands
    .map(
      (brand) => `
        <button class="brand-chip ${brand.id === state.selectedBrandId ? "is-active" : ""}" data-chip-brand="${brand.id}" type="button">
          ${escapeHtml(brand.name)}
          ${brand.profileType === "personal" ? `<small>个人 IP</small>` : ""}
        </button>
      `,
    )
    .join("");

  root.querySelectorAll("[data-chip-brand]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedBrandId = Number(button.dataset.chipBrand);
      syncSelectedTrendSelection(getSelectedBrand());
      renderAll();
      ensureBrandDetailLoaded(state.selectedBrandId).catch((error) => {
        showToast(`${getSelectedBrand()?.profileType === "personal" ? "个人 IP" : "品牌"}详情加载失败：${error.message}`, 8000);
      });
    });
  });
}

function renderTrendModeTabs() {
  const root = document.getElementById("trendModeTabs");
  if (!root) return;
  const brand = getSelectedBrand();
  const buckets = brand ? getTrendBucketsForBrand(brand) : DEFAULT_TREND_BUCKETS;
  root.innerHTML = buckets
    .map(
      (bucket) => {
        const label = getDefaultTrendBucket(bucket.key)?.title || bucket.title;
        return `
        <button class="trend-mode-tab ${bucket.key === state.selectedTrendMode ? "is-active" : ""}" data-trend-mode="${escapeHtml(bucket.key)}" type="button">
          ${escapeHtml(label)}
        </button>
      `;
      },
    )
    .join("");

  root.querySelectorAll("[data-trend-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTrendMode = button.dataset.trendMode;
      state.selectedTrendId = getCurrentTrendBucket()?.items?.[0]?.id ?? null;
      renderAll();
    });
  });
}

function renderHistory() {
  const root = document.getElementById("historyList");
  const brand = getSelectedBrand();

  if (!brand) {
    root.innerHTML = `<p class="analysis-tip">当前账号还没有任何品牌分析记录。</p>`;
    return;
  }

  if (!isBrandDetailLoaded(brand)) {
    root.innerHTML = `<p class="analysis-tip">正在加载 ${escapeHtml(brand.name)} 的分析记录...</p>`;
    return;
  }

  if (!brand.analyses.length) {
    root.innerHTML = `<p class="analysis-tip">当前${brand.profileType === "personal" ? "个人 IP" : "品牌"}还没有分析记录，点击上方按钮即可开始分析。</p>`;
    return;
  }

  root.innerHTML = brand.analyses
    .map(
      (item) => `
        <div class="history-item">
          <div>
            <div>${item.name}</div>
            <div class="panel-subtitle">${item.timestamp}</div>
          </div>
          <div class="history-item-actions">
            <button class="text-btn" data-analysis-view="${item.id}" type="button">查看</button>
            <button class="text-btn danger-text-btn" data-analysis-delete="${item.id}" type="button">删除</button>
          </div>
        </div>
      `,
    )
    .join("");

  root.querySelectorAll("[data-analysis-view]").forEach((button) => {
    button.addEventListener("click", () => {
      restoreAnalysisSnapshot(Number(button.dataset.analysisView));
    });
  });
  root.querySelectorAll("[data-analysis-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteAnalysisSnapshot(Number(button.dataset.analysisDelete));
    });
  });
}

function renderAnalysisSummary() {
  const root = document.getElementById("analysisSummary");
  const brand = getSelectedBrand();

  if (!brand) {
    root.textContent = "先新增品牌或个人 IP 档案，再开始基于主体档案的热点趋势分析。";
    return;
  }

  if (!isBrandDetailLoaded(brand)) {
    root.textContent = `正在加载 ${brand.name} 的完整${brand.profileType === "personal" ? "个人 IP" : "品牌"}详情和趋势记录。`;
    return;
  }

  if (!brand.trends.length) {
    const profileLabel = brand.profileType === "personal" ? "个人 IP" : "品牌";
    root.textContent = `已为 ${brand.name} 建立「${profileLabel}」档案。请选择一个热点维度，点击左侧按钮只生成该维度的 10 条趋势和 20 个完整选题。`;
    return;
  }

  const bucket = getCurrentTrendBucket(brand);
  const label = getDefaultTrendBucket(bucket?.key)?.title || bucket?.title || "当前维度";
  const count = bucket?.items?.length || 0;
  if (!count) {
    root.textContent = `${brand.name} 的「${label}」还没有生成。点击左侧按钮后，只会生成这个维度，不会生成其他维度。`;
    return;
  }
  root.textContent = `${brand.name} 的「${label}」已生成 ${count}/10 条趋势，每条趋势下有 2 个完整内容选题。切换到其他维度后可按需单独生成。`;
}

function renderTrends() {
  const root = document.getElementById("trendList");
  const brand = getSelectedBrand();
  const bucket = getCurrentTrendBucket(brand);

  if (brand && !isBrandDetailLoaded(brand)) {
    const fallbackBucket = getDefaultTrendBucket(state.selectedTrendMode) || DEFAULT_TREND_BUCKETS[0];
    root.innerHTML = `
      <article class="trend-card">
        <div>
          <h3>${escapeHtml(fallbackBucket.title)}</h3>
          <p>${escapeHtml(getTrendBucketDescription(fallbackBucket, brand))}</p>
          <p class="analysis-tip">正在加载 ${escapeHtml(brand.name)} 的趋势和选题记录...</p>
        </div>
      </article>
    `;
    return;
  }

  if (!brand || !bucket || !bucket.items?.length) {
    const fallbackBucket = getDefaultTrendBucket(state.selectedTrendMode) || DEFAULT_TREND_BUCKETS[0];
    root.innerHTML = `
      <article class="trend-card">
        <div>
          <h3>${escapeHtml(fallbackBucket.title)}</h3>
          <p>${escapeHtml(getTrendBucketDescription(fallbackBucket, brand))}</p>
          <p class="analysis-tip">当前维度还没有生成。点击左侧按钮后，将只生成这个维度的 10 条趋势和 20 个完整选题。</p>
        </div>
      </article>
    `;
    return;
  }

  root.innerHTML = `
    <article class="trend-card">
      <div>
        <h3>${escapeHtml(getDefaultTrendBucket(bucket.key)?.title || bucket.title)}</h3>
<p>${escapeHtml(getTrendBucketDescription(bucket, brand))}</p>
      </div>
    </article>
  ` + bucket.items
    .map(
      (trend) => `
        <article class="trend-card">
          <div class="trend-top">
            <div class="trend-rank">${trend.rank}</div>
            <div>
              <h3>${escapeHtml(trend.title)}</h3>
              <span class="trend-category">${escapeHtml(trend.category)}</span>
            </div>
          </div>
          <p>${escapeHtml(trend.summary)}</p>
          <div class="score-track">
            <div class="score-fill" style="width:${trend.score}%"></div>
          </div>
          <div class="trend-footer">
            ${trend.tags.map((tag) => `<span class="idea-tag">${escapeHtml(tag)}</span>`).join("")}
            <span class="trend-score">${trend.score}/100</span>
            <button class="text-btn" data-idea-trend="${trend.id}" type="button">生成选题</button>
          </div>
        </article>
      `,
    )
    .join("");

  root.querySelectorAll("[data-idea-trend]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTrendId = Number(button.dataset.ideaTrend);
      renderIdeas();
      switchTab("ideas");
    });
  });
}

function renderIdeas() {
  const context = document.getElementById("ideaContext");
  const root = document.getElementById("ideaList");
  const promptInput = document.getElementById("customIdeaPrompt");
  const promptMeta = document.getElementById("ideaPromptMeta");
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();

  if (!brand) {
    context.innerHTML = `<div class="idea-copy">先新增品牌，再开始生成内容选题。</div>`;
    promptInput.value = "";
    promptMeta.textContent = "当前使用默认系统提示词生成。";
    root.innerHTML = "";
    return;
  }

  if (!isBrandDetailLoaded(brand)) {
    context.innerHTML = `<div class="idea-copy">正在加载 ${escapeHtml(brand.name)} 的完整品牌详情和选题记录...</div>`;
    promptInput.value = "";
    promptMeta.textContent = "品牌详情加载完成后可继续生成内容。";
    root.innerHTML = "";
    return;
  }

  if (!trend) {
    context.innerHTML = `<div class="idea-copy">先在“趋势分析”中为 ${escapeHtml(brand.name)} 生成一批热点，再进入内容选题页。</div>`;
    promptInput.value = "";
    promptMeta.textContent = "当前使用默认系统提示词生成。";
    root.innerHTML = "";
    return;
  }

  context.innerHTML = `
    <div class="idea-context-top">
      <div>
        <h3>${escapeHtml(brand.name)} × ${escapeHtml(trend.title)}</h3>
        <p class="idea-copy">${
          brand.profileType === "personal"
            ? "内容选题不是只追热点，而是把个人定位、真实素材、目标读者和表达风格一起带入，生成符合本人经历与人设边界的小红书内容方向。"
            : "内容选题不是只追热点，而是把品牌资产、产品卖点、目标受众和运营目标一起带入，生成真正适合该品牌的小红书内容方向。"
        }</p>
        <p class="idea-copy"><strong>热点适配原因：</strong>${escapeHtml(trend.reason)}</p>
        <p class="idea-copy"><strong>${brand.profileType === "personal" ? "补充背景资料" : "品牌资料库"}：</strong>${escapeHtml(brand.knowledgeBase || `当前未补充${brand.profileType === "personal" ? "背景资料" : "品牌资料库"}。`)}</p>
        <p class="idea-copy"><strong>参考图片：</strong>${
          brand.profileType === "personal"
            ? "可上传内容参考图、使用个人头像参考或添加风格参考图；系统不会把个人头像当作品牌 Logo 植入画面。"
            : "可在下方每个选题中上传产品图、选择品牌 Logo 或添加风格参考图，并勾选后用于对应生图。"
        }</p>
      </div>
      <div class="idea-tag-list">
        ${brand.assetTags.map((tag) => `<span class="idea-tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </div>
  `;
  promptInput.value = trend.customPrompt || "";
  promptMeta.textContent = trend.customPrompt
    ? `当前已叠加你的补充提示词：${trend.customPrompt}`
    : "当前使用默认系统提示词生成。";

  root.innerHTML = trend.ideas
    .map(
      (idea, index) => `
        <article class="idea-card">
          ${renderIdeaContent(idea, index)}
          ${renderIdeaLogoControl(index)}
          ${renderIdeaProductUpload(index)}
          ${renderIdeaStyleReferenceUpload(index)}
          ${renderIdeaCreativeSettings(index)}
          <div class="idea-actions">
            <button class="primary-btn small-btn cost-button" data-generate-image="${index}" type="button"><span>一键朋友圈图</span><small>1 积分</small></button>
            <button class="secondary-btn cost-button" data-generate-wechat="${index}" type="button"><span>一键公众号长图</span><small>1 积分</small></button>
            <button class="secondary-btn cost-button" data-generate-carousel="${index}" type="button"><span>一键小红书组图</span><small>4 积分</small></button>
            <button class="secondary-btn cost-button" data-generate-style-image="${index}" type="button"><span>一键风格化图</span><small>1 积分</small></button>
          </div>
          <div class="idea-tag-list">
            ${idea.tags.map((tag) => `<span class="idea-tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
        </article>
      `,
    )
    .join("");

  root.querySelectorAll("[data-toggle-creative-settings]").forEach((button) => {
    button.addEventListener("click", () => {
      const ideaIndex = Number(button.dataset.toggleCreativeSettings);
      const key = getIdeaProductKey(ideaIndex);
      state.openCreativeSettingsKey = state.openCreativeSettingsKey === key ? "" : key;
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-creative-field]").forEach((select) => {
    select.addEventListener("change", () => {
      const ideaIndex = Number(select.dataset.ideaIndex);
      const key = getIdeaProductKey(ideaIndex);
      if (select.dataset.creativeField === "wechat") {
        state.wechatTemplates[key] = select.value;
      } else {
        state.creativeStylePresets[key] = select.value;
      }
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-select-aspect-ratio]").forEach((button) => {
    button.addEventListener("click", () => {
      const ideaIndex = Number(button.dataset.ideaIndex);
      state.aspectRatios[getIdeaProductKey(ideaIndex)] = button.dataset.selectAspectRatio;
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-generate-image]").forEach((button) => {
    button.addEventListener("click", async () => {
      await generateImageConcept(Number(button.dataset.generateImage));
    });
  });

  root.querySelectorAll("[data-generate-wechat]").forEach((button) => {
    button.addEventListener("click", async () => {
      await generateWechatLongImage(Number(button.dataset.generateWechat));
    });
  });

  root.querySelectorAll("[data-generate-carousel]").forEach((button) => {
    button.addEventListener("click", async () => {
      await generateXhsCarousel(Number(button.dataset.generateCarousel));
    });
  });

  root.querySelectorAll("[data-generate-style-image]").forEach((button) => {
    button.addEventListener("click", async () => {
      await generateStyleImage(Number(button.dataset.generateStyleImage));
    });
  });

  root.querySelectorAll("[data-edit-idea]").forEach((button) => {
    button.addEventListener("click", () => {
      const ideaIndex = Number(button.dataset.editIdea);
      const idea = getSelectedTrend()?.ideas?.[ideaIndex];
      if (!idea) return;
      state.editingIdeas[getIdeaDraftKey(ideaIndex)] = {
        title: idea.title || "",
        summary: idea.summary || "",
        angle: idea.angle || "",
        brandFit: idea.brandFit || "",
        audience: idea.audience || "",
        hook: idea.hook || "",
      };
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-cancel-idea-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      delete state.editingIdeas[getIdeaDraftKey(Number(button.dataset.cancelIdeaEdit))];
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-idea-edit-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const ideaIndex = Number(form.dataset.ideaEditForm);
      const brand = getSelectedBrand();
      const trend = getSelectedTrend();
      if (!brand || !trend) return;
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const result = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        replaceTrend(brand.id, result.trend);
        delete state.editingIdeas[getIdeaDraftKey(ideaIndex)];
        renderIdeas();
      } catch (error) {
        alert(`保存失败：${error.message}`);
      }
    });
  });

  root.querySelectorAll("[data-product-image]").forEach((input) => {
    input.addEventListener("change", async () => {
      const ideaIndex = Number(input.dataset.productImage);
      const files = Array.from(input.files || []);
      if (!files.length) return;
      if (!validateProductUploadFiles(ideaIndex, files)) {
        input.value = "";
        return;
      }
      try {
        let duplicateCount = 0;
        for (const file of files) {
          const result = await uploadProductImage(file);
          selectProductImageForIdea(ideaIndex, result.image);
          if (result.duplicate) duplicateCount += 1;
        }
        if (duplicateCount) {
          showToast(duplicateCount === 1 ? "图片已存在，已直接选用已上传图片。" : `${duplicateCount} 张图片已存在，已直接选用已上传图片。`);
        }
        renderIdeas();
      } catch (error) {
        alert(`产品图上传失败：${error.message}`);
      } finally {
        input.value = "";
      }
    });
  });

  root.querySelectorAll("[data-open-product-library]").forEach((button) => {
    button.addEventListener("click", () => {
      openProductImageLibrary(Number(button.dataset.openProductLibrary));
    });
  });

  root.querySelectorAll("[data-clear-product-image]").forEach((button) => {
    button.addEventListener("click", () => {
      delete state.productImages[getIdeaProductKey(Number(button.dataset.clearProductImage))];
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-use-product-image]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const ideaIndex = Number(checkbox.dataset.useProductImage);
      const key = getIdeaProductKey(ideaIndex);
      if (!state.productImages[key]) return;
      state.productImages[key].useImage = checkbox.checked;
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-brand-logo-image]").forEach((input) => {
    input.addEventListener("change", async () => {
      const ideaIndex = Number(input.dataset.brandLogoImage);
      const file = input.files?.[0];
      const brand = getSelectedBrand();
      if (!file || !brand) return;
      if (!validateSingleReferenceFile(file, "品牌 Logo")) {
        input.value = "";
        return;
      }
      if (brand.logo && !confirm("当前品牌已经有 Logo，再次上传会替换原来的 Logo。确定继续上传并替换吗？")) {
        input.value = "";
        return;
      }
      try {
        const nextBrand = await uploadBrandLogo(brand.id, file);
        state.brandLogoUsage[getIdeaProductKey(ideaIndex)] = Boolean(nextBrand.logo);
        renderAll();
      } catch (error) {
        alert(`品牌 Logo 上传失败：${error.message}`);
      } finally {
        input.value = "";
      }
    });
  });

  root.querySelectorAll("[data-use-brand-logo]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      state.brandLogoUsage[getIdeaProductKey(Number(checkbox.dataset.useBrandLogo))] = checkbox.checked;
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-clear-style-reference]").forEach((button) => {
    button.addEventListener("click", () => {
      delete state.styleReferences[getIdeaProductKey(Number(button.dataset.clearStyleReference))];
      renderIdeas();
    });
  });

  root.querySelectorAll("[data-style-reference-image]").forEach((input) => {
    input.addEventListener("change", async () => {
      const readEpoch = sessionEpoch;
      const ideaIndex = Number(input.dataset.styleReferenceImage);
      const file = input.files?.[0];
      if (!file) return;
      if (!validateSingleReferenceFile(file, "风格参考图")) {
        input.value = "";
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        assertSessionEpoch(readEpoch);
        state.styleReferences[getIdeaProductKey(ideaIndex)] = {
          fileName: file.name,
          dataUrl,
          sizeBytes: file.size,
        };
        renderIdeas();
      } catch (error) {
        if (isStaleSessionRequest(error)) return;
        alert(`风格参考图读取失败：${error.message}`);
      } finally {
        input.value = "";
      }
    });
  });

}

function renderIdeaContent(idea, index) {
  const key = getIdeaDraftKey(index);
  const draft = state.editingIdeas[key];
  if (draft) {
    return `
      <form class="idea-edit-form" data-idea-edit-form="${index}">
        <label>
          <span>选题标题</span>
          <input name="title" value="${escapeHtml(draft.title)}" />
        </label>
        <label>
          <span>内容摘要</span>
          <textarea name="summary" rows="3">${escapeHtml(draft.summary)}</textarea>
        </label>
        <div class="form-row">
          <label>
            <span>切入角度</span>
            <input name="angle" value="${escapeHtml(draft.angle)}" />
          </label>
          <label>
            <span>面向人群</span>
            <input name="audience" value="${escapeHtml(draft.audience)}" />
          </label>
        </div>
        <label>
          <span>品牌结合方式</span>
          <input name="brandFit" value="${escapeHtml(draft.brandFit)}" />
        </label>
        <label>
          <span>开头钩子</span>
          <input name="hook" value="${escapeHtml(draft.hook)}" />
        </label>
        <div class="idea-edit-actions">
          <button class="primary-btn small-btn" data-confirm-idea-edit="${index}" type="submit">确认</button>
          <button class="secondary-btn small-btn" data-cancel-idea-edit="${index}" type="button">取消</button>
        </div>
      </form>
    `;
  }
  return `
    <div class="idea-title-row">
      <h3>${escapeHtml(idea.title)}</h3>
      <button class="text-btn" data-edit-idea="${index}" type="button">编辑</button>
    </div>
    <div><strong>内容摘要：</strong>${escapeHtml(idea.summary)}</div>
    <div><strong>切入角度：</strong>${escapeHtml(idea.angle)}</div>
    <div><strong>品牌结合方式：</strong>${escapeHtml(idea.brandFit)}</div>
    <div><strong>面向人群：</strong>${escapeHtml(idea.audience)}</div>
    <div><strong>开头钩子：</strong>${escapeHtml(idea.hook)}</div>
    ${renderIdeaContentAssets(idea)}
  `;
}

function hasCompleteIdeaContentAssets(idea) {
  const assets = idea?.contentAssets || {};
  const slides = assets.xhsCarousel?.slides;
  return Boolean(
    assets.moments?.caption &&
      assets.xhsCarousel?.publishTitle &&
      Array.isArray(slides) &&
      slides.length === 4 &&
      assets.wechatLongImage?.intro,
  );
}

function renderIdeaContentAssets(idea) {
  const assets = idea?.contentAssets || {};
  if (!hasCompleteIdeaContentAssets(idea)) {
    return `<div class="idea-asset-preview is-incomplete">趋势和选题已生成。朋友圈、小红书和公众号的完整发布文案会在你首次生成对应内容时自动补齐。</div>`;
  }
  const moments = assets.moments || {};
  const carousel = assets.xhsCarousel || {};
  return `
    <div class="idea-asset-preview">
      <div><strong>朋友圈标题：</strong>${escapeHtml(moments.title || "")}</div>
      <div><strong>朋友圈文案：</strong>${escapeHtml(moments.caption || "")}</div>
      <div><strong>小红书标题：</strong>${escapeHtml(carousel.publishTitle || carousel.title || "")}</div>
      <div><strong>小红书文案：</strong>${escapeHtml(carousel.publishCaption || carousel.caption || "")}</div>
    </div>
  `;
}

function getIdeaProductKey(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  return `${brand?.id || "none"}:${trend?.id || "none"}:${ideaIndex}`;
}

function getIdeaAspectRatioSelection(ideaIndex) {
  const selection = state.aspectRatios[getIdeaProductKey(ideaIndex)] || "smart";
  return selection === "smart" || IMAGE_ASPECT_RATIOS.includes(selection) ? selection : "smart";
}

function getResolvedIdeaAspectRatio(ideaIndex, type) {
  const selection = getIdeaAspectRatioSelection(ideaIndex);
  return selection === "smart" ? SMART_ASPECT_RATIO_DEFAULTS[type] || "3:4" : selection;
}

function getIdeaCreativeStyleSelection(ideaIndex) {
  const value = state.creativeStylePresets[getIdeaProductKey(ideaIndex)] || "auto";
  return XHS_CREATIVE_STYLE_OPTIONS.some((option) => option.value === value) ? value : "auto";
}

function getIdeaWechatTemplateSelection(ideaIndex) {
  const value = state.wechatTemplates[getIdeaProductKey(ideaIndex)] || "auto";
  return WECHAT_TEMPLATE_OPTIONS.some((option) => option.value === value) ? value : "auto";
}

function getCreativeOption(options, value) {
  return options.find((option) => option.value === value) || options[0];
}

function getAspectRatioShapeStyle(ratio) {
  const [width, height] = String(ratio).split(":").map(Number);
  const max = 30;
  const scale = max / Math.max(width, height);
  return `width:${Math.max(5, Math.round(width * scale))}px;height:${Math.max(5, Math.round(height * scale))}px`;
}

function renderCreativeOptionSelect({ ideaIndex, field, title, options, selectedValue }) {
  const selected = getCreativeOption(options, selectedValue);
  return `
    <label class="idea-creative-field">
      <span>${escapeHtml(title)}</span>
      <select data-creative-field="${field}" data-idea-index="${ideaIndex}">
        ${options
          .map(
            (option) =>
              `<option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? "selected" : ""}>${escapeHtml(option.label)}</option>`,
          )
          .join("")}
      </select>
      <small>${escapeHtml(selected.description)}</small>
    </label>
  `;
}

function renderIdeaCreativeSettings(ideaIndex) {
  const key = getIdeaProductKey(ideaIndex);
  const selection = getIdeaAspectRatioSelection(ideaIndex);
  const styleSelection = getIdeaCreativeStyleSelection(ideaIndex);
  const wechatSelection = getIdeaWechatTemplateSelection(ideaIndex);
  const styleOption = getCreativeOption(XHS_CREATIVE_STYLE_OPTIONS, styleSelection);
  const wechatOption = getCreativeOption(WECHAT_TEMPLATE_OPTIONS, wechatSelection);
  const isOpen = state.openCreativeSettingsKey === key;
  const ratioLabel = selection === "smart" ? "智能比例" : selection;
  const options = ["smart", ...IMAGE_ASPECT_RATIOS];
  return `
    <section class="idea-creative-settings idea-aspect-ratio ${isOpen ? "is-open" : ""}">
      <button class="idea-aspect-ratio-trigger" data-toggle-creative-settings="${ideaIndex}" type="button" aria-expanded="${isOpen}">
        <span class="idea-aspect-ratio-copy">
          <strong>创作设置</strong>
          <small>${escapeHtml(styleOption.label)} · ${escapeHtml(wechatOption.label)} · ${escapeHtml(ratioLabel)}</small>
        </span>
        <span class="idea-aspect-ratio-value">
          <b>${isOpen ? "收起" : "调整"}</b>
          <span class="idea-aspect-ratio-chevron" aria-hidden="true"></span>
        </span>
      </button>
      ${
        isOpen
          ? `<div class="idea-aspect-ratio-panel">
              <div class="idea-creative-grid">
                ${renderCreativeOptionSelect({
                  ideaIndex,
                  field: "xhs",
                  title: "小红书视觉路线",
                  options: XHS_CREATIVE_STYLE_OPTIONS,
                  selectedValue: styleSelection,
                })}
                ${renderCreativeOptionSelect({
                  ideaIndex,
                  field: "wechat",
                  title: "公众号长图模板",
                  options: WECHAT_TEMPLATE_OPTIONS,
                  selectedValue: wechatSelection,
                })}
              </div>
              <div class="idea-creative-ratio">
                <div class="idea-creative-ratio-heading">
                  <strong>图片比例</strong>
                  <small>${selection === "smart" ? "按图片类型自动匹配" : "四种生图使用统一比例"}</small>
                </div>
                <div class="idea-aspect-ratio-grid">
                  ${options
                    .map((ratio) => {
                      const selected = ratio === selection;
                      return `<button class="idea-aspect-ratio-option ${selected ? "is-selected" : ""}" data-select-aspect-ratio="${ratio}" data-idea-index="${ideaIndex}" type="button">
                        <span class="idea-aspect-ratio-visual">${ratio === "smart" ? `<span class="aspect-smart-mark"><i></i><i></i></span>` : `<i class="aspect-shape" style="${getAspectRatioShapeStyle(ratio)}"></i>`}</span>
                        <span>${ratio === "smart" ? "智能" : ratio}</span>
                      </button>`;
                    })
                    .join("")}
                </div>
              </div>
              <p>视觉路线仅影响小红书组图，长图模板仅影响公众号；智能比例会为公众号使用 9:21，其余图片使用 3:4。</p>
            </div>`
          : ""
      }
    </section>
  `;
}

function isWechatAspectRatioWarningDisabled() {
  return localStorage.getItem(WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY) === "true";
}

function confirmWechatAspectRatio(ideaIndex, aspectRatio) {
  if (aspectRatio === "9:21" || isWechatAspectRatioWarningDisabled()) return Promise.resolve(aspectRatio);
  return new Promise((resolve) => {
    const dialog = document.createElement("div");
    dialog.className = "aspect-ratio-warning-backdrop";
    dialog.innerHTML = `
      <section class="aspect-ratio-warning-dialog" role="dialog" aria-modal="true" aria-labelledby="aspectRatioWarningTitle">
        <button class="aspect-ratio-warning-close" data-warning-action="cancel" type="button" aria-label="关闭">×</button>
        <div class="aspect-ratio-warning-kicker">公众号长图比例提醒</div>
        <h2 id="aspectRatioWarningTitle">当前选择的是 ${escapeHtml(aspectRatio)}</h2>
        <p>公众号长图推荐使用 9:21。继续使用 ${escapeHtml(aspectRatio)} 可能影响长图的阅读体验和版式完整性。</p>
        <label class="aspect-ratio-warning-check"><input type="checkbox" data-warning-disabled /> <span>不再提醒</span></label>
        <div class="aspect-ratio-warning-actions">
          <button class="secondary-btn" data-warning-action="use-default" type="button">改用 9:21</button>
          <button class="primary-btn" data-warning-action="continue" type="button">继续使用 ${escapeHtml(aspectRatio)}</button>
        </div>
      </section>
    `;
    const finish = (value) => {
      document.removeEventListener("keydown", onKeyDown);
      dialog.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(null);
    };
    dialog.querySelectorAll("[data-warning-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.warningAction;
        if (action === "cancel") return finish(null);
        if (action === "use-default") {
          state.aspectRatios[getIdeaProductKey(ideaIndex)] = "9:21";
          renderIdeas();
          return finish("9:21");
        }
        if (dialog.querySelector("[data-warning-disabled]")?.checked) {
          localStorage.setItem(WECHAT_ASPECT_RATIO_WARNING_DISABLED_KEY, "true");
        }
        return finish(aspectRatio);
      });
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(null);
    });
    document.body.appendChild(dialog);
    document.addEventListener("keydown", onKeyDown);
    dialog.querySelector('[data-warning-action="continue"]')?.focus();
  });
}

function getIdeaDraftKey(ideaIndex) {
  return getIdeaProductKey(ideaIndex);
}

function isBrandLogoEnabled(ideaIndex) {
  return Boolean(state.brandLogoUsage[getIdeaProductKey(ideaIndex)]);
}

function getStyleReference(ideaIndex) {
  return state.styleReferences[getIdeaProductKey(ideaIndex)] || null;
}

function buildIdeaStylePrompt(idea) {
  const parts = [
    ["选题标题", idea?.title],
    ["内容摘要", idea?.summary],
    ["切入角度", idea?.angle],
    ["品牌结合方式", idea?.brandFit],
    ["面向人群", idea?.audience],
    ["开头钩子", idea?.hook],
  ]
    .map(([label, value]) => {
      const text = String(value || "").trim();
      return text ? `${label}：${text}` : "";
    })
    .filter(Boolean);
  return parts.join("\n");
}

function renderIdeaLogoControl(ideaIndex) {
  const brand = getSelectedBrand();
  const brandLogo = brand?.logo || null;
  const isPersonal = brand?.profileType === "personal";
  const assetLabel = isPersonal ? "个人头像" : "品牌 Logo";
  const logoEnabled = isBrandLogoEnabled(ideaIndex) && Boolean(brandLogo);
  return `
    <div class="idea-logo-control">
      <label class="idea-logo-check">
        <input data-use-brand-logo="${ideaIndex}" type="checkbox" ${brandLogo ? "" : "disabled"} ${logoEnabled ? "checked" : ""} />
        <span>${isPersonal ? "使用个人头像作为视觉参考" : "使用品牌 Logo"}</span>
      </label>
      <div class="idea-logo-meta">
        <span>${brandLogo ? escapeHtml(formatImageName(brandLogo.originalName || assetLabel, 38)) : `未上传${isPersonal ? "头像" : " Logo"}`}</span>
        <label class="idea-inline-upload">
          <input data-brand-logo-image="${ideaIndex}" type="file" accept="image/*" />
          <span>${brandLogo ? `更换${isPersonal ? "头像" : " Logo"}` : `上传${isPersonal ? "头像" : " Logo"}`}</span>
        </label>
      </div>
    </div>
  `;
}

function renderIdeaProductUpload(ideaIndex) {
  const isPersonal = getSelectedBrand()?.profileType === "personal";
  const assetLabel = isPersonal ? "内容参考图" : "产品图";
  const selection = getProductSelection(ideaIndex);
  const selectedImages = selection.images;
  const selectedCount = selectedImages.length;
  const checked = selection.useImage;
  const fileLabel = selectedCount ? selectedImages.map((image) => image.fileName || image.name || assetLabel).join("、") : "";
  const selectedPreview = selectedCount
    ? `<div class="idea-product-selected-strip">${selectedImages
        .slice(0, MAX_SELECTED_PRODUCT_IMAGES)
        .map(
          (image) => `
            <div class="idea-product-selected-preview" title="${escapeHtml(image.fileName || image.name || assetLabel)}">
              <img src="${productImageSrc(image)}" alt="${escapeHtml(image.fileName || image.name || assetLabel)}" />
            </div>
          `,
        )
        .join("")}</div>`
    : "";
  return `
    <div class="idea-product-upload">
      <div class="idea-product-upload-top idea-product-control-row">
        <div class="idea-product-summary">
          <div>
            <div class="idea-product-upload-title">${assetLabel}参考</div>
            <div class="idea-product-file ${selectedCount ? "has-file" : ""}" data-product-file="${ideaIndex}">
              ${
                selectedCount
                  ? escapeHtml(
                      checked
                        ? `已选择 ${selectedCount} 张：${formatImageName(fileLabel, 46)}，生图时会作为主体参考`
                        : `已选择 ${selectedCount} 张：${formatImageName(fileLabel, 46)}`,
                    )
                    : `未选择${assetLabel}`
              }
            </div>
            <div class="idea-product-file">最多 ${MAX_SELECTED_PRODUCT_IMAGES} 张，共 ${formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES)}；当前 ${selectedCount} 张，约 ${formatFileSize(getSelectionTotalBytes(selectedImages))}</div>
          </div>
        </div>
        <div class="idea-product-button-stack">
          <label class="idea-upload-button">
            <input data-product-image="${ideaIndex}" type="file" accept="image/*" multiple />
            <span>${selectedCount ? "继续上传" : `上传${assetLabel}`}</span>
          </label>
          <button class="idea-library-button" data-open-product-library="${ideaIndex}" type="button">选择已上传图片</button>
        </div>
      </div>
      ${selectedPreview}
      <div class="idea-product-actions idea-product-actions-bottom">
        <label class="idea-product-check">
          <input data-use-product-image="${ideaIndex}" type="checkbox" ${selectedCount ? "" : "disabled"} ${checked ? "checked" : ""} />
          使用这些${assetLabel}生成图片
        </label>
        ${selectedCount ? `<button class="idea-product-clear" data-clear-product-image="${ideaIndex}" type="button">清除当前选择</button>` : ""}
      </div>
    </div>
  `;
}

function renderIdeaStyleReferenceUpload(ideaIndex) {
  const styleReference = getStyleReference(ideaIndex);
  const preview = styleReference
    ? `
      <div class="idea-product-selected-strip">
        <div class="idea-product-selected-preview idea-style-reference-preview" title="${escapeHtml(styleReference.fileName || "风格参考图")}">
          <img src="${escapeHtml(styleReference.dataUrl)}" alt="${escapeHtml(styleReference.fileName || "风格参考图")}" />
        </div>
      </div>
    `
    : "";
  return `
    <div class="idea-product-upload idea-style-upload">
      <div class="idea-product-upload-top">
        <div class="idea-product-summary">
          <div>
            <div class="idea-product-upload-title">风格图参考</div>
            <div class="idea-product-file ${styleReference ? "has-file" : ""}">
              ${styleReference ? `${escapeHtml(formatImageName(styleReference.fileName || "风格参考图", 46))}，约 ${formatFileSize(styleReference.sizeBytes)}，用于一键风格化图的色调和版式参考` : "未选择参考图"}
            </div>
            <div class="idea-product-file">只能上传 1 张，${formatFileSize(MAX_SINGLE_UPLOAD_IMAGE_BYTES)} 内</div>
          </div>
        </div>
        <div class="idea-product-button-stack">
          <label class="idea-upload-button">
            <input data-style-reference-image="${ideaIndex}" type="file" accept="image/*" />
            <span>${styleReference ? "更换参考图" : "上传参考图"}</span>
          </label>
        </div>
      </div>
      ${preview}
      ${styleReference ? `<button class="idea-product-clear idea-style-clear" data-clear-style-reference="${ideaIndex}" type="button">清除参考图</button>` : ""}
    </div>
  `;
}

function getSelectedProductImages(ideaIndex) {
  const selection = getProductSelection(ideaIndex);
  if (!selection.useImage) return [];
  return selection.images
    .map((productImage) => {
      if (productImage.id) {
        return {
          id: productImage.id,
          name: productImage.fileName,
        };
      }
      if (!productImage.dataUrl) return null;
      return {
        name: productImage.fileName,
        dataUrl: productImage.dataUrl,
      };
    })
    .filter(Boolean);
}

async function loadGenerationHistory() {
  if (!state.sessionToken) return;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.generationHistoryFilters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  const result = await request(query ? `/api/history?${query}` : "/api/history");
  state.generationHistory = result.generations;
  renderGenerationHistory();
}

async function loadLatestGenerationHistory() {
  state.generationHistoryNeedsLatest = true;
  state.generationHistoryFilters = createEmptyGenerationHistoryFilters();
  await loadGenerationHistory();
  state.generationHistoryNeedsLatest = false;
}

function refreshGenerationHistoryOnHistoryTab() {
  if (!state.sessionToken) return;
  const load = state.generationHistoryNeedsLatest ? loadLatestGenerationHistory : loadGenerationHistory;
  load().catch((error) => alert(`加载历史失败：${error.message}`));
}

function markGenerationHistoryNeedsLatest() {
  state.generationHistoryNeedsLatest = true;
}

async function refreshGenerationHistoryAfterGeneration() {
  markGenerationHistoryNeedsLatest();
  if (state.currentTab === "history") {
    await loadLatestGenerationHistory();
    return;
  }
  state.generationHistoryFilters = createEmptyGenerationHistoryFilters();
  await loadGenerationHistory();
  state.generationHistoryNeedsLatest = false;
}

function normalizeHistoryText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHistoryDateBoundary(value, mode) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return mode === "to" ? `${input}T23:59:59.999Z` : `${input}T00:00:00.000Z`;
  }
  return input;
}

function matchesGenerationHistoryFilters(item, filters = state.generationHistoryFilters) {
  if (!item) return false;
  if (filters.brandId && String(item.brandId) !== String(filters.brandId)) return false;
  if (filters.type && item.type !== filters.type) return false;

  const query = normalizeHistoryText(filters.q);
  if (query) {
    const haystack = [item.cardTitle, item.summary, item.trendTitle, item.brandName, item.ideaTitle]
      .map(normalizeHistoryText)
      .join(" ");
    if (!haystack.includes(query)) return false;
  }

  const createdAt = String(item.createdAt || "");
  const from = normalizeHistoryDateBoundary(filters.from, "from");
  const to = normalizeHistoryDateBoundary(filters.to, "to");
  if (from && createdAt < from) return false;
  if (to && createdAt > to) return false;

  return true;
}

function getVisibleGenerationHistory() {
  return state.generationHistory.filter((item) => matchesGenerationHistoryFilters(item));
}

function bindHistoryFilters() {
  const controls = [
    ["historySearchInput", "q", "input"],
    ["historyBrandFilter", "brandId", "change"],
    ["historyTypeFilter", "type", "change"],
    ["historyFromFilter", "from", "change"],
    ["historyToFilter", "to", "change"],
  ];
  controls.forEach(([id, key, eventName]) => {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener(eventName, () => {
      state.generationHistoryFilters[key] = control.value;
      scheduleGenerationHistoryLoad(eventName === "input");
    });
  });

  document.getElementById("resetHistoryFilters")?.addEventListener("click", () => {
    state.generationHistoryFilters = { q: "", brandId: "", type: "", from: "", to: "" };
    renderGenerationHistoryFilters();
    loadGenerationHistory().catch((error) => alert(`加载历史失败：${error.message}`));
  });
}

function scheduleGenerationHistoryLoad(useDelay) {
  if (historyFilterTimer) window.clearTimeout(historyFilterTimer);
  const delay = useDelay ? 280 : 0;
  historyFilterTimer = window.setTimeout(() => {
    loadGenerationHistory().catch((error) => alert(`加载历史失败：${error.message}`));
  }, delay);
}

function renderGenerationHistoryFilters() {
  const filters = state.generationHistoryFilters;
  const search = document.getElementById("historySearchInput");
  const brandSelect = document.getElementById("historyBrandFilter");
  const typeSelect = document.getElementById("historyTypeFilter");
  const from = document.getElementById("historyFromFilter");
  const to = document.getElementById("historyToFilter");
  if (search) search.value = filters.q;
  if (typeSelect) typeSelect.value = filters.type;
  if (from) from.value = filters.from;
  if (to) to.value = filters.to;
  if (brandSelect) {
    const current = filters.brandId;
    brandSelect.innerHTML = `
      <option value="">全部品牌</option>
      ${state.brands.map((brand) => `<option value="${brand.id}">${escapeHtml(brand.name)}</option>`).join("")}
    `;
    brandSelect.value = state.brands.some((brand) => String(brand.id) === String(current)) ? current : "";
    if (brandSelect.value !== current) {
      state.generationHistoryFilters.brandId = "";
    }
  }
}

async function deleteGenerationHistoryItem(generationId) {
  const item = state.generationHistory.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  if (!confirm(`确定删除「${item.cardTitle || item.ideaTitle || "这条生成内容"}」吗？删除后将无法找回。`)) return;
  try {
    await request(`/api/history/${generationId}`, { method: "DELETE" });
    state.generationHistory = state.generationHistory.filter((generation) => Number(generation.id) !== Number(generationId));
    renderGenerationHistory();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function renderGenerationHistory() {
  const root = document.getElementById("generationHistoryList");
  if (!root) return;
  renderGenerationHistoryFilters();
  const visibleHistory = getVisibleGenerationHistory();

  if (!visibleHistory.length) {
    const hasFilters = Object.values(state.generationHistoryFilters).some(Boolean);
    root.innerHTML = `<article class="brand-card"><div class="brand-description">${hasFilters ? "没有找到符合筛选条件的历史生成记录。" : "你还没有任何生成记录。去内容选题页生成朋友圈图、公众号长图或小红书组图后，这里会自动沉淀下来。"}</div></article>`;
    return;
  }

  root.innerHTML = visibleHistory
    .map((item) => {
      const payload = item.payload || {};
      const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
      const aspectRatio = KNOWN_ASPECT_RATIOS.has(payload.aspectRatio) ? payload.aspectRatio : "";
      let contentHtml = "";

      if (item.type === "moments") {
        contentHtml = `
          <div class="history-generate-copy"><strong>朋友圈文案：</strong>${escapeHtml(getDisplayMomentsCaption(item, payload))}</div>
          <div class="history-generate-copy"><strong>视觉方向：</strong>${escapeHtml(payload.visualDirection || "")}</div>
        `;
      } else if (item.type === "wechat") {
        contentHtml = `
          <div class="history-generate-copy"><strong>发布标题：</strong>${escapeHtml(payload.publishTitle || "")}</div>
          <div class="history-generate-copy"><strong>文章导语：</strong>${escapeHtml(payload.intro || "")}</div>
        `;
      } else if (item.type === "styleImage") {
        contentHtml = `
          <div class="history-generate-copy"><strong>内容摘要：</strong>${escapeHtml(item.summary || payload.visualDirection || "风格化图片")}</div>
          <div class="history-generate-copy"><strong>用途：</strong>公众号封面、节日祝福海报或运营视觉</div>
        `;
      } else if (item.type === "xhsCarousel") {
        contentHtml = `
          <div class="history-generate-copy"><strong>发布标题：</strong>${escapeHtml(getDisplayXhsPublishTitle(item, payload))}</div>
          <div class="history-generate-copy"><strong>发布文案：</strong>${escapeHtml(getDisplayXhsPublishCaption(item, payload))}</div>
        `;
      } else {
        contentHtml = `
          <div class="history-generate-copy"><strong>发布标题：</strong>${escapeHtml(payload.publishTitle || "")}</div>
          <div class="history-generate-copy"><strong>发布文案：</strong>${escapeHtml(payload.publishCaption || "")}</div>
        `;
      }

      const previewHtml =
        item.type === "xhsCarousel"
          ? `
            <div class="history-generate-grid">
              ${(payload.slides || [])
                .slice(0, 4)
                .filter((slide) => safeImageSrc(slide.imageUrl || slide.previewUrl))
                .map(
                  (slide) =>
                    `<img src="${authenticatedImageSrc(slide.imageUrl || slide.previewUrl)}" alt="${escapeHtml(slide.title)}" loading="lazy" decoding="async" data-history-image="true" />`,
                )
                .join("")}
            </div>
          `
          : item.previewUrl
            ? `<div class="history-generate-preview"><img src="${authenticatedImageSrc(item.previewUrl)}" alt="${escapeHtml(item.cardTitle)}" loading="lazy" decoding="async" data-history-image="true" /></div>`
            : "";

      return `
        <article class="history-generate-card">
          <div class="history-generate-top">
            <div>
              <div class="history-generate-meta">
                <span class="brand-tag">${escapeHtml(item.channelLabel)}</span>
                <span class="brand-tag">${escapeHtml(HISTORY_TYPE_LABELS.get(item.type) || item.type)}</span>
                ${aspectRatio ? `<span class="brand-tag history-aspect-ratio"><i class="aspect-shape" style="${getAspectRatioShapeStyle(aspectRatio)}"></i>${escapeHtml(aspectRatio)}</span>` : ""}
                <span class="panel-subtitle">${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }))}</span>
                ${editHistory.length ? `<span class="brand-tag">已改图 ${editHistory.length} 次</span>` : ""}
              </div>
              <h3>${escapeHtml(item.cardTitle)}</h3>
              <div class="history-generate-ref">${escapeHtml(item.brandName)} · ${escapeHtml(item.trendTitle)}</div>
              <div class="history-generate-ref">${escapeHtml(item.ideaTitle)}</div>
            </div>
            <div class="history-generate-actions">
              ${getGenerationPrimaryImageUrl(item) ? `<button class="secondary-btn small-btn history-action-button" data-open-history-generation="${item.id}" type="button">改图</button>` : ""}
              <button class="secondary-btn small-btn history-action-button" data-delete-history-generation="${item.id}" type="button">删除</button>
            </div>
          </div>
          ${contentHtml}
          ${previewHtml ? `<button class="history-preview-button" data-open-history-generation="${item.id}" type="button">${previewHtml}</button>` : ""}
        </article>
      `;
    })
    .join("");

  root.querySelectorAll("[data-open-history-generation]").forEach((button) => {
    button.addEventListener("click", () => openHistoryGeneration(Number(button.dataset.openHistoryGeneration)));
  });
  root.querySelectorAll("[data-delete-history-generation]").forEach((button) => {
    button.addEventListener("click", () => deleteGenerationHistoryItem(Number(button.dataset.deleteHistoryGeneration)));
  });
  bindHistoryImageRetry(root);
}

function bindHistoryImageRetry(root) {
  root.querySelectorAll("img[data-history-image]").forEach((image) => {
    image.addEventListener("error", () => retryHistoryImageAfterSignatureRefresh(image), { once: true });
  });
}

function getHistoryImageRetryPath(image) {
  try {
    return new URL(image.currentSrc || image.src, window.location.origin).pathname;
  } catch (error) {
    return image.currentSrc || image.src || "";
  }
}

function retryHistoryImageAfterSignatureRefresh(image) {
  const retryPath = getHistoryImageRetryPath(image);
  if (!retryPath || retriedHistoryImagePaths.has(retryPath)) return;
  retriedHistoryImagePaths.add(retryPath);
  if (!historyImageSignatureRefreshInFlight) {
    historyImageSignatureRefreshInFlight = loadGenerationHistory()
      .catch((error) => console.warn("历史图片刷新失败", error.message))
      .finally(() => {
        historyImageSignatureRefreshInFlight = null;
      });
  }
}

function getGenerationPrimaryImageUrl(item) {
  if (item?.previewUrl) return item.previewUrl;
  const slides = Array.isArray(item?.payload?.slides) ? item.payload.slides : [];
  const slide = slides.find((candidate) => safeImageSrc(candidate.imageUrl || candidate.previewUrl));
  return slide?.imageUrl || slide?.previewUrl || "";
}

function isInternalXhsCopy(value) {
  return /适合.*组图结构|这套组图适合|先把|封面先|继续展开|根据选题|收藏理由|明确点击理由|真实问题|进入理由|组图可以|热点翻译成|自然进入用户/.test(String(value || ""));
}

function cleanXhsTitle(value) {
  return String(value || "")
    .replace(/｜小红书组图方案/g, "")
    .replace(/：适合[^：。]*组图结构/g, "")
    .replace(/:适合[^:。]*组图结构/g, "")
    .trim();
}

function getDisplayXhsPublishTitle(item, payload) {
  const rawTitle = payload.publishTitle || payload.title || item.cardTitle || item.ideaTitle || "";
  const cleanedTitle = cleanXhsTitle(rawTitle);
  if (cleanedTitle && !isInternalXhsCopy(cleanedTitle)) return cleanedTitle;
  return cleanXhsTitle(item.ideaTitle || payload.title || item.cardTitle || "");
}

function getDisplayXhsPublishCaption(item, payload) {
  const rawCaption = payload.publishCaption || payload.caption || "";
  if (rawCaption && !isInternalXhsCopy(rawCaption)) return rawCaption;
  return "";
}

function renderHistoryDetailParagraph(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `<p><strong>${escapeHtml(label)}：</strong>${escapeHtml(text)}</p>`;
}

function isInternalMomentsCaption(value) {
  return /这句话挺适合发朋友圈|不是为了追热点|落到.*真实场景|真正打动人的反而是|换个角度聊聊|好的内容不一定|能提供的价值其实/.test(String(value || ""));
}

function getDisplayMomentsCaption(item, payload) {
  const rawCaption = payload.caption || "";
  if (rawCaption && !isInternalMomentsCaption(rawCaption)) return rawCaption;
  return "";
}

function renderHistoryAssetCopyDetails(item, payload) {
  if (item.type === "moments") {
    return renderHistoryDetailParagraph("朋友圈文案", getDisplayMomentsCaption(item, payload));
  }
  if (item.type === "wechat") {
    return `
      ${renderHistoryDetailParagraph("发布标题", payload.publishTitle)}
      ${renderHistoryDetailParagraph("文章导语", payload.intro)}
    `;
  }
  return "";
}

function openHistoryGeneration(generationId, selectedSlideIndex = 0) {
  const item = state.generationHistory.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  const payload = item.payload || {};
  if (item.type === "xhsCarousel" && Array.isArray(payload.slides) && payload.slides.length) {
    openCarouselHistoryGeneration(item, selectedSlideIndex);
    return;
  }
  const imageUrl = getGenerationPrimaryImageUrl(item);
  if (!imageUrl) return;
  const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
  const imageResult = openAssetModal({
    kicker: "历史图片",
    title: item.cardTitle || "历史图片",
    description: "查看历史生成图片，可继续追加提示词改图，并保留每次改图记录。",
    loadingTitle: "正在打开历史图片...",
    loadingCopy: "正在整理图片和改图记录。",
  });
  imageResult.innerHTML = `
    <div class="asset-header-card">
      <h3>${escapeHtml(item.cardTitle || "历史图片")}</h3>
      <p><strong>生成类型：</strong>${escapeHtml(item.channelLabel || "")}</p>
      <p><strong>来源选题：</strong>${escapeHtml(item.ideaTitle || "")}</p>
      ${renderHistoryAssetCopyDetails(item, payload)}
    </div>
    <div class="asset-grid">
      <div class="image-preview-card">
        <img src="${authenticatedImageSrc(imageUrl)}" alt="${escapeHtml(item.cardTitle || "历史图片")}" />
      </div>
      <div class="image-meta-card">
        <h3>原图改图</h3>
        ${renderImageEditPanel({
          imageUrl,
          title: item.cardTitle || "改图结果",
          aspectRatio: payload.aspectRatio || "",
          generationId: item.id,
        })}
      </div>
    </div>
    <div class="image-edit-history-block">
      <h3>图片修改历史</h3>
      ${renderImageEditHistory(editHistory, item)}
    </div>
  `;
  bindImageEditActions(imageResult);
}

function openCarouselHistoryGeneration(item, selectedSlideIndex = 0) {
  const payload = item.payload || {};
  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  const requestedIndex = Math.min(Math.max(Number(selectedSlideIndex) || 0, 0), Math.max(slides.length - 1, 0));
  const firstImageIndex = slides.findIndex((slide) => safeImageSrc(slide.imageUrl || slide.previewUrl));
  const safeIndex = safeImageSrc(slides[requestedIndex]?.imageUrl || slides[requestedIndex]?.previewUrl) ? requestedIndex : firstImageIndex;
  if (safeIndex < 0) return;
  const selectedSlide = slides[safeIndex] || {};
  const imageUrl = selectedSlide.imageUrl || selectedSlide.previewUrl;
  if (!imageUrl) return;
  const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
  const imageResult = openAssetModal({
    kicker: "历史组图",
    title: item.cardTitle || "小红书组图",
    description: "选择任意一张组图继续追加提示词改图，并保留每次改图记录。",
    loadingTitle: "正在打开历史组图...",
    loadingCopy: "正在整理组图图片和改图记录。",
  });
  imageResult.innerHTML = `
    <div class="asset-header-card">
      <h3>${escapeHtml(item.cardTitle || "小红书组图")}</h3>
      <p><strong>生成类型：</strong>${escapeHtml(item.channelLabel || "")}</p>
      <p><strong>来源选题：</strong>${escapeHtml(item.ideaTitle || "")}</p>
      ${renderHistoryDetailParagraph("发布标题", getDisplayXhsPublishTitle(item, payload))}
      ${renderHistoryDetailParagraph("发布文案", getDisplayXhsPublishCaption(item, payload))}
    </div>
    <div class="history-carousel-picker">
      ${slides
        .map((slide, index) => {
          const url = slide.imageUrl || slide.previewUrl;
          return `
            <button class="history-carousel-thumb ${index === safeIndex ? "is-active" : ""}" data-history-slide-index="${index}" type="button" ${url ? "" : "disabled"}>
              ${url ? `<img src="${authenticatedImageSrc(url)}" alt="${escapeHtml(slide.title || `第 ${index + 1} 张`)}" />` : ""}
              <span>${escapeHtml(slide.pageLabel || `第 ${index + 1} 张`)}</span>
            </button>
          `;
        })
        .join("")}
    </div>
    <div class="asset-grid">
      <div class="image-preview-card">
        <img src="${authenticatedImageSrc(imageUrl)}" alt="${escapeHtml(selectedSlide.title || item.cardTitle || "小红书组图")}" />
      </div>
      <div class="image-meta-card">
        <h3>${escapeHtml(selectedSlide.pageLabel || `第 ${safeIndex + 1} 张`)} · ${escapeHtml(selectedSlide.title || item.cardTitle || "小红书组图")}</h3>
        ${renderImageEditPanel({
          imageUrl,
          title: `${selectedSlide.pageLabel || `第 ${safeIndex + 1} 张`} · ${selectedSlide.title || item.cardTitle || "改图结果"}`,
          aspectRatio: selectedSlide.aspectRatio || payload.aspectRatio || "3:4",
          generationId: item.id,
          slideIndex: safeIndex,
        })}
      </div>
    </div>
    <div class="image-edit-history-block">
      <h3>图片修改历史</h3>
      ${renderImageEditHistory(editHistory, item)}
    </div>
  `;
  imageResult.querySelectorAll("[data-history-slide-index]").forEach((button) => {
    button.addEventListener("click", () => openHistoryGeneration(item.id, Number(button.dataset.historySlideIndex)));
  });
  bindImageEditActions(imageResult);
}

function renderImageEditHistory(editHistory, generation) {
  if (!editHistory.length) {
    return `<div class="idea-copy">还没有改图记录。</div>`;
  }
  return `
    <div class="image-edit-history-list">
      ${editHistory
        .map(
          (entry) => `
            <article class="image-edit-history-card">
              <img src="${authenticatedImageSrc(entry.imageUrl || entry.previewUrl)}" alt="${escapeHtml(entry.title || "改图结果")}" />
              <div>
                <div class="history-generate-meta">
                  <span class="brand-tag">改图</span>
                  ${entry.sourceSlideIndex != null ? `<span class="brand-tag">第 ${Number(entry.sourceSlideIndex) + 1} 张</span>` : ""}
                  <span class="panel-subtitle">${escapeHtml(new Date(entry.completedAt || entry.createdAt || Date.now()).toLocaleString("zh-CN", { hour12: false }))}</span>
                </div>
                <h3>${escapeHtml(entry.title || "改图结果")}</h3>
                ${renderImageEditPanel({
                  imageUrl: entry.imageUrl || entry.previewUrl,
                  title: entry.title || generation.cardTitle || "改图结果",
                  aspectRatio: entry.aspectRatio || generation.payload?.aspectRatio || "",
                  generationId: generation.id,
                  parentEditId: entry.id,
                  slideIndex: entry.sourceSlideIndex,
                })}
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function openAssetModal({ kicker, title, description, loadingTitle, loadingCopy }) {
  const imageModal = document.getElementById("imageModal");
  const imageResult = document.getElementById("imageResult");
  document.getElementById("assetModalKicker").textContent = kicker;
  document.getElementById("assetModalTitle").textContent = title;
  document.getElementById("assetModalDescription").textContent = description;
  imageModal.classList.add("is-open");
  imageResult.innerHTML = `<div class="image-meta-card"><h3>${escapeHtml(loadingTitle)}</h3><div class="idea-copy">${escapeHtml(loadingCopy)}</div></div>`;
  return imageResult;
}

function renderImageEditPanel({ imageUrl, title, aspectRatio, generationId, parentEditId, slideIndex }) {
  const safeUrl = safeImageSrc(imageUrl);
  if (!safeUrl) return "";
  const slideValue = slideIndex == null ? "" : String(slideIndex);
  return `
    <form class="asset-edit-form" data-edit-image-url="${escapeHtml(safeUrl)}" data-edit-title="${escapeHtml(title || "改图结果")}" data-edit-aspect-ratio="${escapeHtml(aspectRatio || "")}" data-edit-generation-id="${escapeHtml(generationId || "")}" data-edit-parent-id="${escapeHtml(parentEditId || "")}" data-edit-slide-index="${escapeHtml(slideValue)}">
      <label>
        <span>追加提示词改图</span>
        <textarea data-edit-prompt rows="3" placeholder="例如：把背景改成暖色木质桌面，保留产品主体和构图。"></textarea>
      </label>
      <div class="asset-edit-actions">
        <button class="primary-btn small-btn cost-button" data-edit-submit type="submit"><span>按提示词改图</span><small>1 积分</small></button>
        <div class="asset-edit-status" data-edit-status></div>
      </div>
    </form>
  `;
}

function bindImageEditActions(root) {
  root.querySelectorAll(".asset-edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = form.querySelector("[data-edit-prompt]")?.value.trim() || "";
      const status = form.querySelector("[data-edit-status]");
      const button = form.querySelector("[data-edit-submit]");
      if (!prompt) {
        if (status) status.textContent = "请先填写改图提示词。";
        return;
      }
      button.disabled = true;
      if (status) status.textContent = "正在提交改图任务...";
      try {
        const result = await request("/api/image-edits", {
          method: "POST",
          body: JSON.stringify({
            imageUrl: form.dataset.editImageUrl,
            prompt,
            title: form.dataset.editTitle,
            aspectRatio: form.dataset.editAspectRatio,
            generationId: form.dataset.editGenerationId,
            parentEditId: form.dataset.editParentId,
            slideIndex: form.dataset.editSlideIndex,
          }),
        });
        updateCurrentUser(result.user);
        if (!result.jobId) throw new Error("改图任务创建失败");
        if (status) status.textContent = "改图任务已提交，正在等待结果...";
        const imageConcept = await pollImageJob(result.jobId);
        const nextUrl = safeImageSrc(imageConcept.imageUrl || imageConcept.previewUrl);
        if (!nextUrl) throw new Error("改图完成但没有返回图片地址");
        const previewImage = form.closest(".asset-grid")?.querySelector(".image-preview-card img") || root.querySelector(".image-preview-card img");
        if (previewImage) previewImage.src = authenticatedImageSrc(nextUrl);
        form.dataset.editImageUrl = nextUrl;
        form.querySelector("[data-edit-prompt]").value = "";
        if (status) status.textContent = "改图完成，可继续追加提示词。";
        if (form.dataset.editGenerationId) {
          await refreshGenerationHistoryAfterGeneration();
          openHistoryGeneration(Number(form.dataset.editGenerationId), Number(form.dataset.editSlideIndex || 0));
        }
      } catch (error) {
        if (isStaleSessionRequest(error)) return;
        if (status) status.textContent = `改图失败：${error.message}`;
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function generateImageConcept(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  if (!brand || !trend) return;
  let pendingTaskId = "";
  const aspectRatio = getResolvedIdeaAspectRatio(ideaIndex, "moments");

  const imageResult = openAssetModal({
    kicker: "AI 朋友圈图",
    title: "朋友圈图与文案方案",
    description: "根据当前选题自动生成朋友圈分享主图和配套文案。",
    loadingTitle: "AI 正在生成朋友圈图...",
    loadingCopy: "正在调用真实生图服务，生成当前选题对应的朋友圈图。外部服务通常需要 30-90 秒，请稍等。",
  });

  try {
    const job = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/image`, {
      method: "POST",
      body: JSON.stringify({
        productImages: getSelectedProductImages(ideaIndex),
        useBrandLogo: isBrandLogoEnabled(ideaIndex),
        aspectRatio,
      }),
    });
    updateCurrentUser(job.user);
    if (!job.jobId) {
      throw new Error("图片任务创建失败");
    }
    pendingTaskId = `moments:${job.jobId}`;
    addPendingImageTask({
      id: pendingTaskId,
      type: "single",
      channel: "moments",
      jobId: job.jobId,
    });
    imageResult.innerHTML = `<div class="image-meta-card"><h3>AI 正在生成朋友圈图...</h3><div class="idea-copy">图片任务已提交，正在等待外部服务返回结果。这一步通常需要几十秒。</div></div>`;
    const imageConcept = await pollImageJob(job.jobId);
    await refreshGenerationHistoryAfterGeneration();
    removePendingImageTask(pendingTaskId);
    const generatedImageUrl = imageConcept.imageUrl || imageConcept.previewUrl;
    imageResult.innerHTML = `
      <div class="asset-header-card">
        <h3>${escapeHtml(imageConcept.title)}</h3>
        <p><strong>朋友圈文案：</strong>${escapeHtml(imageConcept.caption || "")}</p>
      </div>
      <div class="asset-grid">
        <div class="image-preview-card">
          <img src="${authenticatedImageSrc(generatedImageUrl)}" alt="${escapeHtml(imageConcept.title)}" />
        </div>
        <div class="image-meta-card">
          <h3>${escapeHtml(imageConcept.title)}</h3>
          <div class="image-meta-item">
            <span>视觉方向</span>
            <div>${escapeHtml(imageConcept.visualDirection)}</div>
          </div>
          <div class="image-meta-item">
            <span>风格</span>
            <div>${escapeHtml(imageConcept.style)}</div>
          </div>
          <div class="image-meta-item">
            <span>构图建议</span>
            <div>${escapeHtml(imageConcept.composition)}</div>
          </div>
          ${renderImageEditPanel({
            imageUrl: generatedImageUrl,
            title: imageConcept.title,
            aspectRatio: imageConcept.aspectRatio,
          })}
        </div>
      </div>
    `;
    bindImageEditActions(imageResult);
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    if (pendingTaskId) removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `<div class="image-meta-card"><h3>生成失败</h3><div class="idea-copy">生图服务暂时不可用：${escapeHtml(error.message)}</div></div>`;
  }
}

async function generateWechatLongImage(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  if (!brand || !trend) return;
  const aspectRatio = await confirmWechatAspectRatio(ideaIndex, getResolvedIdeaAspectRatio(ideaIndex, "wechat"));
  if (!aspectRatio) return;
  let pendingTaskId = "";

  const imageResult = openAssetModal({
    kicker: "AI 公众号长图",
    title: "微信公众号内容长图方案",
    description: "输出适合公众号场景的发布标题、导语、结构和长图视觉方向。",
    loadingTitle: "AI 正在生成公众号长图方案...",
    loadingCopy: "正在组合标题、导语、文章结构和长图视觉方向。",
  });

  try {
    const result = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/wechat-long-image`, {
      method: "POST",
      body: JSON.stringify({
        productImages: getSelectedProductImages(ideaIndex),
        useBrandLogo: isBrandLogoEnabled(ideaIndex),
        wechatTemplate: getIdeaWechatTemplateSelection(ideaIndex),
        aspectRatio,
      }),
    });
    updateCurrentUser(result.user);
    const pack = result.wechatPack;
    if (!result.jobId) {
      throw new Error("公众号长图任务创建失败");
    }
    pendingTaskId = `wechat:${result.jobId}`;
    addPendingImageTask({
      id: pendingTaskId,
      type: "single",
      channel: "wechat",
      jobId: result.jobId,
    });
    imageResult.innerHTML = `<div class="image-meta-card"><h3>AI 正在生成公众号长图...</h3><div class="idea-copy">图片任务已提交，正在等待外部生图服务返回结果。这一步通常需要几十秒。</div></div>`;
    const imageConcept = await pollImageJob(result.jobId);
    pack.previewUrl = imageConcept.imageUrl || imageConcept.previewUrl;
    pack.imageUrl = imageConcept.imageUrl || imageConcept.previewUrl;
    await refreshGenerationHistoryAfterGeneration();
    removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `
      <div class="asset-header-card">
        <h3>${escapeHtml(pack.title)}</h3>
        <p><strong>发布标题：</strong>${escapeHtml(pack.publishTitle)}</p>
        <p><strong>文章导语：</strong>${escapeHtml(pack.intro)}</p>
        <ol>
          ${pack.outline.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ol>
      </div>
      <div class="asset-grid">
        <div class="image-preview-card">
          <img src="${authenticatedImageSrc(pack.imageUrl || pack.previewUrl)}" alt="${escapeHtml(pack.title)}" />
        </div>
        <div class="image-meta-card">
          <h3>公众号长图制作说明</h3>
          <div class="image-meta-item">
            <span>长图定位</span>
            <div>${escapeHtml(pack.positioning)}</div>
          </div>
          <div class="image-meta-item">
            <span>适合插入的 CTA</span>
            <div>${escapeHtml(pack.cta)}</div>
          </div>
          ${renderImageEditPanel({
            imageUrl: pack.imageUrl || pack.previewUrl,
            title: pack.title,
            aspectRatio: pack.aspectRatio || imageConcept.aspectRatio || aspectRatio,
          })}
        </div>
      </div>
    `;
    bindImageEditActions(imageResult);
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    if (pendingTaskId) removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `<div class="image-meta-card"><h3>生成失败</h3><div class="idea-copy">${escapeHtml(error.message)}</div></div>`;
  }
}

function enrichXhsCarouselSlides(pack) {
  const slides = Array.isArray(pack?.slides) ? pack.slides.slice(0, 4) : [];
  return slides.map((slide, index) => ({
    ...slide,
    pageLabel: slide.pageLabel || `第 ${index + 1} 张`,
    visualDirection: slide.visualDirection || slide.title || `第 ${index + 1} 张视觉方向`,
    style: slide.style || "小红书组图封面页，清晰、真实、适合收藏",
    composition: slide.composition || `小红书组图${index + 1}/4，比例${pack.aspectRatio || "3:4"}，标题清晰，画面有连续组图统一性。`,
    prompt: slide.prompt || "",
    isGenerating: false,
    error: "",
  }));
}

function createXhsCarouselGroupId(brandId, trendId, ideaIndex) {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `xhs-${brandId}-${trendId}-${ideaIndex}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function syncXhsCarouselPromptInputs(root, pack) {
  root.querySelectorAll("[data-carousel-prompt]").forEach((textarea) => {
    const slideIndex = Number(textarea.dataset.carouselPrompt);
    if (pack.slides[slideIndex]) {
      pack.slides[slideIndex].prompt = textarea.value.trim();
    }
  });
}

function hasXhsCarouselSlideImage(slide) {
  return Boolean(safeImageSrc(slide?.imageUrl || slide?.previewUrl));
}

function getXhsCarouselSlideStatus(slide, hasImage) {
  if (slide.error) return slide.error;
  if (slide.isEditing) return "改图中";
  if (slide.editQueued) return "改图排队中";
  if (slide.isGenerating) return "生图中";
  if (slide.isQueued) return "排队中";
  return hasImage ? "已生成" : `${slide.pageLabel}待生成`;
}

function renderXhsCarouselDraft(imageResult, pack, stateFlags = {}) {
  const remainingSlideCount = pack.slides.filter((slide) => !hasXhsCarouselSlideImage(slide)).length;
  const generateAllCost = Math.max(remainingSlideCount, 1);
  imageResult.innerHTML = `
    <div class="carousel-draft-shell">
      <div class="asset-header-card">
        <h3>${escapeHtml(pack.title)}</h3>
        <p><strong>发布标题：</strong>${escapeHtml(pack.publishTitle)}</p>
        <p><strong>发布文案：</strong>${escapeHtml(pack.publishCaption)}</p>
        <p><strong>组图说明：</strong>${escapeHtml(pack.caption)}</p>
      </div>
      <div class="carousel-draft-list">
        ${pack.slides
          .map((slide, index) => {
            const imageUrl = slide.imageUrl || slide.previewUrl;
            const hasImage = hasXhsCarouselSlideImage(slide);
            const busy = slide.isGenerating || slide.isQueued || slide.isEditing || slide.editQueued;
            return `
              <article class="carousel-draft-slide ${hasImage ? "has-image" : ""}" data-carousel-slide="${index}">
                <div class="carousel-draft-preview">
                  ${
                    hasImage
                      ? `<img src="${authenticatedImageSrc(imageUrl)}" alt="${escapeHtml(slide.title)}" />`
                      : `<button class="primary-btn carousel-start-btn" data-generate-carousel-slide="${index}" type="button" ${busy || stateFlags.isGeneratingAll ? "disabled" : ""}>${slide.isGenerating ? "生图中" : slide.isQueued ? "排队中" : "开始生图"}</button>`
                  }
                  <div class="carousel-slide-status">
                    ${escapeHtml(getXhsCarouselSlideStatus(slide, hasImage))}
                  </div>
                </div>
                <div class="image-meta-card carousel-draft-meta">
                  <h3>${escapeHtml(slide.pageLabel)} · ${escapeHtml(slide.title)}</h3>
                  <div class="image-meta-item">
                    <span>视觉方向</span>
                    <div>${escapeHtml(slide.visualDirection)}</div>
                  </div>
                  <div class="image-meta-item">
                    <span>风格</span>
                    <div>${escapeHtml(slide.style)}</div>
                  </div>
                  <div class="image-meta-item">
                    <span>构图建议</span>
                    <div>${escapeHtml(slide.composition)}</div>
                  </div>
                  ${
                    hasImage
                      ? `
                        <div class="carousel-slide-edit">
                          ${
                            slide.editOpen
                              ? `
                                <label>
                                  <span>改图提示词</span>
                                  <textarea class="carousel-edit-input" data-carousel-edit-prompt="${index}" rows="3" placeholder="例如：保留产品和构图，把背景改成更明亮的办公室晨光。">${escapeHtml(slide.editPrompt || "")}</textarea>
                                </label>
                                <div class="carousel-edit-actions">
                                  <button class="primary-btn small-btn" data-carousel-edit-confirm="${index}" type="button" ${busy ? "disabled" : ""}>确认</button>
                                  <button class="secondary-btn small-btn" data-carousel-edit-cancel="${index}" type="button">取消</button>
                                </div>
                              `
                              : `<button class="secondary-btn small-btn carousel-edit-toggle" data-carousel-edit-open="${index}" type="button" ${busy ? "disabled" : ""}>改图</button>`
                          }
                        </div>
                      `
                      : ""
                  }
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
      <div class="carousel-floating-actions">
        <button class="primary-btn carousel-generate-all-btn" data-generate-carousel-all type="button" ${stateFlags.isGeneratingAll || remainingSlideCount === 0 ? "disabled" : ""}>
          ${remainingSlideCount === 0 ? "已全部生成" : stateFlags.isGeneratingAll ? "生图中" : `一键生图 ${generateAllCost} 积分`}
        </button>
      </div>
    </div>
  `;
}

async function generateXhsCarousel(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  if (!brand || !trend) return;
  await generateXhsCarouselForContext({
    brand,
    trend,
    idea: trend.ideas?.[ideaIndex],
    ideaIndex,
    productImages: getSelectedProductImages(ideaIndex),
    useBrandLogo: isBrandLogoEnabled(ideaIndex),
    visualStylePreset: getIdeaCreativeStyleSelection(ideaIndex),
    aspectRatio: getResolvedIdeaAspectRatio(ideaIndex, "xhsCarousel"),
  });
}

async function generateXhsCarouselForContext({
  brand,
  trend,
  idea,
  ideaIndex,
  productImages,
  useBrandLogo,
  carouselPack: customCarouselPack = null,
  sourceCase = null,
  visualStylePreset = "auto",
  aspectRatio = "3:4",
} = {}) {
  if (!brand || !trend) return;
  const resolvedIdeaIndex = Number(ideaIndex);
  const resolvedIdea = idea || trend.ideas?.[resolvedIdeaIndex];
  if (!resolvedIdea) return;

  const imageResult = openAssetModal({
    kicker: sourceCase ? "一键仿图文" : "AI 小红书组图",
    title: sourceCase ? "优秀内容仿图文方案" : "小红书组图内容包",
    description: sourceCase
      ? "基于参考笔记节奏生成 4 页原创组图，可继续单张或一键生图。"
      : "先检查每张图的视觉方向、风格和构图，再选择单张或一键生成四张图。",
    loadingTitle: sourceCase ? "正在准备仿图文方案..." : "正在准备小红书组图方案...",
    loadingCopy: sourceCase
      ? "正在基于参考案例与当前选题整理 4 页原创页面。"
      : "正在整理 4 张组图页面的视觉方向、风格和构图建议。",
  });

  try {
    const previewBody = { aspectRatio, visualStylePreset };
    if (customCarouselPack && typeof customCarouselPack === "object") {
      previewBody.carouselPack = customCarouselPack;
    }
    const previewResult = await request(
      `/api/brands/${brand.id}/trends/${trend.id}/ideas/${resolvedIdeaIndex}/xhs-carousel/preview`,
      {
        method: "POST",
        body: JSON.stringify(previewBody),
      },
    );
    updateCurrentUser(previewResult.user);
    const previewPack = previewResult.carouselPack;
    if (!previewPack || !Array.isArray(previewPack.slides)) {
      throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
    }
    const pack = {
      ...previewPack,
      aspectRatio,
      carouselGroupId: previewPack.carouselGroupId || createXhsCarouselGroupId(brand.id, trend.id, resolvedIdeaIndex),
      slides: enrichXhsCarouselSlides(previewPack),
    };
    const selectedProductImages = Array.isArray(productImages) ? productImages : getSelectedProductImages(resolvedIdeaIndex);
    const selectedUseBrandLogo = typeof useBrandLogo === "boolean" ? useBrandLogo : isBrandLogoEnabled(resolvedIdeaIndex);
    const flags = {
      isGeneratingAll: false,
      completed: false,
      creditEventId: null,
    };
    const taskQueue = [];
    let activeTaskCount = 0;
    let activeGenerateTaskCount = 0;
    let imageJobSubmissionChain = Promise.resolve();
    let renderAndBind = () => {};

    const completeIfReady = async () => {
      if (flags.completed || !pack.slides.every(hasXhsCarouselSlideImage)) return;
      const completeResult = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${resolvedIdeaIndex}/xhs-carousel/complete`, {
        method: "POST",
        body: JSON.stringify({ carouselPack: pack, creditEventId: flags.creditEventId }),
      });
      updateCurrentUser(completeResult.user);
      if (completeResult.generation && !state.generationHistory.some((item) => item.id === completeResult.generation.id)) {
        state.generationHistoryFilters = createEmptyGenerationHistoryFilters();
        state.generationHistoryNeedsLatest = false;
        state.generationHistory.unshift(completeResult.generation);
        renderGenerationHistory();
      }
      flags.completed = true;
      showToast(sourceCase ? "仿图文组图已全部生成并写入历史生成。" : "小红书组图已全部生成并写入历史生成。");
    };

    const getNextRunnableTaskIndex = () => {
      if (activeTaskCount >= IMAGE_TASK_MAX_CONCURRENCY || !taskQueue.length) return -1;
      const nextGenerateIndex = taskQueue.findIndex((task) => task.type === "generate");
      if (nextGenerateIndex >= 0) return nextGenerateIndex;
      if (activeGenerateTaskCount > 0) return -1;
      return 0;
    };

    const runImageJobSubmission = (submit) => {
      const pending = imageJobSubmissionChain.catch(() => {});
      imageJobSubmissionChain = pending.then(submit);
      return imageJobSubmissionChain;
    };

    const pumpImageTaskQueue = () => {
      let taskIndex = getNextRunnableTaskIndex();
      while (taskIndex >= 0) {
        const [task] = taskQueue.splice(taskIndex, 1);
        activeTaskCount += 1;
        if (task.type === "generate") activeGenerateTaskCount += 1;
        task.run()
          .catch((error) => {
            console.warn(error.message);
          })
          .finally(async () => {
            activeTaskCount -= 1;
            if (task.type === "generate") activeGenerateTaskCount -= 1;
            if (!taskQueue.length && activeTaskCount === 0) {
              flags.isGeneratingAll = false;
              await completeIfReady().catch((error) => showToast(`小红书组图写入历史失败：${error.message}`));
            }
            renderAndBind();
            pumpImageTaskQueue();
          });
        taskIndex = getNextRunnableTaskIndex();
      }
    };

    const enqueueImageTask = (type, run) => {
      taskQueue.push({ type, run });
      pumpImageTaskQueue();
      renderAndBind();
    };

    const enqueueGenerateSlide = (slideIndex) => {
      const slide = pack.slides[slideIndex];
      if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating || slide.isQueued) return;
      syncXhsCarouselPromptInputs(imageResult, pack);
      slide.isQueued = true;
      slide.error = "";
      enqueueImageTask("generate", () => runGenerateSlide(slideIndex));
    };

    const runGenerateSlide = async (slideIndex) => {
      const slide = pack.slides[slideIndex];
      if (!slide || hasXhsCarouselSlideImage(slide)) return;
      slide.isQueued = false;
      slide.isGenerating = true;
      renderAndBind();
      try {
        const result = await runImageJobSubmission(() =>
          request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${resolvedIdeaIndex}/xhs-carousel/slides/${slideIndex}`, {
            method: "POST",
            body: JSON.stringify({
              carouselPack: pack,
              slide,
              productImages: selectedProductImages,
              useBrandLogo: selectedUseBrandLogo,
              visualStylePreset,
              aspectRatio,
            }),
          }),
        );
        updateCurrentUser(result.user);
        flags.creditEventId = result.creditEventId || flags.creditEventId;
        if (!result.slideJob?.jobId) throw new Error("小红书组图任务创建失败");
        const imageConcept = await pollImageJob(result.slideJob.jobId);
        pack.slides[slideIndex] = {
          ...pack.slides[slideIndex],
          previewUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          imageUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          isGenerating: false,
          isQueued: false,
          error: "",
        };
      } catch (error) {
        if (isStaleSessionRequest(error)) return;
        slide.isGenerating = false;
        slide.isQueued = false;
        slide.error = `生成失败：${error.message}`;
      }
    };

    const enqueueEditSlide = (slideIndex) => {
      const slide = pack.slides[slideIndex];
      if (!slide || !hasXhsCarouselSlideImage(slide) || slide.isEditing || slide.editQueued) return;
      const prompt = String(slide.editPrompt || "").trim();
      if (!prompt) {
        slide.error = "请先填写改图提示词。";
        renderAndBind();
        return;
      }
      slide.editQueued = true;
      slide.editOpen = false;
      slide.error = "";
      enqueueImageTask("edit", () => runEditSlide(slideIndex, prompt));
    };

    const runEditSlide = async (slideIndex, prompt) => {
      const slide = pack.slides[slideIndex];
      if (!slide || !hasXhsCarouselSlideImage(slide)) return;
      slide.editQueued = false;
      slide.isEditing = true;
      renderAndBind();
      try {
        const result = await runImageJobSubmission(() =>
          request("/api/image-edits", {
            method: "POST",
            body: JSON.stringify({
              imageUrl: slide.imageUrl || slide.previewUrl,
              prompt,
              title: slide.title || pack.title,
              aspectRatio: pack.aspectRatio || aspectRatio,
            }),
          }),
        );
        updateCurrentUser(result.user);
        if (!result.jobId) throw new Error("改图任务创建失败");
        const imageConcept = await pollImageJob(result.jobId);
        pack.slides[slideIndex] = {
          ...pack.slides[slideIndex],
          previewUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          imageUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          isEditing: false,
          editQueued: false,
          editPrompt: "",
          error: "",
        };
      } catch (error) {
        if (isStaleSessionRequest(error)) return;
        slide.isEditing = false;
        slide.editQueued = false;
        slide.editOpen = true;
        slide.error = `改图失败：${error.message}`;
      }
    };

    const bindDraftActions = () => {
      imageResult.querySelectorAll("[data-carousel-prompt]").forEach((textarea) => {
        textarea.addEventListener("input", () => {
          const slideIndex = Number(textarea.dataset.carouselPrompt);
          if (pack.slides[slideIndex]) pack.slides[slideIndex].prompt = textarea.value;
        });
      });
      imageResult.querySelectorAll("[data-carousel-edit-prompt]").forEach((textarea) => {
        textarea.addEventListener("input", () => {
          const slideIndex = Number(textarea.dataset.carouselEditPrompt);
          if (pack.slides[slideIndex]) pack.slides[slideIndex].editPrompt = textarea.value;
        });
      });
      imageResult.querySelectorAll("[data-generate-carousel-slide]").forEach((button) => {
        button.addEventListener("click", () => enqueueGenerateSlide(Number(button.dataset.generateCarouselSlide)));
      });
      imageResult.querySelectorAll("[data-carousel-edit-open]").forEach((button) => {
        button.addEventListener("click", () => {
          const slide = pack.slides[Number(button.dataset.carouselEditOpen)];
          if (!slide) return;
          syncXhsCarouselPromptInputs(imageResult, pack);
          slide.editOpen = true;
          slide.error = "";
          renderAndBind();
        });
      });
      imageResult.querySelectorAll("[data-carousel-edit-cancel]").forEach((button) => {
        button.addEventListener("click", () => {
          const slide = pack.slides[Number(button.dataset.carouselEditCancel)];
          if (!slide) return;
          slide.editOpen = false;
          slide.editPrompt = "";
          slide.error = "";
          renderAndBind();
        });
      });
      imageResult.querySelectorAll("[data-carousel-edit-confirm]").forEach((button) => {
        button.addEventListener("click", () => enqueueEditSlide(Number(button.dataset.carouselEditConfirm)));
      });
      const allButton = imageResult.querySelector("[data-generate-carousel-all]");
      allButton?.addEventListener("click", () => {
        syncXhsCarouselPromptInputs(imageResult, pack);
        const remainingSlideCount = pack.slides.filter((slide) => !hasXhsCarouselSlideImage(slide) && !slide.isGenerating && !slide.isQueued).length;
        if (remainingSlideCount === 0) return;
        if (Number(state.currentUser?.credits || 0) < remainingSlideCount) {
          showRechargeToast(`积分不足，一键生成剩余 ${remainingSlideCount} 张需要 ${remainingSlideCount} 积分，当前剩余 ${Number(state.currentUser?.credits || 0)} 积分。`);
          return;
        }
        flags.isGeneratingAll = true;
        for (let index = 0; index < pack.slides.length; index += 1) {
          enqueueGenerateSlide(index);
        }
        renderAndBind();
      });
    };

    renderAndBind = () => {
      renderXhsCarouselDraft(imageResult, pack, flags);
      bindDraftActions();
    };

    renderAndBind();
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    imageResult.innerHTML = `<div class="image-meta-card"><h3>生成失败</h3><div class="idea-copy">${escapeHtml(error.message)}</div></div>`;
  }
}

let excellentRemixState = null;
let excellentDetailScrollLock = false;

function formatCompactMetric(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1)}万`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

function createExcellentBoardSlice(board) {
  if (board === "ecommerce_hot") {
    return {
      items: [],
      industryPath: "",
      contentSource: "all",
      draftIndustryPath: "",
      draftContentSource: "all",
      status: "idle",
      error: "",
      updatedAt: "",
      stale: false,
      hasCache: false,
      needsUpdate: false,
      refreshing: false,
      refreshError: "",
      requestId: 0,
      scrollTop: 0,
    };
  }
  return {
    items: [],
    categoryPath: "",
    contentSource: "all",
    draftCategoryPath: "",
    draftContentSource: "all",
    status: "idle",
    error: "",
    updatedAt: "",
    stale: false,
    hasCache: false,
    needsUpdate: false,
    refreshing: false,
    refreshError: "",
    requestId: 0,
    scrollTop: 0,
  };
}

function getExcellentBoardState(board = state.excellentContentBoard) {
  const key = board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  if (!state.excellentContentBoards[key]) {
    state.excellentContentBoards[key] = createExcellentBoardSlice(key);
  }
  return state.excellentContentBoards[key];
}

function syncExcellentActiveBoardMirrors() {
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  state.excellentContents = slice.items || [];
  state.excellentContentStatus = slice.status || "idle";
  state.excellentContentError = slice.error || "";
  state.excellentContentUpdatedAt = slice.updatedAt || "";
  state.excellentContentStale = Boolean(slice.stale);
  state.excellentContentRequestId = slice.requestId || 0;
  state.excellentContentFilters = {
    categoryPath: slice.categoryPath || "",
    industryPath: slice.industryPath || "",
    source: board,
    contentSource: slice.contentSource || "all",
  };
}

function findExcellentContentById(noteId, board = state.excellentContentBoard) {
  const target = String(noteId || "");
  const slice = getExcellentBoardState(board);
  const fromBoard = (slice.items || []).find((item) => String(item.noteId || item.id) === target);
  if (fromBoard) return fromBoard;
  // Fallback search both boards (detail may open after switch).
  for (const key of ["xhs_hot", "ecommerce_hot"]) {
    const hit = (getExcellentBoardState(key).items || []).find((item) => String(item.noteId || item.id) === target);
    if (hit) return hit;
  }
  return null;
}

function setExcellentModalOpen(isOpen) {
  document.body.classList.toggle("excellent-modal-open", Boolean(isOpen));
  if (!isOpen) excellentDetailScrollLock = false;
}

function getExcellentBoardScrollKey(board = state.excellentContentBoard) {
  const key = board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  return `excellent:${key}`;
}

function saveExcellentBoardScrollPosition(board = state.excellentContentBoard) {
  if (state.currentPage !== "dashboard" || state.currentTab !== "excellent") return;
  const snapshot = getDashboardScrollSnapshot();
  dashboardScrollPositions.set(getExcellentBoardScrollKey(board), snapshot);
  const slice = getExcellentBoardState(board);
  slice.scrollTop = Number(snapshot.contentTop || snapshot.windowY || 0);
}

function restoreExcellentBoardScrollPosition(board = state.excellentContentBoard) {
  if (state.currentPage !== "dashboard" || state.currentTab !== "excellent") return;
  const snapshot = dashboardScrollPositions.get(getExcellentBoardScrollKey(board)) || {
    windowY: 0,
    contentTop: 0,
  };
  applyDashboardScrollSnapshot(snapshot);
  window.requestAnimationFrame(() => applyDashboardScrollSnapshot(snapshot));
}

function formatExcellentUpdatedLabel(updatedAt) {
  if (!updatedAt) return "";
  try {
    return new Date(updatedAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_error) {
    return "";
  }
}

function renderIndustryOptions(items, depth = 0) {
  return (items || [])
    .map((item) => {
      const indent = depth ? `${"—".repeat(depth)} ` : "";
      const children = Array.isArray(item.children) ? renderIndustryOptions(item.children, depth + 1) : "";
      return `<option value="${escapeHtml(item.value || "")}">${escapeHtml(indent + (item.label || item.value || ""))}</option>${children}`;
    })
    .join("");
}

function renderExcellentTaxonomyOptions() {
  const select = document.getElementById("excellentCategoryFilter");
  const title = document.getElementById("excellentTaxonomyFilterTitle");
  if (!select) return;
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  const busy = Boolean(slice.refreshing);
  if (board === "ecommerce_hot") {
    if (title) title.textContent = "所属行业";
    const selected = slice.draftIndustryPath || "";
    const industryOptions = renderIndustryOptions(state.excellentIndustryTaxonomy);
    const emptyHint =
      state.excellentIndustryStatus === "loading"
        ? "加载中…"
        : state.excellentIndustryStatus === "error"
          ? "所属行业暂时不可用"
          : "全部所属行业";
    select.innerHTML = `<option value="">${escapeHtml(emptyHint)}</option>${industryOptions}`;
    select.disabled = busy || state.excellentIndustryStatus === "loading";
    select.value = selected;
    if (selected && select.value !== selected) {
      // Only clear invalid draft; formal industryPath stays with current cached items.
      slice.draftIndustryPath = "";
      select.value = "";
    }
  } else {
    if (title) title.textContent = "内容类目";
    const selected = slice.draftCategoryPath || "";
    const categoryOptions = renderXhsCategoryOptions(state.xhsCategories);
    const emptyHint =
      state.xhsCategoryStatus === "loading"
        ? "加载中…"
        : state.xhsCategoryStatus === "error"
          ? "内容类目暂时不可用"
          : "全部内容类目";
    select.innerHTML = `<option value="">${escapeHtml(emptyHint)}</option>${categoryOptions}`;
    select.disabled = busy || state.xhsCategoryStatus === "loading";
    select.value = selected;
    if (selected && select.value !== selected) {
      // Only clear invalid draft; formal categoryPath stays with current cached items.
      slice.draftCategoryPath = "";
      select.value = "";
    }
  }
}

function renderExcellentSourceOptions() {
  const select = document.getElementById("excellentSourceFilter");
  if (!select) return;
  const slice = getExcellentBoardState();
  const sources = state.excellentContentSources || [{ value: "all", label: "全部" }];
  select.innerHTML = sources
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");
  select.value = slice.draftContentSource || "all";
  select.disabled = Boolean(slice.refreshing);
}

function renderExcellentBoardTabs() {
  document.querySelectorAll("[data-excellent-board]").forEach((btn) => {
    const board = btn.getAttribute("data-excellent-board");
    const active = board === state.excellentContentBoard;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function renderExcellentRefreshButton() {
  const btn = document.getElementById("refreshExcellentContentsBtn");
  if (!btn) return;
  const slice = getExcellentBoardState();
  const refreshing = Boolean(slice.refreshing);
  btn.disabled = refreshing;
  btn.textContent = refreshing ? "正在更新…" : "更新内容";
  btn.classList.toggle("is-loading", refreshing);
}

function renderExcellentContentMeta() {
  const meta = document.getElementById("excellentContentMeta");
  if (!meta) return;
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  const parts = [`<span>近7日 · 图文 · 按阅读量排序</span>`];
  if (slice.updatedAt) {
    const label = formatExcellentUpdatedLabel(slice.updatedAt);
    if (label) parts.push(`<span>更新 ${escapeHtml(label)}</span>`);
  }
  if (slice.stale && (slice.items || []).length && !excellentFiltersAreDirty(slice, board)) {
    parts.push(`<span class="is-stale">当前展示上一次保存的数据，可点击更新内容</span>`);
  }
  meta.innerHTML = parts.join("");
}

function renderExcellentStatus() {
  const statusEl = document.getElementById("excellentContentStatus");
  if (!statusEl) return;
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  if (slice.refreshing) {
    statusEl.hidden = false;
    statusEl.className = "excellent-status";
    statusEl.textContent = "正在更新内容…";
    return;
  }
  if (slice.refreshError) {
    statusEl.hidden = false;
    statusEl.className = "excellent-status is-error";
    statusEl.textContent = slice.refreshError;
    return;
  }
  if (excellentFiltersAreDirty(slice, board)) {
    statusEl.hidden = false;
    statusEl.className = "excellent-status is-pending";
    statusEl.textContent = "筛选条件将在点击“更新内容”后生效，当前仍展示上一次保存的数据。";
    return;
  }
  if (slice.stale && (slice.items || []).length) {
    statusEl.hidden = false;
    statusEl.className = "excellent-status";
    statusEl.textContent = "当前展示上一次保存的数据，可点击更新内容。";
    return;
  }
  if (slice.status === "error" && !(slice.items || []).length) {
    statusEl.hidden = false;
    statusEl.className = "excellent-status is-error";
    statusEl.textContent = slice.error || "优秀内容加载失败";
    return;
  }
  statusEl.hidden = true;
  statusEl.textContent = "";
}

/** Update draft-filter chrome only — never loads list content. */
function renderExcellentFilterChrome() {
  renderExcellentTaxonomyOptions();
  renderExcellentSourceOptions();
  renderExcellentRefreshButton();
  renderExcellentContentMeta();
  renderExcellentStatus();
}

function renderExcellentContents() {
  const root = document.getElementById("excellentContentGrid");
  if (!root) return;
  syncExcellentActiveBoardMirrors();
  renderExcellentBoardTabs();
  renderExcellentTaxonomyOptions();
  renderExcellentSourceOptions();
  renderExcellentRefreshButton();
  renderExcellentContentMeta();
  renderExcellentStatus();

  const slice = getExcellentBoardState();
  if (slice.status === "loading" && !(slice.items || []).length) {
    root.innerHTML = `<div class="excellent-skeleton-grid">${Array.from({ length: 8 }).map(() => `<div class="excellent-skeleton-card"></div>`).join("")}</div>`;
    return;
  }

  const items = slice.items || [];
  if (!items.length) {
    const isError = slice.status === "error";
    const title = isError ? "暂时无法加载优秀内容" : "该筛选条件暂无已保存内容";
    const message = isError
      ? slice.error || "优秀内容加载失败"
      : "该筛选条件暂无已保存内容，请点击“更新内容”获取最新数据。";
    root.innerHTML = `<div class="excellent-empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p><button class="primary-btn" id="refreshExcellentContentsEmpty" type="button"${slice.refreshing ? " disabled" : ""}>${slice.refreshing ? "正在更新…" : "更新内容"}</button></div>`;
    document.getElementById("refreshExcellentContentsEmpty")?.addEventListener("click", () => {
      refreshExcellentContentsForBoard(state.excellentContentBoard).catch(() => {});
    });
    return;
  }

  root.innerHTML = items
    .map((item) => {
      const noteId = String(item.noteId || item.id || "");
      const cover = safeImageSrc(item.primaryCoverUrl || item.imageUrls?.[0] || item.coverUrls?.[0] || "");
      const imageCount = Array.isArray(item.imageUrls)
        ? item.imageUrls.filter(Boolean).length
        : Number(item.imageCount || 0);
      const readCount = Number(item.metrics?.readCount || 0);
      return `
        <article class="excellent-note-card" data-note-id="${escapeHtml(noteId)}">
          <button class="excellent-note-cover" data-excellent-detail="${escapeHtml(noteId)}" type="button">
            ${
              cover
                ? `<img src="${cover}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'excellent-cover-fallback',textContent:'封面加载失败'}))" />`
                : `<div class="excellent-cover-fallback">暂无封面</div>`
            }
            <span class="excellent-note-rank">TOP ${escapeHtml(String(item.rank || ""))}</span>
            ${imageCount > 1 ? `<span class="excellent-note-count">${imageCount}图</span>` : ""}
          </button>
          <div class="excellent-note-body">
            <button class="excellent-note-title" data-excellent-detail="${escapeHtml(noteId)}" type="button">${escapeHtml(item.title || "未命名笔记")}</button>
            <div class="excellent-note-author">${escapeHtml(item.author?.nickname || "未知作者")}</div>
            <div class="excellent-note-metrics">
              <span>阅读 <strong>${formatCompactMetric(readCount)}</strong></span>
              <span>赞 ${formatCompactMetric(item.metrics?.likeCount)}</span>
              <span>藏 ${formatCompactMetric(item.metrics?.favoriteCount)}</span>
              <span>评 ${formatCompactMetric(item.metrics?.commentCount)}</span>
            </div>
            <div class="excellent-note-actions">
              <a href="${escapeHtml(item.noteUrl || "#")}" target="_blank" rel="noopener noreferrer" data-excellent-external>查看原笔记</a>
              <button data-excellent-remix="${escapeHtml(noteId)}" type="button">一键仿图文</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadExcellentIndustryTaxonomy() {
  if (!state.sessionToken) return;
  if (state.excellentIndustryStatus === "ready" || state.excellentIndustryStatus === "loading") return;
  state.excellentIndustryStatus = "loading";
  try {
    const result = await request("/api/excellent-contents/taxonomy?board=ecommerce_hot");
    state.excellentIndustryTaxonomy = Array.isArray(result?.tree?.items) ? result.tree.items : [];
    state.excellentIndustryStatus = "ready";
    state.excellentIndustryError = "";
    if (state.excellentContentBoard === "ecommerce_hot") renderExcellentTaxonomyOptions();
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    state.excellentIndustryStatus = "error";
    state.excellentIndustryError = error.message || "所属行业加载失败";
  }
}

/**
 * Cache-only list load for a board slice. Never passes waitForFresh/forceRefresh.
 * Results always write back to the request slice (even if UI switched away).
 */
async function loadExcellentContentsForBoard(board, { preserveItems = true, restoreScroll = true } = {}) {
  if (!state.sessionToken) return null;
  const requestBoard = board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const requestSlice = getExcellentBoardState(requestBoard);
  const requestId = ++requestSlice.requestId;
  const loadEpoch = sessionEpoch;
  const contentSource = requestSlice.contentSource || "all";
  const taxonomyPath =
    requestBoard === "ecommerce_hot" ? requestSlice.industryPath || "" : requestSlice.categoryPath || "";
  const hadItems = (requestSlice.items || []).length > 0;
  requestSlice.status = "loading";
  requestSlice.refreshError = "";
  if (!(preserveItems && hadItems)) requestSlice.error = "";

  const isActiveAtStart = state.excellentContentBoard === requestBoard;
  if (isActiveAtStart) {
    syncExcellentActiveBoardMirrors();
    if (!hadItems || !preserveItems) renderExcellentContents();
    else {
      renderExcellentStatus();
      renderExcellentRefreshButton();
    }
  }

  try {
    const query = new URLSearchParams({ board: requestBoard, contentSource });
    if (requestBoard === "ecommerce_hot") {
      if (taxonomyPath) query.set("industryPath", taxonomyPath);
    } else if (taxonomyPath) {
      query.set("categoryPath", taxonomyPath);
    }
    const result = await request(`/api/excellent-contents?${query.toString()}`);
    assertSessionEpoch(loadEpoch);
    const applied = applyExcellentListResult({
      slice: requestSlice,
      requestId,
      sessionEpoch,
      loadEpoch,
      result,
      activeBoard: state.excellentContentBoard,
      requestBoard,
    });
    if (!applied.applied) return null;
    if (Array.isArray(result?.filters?.contentSources) && result.filters.contentSources.length) {
      state.excellentContentSources = result.filters.contentSources;
    }
    if (applied.isActive) {
      syncExcellentActiveBoardMirrors();
      renderExcellentContents();
      if (restoreScroll) restoreExcellentBoardScrollPosition(requestBoard);
    }
    return result;
  } catch (error) {
    if (isStaleSessionRequest(error)) return null;
    const applied = applyExcellentListError({
      slice: requestSlice,
      requestId,
      sessionEpoch,
      loadEpoch,
      error,
      preserveItems,
      hadItems,
      activeBoard: state.excellentContentBoard,
      requestBoard,
    });
    if (!applied.applied) return null;
    if (applied.isActive) {
      syncExcellentActiveBoardMirrors();
      renderExcellentContents();
    }
    if (!(preserveItems && hadItems)) throw error;
    return null;
  }
}

/**
 * Explicit refresh via POST /api/excellent-contents/refresh using draft filters.
 * Keeps old items + formal filters until success; rolls draft back on failure.
 */
async function refreshExcellentContentsForBoard(board) {
  if (!state.sessionToken) return null;
  const requestBoard = board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const requestSlice = getExcellentBoardState(requestBoard);
  if (requestSlice.refreshing) return null;

  const requestId = ++requestSlice.requestId;
  const loadEpoch = sessionEpoch;
  // Immutable snapshot of draft filters for this request only.
  const requestFilters = {
    board: requestBoard,
    contentSource: requestSlice.draftContentSource || "all",
    categoryPath: requestBoard === "xhs_hot" ? requestSlice.draftCategoryPath || "" : "",
    industryPath: requestBoard === "ecommerce_hot" ? requestSlice.draftIndustryPath || "" : "",
  };
  const filtersChanged = excellentFiltersAreDirty(requestSlice, requestBoard);
  const previousItems = Array.isArray(requestSlice.items) ? [...requestSlice.items] : [];
  const previousUpdatedAt = requestSlice.updatedAt || "";
  const previousFormal = {
    contentSource: requestSlice.contentSource || "all",
    categoryPath: requestSlice.categoryPath || "",
    industryPath: requestSlice.industryPath || "",
  };
  requestSlice.refreshing = true;
  requestSlice.refreshError = "";

  const isActiveAtStart = state.excellentContentBoard === requestBoard;
  if (isActiveAtStart) {
    syncExcellentActiveBoardMirrors();
    renderExcellentFilterChrome();
    if (!previousItems.length) renderExcellentContents();
  }

  try {
    const result = await request("/api/excellent-contents/refresh", {
      method: "POST",
      body: JSON.stringify(requestFilters),
    });
    assertSessionEpoch(loadEpoch);
    if (!excellentRefreshResponseMatches(result, requestFilters)) {
      // Stale / mismatched payload — do not replace current board content.
      if (requestSlice.requestId === requestId) {
        requestSlice.refreshing = false;
      }
      return null;
    }
    const applied = applyExcellentRefreshResult({
      slice: requestSlice,
      requestId,
      sessionEpoch,
      loadEpoch,
      result,
      activeBoard: state.excellentContentBoard,
      requestBoard,
    });
    if (!applied.applied) return null;
    commitExcellentDraftFilters(requestSlice, requestBoard, requestFilters);
    if (Array.isArray(result?.filters?.contentSources) && result.filters.contentSources.length) {
      state.excellentContentSources = result.filters.contentSources;
    }
    if (applied.isActive) {
      syncExcellentActiveBoardMirrors();
      renderExcellentContents();
      if (filtersChanged) {
        // New formal filters: reset scroll to top of list.
        requestSlice.scrollTop = 0;
        dashboardScrollPositions.set(getExcellentBoardScrollKey(requestBoard), {
          windowY: 0,
          contentTop: 0,
        });
        restoreExcellentBoardScrollPosition(requestBoard);
      }
      // Same formal filters: keep current scroll position (do not restore).
      const label = formatExcellentUpdatedLabel(result?.updatedAt || requestSlice.updatedAt);
      if (label) showToast(`已更新至 ${label}`);
    }
    return result;
  } catch (error) {
    if (isStaleSessionRequest(error)) {
      // Avoid permanent "正在更新…" if session changed mid-request.
      if (requestSlice.requestId === requestId) requestSlice.refreshing = false;
      return null;
    }
    // Always keep previous items + formal filters on failure.
    if (!(requestSlice.items || []).length && previousItems.length) {
      requestSlice.items = previousItems;
    }
    requestSlice.updatedAt = previousUpdatedAt;
    requestSlice.contentSource = previousFormal.contentSource;
    if (requestBoard === "ecommerce_hot") {
      requestSlice.industryPath = previousFormal.industryPath;
    } else {
      requestSlice.categoryPath = previousFormal.categoryPath;
    }
    const applied = applyExcellentRefreshError({
      slice: requestSlice,
      requestId,
      sessionEpoch,
      loadEpoch,
      error,
      activeBoard: state.excellentContentBoard,
      requestBoard,
    });
    if (!applied.applied) {
      if (requestSlice.requestId === requestId) requestSlice.refreshing = false;
      return null;
    }
    rollbackExcellentDraftFilters(requestSlice, requestBoard);
    if (applied.isActive) {
      syncExcellentActiveBoardMirrors();
      renderExcellentContents();
      if ((requestSlice.items || []).length) {
        showToast("更新失败，当前仍展示上一次保存的数据。");
      } else {
        showToast(error?.message || "更新失败，请稍后重试。");
      }
    }
    return null;
  }
}

async function loadExcellentContents({ preserveItems = true, restoreScroll = true } = {}) {
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  return loadExcellentContentsForBoard(board, { preserveItems, restoreScroll });
}

async function prefetchExcellentContents() {
  if (!state.sessionToken) return;
  const slice = getExcellentBoardState();
  if (slice.status === "ready" || slice.status === "loading" || slice.status === "empty") return;
  try {
    await loadExcellentContents();
  } catch (_error) {
    // Prefetch failures must not impact workspace entry.
  }
}

function switchExcellentBoard(nextBoard) {
  const board = nextBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  if (board === state.excellentContentBoard) return;
  saveExcellentBoardScrollPosition(state.excellentContentBoard);
  state.excellentContentBoard = board;
  const slice = getExcellentBoardState(board);
  syncExcellentActiveBoardMirrors();
  renderExcellentContents();
  restoreExcellentBoardScrollPosition(board);
  if (board === "ecommerce_hot") loadExcellentIndustryTaxonomy().catch(() => {});
  else if (state.xhsCategoryStatus === "idle") loadXhsCategories().catch(() => {});
  // Board switch only reads that board's cache; never auto-calls Pgy.
  if (slice.status === "idle" || (!(slice.items || []).length && slice.status !== "loading" && slice.status !== "empty")) {
    loadExcellentContents({ preserveItems: false }).catch(() => {});
  }
}

function getDetailImages(item) {
  if (!item) return [];
  if (Array.isArray(item.imageUrls) && item.imageUrls.length) return item.imageUrls;
  return [item.primaryCoverUrl, ...(item.coverUrls || [])].filter(Boolean);
}

function renderExcellentDetailCarousel() {
  const detail = document.getElementById("excellentContentDetail");
  const modal = document.getElementById("excellentContentModal");
  if (!detail || !modal || !state.excellentDetail?.item) return;
  const item = state.excellentDetail.item;
  const images = getDetailImages(item).map((src) => safeImageSrc(src)).filter(Boolean);
  const index = clampImageIndex(state.excellentDetail.activeImageIndex, images.length);
  state.excellentDetail.activeImageIndex = index;
  const current = images[index] || "";
  const detailBoard = state.excellentDetail.board === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const taxonomyLabel =
    item.industryPath ||
    item.categoryPath ||
    (detailBoard === "ecommerce_hot" ? "全部所属行业" : "全部内容类目");
  const contentSourceLabel =
    (state.excellentContentSources || []).find((entry) => entry.value === (item.contentSource || "all"))?.label ||
    item.contentSource ||
    "全部";
  detail.innerHTML = `
    <div class="excellent-detail-layout excellent-detail-carousel-layout">
      <section class="excellent-detail-gallery excellent-detail-carousel">
        <div class="excellent-carousel-stage">
          <button type="button" class="excellent-carousel-nav is-prev" data-excellent-img-prev ${canGoPrevious(index, images.length) ? "" : "disabled"} aria-label="上一张">‹</button>
          <div class="excellent-carousel-main">
            ${
              current
                ? `<img src="${current}" alt="${escapeHtml(item.title || "笔记")} 第 ${index + 1} 张" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'excellent-cover-fallback',textContent:'图片加载失败'}))" />`
                : `<div class="excellent-cover-fallback">暂无图片</div>`
            }
          </div>
          <button type="button" class="excellent-carousel-nav is-next" data-excellent-img-next ${canGoNext(index, images.length) ? "" : "disabled"} aria-label="下一张">›</button>
        </div>
        <div class="excellent-detail-gallery-meta">${images.length ? `${index + 1} / ${images.length}` : "暂无图片"}</div>
        ${
          images.length > 1
            ? `<div class="excellent-carousel-thumbs">${images
                .map(
                  (src, i) =>
                    `<button type="button" class="excellent-carousel-thumb ${i === index ? "is-active" : ""}" data-excellent-img-index="${i}"><img src="${src}" alt="" referrerpolicy="no-referrer" /></button>`,
                )
                .join("")}</div>`
            : ""
        }
        ${state.excellentDetail.loading ? `<div class="excellent-detail-loading">正在加载详情…</div>` : ""}
        ${state.excellentDetail.error ? `<div class="excellent-detail-error">${escapeHtml(state.excellentDetail.error)}</div>` : ""}
      </section>
      <aside class="excellent-detail-copy">
        <h2 id="excellentContentModalTitle">${escapeHtml(item.title || "未命名笔记")}</h2>
        <div class="excellent-detail-meta">
          <div>作者：${escapeHtml(item.author?.nickname || "未知作者")}</div>
          <div>发布时间：${escapeHtml(item.publishTime || "-")}</div>
          <div>${detailBoard === "ecommerce_hot" ? "所属行业" : "内容类目"}：${escapeHtml(taxonomyLabel)}</div>
          <div>内容来源：${escapeHtml(contentSourceLabel)}</div>
        </div>
        <div class="excellent-detail-metrics">
          <div><strong>${formatCompactMetric(item.metrics?.readCount)}</strong><span>阅读</span></div>
          <div><strong>${formatCompactMetric(item.metrics?.likeCount)}</strong><span>点赞</span></div>
          <div><strong>${formatCompactMetric(item.metrics?.favoriteCount)}</strong><span>收藏</span></div>
          <div><strong>${formatCompactMetric(item.metrics?.commentCount)}</strong><span>评论</span></div>
        </div>
        ${
          String(item.content || "").trim()
            ? `<div class="excellent-detail-body">${escapeHtml(item.content)}</div>`
            : ""
        }
        <div class="excellent-detail-actions">
          <a href="${escapeHtml(item.noteUrl || "#")}" target="_blank" rel="noopener noreferrer">查看原笔记</a>
          <button class="primary-btn excellent-detail-remix" data-excellent-remix="${escapeHtml(String(item.noteId || item.id))}" type="button">一键仿图文</button>
        </div>
      </aside>
    </div>
  `;
  detail.querySelector("[data-excellent-remix]")?.addEventListener("click", (event) => {
    event.preventDefault();
    openExcellentRemix(event.currentTarget.dataset.excellentRemix);
  });
  detail.querySelector("[data-excellent-img-prev]")?.addEventListener("click", () => {
    state.excellentDetail.activeImageIndex = getPreviousImageIndex(state.excellentDetail.activeImageIndex, images.length);
    renderExcellentDetailCarousel();
  });
  detail.querySelector("[data-excellent-img-next]")?.addEventListener("click", () => {
    state.excellentDetail.activeImageIndex = getNextImageIndex(state.excellentDetail.activeImageIndex, images.length);
    renderExcellentDetailCarousel();
  });
  detail.querySelectorAll("[data-excellent-img-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.excellentDetail.activeImageIndex = clampImageIndex(Number(btn.getAttribute("data-excellent-img-index")), images.length);
      renderExcellentDetailCarousel();
    });
  });
}

async function openExcellentContentDetail(noteId) {
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  const item = findExcellentContentById(noteId, board);
  if (!item) return;
  const modal = document.getElementById("excellentContentModal");
  if (!modal) return;
  const requestId = (state.excellentDetail.requestId || 0) + 1;
  const contentSource = slice.contentSource || item.contentSource || "all";
  const categoryPath = board === "xhs_hot" ? slice.categoryPath || item.categoryPath || "" : "";
  const industryPath = board === "ecommerce_hot" ? slice.industryPath || item.industryPath || "" : "";
  state.excellentDetail = {
    noteId: String(item.noteId || item.id || ""),
    board,
    loading: true,
    error: "",
    item: { ...item },
    activeImageIndex: 0,
    requestId,
    complete: null,
  };
  renderExcellentDetailCarousel();
  modal.classList.add("is-open");
  excellentDetailScrollLock = true;
  setExcellentModalOpen(true);

  try {
    const query = new URLSearchParams({ board, contentSource });
    if (board === "ecommerce_hot") {
      if (industryPath) query.set("industryPath", industryPath);
    } else if (categoryPath) {
      query.set("categoryPath", categoryPath);
    }
    const result = await request(
      `/api/excellent-contents/${encodeURIComponent(state.excellentDetail.noteId)}/detail?${query.toString()}`,
    );
    if (requestId !== state.excellentDetail.requestId) return;
    if (result?.item) {
      const listUrls = Array.isArray(state.excellentDetail.item.imageUrls)
        ? state.excellentDetail.item.imageUrls.filter(Boolean)
        : [];
      const resultUrls = Array.isArray(result.item.imageUrls) ? result.item.imageUrls.filter(Boolean) : [];
      // Keep list images when incomplete; never fabricate extra covers.
      const imageUrls = resultUrls.length ? resultUrls : listUrls;
      const merged = {
        ...state.excellentDetail.item,
        ...result.item,
        metrics: { ...(state.excellentDetail.item.metrics || {}), ...(result.item.metrics || {}) },
        imageUrls,
      };
      state.excellentDetail.item = merged;
      state.excellentDetail.complete = Boolean(result.complete);
      // Empty body is normal for list-sourced notes; do not show placeholder copy.
      state.excellentDetail.error = "";
    }
  } catch (error) {
    if (isStaleSessionRequest(error) || requestId !== state.excellentDetail.requestId) return;
    state.excellentDetail.error = "详情暂时无法加载";
  } finally {
    if (requestId === state.excellentDetail.requestId) {
      state.excellentDetail.loading = false;
      renderExcellentDetailCarousel();
    }
  }
}

function closeExcellentContentDetail() {
  document.getElementById("excellentContentModal")?.classList.remove("is-open");
  state.excellentDetail = {
    noteId: "",
    board: state.excellentContentBoard || "xhs_hot",
    loading: false,
    error: "",
    item: null,
    activeImageIndex: 0,
    requestId: (state.excellentDetail?.requestId || 0) + 1,
  };
  if (!document.getElementById("excellentRemixModal")?.classList.contains("is-open")) {
    setExcellentModalOpen(false);
  }
}

function flattenRemixTrends(brand) {
  return getTrendBucketsForBrand(brand).flatMap((bucket) =>
    (bucket.items || []).map((trend) => ({
      bucketKey: bucket.key,
      bucketTitle: bucket.title || bucket.key,
      trend,
    })),
  );
}

async function openExcellentRemix(noteId) {
  const item = findExcellentContentById(noteId);
  if (!item) return;
  closeExcellentContentDetail();
  const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
  const slice = getExcellentBoardState(board);
  const instanceId = ++excellentRemixInstanceSequence;
  excellentRemixState = createExcellentRemixState({
    noteId: String(item.noteId || item.id),
    board,
    contentSource: slice.contentSource || "all",
    categoryPath: slice.categoryPath || "",
    industryPath: slice.industryPath || "",
    brandId: state.selectedBrandId || state.brands[0]?.id || null,
    instanceId,
    sessionEpoch,
    requestEpoch: sessionEpoch,
  });
  document.getElementById("excellentRemixModal")?.classList.add("is-open");
  setExcellentModalOpen(true);
  renderExcellentRemix();
  // Analysis and brand load in parallel; smart directions only start after user clicks generate.
  const analysisPromise = loadExcellentRemixAnalysis().catch(() => {});
  const brandPromise = excellentRemixState.brandId
    ? loadExcellentRemixBrandContext(excellentRemixState.brandId).catch(() => {})
    : Promise.resolve();
  await Promise.all([analysisPromise, brandPromise]);
}

function closeExcellentRemix() {
  document.getElementById("excellentRemixModal")?.classList.remove("is-open");
  document.getElementById("excellentRemixProductPickerModal")?.classList.remove("is-open");
  // Invalidate any in-flight responses for the previous instance.
  excellentRemixInstanceSequence += 1;
  excellentRemixState = null;
  if (!document.getElementById("excellentContentModal")?.classList.contains("is-open")) {
    setExcellentModalOpen(false);
  }
}

function isExcellentRemixResponseCurrent(token, options = {}) {
  if (!excellentRemixState || !token) return false;
  if (Number(token.sessionEpoch) !== Number(sessionEpoch)) return false;
  return isRemixResponseCurrent(excellentRemixState, token, options);
}

async function loadExcellentRemixAnalysis() {
  if (!excellentRemixState) return;
  const requestId = nextRemixRequestId(excellentRemixState, "analysisRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "analysisRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  excellentRemixState.analysisStatus = "loading";
  excellentRemixState.analysisError = "";
  renderExcellentRemix();
  try {
    const result = await fetchRemixAnalysis(request, noteId, {
      board,
      contentSource: excellentRemixState.contentSource,
      categoryPath: excellentRemixState.categoryPath,
      industryPath: excellentRemixState.industryPath,
    });
    if (!isExcellentRemixResponseCurrent(token, { noteId, board })) return;
    const analysis = result.analysis || result;
    excellentRemixState.analysis = analysis;
    excellentRemixState.analysisId = analysis.analysisId || "";
    excellentRemixState.analysisStatus =
      analysis.analysisMode === "metadata_only" || analysis.degraded ? "degraded" : "ready";
    if (analysis.degraded) excellentRemixState.analysisStatus = "degraded";
    if (excellentRemixState.analysisStatus === "ready" && analysis.analysisMode === "metadata_only") {
      excellentRemixState.analysisStatus = "degraded";
    }
    if (!analysis.analysisMode) excellentRemixState.analysisStatus = "degraded";
    // metadata_only: keep structure/hook defaults; strip reference-visual focus claim.
    if (isPlatformDefaultVisual(analysis)) {
      excellentRemixState.learningFocus = (excellentRemixState.learningFocus || []).filter((item) => item !== "visual");
      if (!excellentRemixState.learningFocus.length) {
        excellentRemixState.learningFocus = defaultLearningFocusForAnalysis(analysis);
      }
    }
    renderExcellentRemix();
  } catch (error) {
    if (isStaleSessionRequest(error) || !isExcellentRemixResponseCurrent(token, { noteId, board })) return;
    excellentRemixState.analysisError = error.message || "分析失败";
    // Keep modal open; fusion can still use server-side degraded analysis.
    excellentRemixState.analysisStatus = "degraded";
    renderExcellentRemix();
  }
}

async function loadExcellentRemixBrandContext(brandId) {
  if (!excellentRemixState) return;
  const requestId = nextRemixRequestId(excellentRemixState, "brandRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "brandRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  excellentRemixState.loadingBrand = true;
  excellentRemixState.productImageIds = [];
  excellentRemixState.useBrandLogo = false;
  excellentRemixState.assetMode = REMIX_ASSET_MODES.NONE;
  excellentRemixState.selectedExistingIdea = null;
  excellentRemixState.smartDirections = [];
  excellentRemixState.selectedSmartDirectionId = "";
  excellentRemixState.directionsStatus = "idle";
  excellentRemixState.directionsError = "";
  excellentRemixState.directionsAutoTriggered = false;
  excellentRemixState.trendRecommendations = [];
  excellentRemixState.selectedTrendId = null;
  excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
  // Invalidate in-flight direction responses for previous brand.
  nextRemixRequestId(excellentRemixState, "directionsRequestId");
  renderExcellentRemix();
  try {
    await ensureBrandDetailLoaded(brandId);
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    const ideasResult = await fetchBrandRemixIdeas(request, brandId);
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    excellentRemixState.existingIdeas = ideasResult.ideas || [];
  } catch (error) {
    if (!isStaleSessionRequest(error) && isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      showToast(`品牌详情加载失败：${error.message}`);
    }
  } finally {
    if (excellentRemixState && isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      excellentRemixState.loadingBrand = false;
      renderExcellentRemix();
    }
  }
}

async function loadExcellentRemixDirections() {
  if (!excellentRemixState || !excellentRemixState.brandId) return;
  // Hard barrier: never race ahead of analysisId / analysis settlement.
  const settled =
    excellentRemixState.analysisStatus === "ready" ||
    excellentRemixState.analysisStatus === "degraded" ||
    excellentRemixState.analysisStatus === "error";
  if (!settled) {
    excellentRemixState.directionsError = "请等待参考分析完成后再生成内容方向。";
    renderExcellentRemix();
    return;
  }
  const requestId = nextRemixRequestId(excellentRemixState, "directionsRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "directionsRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  const brandId = Number(excellentRemixState.brandId);
  excellentRemixState.directionsStatus = "loading";
  excellentRemixState.directionsError = "";
  renderExcellentRemix();
  try {
    const result = await fetchContentDirections(request, noteId, {
      board,
      brandId,
      sourceAnalysisId: excellentRemixState.analysisId || "",
      learningFocus: excellentRemixState.learningFocus,
      contentSource: excellentRemixState.contentSource,
      categoryPath: excellentRemixState.categoryPath,
      industryPath: excellentRemixState.industryPath,
    });
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    excellentRemixState.smartDirections = result.directions || [];
    excellentRemixState.selectedSmartDirectionId = excellentRemixState.smartDirections[0]?.id || "";
    excellentRemixState.directionsStatus = "ready";
    if (result.analysisId) excellentRemixState.analysisId = result.analysisId;
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    renderExcellentRemix();
  } catch (error) {
    if (isStaleSessionRequest(error) || !isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      return;
    }
    excellentRemixState.directionsStatus = "error";
    excellentRemixState.directionsError = error.message || "内容方向生成失败";
    renderExcellentRemix();
  }
}

function renderExcellentRemix() {
  const root = document.getElementById("excellentRemixBody");
  const submitButton = document.getElementById("submitExcellentRemix");
  if (!root) return;
  if (!excellentRemixState) {
    root.innerHTML = "";
    if (submitButton) submitButton.disabled = true;
    return;
  }
  const item = findExcellentContentById(excellentRemixState.noteId, excellentRemixState.board);
  const brand = state.brands.find((entry) => Number(entry.id) === Number(excellentRemixState.brandId));
  const subjectLabel = brand?.profileType === "personal" ? "个人 IP" : "品牌";
  const brandReady = Boolean(brand && isBrandDetailLoaded(brand) && !excellentRemixState.loadingBrand);
  const emptyState = !state.brands.length
    ? `<div class="excellent-remix-empty"><strong>还没有内容主体档案</strong><p>请先创建品牌或个人 IP，再回来完成一键仿图文。</p><div class="excellent-remix-empty-actions"><button class="primary-btn" data-remix-go-brand type="button">去创建档案</button></div></div>`
    : excellentRemixState.loadingBrand
      ? `<div class="excellent-remix-empty"><strong>正在加载${subjectLabel}详情…</strong><p>请稍候。</p></div>`
      : "";

  root.innerHTML = renderExcellentRemixBodyHtml({
    state: excellentRemixState,
    item,
    brand,
    brandReady,
    emptyStateHtml: emptyState,
    helpers: {
      escapeHtml,
      safeImageSrc,
      authenticatedImageSrc,
      formatCompactMetric,
      brands: state.brands,
      subjectLabel,
    },
  });

  if (submitButton) {
    submitButton.disabled = !canSubmitExcellentRemix(excellentRemixState, brandReady);
  }

  root.querySelector("[data-remix-go-brand]")?.addEventListener("click", () => {
    closeExcellentRemix();
    switchTab("brands");
  });
  root.querySelector("[data-remix-build-fusion]")?.addEventListener("click", () => {
    buildExcellentRemixFusionPlan().catch(() => {});
  });
  root.querySelector("[data-remix-generate-directions]")?.addEventListener("click", () => {
    loadExcellentRemixDirections().catch(() => {});
  });
  root.querySelector("[data-remix-open-product-picker]")?.addEventListener("click", () => {
    openExcellentRemixProductPicker().catch(() => {});
  });

  if (excellentRemixState.productPickerOpen) {
    renderExcellentRemixProductPicker();
  }
}

async function buildExcellentRemixFusionPlan() {
  if (!excellentRemixState) return;
  const brand = state.brands.find((entry) => Number(entry.id) === Number(excellentRemixState.brandId));
  const brandReady = brand && isBrandDetailLoaded(brand);
  if (!canGenerateFusionPlan(excellentRemixState, brandReady)) {
    showToast("请先完成品牌、参考分析与内容方向选择。");
    return;
  }
  const requestId = nextRemixRequestId(excellentRemixState, "fusionRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "fusionRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  const brandId = Number(excellentRemixState.brandId);
  excellentRemixState.fusionStatus = "loading";
  excellentRemixState.fusionError = "";
  renderExcellentRemix();
  try {
    const result = await fetchFusionPlan(request, noteId, buildFusionRequestBody(excellentRemixState));
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    excellentRemixState.fusionPlan = result.fusionPlan || result;
    excellentRemixState.fusionStatus = "ready";
    if (excellentRemixState.fusionPlan?.analysisId) {
      excellentRemixState.analysisId = excellentRemixState.fusionPlan.analysisId;
    }
    renderExcellentRemix();
  } catch (error) {
    if (isStaleSessionRequest(error) || !isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      return;
    }
    excellentRemixState.fusionStatus = "error";
    excellentRemixState.fusionError = error.message || "融合方案生成失败";
    excellentRemixState.fusionPlan = null;
    renderExcellentRemix();
  }
}

async function openExcellentRemixProductPicker() {
  if (!excellentRemixState?.brandId) return;
  const requestId = nextRemixRequestId(excellentRemixState, "productImagesRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "productImagesRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  const brandId = Number(excellentRemixState.brandId);
  excellentRemixState.productPickerOpen = true;
  excellentRemixState.brandProductImagesStatus = "loading";
  document.getElementById("excellentRemixProductPickerModal")?.classList.add("is-open");
  renderExcellentRemixProductPicker();
  try {
    const result = await fetchBrandProductImages(request, brandId);
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    excellentRemixState.brandProductImages = result.images || [];
    excellentRemixState.unassignedProductImages = result.unassignedImages || [];
    excellentRemixState.brandProductImagesStatus = "ready";
    renderExcellentRemixProductPicker();
  } catch (error) {
    if (isStaleSessionRequest(error) || !isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      return;
    }
    excellentRemixState.brandProductImages = [];
    excellentRemixState.unassignedProductImages = [];
    excellentRemixState.brandProductImagesStatus = "error";
    excellentRemixState.assetMode = REMIX_ASSET_MODES.NONE;
    excellentRemixState.productImageIds = [];
    showToast(`产品素材加载失败：${error.message}`);
    renderExcellentRemixProductPicker();
  }
}

async function uploadExcellentRemixBrandProductImage(file) {
  if (!excellentRemixState?.brandId || !file) return;
  const brandId = Number(excellentRemixState.brandId);
  const requestId = nextRemixRequestId(excellentRemixState, "productImagesRequestId");
  const token = captureRemixRequestToken(excellentRemixState, "productImagesRequestId", requestId);
  const noteId = excellentRemixState.noteId;
  const board = excellentRemixState.board;
  try {
    const dataUrl = await fileToDataUrl(file);
    const result = await request("/api/product-images", {
      method: "POST",
      body: JSON.stringify({
        brandId,
        name: file.name,
        dataUrl,
      }),
    });
    if (!isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) return;
    const image = result.image;
    if (image) {
      excellentRemixState.brandProductImages = [
        image,
        ...(excellentRemixState.brandProductImages || []).filter((item) => Number(item.id) !== Number(image.id)),
      ];
      excellentRemixState.unassignedProductImages = (excellentRemixState.unassignedProductImages || []).filter(
        (item) => Number(item.id) !== Number(image.id),
      );
      excellentRemixState.brandProductImagesStatus = "ready";
      // Auto-select newly uploaded brand asset if under cap.
      if ((excellentRemixState.productImageIds || []).length < MAX_REMIX_PRODUCT_IMAGES) {
        excellentRemixState.productImageIds = [
          ...new Set([...(excellentRemixState.productImageIds || []), image.id]),
        ].slice(0, MAX_REMIX_PRODUCT_IMAGES);
        excellentRemixState.assetMode = excellentRemixState.useBrandLogo
          ? REMIX_ASSET_MODES.LOGO_AND_PRODUCT
          : REMIX_ASSET_MODES.PRODUCT;
      }
      upsertProductImageLibrary(image);
      showToast(result.duplicate ? "该图片已在当前品牌素材库中" : "已上传到当前品牌素材库");
    }
    renderExcellentRemixProductPicker();
  } catch (error) {
    if (isStaleSessionRequest(error) || !isExcellentRemixResponseCurrent(token, { noteId, board, requireBrand: true, brandId })) {
      return;
    }
    showToast(`上传失败：${error.message}`);
  }
}

function renderExcellentRemixProductPicker() {
  const root = document.getElementById("excellentRemixProductPickerBody");
  if (!root || !excellentRemixState) return;
  root.innerHTML = renderBrandProductPickerHtml(excellentRemixState, {
    escapeHtml,
    authenticatedImageSrc,
  });
}

function closeExcellentRemixProductPicker() {
  document.getElementById("excellentRemixProductPickerModal")?.classList.remove("is-open");
  if (excellentRemixState) {
    excellentRemixState.productPickerOpen = false;
    if (excellentRemixState.productImageIds?.length) {
      excellentRemixState.assetMode =
        excellentRemixState.useBrandLogo ? REMIX_ASSET_MODES.LOGO_AND_PRODUCT : REMIX_ASSET_MODES.PRODUCT;
    }
    renderExcellentRemix();
  }
}

async function handleExcellentRemixChange(event) {
  if (!excellentRemixState) return;
  const target = event.target;

  if (target.dataset.remixField === "brand") {
    excellentRemixState.brandId = Number(target.value);
    await loadExcellentRemixBrandContext(excellentRemixState.brandId);
    return;
  }
  if (target.dataset.remixFocus) {
    if (target.dataset.remixFocus === "visual" && isPlatformDefaultVisual(excellentRemixState.analysis)) {
      // Opt-in only as platform-default guidance, never as reference-image learning.
      if (target.checked) {
        showToast("当前未进行图片理解，已作为平台通用视觉建议使用，不代表参考笔记真实视觉特征。");
      }
    }
    excellentRemixState.learningFocus = toggleLearningFocus(
      excellentRemixState.learningFocus,
      target.dataset.remixFocus,
      target.checked,
    );
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    renderExcellentRemix();
    return;
  }
  if (target.dataset.remixContentMode) {
    excellentRemixState.contentDirectionMode = target.dataset.remixContentMode;
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    // Smart directions are manual-only; switching tabs never auto-generates.
    renderExcellentRemix();
    return;
  }
  if (target.dataset.remixSmartDirection) {
    excellentRemixState.selectedSmartDirectionId = target.dataset.remixSmartDirection;
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    renderExcellentRemix();
    return;
  }
  if (target.dataset.remixExistingIdea) {
    const key = String(target.dataset.remixExistingIdea || "");
    const parsed = parseExistingIdeaKey(key);
    const hit = (excellentRemixState.existingIdeas || []).find((idea) => buildExistingIdeaKey(idea) === key);
    excellentRemixState.selectedExistingIdea = hit || parsed;
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    renderExcellentRemix();
    return;
  }
  if (target.hasAttribute("data-remix-upload-brand-product") && target.files?.[0]) {
    const file = target.files[0];
    target.value = "";
    await uploadExcellentRemixBrandProductImage(file);
    return;
  }
  if (target.hasAttribute("data-remix-custom-direction")) {
    excellentRemixState.customDirection = target.value || "";
    excellentRemixState = invalidateAfterInputChange(excellentRemixState, {});
    // Keep action availability in sync without re-rendering and disrupting the cursor.
    const brand = state.brands.find((entry) => Number(entry.id) === Number(excellentRemixState.brandId));
    const brandReady = Boolean(brand && isBrandDetailLoaded(brand));
    const fusionButton = document.querySelector("[data-remix-build-fusion]");
    if (fusionButton) {
      fusionButton.disabled = !canGenerateFusionPlan(excellentRemixState, brandReady);
    }
    const submitButton = document.getElementById("submitExcellentRemix");
    if (submitButton) {
      submitButton.disabled = !canSubmitExcellentRemix(
        excellentRemixState,
        brandReady,
      );
    }
    return;
  }
  if (target.hasAttribute("data-remix-idea-query")) {
    excellentRemixState.existingIdeaQuery = target.value || "";
    renderExcellentRemix();
    const search = document.querySelector("[data-remix-idea-query]");
    if (search) {
      search.focus();
      search.selectionStart = search.selectionEnd = search.value.length;
    }
    return;
  }
  if (target.hasAttribute("data-remix-logo")) {
    excellentRemixState.useBrandLogo = Boolean(target.checked);
    if (excellentRemixState.useBrandLogo) {
      excellentRemixState.assetMode = excellentRemixState.productImageIds.length
        ? REMIX_ASSET_MODES.LOGO_AND_PRODUCT
        : REMIX_ASSET_MODES.LOGO;
    } else if (excellentRemixState.productImageIds.length) {
      excellentRemixState.assetMode = REMIX_ASSET_MODES.PRODUCT;
    } else {
      excellentRemixState.assetMode = REMIX_ASSET_MODES.NONE;
    }
    renderExcellentRemix();
    return;
  }
  if (target.dataset.remixPickProduct) {
    let imageId = Number(target.dataset.remixPickProduct);
    const isUnassignedPick = target.hasAttribute("data-remix-pick-unassigned");
    if (target.checked) {
      if ((excellentRemixState.productImageIds || []).length >= MAX_REMIX_PRODUCT_IMAGES) {
        target.checked = false;
        showToast(`最多选择 ${MAX_REMIX_PRODUCT_IMAGES} 张产品实拍图。`);
        return;
      }
      if (isUnassignedPick) {
        try {
          const brandId = Number(excellentRemixState.brandId);
          const claimResult = await claimProductImageToBrand(request, imageId, brandId);
          const claimed = claimResult?.image;
          if (!claimed?.id) throw new Error("归属当前品牌失败");
          // Remove from unassigned list; add/replace in brand list.
          excellentRemixState.unassignedProductImages = (excellentRemixState.unassignedProductImages || []).filter(
            (item) => Number(item.id) !== Number(imageId) && Number(item.id) !== Number(claimed.id),
          );
          excellentRemixState.brandProductImages = [
            claimed,
            ...(excellentRemixState.brandProductImages || []).filter((item) => Number(item.id) !== Number(claimed.id)),
          ];
          imageId = Number(claimed.id);
          upsertProductImageLibrary(claimed);
          showToast("已加入当前品牌素材库");
        } catch (error) {
          target.checked = false;
          if (!isStaleSessionRequest(error)) {
            showToast(`加入品牌失败：${error.message}`);
          }
          renderExcellentRemixProductPicker();
          return;
        }
      }
      excellentRemixState.productImageIds = [...new Set([...(excellentRemixState.productImageIds || []), imageId])].slice(
        0,
        MAX_REMIX_PRODUCT_IMAGES,
      );
    } else {
      excellentRemixState.productImageIds = (excellentRemixState.productImageIds || []).filter((id) => id !== imageId);
    }
    if (excellentRemixState.productImageIds.length) {
      excellentRemixState.assetMode = excellentRemixState.useBrandLogo
        ? REMIX_ASSET_MODES.LOGO_AND_PRODUCT
        : REMIX_ASSET_MODES.PRODUCT;
    } else if (excellentRemixState.useBrandLogo) {
      excellentRemixState.assetMode = REMIX_ASSET_MODES.LOGO;
    } else {
      excellentRemixState.assetMode = REMIX_ASSET_MODES.NONE;
    }
    renderExcellentRemixProductPicker();
    return;
  }
}

async function submitExcellentRemix(event) {
  event.preventDefault();
  if (!excellentRemixState) return;
  const brand = state.brands.find((entry) => Number(entry.id) === Number(excellentRemixState.brandId));
  if (!brand) return;
  await ensureBrandDetailLoaded(brand.id);
  if (!canSubmitExcellentRemix(excellentRemixState, true)) {
    showToast("请先生成有效的融合方案（4 页）。");
    return;
  }
  const item = findExcellentContentById(excellentRemixState.noteId, excellentRemixState.board);
  const fusionPlan = excellentRemixState.fusionPlan;
  const genPayload = buildGenerationPayload(excellentRemixState, fusionPlan);
  const productImages = (excellentRemixState.brandProductImages || []).filter((image) =>
    genPayload.productImageIds.includes(image.id),
  );
  // Fallback: map ids to minimal objects for API if picker list was emptied after selection.
  const productImagePayload =
    productImages.length > 0
      ? productImages
      : genPayload.productImageIds.map((id) => ({ id }));
  closeExcellentRemix();
  await generateExcellentRemixCarousel({
    brand,
    fusionPlan,
    sourceCase: item,
    productImages: productImagePayload,
    useBrandLogo: Boolean(genPayload.useBrandLogo && brand.logo),
    contentMode: genPayload.contentMode,
    existingIdeaRef: genPayload.existingIdeaRef,
    ideaTitle: genPayload.ideaTitle,
    trendTitle: genPayload.trendTitle,
  });
}

async function generateExcellentRemixCarousel({
  brand,
  fusionPlan,
  sourceCase = null,
  productImages = [],
  useBrandLogo = false,
  contentMode = "smart",
  existingIdeaRef = null,
  ideaTitle = "",
  trendTitle = "",
  aspectRatio = "3:4",
} = {}) {
  if (!brand || !fusionPlan?.carouselPack) return;
  const imageResult = openAssetModal({
    kicker: "一键仿图文",
    title: "优秀内容仿图文方案",
    description: "基于参考方法 × 内容方向 × 品牌信息生成 4 页原创组图，可继续单张或一键生图。",
    loadingTitle: "正在准备仿图文方案...",
    loadingCopy: "正在校验融合方案并进入现有小红书组图预览链路。",
  });

  try {
    const previewResult = await previewExcellentRemix(request, brand.id, {
      aspectRatio,
      carouselPack: fusionPlan.carouselPack,
      contentMode,
      existingIdeaRef,
    });
    updateCurrentUser(previewResult.user);
    const previewPack = previewResult.carouselPack;
    if (!previewPack || !Array.isArray(previewPack.slides)) {
      throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
    }
    const serverCarouselGroupId = previewResult.carouselGroupId || previewPack.carouselGroupId;
    if (!serverCarouselGroupId) {
      throw new Error("预览未返回组图分组标识，请重试。");
    }
    const pack = {
      ...previewPack,
      aspectRatio,
      carouselGroupId: serverCarouselGroupId,
      slides: enrichXhsCarouselSlides(previewPack),
    };
    const flags = {
      isGeneratingAll: false,
      completed: false,
      completing: false,
      completeError: "",
    };
    /** @type {Map<number, { jobId: string, creditEventId: number|null, generationId: number|null, status: string }>} */
    const slideJobs = new Map();

    const taskQueue = [];
    let activeTaskCount = 0;
    let activeGenerateTaskCount = 0;
    let imageJobSubmissionChain = Promise.resolve();
    let renderAndBind = () => {};

    const getOrderedSlideJobIds = () =>
      [0, 1, 2, 3].map((index) => slideJobs.get(index)?.jobId).filter(Boolean);

    const rememberGenerationInHistory = (generation) => {
      if (!generation?.id) return;
      const existingIndex = state.generationHistory.findIndex((item) => item.id === generation.id);
      if (existingIndex >= 0) {
        state.generationHistory[existingIndex] = generation;
      } else {
        state.generationHistoryFilters = createEmptyGenerationHistoryFilters();
        state.generationHistoryNeedsLatest = false;
        state.generationHistory.unshift(generation);
      }
      renderGenerationHistory();
    };

    const completeIfReady = async ({ force = false } = {}) => {
      if (flags.completed || flags.completing) return;
      if (!pack.slides.every(hasXhsCarouselSlideImage)) return;
      const slideJobIds = getOrderedSlideJobIds();
      if (slideJobIds.length !== 4) {
        if (force) {
          flags.completeError = "缺少完整的 4 个图片任务，无法重新写入历史。";
          renderAndBind();
        }
        return;
      }
      flags.completing = true;
      flags.completeError = "";
      renderAndBind();
      try {
        const completeResult = await completeExcellentRemix(request, brand.id, {
          carouselGroupId: pack.carouselGroupId,
          slideJobIds,
          expectedSlideCount: 4,
        });
        updateCurrentUser(completeResult.user);
        rememberGenerationInHistory(completeResult.generation);
        flags.completed = true;
        flags.completeError = "";
        showToast("仿图文组图已全部生成并写入历史生成。");
      } catch (error) {
        flags.completeError = error?.message || "写入历史失败";
        showToast(`仿图文组图写入历史失败：${flags.completeError}。可点击「重新写入历史」重试，不会重复扣积分。`);
        throw error;
      } finally {
        flags.completing = false;
        renderAndBind();
      }
    };

    const getNextRunnableTaskIndex = () => {
      if (activeTaskCount >= IMAGE_TASK_MAX_CONCURRENCY || !taskQueue.length) return -1;
      const nextGenerateIndex = taskQueue.findIndex((task) => task.type === "generate");
      if (nextGenerateIndex >= 0) return nextGenerateIndex;
      if (activeGenerateTaskCount > 0) return -1;
      return 0;
    };

    const runImageJobSubmission = (submit) => {
      const pending = imageJobSubmissionChain.catch(() => {});
      imageJobSubmissionChain = pending.then(submit);
      return imageJobSubmissionChain;
    };

    const pumpImageTaskQueue = () => {
      let taskIndex = getNextRunnableTaskIndex();
      while (taskIndex >= 0) {
        const [task] = taskQueue.splice(taskIndex, 1);
        activeTaskCount += 1;
        if (task.type === "generate") activeGenerateTaskCount += 1;
        task
          .run()
          .catch((error) => {
            console.warn(error.message);
          })
          .finally(async () => {
            activeTaskCount -= 1;
            if (task.type === "generate") activeGenerateTaskCount -= 1;
            if (!taskQueue.length && activeTaskCount === 0) {
              flags.isGeneratingAll = false;
              await completeIfReady().catch(() => {});
            }
            renderAndBind();
            pumpImageTaskQueue();
          });
        taskIndex = getNextRunnableTaskIndex();
      }
    };

    const enqueueImageTask = (type, run) => {
      taskQueue.push({ type, run });
      pumpImageTaskQueue();
      renderAndBind();
    };

    const runGenerateSlide = async (slideIndex) => {
      const slide = pack.slides[slideIndex];
      if (!slide || hasXhsCarouselSlideImage(slide)) return;
      slide.isQueued = false;
      slide.isGenerating = true;
      renderAndBind();
      try {
        const result = await runImageJobSubmission(() =>
          generateExcellentRemixSlide(request, brand.id, slideIndex, {
            carouselPack: pack,
            carouselGroupId: pack.carouselGroupId,
            slide,
            productImages,
            useBrandLogo,
            aspectRatio,
            contentMode,
            existingIdeaRef,
            ideaTitle,
            trendTitle,
          }),
        );
        updateCurrentUser(result.user);
        if (!result.slideJob?.jobId) throw new Error("小红书组图任务创建失败");
        slideJobs.set(slideIndex, {
          jobId: result.slideJob.jobId,
          creditEventId: result.creditEventId || null,
          generationId: null,
          status: "pending",
        });
        const imageConcept = await pollImageJob(result.slideJob.jobId);
        pack.slides[slideIndex] = {
          ...pack.slides[slideIndex],
          previewUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          imageUrl: imageConcept.imageUrl || imageConcept.previewUrl,
          isGenerating: false,
          isQueued: false,
          error: "",
        };
        slideJobs.set(slideIndex, {
          jobId: result.slideJob.jobId,
          creditEventId: result.creditEventId || null,
          generationId: imageConcept.generationId || null,
          status: "completed",
        });
        if (imageConcept.generationId || imageConcept.persisted) {
          showToast("已保存至历史生成");
        }
      } catch (error) {
        if (isStaleSessionRequest(error)) return;
        slide.isGenerating = false;
        slide.isQueued = false;
        slide.error = `生成失败：${error.message}`;
      }
    };

    const enqueueGenerateSlide = (slideIndex) => {
      const slide = pack.slides[slideIndex];
      if (!slide || hasXhsCarouselSlideImage(slide) || slide.isGenerating || slide.isQueued) return;
      syncXhsCarouselPromptInputs(imageResult, pack);
      slide.isQueued = true;
      slide.error = "";
      enqueueImageTask("generate", () => runGenerateSlide(slideIndex));
    };

    // Reuse the existing carousel UI renderer by temporarily adapting to known helpers.
    renderAndBind = () => {
      renderXhsCarouselPreviewUI({
        imageResult,
        pack,
        flags,
        sourceCase,
        enqueueGenerateSlide,
        onGenerateAll: () => {
          flags.isGeneratingAll = true;
          pack.slides.forEach((_, index) => enqueueGenerateSlide(index));
        },
        onRetryComplete: () => {
          completeIfReady({ force: true }).catch(() => {});
        },
      });
    };
    renderAndBind();
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    imageResult.innerHTML = `<div class="image-meta-card"><h3>准备失败</h3><div class="idea-copy">${escapeHtml(
      error.message,
    )}</div></div>`;
  }
}

function renderXhsCarouselPreviewUI({
  imageResult,
  pack,
  flags,
  sourceCase,
  enqueueGenerateSlide,
  onGenerateAll,
  onRetryComplete,
}) {
  // Lightweight dedicated renderer so excellent remix does not depend on trend/idea route helpers.
  const slidesHtml = (pack.slides || [])
    .map((slide, index) => {
      const img = slide.imageUrl || slide.previewUrl;
      return `
        <div class="xhs-slide-card">
          <div class="xhs-slide-head">
            <strong>${escapeHtml(slide.pageLabel || `第 ${index + 1} 张`)}</strong>
            <span>${escapeHtml(slide.pageRole || "")}</span>
          </div>
          <div class="idea-copy"><strong>${escapeHtml(slide.title || "")}</strong><p>${escapeHtml(slide.copy || "")}</p></div>
          <div class="idea-copy muted">${escapeHtml(slide.visualDirection || "")}</div>
          ${
            img
              ? `<img src="${authenticatedImageSrc(img)}" alt="${escapeHtml(slide.title || "")}" />`
              : `<div class="excellent-cover-fallback">待生成</div>`
          }
          ${slide.error ? `<div class="idea-copy" style="color:#ff8fa8">${escapeHtml(slide.error)}</div>` : ""}
          <button type="button" class="secondary-btn small-btn" data-remix-gen-slide="${index}" ${
            slide.isGenerating || slide.isQueued || img ? "disabled" : ""
          }>
            ${slide.isGenerating || slide.isQueued ? "生成中…" : "生成此页"}
          </button>
        </div>
      `;
    })
    .join("");

  const allReady = (pack.slides || []).every((slide) => Boolean(slide.imageUrl || slide.previewUrl));
  const showRetry = Boolean(flags.completeError) && allReady && !flags.completed;

  imageResult.innerHTML = `
    <div class="asset-header-card">
      <h3>${escapeHtml(pack.publishTitle || pack.title || "仿图文组图")}</h3>
      <p>${escapeHtml(pack.publishCaption || "")}</p>
      ${sourceCase ? `<p class="muted">参考：${escapeHtml(sourceCase.title || "")}（仅学习方法，不复制原文原图）</p>` : ""}
      <div class="form-actions">
        <button type="button" class="primary-btn" data-remix-gen-all ${flags.isGeneratingAll || flags.completing ? "disabled" : ""}>一键生成四页</button>
        ${
          showRetry
            ? `<button type="button" class="secondary-btn" data-remix-retry-complete ${flags.completing ? "disabled" : ""}>${
                flags.completing ? "写入中…" : "重新写入历史"
              }</button>`
            : ""
        }
      </div>
      ${
        flags.completeError
          ? `<p class="idea-copy" style="color:#ff8fa8">写入历史失败：${escapeHtml(
              flags.completeError,
            )}。当前 4 张图片仍保留，重试不会重复生成或扣积分。</p>`
          : ""
      }
      ${flags.completed ? `<p class="idea-copy muted">组图已写入历史生成。</p>` : ""}
    </div>
    <div class="asset-grid xhs-slide-grid">${slidesHtml}</div>
  `;
  imageResult.querySelector("[data-remix-gen-all]")?.addEventListener("click", onGenerateAll);
  imageResult.querySelector("[data-remix-retry-complete]")?.addEventListener("click", () => onRetryComplete?.());
  imageResult.querySelectorAll("[data-remix-gen-slide]").forEach((button) => {
    button.addEventListener("click", () => enqueueGenerateSlide(Number(button.dataset.remixGenSlide)));
  });
}

function bindExcellentContentLibrary() {
  const grid = document.getElementById("excellentContentGrid");
  grid?.addEventListener("click", (event) => {
    if (event.target.closest("[data-excellent-external]")) return;
    const remixButton = event.target.closest("[data-excellent-remix]");
    if (remixButton) {
      openExcellentRemix(remixButton.dataset.excellentRemix);
      return;
    }
    const detailButton = event.target.closest("[data-excellent-detail]");
    if (detailButton) openExcellentContentDetail(detailButton.dataset.excellentDetail);
  });

  document.querySelectorAll("[data-excellent-board]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchExcellentBoard(btn.getAttribute("data-excellent-board"));
    });
  });

  // Filter changes only touch draft fields. Never load list / POST refresh / clear items.
  document.getElementById("excellentCategoryFilter")?.addEventListener("change", (event) => {
    const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
    const slice = getExcellentBoardState(board);
    if (slice.refreshing) {
      // Revert UI while a refresh is in flight.
      renderExcellentTaxonomyOptions();
      return;
    }
    if (board === "ecommerce_hot") {
      slice.draftIndustryPath = event.target.value || "";
    } else {
      slice.draftCategoryPath = event.target.value || "";
    }
    slice.refreshError = "";
    renderExcellentFilterChrome();
  });

  document.getElementById("excellentSourceFilter")?.addEventListener("change", (event) => {
    const board = state.excellentContentBoard === "ecommerce_hot" ? "ecommerce_hot" : "xhs_hot";
    const slice = getExcellentBoardState(board);
    if (slice.refreshing) {
      renderExcellentSourceOptions();
      return;
    }
    slice.draftContentSource = event.target.value || "all";
    slice.refreshError = "";
    renderExcellentFilterChrome();
  });

  document.getElementById("refreshExcellentContentsBtn")?.addEventListener("click", () => {
    refreshExcellentContentsForBoard(state.excellentContentBoard).catch(() => {});
  });

  document.getElementById("closeExcellentContentModal")?.addEventListener("click", closeExcellentContentDetail);
  document.getElementById("excellentContentModal")?.addEventListener("click", (event) => {
    if (event.target.id === "excellentContentModal") closeExcellentContentDetail();
  });
  document.getElementById("closeExcellentRemixModal")?.addEventListener("click", closeExcellentRemix);
  document.getElementById("cancelExcellentRemixModal")?.addEventListener("click", closeExcellentRemix);
  document.getElementById("excellentRemixModal")?.addEventListener("click", (event) => {
    if (event.target.id === "excellentRemixModal") closeExcellentRemix();
  });
  document.getElementById("excellentRemixBody")?.addEventListener("change", handleExcellentRemixChange);
  document.getElementById("excellentRemixBody")?.addEventListener("input", (event) => {
    if (
      event.target?.hasAttribute?.("data-remix-custom-direction") ||
      event.target?.hasAttribute?.("data-remix-idea-query")
    ) {
      handleExcellentRemixChange(event);
    }
  });
  document.getElementById("excellentRemixForm")?.addEventListener("submit", submitExcellentRemix);
  document.getElementById("closeExcellentRemixProductPickerModal")?.addEventListener("click", closeExcellentRemixProductPicker);
  document.getElementById("finishExcellentRemixProductPickerModal")?.addEventListener("click", closeExcellentRemixProductPicker);
  document.getElementById("excellentRemixProductPickerBody")?.addEventListener("change", handleExcellentRemixChange);
  document.getElementById("excellentRemixProductPickerModal")?.addEventListener("click", (event) => {
    if (event.target.id === "excellentRemixProductPickerModal") closeExcellentRemixProductPicker();
  });

  document.addEventListener("keydown", (event) => {
    if (document.getElementById("excellentContentModal")?.classList.contains("is-open") && state.excellentDetail?.item) {
      const images = getDetailImages(state.excellentDetail.item);
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        state.excellentDetail.activeImageIndex = getPreviousImageIndex(state.excellentDetail.activeImageIndex, images.length);
        renderExcellentDetailCarousel();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        state.excellentDetail.activeImageIndex = getNextImageIndex(state.excellentDetail.activeImageIndex, images.length);
        renderExcellentDetailCarousel();
        return;
      }
    }
    if (event.key !== "Escape") return;
    if (document.getElementById("excellentRemixModal")?.classList.contains("is-open")) {
      closeExcellentRemix();
      return;
    }
    if (document.getElementById("excellentContentModal")?.classList.contains("is-open")) {
      closeExcellentContentDetail();
    }
  });
}

async function generateStyleImage(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  const idea = trend?.ideas?.[ideaIndex];
  if (!brand || !trend || !idea) return;
  const stylePrompt = buildIdeaStylePrompt(idea);
  if (!stylePrompt) {
    alert("请先点击当前选题右上角“编辑”，补充内容摘要、切入角度等字段后再生成风格化图。");
    return;
  }
  const styleReference = getStyleReference(ideaIndex);
  const aspectRatio = getResolvedIdeaAspectRatio(ideaIndex, "styleImage");
  let pendingTaskId = "";
  const imageResult = openAssetModal({
    kicker: "AI 风格化图",
    title: "风格化图片",
    description: "按当前选题的标题、摘要、角度和人群生成公众号封面、节日祝福海报或运营视觉。",
    loadingTitle: "AI 正在生成风格化图...",
    loadingCopy: "正在按当前选题内容生成风格化图片。参考图只用于借鉴色调、版式和氛围。",
  });

  try {
    const result = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/style-image`, {
      method: "POST",
      body: JSON.stringify({
        title: idea.title || "风格化图片",
        stylePrompt,
        useBrandLogo: isBrandLogoEnabled(ideaIndex),
        aspectRatio,
        styleReferenceImages: styleReference
          ? [
              {
                name: styleReference.fileName,
                dataUrl: styleReference.dataUrl,
              },
            ]
          : [],
      }),
    });
    updateCurrentUser(result.user);
    if (!result.jobId) throw new Error("风格化图任务创建失败");
    pendingTaskId = `style:${result.jobId}`;
    addPendingImageTask({
      id: pendingTaskId,
      type: "single",
      channel: "styleImage",
      jobId: result.jobId,
    });
    imageResult.innerHTML = `<div class="image-meta-card"><h3>AI 正在生成风格化图...</h3><div class="idea-copy">图片任务已提交，正在等待外部服务返回结果。</div></div>`;
    const imageConcept = await pollImageJob(result.jobId);
    await refreshGenerationHistoryAfterGeneration();
    removePendingImageTask(pendingTaskId);
    const generatedImageUrl = imageConcept.imageUrl || imageConcept.previewUrl;
    imageResult.innerHTML = `
      <div class="asset-header-card">
        <h3>${escapeHtml(imageConcept.title || "风格化图片")}</h3>
      </div>
      <div class="asset-grid">
        <div class="image-preview-card">
          <img src="${authenticatedImageSrc(generatedImageUrl)}" alt="${escapeHtml(imageConcept.title || "风格化图片")}" />
        </div>
        <div class="image-meta-card">
          <h3>风格化图制作说明</h3>
          <div class="image-meta-item">
            <span>用途</span>
            <div>公众号封面、节日祝福海报或运营视觉</div>
          </div>
          ${renderImageEditPanel({
            imageUrl: generatedImageUrl,
            title: imageConcept.title || "风格化图片",
            aspectRatio: imageConcept.aspectRatio,
          })}
        </div>
      </div>
    `;
    bindImageEditActions(imageResult);
  } catch (error) {
    if (isStaleSessionRequest(error)) return;
    if (pendingTaskId) removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `<div class="image-meta-card"><h3>生成失败</h3><div class="idea-copy">${escapeHtml(error.message)}</div></div>`;
  }
}

init();
