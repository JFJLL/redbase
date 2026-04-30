export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeImageSrc(value) {
  const src = String(value || "");
  if (src.startsWith("data:image/") || src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/")) {
    return src;
  }
  return "";
}

export function authenticatedImageSrc(value) {
  return safeImageSrc(value);
}

export function productImageSrc(image) {
  return authenticatedImageSrc(image?.url);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

export function formatImageName(name, maxLength = 32) {
  const text = String(name || "产品图");
  if (text.length <= maxLength) return text;
  const extMatch = text.match(/(\.[a-z0-9]{2,5})$/i);
  const ext = extMatch?.[1] || "";
  const headLength = Math.max(10, maxLength - ext.length - 10);
  return `${text.slice(0, headLength)}...${text.slice(-6 - ext.length)}`;
}

export function showToast(message) {
  let toast = document.getElementById("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  textToast(toast, message);
}

function textToast(toast, message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

