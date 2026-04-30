const STORAGE_KEY = "redbase.sessionToken";
const SIDEBAR_COLLAPSED_KEY = "redbase.sidebarCollapsed";
const PENDING_IMAGE_TASKS_KEY = "redbase.pendingImageTasks";
const IMAGE_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
const IMAGE_JOB_POLL_INTERVAL_MS = 5000;
const MAX_SELECTED_PRODUCT_IMAGES = 10;
const MAX_SELECTED_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_SINGLE_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

const state = {
  currentPage: "landing",
  currentTab: "brands",
  brands: [],
  generationHistory: [],
  selectedBrandId: null,
  selectedTrendId: null,
  selectedTrendMode: "global",
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
  let pendingLogo = null;

  const open = () => modal.classList.add("is-open");
  const close = () => {
    modal.classList.remove("is-open");
  };

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  logoInput?.addEventListener("change", async () => {
    const file = logoInput.files?.[0];
    if (!file) {
      pendingLogo = null;
      if (logoPreview) logoPreview.textContent = "可选上传，后续生图时可作为产品 Logo 使用。";
      if (logoUploadText) logoUploadText.textContent = "选择 Logo 图片";
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
    if (pendingLogo) {
      payload.logoName = pendingLogo.name;
      payload.logoDataUrl = pendingLogo.dataUrl;
    }

    try {
      setBusy(true);
      const result = await request("/api/brands", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.brands.unshift(result.brand);
      state.selectedBrandId = result.brand.id;
      state.selectedTrendId = null;
      form.reset();
      pendingLogo = null;
      if (logoPreview) logoPreview.textContent = "可选上传，后续生图时可作为产品 Logo 使用。";
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
      state.selectedTrendMode = result.brand.trends[0]?.key ?? "global";
      state.selectedTrendId = result.brand.trends[0]?.items?.[0]?.id ?? null;
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
      if (!(currentBrand?.trends || []).some((bucket) => bucket.key === state.selectedTrendMode)) {
        state.selectedTrendMode = currentBrand?.trends?.[0]?.key ?? "global";
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

  state.selectedTrendMode = analysis.trendSnapshot[0]?.key ?? "global";
  state.selectedTrendId = analysis.trendSnapshot[0]?.items?.[0]?.id ?? null;
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
  for (const bucket of brand.trends || []) {
    const found = (bucket.items || []).find((item) => item.id === state.selectedTrendId);
    if (found) return found;
  }
  return getCurrentTrendBucket(brand)?.items?.[0] ?? null;
}

function getCurrentTrendBucket(brand = getSelectedBrand()) {
  if (!brand) return null;
  return (brand.trends || []).find((bucket) => bucket.key === state.selectedTrendMode) ?? brand.trends?.[0] ?? null;
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
          </div>
        </article>
      `,
    )
    .join("");

  root.onclick = (event) => {
    const button = event.target.closest("[data-brand-id]");
    if (!button || !root.contains(button)) return;

    const selectedBrandId = Number(button.dataset.brandId);
    const nextTab = button.dataset.brandAction || "brands";
    state.selectedBrandId = selectedBrandId;
    state.selectedTrendMode = getSelectedBrand().trends?.[0]?.key ?? "global";
    state.selectedTrendId = getSelectedBrand().trends?.[0]?.items?.[0]?.id ?? null;
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
      state.selectedTrendMode = getSelectedBrand().trends?.[0]?.key ?? "global";
      state.selectedTrendId = getSelectedBrand().trends?.[0]?.items?.[0]?.id ?? null;
      renderAll();
    });
  });
}

function renderTrendModeTabs() {
  const root = document.getElementById("trendModeTabs");
  if (!root) return;
  const brand = getSelectedBrand();
  const buckets = brand?.trends || [];
  root.innerHTML = buckets
    .map(
      (bucket) => `
        <button class="trend-mode-tab ${bucket.key === state.selectedTrendMode ? "is-active" : ""}" data-trend-mode="${escapeHtml(bucket.key)}" type="button">
          ${escapeHtml(bucket.title)}
        </button>
      `,
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

  root.textContent = `${brand.name} 的热点趋势分析已就绪。当前已拆成三种可借势方式：全网热点指数、品类热点指数、新闻热点趋势。每一种都会给出前 10 个热点，帮助你从不同层级判断该怎么蹭热点。`;
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
        <h3>${escapeHtml(bucket.title)}</h3>
        <p>${escapeHtml(bucket.description)}</p>
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
        <div class="idea-product-actions idea-product-actions-top">
          <label class="idea-product-check">
            <input data-use-product-image="${ideaIndex}" type="checkbox" ${selectedCount ? "" : "disabled"} ${checked ? "checked" : ""} />
            使用这些产品图生成图片
          </label>
          ${selectedCount ? `<button class="idea-product-clear" data-clear-product-image="${ideaIndex}" type="button">清除当前选择</button>` : ""}
        </div>
        <div class="idea-product-button-stack">
          <label class="idea-upload-button">
            <input data-product-image="${ideaIndex}" type="file" accept="image/*" multiple />
            <span>${selectedCount ? "继续上传" : "上传产品图"}</span>
          </label>
          <button class="idea-library-button" data-open-product-library="${ideaIndex}" type="button">选择已上传图片</button>
        </div>
      </div>
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
      ${selectedPreview}
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
            ${getGenerationPrimaryImageUrl(item) ? `<button class="secondary-btn small-btn" data-open-history-generation="${item.id}" type="button">查看 / 改图</button>` : ""}
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
}

function getGenerationPrimaryImageUrl(item) {
  if (item?.previewUrl) return item.previewUrl;
  const slides = Array.isArray(item?.payload?.slides) ? item.payload.slides : [];
  return slides.find((slide) => safeImageSrc(slide.imageUrl || slide.previewUrl))?.imageUrl || slides[0]?.previewUrl || "";
}

function openHistoryGeneration(generationId) {
  const item = state.generationHistory.find((generation) => Number(generation.id) === Number(generationId));
  if (!item) return;
  const payload = item.payload || {};
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

function renderImageEditPanel({ imageUrl, title, aspectRatio, generationId, parentEditId }) {
  const safeUrl = safeImageSrc(imageUrl);
  if (!safeUrl) return "";
  return `
    <form class="asset-edit-form" data-edit-image-url="${escapeHtml(safeUrl)}" data-edit-title="${escapeHtml(title || "改图结果")}" data-edit-aspect-ratio="${escapeHtml(aspectRatio || "")}" data-edit-generation-id="${escapeHtml(generationId || "")}" data-edit-parent-id="${escapeHtml(parentEditId || "")}">
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
          openHistoryGeneration(Number(form.dataset.editGenerationId));
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

async function generateXhsCarousel(ideaIndex) {
  const brand = getSelectedBrand();
  const trend = getSelectedTrend();
  if (!brand || !trend) return;
  let pendingTaskId = "";

  const imageResult = openAssetModal({
    kicker: "AI 小红书组图",
    title: "小红书组图内容包",
    description: "自动输出发布标题、发布文案和 4 张组图视觉方案。",
    loadingTitle: "AI 正在生成小红书组图包...",
    loadingCopy: "正在组织标题、文案结构和 4 张组图页面的视觉方案。",
  });

  try {
    const result = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/xhs-carousel`, {
      method: "POST",
      body: JSON.stringify({
        productImages: getSelectedProductImages(ideaIndex),
        useBrandLogo: isBrandLogoEnabled(ideaIndex),
      }),
    });
    updateCurrentUser(result.user);
    const pack = result.carouselPack;
    if (!Array.isArray(result.slideJobs) || !result.slideJobs.length) {
      throw new Error("小红书组图任务创建失败");
    }
    pendingTaskId = `xhs:${brand.id}:${trend.id}:${ideaIndex}:${result.creditEventId || Date.now()}`;
    addPendingImageTask({
      id: pendingTaskId,
      type: "xhsCarousel",
      brandId: brand.id,
      trendId: trend.id,
      ideaIndex,
      carouselPack: pack,
      slideJobs: result.slideJobs,
      creditEventId: result.creditEventId,
    });
    imageResult.innerHTML = `<div class="image-meta-card"><h3>AI 正在生成小红书组图...</h3><div class="idea-copy">已提交 ${result.slideJobs.length} 张组图的生图任务，正在等待外部生图服务返回结果。</div></div>`;
    const generatedSlides = [];
    for (const slideJob of result.slideJobs) {
      imageResult.innerHTML = `<div class="image-meta-card"><h3>AI 正在生成小红书组图...</h3><div class="idea-copy">正在生成第 ${slideJob.slideIndex + 1}/${result.slideJobs.length} 张，请稍等。</div></div>`;
      const imageConcept = await pollImageJob(slideJob.jobId);
      generatedSlides[slideJob.slideIndex] = {
        ...(pack.slides[slideJob.slideIndex] || {}),
        previewUrl: imageConcept.imageUrl || imageConcept.previewUrl,
        imageUrl: imageConcept.imageUrl || imageConcept.previewUrl,
        model: imageConcept.model,
      };
      updatePendingImageTask(pendingTaskId, { carouselPack: { ...pack, slides: generatedSlides } });
    }
    pack.slides = generatedSlides;
    const completeResult = await request(`/api/brands/${brand.id}/trends/${trend.id}/ideas/${ideaIndex}/xhs-carousel/complete`, {
      method: "POST",
      body: JSON.stringify({ carouselPack: pack, creditEventId: result.creditEventId }),
    });
    updateCurrentUser(completeResult.user);
    if (completeResult.generation) {
      state.generationHistory.unshift(completeResult.generation);
      renderGenerationHistory();
    }
    removePendingImageTask(pendingTaskId);
    imageResult.innerHTML = `
      <div class="asset-header-card">
        <h3>${escapeHtml(pack.title)}</h3>
        <p><strong>发布标题：</strong>${escapeHtml(pack.publishTitle)}</p>
        <p><strong>发布文案：</strong>${escapeHtml(pack.publishCaption)}</p>
        <p><strong>组图说明：</strong>${escapeHtml(pack.caption)}</p>
      </div>
      <div class="carousel-grid">
        ${pack.slides
          .map(
            (slide) => `
              <article class="carousel-slide-card">
                <img src="${authenticatedImageSrc(slide.previewUrl)}" alt="${escapeHtml(slide.title)}" />
                <h3>${escapeHtml(slide.pageLabel)} · ${escapeHtml(slide.title)}</h3>
                <p>${escapeHtml(slide.copy)}</p>
                <div class="image-meta-item">
                  <span>画面 Prompt</span>
                  <div class="image-prompt">${escapeHtml(slide.prompt)}</div>
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    `;
  } catch (error) {
    if (pendingTaskId) removePendingImageTask(pendingTaskId);
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
