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

let sessionEpoch = 0;

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

const HISTORY_TYPE_LABELS = new Map([
  ["moments", "朋友圈图文"],
  ["wechat", "公众号长图"],
  ["xhsCarousel", "小红书组图"],
  ["styleImage", "一键风格化"],
  ["imageEdit", "历史改图"],
]);

async function init() {
  bindLandingEntry();
  bindSidebarControls();
  bindAccountCenterModal();
  bindSidebarTabs();
  bindTabJump();
  bindBrandModal();
  bindBrandDeleteModal();
  bindImageModal();
  bindProductImageLibraryModal();
  bindAuthModal();
  bindBusinessQuoteModal();
  bindAnalysisButton();
  bindXhsCategorySelector();
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
  const user = state.currentUser;
  if (!account || !expiry || !packageName) return;

  account.textContent = firstTextValue(user?.phone, user?.name) || "-";
  expiry.textContent = getAccountPackageExpiry(user);
  packageName.textContent = getAccountPackageName(user);
}

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
  let pendingLogo = null;
  let editingBrandId = null;

  const setLogoPreview = (brand = null) => {
    if (!logoPreview) return;
    if (brand?.logo?.url) {
      logoPreview.innerHTML = `
        <span>当前 Logo：${escapeHtml(formatImageName(brand.logo.originalName || "品牌 Logo", 38))}</span>
        <img src="${authenticatedImageSrc(brand.logo.url)}" alt="${escapeHtml(brand.logo.originalName || "品牌 Logo")}" />
      `;
      return;
    }
    logoPreview.textContent = "可选上传，后续生图时可作为产品 Logo 使用。";
  };
  const setBrandModalMode = (brand = null) => {
    editingBrandId = brand?.id || null;
    pendingLogo = null;
    form.reset();
    if (logoInput) logoInput.value = "";
    if (modalKicker) modalKicker.textContent = editingBrandId ? "品牌资产维护" : "品牌资产录入";
    if (modalTitle) modalTitle.textContent = editingBrandId ? "编辑品牌" : "新增品牌";
    if (modalDescription) modalDescription.textContent = editingBrandId ? "更新品牌定位、产品信息和资料库，后续 AI 分析会使用最新内容。" : "填写品牌信息，帮助 AI 更好地理解你的需求";
    if (submitButton) submitButton.textContent = editingBrandId ? "保存修改" : "创建品牌";
    if (logoUploadText) logoUploadText.textContent = brand?.logo ? "更换 Logo" : "选择 Logo 图片";
    setLogoPreview(brand);
    if (!brand) return;
    form.elements.name.value = brand.name || "";
    form.elements.industry.value = brand.industry || "";
    form.elements.audience.value = brand.audience || "";
    form.elements.description.value = brand.description || "";
    form.elements.product.value = brand.product || "";
    form.elements.knowledgeBase.value = brand.knowledgeBase || "";
    form.elements.goal.value = brand.goal || "";
  };
  const open = (brand = null) => {
    setBrandModalMode(brand);
    modal.classList.add("is-open");
  };
  openBrandEditor = open;
  const close = () => {
    modal.classList.remove("is-open");
  };

  openBtn.addEventListener("click", () => open());
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
    if (!validateSingleReferenceFile(file, "品牌 Logo")) {
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
      alert(`品牌 Logo 读取失败：${error.message}`);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    const profileSize = getBrandProfileInputSize(payload);
    if (profileSize.total > MAX_BRAND_PROFILE_CHARS) {
      alert(
        `当前品牌档案共 ${profileSize.total} 字，超过上限 ${MAX_BRAND_PROFILE_CHARS} 字，已超出 ${profileSize.total - MAX_BRAND_PROFILE_CHARS} 字。请删减品牌介绍、产品介绍或品牌资料库后再保存。`,
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
      switchTab("brands");
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(false);
    }
  });
}

