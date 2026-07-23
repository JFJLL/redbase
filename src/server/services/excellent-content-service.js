const {
  fetchPgyXhsHotNotes,
  fetchPgyCategoryTree,
  fetchPgyIndustryTree,
  getPgyPublicErrorMessage,
  normalizePgyCategoryPath,
  normalizePgyIndustryPath,
} = require("../integrations/pgy-content-square");
const {
  findExcellentContentCache,
  upsertExcellentContentCache,
  recordExcellentContentCacheError,
} = require("../db/repositories/excellent-content-cache-repository");

// Boards are Pgy content-square tabs. Do not confuse with contentSource (内容来源).
const EXCELLENT_BOARD_XHS_HOT = "xhs_hot";
const EXCELLENT_BOARD_ECOMMERCE_HOT = "ecommerce_hot";
const EXCELLENT_BOARD_DEFAULT = EXCELLENT_BOARD_XHS_HOT;

// Shared 内容来源 options (Pgy contentType). Both boards use the same mapping.
const EXCELLENT_CONTENT_SOURCES = Object.freeze([
  { value: "all", label: "全部", contentType: null },
  { value: "kol", label: "博主合作笔记", contentType: "1" },
  { value: "celebrity", label: "明星合作笔记", contentType: "2" },
  { value: "employee", label: "员工笔记", contentType: "3" },
  { value: "buyer", label: "买手笔记", contentType: "5" },
  { value: "professional", label: "专业号笔记", contentType: "6" },
  { value: "owner", label: "主理人笔记", contentType: "11" },
  { value: "user", label: "用户笔记", contentType: "12" },
]);

const EXCELLENT_CONTENT_BOARDS = Object.freeze({
  [EXCELLENT_BOARD_XHS_HOT]: Object.freeze({
    value: EXCELLENT_BOARD_XHS_HOT,
    label: "小红书热门",
    bizType: "1",
    taxonomyType: "category",
    taxonomyParam: "noteContentCategory",
  }),
  [EXCELLENT_BOARD_ECOMMERCE_HOT]: Object.freeze({
    value: EXCELLENT_BOARD_ECOMMERCE_HOT,
    label: "电商热门",
    bizType: "6",
    taxonomyType: "industry",
    taxonomyParam: "noteContentCategory",
  }),
});

// Backward-compatible aliases from V1 (board-only, single source).
const EXCELLENT_SOURCE_XHS_HOT = EXCELLENT_BOARD_XHS_HOT;
const EXCELLENT_SOURCE_DEFAULT = EXCELLENT_BOARD_DEFAULT;

const EXCELLENT_WINDOW_DAYS = 7;
const EXCELLENT_ORDER_BY = "premium_read_num";
const EXCELLENT_SORT = "desc";
const EXCELLENT_PAGE_SIZE = 20;
const EXCELLENT_MAX_PAGES = 3;
const EXCELLENT_LIMIT = 8;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const EXCELLENT_PUBLIC_MESSAGES = {
  PGY_EMPTY_RESULT: "当前筛选条件下近7日暂无可用图文内容，请切换筛选或稍后重试。",
  PGY_NETWORK_ERROR: "优秀内容暂时无法更新，请稍后重试。",
  PGY_API_ERROR: "优秀内容暂时无法更新，请稍后重试。",
  EXCELLENT_CONTENT_UNAVAILABLE: "优秀内容暂时不可用，请稍后重试。",
};

const inFlightRefreshes = new Map();
const industryTreeCache = { expiresAt: 0, tree: null };

function getExcellentContentBoard(boardValue) {
  const value = String(boardValue || "").trim();
  // Legacy V1 used source=xhs_hot for the only board.
  if (!value || value === EXCELLENT_BOARD_XHS_HOT || value === "xhs") {
    return EXCELLENT_CONTENT_BOARDS[EXCELLENT_BOARD_XHS_HOT];
  }
  return EXCELLENT_CONTENT_BOARDS[value] || null;
}

function getExcellentContentSource(sourceValue) {
  const value = String(sourceValue || "").trim();
  if (!value || value === "all" || value === EXCELLENT_BOARD_XHS_HOT) {
    // V1 called board "source=xhs_hot" meaning all content sources on xhs hot.
    if (value === EXCELLENT_BOARD_XHS_HOT) {
      return EXCELLENT_CONTENT_SOURCES[0];
    }
    return EXCELLENT_CONTENT_SOURCES[0];
  }
  return EXCELLENT_CONTENT_SOURCES.find((item) => item.value === value) || null;
}

