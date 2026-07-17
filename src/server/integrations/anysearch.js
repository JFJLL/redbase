const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";
const GENERAL_DOMAIN = "general";
const GENERAL_SUB_DOMAIN = "general.general";
const SOCIAL_DOMAIN = "social_media";
const SOCIAL_SUB_DOMAIN = "social_media.social_media";
const DEFAULT_MAX_RESULTS_PER_QUERY = 6;
const DEFAULT_MAX_EVIDENCE = 8;
const DEFAULT_MAX_SOCIAL_EVIDENCE = 2;
const DEFAULT_MIN_RELIABLE_EVIDENCE = 2;
const DEFAULT_REQUEST_RETRIES = 2;
const DEFAULT_DAILY_QUERY_LIMIT = 950;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const evidenceCache = new Map();
let dailyBudgetState = { date: "", keys: {} };

const HIGH_TRUST_HOSTS = [
  "gov.cn",
  "samr.gov.cn",
  "stats.gov.cn",
  "cnnic.cn",
  "xiaohongshu.com",
];
const MEDIUM_TRUST_HOSTS = [
  "ce.cn",
  "people.com.cn",
  "xinhuanet.com",
  "chinanews.com.cn",
  "cctv.com",
  "thepaper.cn",
  "yicai.com",
  "socialbeta.com",
  "jiemian.com",
  "36kr.com",
  "huxiu.com",
  "cbndata.com",
  "chinadaily.com.cn",
  "baijiahao.baidu.com",
  "zhihu.com",
  "weibo.com",
];
const LOW_TRUST_HOSTS = [
  "book118.com",
  "chinairn.com",
  "sohu.com",
  "163.com",
  "toutiao.com",
  "itbear.com.cn",
  "eastmoney.com",
  "growthhk.cn",
];
const SOCIAL_HOSTS = [
  "weibo.com",
  "zhihu.com",
  "xiaohongshu.com",
  "x.com",
  "twitter.com",
  "reddit.com",
  "linkedin.com",
  "mp.weixin.qq.com",
  "weixin.qq.com",
  "weixin.sogou.com",
];

function createAnySearchError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/\bas_sk_[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|authorization|token|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function isAnySearchQuotaExhaustion(statusCode, data, raw = "") {
  if (data?.auto_registered?.api_key || data?.error?.data?.auto_registered?.api_key) return true;
  const errorText = redactSensitiveText([
    data?.error?.code,
    data?.error?.message,
    data?.error?.data?.code,
    data?.error?.data?.message,
    data?.message,
    raw,
  ].filter(Boolean).join(" ")).slice(0, 1200);
  const explicitlyExhausted =
    /(?:insufficient|exceeded|exhausted|depleted)[\s_-]*(?:quota|credit)|(?:quota|credit|daily[\s_-]*usage)[\s_-]*(?:exceeded|exhausted|depleted|limit)|insufficient_quota/i.test(errorText) ||
    /(?:额度|配额|次数).{0,12}(?:用尽|耗尽|不足|超出|达到上限|已达上限)/i.test(errorText);
  return explicitlyExhausted && [200, 402, 403, 429].includes(Number(statusCode));
}

function truncateQueryValue(value, maxLength = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatShanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}年${values.month}月${values.day}日`;
}

function getShanghaiDateKey(now = new Date()) {
  return formatShanghaiDate(now);
}

function getConfiguredAnySearchApiKeys(config = {}) {
  return [
    ...(Array.isArray(config.apiKeys) ? config.apiKeys : []),
    config.apiKey,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function getAnySearchKeyId(apiKey, index = 0) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) return `anonymous-${index + 1}`;
  return `key-${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

function getAnySearchDailyLimit(config = {}) {
  const configuredLimit = Number(config.dailyQueryLimit);
  return Number.isFinite(configuredLimit) && configuredLimit >= 1
    ? Math.floor(configuredLimit)
    : DEFAULT_DAILY_QUERY_LIMIT;
}

function loadAnySearchBudgetState(config, date, keyRecords) {
  const configuredUsageFile = String(config.dailyUsageFile || "").trim();
  const usageFile = configuredUsageFile
    ? path.resolve(configuredUsageFile)
    : "";
  if (usageFile && fs.existsSync(usageFile)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(usageFile, "utf8"));
      if (persisted?.date !== date) {
        dailyBudgetState = { date, keys: {} };
      } else if (persisted?.keys && typeof persisted.keys === "object" && !Array.isArray(persisted.keys)) {
        dailyBudgetState = {
          date,
          keys: Object.fromEntries(
            Object.entries(persisted.keys).map(([keyId, used]) => [keyId, Math.max(0, Number(used || 0))]),
          ),
        };
      } else {
        dailyBudgetState = {
          date,
          keys: { [keyRecords[0].id]: Math.max(0, Number(persisted?.used || 0)) },
        };
      }
    } catch (_error) {
      throw createAnySearchError("ANYSEARCH_USAGE_STATE_ERROR", "AnySearch 用量状态文件损坏，已停止搜索以避免突破每日上限。");
    }
  } else if (dailyBudgetState.date !== date) {
    dailyBudgetState = { date, keys: {} };
  }
  return usageFile;
}

