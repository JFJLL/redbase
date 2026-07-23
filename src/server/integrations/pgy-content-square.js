const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { withRetries } = require("../utils");

const PGY_ORIGIN = "https://pgy.xiaohongshu.com";
const PGY_REFERER = "https://pgy.xiaohongshu.com/microapp/creativity/inspire";
const PGY_CATEGORY_TREE_URL =
  "https://edith.xiaohongshu.com/api/pgy/content_square/attribute/item/detail?type=tree&itemKey=noteContentCategory&platform=1";
const PGY_HOT_NOTES_URL = "https://edith.xiaohongshu.com/api/pgy/content_square/search_note_v2";
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PGY_ROOT_CATEGORY = "内容类目";
const PGY_ROOT_INDUSTRY = "所属行业";
const PGY_MAX_CATEGORY_PATH_LENGTH = 180;
const DEFAULT_PGY_HOT_NOTES_PAGE_SIZE = 10;

const PGY_PUBLIC_MESSAGES = {
  PGY_NOT_CONFIGURED: "小红书蒲公英内容广场未配置，请在后台环境变量中配置 Pgy 登录态后再试。",
  PGY_AUTH_EXPIRED: "小红书蒲公英登录态已失效，请更新后台配置后再试。",
  PGY_EMPTY_RESULT: "当前小红书类目近3日暂无可用热点内容，请换一个类目或稍后重试。",
  PGY_API_ERROR: "小红书热点数据暂时不可用，请稍后重试。",
  PGY_NETWORK_ERROR: "小红书热点数据连接失败，请稍后重试。",
};

let cookieSourceCache = {
  key: "",
  expiresAt: 0,
  cookies: [],
  nextIndex: 0,
  expiredIndexes: new Set(),
};

function createPgyError(code, message, details = {}) {
  const error = new Error(message || PGY_PUBLIC_MESSAGES[code] || PGY_PUBLIC_MESSAGES.PGY_API_ERROR);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/((?:access-token|web_session|cookie|authorization|token|ticket|xsec|sign|session|sid)[^"'\s:=&]*)(["'\s:=]+)[^"',\s&]+/gi, "$1$2[redacted]")
    .replace(/([?&](?:access-token|web_session|token|ticket|xsec|sign|authorization|cookie|session|sid)[^=&]*=)[^&\s]+/gi, "$1[redacted]");
}

function getPgyPublicErrorMessage(error) {
  return PGY_PUBLIC_MESSAGES[error?.code] || PGY_PUBLIC_MESSAGES.PGY_API_ERROR;
}

function isPgyAuthError(statusCode, payload) {
  const message = String(payload?.msg || payload?.message || payload?.error || "").toLowerCase();
  return statusCode === 401 || statusCode === 403 || /login|登录|登陆|auth|unauthorized|forbidden|expired|过期/.test(message);
}

function normalizePgyCategoryPath(value, parentValue = "") {
  const raw = String(value || "").trim();
  const parent = String(parentValue || "").trim();
  if (!raw) return "";
  if (raw === PGY_ROOT_CATEGORY) return "";
  if (raw.startsWith(`${PGY_ROOT_CATEGORY}#`)) return raw.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);

  const normalizedRaw = raw
    .replace(/[\\/／＞>]+/g, "#")
    .split("#")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== PGY_ROOT_CATEGORY)
    .join("#");
  if (!normalizedRaw) return "";

  if (parent) {
    const normalizedParent = normalizePgyCategoryPath(parent);
    const parentSuffix = normalizedParent ? normalizedParent.replace(`${PGY_ROOT_CATEGORY}#`, "") : parent;
    const fullPath = `${PGY_ROOT_CATEGORY}#${parentSuffix}#${normalizedRaw}`
      .split("#")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part, index, all) => index === 0 || part !== all[index - 1])
      .join("#");
    return fullPath.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);
  }

  return `${PGY_ROOT_CATEGORY}#${normalizedRaw}`.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);
}