function buildCacheSourceKey(board, contentSourceValue) {
  const boardKey = String(board || EXCELLENT_BOARD_DEFAULT).trim() || EXCELLENT_BOARD_DEFAULT;
  const source = String(contentSourceValue || "").trim();
  if (!source || source === "all") return boardKey;
  return `${boardKey}:${source}`;
}

function resolveTaxonomyPath(boardDef, { categoryPath = "", industryPath = "" } = {}) {
  if (!boardDef) return { categoryPath: "", industryPath: "", taxonomyPath: "" };
  if (boardDef.taxonomyType === "industry") {
    const path = normalizePgyIndustryPath(industryPath || "");
    return { categoryPath: "", industryPath: path, taxonomyPath: path };
  }
  const path = normalizePgyCategoryPath(categoryPath || "");
  return { categoryPath: path, industryPath: "", taxonomyPath: path };
}

function getExcellentContentCacheTtlMs(appConfig) {
  const configured = Number(appConfig?.pgy?.excellentContentCacheTtlMs || appConfig?.pgy?.cacheTtlMs || 0);
  if (Number.isFinite(configured) && configured >= 30 * 60 * 1000 && configured <= 24 * 60 * 60 * 1000) {
    return configured;
  }
  return DEFAULT_CACHE_TTL_MS;
}

function cacheKey(sourceKey, taxonomyPath) {
  return `${String(sourceKey || "")}::${String(taxonomyPath || "")}`;
}

function isCacheFresh(cache, nowMs = Date.now()) {
  if (!cache?.expiresAt) return false;
  const expiresMs = Date.parse(cache.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function hasCacheItems(cache) {
  return Array.isArray(cache?.items) && cache.items.length > 0;
}

function readOf(note) {
  return Number(note?.metrics?.readCount || 0);
}

function publishTimeMs(note) {
  const raw = String(note?.publishTime || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
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

function filterRankAndLimitNotes(notes, { board = EXCELLENT_BOARD_DEFAULT, sourceKey = "" } = {}) {
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
      board: note.board || board,
      source: note.source || "pgy_content_square",
      sourceKey: sourceKey || note.sourceKey || board,
      content: note.content != null ? String(note.content) : "",
      noteType: "image",
    });
  }
  imageNotes.sort((a, b) => {
    const readDiff = readOf(b) - readOf(a);
    if (readDiff !== 0) return readDiff;
    const timeDiff = publishTimeMs(b) - publishTimeMs(a);
    if (timeDiff !== 0) return timeDiff;
    return String(a.noteId).localeCompare(String(b.noteId));
  });
  return imageNotes.slice(0, EXCELLENT_LIMIT).map((note, index) => ({
    ...note,
    rank: index + 1,
  }));
}

async function fetchExcellentNotesFromPgy(
  appConfig,
  {
    board = EXCELLENT_BOARD_DEFAULT,
    categoryPath = "",
    industryPath = "",
    contentType = null,
    contentSource = "all",
    sourceKey = "",
    fetchImpl,
  } = {},
) {
  const boardDef = getExcellentContentBoard(board);
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }
  const taxonomy = resolveTaxonomyPath(boardDef, { categoryPath, industryPath });
  const cacheSourceKey = sourceKey || buildCacheSourceKey(boardDef.value, contentSource);
  const collected = [];

  for (let pageNum = 1; pageNum <= EXCELLENT_MAX_PAGES; pageNum += 1) {
    const page = await fetchPgyXhsHotNotes(appConfig, {
      board: boardDef.value,
      sourceKey: cacheSourceKey,
      categoryPath: taxonomy.categoryPath,
      industryPath: taxonomy.industryPath,
      pageSize: EXCELLENT_PAGE_SIZE,
      pageNum,
      nd: String(EXCELLENT_WINDOW_DAYS),
      orderBy: EXCELLENT_ORDER_BY,
      sort: EXCELLENT_SORT,
      noteType: 1,
      bizType: boardDef.bizType,
      contentType: contentType == null || contentType === "" ? undefined : contentType,
      contentSource,
      fetchImpl,
    });
    collected.push(
      ...(page.notes || []).map((note) => ({
        ...note,
        board: boardDef.value,
        sourceKey: cacheSourceKey,
        contentSource: contentSource === "all" ? "" : contentSource,
        categoryPath: taxonomy.categoryPath,
        industryPath: taxonomy.industryPath,
      })),
    );
    const imageCount = filterRankAndLimitNotes(collected, {
      board: boardDef.value,
      sourceKey: cacheSourceKey,
    }).length;
    if (imageCount >= EXCELLENT_LIMIT) break;
    const pageNotes = Array.isArray(page.notes) ? page.notes : [];
    if (pageNotes.length < EXCELLENT_PAGE_SIZE) break;
  }

  const items = filterRankAndLimitNotes(collected, {
    board: boardDef.value,
    sourceKey: cacheSourceKey,
  });
  if (!items.length) {
    const error = new Error(EXCELLENT_PUBLIC_MESSAGES.PGY_EMPTY_RESULT);
    error.code = "PGY_EMPTY_RESULT";
    throw error;
  }
  return items;
}

