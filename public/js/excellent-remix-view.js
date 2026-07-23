/**
 * Pure HTML builders for excellent remix modal.
 * Callers must pass escapeHtml / authenticatedImageSrc / safeImageSrc / formatCompactMetric.
 */

import {
  REMIX_CONTENT_MODES,
  MAX_REMIX_PRODUCT_IMAGES,
  MAX_CUSTOM_DIRECTION_CHARS,
  MIN_CUSTOM_DIRECTION_CHARS,
  filterExistingIdeas,
  canGenerateFusionPlan,
  resolveAssetFlags,
  buildExistingIdeaKey,
  isPlatformDefaultVisual,
} from "./excellent-remix-state.js";

function boardLabel(board) {
  return board === "ecommerce_hot" ? "电商热门" : "小红书热门";
}

export function renderAnalysisStatusHtml(state, { escapeHtml }) {
  if (state.analysisStatus === "loading") {
    return `<div class="excellent-remix-status is-loading">正在分析参考笔记的方法…</div>`;
  }
  if (state.analysisStatus === "ready" && state.analysis?.analysisMode === "multimodal") {
    return `<div class="excellent-remix-status is-ready">已完成参考方法分析（含图片理解）</div>`;
  }
  if (state.analysisStatus === "ready" || state.analysisStatus === "degraded") {
    return `<div class="excellent-remix-status is-degraded">当前使用基础信息分析，未进行完整图片理解。</div>`;
  }
  if (state.analysisStatus === "error") {
    return `<div class="excellent-remix-status is-error">参考方法分析暂时不可用，将使用基础信息继续。${
      state.analysisError ? `<span>${escapeHtml(state.analysisError)}</span>` : ""
    }</div>`;
  }
  return `<div class="excellent-remix-status">打开后将按需分析参考方法</div>`;
}

export function renderReferenceCardHtml(item, state, helpers) {
  const { escapeHtml, safeImageSrc, formatCompactMetric } = helpers;
  const cover = safeImageSrc(item?.primaryCoverUrl || item?.imageUrls?.[0] || "");
  return `
    <section class="excellent-remix-section">
      <h3>1. 参考笔记</h3>
      <div class="excellent-remix-template">
        ${cover ? `<img src="${cover}" alt="" referrerpolicy="no-referrer" />` : `<div class="excellent-cover-fallback">暂无封面</div>`}
        <div>
          <span>${escapeHtml(boardLabel(state.board))}</span>
          <strong>${escapeHtml(item?.title || "优秀内容")}</strong>
          <p>${escapeHtml(item?.author?.nickname || "未知作者")} · 阅读 ${formatCompactMetric(item?.metrics?.readCount)} · ${Number(item?.imageCount || item?.imageUrls?.length || 0)} 图</p>
          ${renderAnalysisStatusHtml(state, helpers)}
        </div>
      </div>
    </section>
  `;
}

export function renderBrandSummaryHtml(brand, state, helpers) {
  const { escapeHtml } = helpers;
  if (!brand) return "";
  const product = String(brand.product || brand.description || "").split(/[。；\n]/)[0].slice(0, 80);
  return `
    <div class="excellent-remix-summary-card">
      <div><span>品牌</span><strong>${escapeHtml(brand.name || "")}</strong></div>
      <div><span>产品</span><p>${escapeHtml(product || "未填写")}</p></div>
      <div><span>人群</span><p>${escapeHtml(brand.audience || "未填写")}</p></div>
      <div><span>调性/目标</span><p>${escapeHtml(String(brand.goal || brand.description || "").slice(0, 100) || "未填写")}</p></div>
    </div>
  `;
}

function canRequestSmartDirections(state) {
  if (!state?.brandId || state.loadingBrand) return false;
  const settled =
    state.analysisStatus === "ready" ||
    state.analysisStatus === "degraded" ||
    state.analysisStatus === "error";
  return settled && state.directionsStatus !== "loading";
}

