const {
  fetchPgyXhsHotNotes,
  getPgyPublicErrorMessage,
  normalizePgyCategoryPath,
} = require("../integrations/pgy-content-square");
const {
  findExcellentContentCache,
  upsertExcellentContentCache,
  recordExcellentContentCacheError,
} = require("../db/repositories/excellent-content-cache-repository");

const EXCELLENT_SOURCE_XHS_HOT = "xhs_hot";
const EXCELLENT_WINDOW_DAYS = 7;
const EXCELLENT_ORDER_BY = "premium_engage_num";
const EXCELLENT_SORT = "desc";
const EXCELLENT_PAGE_SIZE = 20;
const EXCELLENT_MAX_PAGES = 3;
const EXCELLENT_LIMIT = 8;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

const EXCELLENT_PUBLIC_MESSAGES = {
  PGY_EMPTY_RESULT: "当前类目近7日暂无可用图文内容，请切换类目或稍后重试。",
  PGY_NETWORK_ERROR: "优秀内容暂时无法更新，请稍后重试。",
  PGY_API_ERROR: "优秀内容暂时无法更新，请稍后重试。",
  EXCELLENT_CONTENT_UNAVAILABLE: "优秀内容暂时不可用，请稍后重试。",
};

const inFlightRefreshes = new Map();

function getExcellentContentCacheTtlMs(appConfig) {
  const configured = Number(appConfig?.pgy?.excellentContentCacheTtlMs || appConfig?.pgy?.cacheTtlMs || 0);
  if (Number.isFinite(configured) && configured >= 30 * 60 * 1000 && configured <= 24 * 60 * 60 * 1000) {
    return configured;
  }
  return DEFAULT_CACHE_TTL_MS;
}

function cacheKey(sourceKey, categoryPath) {
  return `${String(sourceKey || "")}::${String(categoryPath || "")}`;
}

function isCacheFresh(cache, nowMs = Date.now()) {
  if (!cache?.expiresAt) return false;
  const expiresMs = Date.parse(cache.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function hasCacheItems(cache) {
  return Array.isArray(cache?.items) && cache.items.length > 0;
}

function engagementOf(note) {
  return Number(note?.metrics?.engagementCount || 0);
}

function mapExcellentContentError(error) {
  const code = error?.code || "";
  if (code && EXCELLENT_PUBLIC_MESSAGES[code]) {
    return EXCELLENT_PUBLIC_MESSAGES[code];
  }
  if (code === "PGY_NOT_CONFIGURED" || code === "PGY_AUTH_EXPIRED") {
    return getPgyPublicErrorMessage(error);
  }
  if (code) {
    return getPgyPublicErrorMessage(error);
  }
  return String(error?.message || EXCELLENT_PUBLIC_MESSAGES.EXCELLENT_CONTENT_UNAVAILABLE).slice(0, 300);
}

function filterRankAndLimitNotes(notes) {
  const seen = new Set();
  const imageNotes = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || note.noteType === "video") continue;
    const noteId = String(note.noteId || note.id || "").trim();
    if (!noteId || seen.has(noteId)) continue;
    seen.add(noteId);
    imageNotes.push({
      ...note,
      id: noteId,
      noteId,
      source: note.source || "pgy_content_square",
      sourceKey: note.sourceKey || EXCELLENT_SOURCE_XHS_HOT,
    });
  }
  imageNotes.sort((a, b) => {
    const diff = engagementOf(b) - engagementOf(a);
    if (diff !== 0) return diff;
    return String(a.noteId).localeCompare(String(b.noteId));
  });
  return imageNotes.slice(0, EXCELLENT_LIMIT).map((note, index) => ({
    ...note,
    rank: index + 1,
  }));
}

async function fetchExcellentNotesFromPgy(appConfig, { categoryPath = "", fetchImpl } = {}) {
  const collected = [];
  for (let pageNum = 1; pageNum <= EXCELLENT_MAX_PAGES; pageNum += 1) {
    const page = await fetchPgyXhsHotNotes(appConfig, {
      categoryPath,
      pageSize: EXCELLENT_PAGE_SIZE,
      pageNum,
      nd: String(EXCELLENT_WINDOW_DAYS),
      orderBy: EXCELLENT_ORDER_BY,
      sort: EXCELLENT_SORT,
      // Request image/text notes only; engage ranking otherwise floods with videos.
      noteType: 1,
      fetchImpl,
    });
    collected.push(...(page.notes || []));
    const imageCount = filterRankAndLimitNotes(collected).length;
    if (imageCount >= EXCELLENT_LIMIT) break;
    const pageNotes = Array.isArray(page.notes) ? page.notes : [];
    if (pageNotes.length < EXCELLENT_PAGE_SIZE) break;
  }
  const items = filterRankAndLimitNotes(collected);
  if (!items.length) {
    const error = new Error(EXCELLENT_PUBLIC_MESSAGES.PGY_EMPTY_RESULT);
    error.code = "PGY_EMPTY_RESULT";
    throw error;
  }
  return items;
}

function buildResponse({ items, updatedAt, stale = false, lastError = "" }) {
  return {
    items: Array.isArray(items) ? items : [],
    filters: {
      sources: [{ value: EXCELLENT_SOURCE_XHS_HOT, label: "小红书热门" }],
    },
    updatedAt: updatedAt || "",
    stale: Boolean(stale),
    windowDays: EXCELLENT_WINDOW_DAYS,
    sort: "engagement_desc",
    lastError: lastError ? String(lastError).slice(0, 300) : "",
  };
}

