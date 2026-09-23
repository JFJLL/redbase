const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");
const {
  normalizeEvidence,
  selectEvidence,
  sortEvidenceForSelection,
  isMarketingEvidenceRelevant,
  isTrafficMarketingEvidenceRelevant,
} = require("./anysearch");

const DEFAULT_ZHIHU_ENDPOINT = "https://developer.zhihu.com/api/v1/content/global_search";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_COUNT = 5;
const zhihuCache = new Map();

function createZhihuError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanSearchTitle(title) {
  let text = String(title || "").trim();
  if (!text) return "";
  text = text.replace(
    /\s*[-_—|]\s*(知乎|知乎专栏|什么值得买|网易订阅|网易新闻|新浪网|新浪财经|新浪新闻|澎湃新闻|腾讯新闻|腾讯网|百度贴吧|百度知道|微信公众平台|手机搜狐网|搜狐网|搜狐|今日头条|快懂百科|CSDN博客|小红书|豆瓣|微博).*$/i,
    "",
  );
  text = text.replace(/(?:\|[^|]{2,10}){2,}\s*$/g, "");
  text = text.replace(/[\s\-_—|:：]+$/g, "").trim();
  return text;
}

function buildZhihuQueries(brand, bucketMeta, options = {}) {
  const brandName = String(brand?.name || "").trim();
  const industry = String(brand?.industry || "").trim();
  const product = String(brand?.product || "").trim();
  const audience = String(brand?.audience || "").trim();
  const bucketKey = Array.isArray(bucketMeta)
    ? bucketMeta[0]?.key || "general"
    : bucketMeta?.key || "general";

  const queries = [];
  if (brandName && product) {
    queries.push(`${brandName} ${product} 消费趋势 热门讨论`.trim());
  } else if (industry && product) {
    queries.push(`${industry} ${product} 2026 市场趋势`.trim());
  }

  if (audience && product) {
    queries.push(`${audience} ${product} 痛点 体验`.trim());
  } else if (industry) {
    queries.push(`${industry} 行业动态 消费洞察`.trim());
  }

  if (queries.length === 0) {
    queries.push(`${brandName || industry || "消费趋势"} 市场洞察`.trim());
  }

  return queries.slice(0, 3);
}

async function requestZhihuSearch({
  query,
  count = DEFAULT_COUNT,
  searchDb = "all",
  apiKey,
  baseUrl = DEFAULT_ZHIHU_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) {
    throw createZhihuError("ZHIHU_MISSING_KEY", "知乎搜索 API Key (Secret) 未配置。");
  }
  if (!query || !query.trim()) {
    throw createZhihuError("ZHIHU_EMPTY_QUERY", "搜索查询关键词为空。");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set("Query", query.trim());
  targetUrl.searchParams.set("Count", String(count));
  targetUrl.searchParams.set("SearchDB", searchDb);

  const isHttps = targetUrl.protocol === "https:";
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      targetUrl.toString(),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "X-Request-Timestamp": timestamp,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(
              createZhihuError(
                "ZHIHU_HTTP_ERROR",
                `知乎 API 请求失败 (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`,
                { statusCode: res.statusCode, rawResponse: raw },
              ),
            );
          }
          try {
            const data = JSON.parse(raw);
            if (data.Code !== 0 && data.code !== 0 && data.Code !== undefined) {
              return reject(
                createZhihuError(
                  "ZHIHU_API_ERROR",
                  `知乎 API 业务错误 (${data.Code || data.code}): ${data.Message || data.message || "未知错误"}`,
                  { apiCode: data.Code || data.code, details: data },
                ),
              );
            }
            resolve(data);
          } catch (err) {
            reject(
              createZhihuError(
                "ZHIHU_INVALID_JSON",
                `知乎 API 返回非合法 JSON: ${raw.slice(0, 200)}`,
                { error: err.message },
              ),
            );
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(
        createZhihuError(
          "ZHIHU_TIMEOUT",
          `知乎搜索 API 请求超时 (${timeoutMs}ms)。`,
        ),
      );
    });

    req.on("error", (err) => {
      reject(
        createZhihuError(
          "ZHIHU_NETWORK_ERROR",
          `知乎搜索网络连接错误: ${err.message}`,
          { originalError: err },
        ),
      );
    });

    req.end();
  });
}