function listContentSourceFilters() {
  return EXCELLENT_CONTENT_SOURCES.map((item) => ({ value: item.value, label: item.label }));
}

function listBoardFilters() {
  return Object.values(EXCELLENT_CONTENT_BOARDS).map((item) => ({
    value: item.value,
    label: item.label,
  }));
}

function buildResponse({
  items,
  updatedAt,
  stale = false,
  lastError = "",
  board = EXCELLENT_BOARD_DEFAULT,
  contentSource = "all",
  categoryPath = "",
  industryPath = "",
} = {}) {
  const boardDef = getExcellentContentBoard(board) || EXCELLENT_CONTENT_BOARDS[EXCELLENT_BOARD_DEFAULT];
  return {
    board: boardDef.value,
    boardLabel: boardDef.label,
    items: Array.isArray(items) ? items : [],
    filters: {
      boards: listBoardFilters(),
      contentSources: listContentSourceFilters(),
      // V1 alias kept for older clients.
      sources: listBoardFilters(),
    },
    source: boardDef.value,
    contentSource: contentSource || "all",
    categoryPath: categoryPath || "",
    industryPath: industryPath || "",
    updatedAt: updatedAt || "",
    stale: Boolean(stale),
    windowDays: EXCELLENT_WINDOW_DAYS,
    noteType: "image",
    sort: "read_desc",
    lastError: lastError ? String(lastError).slice(0, 300) : "",
  };
}

function storeSuccessfulCache(appConfig, sourceKey, taxonomyPath, items) {
  const now = new Date();
  const ttlMs = getExcellentContentCacheTtlMs(appConfig);
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return upsertExcellentContentCache({
    sourceKey,
    categoryPath: taxonomyPath,
    items,
    fetchedAt: now.toISOString(),
    expiresAt,
    lastError: "",
  });
}

async function refreshExcellentContentCache(
  appConfig,
  { board, categoryPath, industryPath, contentType, contentSource, sourceKey, fetchImpl } = {},
) {
  const items = await fetchExcellentNotesFromPgy(appConfig, {
    board,
    categoryPath,
    industryPath,
    contentType,
    contentSource,
    sourceKey,
    fetchImpl,
  });
  const boardDef = getExcellentContentBoard(board);
  const taxonomy = resolveTaxonomyPath(boardDef, { categoryPath, industryPath });
  return storeSuccessfulCache(appConfig, sourceKey, taxonomy.taxonomyPath, items);
}

function ensureExcellentContentRefresh(appConfig, options = {}) {
  const boardDef = getExcellentContentBoard(options.board);
  const taxonomy = resolveTaxonomyPath(boardDef, options);
  const sourceKey =
    options.sourceKey || buildCacheSourceKey(boardDef?.value, options.contentSource);
  const key = cacheKey(sourceKey, taxonomy.taxonomyPath);
  let promise = inFlightRefreshes.get(key);
  if (!promise) {
    promise = refreshExcellentContentCache(appConfig, {
      ...options,
      sourceKey,
    }).finally(() => {
      inFlightRefreshes.delete(key);
    });
    inFlightRefreshes.set(key, promise);
  }
  return promise;
}

function scheduleBackgroundRefresh(appConfig, options = {}) {
  const boardDef = getExcellentContentBoard(options.board);
  const taxonomy = resolveTaxonomyPath(boardDef, options);
  const sourceKey =
    options.sourceKey || buildCacheSourceKey(boardDef?.value, options.contentSource);
  const promise = ensureExcellentContentRefresh(appConfig, { ...options, sourceKey });
  promise.catch((error) => {
    const message = mapExcellentContentError(error);
    try {
      recordExcellentContentCacheError(sourceKey, taxonomy.taxonomyPath, message);
    } catch (_error) {
      // Ignore cache write failures during background refresh.
    }
  });
  return promise;
}