/**
 * Normalize Pgy taxonomy path with a fixed root label (内容类目 / 所属行业).
 * Empty or bare root returns "".
 */
function normalizePgyTaxonomyPath(value, rootLabel, parentValue = "") {
  const root = String(rootLabel || "").trim();
  const raw = String(value || "").trim();
  const parent = String(parentValue || "").trim();
  if (!root) return "";
  if (!raw) return "";
  if (raw === root) return "";
  if (raw.startsWith(`${root}#`)) return raw.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);

  const normalizedRaw = raw
    .replace(/[\\/／＞>]+/g, "#")
    .split("#")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== root)
    .join("#");
  if (!normalizedRaw) return "";

  if (parent) {
    const normalizedParent = normalizePgyTaxonomyPath(parent, root);
    const parentSuffix = normalizedParent ? normalizedParent.replace(`${root}#`, "") : parent;
    const fullPath = `${root}#${parentSuffix}#${normalizedRaw}`
      .split("#")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part, index, all) => index === 0 || part !== all[index - 1])
      .join("#");
    return fullPath.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);
  }

  return `${root}#${normalizedRaw}`.slice(0, PGY_MAX_CATEGORY_PATH_LENGTH);
}

function normalizePgyIndustryPath(value, parentValue = "") {
  return normalizePgyTaxonomyPath(value, PGY_ROOT_INDUSTRY, parentValue);
}

function buildPgyHotNotesPayload({
  categoryPath = "",
  industryPath = "",
  pageSize = DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  pageNum = 1,
  nd = "3",
  orderBy,
  sort,
  noteType,
  bizType,
  contentType,
} = {}) {
  const payload = {
    searchWord: "",
    pageSize: Number(pageSize) || DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
    pageNum: Number(pageNum) || 1,
    platform: 1,
    // Defaults preserve existing trend-analysis behavior unless callers override.
    bizType: bizType == null || bizType === "" ? "1" : String(bizType),
    orderBy: orderBy == null || orderBy === "" ? "premium_imp_num" : String(orderBy),
    nd: String(nd == null || nd === "" ? "3" : nd),
    sort: sort == null || sort === "" ? "desc" : String(sort),
  };
  // Pgy noteType: 1 = image/text notes, 2 = video. Only set when caller asks.
  if (noteType === 1 || noteType === 2 || noteType === "1" || noteType === "2") {
    payload.noteType = Number(noteType);
  }
  // contentType is Pgy 内容来源. Trend analysis leaves it unset. -1 means 全部 on the real page.
  if (contentType != null && contentType !== "" && String(contentType) !== "-1") {
    const asNum = Number(contentType);
    payload.contentType = Number.isFinite(asNum) ? asNum : String(contentType);
  }
  // Both 内容类目 and 所属行业 are sent as noteContentCategory with different path prefixes.
  const normalizedIndustryPath = normalizePgyIndustryPath(industryPath);
  const normalizedCategoryPath = normalizePgyCategoryPath(categoryPath);
  const taxonomyPath = normalizedIndustryPath || normalizedCategoryPath;
  if (taxonomyPath) {
    payload.noteContentCategory = taxonomyPath;
  }
  return payload;
}

function getPgyConfig(appConfig) {
  const pgy = appConfig?.pgy || {};
  const enabled = pgy.enabled === true || String(pgy.enabled || "").toLowerCase() === "true";
  return {
    enabled,
    cookie: String(pgy.cookie || "").trim(),
    cookieFile: String(pgy.cookieFile || "").trim(),
    userAgent: String(pgy.userAgent || DEFAULT_BROWSER_USER_AGENT).trim() || DEFAULT_BROWSER_USER_AGENT,
    timeoutMs: Number(pgy.timeoutMs || 20000),
    cacheTtlMs: Number(pgy.cacheTtlMs || 10 * 60 * 1000),
    ossEndpoint: String(pgy.ossEndpoint || "").trim(),
    ossBucket: String(pgy.ossBucket || "").trim(),
    ossObjectKey: String(pgy.ossObjectKey || "").trim(),
    ossAccessKeyId: String(pgy.ossAccessKeyId || "").trim(),
    ossAccessKeySecret: String(pgy.ossAccessKeySecret || "").trim(),
  };
}

