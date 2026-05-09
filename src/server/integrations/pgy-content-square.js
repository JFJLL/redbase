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
  cookie: "",
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

function buildPgyHotNotesPayload({ categoryPath = "", pageSize = DEFAULT_PGY_HOT_NOTES_PAGE_SIZE, pageNum = 1, nd = "3" } = {}) {
  const payload = {
    searchWord: "",
    pageSize: Number(pageSize) || DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
    pageNum: Number(pageNum) || 1,
    platform: 1,
    bizType: "1",
    orderBy: "premium_imp_num",
    nd: String(nd || "3"),
    sort: "desc",
  };
  const normalizedCategoryPath = normalizePgyCategoryPath(categoryPath);
  if (normalizedCategoryPath) {
    payload.noteContentCategory = normalizedCategoryPath;
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
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "";
    return normalizeCookieHeader(parsed.find((item) => item && typeof item === "object") || "");
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) return normalizeCookieHeader(JSON.parse(trimmed));
    if (trimmed.includes("=")) return normalizeCookieHeader(trimmed);
  }
  return "";
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

async function resolvePgyCookieHeader(appConfig, options = {}) {
  const pgy = getPgyConfig(appConfig);
  if (!pgy.enabled) {
    throw createPgyError("PGY_NOT_CONFIGURED");
  }
  const directCookie = normalizeCookieHeader(pgy.cookie);
  if (directCookie) return directCookie;

  const sourceKey = JSON.stringify({
    cookieFile: pgy.cookieFile,
    ossEndpoint: pgy.ossEndpoint,
    ossBucket: pgy.ossBucket,
    ossObjectKey: pgy.ossObjectKey,
    ossAccessKeyId: pgy.ossAccessKeyId ? "configured" : "",
  });
  if (cookieSourceCache.key === sourceKey && cookieSourceCache.cookie && cookieSourceCache.expiresAt > Date.now()) {
    return cookieSourceCache.cookie;
  }

  let tokenText = "";
  if (pgy.cookieFile) {
    try {
      tokenText = await readCookieFile(pgy.cookieFile);
    } catch (error) {
      if (!isOssCookieSourceConfigured(pgy)) {
        throw createPgyError("PGY_NOT_CONFIGURED");
      }
    }
  }
  if (!tokenText && isOssCookieSourceConfigured(pgy)) {
    tokenText = await fetchOssCookieTokenText(pgy, options.fetchImpl);
  }

  const cookie = parseCookieTokenText(tokenText);
  if (!cookie) {
    throw createPgyError("PGY_NOT_CONFIGURED");
  }
  cookieSourceCache = {
    key: sourceKey,
    expiresAt: Date.now() + Math.max(1000, pgy.cacheTtlMs),
    cookie,
  };
  return cookie;
}

async function pgyFetchJson(appConfig, url, { method = "GET", body, fetchImpl = fetch } = {}) {
  const pgy = getPgyConfig(appConfig);
  const cookie = await resolvePgyCookieHeader(appConfig, { fetchImpl });
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

function normalizePgyCategoryTree(rawTree) {
  const rootSource = Array.isArray(rawTree)
    ? rawTree.find((item) => getNodeLabel(item) === PGY_ROOT_CATEGORY) || rawTree[0] || {}
    : rawTree?.itemKey === "noteContentCategory" && rawTree?.itemValue
      ? rawTree
      : rawTree?.root || rawTree;
  const root = getNodeLabel(rootSource) || PGY_ROOT_CATEGORY;
  const children = Array.isArray(rootSource?.children)
    ? rootSource.children.map((child) => normalizePgyCategoryNode(child, root)).filter(Boolean)
    : [];
  return {
    root,
    items: children,
  };
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

function asHttps(url) {
  return String(url || "").replace(/^http:\/\//, "https://");
}

function normalizePgyHotNote(raw, index, categoryPath = "") {
  const note = raw?.noteInfo || {};
  const user = raw?.userInfo || {};
  const imageUrls = Array.isArray(note.noteImages)
    ? note.noteImages.map((image) => asHttps(image?.imageUrl)).filter(Boolean)
    : [];
  const likeCount = Number(note.likeNum || 0);
  const favoriteCount = Number(note.favNum || 0);
  const commentCount = Number(note.cmtNum || 0);
  const noteId = String(note.noteId || "").trim();

  return {
    source: "pgy_content_square",
    sourceBucket: "xhs",
    categoryPath: normalizePgyCategoryPath(categoryPath),
    exposureRank: index + 1,
    noteId,
    title: String(note.title || "").replace(/\s+/g, " ").trim(),
    noteType: Number(note.noteType) === 2 ? "video" : "image",
    publishTime: String(note.notePublishTime || ""),
    primaryCoverUrl: imageUrls[0] || "",
    coverUrls: imageUrls.slice(0, 3),
    imageCount: imageUrls.length,
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
    noteUrl: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : "",
  };
}

function normalizePgyHotNotes(rawNotes, categoryPath = "") {
  return (Array.isArray(rawNotes) ? rawNotes : [])
    .map((note, index) => normalizePgyHotNote(note, index, categoryPath))
    .filter((note) => note.title || note.primaryCoverUrl);
}

async function fetchPgyCategoryTree(appConfig, options = {}) {
  const data = await withRetries(
    () => pgyFetchJson(appConfig, PGY_CATEGORY_TREE_URL, { fetchImpl: options.fetchImpl }),
    { retries: 2, delayMs: 800 },
  );
  return normalizePgyCategoryTree(data);
}

async function fetchPgyXhsHotNotes(appConfig, options = {}) {
  const categoryPath = normalizePgyCategoryPath(options.categoryPath || "");
  const payload = buildPgyHotNotesPayload({
    categoryPath,
    pageSize: options.pageSize || DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
    pageNum: options.pageNum || 1,
    nd: options.nd || "3",
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
  const notes = normalizePgyHotNotes(rawNotes, categoryPath);
  if (!notes.length) {
    throw createPgyError("PGY_EMPTY_RESULT");
  }
  return {
    categoryPath,
    pageInfo: data?.pageInfoDto || null,
    total: Number(data?.total || data?.pageInfoDto?.total || notes.length),
    notes,
  };
}

module.exports = {
  PGY_PUBLIC_MESSAGES,
  PGY_MAX_CATEGORY_PATH_LENGTH,
  DEFAULT_PGY_HOT_NOTES_PAGE_SIZE,
  buildPgyHotNotesPayload,
  normalizePgyCategoryPath,
  normalizePgyCategoryTree,
  isPgyCategoryPathInTree,
  normalizeCookieHeader,
  parseCookieTokenText,
  normalizePgyHotNote,
  normalizePgyHotNotes,
  fetchPgyCategoryTree,
  fetchPgyXhsHotNotes,
  getPgyPublicErrorMessage,
  redactSensitiveText,
};
