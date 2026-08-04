/**
 * Per-idea creative settings memory store (session-scoped, in-memory).
 *
 * Legacy public/app.js kept aspect ratio / creative style / wechat template /
 * logo usage / product selection / style reference per idea in module state
 * keyed by getIdeaProductKey(ideaIndex) = `${brandId}:${trendId}:${ideaIndex}`
 * (getIdeaAspectRatioSelection / getIdeaCreativeStyleSelection /
 * getIdeaWechatTemplateSelection / state.styleReferences / brandLogoUsage).
 * GenerationView restores the same idea's settings on re-entry and never
 * bleeds values across ideas. Cleared on account switch (notifyAuthReset).
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

/** Test helper. */
export function clearIdeaCreativeSettings(): void {
  settingsByKey.clear();
}
