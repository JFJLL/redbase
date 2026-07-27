// 趋势维度纯函数，逐一迁移自旧前端 public/app.js（normalizeTrendBucketKey、
// sortTrendItemsForDisplay、getTrendBucketsForBrand、mergeGeneratedTrendResult、
// formatTrendAnalysisError 等），行为必须与旧版一致。
import { ApiError } from "@/shared/api/client";
import {
  DEFAULT_TREND_BUCKETS,
  LEGACY_TREND_BUCKET_KEYS,
  PERSONAL_TREND_BUCKET_DESCRIPTIONS,
  type TrendBucketMeta,
} from "./constants";
import type { InsightsBrand, TrendBucket, TrendItem, XhsCategoryNode, XhsCategoryOption } from "./types";

export function normalizeTrendBucketKey(key: unknown): string {
  const value = String(key || "");
  return LEGACY_TREND_BUCKET_KEYS[value] || value;
}

export function getDefaultTrendBucket(key: unknown): TrendBucketMeta | null {
  return DEFAULT_TREND_BUCKETS.find((bucket) => bucket.key === normalizeTrendBucketKey(key)) || null;
}

export function getTrendBucketDescription(
  bucket: Pick<TrendBucket, "key" | "description"> | null,
  brand: InsightsBrand | null,
): string {
  const fallback = getDefaultTrendBucket(bucket?.key);
  if (brand?.profileType === "personal") {
    return PERSONAL_TREND_BUCKET_DESCRIPTIONS[normalizeTrendBucketKey(bucket?.key)] || "适合当前个人 IP 参与和表达的话题方向。";
  }
  return fallback?.description || bucket?.description || "适合当前品牌借势的热点方向。";
}

export function sortTrendItemsForDisplay(items: TrendItem[] | undefined): TrendItem[] {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      item,
      index,
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : -1,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }, index) => ({ ...item, rank: index + 1 }));
}

/** 六个维度全量返回；缺失维度补空 items（与旧版 getTrendBucketsForBrand 一致）。 */
export function getTrendBucketsForBrand(brand: InsightsBrand | null | undefined): TrendBucket[] {
  const bucketsByKey = new Map<string, TrendBucket>(
    DEFAULT_TREND_BUCKETS.map((bucket) => [bucket.key, { ...bucket, items: [] }]),
  );

  for (const bucket of brand?.trends || []) {
    const key = normalizeTrendBucketKey(bucket.key);
    const base = bucketsByKey.get(key);
    if (!base) continue;
    bucketsByKey.set(key, {
      ...base,
      // 历史快照可能早于服务端按分数排序，展示前统一重排且不改存储。
      items: sortTrendItemsForDisplay(bucket.items),
    });
  }

  return DEFAULT_TREND_BUCKETS.map((bucket) => bucketsByKey.get(bucket.key) as TrendBucket);
}

export function firstTrendBucket(brand: InsightsBrand | null | undefined): TrendBucket | null {
  const buckets = getTrendBucketsForBrand(brand);
  return buckets.find((bucket) => bucket.items?.length) || buckets[0] || null;
}

export function countBrandTrends(brand: InsightsBrand): number {
  return getTrendBucketsForBrand(brand).reduce((sum, bucket) => sum + (bucket.items?.length || 0), 0);
}

/** 历史分析记录名称形如「品牌名 - 小红书热点话题」，据此反推维度 key。 */
export function getAnalysisBucketKey(analysis: { name?: string } | null | undefined): string {
  const name = String(analysis?.name || "");
  return DEFAULT_TREND_BUCKETS.find((bucket) => name.includes(bucket.title))?.key || "";
}

