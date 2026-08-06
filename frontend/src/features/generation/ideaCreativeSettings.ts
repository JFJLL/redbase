/**
 * Per-idea creative settings memory store (session-scoped, in-memory).
 *
 * Legacy public/app.js kept aspect ratio / creative style / wechat template /
 * logo usage / product selection / style reference per idea in module state
 * keyed by getIdeaProductKey(ideaIndex) = `${brandId}:${trendId}:${ideaIndex}`
 * (getIdeaAspectRatioSelection / getIdeaCreativeStyleSelection /
 * getIdeaWechatTemplateSelection / state.styleReferences / brandLogoUsage).
 * 内容选题页恢复同一选题的设置并在选题间隔离，永不串值。
 * 账号切换（notifyAuthReset）时整体清空。
 */
import { onAuthReset } from "@/shared/composables/useAbortScope";
import {
  IMAGE_ASPECT_RATIOS,
  WECHAT_TEMPLATE_OPTIONS,
  XHS_CREATIVE_STYLE_OPTIONS,
} from "./api";

export interface StyleReferenceImage {
  fileName: string;
  dataUrl: string;
  sizeBytes: number;
}

export interface IdeaCreativeSettings {
  aspectRatioSelection: string;
  visualStylePreset: string;
  wechatTemplate: string;
  useBrandLogo: boolean;
  selectedProductIds: number[];
  /** 内容选题页「使用这些产品图生成图片」开关（旧版 productImages[key].useImage）。
   *  有已选产品图时默认启用，与旧版 getProductSelection 的 useImage 兜底一致。 */
  useProductImages: boolean;
  styleReference: StyleReferenceImage | null;
}

const settingsByKey = new Map<string, IdeaCreativeSettings>();

onAuthReset(() => {
  settingsByKey.clear();
});

/** getIdeaProductKey semantics (app.js 3082). */
export function getIdeaSettingsKey(
  brandId: number | null | undefined,
  trendId: number | null | undefined,
  ideaIndex: number | null | undefined,
): string {
  return `${Number(brandId) || "none"}:${Number(trendId) || "none"}:${Number(ideaIndex ?? -1) >= 0 ? Number(ideaIndex) : "none"}`;
}

function defaultSettings(): IdeaCreativeSettings {
  return {
    aspectRatioSelection: "smart",
    visualStylePreset: "auto",
    wechatTemplate: "auto",
    useBrandLogo: false,
    selectedProductIds: [],
    useProductImages: true,
    styleReference: null,
  };
}

/** Invalid stored values fall back like the legacy getters (smart / auto). */
function sanitize(settings: IdeaCreativeSettings): IdeaCreativeSettings {
  const validRatio =
    settings.aspectRatioSelection === "smart" || IMAGE_ASPECT_RATIOS.includes(settings.aspectRatioSelection);
  const validStyle = XHS_CREATIVE_STYLE_OPTIONS.some((option) => option.value === settings.visualStylePreset);
  const validTemplate = WECHAT_TEMPLATE_OPTIONS.some((option) => option.value === settings.wechatTemplate);
  return {
    ...settings,
    aspectRatioSelection: validRatio ? settings.aspectRatioSelection : "smart",
    visualStylePreset: validStyle ? settings.visualStylePreset : "auto",
    wechatTemplate: validTemplate ? settings.wechatTemplate : "auto",
    selectedProductIds: Array.isArray(settings.selectedProductIds) ? [...settings.selectedProductIds] : [],
    useProductImages: settings.useProductImages !== false,
  };
}

/** Snapshot for one idea key; always a fresh object so callers can mutate. */
export function getIdeaCreativeSettings(key: string): IdeaCreativeSettings {
  const stored = settingsByKey.get(key);
  return stored ? sanitize(stored) : defaultSettings();
}

export function saveIdeaCreativeSettings(key: string, settings: IdeaCreativeSettings): void {
  settingsByKey.set(key, {
    ...settings,
    selectedProductIds: [...settings.selectedProductIds],
  });
}

/** 统计引用了某张产品图的选题键位数（删除确认时展示影响）。 */
export function countProductImageReferences(imageId: number): number {
  let count = 0;
  for (const settings of settingsByKey.values()) {
    if (settings.selectedProductIds.some((id) => Number(id) === Number(imageId))) count += 1;
  }
  return count;
}

/** 删除图片后清理所有选题键位中的失效引用，返回被清理的键位数。 */
export function removeProductImageFromAllSettings(imageId: number): number {
  let cleaned = 0;
  for (const [key, settings] of [...settingsByKey]) {
    const next = settings.selectedProductIds.filter((id) => Number(id) !== Number(imageId));
    if (next.length !== settings.selectedProductIds.length) {
      settingsByKey.set(key, { ...settings, selectedProductIds: next });
      cleaned += 1;
    }
  }
  return cleaned;
}

/** Test helper. */
export function clearIdeaCreativeSettings(): void {
  settingsByKey.clear();
}
