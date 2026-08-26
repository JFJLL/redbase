const XINGTU_CONTENT_MARKET_URL = "https://www.xingtu.cn/ad/creator/insight/content-market";
const { normalizeCookieHeader } = require("../integrations/pgy-content-square");

const XINGTU_TRANSCRIPT_ENDPOINT = "https://www.xingtu.cn/gw/api/aggregator/get_item_high_quality_text";
const DOUYIN_MEDIA_REFERER = "https://www.douyin.com/";
const XINGTU_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_TRANSCRIPT_SEGMENTS = 360;
const MAX_TRANSCRIPT_TEXT_LENGTH = 300000;
const TRANSCRIPT_TIMEOUT_MS = 12000;
const MEDIA_TIMEOUT_MS = 25000;
const MAX_MEDIA_REDIRECTS = 4;

/**
 * A public, display-only catalogue sampled from the official content market.
 * It is deliberately not persisted in SQLite and contains no media binaries.
 * Playback, original-detail navigation, and transcripts always point to official
 * ByteDance / Xingtu locations at request time.
 */
const XINGTU_PUBLIC_VIDEO_CATALOG = [
  {
    id: "7668915619579890982",
    videoId: "v0200fg10000d9mn6bnog65ilu24kt70",
    title: "爱是彼此成就，也是一直并肩",
    author: { nickname: "李默", followerCount: 2327609 },
    category: "生活记录",
    duration: 277.8,
    metrics: { viewCount: 15169673, likeCount: 525277, commentCount: 14390, shareCount: 88912, interactCount: 628579, finishRate: 0.054926, interactRate: 0.041437 },
    coverUri: "tos-cn-p-0015/og6fFf6wDAzqFsiAuaE5XCQqbBCQXcUglE9IMA",
  },
  {
    id: "7675709137612013818",
    videoId: "v2800fgi0000da2p2vvog65i8assau70",
    title: "牛来听完这故事，哭着喊着说不来了",
    author: { nickname: "李炮儿", followerCount: 21868004 },
    category: "剧情",
    duration: 335.667,
    metrics: { viewCount: 74917550, likeCount: 2317110, commentCount: 741790, shareCount: 783261, interactCount: 3842161, finishRate: 0.19716, interactRate: 0.051285 },
    coverUri: "tos-cn-p-0015c000-ce/owOFfegCfAI2SLCjCD7VXMDOmEJQFBQKhy1Iok",
  },
  {
    id: "7670760000323334479",
    videoId: "v0300fg10000d9q03avog65n6l45kutg",
    title: "新疆女孩花期都很短么",
    author: { nickname: "乌上高高", followerCount: 2987439 },
    category: "剧情",
    duration: 151.952,
    metrics: { viewCount: 49516675, likeCount: 1475469, commentCount: 62142, shareCount: 389249, interactCount: 1926860, finishRate: 0.086363, interactRate: 0.038913 },
    coverUri: "tos-cn-p-0015/o40pgdDBhIqQFh0GvDfB9arH5ueIAAACAEA7ZE",
  },
  {
    id: "7666739604120227110",
    videoId: "v0300fg10000d9iri3fog65oegdidtv0",
    title: "以为是玩水，结果上来就被吓到",
    author: { nickname: "辣椒爱吃静静", followerCount: 1250567 },
    category: "旅行",
    duration: 168.601,
    metrics: { viewCount: 72101347, likeCount: 846795, commentCount: 19072, shareCount: 89612, interactCount: 955479, finishRate: 0.133305, interactRate: 0.013252 },
    coverUri: "tos-cn-p-0015/oMZAeBEbVWDB9ig7k6FNFblAfwDQ1qIAuZINDu",
  },
  {
    id: "7667764205303711205",
    videoId: "v1e00fgi0000d9klthnog65sel2kqt9g",
    title: "bro 小时候的日常",
    author: { nickname: "阿志潮游", followerCount: 36203 },
    category: "游戏",
    duration: 19.668,
    metrics: { viewCount: 8808805, likeCount: 419928, commentCount: 10016, shareCount: 163526, interactCount: 593470, finishRate: 0.22529, interactRate: 0.067372 },
    coverUri: "tos-cn-p-0015c000-ce/ogdiTACNEqeeBebxZv8dpIKV1uAXUBvPNBiwAE",
  },
  {
    id: "7676313493305396507",
    videoId: "v0200fg10000da3gmjnog65ulculveg0",
    title: "我正在思考：一块绘画板能带来什么",
    author: { nickname: "模子大人", followerCount: 1110607 },
    category: "艺术",
    duration: 225.17,
    metrics: { viewCount: 6555254, likeCount: 461001, commentCount: 9676, shareCount: 452881, interactCount: 923558, finishRate: 0.073062, interactRate: 0.140888 },
    coverUri: "tos-cn-p-0015/o4g99hEiqxVAtHC6AntOC9gIDfArFABufB7qwI",
  },
  {
    id: "7670014202929847014",
    videoId: "v0200fg10000d9olnd7og65g14qub9sg",
    title: "乌鲁木齐本地人私藏的过油肉拌面",
    author: { nickname: "达哥在上海", followerCount: 8493035 },
    category: "美食",
    duration: 358.422,
    metrics: { viewCount: 16404322, likeCount: 426763, commentCount: 12428, shareCount: 84604, interactCount: 523795, finishRate: 0.02912, interactRate: 0.03193 },
    coverUri: "tos-cn-p-0015/o4PAxIIwtTBbFpCQxDCdAEa5X8xlsgXiUpinP",
  },
  {
    id: "7669984794951894001",
    videoId: "v2700fgi0000d9ojocnog65r0v11k2tg",
    title: "下次再也不会去了，差点又被丢下",
    author: { nickname: "小糯汤", followerCount: 311742 },
    category: "体育",
    duration: 132.567,
    metrics: { viewCount: 7474084, likeCount: 183422, commentCount: 12270, shareCount: 82999, interactCount: 278691, finishRate: 0.285236, interactRate: 0.037288 },
    coverUri: "tos-cn-p-0015c000-ce/ocaEAjnNE8B8ionEV8xBIx77PaQIAviMEZCMD",
  },
];