function cookieObjectToHeader(cookies) {
  if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)) return "";
  return Object.entries(cookies)
    .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
    .filter(([key, value]) => key && value)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function normalizeCookieHeader(value) {
  if (!value) return "";
  if (typeof value === "object") return cookieObjectToHeader(value);
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("{")) {
    try {
      return cookieObjectToHeader(JSON.parse(text));
    } catch (error) {
      return text;
    }
  }
  return text.replace(/\r?\n+/g, "; ").replace(/\s*;\s*/g, "; ").trim();
}

function parseCookieTokenText(text) {
  return parseCookieTokenList(text)[0] || "";
}

function uniqueCookieHeaders(cookies) {
  return [...new Set(cookies.map((cookie) => normalizeCookieHeader(cookie)).filter(Boolean))];
}

function parseCookieTokenList(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  if (raw.startsWith("[") || (raw.startsWith("{") && !raw.includes("\n"))) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return uniqueCookieHeaders(parsed);
      return uniqueCookieHeaders([parsed]);
    } catch (error) {
      // Fall through to line-based parsing for JSONL token files.
    }
  }

  const cookies = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          cookies.push(...parsed);
        } else {
          cookies.push(parsed);
        }
      } catch (error) {
        // Ignore malformed lines; an empty result is reported as not configured.
      }
    } else if (trimmed.includes("=")) {
      cookies.push(trimmed);
    }
  }
  return uniqueCookieHeaders(cookies);
}

function isOssCookieSourceConfigured(pgy) {
  return Boolean(pgy.ossEndpoint && pgy.ossBucket && pgy.ossObjectKey && pgy.ossAccessKeyId && pgy.ossAccessKeySecret);
}

function buildOssObjectUrl(pgy) {
  const endpoint = new URL(pgy.ossEndpoint);
  const host = endpoint.hostname.startsWith(`${pgy.ossBucket}.`) ? endpoint.hostname : `${pgy.ossBucket}.${endpoint.hostname}`;
  const objectPath = pgy.ossObjectKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${endpoint.protocol}//${host}/${objectPath}`;
}

