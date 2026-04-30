const STORAGE_KEY = "redbase.sessionToken";
const SIDEBAR_COLLAPSED_KEY = "redbase.sidebarCollapsed";
const PENDING_IMAGE_TASKS_KEY = "redbase.pendingImageTasks";
const IMAGE_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
const IMAGE_JOB_POLL_INTERVAL_MS = 5000;
const IMAGE_TASK_MAX_CONCURRENCY = 30;
const MAX_SELECTED_PRODUCT_IMAGES = 10;
const MAX_SELECTED_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_SINGLE_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BRAND_PROFILE_CHARS = 5000;
const DEFAULT_TREND_BUCKETS = [
  {
    key: "xhs",
    title: "小红书热点话题",
    description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
  },
  {
    key: "news",
    title: "新闻热点趋势",
    description: "从近期新闻、行业动态和消费趋势中找到可被品牌内容化的机会。",
  },
  {
    key: "social",
    title: "社会热点趋势",
    description: "从大众情绪、生活方式变化、社会议题和公共讨论中找到适合品牌表达的切口。",
  },
  {
    key: "traffic",
    title: "流量热点趋势",
    description: "从小红书站内爆款形式、标题结构、场景表达和内容套路中找到流量机会。",
  },
  {
    key: "track",
    title: "赛道热点趋势",
    description: "聚焦品牌所属行业、品类、竞品内容和消费决策链路里的增长机会。",
  },
  {
    key: "crowd",
    title: "人群热点趋势",
    description: "聚焦目标受众正在关注的身份标签、生活场景、消费焦虑、兴趣圈层和内容需求。",
  },
];
const DEFAULT_TREND_MODE = DEFAULT_TREND_BUCKETS[0].key;
const LEGACY_TREND_BUCKET_KEYS = {
  global: "xhs",
  industry: "track",
};

const state = {
  currentPage: "landing",
  currentTab: "brands",
  brands: [],
  generationHistory: [],
  selectedBrandId: null,
  selectedTrendId: null,
  selectedTrendMode: DEFAULT_TREND_MODE,
  loading: false,
  currentUser: null,
  sessionToken: localStorage.getItem(STORAGE_KEY) || "",
  productImages: {},
  productImageLibrary: [],
  productImagePickerIdeaIndex: null,
  productImageLibrarySort: "recentUsed",
  brandLogoUsage: {},
  editingIdeas: {},
  styleReferences: {},
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  resumingImageTasks: false,
};
let openBrandEditor = () => {};
let pendingBrandDeleteId = null;

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
  if (src.startsWith("data:image/") || src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
    return src;
  }
  return "";
}