function persistAnySearchBudgetState(usageFile) {
  if (!usageFile) return;
  try {
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    const tempFile = `${usageFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(dailyBudgetState)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, usageFile);
  } catch (_error) {
    throw createAnySearchError("ANYSEARCH_USAGE_STATE_ERROR", "AnySearch 用量状态写入失败，已停止搜索以避免突破每日上限。");
  }
}

function reserveAnySearchKey(config, units, now = new Date(), options = {}) {
  const date = getShanghaiDateKey(now);
  const apiKeys = getConfiguredAnySearchApiKeys(config);
  const keyValues = apiKeys.length ? apiKeys : [""];
  const keyRecords = keyValues.map((apiKey, index) => ({ apiKey, id: getAnySearchKeyId(apiKey, index), index }));
  const usageFile = loadAnySearchBudgetState(config, date, keyRecords);
  const requested = Number(units);
  const limit = getAnySearchDailyLimit(config);
  const requestedUnits = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;
  const available = keyRecords
    .map((record) => ({ ...record, used: Math.max(0, Number(dailyBudgetState.keys[record.id] || 0)) }))
    .filter((record) => record.used + requestedUnits <= limit)
    .sort((left, right) => left.used - right.used || left.index - right.index);
  const excludedKeyIds = new Set(Array.isArray(options.excludeKeyIds) ? options.excludeKeyIds : []);
  const selected = available.find((record) => !excludedKeyIds.has(record.id)) || available[0];
  const totalUsed = keyRecords.reduce((sum, record) => sum + Math.max(0, Number(dailyBudgetState.keys[record.id] || 0)), 0);
  const totalLimit = limit * keyRecords.length;
  if (!selected) {
    throw createAnySearchError(
      "ANYSEARCH_DAILY_LIMIT",
      `AnySearch 今日项目侧搜索额度已用尽：${totalUsed}/${totalLimit}（${keyRecords.length} 个 Key）。`,
    );
  }
  const used = selected.used + requestedUnits;
  dailyBudgetState.keys[selected.id] = used;
  persistAnySearchBudgetState(usageFile);
  const result = {
    date,
    keyId: selected.id,
    keyCount: keyRecords.length,
    used,
    limit,
    totalUsed: totalUsed + requestedUnits,
    totalLimit,
  };
  Object.defineProperty(result, "apiKey", { value: selected.apiKey, enumerable: false });
  return result;
}

function consumeAnySearchBudget(config, units, now = new Date()) {
  const reservation = reserveAnySearchKey(config, units, now);
  return { date: reservation.date, used: reservation.used, limit: reservation.limit };
}

function markAnySearchKeyExhausted(config, keyId, now = new Date()) {
  const date = getShanghaiDateKey(now);
  const apiKeys = getConfiguredAnySearchApiKeys(config);
  const keyValues = apiKeys.length ? apiKeys : [""];
  const keyRecords = keyValues.map((apiKey, index) => ({ apiKey, id: getAnySearchKeyId(apiKey, index), index }));
  const usageFile = loadAnySearchBudgetState(config, date, keyRecords);
  if (keyRecords.some((record) => record.id === keyId)) {
    dailyBudgetState.keys[keyId] = getAnySearchDailyLimit(config);
    persistAnySearchBudgetState(usageFile);
  }
}

function resetAnySearchBudget() {
  dailyBudgetState = { date: "", keys: {} };
}

function getBucketKey(bucketMeta) {
  const source = Array.isArray(bucketMeta) ? bucketMeta[0] : bucketMeta;
  return String(source?.key || source || "news").trim().toLowerCase();
}

function buildGeneralQueryTexts(brand, bucketKey, now = new Date()) {
  const date = formatShanghaiDate(now);
  const industry = truncateQueryValue(brand?.industry || "消费行业");
  const product = truncateQueryValue(brand?.product || industry);
  const audience = truncateQueryValue(brand?.audience || "目标消费者");
  const byBucket = {
    traffic: [
      `${date} 小红书 ${industry} ${product} 最近30天 热门内容形式 标题 封面 种草趋势`,
      `${date} ${industry} ${product} 内容营销 案例 用户互动 趋势 最近30天`,
    ],
    news: [
      `${date} ${industry} ${product} 最近30天 新闻 政策 标准 消费趋势`,
      `${date} ${industry} 行业动态 产品趋势 消费者关注 最近30天`,
    ],
    social: [
      `${date} ${audience} ${industry} 最近30天 社会话题 生活方式 消费情绪`,
      `${date} ${product} 公共讨论 用户态度 生活场景 最近30天`,
    ],
    track: [
      `${date} ${industry} ${product} 最近30天 品类趋势 竞品 消费决策`,
      `${date} ${industry} 用户购买理由 产品痛点 市场趋势 最近30天`,
    ],
    crowd: [
      `${date} ${audience} ${product} 最近30天 消费需求 使用场景 兴趣趋势`,
      `${date} ${audience} 生活方式 消费焦虑 内容需求 最近30天`,
    ],
    xhs: [
      `${date} 小红书 ${industry} ${product} 最近30天 热门内容 用户讨论`,
      `${date} ${audience} ${product} 小红书 种草 场景 趋势 最近30天`,
    ],
  };
  return byBucket[bucketKey] || byBucket.news;
}

function buildSocialQueryTypes(bucketKey) {
  if (bucketKey === "social") return ["weibo", "zhihu"];
  if (["traffic", "track", "crowd", "xhs"].includes(bucketKey)) return ["zhihu"];
  return [];
}

function buildAnySearchQueries(brand, bucketMeta, config = {}, now = new Date()) {
  const bucketKey = getBucketKey(bucketMeta);
  const maxResults = Math.max(1, Math.min(10, Number(config.maxResultsPerQuery || DEFAULT_MAX_RESULTS_PER_QUERY)));
  const generalDomain = String(config.domain || GENERAL_DOMAIN);
  const generalSubDomain = String(config.subDomain || GENERAL_SUB_DOMAIN);
  const generalQueries = buildGeneralQueryTexts(brand, bucketKey, now).map((query) => ({
    query,
    domain: generalDomain,
    sub_domain: generalSubDomain,
    max_results: maxResults,
  }));
  const socialTypes = config.socialEnabled === false ? [] : buildSocialQueryTypes(bucketKey);
  const socialKeyword = truncateQueryValue(
    `${brand?.industry || ""} ${brand?.product || ""} ${brand?.audience || ""}`,
    120,
  );
  const socialQueries = socialTypes.map((type) => ({
    query: `${socialKeyword} ${bucketKey === "traffic" ? "内容趋势" : "用户讨论"}`.trim(),
    domain: String(config.socialDomain || SOCIAL_DOMAIN),
    sub_domain: String(config.socialSubDomain || SOCIAL_SUB_DOMAIN),
    sub_domain_params: {
      keyword: socialKeyword,
      type,
    },
    max_results: maxResults,
  }));
  return [...generalQueries, ...socialQueries].slice(0, 5);
}

function buildAnySearchAuthoritativeQueries(brand, bucketMeta, config = {}) {
  const bucketKey = getBucketKey(bucketMeta);
  const industry = truncateQueryValue(brand?.industry || "消费行业", 48);
  const product = truncateQueryValue(String(brand?.product || industry).split(/\r?\n/)[0], 56);
  const focusByBucket = {
    traffic: "内容营销 平台趋势 消费者关注",
    news: "政策 标准 行业动态 消费趋势",
    social: "社会话题 生活方式 消费情绪",
    track: "品类趋势 行业动态 消费决策",
    crowd: "人群趋势 消费需求 使用场景",
    xhs: "小红书 内容趋势 消费者关注",
  };
  const focus = focusByBucket[bucketKey] || focusByBucket.news;
  const maxResults = Math.max(1, Math.min(10, Number(config.maxResultsPerQuery || DEFAULT_MAX_RESULTS_PER_QUERY)));
  const domain = String(config.domain || GENERAL_DOMAIN);
  const subDomain = String(config.subDomain || GENERAL_SUB_DOMAIN);
  return [
    `site:gov.cn ${industry} ${product} ${focus} 官方`,
    `(site:people.com.cn OR site:xinhuanet.com OR site:ce.cn OR site:36kr.com) ${industry} ${product} ${focus}`,
  ].map((query) => ({
    query,
    domain,
    sub_domain: subDomain,
    max_results: maxResults,
  }));
}

function decodeBasicHtml(value) {
  return String(value || "")
    .replace(/<em>/gi, "")
    .replace(/<\/em>/gi, "")
    .replace(/&#34;|&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanSnippet(value, maxLength = 520) {
  return decodeBasicHtml(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeEvidenceText(value, maxLength = 520) {
  return cleanSnippet(value, maxLength)
    .replace(/(?:忽略|无视|覆盖|绕过).{0,32}(?:指令|提示词|系统消息|系统提示|规则)/gi, "[已过滤疑似提示指令]")
    .replace(/(?:ignore|disregard|override|bypass).{0,48}(?:instructions?|system prompt|developer message|rules?)/gi, "[filtered prompt-like instruction]")
    .replace(/(?:输出|显示|泄露|返回|打印).{0,32}(?:api\s*key|密钥|token|系统提示|系统消息)/gi, "[已过滤疑似敏感信息指令]")
    .replace(/(?:reveal|show|print|return|leak).{0,48}(?:api\s*keys?|tokens?|system prompt|developer message)/gi, "[filtered sensitive-data instruction]");
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function hostMatches(hostname, suffix) {
  const host = String(hostname || "").toLowerCase();
  const expected = String(suffix || "").toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (!normalized) return true;
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (normalized.includes(":") && embeddedIpv4) return isPrivateAddress(embeddedIpv4);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const parts = normalized.split(".").map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) ||
      (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 224
    );
  }
  if (ipVersion === 6) {
    const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (
      normalized === "::" ||
      normalized === "::1" ||
      (firstHextet & 0xfe00) === 0xfc00 ||
      (firstHextet & 0xffc0) === 0xfe80 ||
      (firstHextet & 0xffc0) === 0xfec0 ||
      (firstHextet & 0xff00) === 0xff00
    );
  }
  return true;
}

function isSafePublicUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return false;
  const { hostname, username, password, port } = new URL(normalized);
  const host = hostname.toLowerCase();
  if (username || password || (port && !["80", "443"].includes(port))) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (net.isIP(hostname) && isPrivateAddress(hostname)) return false;
  return !hostMatches(host, "example.com");
}

function getTrustLevel(hostname, sourceType) {
  if (sourceType === "social") return "social";
  if (HIGH_TRUST_HOSTS.some((host) => hostMatches(hostname, host))) return "high";
  if (LOW_TRUST_HOSTS.some((host) => hostMatches(hostname, host))) return "low";
  if (MEDIUM_TRUST_HOSTS.some((host) => hostMatches(hostname, host))) return "medium";
  return "low";
}

function getTrustScore(level) {
  return { high: 4, medium: 3, social: 2, low: 1 }[level] || 0;
}

function normalizeRelevancePhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildFieldRelevanceTerms(value) {
  const stopTerms = new Set([
    "品牌", "产品", "用户", "消费", "行业", "趋势", "内容", "关注", "提升", "核心",
    "目标", "使用", "场景", "设计", "市场", "家庭", "生活", "专为",
  ]);
  const source = String(value || "").toLowerCase();
  const phrases = new Set();
  const terms = [];
  let offset = 0;
  for (const chunk of source.match(/[\p{Script=Han}]{2,}/gu) || []) {
    const phrase = normalizeRelevancePhrase(chunk);
    if (phrase.length <= 20 && !stopTerms.has(phrase)) phrases.add(phrase);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const term = chunk.slice(index, index + 2);
      if (!stopTerms.has(term)) terms.push({ term, position: offset + index });
    }
    offset += chunk.length + 1;
  }
  for (const token of source.match(/[a-z0-9][a-z0-9.+-]{2,}/g) || []) {
    const phrase = normalizeRelevancePhrase(token);
    if (!stopTerms.has(phrase)) {
      phrases.add(phrase);
      terms.push({ term: phrase, position: offset });
      offset += phrase.length + 1;
    }
  }
  return { phrases: [...phrases], terms };
}

function isEvidenceRelevantToBrand(item, brand) {
  const haystack = normalizeRelevancePhrase(`${item?.title || ""} ${item?.snippet || ""}`);
  const brandProfile = buildFieldRelevanceTerms(brand?.name);
  const productProfile = buildFieldRelevanceTerms(brand?.product);
  if (brandProfile.phrases.some((phrase) => phrase.length >= 2 && haystack.includes(phrase))) return true;
  if (productProfile.phrases.some((phrase) => phrase.length >= 2 && haystack.includes(phrase))) return true;

  const matchedProductTerms = productProfile.terms.filter(({ term }) => haystack.includes(term));
  if (matchedProductTerms.some(({ term }) => /^[a-z0-9]/.test(term) && term.length >= 5)) return true;
  const hasSeparatedProductPair = matchedProductTerms.some((left, index) =>
    matchedProductTerms.slice(index + 1).some((right) => Math.abs(left.position - right.position) >= 2),
  );
  return hasSeparatedProductPair;
}

function parseResultBlocks(sectionText, query, queryIndex) {
  const matches = [...String(sectionText || "").matchAll(/^###\s+\d+\.\s+(.+)$/gm)];
  const results = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : sectionText.length;
    const block = sectionText.slice(start, end).trim();
    const url = block.match(/^- \*\*URL\*\*:\s*(\S+)/m)?.[1] || "";
    if (!url) continue;
    const sourceType =
      query?.domain === SOCIAL_DOMAIN || String(query?.sub_domain || "").startsWith(`${SOCIAL_DOMAIN}.`)
        ? "social"
        : "web";
    results.push({
      title: cleanSnippet(matches[index][1], 180),
      url,
      publishedAt: block.match(/\bPublished:\s*([^\s]+)/i)?.[1] || "",
      source: block.match(/\bSource:\s*([^\s(]+)/i)?.[1] || "",
      snippet: block.replace(/^- \*\*URL\*\*:.+$/m, "").trim(),
      sourceType,
      platformType: query?.sub_domain_params?.type || "",
      queryIndex,
    });
  }
  return results;
}

function parseAnySearchMarkdown(markdown, queries = []) {
  const text = String(markdown || "");
  const queryMatches = [...text.matchAll(/^## Query (\d+):.*$/gm)];
  if (!queryMatches.length) return parseResultBlocks(text, queries[0], 0);
  const items = [];
  for (let index = 0; index < queryMatches.length; index += 1) {
    const start = queryMatches[index].index + queryMatches[index][0].length;
    const end = index + 1 < queryMatches.length ? queryMatches[index + 1].index : text.length;
    const queryIndex = Math.max(0, Number(queryMatches[index][1]) - 1);
    items.push(...parseResultBlocks(text.slice(start, end), queries[queryIndex], queryIndex));
  }
  return items;
}

function looksLikeBrokenPage(item) {
  const title = String(item?.title || "");
  const excerpt = String(item?.snippet || "").slice(0, 360);
  return /(?:页面不见了|页面不存在|网页不存在|page not found|404 not found|404 error)/i.test(`${title} ${excerpt}`);
}

function prepareEvidence(items, options = {}) {
  const maxSnippetChars = Math.max(200, Math.min(800, Number(options.maxSnippetChars || 520)));
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const url = normalizeUrl(item?.url);
      if (!isSafePublicUrl(url) || looksLikeBrokenPage(item)) return null;
      const parsed = new URL(url);
      const title = sanitizeEvidenceText(item?.title || parsed.hostname, 180);
      const titleKey = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 100);
      const sourceType =
        item?.sourceType === "social" || SOCIAL_HOSTS.some((host) => hostMatches(parsed.hostname, host))
          ? "social"
          : "web";
      const trustLevel = getTrustLevel(parsed.hostname, sourceType);
      return {
        title,
        url,
        publishedAt: cleanSnippet(item?.publishedAt || "", 80),
        source: sanitizeEvidenceText(item?.source || parsed.hostname, 100),
        host: parsed.hostname.toLowerCase(),
        snippet: sanitizeEvidenceText(item?.snippet || "", maxSnippetChars),
        sourceType,
        platformType: cleanSnippet(item?.platformType || "", 40),
        trustLevel,
        trustScore: getTrustScore(trustLevel),
        queryIndex: Number(item?.queryIndex || 0),
        dedupeTitleKey: titleKey,
      };
    })
    .filter(Boolean);
}

function dedupeEvidence(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  return (Array.isArray(items) ? items : [])
    .sort((left, right) => right.trustScore - left.trustScore || String(right.publishedAt).localeCompare(String(left.publishedAt)))
    .filter((item) => {
      if (seenUrls.has(item.url) || (item.dedupeTitleKey && seenTitles.has(item.dedupeTitleKey))) return false;
      seenUrls.add(item.url);
      if (item.dedupeTitleKey) seenTitles.add(item.dedupeTitleKey);
      return true;
    })
    .map(({ dedupeTitleKey, ...item }) => item);
}

function normalizeEvidence(items, options = {}) {
  return dedupeEvidence(prepareEvidence(items, options));
}

function selectEvidence(items, options = {}) {
  const maxEvidence = Math.max(3, Math.min(12, Number(options.maxEvidence || DEFAULT_MAX_EVIDENCE)));
  const maxSocial = Math.max(0, Math.min(3, Number(options.maxSocialEvidence ?? DEFAULT_MAX_SOCIAL_EVIDENCE)));
  const social = items.filter((item) => item.sourceType === "social").slice(0, maxSocial);
  const web = items.filter((item) => item.sourceType !== "social").slice(0, maxEvidence - social.length);
  return [...web, ...social]
    .sort((left, right) => right.trustScore - left.trustScore || left.queryIndex - right.queryIndex)
    .slice(0, maxEvidence)
    .map((item, index) => ({ id: `S${index + 1}`, ...item }));
}

function getSafeRedirectUrl(currentUrl, location) {
  try {
    const nextUrl = normalizeUrl(new URL(String(location || ""), currentUrl).toString());
    return nextUrl && isSafePublicUrl(nextUrl) ? nextUrl : "";
  } catch (_error) {
    return "";
  }
}

function isAccessibleStatus(status) {
  const normalized = Number(status || 0);
  return (normalized >= 200 && normalized < 400) || [401, 403, 405, 501].includes(normalized);
}

async function resolvePublicAddresses(hostname, lookupImpl = dns.promises.lookup) {
  if (net.isIP(hostname)) return isPrivateAddress(hostname) ? [] : [{ address: hostname, family: net.isIP(hostname) }];
  const result = await lookupImpl(hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(result) ? result : [result];
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item?.address || item))) return [];
  return addresses.map((item) => ({
    address: String(item?.address || item),
    family: Number(item?.family || net.isIP(item?.address || item)),
  }));
}

async function resolvePublicHostname(hostname, lookupImpl = dns.promises.lookup) {
  return (await resolvePublicAddresses(hostname, lookupImpl)).length > 0;
}

function createPinnedLookup(address, family = net.isIP(address)) {
  return (_hostname, options, callback) => {
    const lookupOptions = typeof options === "object" && options ? options : {};
    const done = typeof options === "function" ? options : callback;
    if (lookupOptions.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };
}

async function requestPinnedUrl(value, options = {}) {
  const parsed = new URL(value);
  const addresses = await resolvePublicAddresses(parsed.hostname, options.lookupImpl || dns.promises.lookup);
  if (!addresses.length) throw new Error("URL hostname does not resolve exclusively to public addresses");
  const pinned = addresses[0];
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      parsed,
      {
        method: options.method || "HEAD",
        signal: options.signal,
        headers: options.headers || {},
        lookup: createPinnedLookup(pinned.address, pinned.family),
      },
      (response) => {
        response.resume();
        resolve({
          status: Number(response.statusCode || 0),
          headers: {
            get(name) {
              const value = response.headers[String(name || "").toLowerCase()];
              return Array.isArray(value) ? value[0] || "" : String(value || "");
            },
          },
        });
      },
    );
    request.setTimeout(Math.max(500, Number(options.timeoutMs || 3500)), () => {
      request.destroy(new Error("URL accessibility request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function checkUrlAccessible(value, options = {}) {
  const lookupImpl = options.lookupImpl || dns.promises.lookup;
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 3500));
  if (!isSafePublicUrl(value)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = normalizeUrl(value);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const parsed = new URL(currentUrl);
      if (SOCIAL_HOSTS.some((host) => hostMatches(parsed.hostname, host))) {
        return resolvePublicHostname(parsed.hostname, lookupImpl);
      }
      const response = await requestPinnedUrl(currentUrl, {
        method: "HEAD",
        signal: controller.signal,
        timeoutMs,
        lookupImpl,
        headers: { "User-Agent": "RedBase-Evidence-Check/1.0" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.("location");
        if (!location) return false;
        currentUrl = getSafeRedirectUrl(currentUrl, location);
        if (!currentUrl) return false;
        continue;
      }
      return isAccessibleStatus(response.status);
    }
    return false;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAnySearch(config, queries, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw createAnySearchError("ANYSEARCH_RUNTIME_ERROR", "当前运行环境不支持 AnySearch HTTP 请求。");
  const configuredRetries = Number(options.retries ?? config.retries);
  const retries = Number.isFinite(configuredRetries)
    ? Math.max(0, Math.min(3, Math.floor(configuredRetries)))
    : DEFAULT_REQUEST_RETRIES;
  let lastError = null;
  const attemptedKeyIds = new Set();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(config.timeoutMs || 30000)));
    let reservation = null;
    try {
      // A timeout/5xx can happen after AnySearch processed the batch, so every outbound attempt
      // reserves query units on the least-used key. This keeps each key's 950-unit ceiling fail-closed.
      reservation = reserveAnySearchKey(config, queries.length, options.now || new Date(), {
        excludeKeyIds: [...attemptedKeyIds],
      });
      attemptedKeyIds.add(reservation.keyId);
      const response = await fetchImpl(config.baseUrl || ANYSEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(reservation.apiKey ? { Authorization: `Bearer ${reservation.apiKey}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `redbase-${Date.now()}-${attempt}`,
          method: "tools/call",
          params: {
            name: "batch_search",
            arguments: { queries },
          },
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (_error) {
        throw createAnySearchError("ANYSEARCH_INVALID_RESPONSE", "AnySearch 返回了无法解析的响应。");
      }
      if (!response.ok || data?.error) {
        const message = redactSensitiveText(data?.error?.message || `HTTP ${response.status}`).slice(0, 240);
        if (isAnySearchQuotaExhaustion(response.status, data, raw)) {
          throw createAnySearchError("ANYSEARCH_QUOTA_EXHAUSTED", "AnySearch 当前密钥额度已用尽，需要切换 API Key。");
        }
        if (response.status === 401) {
          throw createAnySearchError("ANYSEARCH_KEY_REJECTED", "AnySearch 当前密钥验证失败，需要切换 API Key。");
        }
        const error = createAnySearchError("ANYSEARCH_API_ERROR", `AnySearch 请求失败：${message}`);
        error.statusCode = response.status;
        throw error;
      }
      const content = Array.isArray(data?.result?.content) ? data.result.content : [];
      const markdown = content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n").trim();
      if (!markdown) throw createAnySearchError("ANYSEARCH_EMPTY_RESULT", "AnySearch 没有返回可用搜索结果。");
      return markdown;
    } catch (error) {
      lastError = error?.code?.startsWith("ANYSEARCH_")
        ? error
        : error?.name === "AbortError"
          ? createAnySearchError("ANYSEARCH_TIMEOUT", "AnySearch 请求超时。", error)
          : createAnySearchError("ANYSEARCH_NETWORK_ERROR", "AnySearch 网络连接失败。", error);
      if (reservation && ["ANYSEARCH_QUOTA_EXHAUSTED", "ANYSEARCH_KEY_REJECTED"].includes(lastError.code)) {
        markAnySearchKeyExhausted(config, reservation.keyId, options.now || new Date());
      }
      const retryable =
        ["ANYSEARCH_TIMEOUT", "ANYSEARCH_NETWORK_ERROR"].includes(lastError.code) ||
        (lastError.code === "ANYSEARCH_API_ERROR" && (lastError.statusCode === 429 || lastError.statusCode >= 500)) ||
        (["ANYSEARCH_QUOTA_EXHAUSTED", "ANYSEARCH_KEY_REJECTED"].includes(lastError.code) && reservation?.keyCount > 1);
      if (!retryable || attempt >= retries) throw lastError;
      const delayMs = Math.max(0, Math.min(2000, Number(options.retryDelayMs ?? config.retryDelayMs ?? 350))) * (attempt + 1);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || createAnySearchError("ANYSEARCH_NETWORK_ERROR", "AnySearch 网络连接失败。");
}

function buildCacheKey(config, queries, brand) {
  return JSON.stringify({
    baseUrl: config.baseUrl || ANYSEARCH_ENDPOINT,
    queries,
    relevanceSignature: {
      name: normalizeRelevancePhrase(brand?.name),
      industry: normalizeRelevancePhrase(brand?.industry),
      product: normalizeRelevancePhrase(brand?.product),
    },
    urlCheckEnabled: config.urlCheckEnabled !== false,
    maxEvidence: config.maxEvidence || DEFAULT_MAX_EVIDENCE,
    maxSocialEvidence: config.maxSocialEvidence ?? DEFAULT_MAX_SOCIAL_EVIDENCE,
    minReliableEvidence: config.minReliableEvidence || DEFAULT_MIN_RELIABLE_EVIDENCE,
    maxSnippetChars: config.maxSnippetChars || 520,
  });
}

function getCachedEvidence(key, ttlMs) {
  const cached = evidenceCache.get(key);
  if (!cached || Date.now() - cached.createdAt > ttlMs) {
    evidenceCache.delete(key);
    return null;
  }
  return structuredClone(cached.value);
}

function pruneEvidenceCache(now = Date.now(), maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
  for (const [key, cached] of evidenceCache.entries()) {
    if (Number(cached?.expiresAt || 0) <= now) evidenceCache.delete(key);
  }
  const limit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_CACHE_ENTRIES));
  while (evidenceCache.size > limit) {
    const oldestKey = evidenceCache.keys().next().value;
    if (oldestKey === undefined) break;
    evidenceCache.delete(oldestKey);
  }
}

