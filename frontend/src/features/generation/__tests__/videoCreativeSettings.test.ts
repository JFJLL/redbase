import { afterEach, describe, expect, it } from "vitest";
import {
  clearIdeaCreativeSettings,
  getIdeaCreativeSettings,
  getIdeaSettingsKey,
  saveIdeaCreativeSettings,
} from "../ideaCreativeSettings";

describe("video creative settings isolation", () => {
  afterEach(() => {
    clearIdeaCreativeSettings();
  });

  it("keeps video ratio and references independent from image settings", () => {
    const key = getIdeaSettingsKey(1, 5, 0);
    const initial = getIdeaCreativeSettings(key);
    saveIdeaCreativeSettings(key, {
      ...initial,
      aspectRatioSelection: "2:3",
      selectedProductIds: [11],
      videoAspectRatio: "16:9",
      videoReferenceImageIds: [22, 22, -1],
    });

    const settings = getIdeaCreativeSettings(key);
    expect(settings.aspectRatioSelection).toBe("2:3");
    expect(settings.selectedProductIds).toEqual([11]);
    expect(settings.videoAspectRatio).toBe("16:9");
    expect(settings.videoReferenceImageIds).toEqual([22]);

    saveIdeaCreativeSettings(key, {
      ...settings,
      videoAspectRatio: "4:3",
      videoReferenceImageIds: [33],
    });

    const changedVideoOnly = getIdeaCreativeSettings(key);
    expect(changedVideoOnly.aspectRatioSelection).toBe("2:3");
    expect(changedVideoOnly.selectedProductIds).toEqual([11]);
    expect(changedVideoOnly.videoAspectRatio).toBe("4:3");
    expect(changedVideoOnly.videoReferenceImageIds).toEqual([33]);
  });

  it("sanitizes legacy video values without overwriting the image ratio", () => {
    const key = getIdeaSettingsKey(1, 5, 1);
    const defaults = getIdeaCreativeSettings(key);
    const { videoAspectRatio: _videoAspectRatio, videoReferenceImageIds: _videoReferenceImageIds, ...legacy } = defaults;
    saveIdeaCreativeSettings(key, {
      ...legacy,
      aspectRatioSelection: "2:3",
      selectedProductIds: [11],
    });

    const restored = getIdeaCreativeSettings(key);
    expect(restored.aspectRatioSelection).toBe("2:3");
    expect(restored.selectedProductIds).toEqual([11]);
    expect(restored.videoAspectRatio).toBe("smart");
    expect(restored.videoReferenceImageIds).toBeUndefined();
  });

  it("does not derive video controls from legacy image settings", () => {
    const key = getIdeaSettingsKey(9, 9, 9);
    saveIdeaCreativeSettings(key, {
      ...getIdeaCreativeSettings(key),
      aspectRatioSelection: "2:3",
      selectedProductIds: [44],
      videoAspectRatio: undefined,
      videoReferenceImageIds: undefined,
    });

    const restored = getIdeaCreativeSettings(key);
    expect(restored.videoAspectRatio).toBe("smart");
    expect(restored.videoReferenceImageIds).toBeUndefined();
  });
});