function storeSuccessfulCache(appConfig, sourceKey, categoryPath, items) {
  const now = new Date();
  const ttlMs = getExcellentContentCacheTtlMs(appConfig);
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return upsertExcellentContentCache({
    sourceKey,
    categoryPath,
    items,
    fetchedAt: now.toISOString(),
    expiresAt,
    lastError: "",
  });
}

async function refreshExcellentContentCache(appConfig, { sourceKey, categoryPath, fetchImpl } = {}) {
  const items = await fetchExcellentNotesFromPgy(appConfig, { categoryPath, fetchImpl });
  return storeSuccessfulCache(appConfig, sourceKey, categoryPath, items);
}

function ensureExcellentContentRefresh(appConfig, { sourceKey, categoryPath, fetchImpl } = {}) {
  const key = cacheKey(sourceKey, categoryPath);
  let promise = inFlightRefreshes.get(key);
  if (!promise) {
    promise = refreshExcellentContentCache(appConfig, { sourceKey, categoryPath, fetchImpl }).finally(() => {
      inFlightRefreshes.delete(key);
    });
    inFlightRefreshes.set(key, promise);
  }
  return promise;
}

function scheduleBackgroundRefresh(appConfig, { sourceKey, categoryPath, fetchImpl } = {}) {
  const promise = ensureExcellentContentRefresh(appConfig, { sourceKey, categoryPath, fetchImpl });
  promise.catch((error) => {
    const message = mapExcellentContentError(error);
    try {
      recordExcellentContentCacheError(sourceKey, categoryPath, message);
    } catch (_error) {
      // Ignore cache write failures during background refresh.
    }
  });
  return promise;
}

async function getExcellentContents(appConfig, options = {}) {
  const sourceKey = String(options.source || EXCELLENT_SOURCE_XHS_HOT).trim() || EXCELLENT_SOURCE_XHS_HOT;
  if (sourceKey !== EXCELLENT_SOURCE_XHS_HOT) {
    const error = new Error("暂不支持该内容来源。");
    error.code = "INVALID_SOURCE";
    error.statusCode = 400;
    throw error;
  }
  const categoryPath = normalizePgyCategoryPath(options.categoryPath || "");
  const forceRefresh = options.forceRefresh === true;
  const waitForFresh = options.waitForFresh === true;
  // Default true: user requests may fall back to last successful cache on Pgy failure.
  const allowStaleOnError = options.allowStaleOnError !== false;
  const fetchImpl = options.fetchImpl;
  const cache = findExcellentContentCache(sourceKey, categoryPath);

  if (!forceRefresh && hasCacheItems(cache) && isCacheFresh(cache)) {
    return buildResponse({
      items: cache.items,
      updatedAt: cache.fetchedAt,
      stale: false,
      lastError: cache.lastError,
    });
  }

  // Stale-while-revalidate: return expired cache immediately and refresh in background.
  if (!forceRefresh && !waitForFresh && hasCacheItems(cache)) {
    scheduleBackgroundRefresh(appConfig, { sourceKey, categoryPath, fetchImpl });
    return buildResponse({
      items: cache.items,
      updatedAt: cache.fetchedAt,
      stale: true,
      lastError: cache.lastError,
    });
  }

  // Cold cache, forceRefresh, or waitForFresh: await shared in-flight refresh.
  try {
    const refreshed = await ensureExcellentContentRefresh(appConfig, { sourceKey, categoryPath, fetchImpl });
    if (!refreshed || !hasCacheItems(refreshed)) {
      const error = new Error(EXCELLENT_PUBLIC_MESSAGES.PGY_EMPTY_RESULT);
      error.code = "PGY_EMPTY_RESULT";
      throw error;
    }
    return buildResponse({
      items: refreshed.items,
      updatedAt: refreshed.fetchedAt,
      stale: false,
      lastError: "",
    });
  } catch (error) {
    const message = mapExcellentContentError(error);
    if (hasCacheItems(cache)) {
      try {
        recordExcellentContentCacheError(sourceKey, categoryPath, message);
      } catch (_error) {
        // keep going
      }
    }
    if (allowStaleOnError && hasCacheItems(cache)) {
      return buildResponse({
        items: cache.items,
        updatedAt: cache.fetchedAt,
        stale: true,
        lastError: message,
      });
    }
    const publicError = new Error(message);
    publicError.code = error?.code || "EXCELLENT_CONTENT_UNAVAILABLE";
    publicError.statusCode = error?.statusCode || 502;
    throw publicError;
  }
}

async function warmExcellentContentCache(appConfig, options = {}) {
  return getExcellentContents(appConfig, {
    source: EXCELLENT_SOURCE_XHS_HOT,
    categoryPath: options.categoryPath || "",
    forceRefresh: true,
    allowStaleOnError: false,
    fetchImpl: options.fetchImpl,
  });
}

function __resetExcellentContentInFlightForTests() {
  inFlightRefreshes.clear();
}

module.exports = {
  EXCELLENT_SOURCE_XHS_HOT,
  EXCELLENT_WINDOW_DAYS,
  EXCELLENT_ORDER_BY,
  EXCELLENT_PAGE_SIZE,
  EXCELLENT_MAX_PAGES,
  EXCELLENT_LIMIT,
  EXCELLENT_PUBLIC_MESSAGES,
  filterRankAndLimitNotes,
  getExcellentContents,
  warmExcellentContentCache,
  getExcellentContentCacheTtlMs,
  mapExcellentContentError,
  __resetExcellentContentInFlightForTests,
};