function getBrandProfileInputSize(payload) {
  const fields = ["name", "industry", "audience", "description", "product", "goal", "knowledgeBase"];
  return {
    total: fields.reduce((sum, key) => sum + String(payload?.[key] || "").trim().length, 0),
  };
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
      alert("请先选择品牌并生成热点趋势。");
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
  state.trendAnalysisLoadingKeys = [];
  state.productImages = {};
  state.productImageLibrary = [];
  state.productImagePickerIdeaIndex = null;
  state.brandLogoUsage = {};
  state.editingIdeas = {};
  state.styleReferences = {};
  state.resumingImageTasks = false;
  brandDetailRequests.clear();
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
    return;
  }

  state.xhsCategories = Array.isArray(result?.items) ? result.items : [];
  state.xhsCategoryStatus = state.xhsCategories.length ? "ready" : "empty";
  state.xhsCategoryError = "";
  const validValues = new Set(flattenXhsCategoryOptions(state.xhsCategories).map((item) => item.value));
  if (state.xhsCategoryPath && !validValues.has(state.xhsCategoryPath)) {
    state.xhsCategoryPath = "";
  }
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
    const result = await request(`/api/brands/${brandId}`, {
      method: "DELETE",
      body: JSON.stringify({ deleteGenerations }),
    });
    state.brands = state.brands.filter((item) => item.id !== brandId);
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
      items: Array.isArray(bucket.items) ? bucket.items : [],
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
  renderBrandChips();
  renderTrendModeTabs();
  renderTrendAnalysisButton();
  renderXhsCategorySelector();
  renderHistory();
  renderAnalysisSummary();
  renderTrends();
  renderIdeas();
  renderGenerationHistory();
}