function normalizeItemId(value) {
  const itemId = String(value || "").trim();
  if (!/^\d{12,24}$/.test(itemId)) {
    const error = new Error("巨量星图视频标识无效。");
    error.code = "INVALID_XINGTU_ITEM_ID";
    error.statusCode = 400;
    throw error;
  }
  return itemId;
}

function officialCoverUrl(coverUri) {
  const uri = String(coverUri || "").replace(/^\/+/, "");
  // Match the public content-market card URL exactly. The browser requests this
  // official image URL directly; it is neither proxied nor persisted by RedBase.
  return uri ? `https://p3-star.byteimg.com/img/${uri}~tplv-resize:400:0.webp` : "";
}

function officialVideoPageUrl(itemId) {
  return `https://www.douyin.com/video/${encodeURIComponent(normalizeItemId(itemId))}`;
}

function officialMediaUrl(videoId) {
  const normalized = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(normalized)) return "";
  return `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(normalized)}&ratio=720p&line=0`;
}

function xingtuCookie(value = "") {
  return normalizeCookieHeader(value || process.env.XINGTU_COOKIE || "");
}

function xingtuRequestHeaders(targetUrl, { range = "", cookie = "" } = {}) {
  const target = new URL(targetUrl);
  const host = target.hostname.toLowerCase();
  const isDouyinMedia = host === "douyin.com"
    || host.endsWith(".douyin.com")
    || host === "iesdouyin.com"
    || host.endsWith(".iesdouyin.com")
    || host.endsWith(".douyinvod.com")
    || host.endsWith(".zjcdn.com");
  const headers = {
    Accept: "*/*",
    "User-Agent": XINGTU_BROWSER_USER_AGENT,
    // The video CDN validates a Douyin referer. Xingtu's referer works for its
    // own API, but produces a 403 after the public media endpoint redirects.
    Referer: isDouyinMedia ? DOUYIN_MEDIA_REFERER : XINGTU_CONTENT_MARKET_URL,
  };
  if (range) headers.Range = String(range).slice(0, 256);
  // Cookie only ever goes to official xingtu.cn hosts. Redirected media/CDN
  // hosts never receive it, so the application cannot leak the session token.
  if (target.hostname === "xingtu.cn" || target.hostname.endsWith(".xingtu.cn")) {
    const normalizedCookie = xingtuCookie(cookie);
    if (normalizedCookie) headers.Cookie = normalizedCookie;
  }
  return headers;
}