function authenticatedImageSrc(value) {
  const src = safeImageSrc(value);
  if (!src || !state.sessionToken || !src.startsWith("/api/") || src.includes("token=")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}token=${encodeURIComponent(state.sessionToken)}`;
}

function productImageSrc(image) {
  return authenticatedImageSrc(image?.url);
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

async function pollImageJob(jobId, maxWaitMs = IMAGE_JOB_MAX_WAIT_MS, delayMs = IMAGE_JOB_POLL_INTERVAL_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const result = await request(`/api/image-jobs/${jobId}`);
    if (result.status === "completed") {
      return result.imageConcept;
    }
    if (result.status === "failed") {
      throw new Error(result.error || "图片生成失败");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`图片生成时间超过 ${Math.round(maxWaitMs / 60000)} 分钟，请稍后再试。`);
}

async function init() {
  bindLandingEntry();
  bindSidebarControls();
  bindSidebarTabs();
  bindTabJump();
  bindBrandModal();
  bindBrandDeleteModal();
  bindImageModal();
  bindProductImageLibraryModal();
  bindAuthModal();
  bindAnalysisButton();
  bindIdeaPromptActions();
  bindLogout();
  await restoreSession();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadProductImage(file) {
  const dataUrl = await fileToDataUrl(file);
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
  const dataUrl = await fileToDataUrl(file);
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

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
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

function formatImageName(name, maxLength = 32) {
  const text = String(name || "产品图");
  if (text.length <= maxLength) return text;
  const extMatch = text.match(/(\.[a-z0-9]{2,5})$/i);
  const ext = extMatch?.[1] || "";
  const headLength = Math.max(10, maxLength - ext.length - 10);
  return `${text.slice(0, headLength)}...${text.slice(-6 - ext.length)}`;
}

function showToast(message) {
  let toast = document.getElementById("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
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
  const tasks = getCurrentUserPendingImageTasks();
  if (!tasks.length) return;

  state.resumingImageTasks = true;
  showToast(`发现 ${tasks.length} 个未完成图片任务，正在后台恢复。`);
  try {
    for (const task of tasks) {
      await resumePendingImageTask(task);
    }
  } finally {
    state.resumingImageTasks = false;
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
    await loadGenerationHistory();
    removePendingImageTask(task.id);
    showToast("一个历史图片任务已恢复完成。");
  } catch (error) {
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
      model: imageConcept.model,
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
  await loadGenerationHistory();
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
  if (icon) icon.textContent = state.sidebarCollapsed ? "›" : "‹";
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
      pendingLogo = {
        name: file.name,
        dataUrl: await fileToDataUrl(file),
      };
      if (logoUploadText) logoUploadText.textContent = "重新选择 Logo";
      if (logoPreview) {
        logoPreview.innerHTML = `
          <span>已选择：${escapeHtml(formatImageName(file.name, 38))}</span>
          <img src="${escapeHtml(pendingLogo.dataUrl)}" alt="${escapeHtml(file.name)}" />
        `;
      }
    } catch (error) {
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
        state.brands.unshift(result.brand);
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
  const accountTypeSelect = document.getElementById("accountTypeSelect");
  const departmentField = document.getElementById("departmentField");
  const departmentSelect = document.getElementById("departmentSelect");

  const syncDepartmentField = () => {
    const isYimei = accountTypeSelect?.value === "yimei";
    departmentField?.classList.toggle("is-hidden", !isYimei);
    if (departmentSelect) {
      departmentSelect.required = isYimei;
      if (!isYimei) departmentSelect.value = "";
    }
  };
  accountTypeSelect?.addEventListener("change", syncDepartmentField);
  syncDepartmentField();

  closeBtn.addEventListener("click", () => modal.classList.remove("is-open"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.classList.remove("is-open");
    }
  });

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setAuthTab(tab.dataset.authTab));
  });

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(registerForm).entries());
    if (payload.accountType !== "yimei") {
      payload.department = "";
    }
    try {
      const result = await request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applySession(result.sessionToken, result.user);
      registerForm.reset();
      syncDepartmentField();
      document.getElementById("authModal").classList.remove("is-open");
      await loadBrands();
      switchPage("dashboard");
      switchTab(state.currentTab || "brands");
      resumePendingImageTasks();
    } catch (error) {
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
      applySession(result.sessionToken, result.user);
      document.getElementById("authModal").classList.remove("is-open");
      await loadBrands();
      switchPage("dashboard");
      switchTab(state.currentTab || "brands");
      resumePendingImageTasks();
    } catch (error) {
      alert(error.message);
    }
  });
}

function bindAnalysisButton() {
  document.getElementById("runTrendAnalysis").addEventListener("click", async () => {
    const brand = getSelectedBrand();
    if (!brand) return;

    try {
      setBusy(true);
      const result = await request(`/api/brands/${brand.id}/analyses`, {
        method: "POST",
      });
      updateCurrentUser(result.user);
      replaceBrand(result.brand);
      state.selectedTrendMode = firstTrendBucket(result.brand)?.key ?? DEFAULT_TREND_MODE;
      state.selectedTrendId = firstTrendBucket(result.brand)?.items?.[0]?.id ?? null;
      renderAll();
    } catch (error) {
      alert(formatTrendAnalysisError(error));
    } finally {
      setBusy(false);
    }
  });
}

function formatTrendAnalysisError(error) {
  const message = String(error?.message || "");
  if (message.includes("未返回可用趋势结果") || message.includes("未能获取到可用热点") || message.includes("文本模型暂时不可用")) {
    return [
      "本次分析未能获取到可用热点，请稍后重试。",
      "",
      "搜索增强已保持开启，系统已尝试宽松解析、严格格式和精简品牌资料三次，但这次仍没有拿到完整可用的热点列表。",
      "",
      "你的品牌资料和积分状态没有损坏，请稍后再次点击「开始 AI 热点分析」。",
    ].join("\n");
  }
  return message || "AI 热点分析失败，请稍后再次点击「开始 AI 热点分析」重新生成。";
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
    state.brands = [];
      state.generationHistory = [];
      state.productImageLibrary = [];
      state.productImages = {};
      state.selectedBrandId = null;
    state.selectedTrendId = null;
    renderAll();
    switchPage("landing");
  });
}

async function restoreSession() {
  if (!state.sessionToken) {
    switchPage("landing");
    renderUser();
    return;
  }

  try {
    const result = await request("/api/session");
    state.currentUser = result.user;
    renderUser();
    await loadBrands();
    switchPage("dashboard");
    switchTab(state.currentTab);
    resumePendingImageTasks();
  } catch (error) {
    clearSession();
    switchPage("landing");
    renderUser();
  }
}

function applySession(token, user) {
  state.sessionToken = token;
  state.currentUser = user;
  localStorage.setItem(STORAGE_KEY, token);
  renderUser();
}

function updateCurrentUser(user) {
  if (!user) return;
  state.currentUser = user;
  renderUser();
}

function clearSession() {
  state.sessionToken = "";
  state.currentUser = null;
  localStorage.removeItem(STORAGE_KEY);
  renderUser();
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
  const button = document.getElementById("runTrendAnalysis");
  if (button) {
    button.disabled = loading;
    button.innerHTML = loading
      ? "<span>分析中...</span>"
      : "<span>开始 AI 热点分析</span><small>消耗 1 积分</small>";
  }
}

async function loadBrands() {
  if (!state.sessionToken) return;
  try {
    setBusy(true);
    const [brandResult, historyResult, productImageResult] = await Promise.all([
      request("/api/brands"),
      request("/api/history"),
      request("/api/product-images"),
    ]);
    state.brands = brandResult.brands;
    state.generationHistory = historyResult.generations;
    state.productImageLibrary = productImageResult.images || [];
    if (state.brands.length) {
      if (!state.brands.some((brand) => brand.id === state.selectedBrandId)) {
        state.selectedBrandId = state.brands[0].id;
      }
      const currentBrand = getSelectedBrand();
      if (!getTrendBucketsForBrand(currentBrand).some((bucket) => bucket.key === state.selectedTrendMode)) {
        state.selectedTrendMode = firstTrendBucket(currentBrand)?.key ?? DEFAULT_TREND_MODE;
      }
      state.selectedTrendId = getCurrentTrendBucket(currentBrand)?.items?.[0]?.id ?? null;
    } else {
      state.selectedBrandId = null;
      state.selectedTrendId = null;
    }
    renderAll();
  } catch (error) {
    alert(`加载失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function replaceBrand(nextBrand) {
  state.brands = state.brands.map((brand) => (brand.id === nextBrand.id ? nextBrand : brand));
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
      ? `当前品牌有 ${generationCount} 条历史生成记录；勾选后会同步删除对应数据库记录和本地生成图片文件。`
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
      trends: brand.trends.map((bucket) => ({
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
  return getTrendBucketsForBrand(brand)[0] || null;
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

  state.brands = state.brands.map((item) => {
    if (item.id !== brand.id) return item;
    return {
      ...item,
      trends: analysis.trendSnapshot.map(cloneTrendBucket),
    };
  });

  state.selectedTrendMode = firstTrendBucket(getSelectedBrand())?.key ?? DEFAULT_TREND_MODE;
  state.selectedTrendId = firstTrendBucket(getSelectedBrand())?.items?.[0]?.id ?? null;
  renderAll();
  switchTab("trends");
}

function switchPage(page) {
  state.currentPage = page;
  document.querySelectorAll(".page").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.page === page);
  });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll(".sidebar-item").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.tabPanel === tab);
  });
}

