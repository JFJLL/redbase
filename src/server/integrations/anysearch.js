const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  getExplicitTrendYears: getExplicitYears,
  hasVolatileTrendPrice,
} = require("../trend-copy-quality");

const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";
const GENERAL_DOMAIN = "general";
const GENERAL_SUB_DOMAIN = "general.general";
const SOCIAL_DOMAIN = "social_media";
const SOCIAL_SUB_DOMAIN = "social_media.social_media";
const DEFAULT_MAX_RESULTS_PER_QUERY = 6;
const DEFAULT_MAX_EVIDENCE = 8;
const DEFAULT_MAX_SOCIAL_EVIDENCE = 2;
const DEFAULT_MIN_EVIDENCE = 2;
// CloudFront currently returns four A records; trying all four prevents three
// unhealthy edges from masking the still-healthy fourth address.
const DEFAULT_REQUEST_RETRIES = 3;
const DEFAULT_DAILY_QUERY_LIMIT = 950;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const MAX_ANYSEARCH_RESPONSE_BYTES = 10 * 1024 * 1024;
const evidenceCache = new Map();
let dailyBudgetState = { date: "", keys: {} };
let anySearchAddressCursor = 0;
const anySearchAddressCooldowns = new Map();
const DEFAULT_ANYSEARCH_CONNECT_TIMEOUT_MS = 6000;
const DEFAULT_ANYSEARCH_ADDRESS_COOLDOWN_MS = 5 * 60 * 1000;

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
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(bearer)(?:\s+|\s*[:=]\s*)[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
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

function buildCategorySearchText(brand) {
  const aliases = [];
  if (isChildFamilySearchProfile(brand)) {
    aliases.push("母婴", "儿童健康", "家长");
  }
  if (isMedicineSearchProfile(brand)) {
    aliases.push("家庭健康", "健康信息沟通");
  }
  const categoryTerms = aliases.length ? aliases : [brand?.industry];
  return truncateQueryValue([...new Set(categoryTerms.filter(Boolean))].join(" "), 100);
}

function isChildFamilySearchProfile(brand) {
  return /(?:儿童|小儿|宝宝|婴幼儿|母婴|育儿|家长)/i.test(
    [brand?.industry, brand?.product, brand?.audience, brand?.description]
      .map((value) => String(value || ""))
      .join(" "),
  );
}

function isMedicineSearchProfile(brand) {
  return /(?:药品|用药|感冒药|医药|制药|OTC|医疗器械)/i.test(
    [brand?.industry, brand?.product, brand?.description].map((value) => String(value || "")).join(" "),
  );
}

function buildTrafficMarketingCategoryText(brand) {
  if (isChildFamilySearchProfile(brand)) {
    return "母婴 育儿 家长";
  }
  return buildCategorySearchText(brand);
}

function isSafeTrafficEvidenceForMedicineBrand(item) {
  const text = `${item?.title || ""} ${item?.snippet || ""}`;
  return !/(?:药品|用药|感冒|发烧|咳嗽|症状|疾病|医疗|医学|诊疗|医生|药师|营养品|保健品|奶粉|乳铁蛋白|DHA|心理健康|黄疸|治疗|预防|功效|配方|成分)/i.test(text);
}

function buildGeneralQueryTexts(brand, bucketKey, now = new Date()) {
  const date = formatShanghaiDate(now);
  const month = date.replace(/\d+日$/, "");
  const industry = truncateQueryValue(brand?.industry || "消费行业");
  const product = truncateQueryValue(brand?.product || industry);
  const audience = truncateQueryValue(brand?.audience || "目标消费者");
  const categorySearch = buildCategorySearchText(brand) || industry;
  const trafficCategorySearch = buildTrafficMarketingCategoryText(brand) || categorySearch;
  const byBucket = {
    traffic: [
      `${month} 小红书 ${trafficCategorySearch} 品牌 内容营销 社媒运营 案例 内容形式 用户洞察 最近30天`,
      `${month} ${trafficCategorySearch} 消费者沟通 用户情绪 内容创作 社交媒体 品牌营销 最近30天`,
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
  if (bucketKey === "traffic") return ["weibo", "zhihu"];
  if (["track", "crowd", "xhs"].includes(bucketKey)) return ["zhihu"];
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
    bucketKey === "traffic"
      ? `${buildTrafficMarketingCategoryText(brand)} 品牌内容 家长讨论 用户情绪`
      : `${brand?.industry || ""} ${brand?.product || ""} ${brand?.audience || ""}`,
    120,
  );
  const socialQueries = socialTypes.map((type) => ({
    query: `${socialKeyword} ${bucketKey === "traffic" ? "社媒内容观察" : "用户讨论"}`.trim(),
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
    if (embeddedIpv4 && isPrivateAddress(embeddedIpv4)) return true;
    const hextets = normalized.split(":");
    const firstHextet = Number.parseInt(hextets[0] || "0", 16);
    const secondHextet = Number.parseInt(hextets[1] || "0", 16);
    return (
      // Evidence URLs have no reason to resolve to transition, mapped, local,
      // documentation, or protocol-assignment space. Only global 2000::/3
      // addresses may be pinned for an outbound verification request.
      (firstHextet & 0xe000) !== 0x2000 ||
      (firstHextet === 0x2001 && secondHextet <= 0x01ff) ||
      (firstHextet === 0x2001 && secondHextet === 0x0db8) ||
      firstHextet === 0x2002 ||
      firstHextet === 0x3ffe ||
      (firstHextet === 0x3fff && secondHextet <= 0x0fff)
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

function getMarketingRelevancePhrases(value) {
  return [
    ...(String(value || "").match(/[\p{Script=Han}]{2,}/gu) || []),
    ...(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) || []),
  ]
    .map(normalizeRelevancePhrase)
    .filter((phrase) => phrase.length >= 2 && phrase.length <= 240);
}

function getDistinctiveMarketingTerms(brand) {
  const stopTerms = new Set([
    "品牌", "产品", "用户", "消费", "行业", "趋势", "内容", "关注", "提升", "核心",
    "目标", "使用", "场景", "设计", "市场", "家庭", "生活", "专为", "健康", "儿童",
  ]);
  const terms = new Set();
  for (const value of [brand?.name, brand?.product, brand?.industry, brand?.audience]) {
    for (const phrase of getMarketingRelevancePhrases(value)) {
      if (/^[a-z0-9]/.test(phrase)) {
        if (phrase.length >= 3 && !stopTerms.has(phrase)) terms.add(phrase);
        continue;
      }
      for (let index = 0; index < phrase.length - 1; index += 1) {
        const term = phrase.slice(index, index + 2);
        if (!stopTerms.has(term) && !/\d/.test(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

function getMarketingConceptClusters(brand) {
  const profileText = [brand?.name, brand?.product, brand?.industry, brand?.audience, brand?.description]
    .map((value) => String(value || ""))
    .join(" ");
  const clusters = [];
  if (/(?:儿童|小儿|宝宝|婴幼儿|母婴|育儿|家长)/i.test(profileText)) {
    clusters.push(["儿童", "孩子", "宝宝", "家长", "父母", "育儿", "母婴", "少儿", "儿科", "婴儿"]);
  }
  if (/(?:药品|用药|感冒药|医药|制药|OTC|医疗器械)/i.test(profileText)) {
    clusters.push(["健康", "科普", "用药", "药品", "感冒", "护理", "养护", "家庭健康"]);
  }
  return clusters;
}

function isMarketingEvidenceRelevant(item, brand) {
  const haystack = normalizeRelevancePhrase(`${item?.title || ""} ${item?.snippet || ""}`);
  const strongPhrases = [brand?.name, brand?.product]
    .flatMap(getMarketingRelevancePhrases)
    .filter((phrase) => phrase.length >= 2 && phrase.length <= 24);
  if (strongPhrases.some((phrase) => haystack.includes(phrase))) return true;
  const matchedTerms = getDistinctiveMarketingTerms(brand).filter((term) => haystack.includes(term));
  if (new Set(matchedTerms).size >= 2) return true;
  const conceptClusters = getMarketingConceptClusters(brand);
  if (!conceptClusters.length) return false;
  const clusterMatches = conceptClusters.map((terms) => terms.filter((term) => haystack.includes(term)));
  if (clusterMatches.every((matches) => matches.length >= 1)) return true;
  return conceptClusters.length === 1 && clusterMatches[0].length >= 2;
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

function normalizeEvidencePublishedAt(explicitValue, snippet) {
  const explicit = cleanSnippet(explicitValue || "", 80);
  const source = `${explicit} ${String(snippet || "")}`;
  const numericDate = source.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?!\d)/);
  if (numericDate) {
    const [, year, month, day] = numericDate;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const englishDate = source.match(/发布时间\s*[:：]\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\s+20\d{2})/);
  if (englishDate) {
    const parsed = new Date(englishDate[1]);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return "";
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
        publishedAt: normalizeEvidencePublishedAt(item?.publishedAt, item?.snippet),
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

function getEvidenceFreshnessScore(item, now = new Date()) {
  if (!item?.publishedAt) return 0;
  const publishedAt = new Date(`${item.publishedAt}T00:00:00.000+08:00`);
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(publishedAt.getTime()) || Number.isNaN(reference.getTime())) return 0;
  const ageDays = (reference.getTime() - publishedAt.getTime()) / 86400000;
  if (ageDays < -7) return -2;
  if (ageDays <= 45) return 5;
  if (ageDays <= 120) return 3;
  if (ageDays <= 365) return 1;
  return -4;
}

const BRACKET_PAIRS = { "(": ")", "（": "）", "[": "]", "【": "】", "《": "》", "“": "”", "‘": "’" };
const BRACKET_CLOSERS = new Set(Object.values(BRACKET_PAIRS));

function stripAllowedBracketIdioms(value) {
  return String(value || "")
    .replace(/[:;]-?[)）]/g, "")
    .replace(/[\[(]\s*-?\d+(?:\.\d+)?\s*[,，]\s*-?\d+(?:\.\d+)?\s*[\])]/g, "");
}

function hasMalformedSearchTitlePunctuation(value) {
  const text = stripAllowedBracketIdioms(String(value || "").normalize("NFKC"));
  if (/[（(]\s*[:：]/u.test(text)) return true;
  const stack = [];
  for (const character of text) {
    if (BRACKET_PAIRS[character]) stack.push(BRACKET_PAIRS[character]);
    else if (BRACKET_CLOSERS.has(character) && stack.pop() !== character) return true;
  }
  return stack.length > 0;
}

function isPriceLedSearchTitle(value) {
  return hasVolatileTrendPrice(value);
}

function isCurrentTrendEvidenceUsable(item, now = new Date()) {
  const reference = now instanceof Date ? now : new Date(now);
  const currentYear = Number(formatShanghaiDate(Number.isNaN(reference.getTime()) ? new Date() : reference).match(/\d{4}/)?.[0]);
  const title = String(item?.title || "");
  if (isPriceLedSearchTitle(title) || hasMalformedSearchTitlePunctuation(title)) return false;

  const titleYears = getExplicitYears(title);
  if (titleYears.some((year) => year < currentYear) && !titleYears.includes(currentYear)) return false;

  return true;
}

const TRAFFIC_MARKETING_SIGNAL_PATTERNS = [
  /(?:小红书|社交媒体|社媒|内容营销|品牌营销|社媒运营|营销案例|品牌观察|品牌.{0,6}活动|公益.{0,6}活动|活动传播|爆文|笔记|创作者|博主|达人|种草|传播策略)/i,
  /(?:用户洞察|消费洞察|消费者|消费趋势|用户讨论|家长讨论|家长热议|消费情绪|内容需求|舆论场|沟通矛盾)/i,
  /(?:内容形式|内容方向|内容创作|标题|封面|图文|短视频|评论区|互动方式|话题表达|生活场景|讨论场景)/i,
];

// Prefer evidence that already encodes market/consumer change language so the
// downstream signal extractor can form concrete opportunity cards.
const MARKET_CHANGE_EVIDENCE_PATTERNS = [
  /(?:从.{2,12}(?:转向|变为|变成|迁移到)|增长|下降|升温|降温|崛起|兴起|替代|分流|迁移|重构|分化)/i,
  /(?:用户|消费者|家长|宝妈).{0,8}(?:开始|更|正在|转向|偏好|吐槽|焦虑|纠结|求)/i,
  /(?:痛点|避坑|对比|核验|从.+到|转向|迁移)/i,
];

function getMarketChangeEvidenceScore(item) {
  const text = `${item?.title || ""} ${item?.snippet || ""}`;
  let score = 0;
  for (const pattern of MARKET_CHANGE_EVIDENCE_PATTERNS) {
    if (pattern.test(text)) score += 2;
  }
  return score;
}

const MEDICAL_INSTRUCTION_SIGNAL_PATTERN = /(?:怎么防|怎么治|如何治疗|治疗方案|治愈|诊断|药方|偏方|处方|服药|吃药|喂药|用药指导|用药清单|药箱|备药|剂量|用量|药物搭配|说明书|临床指南|速通攻略|必读手册)/i;
const HEALTH_PRODUCT_ADVERTORIAL_PATTERN = /(?:有没有|求|靠谱).{0,12}(?:益生菌|保健品|营养品|健康产品|药品).{0,10}(?:推荐|公司)|(?:认准|宝藏).{0,12}(?:企业|品牌|产品)/i;

function getTrafficMarketingSignalScore(item) {
  const url = String(item?.url || "");
  if (/\/user\/profile\//i.test(url)) return -100;
  const title = String(item?.title || "");
  const text = `${title} ${item?.snippet || ""}`;
  let score = 0;
  for (const pattern of TRAFFIC_MARKETING_SIGNAL_PATTERNS) {
    if (pattern.test(title)) score += 4;
    else if (pattern.test(text)) score += 2;
  }
  if (item?.sourceType === "social" && /(?:讨论|热议|吐槽|焦虑|困扰|情绪|需求|问答|争议)/i.test(text)) score += 2;
  if (MEDICAL_INSTRUCTION_SIGNAL_PATTERN.test(text)) score -= 5;
  if (HEALTH_PRODUCT_ADVERTORIAL_PATTERN.test(text)) score -= 5;
  return score;
}

function isTrafficMarketingEvidenceRelevant(item) {
  return getTrafficMarketingSignalScore(item) > 0;
}

function isMedicineTrafficMarketingEvidenceRelevant(item, brand = null) {
  const text = `${item?.title || ""} ${item?.snippet || ""}`;
  if (!isTrafficMarketingEvidenceRelevant(item) || !isSafeTrafficEvidenceForMedicineBrand(item)) return false;
  if (!brand || isChildFamilySearchProfile(brand)) {
    return /(?:母婴|育儿|家长|父母|亲子|儿童|孩子|宝宝|婴幼儿)/i.test(text);
  }
  return isMarketingEvidenceRelevant(item, brand);
}

function sortEvidenceForSelection(items, options = {}) {
  const preferRecent = Boolean(options.preferRecent);
  const preferMarketingContent = Boolean(options.preferMarketingContent);
  const now = options.now || new Date();
  return [...items].sort((left, right) => {
    const leftMarketingScore = preferMarketingContent ? getTrafficMarketingSignalScore(left) * 3 : 0;
    const rightMarketingScore = preferMarketingContent ? getTrafficMarketingSignalScore(right) * 3 : 0;
    const leftChangeScore = getMarketChangeEvidenceScore(left);
    const rightChangeScore = getMarketChangeEvidenceScore(right);
    const leftScore = (preferRecent ? left.trustScore * 4 + getEvidenceFreshnessScore(left, now) : left.trustScore)
      + leftMarketingScore
      + leftChangeScore;
    const rightScore = (preferRecent ? right.trustScore * 4 + getEvidenceFreshnessScore(right, now) : right.trustScore)
      + rightMarketingScore
      + rightChangeScore;
    return rightScore - leftScore || String(right.publishedAt).localeCompare(String(left.publishedAt)) || left.queryIndex - right.queryIndex;
  });
}

function selectEvidence(items, options = {}) {
  const maxEvidence = Math.max(3, Math.min(12, Number(options.maxEvidence || DEFAULT_MAX_EVIDENCE)));
  const maxSocial = Math.max(0, Math.min(3, Number(options.maxSocialEvidence ?? DEFAULT_MAX_SOCIAL_EVIDENCE)));
  const ranked = sortEvidenceForSelection(items, options);
  const social = ranked.filter((item) => item.sourceType === "social").slice(0, maxSocial);
  const web = ranked.filter((item) => item.sourceType !== "social").slice(0, maxEvidence - social.length);
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

function createAnySearchAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function awaitWithAnySearchAbort(value, options = {}) {
  const signal = options.signal;
  const timeoutMs = Number(options.timeoutMs || 0);
  if (signal?.aborted) return Promise.reject(createAnySearchAbortError("AnySearch DNS lookup was aborted"));
  if (!signal && !(timeoutMs > 0)) return Promise.resolve(value);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(result);
    };
    const onAbort = () => finish(reject, createAnySearchAbortError("AnySearch DNS lookup was aborted"));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timeout = setTimeout(
        () => finish(reject, createAnySearchAbortError("AnySearch DNS lookup timed out")),
        timeoutMs,
      );
    }
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

async function resolvePublicAddresses(hostname, lookupImpl = dns.promises.lookup, options = {}) {
  if (net.isIP(hostname)) return isPrivateAddress(hostname) ? [] : [{ address: hostname, family: net.isIP(hostname) }];
  const lookup = Promise.resolve().then(() => lookupImpl(hostname, { all: true, verbatim: true }));
  const result = await awaitWithAnySearchAbort(lookup, options);
  const addresses = Array.isArray(result) ? result : [result];
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item?.address || item))) return [];
  return addresses.map((item) => ({
    address: String(item?.address || item),
    family: Number(item?.family || net.isIP(item?.address || item)),
  }));
}

async function resolvePublicHostname(hostname, lookupImpl = dns.promises.lookup, options = {}) {
  return (await resolvePublicAddresses(hostname, lookupImpl, options)).length > 0;
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

function getEligibleAnySearchAddresses(addresses, now = Date.now()) {
  const normalized = (Array.isArray(addresses) ? addresses : [])
    .filter((item) => item?.address)
    .sort((left, right) => Number(left.family || 0) - Number(right.family || 0) || String(left.address).localeCompare(String(right.address)));
  const healthy = normalized.filter((item) => Number(anySearchAddressCooldowns.get(item.address) || 0) <= now);
  return healthy.length ? healthy : normalized;
}

function markAnySearchAddressUnhealthy(address, now = Date.now(), cooldownMs = DEFAULT_ANYSEARCH_ADDRESS_COOLDOWN_MS) {
  if (!address) return;
  anySearchAddressCooldowns.set(String(address), now + Math.max(1000, Number(cooldownMs) || DEFAULT_ANYSEARCH_ADDRESS_COOLDOWN_MS));
}

function resetAnySearchAddressHealth() {
  anySearchAddressCooldowns.clear();
  anySearchAddressCursor = 0;
}

function selectAnySearchAddress(addresses, cursor = anySearchAddressCursor, now = Date.now()) {
  if (!Array.isArray(addresses) || !addresses.length) return null;
  const eligible = getEligibleAnySearchAddresses(addresses, now);
  return eligible[Math.abs(Number(cursor) || 0) % eligible.length] || null;
}

function buildAnySearchRequestOptions(target, options = {}, pinnedLookup = null) {
  const hostname = String(target?.hostname || "").toLowerCase();
  const needsAnySearchTlsCompatibility = target.protocol === "https:" &&
    (hostname === "api.anysearch.com" || hostname.endsWith(".anysearch.com"));
  return {
    method: options.method || "GET",
    headers: options.headers || {},
    signal: options.signal,
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(pinnedLookup ? { lookup: pinnedLookup } : {}),
    // AnySearch's CDN currently resets Node TLS 1.3 POST connections. Scope the
    // compatibility limit to this integration instead of weakening global TLS.
    ...(needsAnySearchTlsCompatibility ? { maxVersion: options.tlsMaxVersion || "TLSv1.2" } : {}),
  };
}

async function requestPinnedUrl(value, options = {}) {
  const parsed = new URL(value);
  const addresses = await resolvePublicAddresses(parsed.hostname, options.lookupImpl || dns.promises.lookup, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
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
        return resolvePublicHostname(parsed.hostname, lookupImpl, { signal: controller.signal, timeoutMs });
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

async function requestAnySearchHttp(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const body = options.body == null ? "" : String(options.body);
  const headers = { ...(options.headers || {}) };
  let pinnedLookup = null;
  let pinnedAddress = null;
  if (!net.isIP(target.hostname) && !["localhost", "localhost.localdomain"].includes(target.hostname.toLowerCase())) {
    const addresses = await resolvePublicAddresses(target.hostname, options.lookupImpl || dns.promises.lookup, {
      signal: options.signal,
      timeoutMs: Math.max(1000, Number(options.connectTimeoutMs || DEFAULT_ANYSEARCH_CONNECT_TIMEOUT_MS)),
    });
    if (!addresses.length) throw new Error("AnySearch hostname does not resolve exclusively to public addresses");
    pinnedAddress = selectAnySearchAddress(addresses);
    anySearchAddressCursor = (anySearchAddressCursor + 1) % Number.MAX_SAFE_INTEGER;
    pinnedLookup = createPinnedLookup(pinnedAddress.address, pinnedAddress.family);
  }
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let connectionReady = false;
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      if (!connectionReady && pinnedAddress?.address) markAnySearchAddressUnhealthy(pinnedAddress.address);
      if (error) {
        if (pinnedAddress?.address) error.anySearchAddress = pinnedAddress.address;
        error.anySearchStage = responseStarted ? "response" : connectionReady ? "headers" : "connect";
      }
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      resolve(value);
    };
    const request = transport.request(
      target,
      buildAnySearchRequestOptions(target, { ...options, headers }, pinnedLookup),
      (response) => {
        responseStarted = true;
        connectionReady = true;
        clearConnectTimer();
        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_ANYSEARCH_RESPONSE_BYTES) {
            request.destroy(new Error("AnySearch response exceeded the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolveOnce({
            ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
            status: Number(response.statusCode || 0),
            text: async () => raw,
          });
        });
        response.on("aborted", () => rejectOnce(new Error("AnySearch response was aborted")));
        response.on("error", rejectOnce);
      },
    );
    request.on("socket", (socket) => {
      const isSecure = target.protocol === "https:";
      const readyEvent = isSecure ? "secureConnect" : "connect";
      const socketIsAlreadyReady = request.reusedSocket === true || (
        !socket.connecting && (!isSecure || socket.secureConnecting === false)
      );
      if (socketIsAlreadyReady) {
        connectionReady = true;
        clearConnectTimer();
        return;
      }
      connectTimer = setTimeout(() => {
        const error = new Error("AnySearch connection timed out");
        error.code = "ETIMEDOUT";
        request.destroy(error);
      }, Math.max(1000, Number(options.connectTimeoutMs || DEFAULT_ANYSEARCH_CONNECT_TIMEOUT_MS)));
      socket.once(readyEvent, () => {
        connectionReady = true;
        clearConnectTimer();
      });
    });
    request.on("error", rejectOnce);
    request.end(body || undefined);
  });
}

async function requestAnySearch(config, queries, options = {}) {
  const fetchImpl = options.fetchImpl || requestAnySearchHttp;
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
    let responseReceived = false;
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
        connectTimeoutMs: Number(config.connectTimeoutMs || DEFAULT_ANYSEARCH_CONNECT_TIMEOUT_MS),
      });
      responseReceived = true;
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
      const failureStage = String(error?.anySearchStage || error?.cause?.anySearchStage || "");
      const requestMayHaveReachedServer = responseReceived || ["headers", "response"].includes(failureStage);
      const retryable =
        (!requestMayHaveReachedServer && ["ANYSEARCH_TIMEOUT", "ANYSEARCH_NETWORK_ERROR"].includes(lastError.code)) ||
        (lastError.code === "ANYSEARCH_API_ERROR" && lastError.statusCode === 429) ||
        (["ANYSEARCH_QUOTA_EXHAUSTED", "ANYSEARCH_KEY_REJECTED"].includes(lastError.code) && reservation?.keyCount > 1);
      if (["ANYSEARCH_TIMEOUT", "ANYSEARCH_NETWORK_ERROR"].includes(lastError.code)) {
        console.warn("[anysearch] direct request attempt failed", {
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          code: lastError.code,
          transportCode: String(error?.code || error?.cause?.code || "UNKNOWN").slice(0, 40),
          stage: String(error?.anySearchStage || error?.cause?.anySearchStage || "unknown").slice(0, 20),
          address: String(error?.anySearchAddress || error?.cause?.anySearchAddress || "").slice(0, 64),
        });
      }
      if (!retryable || attempt >= retries) throw lastError;
      const delayMs = Math.max(0, Math.min(2000, Number(options.retryDelayMs ?? config.retryDelayMs ?? 350))) * (attempt + 1);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || createAnySearchError("ANYSEARCH_NETWORK_ERROR", "AnySearch 网络连接失败。");
}

function buildCacheKey(config, queries, brand, options = {}) {
  return JSON.stringify({
    baseUrl: config.baseUrl || ANYSEARCH_ENDPOINT,
    queries,
    relevanceSignature: {
      name: normalizeRelevancePhrase(brand?.name),
      industry: normalizeRelevancePhrase(brand?.industry),
      product: normalizeRelevancePhrase(brand?.product),
      audience: normalizeRelevancePhrase(brand?.audience),
      description: normalizeRelevancePhrase(brand?.description),
      medicineProfile: isMedicineSearchProfile(brand),
      childFamilyProfile: isChildFamilySearchProfile(brand),
    },
    urlCheckEnabled: config.urlCheckEnabled !== false,
    maxEvidence: config.maxEvidence || DEFAULT_MAX_EVIDENCE,
    maxSocialEvidence: config.maxSocialEvidence ?? DEFAULT_MAX_SOCIAL_EVIDENCE,
    minEvidence: config.minEvidence || config.minReliableEvidence || DEFAULT_MIN_EVIDENCE,
    maxSnippetChars: config.maxSnippetChars || 520,
    allowSparseEvidence: options.allowSparseEvidence === true,
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
  const queries = buildAnySearchQueries(brand, bucketMeta, config, options.now || new Date());
  const cacheTtlMs = Math.max(0, Number(config.cacheTtlMs ?? 10 * 60 * 1000));
  const cacheKey = buildCacheKey(config, queries, brand, options);
  if (!options.skipCache && cacheTtlMs > 0) {
    const cached = getCachedEvidence(cacheKey, cacheTtlMs);
    if (cached) return { ...cached, cacheHit: true };
  }

  const requestImpl = options.requestImpl || requestAnySearch;
  const markdown = await requestImpl(config, queries, options);
  const parsed = parseAnySearchMarkdown(markdown, queries);
  const accessibilityCache = new Map();
  const bucketKey = getBucketKey(bucketMeta);
  const medicineTraffic = bucketKey === "traffic" && isMedicineSearchProfile(brand);
  const normalized = normalizeEvidence(parsed, config)
    .filter((item) => medicineTraffic
      ? isMedicineTrafficMarketingEvidenceRelevant(item, brand)
      : isMarketingEvidenceRelevant(item, brand));
  const bucketRelevant = bucketKey === "traffic"
    ? normalized.filter(isTrafficMarketingEvidenceRelevant)
    : normalized;
  const currentTrendEvidence = bucketRelevant.filter((item) => isCurrentTrendEvidenceUsable(
    item,
    options.now || new Date(),
  ));
  const accessible = await getAccessibleEvidence(currentTrendEvidence, config, options, accessibilityCache);
  const evidence = selectEvidence(accessible, {
    ...config,
    now: options.now || new Date(),
    preferRecent: ["traffic", "news", "social"].includes(bucketKey),
    preferMarketingContent: bucketKey === "traffic",
  });
  const reliableCount = countReliableEvidence(evidence);
  const minEvidence = Math.max(
    1,
    Number(config.minEvidence || config.minReliableEvidence || DEFAULT_MIN_EVIDENCE),
  );
  const requiredEvidence = options.allowSparseEvidence ? 1 : minEvidence;

  if (evidence.length < requiredEvidence) {
    throw createAnySearchError(
      "ANYSEARCH_INSUFFICIENT_EVIDENCE",
      `AnySearch 返回的可验证营销/社交来源不足：${evidence.length}/${requiredEvidence}。`,
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
    cacheHit: false,
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
  parseAnySearchMarkdown,
  normalizeEvidence,
  normalizeEvidencePublishedAt,
  selectEvidence,
  sortEvidenceForSelection,
  isMarketingEvidenceRelevant,
  getTrafficMarketingSignalScore,
  getMarketChangeEvidenceScore,
  isTrafficMarketingEvidenceRelevant,
  isMedicineTrafficMarketingEvidenceRelevant,
  isChildFamilySearchProfile,
  isSafeTrafficEvidenceForMedicineBrand,
  isPrivateAddress,
  isSafePublicUrl,
  checkUrlAccessible,
  requestAnySearchHttp,
  requestAnySearch,
  redactSensitiveText,
  isAnySearchQuotaExhaustion,
  sanitizeEvidenceText,
  createPinnedLookup,
  selectAnySearchAddress,
  markAnySearchAddressUnhealthy,
  resetAnySearchAddressHealth,
  buildAnySearchRequestOptions,
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