async function getExcellentContents(appConfig, options = {}) {
  // Prefer explicit board; accept legacy source= as board id.
  const boardRaw = options.board || options.source || EXCELLENT_BOARD_DEFAULT;
  const boardDef = getExcellentContentBoard(boardRaw);
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }

  const contentSourceRaw = options.contentSource || options.contentSourceKey || "all";
  const sourceDef = getExcellentContentSource(contentSourceRaw);
  if (!sourceDef) {
    const error = new Error("暂不支持该内容来源。");
    error.code = "INVALID_SOURCE";
    error.statusCode = 400;
    throw error;
  }

  // Enforce taxonomy isolation: ignore the wrong path for each board.
  const taxonomy = resolveTaxonomyPath(boardDef, {
    categoryPath: boardDef.taxonomyType === "category" ? options.categoryPath || "" : "",
    industryPath: boardDef.taxonomyType === "industry" ? options.industryPath || "" : "",
  });

  const sourceKey = buildCacheSourceKey(boardDef.value, sourceDef.value);
  const forceRefresh = options.forceRefresh === true;
  const waitForFresh = options.waitForFresh === true;
  const allowStaleOnError = options.allowStaleOnError !== false;
  const fetchImpl = options.fetchImpl;
  const cache = findExcellentContentCache(sourceKey, taxonomy.taxonomyPath);

  const responseBase = {
    board: boardDef.value,
    contentSource: sourceDef.value,
    categoryPath: taxonomy.categoryPath,
    industryPath: taxonomy.industryPath,
  };

  if (!forceRefresh && hasCacheItems(cache) && isCacheFresh(cache)) {
    return buildResponse({
      items: cache.items,
      updatedAt: cache.fetchedAt,
      stale: false,
      lastError: cache.lastError,
      ...responseBase,
    });
  }

  if (!forceRefresh && !waitForFresh && hasCacheItems(cache)) {
    scheduleBackgroundRefresh(appConfig, {
      board: boardDef.value,
      categoryPath: taxonomy.categoryPath,
      industryPath: taxonomy.industryPath,
      contentType: sourceDef.contentType,
      contentSource: sourceDef.value,
      sourceKey,
      fetchImpl,
    });
    return buildResponse({
      items: cache.items,
      updatedAt: cache.fetchedAt,
      stale: true,
      lastError: cache.lastError,
      ...responseBase,
    });
  }

  try {
    const refreshed = await ensureExcellentContentRefresh(appConfig, {
      board: boardDef.value,
      categoryPath: taxonomy.categoryPath,
      industryPath: taxonomy.industryPath,
      contentType: sourceDef.contentType,
      contentSource: sourceDef.value,
      sourceKey,
      fetchImpl,
    });
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
      ...responseBase,
    });
  } catch (error) {
    const message = mapExcellentContentError(error);
    if (hasCacheItems(cache)) {
      try {
        recordExcellentContentCacheError(sourceKey, taxonomy.taxonomyPath, message);
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
        ...responseBase,
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
    board: options.board || options.source || EXCELLENT_BOARD_DEFAULT,
    contentSource: options.contentSource || "all",
    categoryPath: options.categoryPath || "",
    industryPath: options.industryPath || "",
    forceRefresh: true,
    allowStaleOnError: false,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Warm both default boards (all taxonomy + all content sources).
 * Throws / returns failed board if any default board cannot refresh strictly.
 */
async function warmAllExcellentContentBoards(appConfig, options = {}) {
  const boards = [EXCELLENT_BOARD_XHS_HOT, EXCELLENT_BOARD_ECOMMERCE_HOT];
  const results = [];
  for (const board of boards) {
    try {
      const result = await warmExcellentContentCache(appConfig, {
        board,
        contentSource: "all",
        fetchImpl: options.fetchImpl,
      });
      const count = Array.isArray(result?.items) ? result.items.length : 0;
      const stale = Boolean(result?.stale);
      const lastError = String(result?.lastError || "");
      const ok = !stale && !lastError && count > 0;
      results.push({
        board,
        ok,
        count,
        stale,
        updatedAt: result?.updatedAt || "",
        lastError: lastError || undefined,
      });
      if (!ok) {
        const error = new Error(`warm failed for board ${board}`);
        error.code = "WARM_BOARD_FAILED";
        error.boards = results;
        throw error;
      }
    } catch (error) {
      if (error?.boards) throw error;
      results.push({
        board,
        ok: false,
        count: 0,
        stale: true,
        updatedAt: "",
        lastError: mapExcellentContentError(error),
        code: error?.code || "WARM_BOARD_FAILED",
      });
      const wrapped = new Error(mapExcellentContentError(error));
      wrapped.code = error?.code || "WARM_BOARD_FAILED";
      wrapped.boards = results;
      throw wrapped;
    }
  }
  return { ok: true, boards: results };
}

function findNoteInCacheItems(cache, noteId) {
  if (!hasCacheItems(cache)) return null;
  const target = String(noteId || "").trim();
  if (!target) return null;
  const hit = cache.items.find((item) => String(item.noteId || item.id) === target);
  if (!hit) return null;
  return {
    item: hit,
    updatedAt: cache.fetchedAt || "",
    sourceKey: cache.sourceKey || "",
    taxonomyPath: cache.categoryPath != null ? String(cache.categoryPath) : "",
  };
}

/**
 * Prefer exact (sourceKey, taxonomyPath) cache for the list context that opened detail.
 * Safe fallbacks stay on the same board only: same sourceKey default taxonomy, then board:all default.
 * Never returns a note from another board even if noteId collides.
 */
function findNoteInCaches(
  noteId,
  board,
  { contentSource = "all", taxonomyPath = "" } = {},
) {
  const target = String(noteId || "").trim();
  if (!target) return null;
  const boardDef = getExcellentContentBoard(board);
  if (!boardDef) return null;
  const boardKey = boardDef.value;
  const sourceDef = getExcellentContentSource(contentSource);
  const resolvedSource = sourceDef ? sourceDef.value : "all";
  const exactSourceKey = buildCacheSourceKey(boardKey, resolvedSource);
  const exactTaxonomy = String(taxonomyPath || "");

  const exact = findNoteInCacheItems(findExcellentContentCache(exactSourceKey, exactTaxonomy), target);
  if (exact) {
    return { ...exact, sourceKey: exactSourceKey, taxonomyPath: exactTaxonomy, contentSource: resolvedSource };
  }

  // Fallback: same content source, default (empty) taxonomy — only if exact path was non-empty.
  if (exactTaxonomy) {
    const defaultTaxonomy = findNoteInCacheItems(findExcellentContentCache(exactSourceKey, ""), target);
    if (defaultTaxonomy) {
      return {
        ...defaultTaxonomy,
        sourceKey: exactSourceKey,
        taxonomyPath: "",
        contentSource: resolvedSource,
      };
    }
  }

  // Fallback: board "all" content source, default taxonomy (never another board).
  if (exactSourceKey !== boardKey) {
    const boardDefault = findNoteInCacheItems(findExcellentContentCache(boardKey, ""), target);
    if (boardDefault) {
      return { ...boardDefault, sourceKey: boardKey, taxonomyPath: "", contentSource: "all" };
    }
  }

  return null;
}

function noteHasCompleteImages(item) {
  if (!item) return false;
  const urls = Array.isArray(item.imageUrls) ? item.imageUrls.filter(Boolean) : [];
  if (!urls.length) return false;
  const count = Number(item.imageCount || 0);
  if (!Number.isFinite(count) || count <= 0) {
    // Unknown total: treat returned urls as usable, without claiming a verified total.
    return true;
  }
  return urls.length >= count;
}

function buildDetailMessage(item, complete) {
  const hasContent = Boolean(String(item?.content || "").trim());
  if (hasContent && complete) return "";
  if (!complete && urlsCount(item) > 0) {
    return "当前仅展示接口已返回的图片";
  }
  if (!hasContent && complete) return "";
  if (!hasContent) return "完整内容暂时无法加载";
  return "";
}

function urlsCount(item) {
  return Array.isArray(item?.imageUrls) ? item.imageUrls.filter(Boolean).length : 0;
}

/**
 * Detail strategy: list already carries full noteImages; return cache item.
 * No upstream detail API confirmed; never fabricate body/images.
 */
async function getExcellentContentDetail(
  appConfig,
  {
    noteId,
    board = EXCELLENT_BOARD_DEFAULT,
    contentSource = "all",
    categoryPath = "",
    industryPath = "",
  } = {},
) {
  const boardDef = getExcellentContentBoard(board);
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }
  const sourceDef = getExcellentContentSource(contentSource);
  if (!sourceDef) {
    const error = new Error("暂不支持该内容来源。");
    error.code = "INVALID_SOURCE";
    error.statusCode = 400;
    throw error;
  }
  const taxonomy = resolveTaxonomyPath(boardDef, { categoryPath, industryPath });
  const hit = findNoteInCaches(noteId, boardDef.value, {
    contentSource: sourceDef.value,
    taxonomyPath: taxonomy.taxonomyPath,
  });
  if (hit?.item) {
    const urls = Array.isArray(hit.item.imageUrls) ? hit.item.imageUrls.filter(Boolean) : [];
    const rawCount = Number(hit.item.imageCount || 0);
    const imageCount = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : urls.length;
    const complete = noteHasCompleteImages({ ...hit.item, imageUrls: urls, imageCount: rawCount });
    return {
      item: {
        ...hit.item,
        content: hit.item.content != null ? String(hit.item.content) : "",
        imageUrls: urls,
        imageCount,
      },
      board: boardDef.value,
      contentSource: hit.contentSource || sourceDef.value,
      taxonomyPath: hit.taxonomyPath != null ? hit.taxonomyPath : taxonomy.taxonomyPath,
      fromCache: true,
      complete,
      availableImageCount: urls.length,
      imageCount,
      updatedAt: hit.updatedAt || "",
      detailUnavailable: !String(hit.item.content || "").trim() && !complete,
      message: buildDetailMessage({ ...hit.item, imageUrls: urls }, complete),
    };
  }
  return {
    item: null,
    board: boardDef.value,
    contentSource: sourceDef.value,
    taxonomyPath: taxonomy.taxonomyPath,
    fromCache: false,
    complete: false,
    availableImageCount: 0,
    imageCount: 0,
    updatedAt: "",
    detailUnavailable: true,
    message: "完整内容暂时无法加载",
  };
}

async function getExcellentContentTaxonomy(appConfig, { board = EXCELLENT_BOARD_DEFAULT, fetchImpl } = {}) {
  const boardDef = getExcellentContentBoard(board);
  if (!boardDef) {
    const error = new Error("暂不支持该内容板块。");
    error.code = "INVALID_BOARD";
    error.statusCode = 400;
    throw error;
  }
  if (boardDef.taxonomyType === "industry") {
    if (industryTreeCache.tree && industryTreeCache.expiresAt > Date.now()) {
      return { board: boardDef.value, taxonomyType: "industry", tree: industryTreeCache.tree };
    }
    const tree = await fetchPgyIndustryTree(appConfig, { fetchImpl });
    industryTreeCache.tree = tree;
    industryTreeCache.expiresAt = Date.now() + 30 * 60 * 1000;
    return { board: boardDef.value, taxonomyType: "industry", tree };
  }
  const tree = await fetchPgyCategoryTree(appConfig, { fetchImpl });
  return { board: boardDef.value, taxonomyType: "category", tree };
}

function getExcellentContentSourcesList() {
  return {
    contentSources: listContentSourceFilters(),
  };
}

function __resetExcellentContentInFlightForTests() {
  inFlightRefreshes.clear();
  industryTreeCache.expiresAt = 0;
  industryTreeCache.tree = null;
}

module.exports = {
  EXCELLENT_CONTENT_BOARDS,
  EXCELLENT_CONTENT_SOURCES,
  EXCELLENT_BOARD_DEFAULT,
  EXCELLENT_BOARD_XHS_HOT,
  EXCELLENT_BOARD_ECOMMERCE_HOT,
  EXCELLENT_SOURCE_DEFAULT,
  EXCELLENT_SOURCE_XHS_HOT,
  EXCELLENT_WINDOW_DAYS,
  EXCELLENT_ORDER_BY,
  EXCELLENT_PAGE_SIZE,
  EXCELLENT_MAX_PAGES,
  EXCELLENT_LIMIT,
  EXCELLENT_PUBLIC_MESSAGES,
  DETAIL_CACHE_TTL_MS,
  getExcellentContentBoard,
  getExcellentContentSource,
  buildCacheSourceKey,
  filterRankAndLimitNotes,
  getExcellentContents,
  warmExcellentContentCache,
  warmAllExcellentContentBoards,
  getExcellentContentDetail,
  getExcellentContentTaxonomy,
  getExcellentContentSourcesList,
  getExcellentContentCacheTtlMs,
  mapExcellentContentError,
  noteHasCompleteImages,
  findNoteInCaches,
  __resetExcellentContentInFlightForTests,
};
