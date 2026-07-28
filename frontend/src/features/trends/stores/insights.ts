// 趋势分析与内容选题共享的 Pinia store（两个 feature 均属 Insights Agent）。
// 对应旧前端 public/js/state.js 中 brands / selectedBrandId / selectedTrendMode /
// selectedTrendId / xhsCategory* / trendAnalysisLoadingKeys 等全局状态。
import { defineStore } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import { getBrandDataVersion } from "@/shared/stores/brandDataVersion";
import {
  fetchBrandDetail,
  fetchBrandSummaries,
  fetchXhsCategories,
} from "../api/insightsApi";
import { DEFAULT_TREND_MODE } from "../model/constants";
import {
  countBrandTrends,
  createTrendAnalysisRequestId,
  firstTrendBucket,
  flattenXhsCategoryOptions,
  getTrendBucketsForBrand,
  mergeGeneratedTrendResult,
  normalizeTrendBucketKey,
} from "../model/trendBuckets";
import type {
  InsightsBrand,
  TrendAnalysisResponse,
  TrendBucket,
  TrendItem,
  XhsCategoryNode,
} from "../model/types";

type BrandsStatus = "idle" | "loading" | "ready" | "error";
type XhsCategoryStatus = "idle" | "loading" | "ready" | "empty" | "error";

/** summary 记录补齐详情字段（旧版 markBrandSummary）。 */
function markBrandSummary(brand: InsightsBrand): InsightsBrand {
  return {
    ...brand,
    knowledgeBase: "",
    trends: [],
    analyses: [],
    _detailLoaded: false,
  };
}

/** 详情记录合并（旧版 markBrandDetail）。 */
function markBrandDetail(brand: InsightsBrand, previous: Partial<InsightsBrand> = {}): InsightsBrand {
  const next: InsightsBrand = {
    ...previous,
    ...brand,
    _detailLoaded: true,
  };
  next.trends = Array.isArray(next.trends) ? next.trends : [];
  next.analyses = Array.isArray(next.analyses) ? next.analyses : [];
  next.trendCount = countBrandTrends(next);
  next.analysisCount = next.analyses.length;
  return next;
}

export function getTrendAnalysisKey(brandId: number | null | undefined, bucketKey: string): string {
  return `${Number(brandId) || 0}:${normalizeTrendBucketKey(bucketKey || DEFAULT_TREND_MODE) || DEFAULT_TREND_MODE}`;
}