async function fetchOssCookieTokenText(pgy, fetchImpl = fetch) {
  const date = new Date().toUTCString();
  const canonicalResource = `/${pgy.ossBucket}/${pgy.ossObjectKey}`;
  const stringToSign = `GET\n\n\n${date}\n${canonicalResource}`;
  const signature = crypto.createHmac("sha1", pgy.ossAccessKeySecret).update(stringToSign).digest("base64");
  const response = await fetchImpl(buildOssObjectUrl(pgy), {
    method: "GET",
    headers: {
      Date: date,
      Authorization: `OSS ${pgy.ossAccessKeyId}:${signature}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw createPgyError("PGY_NOT_CONFIGURED", redactSensitiveText(`PGY_OSS_HTTP_${response.status}: ${text}`), {
      statusCode: response.status,
    });
  }
  return text;
}

async function readCookieFile(cookieFile) {
  const resolvedPath = path.resolve(cookieFile);
  return fs.readFile(resolvedPath, "utf8");
}

async function writeCookieFile(cookieFile, tokenText) {
  if (!cookieFile || !tokenText) return;
  const resolvedPath = path.resolve(cookieFile);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, tokenText, "utf8");
}

function buildPgyCookieSourceKey(pgy) {
  return JSON.stringify({
    cookieHash: pgy.cookie ? crypto.createHash("sha256").update(pgy.cookie).digest("hex") : "",
    cookieFile: pgy.cookieFile,
    ossEndpoint: pgy.ossEndpoint,
    ossBucket: pgy.ossBucket,
    ossObjectKey: pgy.ossObjectKey,
    ossAccessKeyId: pgy.ossAccessKeyId ? "configured" : "",
  });
}

function cachePgyCookiePool(sourceKey, pgy, cookies) {
  cookieSourceCache = {
    key: sourceKey,
    expiresAt: Date.now() + Math.max(1000, pgy.cacheTtlMs),
    cookies,
    nextIndex: 0,
    expiredIndexes: new Set(),
  };
  return cookieSourceCache;
}

async function resolvePgyCookiePool(appConfig, options = {}) {
  const pgy = getPgyConfig(appConfig);
  if (!pgy.enabled) {
    throw createPgyError("PGY_NOT_CONFIGURED");
  }

  const sourceKey = buildPgyCookieSourceKey(pgy);
  if (cookieSourceCache.key === sourceKey && cookieSourceCache.cookies.length && cookieSourceCache.expiresAt > Date.now()) {
    return cookieSourceCache;
  }

  let tokenText = "";
  const directCookies = parseCookieTokenList(pgy.cookie);
  if (directCookies.length) {
    return cachePgyCookiePool(sourceKey, pgy, directCookies);
  }

  const ossConfigured = isOssCookieSourceConfigured(pgy);
  let ossError = null;
  if (ossConfigured) {
    try {
      tokenText = await fetchOssCookieTokenText(pgy, options.fetchImpl);
      await writeCookieFile(pgy.cookieFile, tokenText);
    } catch (error) {
      ossError = error;
    }
  }

  if (pgy.cookieFile) {
    if (!tokenText) {
      try {
        tokenText = await readCookieFile(pgy.cookieFile);
      } catch (error) {
        if (ossError?.code) throw ossError;
        throw createPgyError("PGY_NOT_CONFIGURED");
      }
    }
  }

  if (!tokenText && ossError?.code) {
    throw ossError;
  }

  const cookies = parseCookieTokenList(tokenText);
  if (!cookies.length) {
    throw createPgyError("PGY_NOT_CONFIGURED");
  }
  return cachePgyCookiePool(sourceKey, pgy, cookies);
}

function hasAvailablePgyCookie(pool) {
  return pool.cookies.length > 0 && pool.expiredIndexes.size < pool.cookies.length;
}

function getNextPgyCookie(pool) {
  const cookieCount = pool.cookies.length;
  if (!cookieCount) return null;

  for (let checked = 0; checked < cookieCount; checked += 1) {
    const index = pool.nextIndex % cookieCount;
    pool.nextIndex = (index + 1) % cookieCount;
    if (!pool.expiredIndexes.has(index)) {
      return { cookie: pool.cookies[index], index };
    }
  }
  return null;
}

function markPgyCookieFailure(pool, selectedCookie, error) {
  if (error?.code !== "PGY_AUTH_EXPIRED" || !selectedCookie) return;
  pool.expiredIndexes.add(selectedCookie.index);
  if (!hasAvailablePgyCookie(pool)) {
    pool.expiresAt = 0;
  }
}

function isTransientPgyStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function shouldRetryPgyRequest(error, pool, attempts, maxAttempts) {
  if (attempts >= maxAttempts) return false;
  if (error?.code === "PGY_AUTH_EXPIRED") return hasAvailablePgyCookie(pool);
  if (error?.code === "PGY_NETWORK_ERROR") return true;
  if (error?.code === "PGY_API_ERROR" && isTransientPgyStatus(Number(error.statusCode || 0))) return true;
  return false;
}

async function resolvePgyCookieHeader(appConfig, options = {}) {
  const pool = await resolvePgyCookiePool(appConfig, options);
  return getNextPgyCookie(pool)?.cookie || "";
}

async function pgyFetchJson(appConfig, url, { method = "GET", body, fetchImpl = fetch } = {}) {
  const pgy = getPgyConfig(appConfig);
  const pool = await resolvePgyCookiePool(appConfig, { fetchImpl });
  const maxAttempts = Math.max(pool.cookies.length, 3);
  let lastError = null;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const selectedCookie = getNextPgyCookie(pool);
    if (!selectedCookie) break;
    try {
      return await pgyFetchJsonWithCookie(pgy, selectedCookie.cookie, url, { method, body, fetchImpl });
    } catch (error) {
      lastError = error;
      markPgyCookieFailure(pool, selectedCookie, error);
      if (!shouldRetryPgyRequest(error, pool, attempts, maxAttempts)) {
        throw error;
      }
    }
  }

  throw lastError || createPgyError("PGY_NOT_CONFIGURED");
}

async function pgyFetchJsonWithCookie(pgy, cookie, url, { method = "GET", body, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), pgy.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        origin: PGY_ORIGIN,
        referer: PGY_REFERER,
        "user-agent": pgy.userAgent,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      if (isPgyAuthError(response.status, payload)) {
        throw createPgyError("PGY_AUTH_EXPIRED", PGY_PUBLIC_MESSAGES.PGY_AUTH_EXPIRED, { statusCode: response.status });
      }
      throw createPgyError("PGY_API_ERROR", redactSensitiveText(payload?.msg || payload?.message || rawText || `PGY_HTTP_${response.status}`), {
        statusCode: response.status,
      });
    }

    if (!payload || payload.code !== 0 || payload.success === false) {
      if (isPgyAuthError(response.status, payload)) {
        throw createPgyError("PGY_AUTH_EXPIRED");
      }
      throw createPgyError("PGY_API_ERROR", redactSensitiveText(payload?.msg || payload?.message || "PGY_API_ERROR"));
    }

    return payload.data;
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === "AbortError") {
      throw createPgyError("PGY_NETWORK_ERROR", "PGY request timeout");
    }
    throw createPgyError("PGY_NETWORK_ERROR", redactSensitiveText(error?.message || "PGY network error"));
  } finally {
    clearTimeout(timeout);
  }
}

function getNodeLabel(node) {
  return String(node?.label || node?.itemName || node?.itemValue || node?.value || node?.name || "").trim();
}

function normalizePgyCategoryNode(node, parentPath = "") {
  const label = getNodeLabel(node);
  if (!label) return null;
  const rawValue = node?.itemValue || node?.value || label;
  const value = normalizePgyCategoryPath(rawValue, parentPath);
  const children = Array.isArray(node?.children)
    ? node.children.map((child) => normalizePgyCategoryNode(child, value || label)).filter(Boolean)
    : [];
  return {
    label,
    value,
    ...(children.length ? { children } : {}),
  };
}

function normalizePgyTaxonomyTree(rawTree, preferredRoot = PGY_ROOT_CATEGORY) {
  const preferred = String(preferredRoot || PGY_ROOT_CATEGORY).trim() || PGY_ROOT_CATEGORY;
  const rootSource = Array.isArray(rawTree)
    ? rawTree.find((item) => getNodeLabel(item) === preferred) ||
      rawTree.find((item) => getNodeLabel(item) === PGY_ROOT_CATEGORY) ||
      rawTree[0] ||
      {}
    : rawTree?.itemKey === "noteContentCategory" && rawTree?.itemValue
      ? rawTree
      : rawTree?.root || rawTree;
  const root = getNodeLabel(rootSource) || preferred;
  const children = Array.isArray(rootSource?.children)
    ? rootSource.children
        .map((child) => {
          if (root === PGY_ROOT_INDUSTRY) {
            const label = getNodeLabel(child);
            if (!label) return null;
            const rawValue = child?.itemValue || child?.value || label;
            const value = normalizePgyIndustryPath(rawValue, root);
            const nested = Array.isArray(child?.children)
              ? child.children
                  .map((grand) => {
                    const gLabel = getNodeLabel(grand);
                    if (!gLabel) return null;
                    const gRaw = grand?.itemValue || grand?.value || gLabel;
                    return {
                      label: gLabel,
                      value: normalizePgyIndustryPath(gRaw, value || root),
                    };
                  })
                  .filter(Boolean)
              : [];
            return {
              label,
              value,
              ...(nested.length ? { children: nested } : {}),
            };
          }
          return normalizePgyCategoryNode(child, root);
        })
        .filter(Boolean)
    : [];
  return {
    root,
    items: children,
  };
}

function normalizePgyCategoryTree(rawTree) {
  return normalizePgyTaxonomyTree(rawTree, PGY_ROOT_CATEGORY);
}

function normalizePgyIndustryTree(rawTree) {
  return normalizePgyTaxonomyTree(rawTree, PGY_ROOT_INDUSTRY);
}

function collectPgyCategoryValues(items, values = new Set()) {
  for (const item of items || []) {
    if (item?.value) values.add(item.value);
    if (Array.isArray(item?.children)) collectPgyCategoryValues(item.children, values);
  }
  return values;
}

function isPgyCategoryPathInTree(categoryPath, tree) {
  const normalized = normalizePgyCategoryPath(categoryPath);
  if (!normalized) return true;
  return collectPgyCategoryValues(tree?.items).has(normalized);
}

function isPgyIndustryPathInTree(industryPath, tree) {
  const normalized = normalizePgyIndustryPath(industryPath);
  if (!normalized) return true;
  return collectPgyCategoryValues(tree?.items).has(normalized);
}

function asHttps(url) {
  return String(url || "").replace(/^http:\/\//, "https://");
}

function normalizePgyHotNote(raw, index, categoryPath = "", options = {}) {
  const note = raw?.noteInfo || {};
  const user = raw?.userInfo || {};
  const allImageUrls = Array.isArray(note.noteImages)
    ? note.noteImages.map((image) => asHttps(image?.imageUrl)).filter(Boolean)
    : [];
  // Keep full ordered image list for carousel; never pad/repeat covers.
  const imageUrls = allImageUrls;
  const likeCount = Number(note.likeNum || 0);
  const favoriteCount = Number(note.favNum || 0);
  const commentCount = Number(note.cmtNum || 0);
  const noteId = String(note.noteId || "").trim();
  const board = String(options.board || options.sourceKey || "xhs_hot");
  const industryPath = normalizePgyIndustryPath(options.industryPath || "");
  const normalizedCategoryPath = industryPath
    ? ""
    : normalizePgyCategoryPath(categoryPath || options.categoryPath || "");
  const content =
    note.noteDesc != null
      ? String(note.noteDesc)
      : note.desc != null
        ? String(note.desc)
        : note.content != null
          ? String(note.content)
          : note.text != null
            ? String(note.text)
            : "";

  return {
    id: noteId,
    source: "pgy_content_square",
    sourceKey: board,
    board,
    sourceBucket: board === "ecommerce_hot" ? "ecommerce" : "xhs",
    categoryPath: normalizedCategoryPath,
    industryPath,
    contentSource: String(options.contentSource || ""),
    exposureRank: index + 1,
    rank: index + 1,
    noteId,
    title: String(note.title || "").replace(/\s+/g, " ").trim(),
    content: content.replace(/\s+/g, " ").trim(),
    noteType: Number(note.noteType) === 2 ? "video" : "image",
    publishTime: String(note.notePublishTime || ""),
    primaryCoverUrl: imageUrls[0] || "",
    coverUrls: allImageUrls.slice(0, 3),
    imageUrls,
    imageCount: allImageUrls.length,
    videoUrl: note.videoUrl ? asHttps(note.videoUrl) : "",
    videoDurationSeconds: Number(note.videoDuration || 0),
    metrics: {
      readCount: Number(note.readNum || 0),
      likeCount,
      favoriteCount,
      commentCount,
      engagementCount: likeCount + favoriteCount + commentCount,
    },
    author: {
      nickname: String(user.nickName || ""),
      fansCount: Number(user.fansNum || 0),
    },
    noteUrl: note.noteLink
      ? asHttps(note.noteLink)
      : noteId
        ? `https://www.xiaohongshu.com/explore/${noteId}`
        : "",
  };
}

function normalizePgyHotNotes(rawNotes, categoryPath = "", options = {}) {
  return (Array.isArray(rawNotes) ? rawNotes : [])
    .map((note, index) => normalizePgyHotNote(note, index, categoryPath, options))
    .filter((note) => note.title || note.primaryCoverUrl);
}

async function fetchPgyCategoryTree(appConfig, options = {}) {
  const data = await withRetries(
    () => pgyFetchJson(appConfig, PGY_CATEGORY_TREE_URL, { fetchImpl: options.fetchImpl }),
    { retries: 2, delayMs: 800 },
  );
  return normalizePgyCategoryTree(data);
}

async function fetchPgyIndustryTree(appConfig, options = {}) {
  const data = await withRetries(
    () => pgyFetchJson(appConfig, PGY_CATEGORY_TREE_URL, { fetchImpl: options.fetchImpl }),
    { retries: 2, delayMs: 800 },
  );
  return normalizePgyIndustryTree(data);
}

async function fetchPgyXhsHotNotes(appConfig, options = {}) {
  const categoryPath = normalizePgyCategoryPath(options.categoryPath || "");
  const industryPath = normalizePgyIndustryPath(options.industryPath || "");
  const payload = buildPgyHotNotesPayload({
    categoryPath: industryPath ? "" : categoryPath,
    industryPath,
    pageSize: options.pageSize || DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
    pageNum: options.pageNum || 1,
    nd: options.nd || "3",
    orderBy: options.orderBy,
    sort: options.sort,
    noteType: options.noteType,
    bizType: options.bizType,
    contentType: options.contentType,
  });
  const data = await withRetries(
    () =>
      pgyFetchJson(appConfig, PGY_HOT_NOTES_URL, {
        method: "POST",
        body: payload,
        fetchImpl: options.fetchImpl,
      }),
    { retries: 2, delayMs: 800 },
  );
  const rawNotes = data?.noteList || data?.list || data?.items || [];
  const notes = normalizePgyHotNotes(rawNotes, categoryPath, {
    board: options.board || options.sourceKey || "xhs_hot",
    categoryPath,
    industryPath,
    contentSource: options.contentSource || "",
  });
  if (!notes.length) {
    throw createPgyError("PGY_EMPTY_RESULT");
  }
  return {
    categoryPath,
    industryPath,
    pageInfo: data?.pageInfoDto || null,
    total: Number(data?.total || data?.pageInfoDto?.total || notes.length),
    notes,
    // Request-echo fields only — not confirmation that Pgy applied this sort.
    requestedBizType: payload.bizType,
    requestedOrderBy: payload.orderBy,
    requestedNd: payload.nd,
    requestedSort: payload.sort,
    requestedNoteType: payload.noteType,
    requestedContentType: payload.contentType,
  };
}

module.exports = {
  PGY_PUBLIC_MESSAGES,
  PGY_MAX_CATEGORY_PATH_LENGTH,
  PGY_ROOT_CATEGORY,
  PGY_ROOT_INDUSTRY,
  DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  buildPgyHotNotesPayload,
  normalizePgyCategoryPath,
  normalizePgyIndustryPath,
  normalizePgyTaxonomyPath,
  normalizePgyCategoryTree,
  normalizePgyIndustryTree,
  isPgyCategoryPathInTree,
  isPgyIndustryPathInTree,
  normalizeCookieHeader,
  parseCookieTokenList,
  parseCookieTokenText,
  normalizePgyHotNote,
  normalizePgyHotNotes,
  fetchPgyCategoryTree,
  fetchPgyIndustryTree,
  fetchPgyXhsHotNotes,
  getPgyPublicErrorMessage,
  redactSensitiveText,
};