function isAllowedOfficialResourceUrl(value) {
  let target;
  try {
    target = new URL(value);
  } catch (_error) {
    return false;
  }
  if (target.protocol !== "https:") return false;
  const host = target.hostname.toLowerCase();
  return host === "xingtu.cn"
    || host.endsWith(".xingtu.cn")
    || host === "iesdouyin.com"
    || host.endsWith(".iesdouyin.com")
    || host.endsWith(".byteimg.com")
    || host.endsWith(".douyinvod.com")
    || host.endsWith(".douyinpic.com")
    || host.endsWith(".zjcdn.com")
    || host.endsWith(".bytecdn.cn");
}

function upstreamMediaError(message, code = "XINGTU_MEDIA_UPSTREAM_ERROR") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 502;
  return error;
}

async function requestOfficialResource(targetUrl, { fetchImpl = global.fetch, range = "", cookie = "" } = {}) {
  if (typeof fetchImpl !== "function") {
    const error = new Error("当前运行环境不支持读取官方媒体资源。");
    error.code = "XINGTU_FETCH_UNAVAILABLE";
    throw error;
  }
  let currentUrl = String(targetUrl || "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    for (let redirectCount = 0; redirectCount <= MAX_MEDIA_REDIRECTS; redirectCount += 1) {
      if (!isAllowedOfficialResourceUrl(currentUrl)) {
        throw upstreamMediaError("官方媒体地址不在允许范围内。", "XINGTU_MEDIA_HOST_REJECTED");
      }
      const response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: xingtuRequestHeaders(currentUrl, { range, cookie }),
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location) throw upstreamMediaError("官方媒体重定向缺少目标地址。");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw upstreamMediaError(`官方媒体资源暂时不可用（${response.status}）。`);
      }
      return response;
    }
    throw upstreamMediaError("官方媒体重定向次数过多。", "XINGTU_MEDIA_REDIRECT_LIMIT");
  } catch (error) {
    if (error?.name === "AbortError") throw upstreamMediaError("官方媒体请求超时。", "XINGTU_MEDIA_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestOfficialCover(item, options = {}) {
  const url = officialCoverUrl(item?.coverUri);
  if (!url) {
    const error = new Error("该视频暂无可用封面。");
    error.code = "XINGTU_COVER_UNAVAILABLE";
    error.statusCode = 404;
    throw error;
  }
  return requestOfficialResource(url, options);
}

function escapeSvgText(value) {
  return String(value || "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  }[character]));
}

function splitCoverTitle(value, maxCharacters = 15) {
  const text = String(value || "视频预览").replace(/\s+/g, " ").trim();
  const rows = [];
  for (let index = 0; index < text.length && rows.length < 2; index += maxCharacters) {
    const row = text.slice(index, index + maxCharacters);
    rows.push(index + maxCharacters < text.length && rows.length === 1 ? `${row}…` : row);
  }
  return rows.length ? rows : ["视频预览"];
}

function buildXingtuPreviewCover(item) {
  const titleRows = splitCoverTitle(item?.title).map(escapeSvgText);
  const category = escapeSvgText(item?.category || "精选视频");
  const author = escapeSvgText(item?.author?.nickname || "内容创作者");
  const titleSvg = titleRows.map((row, index) => `<text x="42" y="${306 + index * 46}" fill="#ffffff" font-family="Arial, Microsoft YaHei, sans-serif" font-size="30" font-weight="700">${row}</text>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 960" role="img" aria-label="${escapeSvgText(item?.title || "视频预览")}">\n  <defs>\n    <linearGradient id="background" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#161923"/><stop offset=".55" stop-color="#24202a"/><stop offset="1" stop-color="#a92e41"/></linearGradient>\n    <radialGradient id="glow" cx="1" cy="0" r=".9"><stop stop-color="#ed6c76" stop-opacity=".85"/><stop offset="1" stop-color="#ed6c76" stop-opacity="0"/></radialGradient>\n  </defs>\n  <rect width="720" height="960" rx="28" fill="url(#background)"/>\n  <rect width="720" height="960" rx="28" fill="url(#glow)"/>\n  <path d="M0 684C174 612 382 746 720 634V960H0Z" fill="#ffffff" fill-opacity=".055"/>\n  <rect x="42" y="42" width="126" height="42" rx="21" fill="#ffffff" fill-opacity=".14"/>\n  <text x="64" y="70" fill="#ffffff" font-family="Arial, Microsoft YaHei, sans-serif" font-size="18" font-weight="700">${category}</text>\n  <circle cx="360" cy="430" r="68" fill="#ffffff" fill-opacity=".15" stroke="#ffffff" stroke-opacity=".55" stroke-width="2"/>\n  <path d="M342 392L400 430L342 468Z" fill="#ffffff"/>\n  ${titleSvg}\n  <text x="42" y="438" fill="#ffffff" fill-opacity=".68" font-family="Arial, Microsoft YaHei, sans-serif" font-size="18">${author}</text>\n  <rect x="42" y="844" width="196" height="2" fill="#ffffff" fill-opacity=".62"/>\n  <text x="42" y="890" fill="#ffffff" fill-opacity=".7" font-family="Arial, Microsoft YaHei, sans-serif" font-size="16" letter-spacing="3">视频洞察</text>\n</svg>`;
}

async function requestOfficialMedia(item, options = {}) {
  const url = officialMediaUrl(item?.videoId);
  if (!url) {
    const error = new Error("该视频暂无可用播放地址。");
    error.code = "XINGTU_MEDIA_UNAVAILABLE";
    error.statusCode = 404;
    throw error;
  }
  return requestOfficialResource(url, options);
}

function officialTranscriptUrl(itemId) {
  return `${XINGTU_TRANSCRIPT_ENDPOINT}?item_id=${encodeURIComponent(normalizeItemId(itemId))}`;
}

function normalizeCatalogItem(item, index) {
  const id = normalizeItemId(item.id);
  return {
    id,
    itemId: id,
    rank: index + 1,
    platform: "xingtu",
    noteType: "video",
    title: item.title,
    category: item.category,
    duration: Number(item.duration || 0),
    author: { ...item.author },
    metrics: { ...item.metrics },
    coverUrl: `/api/xingtu/videos/${encodeURIComponent(id)}/cover`,
    coverUri: item.coverUri,
    videoId: item.videoId,
    videoType: String(item.videoType || "自然视频"),
    playerUrl: `/api/xingtu/videos/${encodeURIComponent(id)}/media`,
    videoUrl: officialVideoPageUrl(id),
    officialContentMarketUrl: XINGTU_CONTENT_MARKET_URL,
    transcriptUrl: officialTranscriptUrl(id),
  };
}

function getXingtuPublicVideoCatalog() {
  return XINGTU_PUBLIC_VIDEO_CATALOG.map(normalizeCatalogItem);
}

function getXingtuVideoMediaSource(itemId) {
  const normalizedId = normalizeItemId(itemId);
  return XINGTU_PUBLIC_VIDEO_CATALOG.find((item) => String(item.id) === normalizedId) || null;
}

function normalizeTranscriptSegments(rawTexts) {
  const segments = [];
  const seen = new Set();
  for (const value of Array.isArray(rawTexts) ? rawTexts : []) {
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) break;
    const text = String(value?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startMs = Math.max(0, Number(value?.start_time || 0));
    const endMs = Math.max(startMs, Number(value?.end_time || startMs));
    const fingerprint = `${startMs}:${endMs}:${text}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    segments.push({ startMs, endMs, text });
  }
  return segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

async function requestOfficialTranscript(itemId, { fetchImpl = global.fetch, cookie = "" } = {}) {
  const normalizedId = normalizeItemId(itemId);
  if (typeof fetchImpl !== "function") {
    const error = new Error("当前运行环境不支持读取官方视频文稿。");
    error.code = "XINGTU_FETCH_UNAVAILABLE";
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(officialTranscriptUrl(normalizedId), {
      method: "GET",
      headers: {
        ...xingtuRequestHeaders(officialTranscriptUrl(normalizedId), { cookie }),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`官方视频文稿暂时不可用（${response.status}）。`);
      error.code = "XINGTU_TRANSCRIPT_UPSTREAM_ERROR";
      error.statusCode = 502;
      throw error;
    }
    const rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_TRANSCRIPT_TEXT_LENGTH * 4) {
      const error = new Error("官方视频文稿响应过大。");
      error.code = "XINGTU_TRANSCRIPT_TOO_LARGE";
      error.statusCode = 502;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      const error = new Error("官方视频文稿返回格式异常。");
      error.code = "XINGTU_TRANSCRIPT_INVALID_RESPONSE";
      error.statusCode = 502;
      throw error;
    }
    const statusCode = Number(payload?.base_resp?.status_code || 0);
    if (statusCode !== 0) {
      const error = new Error(payload?.base_resp?.status_message || "官方暂无可用视频文稿。");
      error.code = "XINGTU_TRANSCRIPT_UNAVAILABLE";
      error.statusCode = 502;
      throw error;
    }
    const segments = normalizeTranscriptSegments(payload?.texts);
    return {
      itemId: normalizedId,
      available: segments.length > 0,
      segments,
      sourceUrl: officialTranscriptUrl(normalizedId),
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("读取官方视频文稿超时，请稍后重试。");
      timeoutError.code = "XINGTU_TRANSCRIPT_TIMEOUT";
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function pickText(segments, fromRatio, toRatio) {
  const lastEnd = Math.max(...segments.map((segment) => segment.endMs), 1);
  const start = lastEnd * fromRatio;
  const end = lastEnd * toRatio;
  const seen = new Set();
  return segments
    .filter((segment) => segment.endMs >= start && segment.startMs <= end)
    .map((segment) => segment.text)
    .filter((text) => !seen.has(text) && seen.add(text))
    .slice(0, 4)
    .join(" / ");
}

function buildTranscriptLearningAnalysis({ item, transcript }) {
  const segments = transcript?.segments || [];
  if (!segments.length) {
    return {
      available: false,
      title: "官方暂无视频文稿",
      summary: "该视频可以继续在官方页面播放和查看数据；因为官方未返回文稿，本次不生成基于文稿的脚本结构学习。",
      disclaimer: "不会复制原视频、原台词或原素材。",
      structure: [],
      learningPoints: [],
      originalGuidance: [],
    };
  }
  const durationMs = Math.max(Number(item?.duration || 0) * 1000, ...segments.map((segment) => segment.endMs), 1);
  const totalCharacters = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  const wordsPerMinute = Math.round((totalCharacters / durationMs) * 60000);
  const hook = pickText(segments, 0, 0.12);
  const development = pickText(segments, 0.12, 0.82);
  const resolution = pickText(segments, 0.82, 1);
  const hasQuestion = segments.some((segment) => /[？?]/.test(segment.text));
  const hasNumber = segments.some((segment) => /\d/.test(segment.text));
  const finishRate = Number(item?.metrics?.finishRate || 0);
  const interactionRate = Number(item?.metrics?.interactRate || 0);
  const paceLabel = wordsPerMinute >= 270 ? "高信息密度" : wordsPerMinute >= 170 ? "中高信息密度" : "留白较多的叙事节奏";
  return {
    available: true,
    title: "视频结构学习建议",
    summary: `基于 ${segments.length} 段官方文稿和约 ${Math.round(durationMs / 1000)} 秒视频时长，这条内容呈现 ${paceLabel}（约 ${wordsPerMinute} 字/分钟）。重点学习其叙事方法与信息节奏，而非复用具体表达。`,
    disclaimer: "分析仅基于官方返回的文稿和公开数据；请以自己的经历、观点、素材和品牌信息重新创作。",
    structure: [
      { label: "开场钩子", range: "0%–12%", text: hook || "以冲突、结果或问题快速说明本条内容值得继续看。" },
      { label: "过程推进", range: "12%–82%", text: development || "用连续事件、具体细节或阶段变化推动内容。" },
      { label: "收束与余味", range: "82%–100%", text: resolution || "回扣前文结果，并给观众留下可讨论或可行动的出口。" },
    ],
    learningPoints: [
      `开场使用${hasQuestion ? "提问/反问" : "明确情境或结果"}建立观看动机；你的版本可替换为真实用户问题。`,
      `${hasNumber ? "文稿中出现数字或量化信息，可借鉴“具体细节”增强可信度。" : "优先用可见过程、角色反应或场景变化，而非空泛结论。"}`,
      `公开数据中完播率约 ${(finishRate * 100).toFixed(1)}%、互动率约 ${(interactionRate * 100).toFixed(1)}%；将其当作结构参考，不把表现归因于单一文案。`,
    ],
    originalGuidance: [
      "保留“钩子—过程—收束”的方法，不复用原视频的台词、人物、镜头、配乐或素材。",
      "用自己的产品场景、用户证据和可验证体验替换参考内容中的事实与情节。",
      "先写一个独立观点，再补足 3 个能被画面证明的过程节点，最后设计自然的评论或行动提示。",
    ],
  };
}

module.exports = {
  XINGTU_CONTENT_MARKET_URL,
  getXingtuPublicVideoCatalog,
  getXingtuVideoMediaSource,
  normalizeItemId,
  officialCoverUrl,
  officialMediaUrl,
  officialTranscriptUrl,
  requestOfficialCover,
  requestOfficialMedia,
  buildXingtuPreviewCover,
  requestOfficialResource,
  requestOfficialTranscript,
  buildTranscriptLearningAnalysis,
};
