/**
 * Pure HTML builders for excellent remix modal.
 * Callers must pass escapeHtml / authenticatedImageSrc / safeImageSrc / formatCompactMetric.
 */

import {
  REMIX_CONTENT_MODES,
  REMIX_ASSET_MODES,
  MAX_REMIX_PRODUCT_IMAGES,
  MAX_CUSTOM_DIRECTION_CHARS,
  MIN_CUSTOM_DIRECTION_CHARS,
  filterExistingIdeas,
  getSelectedSmartDirection,
  canGenerateFusionPlan,
  canSubmitExcellentRemix,
  resolveAssetFlags,
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

export function renderSmartDirectionsHtml(state, helpers) {
  const { escapeHtml } = helpers;
  if (state.directionsStatus === "loading") {
    return `<div class="excellent-remix-status is-loading">正在生成 3 个内容方向…</div>`;
  }
  if (state.directionsError) {
    return `<div class="excellent-remix-status is-error">${escapeHtml(state.directionsError)}。可切换“使用已有选题”或“自己描述内容”。</div>`;
  }
  const directions = state.smartDirections || [];
  if (!directions.length) {
    return `<div class="excellent-remix-status">选择品牌后将生成内容方向</div>`;
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
  `;
}

export function renderExistingIdeasHtml(state, helpers) {
  const { escapeHtml } = helpers;
  const ideas = filterExistingIdeas(state.existingIdeas, state.existingIdeaQuery);
  if (!state.existingIdeas?.length) {
    return `<div class="excellent-remix-status">当前品牌还没有已生成选题。可改用智能方向或自己描述。</div>`;
  }
  return `
    <input class="excellent-remix-search" data-remix-idea-query type="search" placeholder="搜索选题标题/摘要/人群" value="${escapeHtml(
      state.existingIdeaQuery || "",
    )}" />
    <div class="excellent-idea-list">
      ${ideas
        .map((idea) => {
          const selected =
            state.selectedExistingIdea &&
            Number(state.selectedExistingIdea.trendId) === Number(idea.trendId) &&
            Number(state.selectedExistingIdea.ideaIndex) === Number(idea.ideaIndex);
          return `
            <label class="excellent-idea-card ${selected ? "is-selected" : ""}">
              <input type="radio" name="remix-existing-idea" data-remix-existing-idea="${Number(idea.trendId)}:${Number(
                idea.ideaIndex,
              )}" ${selected ? "checked" : ""} />
              <div>
                <strong>${escapeHtml(idea.ideaTitle || "未命名选题")}</strong>
                <p>${escapeHtml(idea.ideaSummary || "")}</p>
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
      <div class="excellent-mode-tabs">
        ${[
          [REMIX_CONTENT_MODES.SMART, "智能生成内容方向"],
          [REMIX_CONTENT_MODES.EXISTING_IDEA, "使用已有选题"],
          [REMIX_CONTENT_MODES.CUSTOM, "自己描述内容"],
        ]
          .map(
            ([value, label]) => `
          <label class="${mode === value ? "is-active" : ""}">
            <input type="radio" name="remix-content-mode" data-remix-content-mode="${value}" ${
              mode === value ? "checked" : ""
            } />
            <span>${label}</span>
          </label>
        `,
          )
          .join("")}
      </div>
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
    </section>
  `;
}

export function renderTrendSectionHtml(state, helpers) {
  const { escapeHtml } = helpers;
  return `
    <section class="excellent-remix-section">
      <h3>5. 趋势语境增强（可选）</h3>
      <label class="excellent-toggle-row">
        <input type="checkbox" data-remix-trend-toggle ${state.useTrendContext ? "checked" : ""} />
        <span>增加趋势语境（默认关闭；趋势不得改写内容主体）</span>
      </label>
      ${
        state.useTrendContext
          ? `
        <div class="excellent-trend-recs">
          ${
            state.trendRecommendations?.length
              ? state.trendRecommendations
                  .map(
                    (item) => `
              <label class="excellent-trend-card ${Number(state.selectedTrendId) === Number(item.trendId) ? "is-selected" : ""}">
                <input type="radio" name="remix-trend" data-remix-trend-id="${Number(item.trendId)}" ${
                  Number(state.selectedTrendId) === Number(item.trendId) ? "checked" : ""
                } />
                <div>
                  <strong>${escapeHtml(item.title || "")}</strong>
                  <p>${escapeHtml(item.summary || "")}</p>
                  <span class="excellent-direction-meta">相关度 ${Number(item.relevanceScore || 0).toFixed(2)} · ${escapeHtml(
                    item.matchReason || "",
                  )}</span>
                </div>
              </label>
            `,
                  )
                  .join("")
              : `<div class="excellent-remix-status">${escapeHtml(
                  state.trendRecommendMessage || "当前没有适合自然结合的趋势，建议不关联趋势。",
                )}</div>`
          }
        </div>
      `
          : `<p class="excellent-remix-hint">关闭时不会向融合方案传入任何趋势；已有选题的父级趋势也不会自动使用。</p>`
      }
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
        <h3>6. 本次融合方案</h3>
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
          <div><span>品牌如何进入</span><p>${escapeHtml(plan.brandIntegration || "")}</p></div>
          <div><span>趋势语境</span><p>${
            plan.trendUsed
              ? escapeHtml(`已使用：${plan.trendTitle || ""}。${plan.trendRole || ""}`)
              : escapeHtml(plan.trendRole || "未使用趋势")
          }</p></div>
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
  const mode = state.assetMode || REMIX_ASSET_MODES.NONE;
  return `
    <section class="excellent-remix-section ${state.sections?.assetsCollapsed ? "is-collapsed" : ""}">
      <div class="excellent-remix-section-head">
        <h3>7. 素材使用方式（可选）</h3>
        <button type="button" class="ghost-btn small-btn" data-remix-toggle-assets>${
          state.sections?.assetsCollapsed ? "展开" : "收起"
        }</button>
      </div>
      <div class="excellent-asset-modes" ${state.sections?.assetsCollapsed ? "hidden" : ""}>
        <label class="excellent-asset-mode ${mode === REMIX_ASSET_MODES.NONE ? "is-selected" : ""}">
          <input type="radio" name="remix-asset-mode" data-remix-asset-mode="${REMIX_ASSET_MODES.NONE}" ${
            mode === REMIX_ASSET_MODES.NONE ? "checked" : ""
          } />
          <div>
            <strong>不使用上传素材</strong>
            <p>根据品牌档案与产品描述原创生成（默认）</p>
          </div>
        </label>
        <div class="excellent-asset-mode ${mode === REMIX_ASSET_MODES.LOGO || mode === REMIX_ASSET_MODES.LOGO_AND_PRODUCT ? "is-selected" : ""}">
          <div class="excellent-logo-block">
            <strong>品牌 Logo</strong>
            ${
              hasLogo
                ? `
              <label class="excellent-logo-check">
                <input type="checkbox" data-remix-logo ${assets.useBrandLogo ? "checked" : ""} />
                <span>使用品牌 Logo</span>
              </label>
              <img class="excellent-logo-thumb" src="${authenticatedImageSrc(brand.logo.url)}" alt="品牌 Logo" />
            `
                : `
              <p class="excellent-remix-hint">当前品牌未配置 Logo</p>
              <button type="button" class="secondary-btn small-btn" data-remix-go-brand>前往品牌档案上传</button>
            `
            }
          </div>
        </div>
        <div class="excellent-asset-mode ${mode === REMIX_ASSET_MODES.PRODUCT || mode === REMIX_ASSET_MODES.LOGO_AND_PRODUCT ? "is-selected" : ""}">
          <strong>产品实拍图</strong>
          <p>已选择 ${selectedCount} / ${MAX_REMIX_PRODUCT_IMAGES}</p>
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
      <label class="excellent-remix-wide">
        <span>品牌</span>
        <select data-remix-field="brand">
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
        ${[
          ["structure", "信息结构"],
          ["visual", "视觉语言"],
          ["hook", "封面钩子"],
          ["conversion", "收藏转化"],
        ]
          .map(
            ([value, label]) => `
          <label>
            <input data-remix-focus="${value}" type="checkbox" ${state.learningFocus?.includes(value) ? "checked" : ""} />
            <span>${label}</span>
          </label>
        `,
          )
          .join("")}
      </div>
      <p class="excellent-remix-hint">学习重点控制融合阶段真正使用哪些参考方法字段，而不是只显示文字。</p>
    </section>
    ${renderContentDirectionHtml(state, helpers)}
    ${renderTrendSectionHtml(state, helpers)}
    ${renderFusionPlanHtml(state, brandReady, helpers)}
    ${renderAssetsHtml(brand, state, helpers)}
    <div class="excellent-originality-note">只学习参考笔记的信息节奏、页面角色和内容方法；不会复制原文、原图人物、原品牌、原 Logo、水印或具体版式。参考笔记图片不会自动进入最终生图。</div>
  `;
}

export function renderBrandProductPickerHtml(state, helpers) {
  const { escapeHtml, authenticatedImageSrc } = helpers;
  const images = state.brandProductImages || [];
  const selected = new Set(state.productImageIds || []);
  if (state.brandProductImagesStatus === "loading") {
    return `<div class="excellent-remix-status is-loading">正在加载当前品牌产品素材…</div>`;
  }
  if (!images.length) {
    return `<div class="excellent-remix-status">当前品牌还没有产品实拍图。可在品牌相关上传入口补充后，再回到这里选择。</div>`;
  }
  return `
    <div class="excellent-product-picker-grid">
      ${images
        .map((image) => {
          const isSelected = selected.has(image.id);
          return `
            <label class="excellent-product-pick ${isSelected ? "is-selected" : ""}">
              <input type="checkbox" data-remix-pick-product="${image.id}" ${isSelected ? "checked" : ""} />
              <img src="${authenticatedImageSrc(image.url)}" alt="${escapeHtml(image.originalName || "产品图")}" />
              <span>${escapeHtml(image.originalName || "产品图")}</span>
              <em>${escapeHtml(String(image.createdAt || "").slice(0, 16))}</em>
            </label>
          `;
        })
        .join("")}
    </div>
    <p class="excellent-remix-hint">最多选择 ${MAX_REMIX_PRODUCT_IMAGES} 张。已选 ${selected.size} 张。</p>
  `;
}

export { canSubmitExcellentRemix, canGenerateFusionPlan, getSelectedSmartDirection };