function getAnySearchCacheSize() {
  return evidenceCache.size;
}

function getEvidenceCandidates(normalized, config) {
  const candidateLimit = Math.max(Number(config.maxEvidence || DEFAULT_MAX_EVIDENCE) + 4, 8);
  const socialCandidateLimit = Math.min(
    12,
    Math.max(Number(config.maxSocialEvidence ?? DEFAULT_MAX_SOCIAL_EVIDENCE) + 6, 8),
  );
  return [
    ...normalized.filter((item) => item.sourceType !== "social").slice(0, candidateLimit),
    ...normalized.filter((item) => item.sourceType === "social").slice(0, socialCandidateLimit),
  ];
}

async function getAccessibleEvidence(normalized, config, options, accessibilityCache) {
  const candidates = getEvidenceCandidates(normalized, config);
  if (config.urlCheckEnabled === false) return candidates;
  const urlChecker = options.urlChecker || checkUrlAccessible;
  const checks = await Promise.all(
    candidates.map(async (item) => {
      if (!accessibilityCache.has(item.url)) {
        accessibilityCache.set(
          item.url,
          await urlChecker(item.url, {
            timeoutMs: config.urlCheckTimeoutMs,
            lookupImpl: options.lookupImpl,
          }).catch(() => false),
        );
      }
      return { item, accessible: accessibilityCache.get(item.url) };
    }),
  );
  return checks.filter((result) => result.accessible).map((result) => result.item);
}

