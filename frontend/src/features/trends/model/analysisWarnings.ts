// 趋势分析 warning 提示（迁移自 origin/master public/app.js 的
// notifyTrendAnalysisWarnings，语义：降级批次仍是成功，绝不弹失败框）。
import type { TrendAnalysisWarning } from "./types";

export interface TrendWarningNotice {
  /** 概要句：说明本次结果含待验证或降级内容。 */
  summary: string;
  /** 去重后的 warning message 列表（message 缺失时回落到 code）。 */
  messages: string[];
}

const DEGRADED_CODES = ["TREND_ITEM_DEGRADED", "TREND_ITEM_FALLBACK"];

/** warnings 为空返回 null（正常结果不显示提示）。 */
export function buildTrendWarningNotice(
  warnings: TrendAnalysisWarning[] | undefined | null,
  itemCount = 10,
): TrendWarningNotice | null {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return null;

  const degradedIndexes = new Set(
    list
      .filter(
        (warning) =>
          DEGRADED_CODES.includes(String(warning?.code || "")) && Number.isInteger(warning?.trendIndex),
      )
      .map((warning) => warning.trendIndex as number),
  );

  const summary = degradedIndexes.size
    ? `已返回 ${itemCount} 条趋势，其中 ${degradedIndexes.size} 条为待验证/降级内容。`
    : `已返回 ${itemCount} 条趋势，本次结果含待验证或降级内容。`;

  const messages: string[] = [];
  for (const warning of list) {
    const text = String(warning?.message || warning?.code || "提示").trim();
    if (text && !messages.includes(text)) {
      messages.push(text);
    }
  }

  return { summary, messages };
}
