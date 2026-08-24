import { defineStore } from "pinia";
import { onAuthReset } from "@/shared/composables/useAbortScope";
import { useAuthStore } from "@/shared/stores/auth";
import {
  fetchBrands,
  fetchGenerationHistory,
  parseAssetExpiryMs,
  type GenerationHistoryItem,
  type HistoryBrand,
} from "../api";

export const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
export const ASSET_SIGNATURE_SAFETY_MARGIN_MS = 60 * 1000;

function computeFreshUntil(items: GenerationHistoryItem[], loadedAt: number): number {
  const defaultFreshUntil = loadedAt + HISTORY_CACHE_TTL_MS;
  let minAssetExpiry = Infinity;

  for (const item of items) {
    if (item.previewUrl) {
      const expiry = parseAssetExpiryMs(item.previewUrl);
      if (expiry > 0 && expiry < minAssetExpiry) minAssetExpiry = expiry;
    }
    const slides = Array.isArray(item.payload?.slides) ? item.payload.slides : [];
    for (const slide of slides) {
      const url = String(slide?.imageUrl || slide?.previewUrl || "");
      if (url) {
        const expiry = parseAssetExpiryMs(url);
        if (expiry > 0 && expiry < minAssetExpiry) minAssetExpiry = expiry;
      }
    }
  }

  if (Number.isFinite(minAssetExpiry) && minAssetExpiry > 0) {
    const signatureFreshUntil = minAssetExpiry - ASSET_SIGNATURE_SAFETY_MARGIN_MS;
    return Math.min(defaultFreshUntil, Math.max(loadedAt, signatureFreshUntil));
  }
  return defaultFreshUntil;
}

export const useHistoryStore = defineStore("history", {
  state: () => ({
    items: [] as GenerationHistoryItem[],
    brands: [] as HistoryBrand[],
    loaded: false,
    loading: false,
    refreshing: false,
    error: "",
    loadedAt: null as number | null,
    freshUntil: null as number | null,
    ownerUserId: null as string | number | null,
    inFlightPromise: null as Promise<GenerationHistoryItem[]> | null,
  }),

  getters: {
    isFresh: (state) => {
      if (!state.loaded || state.freshUntil === null) return false;
      return Date.now() < state.freshUntil;
    },
  },

  actions: {
    async ensureLoaded(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<GenerationHistoryItem[]> {
      const auth = useAuthStore();
      const currentUserId = auth.user?.id != null ? String(auth.user.id) : null;

      if (!auth.isLoggedIn || currentUserId === null) {
        return [];
      }

      if (this.ownerUserId !== null && this.ownerUserId !== currentUserId) {
        this.clear();
      }
      this.ownerUserId = currentUserId;

      if (!options.force && this.loaded && this.isFresh) {
        return this.items;
      }

      if (this.inFlightPromise) {
        return this.inFlightPromise;
      }

      if (this.loaded) {
        this.refreshing = true;
      } else {
        this.loading = true;
      }

      const fetchPromise = (async () => {
        try {
          const historyResult = await fetchGenerationHistory({}, options.signal);
          const loadedItems = historyResult.generations || [];
          const now = Date.now();

          this.items = loadedItems;
          this.loadedAt = now;
          this.freshUntil = computeFreshUntil(loadedItems, now);
          this.loaded = true;
          this.error = "";

          return this.items;
        } catch (error) {
          const message = (error as Error).message || "加载历史生成失败";
          this.error = message;
          throw error;
        } finally {
          this.loading = false;
          this.refreshing = false;
          this.inFlightPromise = null;
        }
      })();

      this.inFlightPromise = fetchPromise;
      return fetchPromise;
    },

    async loadBrands(signal?: AbortSignal): Promise<HistoryBrand[]> {
      if (this.brands.length > 0) return this.brands;
      try {
        const result = await fetchBrands(signal);
        this.brands = result.brands || [];
        return this.brands;
      } catch {
        return [];
      }
    },

    async refresh(options: { signal?: AbortSignal } = {}): Promise<GenerationHistoryItem[]> {
      return this.ensureLoaded({ force: true, signal: options.signal });
    },

    invalidate(_reason?: string): void {
      this.freshUntil = 0;
    },

    replaceAll(items: GenerationHistoryItem[]): void {
      const now = Date.now();
      this.items = [...items];
      this.loadedAt = now;
      this.freshUntil = computeFreshUntil(this.items, now);
      this.loaded = true;
      this.error = "";
    },

    upsertGeneration(item: GenerationHistoryItem): void {
      const index = this.items.findIndex((candidate) => Number(candidate.id) === Number(item.id));
      if (index >= 0) {
        this.items.splice(index, 1, item);
      } else {
        this.items.unshift(item);
      }
      if (this.loadedAt) {
        this.freshUntil = computeFreshUntil(this.items, this.loadedAt);
      }
    },

    removeGeneration(id: number | string): void {
      this.items = this.items.filter((item) => Number(item.id) !== Number(id));
    },

    clear(): void {
      this.items = [];
      this.brands = [];
      this.loaded = false;
      this.loading = false;
      this.refreshing = false;
      this.error = "";
      this.loadedAt = null;
      this.freshUntil = null;
      this.ownerUserId = null;
      this.inFlightPromise = null;
    },
  },
});

onAuthReset(() => {
  try {
    const store = useHistoryStore();
    store.clear();
  } catch {
    // pinia might not be active yet during test teardown
  }
});
