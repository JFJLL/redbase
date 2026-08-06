/**
 * 优秀内容榜单滚动位置记忆：每个榜单独立保存/恢复浏览位置（sessionStorage，
 * board 键隔离），切换榜单或刷新后回到各自上次浏览位置。
 */
import { onAuthReset } from "@/shared/composables/useAbortScope";

export const EXCELLENT_BOARD_SCROLL_PREFIX = "redbase.excellent.scroll.";

export function saveBoardScrollPosition(board: string, position: number): void {
  const value = Number(position);
  if (!Number.isFinite(value) || value < 0) return;
  try {
    sessionStorage.setItem(`${EXCELLENT_BOARD_SCROLL_PREFIX}${String(board)}`, String(Math.floor(value)));
  } catch {
    // 隐私模式等场景忽略存储失败。
  }
}

export function restoreBoardScrollPosition(board: string): number {
  try {
    const raw = sessionStorage.getItem(`${EXCELLENT_BOARD_SCROLL_PREFIX}${String(board)}`);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

export function clearBoardScrollPosition(board: string): void {
  try {
    sessionStorage.removeItem(`${EXCELLENT_BOARD_SCROLL_PREFIX}${String(board)}`);
  } catch {
    // ignore
  }
}

/** 登出/切换账号时清除全部榜单滚动位置，避免上一账号的浏览位置残留到新账号。 */
export function clearAllBoardScrollPositions(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && key.startsWith(EXCELLENT_BOARD_SCROLL_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

onAuthReset(clearAllBoardScrollPositions);