export function renderSmartDirectionsHtml(state, helpers) {
  const { escapeHtml } = helpers;
  const directions = state.smartDirections || [];
  const canGenerate = canRequestSmartDirections(state);
  const generateLabel = directions.length ? "重新生成内容方向" : "生成内容方向";
  const actionBlock = `
    <div class="excellent-smart-actions">
      <button type="button" class="secondary-btn small-btn" data-remix-generate-directions ${
        canGenerate ? "" : "disabled"
      }>${generateLabel}</button>
      ${
        !state.brandId
          ? `<p class="excellent-remix-hint">请先选择品牌，再生成内容方向。</p>`
          : state.loadingBrand
            ? `<p class="excellent-remix-hint">品牌详情加载中，请稍候。</p>`
            : state.analysisStatus === "loading" || state.analysisStatus === "idle"
              ? `<p class="excellent-remix-hint">请等待参考分析完成后再生成内容方向。</p>`
              : `<p class="excellent-remix-hint">根据参考笔记方法与品牌信息，手动生成 3 个内容方向。</p>`
      }
    </div>
  `;
  if (state.directionsStatus === "loading") {
    return `<div class="excellent-remix-status is-loading">正在生成 3 个内容方向…</div>`;
  }
  if (state.directionsError) {
    return `
      <div class="excellent-remix-status is-error">${escapeHtml(state.directionsError)}。可重试，或切换“使用已有选题”“自己描述内容”。</div>
      ${actionBlock}
    `;
  }
  if (!directions.length) {
    return `
      <div class="excellent-remix-status">尚未生成内容方向，点击下方按钮开始。</div>
      ${actionBlock}
    `;
  }
  return `
    <div class="excellent-direction-grid">
      ${directions
        .map(
          (item) => `
        <label class="excellent-direction-card ${state.selectedSmartDirectionId === item.id ? "is-selected" : ""}">
          <input type="radio" name="remix-smart-direction" data-remix-smart-direction="${escapeHtml(item.id)}" ${
            state.selectedSmartDirectionId === item.id ? "checked" : ""
          } />
          <div>
            <strong>${escapeHtml(item.title || item.transferMode)}</strong>
            <p>${escapeHtml(item.oneSentence || item.contentThesis || "")}</p>
            <span class="excellent-direction-meta">${escapeHtml(item.transferMode)}</span>
          </div>
        </label>
      `,
        )
        .join("")}
    </div>
    ${actionBlock}
  `;
}