export function cloneTrend(trend: TrendItem): TrendItem {
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

export function cloneTrendBucket(bucket: TrendBucket): TrendBucket {
  return {
    ...bucket,
    items: Array.isArray(bucket.items) ? bucket.items.map(cloneTrend) : [],
  };
}

/** 生成成功后仅替换本次生成的维度，其余维度保留本地已有内容（旧版同名函数）。 */
export function mergeGeneratedTrendResult(
  previous: InsightsBrand | null | undefined,
  nextBrand: InsightsBrand,
  generatedBucketKey: string,
): InsightsBrand {
  if (!previous?._detailLoaded) return nextBrand;
  const previousByKey = new Map(getTrendBucketsForBrand(previous).map((bucket) => [bucket.key, bucket]));
  const incomingByKey = new Map(getTrendBucketsForBrand(nextBrand).map((bucket) => [bucket.key, bucket]));
  const trends = DEFAULT_TREND_BUCKETS.map((bucket) => {
    if (bucket.key === generatedBucketKey) {
      return incomingByKey.get(bucket.key) || previousByKey.get(bucket.key) || { ...bucket, items: [] };
    }
    const previousBucket = previousByKey.get(bucket.key);
    const incomingBucket = incomingByKey.get(bucket.key);
    return previousBucket?.items?.length ? previousBucket : incomingBucket || previousBucket || { ...bucket, items: [] };
  });
  const analysesById = new Map<string, InsightsBrand["analyses"][number]>();
  for (const analysis of [...(nextBrand?.analyses || []), ...(previous?.analyses || [])]) {
    const key = String(analysis?.id ?? `${analysis?.name || ""}-${analysis?.timestamp || ""}`);
    if (!analysesById.has(key)) analysesById.set(key, analysis);
  }
  return {
    ...nextBrand,
    trends,
    analyses: [...analysesById.values()].sort((left, right) =>
      String(right?.timestamp || "").localeCompare(String(left?.timestamp || "")),
    ),
  };
}

/** 4xx（排除 408/409）后重置幂等 requestId（旧版 shouldResetTrendAnalysisRequestId）。 */
export function shouldResetTrendAnalysisRequestId(error: unknown): boolean {
  const status = error instanceof ApiError ? Number(error.status || 0) : 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 409;
}

/** 失败文案组装，与旧版 formatTrendAnalysisError 完全一致（\n 由样式 pre-line 呈现）。 */
export function formatTrendAnalysisError(error: unknown): string {
  const message = String((error as { message?: unknown })?.message || "");
  if (message.includes("热点搜索服务") || message.includes("热点来源暂时不可用")) {
    return [
      "热点搜索服务暂时不可用，请稍后重试。",
      "",
      "服务器这次没有拿到可核验的趋势来源，结果不会保存，也不会扣积分。",
      "",
      "请稍后再次点击当前维度的生成按钮；其他维度不受影响。",
    ].join("\n");
  }
  if (message.includes("contentAssets") || message.includes("内容资产")) {
    return [
      "当前维度的趋势和选题已经开始生成，但模型没有按结构完整返回内容资产，本次结果未保存。",
      "",
      message,
      "",
      "请稍后再次点击当前维度的生成按钮。主流程现在只生成当前维度，不会再分批补齐 120 个选题。",
    ].join("\n");
  }
  if (message.includes("未返回可用趋势结果") || message.includes("未能获取到可用热点") || message.includes("文本模型暂时不可用")) {
    return [
      "本次分析未能获取到可用热点，请稍后重试。",
      "",
      "这次没有拿到当前维度可用的趋势、选题和内容资产包。",
      "",
      "你的品牌资料和积分状态没有损坏，请稍后再次点击当前维度的生成按钮。",
    ].join("\n");
  }
  return message || "AI 热点分析失败，请稍后再次点击当前维度的生成按钮重新生成。";
}

/** 类目树拍平为「一级 / 二级」选项（旧版 flattenXhsCategoryOptions）。 */
export function flattenXhsCategoryOptions(
  items: XhsCategoryNode[] | undefined,
  result: XhsCategoryOption[] = [],
  parentLabels: string[] = [],
): XhsCategoryOption[] {
  (items || []).forEach((item) => {
    const labels = [...parentLabels, item?.label].filter(Boolean);
    if (item?.value) result.push({ label: labels.join(" / "), value: item.value });
    if (Array.isArray(item?.children)) flattenXhsCategoryOptions(item.children, result, labels);
  });
  return result;
}

export function createTrendAnalysisRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() || `trend-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