function countReliableEvidence(evidence) {
  return evidence.filter(
    (item) => item.sourceType === "web" && ["high", "medium"].includes(item.trustLevel),
  ).length;
}

async function fetchAnySearchEvidence(appConfig, brand, bucketMeta, options = {}) {
  const config = appConfig?.searchProvider || {};
  if (!config.enabled) throw createAnySearchError("ANYSEARCH_DISABLED", "AnySearch 搜索服务尚未启用。");
  const initialQueries = buildAnySearchQueries(brand, bucketMeta, config, options.now || new Date());
  const cacheTtlMs = Math.max(0, Number(config.cacheTtlMs ?? 10 * 60 * 1000));
  const cacheKey = buildCacheKey(config, initialQueries, brand);
  if (!options.skipCache && cacheTtlMs > 0) {
    const cached = getCachedEvidence(cacheKey, cacheTtlMs);
    if (cached) return cached;
  }

  const requestImpl = options.requestImpl || requestAnySearch;
  let queries = [...initialQueries];
  const markdown = await requestImpl(config, initialQueries, options);
  let parsed = parseAnySearchMarkdown(markdown, initialQueries);
  const accessibilityCache = new Map();
  const initialCandidates = prepareEvidence(parsed, config);
  let normalized = dedupeEvidence(initialCandidates);
  let accessible = await getAccessibleEvidence(normalized, config, options, accessibilityCache);
  let evidence = selectEvidence(accessible, config);
  let reliableCount = countReliableEvidence(evidence);
  const minReliableEvidence = Math.max(1, Number(config.minReliableEvidence || DEFAULT_MIN_RELIABLE_EVIDENCE));

  if (reliableCount < minReliableEvidence) {
    const authoritativeQueries = buildAnySearchAuthoritativeQueries(brand, bucketMeta, config);
    const authoritativeMarkdown = await requestImpl(config, authoritativeQueries, options);
    const authoritativeParsed = parseAnySearchMarkdown(authoritativeMarkdown, authoritativeQueries)
      .map((item) => ({ ...item, queryIndex: item.queryIndex + initialQueries.length }));
    queries = [...initialQueries, ...authoritativeQueries];
    parsed = [...parsed, ...authoritativeParsed];
    const relevantAuthoritativeCandidates = prepareEvidence(authoritativeParsed, config)
      .filter((item) => isEvidenceRelevantToBrand(item, brand));
    normalized = dedupeEvidence([...initialCandidates, ...relevantAuthoritativeCandidates]);
    accessible = await getAccessibleEvidence(normalized, config, options, accessibilityCache);
    evidence = selectEvidence(accessible, config);
    reliableCount = countReliableEvidence(evidence);
  }

  if (reliableCount < minReliableEvidence) {
    throw createAnySearchError(
      "ANYSEARCH_INSUFFICIENT_EVIDENCE",
      `AnySearch 已补充检索权威来源，但可验证来源仍不足：${reliableCount}/${minReliableEvidence}。`,
    );
  }

  const result = {
    provider: "anysearch",
    domain: config.domain || GENERAL_DOMAIN,
    subDomain: config.subDomain || GENERAL_SUB_DOMAIN,
    queries,
    evidence,
    rawResultCount: parsed.length,
    reliableCount,
    retrievedAt: new Date().toISOString(),
  };
  if (cacheTtlMs > 0) {
    const createdAt = Date.now();
    evidenceCache.set(cacheKey, { createdAt, expiresAt: createdAt + cacheTtlMs, value: structuredClone(result) });
    pruneEvidenceCache(createdAt, config.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  }
  return result;
}

function clearAnySearchCache() {
  evidenceCache.clear();
}

module.exports = {
  ANYSEARCH_ENDPOINT,
  GENERAL_DOMAIN,
  GENERAL_SUB_DOMAIN,
  SOCIAL_DOMAIN,
  SOCIAL_SUB_DOMAIN,
  buildAnySearchQueries,
  buildAnySearchAuthoritativeQueries,
  parseAnySearchMarkdown,
  normalizeEvidence,
  selectEvidence,
  isPrivateAddress,
  isSafePublicUrl,
  checkUrlAccessible,
  requestAnySearch,
  redactSensitiveText,
  isAnySearchQuotaExhaustion,
  sanitizeEvidenceText,
  createPinnedLookup,
  getSafeRedirectUrl,
  isAccessibleStatus,
  consumeAnySearchBudget,
  getConfiguredAnySearchApiKeys,
  reserveAnySearchKey,
  resetAnySearchBudget,
  fetchAnySearchEvidence,
  clearAnySearchCache,
  pruneEvidenceCache,
  getAnySearchCacheSize,
};