export function renderExistingIdeasHtml(state, helpers) {
  const { escapeHtml } = helpers;
  const ideas = filterExistingIdeas(state.existingIdeas, state.existingIdeaQuery);
  if (!state.existingIdeas?.length) {
    return `<div class="excellent-remix-status">当前品牌还没有已生成选题。可改用智能方向或自己描述。</div>`;
  }
  const selectedKey = state.selectedExistingIdea ? buildExistingIdeaKey(state.selectedExistingIdea) : "";
  return `
    <input class="excellent-remix-search" data-remix-idea-query type="search" placeholder="搜索选题标题/摘要/人群/历史分析" value="${escapeHtml(
      state.existingIdeaQuery || "",
    )}" />
    <div class="excellent-idea-list" role="listbox" aria-label="已有选题列表">
      ${ideas
        .map((idea) => {
          const key = buildExistingIdeaKey(idea);
          const selected = selectedKey && selectedKey === key;
          const scopeLabel =
            idea.scope === "snapshot"
              ? `历史分析：${idea.analysisName || "未命名分析"}${
                  idea.analysisTimestamp ? ` · ${String(idea.analysisTimestamp).slice(0, 16)}` : ""
                }`
              : "当前选题";
          return `
            <label class="excellent-idea-card ${selected ? "is-selected" : ""}">
              <input type="radio" name="remix-existing-idea" data-remix-existing-idea="${escapeHtml(key)}" ${
                selected ? "checked" : ""
              } />
              <div>
                <strong>${escapeHtml(idea.ideaTitle || "未命名选题")}</strong>
                <p>${escapeHtml(idea.ideaSummary || "")}</p>
                <span class="excellent-direction-meta">${escapeHtml(scopeLabel)}</span>
                <span class="excellent-direction-meta">来源趋势：${escapeHtml(idea.trendTitle || "—")}（仅说明）</span>
                <span class="excellent-direction-meta">人群：${escapeHtml(idea.audience || "—")} · 场景：${escapeHtml(
                  idea.scene || "—",
                )}</span>
              </div>
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

export function renderContentDirectionHtml(state, helpers) {
  const { escapeHtml } = helpers;
  const mode = state.contentDirectionMode || REMIX_CONTENT_MODES.SMART;
  return `
    <section class="excellent-remix-section">
      <h3>4. 这次要讲什么</h3>
      <div class="excellent-mode-tabs" role="tablist" aria-label="内容方向模式">
        ${[
          [REMIX_CONTENT_MODES.EXISTING_IDEA, "使用已有选题"],
          [REMIX_CONTENT_MODES.SMART, "智能生成内容方向"],
          [REMIX_CONTENT_MODES.CUSTOM, "自己描述内容"],
        ]
          .map(
            ([value, label]) => `
          <label class="excellent-mode-tab ${mode === value ? "is-active" : ""}">
            <input type="radio" name="remix-content-mode" data-remix-content-mode="${value}" ${
              mode === value ? "checked" : ""
            } />
            <span>${label}</span>
          </label>
        `,
          )
          .join("")}
      </div>
      <div class="excellent-mode-panel">
      ${
        mode === REMIX_CONTENT_MODES.SMART
          ? renderSmartDirectionsHtml(state, helpers)
          : mode === REMIX_CONTENT_MODES.EXISTING_IDEA
            ? renderExistingIdeasHtml(state, helpers)
            : `
          <textarea data-remix-custom-direction rows="4" maxlength="${MAX_CUSTOM_DIRECTION_CHARS}" placeholder="例如：想讲宝宝转奶期间容易出现的便便变化，目标是让妈妈理解产品温和好吸收的卖点。">${escapeHtml(
            state.customDirection || "",
          )}</textarea>
          <p class="excellent-remix-hint">${MIN_CUSTOM_DIRECTION_CHARS}-${MAX_CUSTOM_DIRECTION_CHARS} 字，先生成融合方案后再进入生图。</p>
        `
      }
      </div>
    </section>
  `;
}

export function renderFusionPlanHtml(state, brandReady, helpers) {
  const { escapeHtml } = helpers;
  const canBuild = canGenerateFusionPlan(state, brandReady);
  const plan = state.fusionPlan;
  const slides = plan?.carouselPack?.slides || [];
  return `
    <section class="excellent-remix-section excellent-remix-fusion">
      <div class="excellent-remix-section-head">
        <h3>5. 本次融合方案</h3>
        <button type="button" class="secondary-btn small-btn" data-remix-build-fusion ${canBuild ? "" : "disabled"}>
          ${state.fusionStatus === "ready" ? "重新生成融合方案" : "生成融合方案"}
        </button>
      </div>
      ${
        state.fusionStatus === "loading"
          ? `<div class="excellent-remix-status is-loading">正在生成融合方案…</div>`
          : ""
      }
      ${
        state.fusionStatus === "stale"
          ? `<div class="excellent-remix-status is-warn">输入已变化，请重新生成融合方案后再一键仿图文。</div>`
          : ""
      }
      ${
        state.fusionStatus === "error"
          ? `<div class="excellent-remix-status is-error">${escapeHtml(state.fusionError || "融合方案生成失败")}</div>`
          : ""
      }
      ${
        state.fusionStatus === "ready" && plan
          ? `
        <div class="excellent-fusion-card">
          <div><span>本次讲什么</span><p>${escapeHtml(plan.contentThesis || "")}</p></div>
          <div><span>目标人群</span><p>${escapeHtml(plan.targetAudience || "")}</p></div>
          <div><span>用户场景</span><p>${escapeHtml(plan.userScene || "")}</p></div>
          <div><span>参考笔记学什么</span><p>${escapeHtml(
            (plan.referenceLearningApplied || []).map((item) => `${item.type}：${item.description}`).join("；") ||
              plan.sourceRole ||
              "",
          )}</p></div>
          ${
            plan.platformVisualGuidance
              ? `<div><span>平台通用视觉建议</span><p>${escapeHtml(
                  plan.platformVisualGuidance.description || "",
                )}（未进行图片理解，不代表参考笔记真实视觉特征）</p></div>`
              : ""
          }
          <div><span>品牌如何进入</span><p>${escapeHtml(plan.brandIntegration || "")}</p></div>
          <div class="excellent-fusion-slides">
            <span>四页规划</span>
            <ol>
              ${slides
                .map(
                  (slide) => `
                <li>
                  <strong>${escapeHtml(slide.pageLabel || "")} · ${escapeHtml(slide.pageRole || slide.remixBrief?.pageRole || "")}</strong>
                  <em>${escapeHtml(slide.title || "")}</em>
                  <p>${escapeHtml(slide.contentGoal || slide.remixBrief?.contentGoal || "")}</p>
                  <p class="muted">${escapeHtml(slide.visualDirection || "")}</p>
                </li>
              `,
                )
                .join("")}
            </ol>
          </div>
        </div>
      `
          : `<p class="excellent-remix-hint">融合方案必须由服务端根据参考方法 × 内容方向 × 品牌生成，不再使用固定四页模板。</p>`
      }
    </section>
  `;
}

export function renderAssetsHtml(brand, state, helpers) {
  const { escapeHtml, authenticatedImageSrc } = helpers;
  const assets = resolveAssetFlags(state);
  const hasLogo = Boolean(brand?.logo);
  const selectedCount = assets.productImageIds.length;
  const logoActive = assets.useBrandLogo;
  const productActive = selectedCount > 0;
  return `
    <section class="excellent-remix-section">
      <h3>6. 素材使用方式（可选）</h3>
      <p class="excellent-remix-hint excellent-asset-intro">默认按品牌档案与产品描述原创生成。需要时可叠加品牌 Logo 与产品实拍图。</p>
      <div class="excellent-asset-unified">
        <div class="excellent-asset-block ${logoActive ? "is-selected" : ""}">
          <div class="excellent-asset-block-head">
            <strong>品牌 Logo</strong>
          </div>
          ${
            hasLogo
              ? `
            <div class="excellent-logo-row">
              <img class="excellent-logo-thumb" src="${authenticatedImageSrc(brand.logo.url)}" alt="品牌 Logo" />
              <label class="excellent-logo-check">
                <input type="checkbox" data-remix-logo ${logoActive ? "checked" : ""} />
                <span>使用品牌 Logo</span>
              </label>
            </div>
          `
              : `
            <p class="excellent-remix-hint">当前品牌未配置 Logo</p>
            <button type="button" class="secondary-btn small-btn" data-remix-go-brand>前往品牌档案上传</button>
          `
          }
        </div>
        <div class="excellent-asset-block ${productActive ? "is-selected" : ""}">
          <div class="excellent-asset-block-head">
            <strong>产品实拍图</strong>
            <span class="excellent-asset-count">已选 ${selectedCount} / ${MAX_REMIX_PRODUCT_IMAGES}</span>
          </div>
          <button type="button" class="secondary-btn small-btn" data-remix-open-product-picker ${
            state.brandId ? "" : "disabled"
          }>从当前品牌素材库选择</button>
          <p class="excellent-remix-hint">只展示当前品牌的产品素材；不显示历史生成图、其他品牌图与无归属图。</p>
        </div>
      </div>
    </section>
  `;
}

export function renderExcellentRemixBodyHtml({
  state,
  item,
  brand,
  brandReady,
  emptyStateHtml = "",
  helpers,
}) {
  if (emptyStateHtml) {
    return `
      ${renderReferenceCardHtml(item, state, helpers)}
      ${emptyStateHtml}
    `;
  }
  return `
    ${renderReferenceCardHtml(item, state, helpers)}
    <section class="excellent-remix-section">
      <h3>2. 选择品牌</h3>
      <label class="excellent-remix-brand-field">
        <span>品牌</span>
        <select class="excellent-remix-brand-select" data-remix-field="brand">
          ${(helpers.brands || [])
            .map(
              (entry) =>
                `<option value="${entry.id}" ${Number(entry.id) === Number(state.brandId) ? "selected" : ""}>${helpers.escapeHtml(
                  entry.name,
                )}</option>`,
            )
            .join("")}
        </select>
      </label>
      ${renderBrandSummaryHtml(brand, state, helpers)}
    </section>
    <section class="excellent-remix-section">
      <h3>3. 想重点学习什么</h3>
      <div class="excellent-check-row">
        ${(() => {
          const platformVisual = isPlatformDefaultVisual(state.analysis);
          const items = [
            ["structure", "信息结构", false],
            [
              "visual",
              platformVisual ? "平台通用视觉建议" : "视觉语言",
              platformVisual,
            ],
            ["hook", "封面钩子", false],
            ["conversion", "收藏转化", false],
          ];
          return items
            .map(
              ([value, label, isPlatformVisual]) => `
          <label class="${isPlatformVisual ? "is-platform-visual" : ""}">
            <input data-remix-focus="${value}" ${
              isPlatformVisual ? 'data-remix-allow-platform-visual="1"' : ""
            } type="checkbox" ${state.learningFocus?.includes(value) ? "checked" : ""} />
            <span>${label}</span>
          </label>
        `,
            )
            .join("");
        })()}
      </div>
      <p class="excellent-remix-hint">学习重点控制融合阶段真正使用哪些参考方法字段。${
        isPlatformDefaultVisual(state.analysis)
          ? "当前为 metadata_only：未进行图片理解，“平台通用视觉建议”不代表参考笔记真实配色/构图/字体。"
          : "学习重点控制融合阶段真正使用哪些参考方法字段，而不是只显示文字。"
      }</p>
    </section>
    ${renderContentDirectionHtml(state, helpers)}
    ${renderFusionPlanHtml(state, brandReady, helpers)}
    ${renderAssetsHtml(brand, state, helpers)}
    <div class="excellent-originality-note">只学习参考笔记的信息节奏、页面角色和内容方法；不会复制原文、原图人物、原品牌、原 Logo、水印或具体版式。参考笔记图片不会自动进入最终生图。</div>
  `;
}

function formatPickerBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function renderProductPickerCard(image, { selected, unassigned = false, escapeHtml, authenticatedImageSrc }) {
  const src = authenticatedImageSrc(image?.url);
  const name = image?.originalName || "产品图";
  const meta = [formatPickerBytes(image?.sizeBytes), String(image?.createdAt || "").slice(0, 16)]
    .filter(Boolean)
    .join(" · ");
  return `
    <label class="excellent-product-card ${selected ? "is-selected" : ""} ${unassigned ? "is-unassigned" : ""}">
      <input type="checkbox" data-remix-pick-product="${Number(image.id)}" ${
        unassigned ? 'data-remix-pick-unassigned="1"' : ""
      } ${selected ? "checked" : ""} />
      <div class="excellent-product-card-thumb">
        ${
          src
            ? `<img src="${src}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'excellent-product-card-fallback',textContent:'预览失败'}))" />`
            : `<div class="excellent-product-card-fallback">暂无预览</div>`
        }
        ${unassigned ? `<span class="excellent-product-card-badge">未归属</span>` : ""}
        ${selected ? `<span class="excellent-product-card-check" aria-hidden="true">✓</span>` : ""}
      </div>
      <div class="excellent-product-card-meta">
        <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
        <span>${escapeHtml(meta || "—")}</span>
        ${unassigned ? `<em>勾选后将加入当前品牌素材库</em>` : `<em>当前品牌产品素材</em>`}
      </div>
    </label>
  `;
}

export function renderBrandProductPickerHtml(state, helpers) {
  const { escapeHtml, authenticatedImageSrc } = helpers;
  const brandImages = state.brandProductImages || [];
  const unassignedImages = state.unassignedProductImages || [];
  const selected = new Set((state.productImageIds || []).map(Number));
  const uploadBlock = `
    <div class="excellent-product-upload-bar">
      <label class="primary-btn small-btn excellent-product-upload-btn">
        上传到当前品牌
        <input type="file" accept="image/*" data-remix-upload-brand-product hidden />
      </label>
      <p class="excellent-remix-hint">支持 PNG / JPG / WEBP / GIF。图片归属当前品牌后可直接勾选使用。</p>
    </div>
  `;
  if (state.brandProductImagesStatus === "loading") {
    return `${uploadBlock}<div class="excellent-remix-status is-loading">正在加载产品素材…</div>`;
  }
  if (state.brandProductImagesStatus === "error") {
    return `${uploadBlock}<div class="excellent-remix-status is-error">产品素材加载失败，请关闭后重试。</div>`;
  }

  const brandSection = brandImages.length
    ? `
      <div class="excellent-product-section">
        <div class="excellent-product-section-head">
          <strong>当前品牌素材</strong>
          <span>${brandImages.length} 张</span>
        </div>
        <div class="excellent-product-picker-grid">
          ${brandImages
            .map((image) =>
              renderProductPickerCard(image, {
                selected: selected.has(Number(image.id)),
                unassigned: false,
                escapeHtml,
                authenticatedImageSrc,
              }),
            )
            .join("")}
        </div>
      </div>
    `
    : `
      <div class="excellent-product-section">
        <div class="excellent-product-section-head">
          <strong>当前品牌素材</strong>
          <span>0 张</span>
        </div>
        <div class="excellent-remix-status">当前品牌还没有产品实拍图。可上传，或从下方未归属素材勾选加入。</div>
      </div>
    `;

  const unassignedSection = unassignedImages.length
    ? `
      <div class="excellent-product-section">
        <div class="excellent-product-section-head">
          <strong>未归属素材库</strong>
          <span>${unassignedImages.length} 张</span>
        </div>
        <p class="excellent-remix-hint">这些图尚未绑定品牌；勾选后会自动加入当前品牌，再用于仿图文。</p>
        <div class="excellent-product-picker-grid">
          ${unassignedImages
            .map((image) =>
              renderProductPickerCard(image, {
                selected: selected.has(Number(image.id)),
                unassigned: true,
                escapeHtml,
                authenticatedImageSrc,
              }),
            )
            .join("")}
        </div>
      </div>
    `
    : "";

  return `
    ${uploadBlock}
    ${brandSection}
    ${unassignedSection}
    <p class="excellent-remix-hint excellent-product-picker-footer-hint">最多选择 ${MAX_REMIX_PRODUCT_IMAGES} 张。已选 ${selected.size} 张。</p>
  `;
}