function renderBrands() {
  const root = document.getElementById("brandList");
  if (!state.brands.length) {
    root.innerHTML = `<article class="brand-card"><div class="brand-description">你还没有品牌档案。登录后先新增品牌，就可以开始热点分析和内容选题。</div></article>`;
    return;
  }

  root.innerHTML = state.brands
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

function renderBrandChips() {
  const root = document.getElementById("trendBrandChips");
  root.innerHTML = state.brands
    .map(
      (brand) => `
        <button class="brand-chip ${brand.id === state.selectedBrandId ? "is-active" : ""}" data-chip-brand="${brand.id}" type="button">
          ${escapeHtml(brand.name)}
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
        showToast(`品牌详情加载失败：${error.message}`, 8000);
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
    root.innerHTML = `<p class="analysis-tip">当前品牌还没有分析记录，点击上方按钮即可开始分析。</p>`;
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
    root.textContent = "先新增品牌档案，再开始基于品牌资产的热点趋势分析。";
    return;
  }

  if (!isBrandDetailLoaded(brand)) {
    root.textContent = `正在加载 ${brand.name} 的完整品牌详情和趋势记录。`;
    return;
  }

  if (!brand.trends.length) {
    root.textContent = `已为 ${brand.name} 建立品牌档案。请选择一个热点维度，点击左侧按钮只生成该维度的 10 条趋势和 20 个完整选题。`;
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
          <p>${escapeHtml(fallbackBucket.description)}</p>
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
          <p>${escapeHtml(fallbackBucket.description)}</p>
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
        <p>${escapeHtml(getDefaultTrendBucket(bucket.key)?.description || bucket.description)}</p>
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
        <p class="idea-copy">内容选题不是只追热点，而是把品牌资产、产品卖点、目标受众和运营目标一起带入，生成真正适合该品牌的小红书内容方向。</p>
        <p class="idea-copy"><strong>热点适配原因：</strong>${escapeHtml(trend.reason)}</p>
        <p class="idea-copy"><strong>品牌资料库：</strong>${escapeHtml(brand.knowledgeBase || "当前未补充品牌资料库。")}</p>
        <p class="idea-copy"><strong>参考图片：</strong>可在下方每个选题中上传产品图、选择品牌 Logo 或添加风格参考图，并勾选后用于对应生图。</p>
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
  const logoEnabled = isBrandLogoEnabled(ideaIndex) && Boolean(brandLogo);
  return `
    <div class="idea-logo-control">
      <label class="idea-logo-check">
        <input data-use-brand-logo="${ideaIndex}" type="checkbox" ${brandLogo ? "" : "disabled"} ${logoEnabled ? "checked" : ""} />
        <span>使用品牌 Logo</span>
      </label>
      <div class="idea-logo-meta">
        <span>${brandLogo ? escapeHtml(formatImageName(brandLogo.originalName || "品牌 Logo", 38)) : "未上传 Logo"}</span>
        <label class="idea-inline-upload">
          <input data-brand-logo-image="${ideaIndex}" type="file" accept="image/*" />
          <span>${brandLogo ? "更换 Logo" : "上传 Logo"}</span>
        </label>
      </div>
    </div>
  `;
}

function renderIdeaProductUpload(ideaIndex) {
  const selection = getProductSelection(ideaIndex);
  const selectedImages = selection.images;
  const selectedCount = selectedImages.length;
  const checked = selection.useImage;
  const fileLabel = selectedCount ? selectedImages.map((image) => image.fileName || image.name || "产品图").join("、") : "";
  const selectedPreview = selectedCount
    ? `<div class="idea-product-selected-strip">${selectedImages
        .slice(0, MAX_SELECTED_PRODUCT_IMAGES)
        .map(
          (image) => `
            <div class="idea-product-selected-preview" title="${escapeHtml(image.fileName || image.name || "产品图")}">
              <img src="${productImageSrc(image)}" alt="${escapeHtml(image.fileName || image.name || "产品图")}" />
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
            <div class="idea-product-upload-title">产品图参考</div>
            <div class="idea-product-file ${selectedCount ? "has-file" : ""}" data-product-file="${ideaIndex}">
              ${
                selectedCount
                  ? escapeHtml(
                      checked
                        ? `已选择 ${selectedCount} 张：${formatImageName(fileLabel, 46)}，生图时会作为主体参考`
                        : `已选择 ${selectedCount} 张：${formatImageName(fileLabel, 46)}`,
                    )
                  : "未选择产品图"
              }
            </div>
            <div class="idea-product-file">最多 ${MAX_SELECTED_PRODUCT_IMAGES} 张，共 ${formatFileSize(MAX_SELECTED_PRODUCT_IMAGE_BYTES)}；当前 ${selectedCount} 张，约 ${formatFileSize(getSelectionTotalBytes(selectedImages))}</div>
          </div>
        </div>
        <div class="idea-product-button-stack">
          <label class="idea-upload-button">
            <input data-product-image="${ideaIndex}" type="file" accept="image/*" multiple />
            <span>${selectedCount ? "继续上传" : "上传产品图"}</span>
          </label>
          <button class="idea-library-button" data-open-product-library="${ideaIndex}" type="button">选择已上传图片</button>
        </div>
      </div>
      ${selectedPreview}
      <div class="idea-product-actions idea-product-actions-bottom">
        <label class="idea-product-check">
          <input data-use-product-image="${ideaIndex}" type="checkbox" ${selectedCount ? "" : "disabled"} ${checked ? "checked" : ""} />
          使用这些产品图生成图片
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
            aspectRatio: "9:16",
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
    composition: slide.composition || `小红书组图${index + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性。`,
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

  const imageResult = openAssetModal({
    kicker: "AI 小红书组图",
    title: "小红书组图内容包",
    description: "先检查每张图的视觉方向、风格和构图，再选择单张或一键生成四张图。",
    loadingTitle: "正在准备小红书组图方案...",
    loadingCopy: "正在整理 4 张组图页面的视觉方向、风格和构图建议。",
  });

  try {
    const idea = trend.ideas?.[ideaIndex];
    if (!idea) throw new Error("当前选题不存在，请重新生成或刷新页面后再试。");
    const previewResult = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/xhs-carousel/preview`, {
      method: "POST",
    });
    updateCurrentUser(previewResult.user);
    const previewPack = previewResult.carouselPack;
    if (!previewPack || !Array.isArray(previewPack.slides)) {
      throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
    }
    const pack = {
      ...previewPack,
      carouselGroupId: previewPack.carouselGroupId || createXhsCarouselGroupId(brand.id, trend.id, ideaIndex),
      slides: enrichXhsCarouselSlides(previewPack),
    };
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
      const completeResult = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/xhs-carousel/complete`, {
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
      showToast("小红书组图已全部生成并写入历史生成。");
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
          request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/xhs-carousel/slides/${slideIndex}`, {
            method: "POST",
            body: JSON.stringify({
              carouselPack: pack,
              slide,
              productImages: getSelectedProductImages(ideaIndex),
              useBrandLogo: isBrandLogoEnabled(ideaIndex),
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
              aspectRatio: "3:4",
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
          alert(`积分不足，一键生成剩余 ${remainingSlideCount} 张需要 ${remainingSlideCount} 积分，当前剩余 ${Number(state.currentUser?.credits || 0)} 积分。`);
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