function mapZhihuItemToEvidence(item, queryIndex = 0) {
  const editTime = item.EditTime || item.editTime || item.CreateTime || item.createTime;
  let publishedAt = "";
  if (editTime) {
    const ts = Number(editTime) * 1000;
    if (!Number.isNaN(ts) && ts > 0) {
      publishedAt = new Date(ts).toISOString().split("T")[0];
    }
  }

  const url = String(item.Url || item.url || "").trim();
  const isZhihuUrl = url.includes("zhihu.com");

  return {
    title: cleanSearchTitle(item.Title || item.title || ""),
    url,
    snippet: String(item.ContentText || item.contentText || item.Snippet || "").trim(),
    source: String(item.AuthorName || item.authorName || (isZhihuUrl ? "知乎" : "全网来源")).trim(),
    publishedAt,
    sourceType: isZhihuUrl ? "social" : "web",
    platformType: "zhihu_global",
    queryIndex,
  };
}

async function fetchZhihuSearchEvidence(appConfig, brand, bucketMeta, options = {}) {
  const searchConfig = appConfig?.searchProvider || {};
  const zhihuConfig = searchConfig.zhihu || {};
  const apiKey = String(zhihuConfig.apiKey || searchConfig.apiKey || "").trim();
  const baseUrl = String(zhihuConfig.baseUrl || searchConfig.baseUrl || DEFAULT_ZHIHU_ENDPOINT).trim();
  const timeoutMs = Math.max(1000, Number(zhihuConfig.timeoutMs || searchConfig.timeoutMs || DEFAULT_TIMEOUT_MS));
  const count = Math.max(1, Math.min(20, Number(zhihuConfig.count || searchConfig.maxResultsPerQuery || DEFAULT_COUNT)));
  const cacheTtlMs = Math.max(0, Number(searchConfig.cacheTtlMs ?? 10 * 60 * 1000));

  if (!searchConfig.enabled) {
    throw createZhihuError("SEARCH_DISABLED", "全网搜索服务尚未启用。");
  }
  if (!apiKey) {
    throw createZhihuError("ZHIHU_MISSING_KEY", "知乎全局搜索 API Key 未配置。");
  }

  const queries = buildZhihuQueries(brand, bucketMeta, options);
  const cacheKey = `zhihu:${brand?.id || "default"}:${queries.join("|")}`;
  if (!options.skipCache && cacheTtlMs > 0 && zhihuCache.has(cacheKey)) {
    const entry = zhihuCache.get(cacheKey);
    if (Date.now() - entry.time < cacheTtlMs) {
      return { ...entry.data, cacheHit: true };
    }
    zhihuCache.delete(cacheKey);
  }

  const rawItems = [];
  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    try {
      const resp = await requestZhihuSearch({
        query,
        count,
        apiKey,
        baseUrl,
        timeoutMs,
      });
      const items = Array.isArray(resp?.Data?.Items) ? resp.Data.Items : [];
      for (const item of items) {
        rawItems.push(mapZhihuItemToEvidence(item, i));
      }
    } catch (err) {
      // Log and continue to next query if at least one query succeeds
      if (i === queries.length - 1 && rawItems.length === 0) {
        throw err;
      }
    }
  }

  // Deduplicate by URL
  const seenUrls = new Set();
  const deduplicated = [];
  for (const item of rawItems) {
    if (item.url && seenUrls.has(item.url)) continue;
    if (item.url) seenUrls.add(item.url);
    deduplicated.push(item);
  }

  const normalized = normalizeEvidence(deduplicated, {
    maxSnippetChars: Number(searchConfig.maxSnippetChars || 520),
  });

  const selectionOptions = {
    ...searchConfig,
    now: options.now || new Date(),
    preferRecent: true,
  };

  const selected = selectEvidence(normalized, selectionOptions).map((item, idx) => ({
    id: `S${idx + 1}`,
    ...item,
  }));

  const candidates = sortEvidenceForSelection(normalized, selectionOptions)
    .slice(0, 30)
    .map((item, index) => ({
      id: `C${index + 1}`,
      ...item,
      brandRelevant: isMarketingEvidenceRelevant(item, brand),
      trafficRelevant: isTrafficMarketingEvidenceRelevant(item),
    }));

  const result = {
    provider: "zhihu",
    queries: queries.map((q) => ({ query: q })),
    evidence: selected,
    candidates,
    rawResultCount: rawItems.length,
    reliableCount: selected.length,
    retrievedAt: new Date().toISOString(),
    cacheHit: false,
  };

  if (cacheTtlMs > 0) {
    zhihuCache.set(cacheKey, { time: Date.now(), data: result });
  }

  return result;
}

function clearZhihuCache() {
  zhihuCache.clear();
}

module.exports = {
  DEFAULT_ZHIHU_ENDPOINT,
  buildZhihuQueries,
  requestZhihuSearch,
  mapZhihuItemToEvidence,
  fetchZhihuSearchEvidence,
  clearZhihuCache,
};
