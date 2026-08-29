import type { AdminDatePreset, AdminFilters } from "./types";

export const PRESET_OPTIONS: Array<{ id: AdminDatePreset; label: string }> = [
  { id: "today", label: "今天" },
  { id: "7d", label: "近7天" },
  { id: "30d", label: "近30天" },
  { id: "90d", label: "近90天" },
  { id: "custom", label: "自定义日期" },
];

export function computeDateParams(filters: AdminFilters): Record<string, string> {
  const params: Record<string, string> = {
    timezone: "Asia/Shanghai",
  };
  if (filters.accountType) {
    params.accountType = filters.accountType;
  }

  const now = new Date();
  const offsetMs = 8 * 3600 * 1000;
  const shanghaiNow = new Date(now.getTime() + offsetMs);
  const todayStr = shanghaiNow.toISOString().slice(0, 10);

  function daysAgoStr(days: number) {
    const d = new Date(shanghaiNow.getTime() - days * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function nextDayStr(dateStr: string) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const ms = Date.UTC(y, m - 1, d + 1);
    return new Date(ms).toISOString().slice(0, 10);
  }

  if (filters.preset === "today") {
    params.from = todayStr;
    params.to = nextDayStr(todayStr);
  } else if (filters.preset === "7d") {
    params.from = daysAgoStr(6);
    params.to = nextDayStr(todayStr);
  } else if (filters.preset === "30d") {
    params.from = daysAgoStr(29);
    params.to = nextDayStr(todayStr);
  } else if (filters.preset === "90d") {
    params.from = daysAgoStr(89);
    params.to = nextDayStr(todayStr);
  } else if (filters.preset === "custom") {
    if (filters.customFrom) params.from = filters.customFrom;
    if (filters.customTo) {
      params.to = /^\d{4}-\d{2}-\d{2}$/.test(filters.customTo) ? nextDayStr(filters.customTo) : filters.customTo;
    }
  }

  return params;
}

export function formatNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString("zh-CN");
}

export function formatCurrency(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "¥0.00";
  return `¥${num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return `${num.toFixed(1)}%`;
}

export function formatDate(value: unknown): string {
  if (!value) return "-";
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN");
}

export function formatDateTime(value: unknown): string {
  if (!value) return "-";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function formatBytes(bytes: unknown): string {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
