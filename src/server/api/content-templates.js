const { normalizeChineseCopy } = require("../utils");
function buildMomentsGenerationPayload(job) {
  return {
    ...job.metadata,
    title: job.metadata.title || "朋友圈图方案",
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
    caption: job.metadata.caption || "",
  };
}

function buildGeneratedAssetPayload(job) {
  return {
    ...job.metadata,
    imageUrl: job.imageUrl || "",
    previewUrl: job.imageUrl || "",
    model: job.model,
    provider: job.provider,
  };
}

function getAssetPalette(brand) {
  return String(brand.industry || "").toLowerCase().includes("beauty") || String(brand.industry || "").includes("美")
    ? ["#f06b93", "#ffd7e2", "#8b4f76"]
    : ["#ef4c82", "#ffb25a", "#342a62"];
}

function normalizeXhsCarouselSlideForJob(input, fallback, slideIndex) {
  const source = input && typeof input === "object" ? input : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const pageLabel = String(source.pageLabel || base.pageLabel || `第 ${slideIndex + 1} 张`).slice(0, 24);
  const title = normalizeChineseCopy(String(source.title || base.title || pageLabel).slice(0, 120));
  const copy = normalizeChineseCopy(String(source.copy || base.copy || "").slice(0, 500));
  const visualDirection = normalizeChineseCopy(String(source.visualDirection || base.visualDirection || title).slice(0, 300));
  const style = String(source.style || base.style || "小红书组图封面页，清晰、真实、适合收藏").slice(0, 160);
  const composition = normalizeChineseCopy(
    String(
      source.composition ||
        base.composition ||
        `小红书组图${slideIndex + 1}/4，竖版3:4，标题清晰，画面有连续组图统一性`,
    ).slice(0, 500),
  );
  const prompt = normalizeChineseCopy(String(source.prompt || base.prompt || "").trim());
  return {
    ...base,
    ...source,
    pageLabel,
    title,
    copy,
    visualDirection,
    style,
    composition,
    prompt,
  };
}

function buildSvgPreview({ brandName, title, subtitle, palette }) {
  const safeTitle = String(title || "");
  const line1 = safeTitle.slice(0, 14);
  const line2 = safeTitle.slice(14, 28);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="840" height="1120" viewBox="0 0 840 1120">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette[0]}"/>
          <stop offset="55%" stop-color="${palette[2]}"/>
          <stop offset="100%" stop-color="#17162a"/>
        </linearGradient>
      </defs>
      <rect width="840" height="1120" rx="48" fill="url(#bg)"/>
      <circle cx="640" cy="220" r="160" fill="${palette[1]}" fill-opacity="0.16"/>
      <circle cx="220" cy="860" r="210" fill="${palette[1]}" fill-opacity="0.1"/>
      <rect x="72" y="74" width="180" height="58" rx="29" fill="rgba(255,255,255,0.12)"/>
      <text x="102" y="113" font-size="28" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(brandName)}</text>
      <text x="72" y="250" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line1)}</text>
      <text x="72" y="328" font-size="68" font-weight="700" fill="#fff7fb" font-family="Arial, sans-serif">${escapeXml(line2)}</text>
      <text x="72" y="430" font-size="34" fill="${palette[1]}" font-family="Arial, sans-serif">${escapeXml(subtitle)}</text>
      <rect x="72" y="886" width="696" height="160" rx="36" fill="rgba(11,11,21,0.28)" stroke="rgba(255,255,255,0.1)"/>
      <text x="110" y="955" font-size="34" fill="#fff7fb" font-family="Arial, sans-serif">内容资产预览图</text>
      <text x="110" y="1008" font-size="28" fill="#ddd4ea" font-family="Arial, sans-serif">品牌资产 × 热点趋势 × 视觉表达</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
module.exports = {
  buildMomentsGenerationPayload,
  buildGeneratedAssetPayload,
  getAssetPalette,
  normalizeXhsCarouselSlideForJob,
  buildSvgPreview,
  escapeXml,
};
