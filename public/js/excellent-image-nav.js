/**
 * Pure image index helpers for excellent-content carousel.
 * No DOM; safe for unit tests.
 */

export function clampImageIndex(index, length) {
  const len = Number(length) || 0;
  if (len <= 0) return 0;
  const i = Number(index);
  if (!Number.isFinite(i)) return 0;
  if (i < 0) return 0;
  if (i > len - 1) return len - 1;
  return Math.floor(i);
}

export function getPreviousImageIndex(index, length) {
  const len = Number(length) || 0;
  if (len <= 0) return 0;
  const current = clampImageIndex(index, len);
  return current <= 0 ? 0 : current - 1;
}

export function getNextImageIndex(index, length) {
  const len = Number(length) || 0;
  if (len <= 0) return 0;
  const current = clampImageIndex(index, len);
  return current >= len - 1 ? len - 1 : current + 1;
}

export function canGoPrevious(index, length) {
  return clampImageIndex(index, length) > 0 && (Number(length) || 0) > 0;
}

export function canGoNext(index, length) {
  const len = Number(length) || 0;
  if (len <= 0) return false;
  return clampImageIndex(index, len) < len - 1;
}