function renderUser() {
  const userName = document.getElementById("userName");
  const userPhone = document.getElementById("userPhone");
  const userAvatar = document.getElementById("userAvatar");

  if (!state.currentUser) {
    userName.textContent = "未登录";
    userPhone.textContent = "请先登录账号";
    userAvatar.textContent = "R";
    return;
  }

  userName.textContent = state.currentUser.name;
  const credits = Number(state.currentUser.credits ?? 0);
  userPhone.innerHTML = `${escapeHtml(state.currentUser.phone)}<br><span class="credit-pill">${credits} 积分</span>`;
  userAvatar.textContent = state.currentUser.name.slice(0, 1).toUpperCase();
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

function renderAll() {
  renderBrands();
  renderBrandChips();
  renderTrendModeTabs();
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
            <button class="secondary-btn" data-brand-action="ideas" data-brand-id="${brand.id}" type="button">查看内容选题</button>
            <button class="secondary-btn" data-brand-edit="${brand.id}" type="button">编辑</button>
            <button class="secondary-btn danger-btn" data-brand-delete="${brand.id}" type="button">删除</button>
          </div>
        </article>
      `,
    )
    .join("");

  root.onclick = (event) => {
    const editButton = event.target.closest("[data-brand-edit]");
    if (editButton && root.contains(editButton)) {
      const brand = state.brands.find((item) => item.id === Number(editButton.dataset.brandEdit));
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
    state.selectedTrendMode = firstTrendBucket(getSelectedBrand())?.key ?? DEFAULT_TREND_MODE;
    state.selectedTrendId = firstTrendBucket(getSelectedBrand())?.items?.[0]?.id ?? null;
    switchTab(nextTab);
    renderAll();
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
      state.selectedTrendMode = firstTrendBucket(getSelectedBrand())?.key ?? DEFAULT_TREND_MODE;
      state.selectedTrendId = firstTrendBucket(getSelectedBrand())?.items?.[0]?.id ?? null;
      renderAll();
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
          <button class="text-btn" data-analysis-view="${item.id}" type="button">查看</button>
        </div>
      `,
    )
    .join("");

  root.querySelectorAll("[data-analysis-view]").forEach((button) => {
    button.addEventListener("click", () => {
      restoreAnalysisSnapshot(Number(button.dataset.analysisView));
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

  if (!brand.trends.length) {
    root.textContent = `已为 ${brand.name} 建立品牌档案。下一步点击左侧按钮，基于品牌资产、产品卖点、目标受众和运营目标生成热点趋势。`;
    return;
  }

  root.textContent = `${brand.name} 的热点趋势分析已就绪。当前已拆成多个可借势维度，每一种都会给出前 10 个热点，帮助你从不同层级判断该怎么蹭热点。`;
}

function renderTrends() {
  const root = document.getElementById("trendList");
  const brand = getSelectedBrand();
  const bucket = getCurrentTrendBucket(brand);

  if (!brand || !bucket || !bucket.items?.length) {
    root.innerHTML = "";
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
      const ideaIndex = Number(input.dataset.styleReferenceImage);
      const file = input.files?.[0];
      if (!file) return;
      if (!validateSingleReferenceFile(file, "风格参考图")) {
        input.value = "";
        return;
      }
      try {
        state.styleReferences[getIdeaProductKey(ideaIndex)] = {
          fileName: file.name,
          dataUrl: await fileToDataUrl(file),
          sizeBytes: file.size,
        };
        renderIdeas();
      } catch (error) {
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
  const result = await request("/api/history");
  state.generationHistory = result.generations;
  renderGenerationHistory();
}

async function deleteGenerationHistoryItem(generationId) {
  const item = state.generationHistory.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  if (!confirm(`确定删除「${item.cardTitle || item.ideaTitle || "这条生成内容"}」吗？相关本地图片文件也会一起删除。`)) return;
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

  if (!state.generationHistory.length) {
    root.innerHTML = `<article class="brand-card"><div class="brand-description">你还没有任何生成记录。去内容选题页生成朋友圈图、公众号长图或小红书组图后，这里会自动沉淀下来。</div></article>`;
    return;
  }

  root.innerHTML = state.generationHistory
    .map((item) => {
      const payload = item.payload || {};
      const editHistory = Array.isArray(payload.editHistory) ? payload.editHistory : [];
      let contentHtml = "";

      if (item.type === "moments") {
        contentHtml = `
          <div class="history-generate-copy"><strong>朋友圈文案：</strong>${escapeHtml(payload.caption || "")}</div>
          <div class="history-generate-copy"><strong>视觉方向：</strong>${escapeHtml(payload.visualDirection || "")}</div>
        `;
      } else if (item.type === "wechat") {
        contentHtml = `
          <div class="history-generate-copy"><strong>发布标题：</strong>${escapeHtml(payload.publishTitle || "")}</div>
          <div class="history-generate-copy"><strong>文章导语：</strong>${escapeHtml(payload.intro || "")}</div>
        `;
      } else if (item.type === "styleImage") {
        contentHtml = `
          <div class="history-generate-copy"><strong>风格化提示词：</strong>${escapeHtml(payload.stylePrompt || payload.prompt || "")}</div>
          <div class="history-generate-copy"><strong>用途：</strong>公众号封面、节日祝福海报或运营视觉</div>
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
                .map((slide) => `<img src="${authenticatedImageSrc(slide.previewUrl)}" alt="${escapeHtml(slide.title)}" />`)
                .join("")}
            </div>
          `
          : item.previewUrl
            ? `<div class="history-generate-preview"><img src="${authenticatedImageSrc(item.previewUrl)}" alt="${escapeHtml(item.cardTitle)}" /></div>`
            : "";

      return `
        <article class="history-generate-card">
          <div class="history-generate-top">
            <div>
              <div class="history-generate-meta">
                <span class="brand-tag">${escapeHtml(item.channelLabel)}</span>
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
}

function getGenerationPrimaryImageUrl(item) {
  if (item?.previewUrl) return item.previewUrl;
  const slides = Array.isArray(item?.payload?.slides) ? item.payload.slides : [];
  return slides.find((slide) => safeImageSrc(slide.imageUrl || slide.previewUrl))?.imageUrl || slides[0]?.previewUrl || "";
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
    </div>
    <div class="asset-grid">
      <div class="image-preview-card">
        <img src="${authenticatedImageSrc(imageUrl)}" alt="${escapeHtml(item.cardTitle || "历史图片")}" />
      </div>
      <div class="image-meta-card">
        <h3>原图改图</h3>
        <div class="image-meta-item">
          <span>原始 Prompt</span>
          <div class="image-prompt">${escapeHtml(payload.prompt || payload.stylePrompt || payload.visualDirection || payload.caption || "")}</div>
        </div>
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
  const safeIndex = Math.min(Math.max(Number(selectedSlideIndex) || 0, 0), Math.max(slides.length - 1, 0));
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
    </div>
    <div class="history-carousel-picker">
      ${slides
        .map((slide, index) => {
          const url = slide.imageUrl || slide.previewUrl;
          return `
            <button class="history-carousel-thumb ${index === safeIndex ? "is-active" : ""}" data-history-slide-index="${index}" type="button">
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
        <div class="image-meta-item">
          <span>原始 Prompt</span>
          <div class="image-prompt">${escapeHtml(selectedSlide.prompt || payload.prompt || payload.publishCaption || "")}</div>
        </div>
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
                <div class="image-meta-item">
                  <span>改图提示词</span>
                  <div class="image-prompt">${escapeHtml(entry.prompt || "")}</div>
                </div>
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
          await loadGenerationHistory();
          openHistoryGeneration(Number(form.dataset.editGenerationId), Number(form.dataset.editSlideIndex || 0));
        }
      } catch (error) {
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
    await loadGenerationHistory();
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
          <div class="image-meta-item">
            <span>生图 Prompt</span>
            <div class="image-prompt">${escapeHtml(imageConcept.prompt)}</div>
          </div>
          <div class="image-meta-item">
            <span>模型</span>
            <div>${escapeHtml(imageConcept.model || "未返回")}</div>
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
    description: "输出适合公众号场景的发布标题、导语、结构和长图视觉 prompt。",
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
    await loadGenerationHistory();
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
          <div class="image-meta-item">
            <span>长图生图 Prompt</span>
            <div class="image-prompt">${escapeHtml(pack.prompt)}</div>
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
    style: slide.style || "xiaohongshu carousel cover page",
    composition: slide.composition || `小红书组图${index + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性。`,
    prompt: slide.prompt || "",
    isGenerating: false,
    error: "",
  }));
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

function buildLocalXhsCarouselPack(brand, trend, idea) {
  const title = idea?.title || "小红书组图";
  const trendTitle = trend?.title || "热点趋势";
  const brandName = brand?.name || "品牌";
  const audience = idea?.audience || brand?.audience || "目标用户";
  const brandFit = idea?.brandFit || brand?.knowledgeBase || "品牌价值";
  const slideCopies = [
    `先把“${trendTitle}”转成一个用户会想点开的真实问题，让封面有明确点击理由。`,
    `继续展开${audience}在这个议题里的具体感受、困扰或期待，少讲概念，多讲生活细节。`,
    `根据选题选择方法、对比、清单、测评或场景故事，把${brandFit}讲得具体可感。`,
    `用一个收藏理由、总结观点或轻互动收口，让用户觉得这组图值得保存或转发。`,
  ];
  const slides = [
    {
      pageLabel: "第 1 张",
      title: `${trendTitle}为什么和你有关`,
      visualDirection: `${title}的小红书封面开场`,
      style: "natural lifestyle social post",
      composition: "封面页要有明确钩子和真实生活氛围，标题短而清楚，主体自然入镜，避免广告海报感。",
      copy: slideCopies[0],
      prompt: `生成一套适合小红书发布的 4 页组图中的第1页，围绕“${title}”，结合热点“${trendTitle}”和品牌${brandName}。第1页需要像真实小红书笔记封面，有明确点击理由和强钩子，但不要像广告海报或品牌PPT。可以用问题、反差、情绪共鸣、避坑提醒、清单标题或趋势判断来组织封面。画面要适合滑动阅读的开场，文字短、层级清楚，品牌露出自然，不要促销感。`,
    },
    {
      pageLabel: "第 2 张",
      title: "先把场景说具体",
      visualDirection: `${audience}的真实场景展开`,
      style: "clean xiaohongshu editorial layout",
      composition: "第二页承接封面，画面更偏场景、痛点或步骤拆解，信息分区清晰，文字不要堆满。",
      copy: slideCopies[1],
      prompt: `生成小红书 4 页组图中的第2页，承接第1页继续展开“${title}”。这一页不要固定成某一种模板，可以根据选题选择用户场景、痛点拆解、误区提醒、前后对比、步骤教程、测评观察或故事化表达。重点是让${audience}看到自己的真实生活、消费判断或情绪状态，画面有代入感，文字简洁，信息不要堆满。`,
    },
    {
      pageLabel: "第 3 张",
      title: "把方法讲到具体处",
      visualDirection: `${brandName}与选题价值的自然结合`,
      style: "warm practical content card",
      composition: "第三页突出方法、清单、对比或细节放大，品牌出现要服务内容，不要硬广。",
      copy: slideCopies[2],
      prompt: `生成小红书 4 页组图中的第3页，继续展开具体价值。不要固定成品牌解决方案页，可以根据内容选择方法清单、细节放大、对比说明、体验测评、趋势解读或案例化表达。需要自然体现${brandName}与选题的关系，重点表现${brandFit}，但不要硬广，不要把画面做成促销海报。`,
    },
    {
      pageLabel: "第 4 张",
      title: "最后给你一个总结",
      visualDirection: "适合收藏和互动的组图收尾",
      style: "cohesive xiaohongshu closing page",
      composition: "最后一页与前三页风格统一，用总结、收藏清单或轻互动收口，留白充足。",
      copy: slideCopies[3],
      prompt: `生成小红书 4 页组图中的第4页，作为整组内容的自然收尾。可以做收藏清单、总结观点、行动建议、轻互动提问、品牌落点或下一步建议，但不要固定成强CTA。画面要和前3页风格统一，适合用户保存、评论或转发；文字短、有重点，品牌${brandName}自然露出，避免广告感和复杂排版。`,
    },
  ];
  return {
    title: `${title}｜小红书组图方案`,
    publishTitle: `${title}：适合${brandName}的一套组图结构`,
    publishCaption: `这套组图适合用来讲“${title}”：封面先给进入理由，中间把场景和价值讲具体，最后给用户一个保存、评论或继续了解的理由。`,
    caption: `围绕“${trendTitle}”，这套组图把热点转成更真实的小红书连续图文，让${brandName}自然进入用户关心的语境。`,
    slides,
  };
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
                  <label class="image-meta-item">
                    <span>生图 Prompt</span>
                    <textarea class="carousel-prompt-input" data-carousel-prompt="${index}" rows="6">${escapeHtml(slide.prompt)}</textarea>
                  </label>
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
    description: "先检查并编辑每张图的生图 Prompt，再选择单张或一键生成四张图。",
    loadingTitle: "正在准备小红书组图方案...",
    loadingCopy: "正在整理 4 张组图页面的视觉方向、风格、构图建议和 Prompt。",
  });

  try {
    const idea = trend.ideas?.[ideaIndex];
    if (!idea) throw new Error("当前选题不存在，请重新生成或刷新页面后再试。");
    const previewPack = buildLocalXhsCarouselPack(brand, trend, idea);
    const pack = {
      ...previewPack,
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
      if (!String(slide.prompt || "").trim()) {
        slide.error = "请先填写当前页的生图 Prompt。";
        renderAndBind();
        return;
      }
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
          model: imageConcept.model,
          isGenerating: false,
          isQueued: false,
          error: "",
        };
      } catch (error) {
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
          model: imageConcept.model,
          isEditing: false,
          editQueued: false,
          editPrompt: "",
          error: "",
        };
      } catch (error) {
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
    await loadGenerationHistory();
    removePendingImageTask(pendingTaskId);
    const generatedImageUrl = imageConcept.imageUrl || imageConcept.previewUrl;
    imageResult.innerHTML = `
      <div class="asset-header-card">
        <h3>${escapeHtml(imageConcept.title || "风格化图片")}</h3>
        <p><strong>提示词：</strong>${escapeHtml(imageConcept.stylePrompt || stylePrompt)}</p>
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
          <div class="image-meta-item">
            <span>生图 Prompt</span>
            <div class="image-prompt">${escapeHtml(imageConcept.prompt || stylePrompt)}</div>
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
    if (pendingTaskId) removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `<div class="image-meta-card"><h3>生成失败</h3><div class="idea-copy">${escapeHtml(error.message)}</div></div>`;
  }
}

init();