export const useInsightsStore = defineStore("insights", {
  state: () => ({
    brands: [] as InsightsBrand[],
    brandsStatus: "idle" as BrandsStatus,
    brandsError: "",
    /** 数据归属的登录用户 id；切换账号时整体重置。 */
    ownerUserId: "" as string,
    selectedBrandId: null as number | null,
    selectedTrendMode: DEFAULT_TREND_MODE,
    selectedTrendId: null as number | null,
    brandDetailLoadingId: null as number | null,
    xhsCategoryPath: "",
    xhsCategories: [] as XhsCategoryNode[],
    xhsCategoryStatus: "idle" as XhsCategoryStatus,
    xhsCategoryError: "",
    trendAnalysisLoadingKeys: [] as string[],
    /** 每个「品牌:维度」的幂等 requestId，失败可复用以复取服务端结果。 */
    trendAnalysisRequestIds: {} as Record<string, string>,
    /** 品牌摘要列表加载时的品牌数据版本快照（brandDataVersion）。 */
    brandsListVersion: -1 as number,
    /** 每个品牌详情加载时的版本快照；品牌 CUD 后版本前移即失效。 */
    brandDetailVersions: {} as Record<number, number>,
  }),

  getters: {
    selectedBrand(state): InsightsBrand | null {
      return state.brands.find((item) => item.id === state.selectedBrandId) ?? state.brands[0] ?? null;
    },
    currentBucket(): TrendBucket | null {
      const brand = this.selectedBrand;
      if (!brand) return null;
      const buckets = getTrendBucketsForBrand(brand);
      return buckets.find((bucket) => bucket.key === this.selectedTrendMode) ?? buckets[0] ?? null;
    },
    selectedTrend(state): TrendItem | null {
      const brand = this.selectedBrand;
      if (!brand) return null;
      for (const bucket of getTrendBucketsForBrand(brand)) {
        const found = (bucket.items || []).find((item) => item.id === state.selectedTrendId);
        if (found) return found;
      }
      return this.currentBucket?.items?.[0] ?? null;
    },
    isAnalysisLoading(state) {
      return (brandId: number | null | undefined, bucketKey: string): boolean =>
        state.trendAnalysisLoadingKeys.includes(getTrendAnalysisKey(brandId, bucketKey));
    },
  },

  actions: {
    /** 切换账号后清空上一账号的数据（旧版 clearSession 的 insights 部分）。 */
    syncOwner(): void {
      const auth = useAuthStore();
      const userId = String(auth.user?.id ?? "");
      if (userId === this.ownerUserId) return;
      this.$reset();
      this.ownerUserId = userId;
    },

    /**
     * 拉取品牌摘要列表。force 时重新请求并把摘要字段合并进已加载详情，
     * 以便品牌档案页里的增删改能在进入趋势页时反映出来。
     */
    async loadBrands(signal?: AbortSignal, options: { force?: boolean } = {}): Promise<void> {
      this.syncOwner();
      const listFresh = this.brandsListVersion >= getBrandDataVersion();
      if (this.brandsStatus === "ready" && !options.force && listFresh) return;
      const previousById = new Map(this.brands.map((brand) => [Number(brand.id), brand]));
      this.brandsStatus = "loading";
      this.brandsError = "";
      const versionSnapshot = getBrandDataVersion();
      try {
        const result = await fetchBrandSummaries(signal);
        this.brands = (result.brands || []).map((summary) => {
          const previous = previousById.get(Number(summary.id));
          const detailFresh =
            (this.brandDetailVersions[Number(summary.id)] ?? -1) >= getBrandDataVersion(summary.id);
          if (previous?._detailLoaded && detailFresh) {
            // 保留仍然新鲜的详情（trends/analyses/knowledgeBase），仅刷新摘要字段。
            return markBrandDetail(summary, previous);
          }
          // 品牌被编辑过：丢弃旧详情，下次进入趋势页重新 GET /api/brands/:id。
          delete this.brandDetailVersions[Number(summary.id)];
          return markBrandSummary(summary);
        });
        this.brandsListVersion = versionSnapshot;
        if (this.brands.length) {
          if (!this.brands.some((brand) => brand.id === this.selectedBrandId)) {
            this.selectedBrandId = this.brands[0].id;
            this.selectedTrendId = null;
          }
        } else {
          this.selectedBrandId = null;
          this.selectedTrendId = null;
        }
        this.brandsStatus = "ready";
      } catch (error) {
        this.brandsStatus = "error";
        this.brandsError = String((error as { message?: unknown })?.message || "加载失败");
        throw error;
      }
    },

    /** 详情懒加载（旧版 ensureBrandDetailLoaded）。品牌 CUD 后缓存失效，必须重新拉取。 */
    async ensureBrandDetail(brandId: number | null | undefined, signal?: AbortSignal): Promise<InsightsBrand | null> {
      const id = Number(brandId || 0);
      if (!id) return null;
      const current = this.brands.find((brand) => Number(brand.id) === id);
      const detailFresh = (this.brandDetailVersions[id] ?? -1) >= getBrandDataVersion(id);
      if (current?._detailLoaded && detailFresh) return current;

      if (Number(this.selectedBrandId) === id) {
        this.brandDetailLoadingId = id;
      }
      try {
        const result = await fetchBrandDetail(id, signal);
        if (!this.brands.some((brand) => Number(brand.id) === id)) return null;
        this.replaceBrand(result.brand);
        const nextBrand = this.brands.find((brand) => Number(brand.id) === id) || null;
        if (Number(this.selectedBrandId) === id) {
          this.syncSelectedTrendSelection();
        }
        return nextBrand;
      } finally {
        if (Number(this.brandDetailLoadingId) === id) {
          this.brandDetailLoadingId = null;
        }
      }
    },

    /** 小红书内容类目（旧版 loadXhsCategories + applyXhsCategoryResult）。 */
    async loadXhsCategories(signal?: AbortSignal): Promise<void> {
      if (this.xhsCategoryStatus === "loading" || this.xhsCategoryStatus === "ready") return;
      this.xhsCategoryStatus = "loading";
      this.xhsCategoryError = "";
      try {
        const result = await fetchXhsCategories(signal);
        this.xhsCategories = Array.isArray(result?.items) ? result.items : [];
        this.xhsCategoryStatus = this.xhsCategories.length ? "ready" : "empty";
        this.xhsCategoryError = "";
        const validValues = new Set(flattenXhsCategoryOptions(this.xhsCategories).map((item) => item.value));
        if (this.xhsCategoryPath && !validValues.has(this.xhsCategoryPath)) {
          this.xhsCategoryPath = "";
        }
      } catch (error) {
        this.xhsCategories = [];
        this.xhsCategoryPath = "";
        this.xhsCategoryStatus = "error";
        this.xhsCategoryError = String((error as { message?: unknown })?.message || "小红书内容类目暂时不可用");
        throw error;
      }
    },

    replaceBrand(nextBrand: InsightsBrand): void {
      const previous = this.brands.find((brand) => Number(brand.id) === Number(nextBrand.id));
      const normalized = markBrandDetail(nextBrand, previous ?? {});
      this.brands = this.brands.some((brand) => Number(brand.id) === Number(nextBrand.id))
        ? this.brands.map((brand) => (Number(brand.id) === Number(nextBrand.id) ? normalized : brand))
        : [normalized, ...this.brands];
      // 详情来自服务端最新响应：记录当前版本快照，直到下一次品牌 CUD 前有效。
      this.brandDetailVersions[Number(nextBrand.id)] = getBrandDataVersion();
    },

    /** 单条趋势替换（选题重生成 / 选题编辑后，旧版 replaceTrend）。 */
    replaceTrendInBrand(brandId: number, nextTrend: TrendItem): void {
      this.brands = this.brands.map((brand) => {
        if (brand.id !== brandId) return brand;
        return {
          ...brand,
          trends: (brand.trends || []).map((bucket) => ({
            ...bucket,
            items: bucket.items.map((trend) => (trend.id === nextTrend.id ? nextTrend : trend)),
          })),
        };
      });
    },

    /** 旧版 syncSelectedTrendSelection：维度与选中趋势兜底。 */
    syncSelectedTrendSelection(): void {
      const brand = this.selectedBrand;
      if (!brand || !brand._detailLoaded) {
        this.selectedTrendId = null;
        return;
      }
      if (!getTrendBucketsForBrand(brand).some((bucket) => bucket.key === this.selectedTrendMode)) {
        this.selectedTrendMode = firstTrendBucket(brand)?.key ?? DEFAULT_TREND_MODE;
      }
      const currentBucket = this.currentBucket;
      if (!currentBucket?.items?.some((trend) => Number(trend.id) === Number(this.selectedTrendId))) {
        this.selectedTrendId = currentBucket?.items?.[0]?.id ?? null;
      }
    },

    setAnalysisBusy(brandId: number, bucketKey: string, loading: boolean): void {
      const key = getTrendAnalysisKey(brandId, bucketKey);
      this.trendAnalysisLoadingKeys = loading
        ? [...new Set([...this.trendAnalysisLoadingKeys, key])]
        : this.trendAnalysisLoadingKeys.filter((item) => item !== key);
    },

    getOrCreateAnalysisRequestId(brandId: number, bucketKey: string): string {
      const key = getTrendAnalysisKey(brandId, bucketKey);
      const existing = this.trendAnalysisRequestIds[key];
      if (existing) return existing;
      const requestId = createTrendAnalysisRequestId();
      this.trendAnalysisRequestIds[key] = requestId;
      return requestId;
    },

    clearAnalysisRequestId(brandId: number, bucketKey: string): void {
      delete this.trendAnalysisRequestIds[getTrendAnalysisKey(brandId, bucketKey)];
    },

    /** 分析成功后合并结果、更新积分并选中新维度第一条趋势。 */
    applyAnalysisResult(brandId: number, bucketKey: string, result: TrendAnalysisResponse): void {
      const previous = this.brands.find((brand) => Number(brand.id) === Number(result.brand?.id)) || null;
      const mergedBrand = mergeGeneratedTrendResult(previous, result.brand, bucketKey);
      const auth = useAuthStore();
      if (result.user) auth.user = result.user;
      this.replaceBrand(mergedBrand);
      if (Number(this.selectedBrandId) === Number(brandId) && this.selectedTrendMode === bucketKey) {
        const merged = this.brands.find((brand) => Number(brand.id) === Number(brandId)) || null;
        this.selectedTrendId =
          getTrendBucketsForBrand(merged).find((bucket) => bucket.key === bucketKey)?.items?.[0]?.id ?? null;
      }
    },
  },
});
