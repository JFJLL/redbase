// In-memory per-user cooldown for the manual "更新内容" refresh.
// Refreshing is free, so the only guard needed is a light per-user rate limit;
// admins bypass it entirely. State is process-local by design (single Node server).

const EXCELLENT_REFRESH_COOLDOWN_MS = 60 * 1000;

const lastRefreshAtByUser = new Map();

/**
 * Returns { allowed: true } and marks the attempt, or
 * { allowed: false, retryAfterSeconds } while the user is cooling down.
 */
function claimExcellentRefreshSlot(userId, { isAdmin = false, now = Date.now() } = {}) {
  if (isAdmin) return { allowed: true, retryAfterSeconds: 0 };
  const key = Number(userId);
  const lastAt = lastRefreshAtByUser.get(key) || 0;
  const elapsed = now - lastAt;
  if (elapsed < EXCELLENT_REFRESH_COOLDOWN_MS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((EXCELLENT_REFRESH_COOLDOWN_MS - elapsed) / 1000)),
    };
  }
  lastRefreshAtByUser.set(key, now);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** A failed refresh should not lock the user out for a minute. */
function releaseExcellentRefreshSlot(userId) {
  lastRefreshAtByUser.delete(Number(userId));
}

function resetExcellentRefreshCooldowns() {
  lastRefreshAtByUser.clear();
}

module.exports = {
  EXCELLENT_REFRESH_COOLDOWN_MS,
  claimExcellentRefreshSlot,
  releaseExcellentRefreshSlot,
  resetExcellentRefreshCooldowns,
};
